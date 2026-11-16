/**
 * A person's emails (D33): their primary one (users.email) and others. Each counts once it's
 * confirmed: by a link a4a mails to it, opened by the person signed in, or by an administrator
 * who sets it. A commit under any confirmed email is then the person's (vcs/authors.ts), as one
 * under a verified primary email is.
 *
 * The link is a token minted as its mail is sent and kept only as a hash, so no token waits in the
 * outbox in plain text; it works once, for a day, and only for the person it was minted for, so a
 * stranger who adds your address can't take it even if you open their link. Without SMTP no link
 * can go, and an administrator confirms emails instead.
 */
import type { EmailLink, PersonEmails, UserEmail } from '@a4a/shared';
import { and, asc, count, desc, eq, gt, sql } from 'drizzle-orm';
import { requireScope, type AppServices, type Ctx, type UserRow } from '../context';
import type { Db } from '../db/client';
import { emailConfirmations, mailOutbox, userEmails, users } from '../db/schema';
import { randomToken, sha256 } from '../lib/crypto';
import { AppError, badRequest, forbidden, notFound } from '../lib/errors';
import { newId } from '../lib/ids';
import { AUTOMATIC, composeMail, type RenderedMail } from '../mail/compose';
import { enqueueMail, kickMail, type MailRow } from '../mail/outbox';
import { mailConfigured } from '../notify/state';
import { findUser } from './schema-cache';
import { userRefDto } from './values';

/** Emails beside the primary one, per person. */
export const MAX_OTHER_EMAILS = 10;
/** How long a link works. */
export const LINK_TTL_MS = 24 * 3_600_000;
/** Links a person may have sent in an hour, and how soon one email may get another. */
const LINKS_PER_HOUR = 5;
const LINK_GAP_MS = 60_000;

type OtherRow = typeof userEmails.$inferSelect;

const lower = (email: string) => email.trim().toLowerCase();

async function target(ctx: Ctx, idOrLogin: string): Promise<UserRow> {
  const s = await ctx.app.schema.get();
  const u = s.users.get(idOrLogin) ?? findUser(s, idOrLogin, ctx.actor.user.id);
  if (!u) throw notFound(`User ${idOrLogin}`);
  return u;
}

/** A person may read their own emails, and an administrator anyone's. */
async function readable(ctx: Ctx, idOrLogin: string): Promise<UserRow> {
  requireScope(ctx, 'read');
  const u = await target(ctx, idOrLogin);
  if (u.id !== ctx.actor.user.id) requireScope(ctx, 'admin');
  return u;
}

/** Changing your own emails changes whose commits are yours: it's done signed in, never with a token. */
function signedIn(ctx: Ctx): void {
  requireScope(ctx, 'write');
  if (ctx.actor.authMethod === 'token') throw forbidden('Your emails are changed signed in, not with a token', 'Open your profile in a4a.');
}

/** When a4a last queued a link to each of a person's emails. */
async function linksSent(db: Db, userId: string): Promise<Map<string, Date>> {
  const rows = await db
    .select({ email: sql<string>`lower(${mailOutbox.payload}->>'email')`, at: sql<Date>`max(${mailOutbox.createdAt})` })
    .from(mailOutbox)
    .where(and(eq(mailOutbox.kind, 'email-confirm'), eq(mailOutbox.userId, userId)))
    .groupBy(sql`lower(${mailOutbox.payload}->>'email')`);
  return new Map(rows.map((r) => [r.email, new Date(r.at)]));
}

async function others(db: Db, userId: string): Promise<OtherRow[]> {
  return db.select().from(userEmails).where(eq(userEmails.userId, userId)).orderBy(asc(userEmails.createdAt));
}

async function emailsOf(ctx: Ctx, u: UserRow): Promise<PersonEmails> {
  const s = await ctx.app.schema.get();
  const fresh = s.users.get(u.id) ?? u;
  const sent = await linksSent(ctx.db, u.id);
  const waiting = (email: string, confirmed: boolean) => (confirmed ? null : (sent.get(lower(email))?.toISOString() ?? null));
  const list: UserEmail[] = [];
  if (fresh.email) {
    list.push({ id: null, email: fresh.email, primary: true, confirmed: fresh.emailVerified, confirmedBy: null, linkSentAt: waiting(fresh.email, fresh.emailVerified), createdAt: null });
  }
  for (const o of await others(ctx.db, u.id)) {
    const by = o.confirmedById ? s.users.get(o.confirmedById) : undefined;
    list.push({
      id: o.id,
      email: o.email,
      primary: false,
      confirmed: o.confirmedAt !== null,
      confirmedBy: by ? userRefDto(by) : null,
      linkSentAt: waiting(o.email, o.confirmedAt !== null),
      createdAt: o.createdAt.toISOString(),
    });
  }
  return { emails: list, canSendLinks: mailConfigured(ctx.app) };
}

