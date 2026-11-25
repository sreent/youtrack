/**
 * CCs on help desk requests (D57, D67): people outside the team copied on a request. They're told what
 * its requester is told (the team's public replies, its changes of state), each by an email of their
 * own with a reply address of its own, and their answers by email become their public comments.
 *
 * - Who copies them: the team (the request's page, the API, MCP), the Cc of the requester's own
 *   email (helpdesk/inbound.ts), and the requester on the portal. Never a4a's or a desk's own
 *   addresses, the team's, the requester's, or one that takes no mail.
 * - A new request's Cc waits for its requester (D67) when a4a can't trust who sent it: held, told
 *   nothing, until they confirm it by the link in their acknowledgement or on the portal.
 * - Who takes them off: the team, the requester on the portal (anyone copied, the team's too, D67),
 *   and each of them, from the unsubscribe link in every email they get. A row stays when they're
 *   taken off, so the next email that names them in its Cc doesn't put them back; the team may, and
 *   the requester may unless they stopped it themselves.
 * - At most the desk's cap at once (`ccsMax`, REQUEST_CCS_MAX unless its managers say otherwise).
 *   Each change locks the request's row, so two at once can't pass the cap, and records its
 *   activity in the same transaction: the request's history says who copied whom, and who stopped.
 */
import { CC_CONFIRM_DAYS, CC_HOLD_DAYS, REQUEST_CCS_MAX, type CcConfirmation, type CcConfirmed, type CustomerSharing, type HeldCc, type PortalCc, type RequestCc, type RequestCcVia } from '@a4a/shared';
import { and, asc, eq, gt, inArray, isNotNull, isNull, lt, lte, sql } from 'drizzle-orm';
import { requireScope, type AppServices, type Ctx } from '../context';
import type { Db } from '../db/client';
import { customerGroups, groupCopyStops, helpdeskMailboxes, helpdeskRequests, issues, requestCcConfirmations, requestCcHolds, requestCcs, requesters, userEmails, users } from '../db/schema';
import { publishActivities, recordActivity, type ActivityRow } from '../events/activity';
import { deskRecipient, splitAddress } from '../helpdesk/addresses';
import { randomToken, sha256 } from '../lib/crypto';
import { AppError, badRequest, conflict, notFound } from '../lib/errors';
import { newId } from '../lib/ids';
import { assertCanWriteProject, groupCopyHears } from './access';
import { groupCopyCandidates, groupCopyLock, groupCopyStandings, type GroupRow } from './customer-groups';
import { botCtx } from './helpdesk';
import { issueRef, readableId, stateNames } from './issue-refs';
import { resolveIssue } from './issues';
import { projectSettings } from './projects';
import type { SchemaSnapshot } from './schema-cache';
import { userRefDto } from './values';

export type CcRow = typeof requestCcs.$inferSelect;
type IssueRow = typeof issues.$inferSelect;

/** Why an address wasn't copied: a code, said as a problem to the team and the portal, and in words in the mail log. */
export type CcRefusal = 'invalid' | 'own' | 'team' | 'requester' | 'full' | 'removed' | 'stopped';
type Refused = { email: string; why: CcRefusal; max: number };

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

