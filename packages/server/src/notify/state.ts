/**
 * What notifications and mail keep per runtime: who to wake when someone's inbox changes, the
 * mail transport, and the key that signs unsubscribe links and the help desk's form tokens. Kept
 * beside the runtime rather than on it, so the rest of the server needn't know about them.
 */
import { EventEmitter } from 'node:events';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { AppServices } from '../context';
import { settings } from '../db/schema';
import { createSmtpTransport, type MailTransport } from '../mail/transport';

interface NotifyState {
  inbox: EventEmitter;
  transport: MailTransport | null | undefined;
  secret: Promise<Buffer> | null;
  /** Wakes the mail sender, when one runs in this process. */
  kickMail: (() => void) | null;
}

const states = new WeakMap<AppServices, NotifyState>();

export function notifyState(app: AppServices): NotifyState {
  let st = states.get(app);
  if (!st) {
    const inbox = new EventEmitter();
    inbox.setMaxListeners(10_000);
    st = { inbox, transport: undefined, secret: null, kickMail: null };
    states.set(app, st);
  }
  return st;
}

/** The mail transport, from SMTP_URL; null when the server sends no email. */
export function mailTransport(app: AppServices): MailTransport | null {
  const st = notifyState(app);
  if (st.transport === undefined) st.transport = app.config.smtpUrl ? createSmtpTransport(app.config.smtpUrl) : null;
  return st.transport;
}

export function mailConfigured(app: AppServices): boolean {
  return mailTransport(app) !== null;
}

/** Tests send through a fake (or a real SMTP server on a port of their own). */
export function setMailTransportForTests(app: AppServices, transport: MailTransport | null): void {
  notifyState(app).transport = transport;
}

/** Tell this person's open inboxes (the SSE stream) that something changed. */
export function inboxChanged(app: AppServices, userId: string): void {
  notifyState(app).inbox.emit('changed', userId);
}

export function onInboxChanged(app: AppServices, listener: (userId: string) => void): () => void {
  const inbox = notifyState(app).inbox;
  inbox.on('changed', listener);
  return () => inbox.off('changed', listener);
}

const SECRET_KEY = 'notifySecret';

/**
 * A random key, made once and kept in settings so every instance signs alike. Whoever can read
 * the database can read it too; what it signs (an unsubscribe, a form) is worth no more than that.
 */
export function appSecret(app: AppServices): Promise<Buffer> {
  const st = notifyState(app);
  st.secret ??= (async () => {
    const fresh = randomBytes(32).toString('base64url');
    await app.db.insert(settings).values({ key: SECRET_KEY, value: fresh as never }).onConflictDoNothing();
    const [row] = await app.db.select().from(settings).where(eq(settings.key, SECRET_KEY));
    return Buffer.from(String(row!.value), 'base64url');
  })().catch((e) => {
    st.secret = null;
    throw e;
  });
  return st.secret;
}

export async function sign(app: AppServices, purpose: string, value: string): Promise<string> {
  return createHmac('sha256', await appSecret(app)).update(`${purpose}\n${value}`).digest('base64url');
}

/** A timing-safe check of a signature made by sign(). */
export async function verify(app: AppServices, purpose: string, value: string, signature: string): Promise<boolean> {
  const expected = Buffer.from(await sign(app, purpose, value));
  const given = Buffer.from(signature);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