export async function personEmails(ctx: Ctx, idOrLogin: string): Promise<PersonEmails> {
  return emailsOf(ctx, await readable(ctx, idOrLogin));
}

/**
 * Whether someone other than `userId` has this email confirmed: one person per confirmed email,
 * so a commit under it names one person.
 */
async function confirmedElsewhere(db: Db, s: Awaited<ReturnType<AppServices['schema']['get']>>, userId: string, email: string): Promise<UserRow | null> {
  const e = lower(email);
  for (const u of s.users.values()) if (u.id !== userId && u.emailVerified && u.email && lower(u.email) === e) return u;
  const [row] = await db
    .select({ userId: userEmails.userId })
    .from(userEmails)
    .where(and(sql`lower(${userEmails.email}) = ${e}`, sql`${userEmails.confirmedAt} IS NOT NULL`, sql`${userEmails.userId} <> ${userId}`))
    .limit(1);
  return row ? (s.users.get(row.userId) ?? null) : null;
}

/** Queue a link to one of a person's emails, within the limits. False when a4a can't send email. */
async function queueLink(ctx: Ctx, db: Db, u: UserRow, email: string): Promise<boolean> {
  if (!mailConfigured(ctx.app)) return false;
  const hourAgo = new Date(Date.now() - 3_600_000);
  const [{ n } = { n: 0 }] = await db
    .select({ n: count() })
    .from(mailOutbox)
    .where(and(eq(mailOutbox.kind, 'email-confirm'), eq(mailOutbox.userId, u.id), gt(mailOutbox.createdAt, hourAgo)));
  if (n >= LINKS_PER_HOUR) throw new AppError(429, 'rate_limited', 'a4a has sent you enough links for now', 'Try again in an hour, or ask an administrator to confirm the email.');
  const [last] = await db
    .select({ at: mailOutbox.createdAt })
    .from(mailOutbox)
    .where(and(eq(mailOutbox.kind, 'email-confirm'), eq(mailOutbox.userId, u.id), sql`lower(${mailOutbox.payload}->>'email') = ${lower(email)}`))
    .orderBy(desc(mailOutbox.createdAt))
    .limit(1);
  if (last && Date.now() - last.at.getTime() < LINK_GAP_MS) throw new AppError(429, 'rate_limited', 'A link went to it a moment ago', 'Look for it, in spam too; a new one can go in a minute.');
  const id = newId();
  return enqueueMail(db, ctx.app, { kind: 'email-confirm', dedupeKey: `email-confirm:${id}`, userId: u.id, payload: { email }, messageId: `ec-${id}` });
}

/** Add an email to your own account; a link to confirm it goes to it, when a4a can send email. */
export async function addMyEmail(ctx: Ctx, email: string): Promise<PersonEmails> {
  signedIn(ctx);
  const u = await target(ctx, ctx.actor.user.id);
  const e = email.trim();
  if (u.email && lower(u.email) === lower(e)) {
    if (u.emailVerified) throw badRequest('That’s your primary email, and it’s confirmed');
    return sendEmailLink(ctx, e);
  }
  if (!u.email) {
    // Someone's first email is their primary one, waiting to be confirmed as any other.
    let sent = false;
    await ctx.db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      await tx.update(users).set({ email: e, emailVerified: false, updatedAt: new Date() }).where(eq(users.id, u.id));
      sent = await queueLink(ctx, tx, u, e);
    });
    ctx.app.schema.invalidate();
    if (sent) kickMail(ctx.app);
    return emailsOf(ctx, await target(ctx, u.id));
  }
  const mine = await others(ctx.db, u.id);
  if (mine.some((o) => lower(o.email) === lower(e))) throw badRequest('You’ve added that email already', 'Send its link again from your list of emails.');
  if (mine.length >= MAX_OTHER_EMAILS) throw badRequest(`You have ${MAX_OTHER_EMAILS} other emails already`, 'Remove one you no longer use first.');
  let sent = false;
  await ctx.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    await tx.insert(userEmails).values({ id: newId(), userId: u.id, email: e });
    sent = await queueLink(ctx, tx, u, e);
  });
  if (sent) kickMail(ctx.app);
  return emailsOf(ctx, u);
}

/** Send a link again to one of your emails that waits to be confirmed. */
export async function sendEmailLink(ctx: Ctx, email: string): Promise<PersonEmails> {
  signedIn(ctx);
  const u = await target(ctx, ctx.actor.user.id);
  const e = lower(email);
  const isPrimary = Boolean(u.email && lower(u.email) === e);
  const other = isPrimary ? undefined : (await others(ctx.db, u.id)).find((o) => lower(o.email) === e);
  if (!isPrimary && !other) throw notFound('That email among yours', 'Add it first.');
  if (isPrimary ? u.emailVerified : other!.confirmedAt) throw badRequest('That email is confirmed already');
  if (!mailConfigured(ctx.app)) throw badRequest('a4a can’t send email here', 'Ask an administrator to confirm the email.');
  await ctx.db.transaction(async (txRaw) => {
    await queueLink(ctx, txRaw as unknown as Db, u, isPrimary ? u.email! : other!.email);
  });
  kickMail(ctx.app);
  return emailsOf(ctx, u);
}