/** The most a request at this desk copies at once (D67): its managers' choice, else REQUEST_CCS_MAX. */
export function deskCcsMax(s: SchemaSnapshot, projectId: string): number {
  const p = s.projects.get(projectId);
  return p ? projectSettings(p).helpdesk.ccsMax : REQUEST_CCS_MAX;
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

/**
 * Who did it: someone on the team, or the requester (by email, or on the portal). `confirmed`: the Cc
 * of their new request's email, held until they confirmed it (D67), by its link or on the portal.
 */
type By = { via: 'team'; userId: string } | { via: 'email' | 'portal'; requesterName: string; confirmed?: boolean };

interface Copied {
  added: CcRow[];
  refused: Refused[];
  activities: ActivityRow[];
}

/** Lock a request's row for a change to whom it copies: the cap is counted under it. Its requester's address, or null when it's no request. */
async function lockRequest(tx: Db, issueId: string): Promise<{ requesterEmail: string } | null> {
  const [locked] = await tx.select({ requesterId: helpdeskRequests.requesterId }).from(helpdeskRequests).where(eq(helpdeskRequests.issueId, issueId)).for('update');
  if (!locked) return null;
  const [requester] = await tx.select({ email: requesters.email }).from(requesters).where(eq(requesters.id, locked.requesterId));
  return { requesterEmail: requester?.email ?? '' };
}

/** Why an address can't be on a request at all, whoever asks: not one a person reads, a4a's own, its requester's, or the team's. */
function standingRefusal(email: string, own: (e: string) => boolean, team: Set<string>, requesterEmail: string): CcRefusal | null {
  if (!readableAddress(email)) return 'invalid';
  if (own(email)) return 'own';
  if (requesterEmail && lower(requesterEmail) === lower(email)) return 'requester';
  if (team.has(lower(email))) return 'team';
  return null;
}

/**
 * Copy these people on a request, in the caller's transaction, as `ctx`. Each address is copied, is
 * already, or is refused with a reason; refusals change nothing. Locks the request's row first.
 * Whoever is copied is no longer held (D67).
 */
async function copyIn(tx: Db, ctx: Ctx, issue: IssueRow, people: Person[], by: By): Promise<Copied> {
  const app = ctx.app;
  const locked = await lockRequest(tx, issue.id);
  if (!locked) return { added: [], refused: [], activities: [] };
  const rows = await tx.select().from(requestCcs).where(eq(requestCcs.issueId, issue.id));
  const byAddress = new Map(rows.map((r) => [lower(r.email), r]));
  let active = rows.filter((r) => !r.removedAt).length;
  const own = await ownCheck(app, tx);
  const team = await teamAddresses(tx, people.map((p) => p.email));
  const s = await app.schema.get(tx);
  const max = deskCcsMax(s, issue.projectId);
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
    // Copied by their customer group (D56's revisit), they're copied now for a reason of their own: the
    // row becomes this copy, which hears whatever the group shares, and it takes no more room.
    const takesOver = Boolean(had && !had.removedAt && had.via === 'group');
    let why: CcRefusal | null = standingRefusal(email, own, team, locked.requesterEmail);
    if (!why && had && !had.removedAt && !takesOver) {
      // Copied already: nothing changes, but a hold for them is settled.
      await tx.delete(requestCcHolds).where(and(eq(requestCcHolds.issueId, issue.id), sql`lower(${requestCcHolds.email}) = ${key}`));
      continue;
    }
    const gone = had?.removedAt ? had : null;
    // An address taken off isn't put back by an email's Cc; nor by the requester, once they stopped it
    // themselves, from an email or by stopping their group's emails.
    if (!why && gone && by.via === 'email' && !by.confirmed) why = 'removed';
    else if (!why && gone && by.via !== 'team' && (gone.removedVia === 'unsubscribe' || gone.removedVia === 'group')) why = 'stopped';
    // Lowering the cap takes no one off (D67): it stops new copies past it.
    else if (!why && !takesOver && active >= max) why = 'full';
    if (why) {
      out.refused.push({ email, why, max });
      continue;
    }
    const addedById = by.via === 'team' ? by.userId : null;
    const values = { name: name || had?.name || '', via: by.via, groupId: null, addedById, addedAt: new Date(), removedAt: null, removedVia: null, removedById: null };
    const [row] = had
      ? await tx.update(requestCcs).set(values).where(eq(requestCcs.id, had.id)).returning()
      : await tx
          .insert(requestCcs)
          .values({ id: newId(), issueId: issue.id, email, ...values })
          .returning();
    await tx.delete(requestCcHolds).where(and(eq(requestCcHolds.issueId, issue.id), sql`lower(${requestCcHolds.email}) = ${key}`));
    if (!takesOver) active++;
    out.added.push(row!);
    const via = by.via !== 'team' && by.confirmed ? 'confirmed' : by.via;
    out.activities.push(
      await recordActivity(tx, ctx, {
        type: 'request.cc_added',
        projectId: issue.projectId,
        issueId: issue.id,
        payload: { issue: ref, data: { cc: { email: row!.email, name: row!.name }, via, ...(by.via !== 'team' ? { requester: { name: by.requesterName } } : {}) } },
      }),
    );
  }
  return out;
}

