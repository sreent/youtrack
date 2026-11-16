/**
 * A help desk's mail, as its managers set it up (D30): the address people write to, the secret its
 * mail provider posts with, and what came in. All of it is setup, so all of it needs managing the
 * project, as the help desk's other settings do.
 *
 * The secret is an API token's kind: random, shown once, kept as its SHA-256 hash, compared in
 * constant time. It travels as HTTP Basic's password, which is how mail providers send what a URL
 * carries (https://a4a:<secret>@…), and stays out of addresses that servers log.
 */
import { timingSafeEqual } from 'node:crypto';
import type { HelpdeskInbound, HelpdeskMail, HelpdeskMailSecret } from '@a4a/shared';
import { and, desc, eq, gte } from 'drizzle-orm';
import { requireScope, type AppServices, type Ctx } from '../context';
import { helpdeskInbound, helpdeskMailboxes, issues } from '../db/schema';
import { deskAddressProblem, replyAddress } from '../helpdesk/addresses';
import { imapServerWords } from '../helpdesk/imap';
import { INBOUND_KEEP_MS } from '../helpdesk/inbound';
import { randomToken, sha256 } from '../lib/crypto';
import { AppError, badRequest } from '../lib/errors';
import { requireProject } from './access';
import { readableId } from './issue-refs';
import { projectByKey, type ProjectRow } from './schema-cache';

const SECRET_PREFIX = 'hdm_';
/** What a reply address looks like, for people: the token differs in each email. */
const EXAMPLE_TOKEN = 'k7q2x9…';

export function inboundUrl(app: AppServices, key: string): string {
  return `${app.config.publicUrl}/api/v1/mail/inbound/${key.toUpperCase()}`;
}

/** The webhook address with the secret in it, as most providers take it: https://a4a:<secret>@host/… */
function inboundUrlWithSecret(app: AppServices, key: string, secret: string): string {
  const url = new URL(inboundUrl(app, key));
  url.username = 'a4a';
  url.password = secret;
  return url.toString();
}

type MailboxRow = typeof helpdeskMailboxes.$inferSelect;

async function mailbox(ctx: Ctx, projectId: string): Promise<MailboxRow | null> {
  const [row] = await ctx.db.select().from(helpdeskMailboxes).where(eq(helpdeskMailboxes.projectId, projectId));
  return row ?? null;
}

function toDto(ctx: Ctx, project: ProjectRow, row: MailboxRow | null): HelpdeskMail {
  const imap = imapServerWords(ctx.app.config.helpdeskImapUrl);
  const example = row ? replyAddress(row.address, EXAMPLE_TOKEN) : null;
  return {
    address: row?.address ?? null,
    replyAddress: example,
    inbound: { url: inboundUrl(ctx.app, project.key), secretPrefix: row?.secretPrefix ?? null },
    imap: { configured: imap !== null, server: imap },
    maxBytes: ctx.app.config.helpdeskMailMaxBytes,
  };
}

export async function deskMail(ctx: Ctx, key: string): Promise<HelpdeskMail> {
  requireScope(ctx, 'read');
  const project = await requireProject(ctx, key, 'manage');
  return toDto(ctx, project, await mailbox(ctx, project.id));
}

/** Set the desk's address, or stop its mail (null): that forgets its secret too. */
export async function setDeskAddress(ctx: Ctx, key: string, address: string | null): Promise<HelpdeskMail> {
  requireScope(ctx, 'write');
  const project = await requireProject(ctx, key, 'manage');
  if (address === null) {
    await ctx.db.delete(helpdeskMailboxes).where(eq(helpdeskMailboxes.projectId, project.id));
    return toDto(ctx, project, null);
  }
  const clean = address.trim();
  const problem = deskAddressProblem(clean);
  if (problem) throw badRequest(problem, 'Give the address people write to, such as support@acme.example.');
  try {
    await ctx.db
      .insert(helpdeskMailboxes)
      .values({ projectId: project.id, address: clean })
      .onConflictDoUpdate({ target: helpdeskMailboxes.projectId, set: { address: clean, updatedAt: new Date() } });
  } catch (e) {
    const err = e as { code?: string; cause?: { code?: string } };
    if (err.code === '23505' || err.cause?.code === '23505') {
      throw new AppError(409, 'address_taken', 'Another help desk takes mail at that address', 'Each desk needs an address of its own.');
    }
    throw e;
  }
  return toDto(ctx, project, await mailbox(ctx, project.id));
}