const INVALID = (): AppError => new AppError(404, 'not_found', 'This link isn’t valid', 'It works once, for 24 hours: send a new one from your profile.');

/** A link's token, as the person it was minted for holds it: null when it's no link of theirs. */
async function linkFor(ctx: Ctx, token: string): Promise<typeof emailConfirmations.$inferSelect> {
  const [row] = await ctx.db.select().from(emailConfirmations).where(eq(emailConfirmations.tokenHash, sha256(token)));
  if (!row || row.expiresAt.getTime() <= Date.now()) throw INVALID();
  // The link is for the account that asked; anyone else opening it changes nothing.
  if (row.userId !== ctx.actor.user.id) throw new AppError(403, 'forbidden', 'This link is for another account in a4a', 'Sign in as the person who added the email, then open it again.');
  return row;
}

/** Which email a link confirms, for the page that asks before it does. Changes nothing. */
export async function emailLink(ctx: Ctx, token: string): Promise<EmailLink> {
  requireScope(ctx, 'read');
  const row = await linkFor(ctx, token);
  const u = await target(ctx, ctx.actor.user.id);
  const e = lower(row.email);
  if (u.email && lower(u.email) === e) return { email: u.email, confirmed: u.emailVerified };
  const other = (await others(ctx.db, u.id)).find((o) => lower(o.email) === e);
  if (!other) throw INVALID();
  return { email: other.email, confirmed: other.confirmedAt !== null };
}

/** Confirm an email by the link a4a mailed to it, signed in as the person it was minted for. */
export async function confirmEmail(ctx: Ctx, token: string): Promise<EmailLink> {
  signedIn(ctx);
  const row = await linkFor(ctx, token);
  const s = await ctx.app.schema.get();
  const u = await target(ctx, ctx.actor.user.id);
  const e = lower(row.email);
  const taken = await confirmedElsewhere(ctx.db, s, u.id, row.email);
  if (taken) throw new AppError(409, 'conflict', 'This email is confirmed for someone else in a4a', 'An administrator can move it to you.');
  let confirmed: string | null = null;
  await ctx.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    if (u.email && lower(u.email) === e) {
      await tx.update(users).set({ emailVerified: true, updatedAt: new Date() }).where(and(eq(users.id, u.id), sql`lower(${users.email}) = ${e}`));
      confirmed = u.email;
    } else {
      const [other] = await tx
        .update(userEmails)
        .set({ confirmedAt: new Date(), confirmedById: u.id })
        .where(and(eq(userEmails.userId, u.id), sql`lower(${userEmails.email}) = ${e}`))
        .returning();
      confirmed = other?.email ?? null;
    }
    // Every link to this email is spent, this one included.
    await tx.delete(emailConfirmations).where(and(eq(emailConfirmations.userId, u.id), sql`lower(${emailConfirmations.email}) = ${e}`));
  });
  if (!confirmed) throw INVALID();
  ctx.app.schema.invalidate();
  return { email: confirmed, confirmed: true };
}

/** Make one of your confirmed emails the primary one; the old primary stays, as another email. */
export async function makePrimary(ctx: Ctx, email: string): Promise<PersonEmails> {
  signedIn(ctx);
  const u = await target(ctx, ctx.actor.user.id);
  const e = lower(email);
  if (u.email && lower(u.email) === e) return emailsOf(ctx, u);
  const chosen = (await others(ctx.db, u.id)).find((o) => lower(o.email) === e);
  if (!chosen) throw notFound('That email among yours');
  if (!chosen.confirmedAt) throw badRequest('Confirm it first', 'Only a confirmed email can be your primary one.');
  await ctx.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    await tx.delete(userEmails).where(eq(userEmails.id, chosen.id));
    // Who confirmed the old primary isn't known: an administrator, single sign-on or a link.
    if (u.email) await tx.insert(userEmails).values({ id: newId(), userId: u.id, email: u.email, confirmedAt: u.emailVerified ? new Date() : null });
    await tx.update(users).set({ email: chosen.email, emailVerified: true, updatedAt: new Date() }).where(eq(users.id, u.id));
  });
  ctx.app.schema.invalidate();
  return emailsOf(ctx, await target(ctx, u.id));
}

/** Remove one of your other emails; commits under it are no longer yours from now on. */
export async function removeMyEmail(ctx: Ctx, id: string): Promise<void> {
  signedIn(ctx);
  await removeEmail(ctx, ctx.actor.user.id, id);
}