/** A refusal as the team and the portal are told it, with its fix. */
export function refusalProblem(r: Refused): AppError {
  switch (r.why) {
    case 'own':
      return badRequest(`${r.email} is an address of a4a’s or a help desk’s own`, 'Copy people outside a4a: mail to its own addresses would come back to it.').said('requestCcs.ownAddress', { email: r.email });
    case 'team':
      return badRequest(`${r.email} belongs to someone on the team`, 'People on the team follow a request by watching it.').said('requestCcs.teamAddress', { email: r.email });
    case 'requester':
      return badRequest(`${r.email} is the requester’s own address`, 'The requester gets every email about it already.').said('requestCcs.requesterAddress', { email: r.email });
    case 'full': {
      // The API's English says the desk's cap as the catalog's plural does: "1 person", "20 people".
      const people = new Intl.PluralRules('en').select(r.max) === 'one' ? 'person' : 'people';
      return conflict(`A request copies at most ${r.max} ${people}`, 'Stop copying someone first.').said('requestCcs.full', { max: r.max });
    }
    case 'stopped':
    case 'removed':
      return conflict(`${r.email} asked to stop emails about this request`, 'Ask the team, who can copy them again.').said('requestCcs.theyStopped', { email: r.email });
    default:
      return badRequest(`${r.email} isn’t an address a person reads`, 'Give an address such as anna@example.com: not one that takes no replies.').said('requestCcs.notAnAddress', { email: r.email });
  }
}

