/**
 * A desk's own mailbox (D45), read beside the shared one (D30): its IMAP URL, password and all,
 * sealed with the server's key (lib/secret-box.ts), so a copy of the database alone doesn't give
 * it away; shown again as its host, user and folder only. Mail read from it is the desk's, down
 * D30's one path, with its own place kept by UID. Mail to the desk's requesters comes from its
 * address and name.
 *
 * Setting the mailbox is an administrator's: it makes the server connect to a host someone names,
 * as HELPDESK_IMAP_URL does. Its name to send from is the desk's managers'.
 */
import type { DeskMailbox } from '@a4a/shared';
import { eq, isNotNull } from 'drizzle-orm';
import { requireScope, type AppServices, type Ctx } from '../context';
import { helpdeskMailboxes } from '../db/schema';
import { imapClient, imapTarget, mailboxKey, pollMailbox, type ImapTarget, type MailboxClient } from '../helpdesk/imap';
import { badRequest } from '../lib/errors';
import { open, seal } from '../lib/secret-box';
import { requireProject } from './access';

const keySource = (app: AppServices) => ({ secretKey: app.config.secretKey, dataDir: app.config.dataDir });

type Row = typeof helpdeskMailboxes.$inferSelect;

function target(app: AppServices, row: Row): ImapTarget | null {
  const url = row.imapUrlSealed ? open(keySource(app), row.imapUrlSealed) : null;
  if (!url) return null;
  try {
    return imapTarget(url);
  } catch {
    return null;
  }
}

function dto(app: AppServices, row: Row | undefined): DeskMailbox {
  const t = row ? target(app, row) : null;
  return {
    imap: t ? { host: t.host, port: t.port, user: t.user, folder: t.folder, secure: t.secure } : null,
    fromName: row?.fromName ?? null,
    lastReadAt: row?.imapReadAt?.toISOString() ?? null,
    lastError: row?.imapError ?? null,
  };
}

export async function deskMailbox(ctx: Ctx, key: string): Promise<DeskMailbox> {
  const project = await requireProject(ctx, key, 'manage');
  const [row] = await ctx.db.select().from(helpdeskMailboxes).where(eq(helpdeskMailboxes.projectId, project.id));
  return dto(ctx.app, row);
}

export async function setDeskMailbox(ctx: Ctx, key: string, input: { imapUrl?: string | null; fromName?: string | null }): Promise<DeskMailbox> {
  requireScope(ctx, 'write');
  const project = await requireProject(ctx, key, 'manage');
  const [row] = await ctx.db.select().from(helpdeskMailboxes).where(eq(helpdeskMailboxes.projectId, project.id));
  if (!row) throw badRequest('Give the desk an address first', 'Its mailbox is the one mail to that address reaches.').said('deskMailbox.addressFirst');
  const set: Partial<Row> = { updatedAt: new Date() };
  if (input.imapUrl !== undefined) {
    // The server connects where this says: an administrator's to say, as HELPDESK_IMAP_URL is.
    requireScope(ctx, 'admin');
    if (input.imapUrl === null || input.imapUrl === '') {
      set.imapUrlSealed = null;
      set.imapError = null;
    } else {
      let t: ImapTarget;
      try {
        t = imapTarget(input.imapUrl);
      } catch {
        throw badRequest('That is no IMAP address', 'Write it as imaps://user:password@host/INBOX; imap:// must upgrade with STARTTLS.').said('deskMailbox.notImap');
      }
      if (!t.user || !t.pass) throw badRequest('The mailbox needs a user and a password', 'Write them in the address: imaps://user:password@host/INBOX.').said('deskMailbox.needsUserAndPassword');
      set.imapUrlSealed = seal(keySource(ctx.app), input.imapUrl);
      set.imapError = null;
    }
  }
  if (input.fromName !== undefined) set.fromName = input.fromName?.trim() || null;
  await ctx.db.update(helpdeskMailboxes).set(set).where(eq(helpdeskMailboxes.projectId, project.id));
  const [fresh] = await ctx.db.select().from(helpdeskMailboxes).where(eq(helpdeskMailboxes.projectId, project.id));
  return dto(ctx.app, fresh);
}

/** Who a desk's mail to its requesters comes from: its name and address, once it has a mailbox or a name of its own. */
export async function deskSender(app: AppServices, projectId: string, projectName: string): Promise<string | undefined> {
  const [row] = await app.db.select().from(helpdeskMailboxes).where(eq(helpdeskMailboxes.projectId, projectId));
  if (!row || (!row.imapUrlSealed && !row.fromName)) return undefined;
  const name = (row.fromName ?? projectName).replace(/["\\\r\n]/g, '');
  return `"${name}" <${row.address}>`;
}

// ---------------------------------------------------------------------------
// The chore: each desk's own mailbox, one after another, in the background
// ---------------------------------------------------------------------------

const polling = new WeakMap<object, Promise<void>>();

/** Read each desk's own mailbox in turn, unless a round is running; the worker goes on at once. */
export function startDeskPolls(app: AppServices & { worker?: { active: boolean } | null }, connect: (t: ImapTarget) => MailboxClient = imapClient): Promise<void> {
  const running = polling.get(app);
  if (running) return running;
  const run = (async () => {
    const s = await app.schema.get();
    const rows = await app.db.select().from(helpdeskMailboxes).where(isNotNull(helpdeskMailboxes.imapUrlSealed));
    for (const row of rows) {
      if (app.worker && !app.worker.active) break;
      const desk = s.projects.get(row.projectId);
      const t = target(app, row);
      if (!desk || !t) continue;
      try {
        const got = await pollMailbox(app, connect(t), mailboxKey(t), { desk, stillHolder: () => app.worker?.active ?? true });
        await app.db.update(helpdeskMailboxes).set({ imapReadAt: new Date(), imapError: null }).where(eq(helpdeskMailboxes.projectId, row.projectId));
        if (got.read) console.log(`${desk.key}'s mailbox: read ${got.read}`);
      } catch (e) {
        const words = (e instanceof Error ? e.message : String(e)).slice(0, 300);
        await app.db.update(helpdeskMailboxes).set({ imapError: words }).where(eq(helpdeskMailboxes.projectId, row.projectId));
      }
    }
  })()
    .catch((e) => console.error("desks' mailboxes: the round failed", e instanceof Error ? e.message : e))
    .finally(() => polling.delete(app));
  polling.set(app, run);
  return run;
}

export async function deskPollsDone(app: AppServices): Promise<void> {
  await polling.get(app);
}