async function removeEmail(ctx: Ctx, userId: string, id: string): Promise<void> {
  const [row] = await ctx.db.select().from(userEmails).where(and(eq(userEmails.id, id), eq(userEmails.userId, userId)));
  if (!row) throw notFound('Email');
  await ctx.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    await tx.delete(userEmails).where(eq(userEmails.id, row.id));
    await tx.delete(emailConfirmations).where(and(eq(emailConfirmations.userId, userId), sql`lower(${emailConfirmations.email}) = ${lower(row.email)}`));
  });
}

/** An administrator adds an email for someone, confirmed: they vouch for it. */
export async function addEmailFor(ctx: Ctx, idOrLogin: string, email: string): Promise<PersonEmails> {
  requireScope(ctx, 'admin');
  const s = await ctx.app.schema.get();
  const u = await target(ctx, idOrLogin);
  const e = email.trim();
  const taken = await confirmedElsewhere(ctx.db, s, u.id, e);
  if (taken) throw new AppError(409, 'conflict', `${taken.name} has this email confirmed already`, `Remove it from ${taken.name} first: a confirmed email is one person's.`);
  if (u.email && lower(u.email) === lower(e)) {
    if (!u.emailVerified) {
      await ctx.db.update(users).set({ emailVerified: true, updatedAt: new Date() }).where(eq(users.id, u.id));
      ctx.app.schema.invalidate();
    }
    return emailsOf(ctx, await target(ctx, u.id));
  }
  const mine = await others(ctx.db, u.id);
  const existing = mine.find((o) => lower(o.email) === lower(e));
  if (existing) {
    if (!existing.confirmedAt) await ctx.db.update(userEmails).set({ confirmedAt: new Date(), confirmedById: ctx.actor.user.id }).where(eq(userEmails.id, existing.id));
  } else {
    if (mine.length >= MAX_OTHER_EMAILS) throw badRequest(`${u.name} has ${MAX_OTHER_EMAILS} other emails already`, 'Remove one first.');
    await ctx.db.insert(userEmails).values({ id: newId(), userId: u.id, email: e, confirmedAt: new Date(), confirmedById: ctx.actor.user.id });
  }
  return emailsOf(ctx, u);
}

/** An administrator removes one of someone's other emails. */
export async function removeEmailFor(ctx: Ctx, idOrLogin: string, id: string): Promise<void> {
  requireScope(ctx, 'admin');
  const u = await target(ctx, idOrLogin);
  await removeEmail(ctx, u.id, id);
}

// ---------------------------------------------------------------------------
// The mail with the link, rendered when it is sent
// ---------------------------------------------------------------------------

export async function renderEmailConfirmMail(app: AppServices, row: MailRow): Promise<RenderedMail | null> {
  const email = String((row.payload as { email?: unknown }).email ?? '');
  if (!row.userId || !email) return null;
  const [u] = await app.db.select().from(users).where(eq(users.id, row.userId));
  if (!u || u.banned) return null;
  const e = lower(email);
  // Confirmed, or removed, since it was asked for: nothing to send.
  if (u.email && lower(u.email) === e) {
    if (u.emailVerified) return null;
  } else {
    const [other] = await app.db.select().from(userEmails).where(and(eq(userEmails.userId, u.id), sql`lower(${userEmails.email}) = ${e}`));
    if (!other || other.confirmedAt) return null;
  }
  const token = randomToken('', 32);
  const tokenHash = sha256(token);
  // Links that expired are forgotten as new ones are made.
  await app.db.delete(emailConfirmations).where(sql`${emailConfirmations.expiresAt} < now()`);
  await app.db.insert(emailConfirmations).values({ tokenHash, userId: u.id, email, expiresAt: new Date(Date.now() + LINK_TTL_MS) });
  const subject = 'Confirm your email for a4a';
  const { text, html } = composeMail(subject, {
    lead: `Confirm that ${email} is yours in a4a.`,
    sections: [
      {
        head: `${u.name} (${u.login}) added this email to their account in a4a.`,
        lines: ['Once it’s confirmed, the commits under it are theirs: they link to issues as theirs, and the commands in them run as them.'],
      },
    ],
    action: { label: 'Confirm it', url: `${app.config.publicUrl}/emails/confirm?token=${encodeURIComponent(token)}` },
    why: `You get this because someone signed in to a4a as ${u.login} added this email. If that wasn’t you, ignore it: nothing changes unless ${u.login} opens the link, signed in. It works once, for 24 hours.`,
  });
  return {
    to: email,
    subject,
    text,
    html,
    headers: { ...AUTOMATIC },
    // A link nobody received is forgotten.
    onFailed: async () => {
      await app.db.delete(emailConfirmations).where(eq(emailConfirmations.tokenHash, tokenHash));
    },
  };
}