/** The log's words for an address an email's Cc didn't copy, or hold. */
function refusalWords(r: Refused): string {
  const why: Record<CcRefusal, string> = {
    invalid: 'not an address a person reads',
    own: 'an address of a4a’s own',
    team: 'someone on the team',
    requester: 'the requester',
    full: `the desk copies at most ${r.max} on a request`,
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

/**
 * Each of these copies of one request, and whether it hears of it now: the seam's `groupCopyHears`,
 * over the request's group and privacy and where each group's copy stands with its group (D56's
 * revisit). Every email to them, every list of who is copied and every relay asks this.
 */
async function withHearing(db: Db, issueId: string, rows: CcRow[]): Promise<{ row: CcRow; hears: boolean }[]> {
  const byGroup = rows.filter((r) => r.via === 'group');
  if (!byGroup.length) return rows.map((row) => ({ row, hears: true }));
  const [request] = await db
    .select({ requesterId: helpdeskRequests.requesterId, groupId: helpdeskRequests.groupId, private: helpdeskRequests.private })
    .from(helpdeskRequests)
    .where(eq(helpdeskRequests.issueId, issueId));
  const standings = await groupCopyStandings(db, request?.groupId ?? null, byGroup.map((r) => r.email));
  return rows.map((row) => ({ row, hears: Boolean(request) && groupCopyHears(request!, row, standings.get(lower(row.email))) }));
}

/** A copy as the emails to it need it (D56's revisit): whether it hears now, and, for a group's, the group and the requester the address is. */
export async function copyStanding(db: Db, cc: CcRow): Promise<{ hears: boolean; group: { id: string; name: string; sharing: CustomerSharing } | null; requesterId: string | null }> {
  const [one] = await withHearing(db, cc.issueId, [cc]);
  if (cc.via !== 'group' || !cc.groupId) return { hears: Boolean(one?.hears), group: null, requesterId: null };
  const [group] = await db.select({ id: customerGroups.id, name: customerGroups.name, sharing: customerGroups.sharing }).from(customerGroups).where(eq(customerGroups.id, cc.groupId));
  const [who] = await db.select({ id: requesters.id }).from(requesters).where(sql`lower(${requesters.email}) = ${lower(cc.email)}`);
  return { hears: Boolean(one?.hears && group && who), group: group ? { ...group, sharing: group.sharing as CustomerSharing } : null, requesterId: who?.id ?? null };
}

/**
 * Who is copied on a request now, first copied first, as the team sees them: each with the group that
 * copied them, if one did, and whether they hear of it now, so a group's copy that doesn't isn't
 * listed as hearing (D56's revisit). Every one of them counts against the desk's cap.
 */
export async function ccsOf(db: Db, s: SchemaSnapshot, issueId: string): Promise<RequestCc[]> {
  const rows = await db
    .select()
    .from(requestCcs)
    .where(and(eq(requestCcs.issueId, issueId), isNull(requestCcs.removedAt)))
    .orderBy(asc(requestCcs.addedAt), asc(requestCcs.id));
  const ids = [...new Set(rows.flatMap((r) => (r.groupId ? [r.groupId] : [])))];
  const names = new Map(ids.length ? (await db.select({ id: customerGroups.id, name: customerGroups.name }).from(customerGroups).where(inArray(customerGroups.id, ids))).map((g) => [g.id, g.name]) : []);
  return (await withHearing(db, issueId, rows)).map(({ row: r, hears }) => {
    const by = r.addedById ? s.users.get(r.addedById) : undefined;
    const group = r.via === 'group' && r.groupId ? (names.get(r.groupId) ?? null) : null;
    return { email: r.email, name: r.name, via: r.via as RequestCcVia, addedBy: by ? userRefDto(by) : null, addedAt: r.addedAt.toISOString(), group, hears };
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
 * changes nothing; one taken off before is copied again; one held is copied, and held no longer.
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
    return takeOff(tx, ctx, issue, (r) => lower(r.email) === lower(email), { via: 'team' });
  });
  await publishActivities(ctx.app, activities);
  return ccsOf(ctx.db, await ctx.app.schema.get(), issue.id);
}

/**
 * Who takes someone off: the team, the CC themselves from an email's link, the requester on the portal
 * (D67), or the CC stopping their customer group's emails, from a link or on the portal (D56's revisit).
 */
type OffBy = { via: 'team' } | { via: 'unsubscribe' } | { via: 'portal'; requesterName: string } | { via: 'group'; group: string; where: 'link' | 'portal' };

/** Take the CC that matches off a request, in the caller's transaction, with its activity. */
async function takeOff(tx: Db, ctx: Ctx, issue: IssueRow, which: (r: CcRow) => boolean, by: OffBy): Promise<ActivityRow[]> {
  await tx.select({ id: helpdeskRequests.issueId }).from(helpdeskRequests).where(eq(helpdeskRequests.issueId, issue.id)).for('update');
  const row = (await tx.select().from(requestCcs).where(and(eq(requestCcs.issueId, issue.id), isNull(requestCcs.removedAt)))).find(which);
  if (!row) return [];
  await tx
    .update(requestCcs)
    .set({ removedAt: new Date(), removedVia: by.via, removedById: by.via === 'team' ? ctx.actor.user.id : null })
    .where(eq(requestCcs.id, row.id));
  const s = await ctx.app.schema.get(tx);
  const ref = issueRef(s, issue, (await stateNames(tx, s, [issue.id])).get(issue.id) ?? null);
  // Stopped from an email, it's them acting, through the help desk; taken off on the portal, its requester (D67): their name in the history.
  // Stopping their group's emails, it's them too, and the history says which group's, and where (D56's revisit).
  const actor =
    by.via === 'unsubscribe' || by.via === 'group' ? { requester: { name: row.name || row.email } } : by.via === 'portal' ? { requester: { name: by.requesterName } } : {};
  const group = by.via === 'group' ? { group: { name: by.group }, where: by.where } : {};
  return [
    await recordActivity(tx, ctx, {
      type: 'request.cc_removed',
      projectId: issue.projectId,
      issueId: issue.id,
      payload: { issue: ref, data: { cc: { email: row.email, name: row.name }, via: by.via, ...actor, ...group } },
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
 * A customer group's people, copied on its new request to hear by email (D56's revisit), in the
 * transaction that files it: only where the group shares its requests with them (`read` or
 * `comment`) and the request isn't kept from it, since an email that quotes the team's reply is
 * seeing the request. Up to the desk's own cap, counting whom the email copied already, in the
 * cap's order (`groupCopyCandidates`: those added by hand, then those who asked most recently); never
 * the desk's own addresses, the team's, the requester's, or anyone who stopped the group's emails. No
 * line in the history: the request is the group's already. Each copy keeps its group, and hears only
 * while the group shares this request with them (the seam's `groupCopyHears`).
 */
export async function copyGroupMembers(tx: Db, app: AppServices, issue: IssueRow, group: GroupRow): Promise<void> {
  const [now] = await tx.select().from(customerGroups).where(eq(customerGroups.id, group.id));
  if (!now || (now.sharing !== 'read' && now.sharing !== 'comment')) return;
  const [request] = await tx.select({ private: helpdeskRequests.private, requesterId: helpdeskRequests.requesterId }).from(helpdeskRequests).where(eq(helpdeskRequests.issueId, issue.id));
  if (!request || request.private) return;
  // Takes turns with someone stopping the group's emails at this moment (groupCopyLock).
  await groupCopyLock(tx, now.id, false);
  const [asker] = await tx.select({ email: requesters.email }).from(requesters).where(eq(requesters.id, request.requesterId));
  const rows = await tx.select().from(requestCcs).where(eq(requestCcs.issueId, issue.id));
  const known = new Set(rows.map((r) => lower(r.email)));
  let active = rows.filter((r) => !r.removedAt).length;
  const max = deskCcsMax(await app.schema.get(tx), issue.projectId);
  if (active >= max) return;
  const own = await ownCheck(app, tx);
  // A few more than there's room for, for those already on it and addresses refused here.
  for (const m of await groupCopyCandidates(tx, now, asker?.email ?? '', max - active + known.size + 20)) {
    if (active >= max) break;
    const key = lower(m.email);
    if (known.has(key) || !readableAddress(m.email) || own(m.email)) continue;
    // By the database's clock, as the stop's turning back on is, so the seam compares like with like.
    await tx
      .insert(requestCcs)
      .values({ id: newId(), issueId: issue.id, email: m.email, name: (m.name ?? '').slice(0, 100), via: 'group', groupId: now.id, addedById: null, addedAt: sql`clock_timestamp()` })
      .onConflictDoNothing();
    known.add(key);
    active++;
  }
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
  const activities = await app.db.transaction(async (txRaw) => takeOff(txRaw as unknown as Db, ctx, row.issue, (r) => r.id === ccId, { via: 'unsubscribe' }));
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
    // A group's members are copied to hear (D56's revisit); their answering is the group's own, D56's.
    .where(and(eq(requestCcs.issueId, issueId), isNull(requestCcs.removedAt), sql`${requestCcs.via} <> 'group'`, sql`lower(${requestCcs.email}) = ${lower(email)}`));
  return row ?? null;
}

/** Those to tell of an event: copied on the request when it happened, and still, and who hear of it now (D56's revisit). */
export async function ccsToTell(db: Db, issueId: string, at: Date): Promise<CcRow[]> {
  const rows = await db
    .select()
    .from(requestCcs)
    .where(and(eq(requestCcs.issueId, issueId), isNull(requestCcs.removedAt), lte(requestCcs.addedAt, at)))
    .orderBy(asc(requestCcs.addedAt));
  return (await withHearing(db, issueId, rows)).filter((x) => x.hears).map((x) => x.row);
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

/** Who is copied on a request, as its requester sees them on the portal: those who hear of it now (D56's revisit). */
export async function portalCcsOf(db: Db, issueId: string): Promise<PortalCc[]> {
  const rows = await db
    .select()
    .from(requestCcs)
    .where(and(eq(requestCcs.issueId, issueId), isNull(requestCcs.removedAt)))
    .orderBy(asc(requestCcs.addedAt), asc(requestCcs.id));
  return (await withHearing(db, issueId, rows))
    .filter((x) => x.hears)
    .map(({ row: r }) => ({ email: r.email, name: r.name, byYou: r.via === 'email' || r.via === 'portal', addedAt: r.addedAt.toISOString() }));
}

// ---------------------------------------------------------------------------
// Stopping a customer group's emails (D56's revisit)
// ---------------------------------------------------------------------------

/** What a group copy's unsubscribe link names: the group and the requester the address is, whatever request it came with. */
export const groupStopSubject = (groupId: string, requesterId: string) => `${groupId}-${requesterId}`;

/** Whether they've stopped a group's emails now. */
export async function groupCopiesStopped(db: Db, groupId: string, requesterId: string): Promise<boolean> {
  const [row] = await db
    .select({ at: groupCopyStops.stoppedAt })
    .from(groupCopyStops)
    .where(and(eq(groupCopyStops.groupId, groupId), eq(groupCopyStops.requesterId, requesterId), isNull(groupCopyStops.resumedAt)));
  return Boolean(row);
}

/**
 * Someone stops a customer group's emails (D56's revisit), from a group copy's link or on the portal.
 * Their reason is the group, not one request, so it stops what the group copied them on: its open
 * requests, each taken off as D67 takes a CC off (`removed_via` group, in each request's history), and
 * its later ones, which don't copy them. Its resolved ones copied them before: the seam hears them no
 * more while they're stopped, and, turned back on, never again. Their own choice, told to nobody.
 * Doing it twice is the same as once: a stop kept is kept as it was.
 */
export async function stopGroupCopies(app: AppServices, groupId: string, requesterId: string, where: 'link' | 'portal'): Promise<void> {
  const [group] = await app.db.select().from(customerGroups).where(eq(customerGroups.id, groupId));
  const [who] = await app.db.select().from(requesters).where(eq(requesters.id, requesterId));
  if (!group || !who) return;
  const ctx = await botCtx(app, group.projectId);
  const activities = await app.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    // Alone, so a request of the group's filed at this moment copies them before this, or sees it.
    await groupCopyLock(tx, group.id, true);
    const [kept] = await tx.select().from(groupCopyStops).where(and(eq(groupCopyStops.groupId, group.id), eq(groupCopyStops.requesterId, who.id)));
    if (!kept) await tx.insert(groupCopyStops).values({ groupId: group.id, requesterId: who.id }).onConflictDoNothing();
    else if (kept.resumedAt) await tx.update(groupCopyStops).set({ stoppedAt: sql`clock_timestamp()`, resumedAt: null }).where(and(eq(groupCopyStops.groupId, group.id), eq(groupCopyStops.requesterId, who.id)));
    // Its open requests that copied them, in one order, so two stops at once lock them alike.
    const open = await tx
      .select({ cc: requestCcs, issue: issues })
      .from(requestCcs)
      .innerJoin(issues, eq(issues.id, requestCcs.issueId))
      .where(and(eq(requestCcs.groupId, group.id), eq(requestCcs.via, 'group'), isNull(requestCcs.removedAt), isNull(issues.resolvedAt), sql`lower(${requestCcs.email}) = ${lower(who.email)}`))
      .orderBy(asc(issues.id));
    const out: ActivityRow[] = [];
    for (const o of open) out.push(...(await takeOff(tx, ctx, o.issue, (r) => r.id === o.cc.id, { via: 'group', group: group.name, where })));
    return out;
  });
  await publishActivities(app, activities);
}

/**
 * They turn a group's emails back on, on the portal (D56's revisit): its later requests copy them
 * again. Not the ones they stopped: copies made before the stop never hear again. On already, nothing changes.
 */
export async function resumeGroupCopies(app: AppServices, groupId: string, requesterId: string): Promise<void> {
  await app.db
    .update(groupCopyStops)
    .set({ resumedAt: sql`clock_timestamp()` })
    .where(and(eq(groupCopyStops.groupId, groupId), eq(groupCopyStops.requesterId, requesterId), isNull(groupCopyStops.resumedAt)));
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

/**
 * The requester takes someone off their request, on the portal (D67): anyone copied on it, whoever
 * copied them, since what the team tells them is about the requester's request. The row stays, so an
 * email's Cc doesn't put them back; the team may copy them again, and so may the requester. The
 * history names the requester. Taking off someone not copied changes nothing.
 */
export async function uncopyFromPortal(app: AppServices, issue: IssueRow, requesterName: string, email: string): Promise<void> {
  const ctx = await botCtx(app, issue.projectId);
  const activities = await app.db.transaction(async (txRaw) => takeOff(txRaw as unknown as Db, ctx, issue, (r) => lower(r.email) === lower(email), { via: 'portal', requesterName }));
  await publishActivities(app, activities);
}

// ---------------------------------------------------------------------------
// A new request's Cc, held for its requester (D67)
// ---------------------------------------------------------------------------

/**
 * The Cc of the email that opens a request, held rather than copied, in the transaction that opens
 * it, when a4a can't trust who sent it (D67): nobody held is told anything until its requester
 * confirms them. The same addresses are left out as a copy would leave out, and at most the desk's
 * cap is held. Says, in the log's words, whom it held and whom it left out.
 */
export async function holdOnNewRequest(tx: Db, app: AppServices, issue: IssueRow, people: Person[]): Promise<{ held: string[]; left: string[] }> {
  const locked = await lockRequest(tx, issue.id);
  if (!locked || !people.length) return { held: [], left: [] };
  const own = await ownCheck(app, tx);
  const team = await teamAddresses(tx, people.map((p) => p.email));
  const max = deskCcsMax(await app.schema.get(tx), issue.projectId);
  const out = { held: [] as string[], left: [] as string[] };
  const start = Date.now();
  const seen = new Set<string>();
  for (const p of people) {
    const email = p.email.trim();
    if (seen.has(lower(email))) continue;
    seen.add(lower(email));
    const why = standingRefusal(email, own, team, locked.requesterEmail) ?? (out.held.length >= max ? 'full' : null);
    if (why) {
      out.left.push(refusalWords({ email, why, max }));
      continue;
    }
    const name = (p.name ?? '').trim().replace(/\s+/g, ' ').slice(0, 100);
    // A millisecond apart, so they're listed as the Cc named them.
    await tx
      .insert(requestCcHolds)
      .values({ id: newId(), issueId: issue.id, email, name, heldAt: new Date(start + out.held.length) })
      .onConflictDoNothing();
    out.held.push(email);
  }
  return out;
}

/** Who waits on a request for its requester to confirm them, first named first. */
export async function heldOf(db: Db, issueId: string): Promise<HeldCc[]> {
  const rows = await db.select().from(requestCcHolds).where(eq(requestCcHolds.issueId, issueId)).orderBy(asc(requestCcHolds.heldAt), asc(requestCcHolds.id));
  return rows.map((r) => ({ email: r.email, name: r.name, heldAt: r.heldAt.toISOString() }));
}

/**
 * The requester settles whom their new request's Cc named (D67): those they confirm are copied, as
 * the help desk's agent for them ("from their email, once they confirmed it"), and those they drop
 * are forgotten, told nothing. One transaction, under the request's lock. Someone the cap now keeps
 * out stays held, to confirm once there's room; anyone named who isn't held changes nothing.
 */
export async function settleHeld(app: AppServices, issue: IssueRow, requesterName: string, copy: string[], drop: string[]): Promise<{ copied: string[]; dropped: string[]; refused: Refused[] }> {
  const ctx = await botCtx(app, issue.projectId);
  const done = await app.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    await lockRequest(tx, issue.id);
    const held = new Map((await tx.select().from(requestCcHolds).where(eq(requestCcHolds.issueId, issue.id))).map((h) => [lower(h.email), h]));
    const copying = [...new Set(copy.map(lower))].flatMap((e) => (held.has(e) ? [held.get(e)!] : []));
    const copied = copying.length ? await copyIn(tx, ctx, issue, copying.map((h) => ({ email: h.email, name: h.name })), { via: 'email', requesterName, confirmed: true }) : { added: [], refused: [], activities: [] };
    // A refusal for good (the address is the team's now, say) forgets the hold; the cap keeps it, to confirm later.
    const forget = copied.refused.filter((r) => r.why !== 'full').map((r) => lower(r.email));
    const dropping = [...new Set(drop.map(lower))].filter((e) => held.has(e) && !copy.map(lower).includes(e));
    const gone = [...forget, ...dropping];
    if (gone.length) await tx.delete(requestCcHolds).where(and(eq(requestCcHolds.issueId, issue.id), sql`lower(${requestCcHolds.email}) IN (${sql.join(gone.map((e) => sql`${e}`), sql`, `)})`));
    return { copied, dropped: dropping.map((e) => held.get(e)!.email) };
  });
  await publishActivities(app, done.copied.activities);
  return { copied: done.copied.added.map((r) => r.email), dropped: done.dropped, refused: done.copied.refused };
}

const CONFIRM_PREFIX = 'hdc_';
const CONFIRM = /^hdc_[A-Za-z0-9_-]{43}$/;

const staleConfirmation = () =>
  new AppError(401, 'link_expired', 'This link has expired or was used', 'Sign in to the portal to confirm or drop the people you copied.').said('requestCcs.confirmLinkExpired');

/** Mint the link that confirms a new request's Cc (D67), as its acknowledgement is sent: only its hash is kept, good once for a few days. */
export async function mintCcConfirmation(db: Db, issueId: string): Promise<string> {
  const token = randomToken(CONFIRM_PREFIX, 32);
  await db.insert(requestCcConfirmations).values({ tokenHash: sha256(token), issueId, expiresAt: new Date(Date.now() + CC_CONFIRM_DAYS * 24 * 3_600_000) });
  return token;
}

/** Forget a confirmation link nobody received: its email's attempt failed. */
export async function forgetCcConfirmation(db: Db, token: string): Promise<void> {
  await db.delete(requestCcConfirmations).where(eq(requestCcConfirmations.tokenHash, sha256(token)));
}

async function confirmationRow(db: Db, token: string | undefined) {
  if (!token || !CONFIRM.test(token)) throw staleConfirmation();
  const [row] = await db
    .select({ c: requestCcConfirmations, issue: issues, requester: requesters })
    .from(requestCcConfirmations)
    .innerJoin(helpdeskRequests, eq(helpdeskRequests.issueId, requestCcConfirmations.issueId))
    .innerJoin(issues, eq(issues.id, helpdeskRequests.issueId))
    .innerJoin(requesters, eq(requesters.id, helpdeskRequests.requesterId))
    .where(and(eq(requestCcConfirmations.tokenHash, sha256(token)), isNull(requestCcConfirmations.usedAt), gt(requestCcConfirmations.expiresAt, new Date())));
  if (!row) throw staleConfirmation();
  return row;
}

/** What a confirmation link confirms, to show before it's used. Opening it changes nothing; a stale, used or unknown one answers alike. */
export async function ccConfirmation(app: AppServices, token: string | undefined): Promise<CcConfirmation> {
  const { c, issue } = await confirmationRow(app.db, token);
  const s = await app.schema.get();
  return {
    request: { id: readableId(s, issue), summary: issue.summary, desk: s.projects.get(issue.projectId)?.name ?? '' },
    held: await heldOf(app.db, issue.id),
    expiresAt: c.expiresAt.toISOString(),
  };
}

/**
 * Use a confirmation link, once (D67): those chosen of the held are copied, the rest dropped. Its use
 * is claimed first, in one statement, so two at once can't both settle the holds.
 */
export async function useCcConfirmation(app: AppServices, token: string | undefined, copy: string[]): Promise<CcConfirmed> {
  const { issue, requester } = await confirmationRow(app.db, token);
  const [claimed] = await app.db
    .update(requestCcConfirmations)
    .set({ usedAt: new Date() })
    .where(and(eq(requestCcConfirmations.tokenHash, sha256(token!)), isNull(requestCcConfirmations.usedAt), gt(requestCcConfirmations.expiresAt, new Date())))
    .returning();
  if (!claimed) throw staleConfirmation();
  const held = (await heldOf(app.db, issue.id)).map((h) => h.email);
  const chosen = new Set(copy.map(lower));
  const done = await settleHeld(
    app,
    issue,
    requester.name,
    held.filter((e) => chosen.has(lower(e))),
    held.filter((e) => !chosen.has(lower(e))),
  );
  return {
    copied: done.copied,
    dropped: done.dropped,
    refused: done.refused.map((r) => {
      const p = refusalProblem(r);
      return { email: r.email, key: p.words?.key ?? '', values: p.words?.values ?? {}, message: p.message };
    }),
  };
}

/** Housekeeping: holds nobody settled within CC_HOLD_DAYS, and confirmation links a day past their time. */
export async function pruneHeldCcs(db: Db, now = new Date()): Promise<void> {
  await db.delete(requestCcHolds).where(lt(requestCcHolds.heldAt, new Date(now.getTime() - CC_HOLD_DAYS * 24 * 3_600_000)));
  await db.delete(requestCcConfirmations).where(lt(requestCcConfirmations.expiresAt, new Date(now.getTime() - 24 * 3_600_000)));
}
