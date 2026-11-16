/**
 * Reading the shared help desk mailbox (HELPDESK_IMAP_URL, D30). Only the instance holding the
 * worker's lease reads it, a poll at a time, in the background so the outbox never waits on a mail
 * server. Each message goes down the same path as one a provider posts (helpdesk/inbound.ts), to
 * the desk whose address it was sent to.
 *
 * - How far it has read is kept by UID, within the folder's UIDVALIDITY, in Postgres, so a new
 *   lease holder carries on where the last one stopped. Messages are also known by Message-ID, so
 *   one read twice changes nothing twice.
 * - The first time a mailbox is read, and whenever its UIDVALIDITY changes, reading starts after
 *   the newest message already there: mail from before a4a read it isn't a request to anyone now.
 * - A message read is marked \Seen, so the people who look at the mailbox can tell.
 * - A message a4a couldn't take for a reason in it (too large, unreadable) is logged and passed; a
 *   failure of a4a's own (the database) ends the poll there, and the next one tries it again.
 */
import { ImapFlow } from 'imapflow';
import { eq, sql } from 'drizzle-orm';
import type { AppServices } from '../context';
import { helpdeskImapState } from '../db/schema';
import { sha256 } from '../lib/crypto';
import { receiveMail, refuseTooLarge } from './inbound';

/** What reading needs from a mailbox: imapflow's client behind it, or a stand-in in tests. */
export interface MailboxClient {
  /** Connect and open the folder; its UIDVALIDITY. */
  open(): Promise<number>;
  /** The UIDs above this one, oldest first. */
  uidsAfter(uid: number): Promise<number[]>;
  /** The highest UID in the folder, or 0 when it's empty. */
  newest(): Promise<number>;
  size(uid: number): Promise<number>;
  source(uid: number): Promise<Buffer>;
  markSeen(uid: number): Promise<void>;
  close(): Promise<void>;
}

/** Messages one poll reads at most; the next poll carries on. */
export const POLL_BATCH = 50;

export interface ImapTarget {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  folder: string;
}

/** HELPDESK_IMAP_URL, read: imaps:// for TLS from the start, imap:// for STARTTLS; the path is the folder (INBOX). */
export function imapTarget(url: string): ImapTarget {
  const u = new URL(url);
  if (u.protocol !== 'imaps:' && u.protocol !== 'imap:') throw new Error('HELPDESK_IMAP_URL must start with imaps:// or imap://');
  const secure = u.protocol === 'imaps:';
  return {
    host: u.hostname,
    port: Number(u.port) || (secure ? 993 : 143),
    secure,
    user: decodeURIComponent(u.username),
    pass: decodeURIComponent(u.password),
    folder: decodeURIComponent(u.pathname.replace(/^\/+/, '')) || 'INBOX',
  };
}

/** Where a mailbox's place is kept: a hash of its server, user and folder, never its password. */
export function mailboxKey(t: ImapTarget): string {
  return sha256(`${t.host}:${t.port}\n${t.user.toLowerCase()}\n${t.folder}`);
}

/** The server and folder, for people: "imap.acme.example/INBOX". */
export function imapServerWords(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const t = imapTarget(url);
    return `${t.host}/${t.folder}`;
  } catch {
    return null;
  }
}

export function imapClient(t: ImapTarget): MailboxClient {
  const loopback = t.host === 'localhost' || t.host === '127.0.0.1' || t.host === '::1';
  const client = new ImapFlow({
    host: t.host,
    port: t.port,
    secure: t.secure,
    // Credentials never cross the network in the clear: imap:// must upgrade, but on loopback.
    doSTARTTLS: t.secure ? undefined : !loopback,
    auth: { user: t.user, pass: t.pass },
    logger: false,
    connectionTimeout: 30_000,
    greetingTimeout: 30_000,
    socketTimeout: 120_000,
  });
  let lock: { release(): void } | null = null;
  return {
    async open() {
      await client.connect();
      lock = await client.getMailboxLock(t.folder);
      const box = client.mailbox;
      return box ? Number(box.uidValidity) : 0;
    },
    async uidsAfter(uid) {
      const found = await client.search({ uid: `${uid + 1}:*` }, { uid: true });
      // "n:*" always names the newest message, even one below n.
      return (found || []).filter((n) => n > uid).sort((a, b) => a - b);
    },
    async newest() {
      // "*" names nothing in an empty folder, and some servers say so with an error.
      if (!client.mailbox || client.mailbox.exists === 0) return 0;
      const last = await client.fetchOne('*', { uid: true });
      return last ? last.uid : 0;
    },
    async size(uid) {
      const m = await client.fetchOne(String(uid), { size: true }, { uid: true });
      return m && typeof m.size === 'number' ? m.size : 0;
    },
    async source(uid) {
      const m = await client.fetchOne(String(uid), { source: true }, { uid: true });
      if (!m || !m.source) throw new Error(`message ${uid} has gone from the mailbox`);
      return m.source;
    },
    async markSeen(uid) {
      await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
    },
    async close() {
      lock?.release();
      await client.logout().catch(() => client.close());
    },
  };
}

