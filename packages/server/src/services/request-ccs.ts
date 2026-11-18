/**
 * CCs on help desk requests (D57): people outside the team copied on a request. They're told what
 * its requester is told (the team's public replies, its changes of state), each by an email of their
 * own with a reply address of its own, and their answers by email become their public comments.
 *
 * - Who copies them: the team (the request's page, the API, MCP), the Cc of the requester's own
 *   email (helpdesk/inbound.ts), and the requester on the portal. Never a4a's or a desk's own
 *   addresses, the team's, the requester's, or one that takes no mail.
 * - Who takes them off: the team, and each of them, from the unsubscribe link in every email they
 *   get. A row stays when they're taken off, so the next email that names them in its Cc doesn't put
 *   them back; the team may, and the requester may unless they stopped it themselves.
 * - At most REQUEST_CCS_MAX at once. Each change locks the request's row, so two at once can't pass
 *   the cap, and records its activity in the same transaction: the request's history says who
 *   copied whom, and who stopped.
 */
import { REQUEST_CCS_MAX, type PortalCc, type RequestCc, type RequestCcVia } from '@a4a/shared';
import { and, asc, eq, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import { requireScope, type AppServices, type Ctx } from '../context';
import type { Db } from '../db/client';
import { helpdeskMailboxes, helpdeskRequests, issues, requestCcs, requesters, userEmails, users } from '../db/schema';
import { publishActivities, recordActivity, type ActivityRow } from '../events/activity';
import { deskRecipient, splitAddress } from '../helpdesk/addresses';
import { AppError, badRequest, conflict, notFound } from '../lib/errors';
import { newId } from '../lib/ids';
import { assertCanWriteProject } from './access';
import { botCtx } from './helpdesk';
import { issueRef, readableId, stateNames } from './issue-refs';
import { resolveIssue } from './issues';
import { userRefDto } from './values';

export type CcRow = typeof requestCcs.$inferSelect;
type IssueRow = typeof issues.$inferSelect;

/** Why an address wasn't copied: a code, said as a problem to the team and the portal, and in words in the mail log. */
export type CcRefusal = 'invalid' | 'own' | 'team' | 'requester' | 'full' | 'removed' | 'stopped';

export interface Person {
  email: string;
  name?: string;
}

const lower = (email: string) => email.trim().toLowerCase();

/** An address a person reads: one "@", a domain with a dot, and not one that takes no replies or reports bounces. */
export function readableAddress(email: string): boolean {
  const e = email.trim();
  if (!e || e.length > 254 || /[\s<>,;"]/.test(e)) return false;
  const parts = splitAddress(e);
  if (!parts || e.indexOf('@') !== e.lastIndexOf('@') || !/^[^.]+(\.[^.]+)+$/.test(parts.domain)) return false;
  return !/^(no-?reply|do-?not-?reply|mailer-daemon|postmaster)([._+-]|$)/.test(parts.local);
}

/** a4a's own addresses: what it sends from, the team's reply address, and every desk's, with their plus forms. */
async function ownCheck(app: AppServices, db: Db): Promise<(email: string) => boolean> {
  const from = lower(/<([^>]+)>/.exec(app.config.mailFrom)?.[1] ?? app.config.mailFrom);
  const boxes = (await db.select({ address: helpdeskMailboxes.address }).from(helpdeskMailboxes)).map((b) => b.address);
  const reply = app.config.mailReplyAddress;
  return (email) => {
    const e = lower(email);
    if (e === from) return true;
    if (reply && deskRecipient(reply, e)) return true;
    return boxes.some((b) => deskRecipient(b, e) !== null);
  };
}

/** The addresses among these that are someone's on the team: their email, or one they confirmed. They follow a request by watching it. */
async function teamAddresses(db: Db, emails: string[]): Promise<Set<string>> {
  const list = [...new Set(emails.map(lower))];
  if (!list.length) return new Set();
  const people = await db
    .select({ email: users.email })
    .from(users)
    .where(sql`lower(${users.email}) IN (${sql.join(list.map((e) => sql`${e}`), sql`, `)})`);
  const confirmed = await db
    .select({ email: userEmails.email })
    .from(userEmails)
    .where(and(isNotNull(userEmails.confirmedAt), sql`lower(${userEmails.email}) IN (${sql.join(list.map((e) => sql`${e}`), sql`, `)})`));
  return new Set([...people, ...confirmed].map((r) => lower(r.email ?? '')).filter(Boolean));
}

/** Who did it: someone on the team, or the requester (by email, or on the portal). */
type By = { via: 'team'; userId: string } | { via: 'email' | 'portal'; requesterName: string };

interface Copied {
  added: CcRow[];
  refused: { email: string; why: CcRefusal }[];
  activities: ActivityRow[];
}

/**
 * Copy these people on a request, in the caller's transaction, as `ctx`. Each address is copied, is
 * already, or is refused with a reason; refusals change nothing. Locks the request's row first.
 */
async function copyIn(tx: Db, ctx: Ctx, issue: IssueRow, people: Person[], by: By): Promise<Copied> {
  const app = ctx.app;
  const [locked] = await tx
    .select({ requesterId: helpdeskRequests.requesterId })
    .from(helpdeskRequests)
    .where(eq(helpdeskRequests.issueId, issue.id))
    .for('update');
  if (!locked) return { added: [], refused: [], activities: [] };
  const [requester] = await tx.select({ email: requesters.email }).from(requesters).where(eq(requesters.id, locked.requesterId));
  const rows = await tx.select().from(requestCcs).where(eq(requestCcs.issueId, issue.id));
  const byAddress = new Map(rows.map((r) => [lower(r.email), r]));
  let active = rows.filter((r) => !r.removedAt).length;
  const own = await ownCheck(app, tx);
  const team = await teamAddresses(tx, people.map((p) => p.email));
  const s = await app.schema.get(tx);
  const ref = issueRef(s, issue, (await stateNames(tx, s, [issue.id])).get(issue.id) ?? null);
  const out: Copied = { added: [], refused: [], activities: [] };
  const seen = new Set<string>();
  for (const p of people) {
    const email = p.email.trim();
    const key = lower(email);
    if (seen.has(key)) continue;
    seen.add(key);
    const name = (p.name ?? '').trim().replace(/\s+/g, ' ').slice(0, 100);
    const had = byAddress.get(key);
    let why: CcRefusal | null = null;
    if (!readableAddress(email)) why = 'invalid';
    else if (own(email)) why = 'own';
    else if (requester && lower(requester.email) === key) why = 'requester';
    else if (team.has(key)) why = 'team';
    else if (had && !had.removedAt) continue; // copied already: nothing changes
    // An address taken off isn't put back by an email's Cc; nor by the requester, once they stopped it themselves.
    else if (had && by.via === 'email') why = 'removed';
    else if (had && by.via === 'portal' && had.removedVia === 'unsubscribe') why = 'stopped';
    else if (active >= REQUEST_CCS_MAX) why = 'full';
    if (why) {
      out.refused.push({ email, why });
      continue;
    }
    const addedById = by.via === 'team' ? by.userId : null;
    const values = { name: name || had?.name || '', via: by.via, addedById, addedAt: new Date(), removedAt: null, removedVia: null, removedById: null };
    const [row] = had
      ? await tx.update(requestCcs).set(values).where(eq(requestCcs.id, had.id)).returning()
      : await tx
          .insert(requestCcs)
          .values({ id: newId(), issueId: issue.id, email, ...values })
          .returning();
    active++;
    out.added.push(row!);
    out.activities.push(
      await recordActivity(tx, ctx, {
        type: 'request.cc_added',
        projectId: issue.projectId,
        issueId: issue.id,
        payload: { issue: ref, data: { cc: { email: row!.email, name: row!.name }, via: by.via, ...(by.via !== 'team' ? { requester: { name: by.requesterName } } : {}) } },
      }),
    );
  }
  return out;
}

/** A refusal as the team and the portal are told it, with its fix. */
function refusalProblem(r: { email: string; why: CcRefusal }): AppError {
  switch (r.why) {
    case 'own':
      return badRequest(`${r.email} is an address of a4a’s or a help desk’s own`, 'Copy people outside a4a: mail to its own addresses would come back to it.').said('requestCcs.ownAddress', { email: r.email });
    case 'team':
      return badRequest(`${r.email} belongs to someone on the team`, 'People on the team follow a request by watching it.').said('requestCcs.teamAddress', { email: r.email });
    case 'requester':
      return badRequest(`${r.email} is the requester’s own address`, 'The requester gets every email about it already.').said('requestCcs.requesterAddress', { email: r.email });
    case 'full':
      return conflict(`A request copies at most ${REQUEST_CCS_MAX} people`, 'Stop copying someone first.').said('requestCcs.full', { max: REQUEST_CCS_MAX });
    case 'stopped':
    case 'removed':
      return conflict(`${r.email} asked to stop emails about this request`, 'Ask the team, who can copy them again.').said('requestCcs.theyStopped', { email: r.email });
    default:
      return badRequest(`${r.email} isn’t an address a person reads`, 'Give an address such as anna@example.com: not one that takes no replies.').said('requestCcs.notAnAddress', { email: r.email });
  }
}

/** The log's words for an address an email's Cc didn't copy. */
function refusalWords(r: { email: string; why: CcRefusal }): string {
  const why: Record<CcRefusal, string> = {
    invalid: 'not an address a person reads',
    own: 'an address of a4a’s own',
    team: 'someone on the team',
    requester: 'the requester',
    full: `it copies ${REQUEST_CCS_MAX} already`,
    removed: 'taken off it before',
    stopped: 'taken off it before',
  };
  return `${r.email} (${why[r.why]})`;
}

/** The request an issue is, for the team: read with the caller's access, and a 404 alike when it's no request. */
async function requestFor(ctx: Ctx, issueId: string): Promise<IssueRow> {
  const issue = await resolveIssue(ctx, issueId);
  const [row] = await ctx.db.select({ id: helpdeskRequests.issueId }).from(helpdeskRequests).where(eq(helpdeskRequests.issueId, issue.id));
  if (!row) {
    const s = await ctx.app.schema.get();
    const id = readableId(s, issue);
    throw notFound(`A help desk request for ${id}`, 'Only issues filed through a help desk have one.').said('helpdesk.requestNotFound', { id });
  }
  return issue;
}

/** Who is copied on a request now, first copied first, as the team sees them. */
export async function ccsOf(db: Db, s: Awaited<ReturnType<AppServices['schema']['get']>>, issueId: string): Promise<RequestCc[]> {
  const rows = await db
    .select()
    .from(requestCcs)
    .where(and(eq(requestCcs.issueId, issueId), isNull(requestCcs.removedAt)))
    .orderBy(asc(requestCcs.addedAt), asc(requestCcs.id));
  return rows.map((r) => {
    const by = r.addedById ? s.users.get(r.addedById) : undefined;
    return { email: r.email, name: r.name, via: r.via as RequestCcVia, addedBy: by ? userRefDto(by) : null, addedAt: r.addedAt.toISOString() };
  });
}

/** For the team: who is copied on a request. Anyone who reads the request. */
export async function listCcs(ctx: Ctx, issueId: string): Promise<RequestCc[]> {
  requireScope(ctx, 'read');
  const issue = await requestFor(ctx, issueId);
  return ccsOf(ctx.db, await ctx.app.schema.get(), issue.id);
}

/**
 * The team copies someone on a request: what a public reply takes, someone who may change the
 * project's issues, since they'll be sent its public replies. Copying someone already copied
 * changes nothing; one taken off before is copied again.
 */
export async function addCc(ctx: Ctx, issueId: string, person: Person): Promise<RequestCc[]> {
  requireScope(ctx, 'write');
  const issue = await requestFor(ctx, issueId);
  await assertCanWriteProject(ctx, issue.projectId);
  const done = await ctx.db.transaction(async (txRaw) => copyIn(txRaw as unknown as Db, ctx, issue, [person], { via: 'team', userId: ctx.actor.user.id }));
  if (done.refused[0]) throw refusalProblem(done.refused[0]);
  await publishActivities(ctx.app, done.activities);
  return ccsOf(ctx.db, await ctx.app.schema.get(), issue.id);
}

/** Take someone off a request, as the team: they're told nothing more, and their replies are refused. Doing it twice is the same as once. */
export async function removeCc(ctx: Ctx, issueId: string, email: string): Promise<RequestCc[]> {
  requireScope(ctx, 'write');
  const issue = await requestFor(ctx, issueId);
  await assertCanWriteProject(ctx, issue.projectId);
  const activities = await ctx.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    return takeOff(tx, ctx, issue, (r) => lower(r.email) === lower(email), 'team');
  });
  await publishActivities(ctx.app, activities);
  return ccsOf(ctx.db, await ctx.app.schema.get(), issue.id);
}

/** Take the CC that matches off a request, in the caller's transaction, with its activity. */
async function takeOff(tx: Db, ctx: Ctx, issue: IssueRow, which: (r: CcRow) => boolean, via: 'team' | 'unsubscribe'): Promise<ActivityRow[]> {
  await tx.select({ id: helpdeskRequests.issueId }).from(helpdeskRequests).where(eq(helpdeskRequests.issueId, issue.id)).for('update');
  const row = (await tx.select().from(requestCcs).where(and(eq(requestCcs.issueId, issue.id), isNull(requestCcs.removedAt)))).find(which);
  if (!row) return [];
  await tx
    .update(requestCcs)
    .set({ removedAt: new Date(), removedVia: via, removedById: via === 'team' ? ctx.actor.user.id : null })
    .where(eq(requestCcs.id, row.id));
  const s = await ctx.app.schema.get(tx);
  const ref = issueRef(s, issue, (await stateNames(tx, s, [issue.id])).get(issue.id) ?? null);
  return [
    await recordActivity(tx, ctx, {
      type: 'request.cc_removed',
      projectId: issue.projectId,
      issueId: issue.id,
      // Stopped from an email, it's them acting, through the help desk: their name in the history.
      payload: { issue: ref, data: { cc: { email: row.email, name: row.name }, via, ...(via === 'unsubscribe' ? { requester: { name: row.name || row.email } } : {}) } },
    }),
  ];
}

// ---------------------------------------------------------------------------
// From mail, from the unsubscribe link, and for telling them
// ---------------------------------------------------------------------------

/**
 * The Cc of the requester's own email (a new request, or their reply): those it can copy are, as the
 * help desk's agent for the requester. Says, in the log's words, who it copied and who it left out.
 */
export async function copyFromMail(app: AppServices, issue: IssueRow, requesterName: string, people: Person[]): Promise<{ copied: string[]; left: string[] }> {
  if (!people.length) return { copied: [], left: [] };
  const ctx = await botCtx(app, issue.projectId);
  const done = await app.db.transaction(async (txRaw) => copyIn(txRaw as unknown as Db, ctx, issue, people, { via: 'email', requesterName }));
  await publishActivities(app, done.activities);
  return { copied: done.added.map((r) => r.email), left: done.refused.map(refusalWords) };
}

/**
 * The Cc of the email that opens a request, in the transaction that opens it, so the email that
 * says it came in already names who is copied (its address's real owner sees who will hear the
 * team's answers). Says, in the log's words, who it copied and who it left out.
 */
export async function copyOnNewRequest(tx: Db, ctx: Ctx, issue: IssueRow, requesterName: string, people: Person[]): Promise<{ words: { copied: string[]; left: string[] }; activities: ActivityRow[] }> {
  const done = await copyIn(tx, ctx, issue, people, { via: 'email', requesterName });
  return { words: { copied: done.added.map((r) => r.email), left: done.refused.map(refusalWords) }, activities: done.activities };
}

/** Someone stops being copied, from the unsubscribe link in an email they got. Doing it twice is the same as once. */
export async function stopCopy(app: AppServices, ccId: string): Promise<void> {
  const [row] = await app.db.select({ cc: requestCcs, issue: issues }).from(requestCcs).innerJoin(issues, eq(issues.id, requestCcs.issueId)).where(eq(requestCcs.id, ccId));
  if (!row || row.cc.removedAt) return;
  const ctx = await botCtx(app, row.issue.projectId);
  const activities = await app.db.transaction(async (txRaw) => takeOff(txRaw as unknown as Db, ctx, row.issue, (r) => r.id === ccId, 'unsubscribe'));
  await publishActivities(app, activities);
}

/** A CC by its id, for what its unsubscribe link stops. */
export async function ccById(db: Db, id: string): Promise<CcRow | null> {
  const [row] = await db.select().from(requestCcs).where(eq(requestCcs.id, id));
  return row ?? null;
}

/** Whether an address is copied on a request now: its row, or null. */
export async function copiedOn(db: Db, issueId: string, email: string): Promise<CcRow | null> {
  const [row] = await db
    .select()
    .from(requestCcs)
    .where(and(eq(requestCcs.issueId, issueId), isNull(requestCcs.removedAt), sql`lower(${requestCcs.email}) = ${lower(email)}`));
  return row ?? null;
}

/** Those to tell of an event: copied on the request when it happened, and still. */
export async function ccsToTell(db: Db, issueId: string, at: Date): Promise<CcRow[]> {
  return db
    .select()
    .from(requestCcs)
    .where(and(eq(requestCcs.issueId, issueId), isNull(requestCcs.removedAt), lte(requestCcs.addedAt, at)))
    .orderBy(asc(requestCcs.addedAt));
}

/** The requests this address is copied on, among these issues: for the portal (D57). */
export async function copiedAmong(db: Db, email: string, issueIds: string[]): Promise<Set<string>> {
  if (!issueIds.length) return new Set();
  const rows = await db
    .select({ issueId: requestCcs.issueId })
    .from(requestCcs)
    .where(and(inArray(requestCcs.issueId, issueIds), isNull(requestCcs.removedAt), sql`lower(${requestCcs.email}) = ${lower(email)}`));
  return new Set(rows.map((r) => r.issueId));
}

/** Who is copied on a request, as its requester sees them on the portal. */
export async function portalCcsOf(db: Db, issueId: string): Promise<PortalCc[]> {
  const rows = await db
    .select()
    .from(requestCcs)
    .where(and(eq(requestCcs.issueId, issueId), isNull(requestCcs.removedAt)))
    .orderBy(asc(requestCcs.addedAt), asc(requestCcs.id));
  return rows.map((r) => ({ email: r.email, name: r.name, byYou: r.via !== 'team', addedAt: r.addedAt.toISOString() }));
}

/**
 * The requester copies someone on their request, on the portal: anyone they choose, as forwarding
 * its emails would, since the request is theirs to share. Not someone who stopped it themselves.
 */
export async function copyFromPortal(app: AppServices, issue: IssueRow, requesterName: string, person: Person): Promise<void> {
  const ctx = await botCtx(app, issue.projectId);
  const done = await app.db.transaction(async (txRaw) => copyIn(txRaw as unknown as Db, ctx, issue, [person], { via: 'portal', requesterName }));
  if (done.refused[0]) throw refusalProblem(done.refused[0]);
  await publishActivities(app, done.activities);
}