/** Make the secret a mail provider posts with, or a new one in its place: the old one stops at once. Shown once. */
export async function newMailSecret(ctx: Ctx, key: string): Promise<HelpdeskMailSecret> {
  requireScope(ctx, 'write');
  const project = await requireProject(ctx, key, 'manage');
  const row = await mailbox(ctx, project.id);
  if (!row) throw badRequest('Give the desk an address first', 'The address is where people write; the secret lets their mail in.');
  const secret = randomToken(SECRET_PREFIX, 24);
  await ctx.db
    .update(helpdeskMailboxes)
    .set({ secretHash: sha256(secret), secretPrefix: secret.slice(0, SECRET_PREFIX.length + 4), updatedAt: new Date() })
    .where(eq(helpdeskMailboxes.projectId, project.id));
  return { secret, url: inboundUrlWithSecret(ctx.app, project.key, secret) };
}

export async function removeMailSecret(ctx: Ctx, key: string): Promise<void> {
  requireScope(ctx, 'write');
  const project = await requireProject(ctx, key, 'manage');
  await ctx.db.update(helpdeskMailboxes).set({ secretHash: null, secretPrefix: null, updatedAt: new Date() }).where(eq(helpdeskMailboxes.projectId, project.id));
}

/** What came in for the desk in the last 30 days, newest first. */
export async function inboundLog(ctx: Ctx, key: string, limit = 100): Promise<HelpdeskInbound[]> {
  requireScope(ctx, 'read');
  const project = await requireProject(ctx, key, 'manage');
  const s = await ctx.app.schema.get();
  const rows = await ctx.db
    .select({ row: helpdeskInbound, issue: { projectId: issues.projectId, number: issues.number } })
    .from(helpdeskInbound)
    .leftJoin(issues, eq(issues.id, helpdeskInbound.issueId))
    .where(and(eq(helpdeskInbound.projectId, project.id), gte(helpdeskInbound.createdAt, new Date(Date.now() - INBOUND_KEEP_MS))))
    .orderBy(desc(helpdeskInbound.createdAt), desc(helpdeskInbound.id))
    .limit(Math.min(Math.max(limit, 1), 200));
  return rows.map(({ row, issue }) => ({
    id: row.id,
    at: row.createdAt.toISOString(),
    via: row.via === 'imap' ? 'imap' : 'webhook',
    sender: row.sender,
    subject: row.subject,
    outcome: row.outcome as HelpdeskInbound['outcome'],
    reason: row.reason,
    issue: issue?.projectId ? readableId(s, issue as { projectId: string; number: number }) : null,
  }));
}

/**
 * The desk a mail provider posts to, if the secret is its own: null alike for a desk that doesn't
 * exist, takes no mail, or has another secret, so a wrong guess learns nothing.
 */
export async function deskForSecret(app: AppServices, key: string, secret: string | null): Promise<ProjectRow | null> {
  const project = projectByKey(await app.schema.get(), key);
  const [row] = project ? await app.db.select().from(helpdeskMailboxes).where(eq(helpdeskMailboxes.projectId, project.id)) : [];
  // Compared as hashes, in constant time, whether or not there's anything to compare with.
  const expected = Buffer.from(row?.secretHash ?? sha256(`none:${key}`), 'hex');
  const given = Buffer.from(sha256(secret ?? ''), 'hex');
  const same = expected.length === given.length && timingSafeEqual(expected, given);
  return project && row?.secretHash && secret && same ? project : null;
}