export interface PollResult {
  read: number;
  /** How many of each outcome, for the server's log. */
  outcomes: Record<string, number>;
}

/** Read what's new in the mailbox, a batch at most, while this instance holds the lease. */
export async function pollMailbox(
  app: AppServices,
  client: MailboxClient,
  key: string,
  opts: { batch?: number; stillHolder?: () => boolean } = {},
): Promise<PollResult> {
  const result: PollResult = { read: 0, outcomes: {} };
  const validity = await client.open();
  try {
    const [state] = await app.db.select().from(helpdeskImapState).where(eq(helpdeskImapState.mailbox, key));
    if (!state || state.uidValidity !== validity) {
      // A mailbox new to a4a, or renumbered: what's there already isn't anyone's request now.
      const newest = await client.newest();
      await save(app, key, validity, newest, true);
      if (state) console.warn(`help desk mailbox: its UIDVALIDITY changed, so reading starts after message ${newest}`);
      return result;
    }
    const max = app.config.helpdeskMailMaxBytes;
    for (const uid of (await client.uidsAfter(state.lastUid)).slice(0, opts.batch ?? POLL_BATCH)) {
      if (opts.stillHolder && !opts.stillHolder()) break;
      const size = await client.size(uid);
      const got = size > max ? await refuseTooLarge(app, { via: 'imap' }, size) : await receiveMail(app, await client.source(uid), { via: 'imap' });
      result.read++;
      result.outcomes[got.outcome] = (result.outcomes[got.outcome] ?? 0) + 1;
      await client.markSeen(uid).catch(() => {});
      await save(app, key, validity, uid, false);
    }
    return result;
  } finally {
    await client.close();
  }
}

async function save(app: AppServices, key: string, validity: number, uid: number, reset: boolean): Promise<void> {
  await app.db
    .insert(helpdeskImapState)
    .values({ mailbox: key, uidValidity: validity, lastUid: uid })
    .onConflictDoUpdate({
      target: helpdeskImapState.mailbox,
      // A place only moves on, unless the mailbox was renumbered.
      set: reset
        ? { uidValidity: validity, lastUid: uid, updatedAt: new Date() }
        : { lastUid: sql`greatest(${helpdeskImapState.lastUid}, ${uid})`, updatedAt: new Date() },
    });
}

// ---------------------------------------------------------------------------
// The chore: a poll at a time, never holding up the worker
// ---------------------------------------------------------------------------

const polling = new WeakMap<object, Promise<void>>();

/** Start a poll in the background unless one is running; the worker's loop goes on at once. */
export function startPoll(app: AppServices & { worker?: { active: boolean } | null }, connect: (t: ImapTarget) => MailboxClient = imapClient): void {
  const url = app.config.helpdeskImapUrl;
  if (!url || polling.has(app)) return;
  const run = (async () => {
    const target = imapTarget(url);
    const got = await pollMailbox(app, connect(target), mailboxKey(target), { stillHolder: () => app.worker?.active ?? true });
    if (got.read) console.log(`help desk mailbox: read ${got.read} (${Object.entries(got.outcomes).map(([k, n]) => `${n} ${k}`).join(', ')})`);
  })()
    .catch((e) => console.error('help desk mailbox: the poll failed', e instanceof Error ? e.message : e))
    .finally(() => polling.delete(app));
  polling.set(app, run);
}

/** Wait for a poll that's running to end, as the server stops. */
export async function pollsDone(app: AppServices): Promise<void> {
  await polling.get(app);
}
