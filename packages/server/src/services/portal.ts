/**
 * The requesters' portal (D45): a requester signs in with a link sent to their email, no password
 * to forget, and sees the requests they made, with public comments only; and, where a desk shares
 * them, their organization's (requesters of an email domain the desk names). They reply on their
 * own requests, and open new ones on a desk's form without its proof of work.
 *
 * A requester is never a member: the portal answers for requests alone, through the access seam's
 * `requesterSees` (services/access.ts), and anything else, or anything not theirs, as missing.
 */
import type { PortalDesk, PortalMe, PortalRequest, PortalRequestDetail } from '@a4a/shared';
import { and, asc, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import type { AppServices } from '../context';
import type { Db } from '../db/client';
import { comments, helpdeskRequests, issues, requestCcs, requesterSessions, requesterSignIns, requesters } from '../db/schema';
import { AUTOMATIC, composeMail, type RenderedMail } from '../mail/compose';
import { enqueueMail, kickMail, type MailRow } from '../mail/outbox';
import { randomToken, sha256 } from '../lib/crypto';
import { AppError } from '../lib/errors';
import { newId } from '../lib/ids';
import { mailConfigured } from '../notify/state';
import { emailDomain, requesterSees } from './access';
import { deskProject, openRequest, postRequesterReply } from './helpdesk';
import { copyFromPortal, portalCcsOf } from './request-ccs';
import { readableId, stateNames } from './issue-refs';
import { projectSettings } from './projects';
import type { SchemaSnapshot } from './schema-cache';
import { translatorFor } from '../i18n';

const SIGN_IN_PREFIX = 'hdl_';
const SESSION_PREFIX = 'hds_';
const SIGN_IN_TTL_MS = 20 * 60_000;
export const PORTAL_SESSION_MS = 30 * 24 * 3_600_000;
export const PORTAL_COOKIE = 'a4a_portal';

type RequesterRow = typeof requesters.$inferSelect;

const missing = () => new AppError(404, 'not_found', "There's no request here", 'Open it from your list of requests.').said('portal.noRequestHere');
const signedOut = () => new AppError(401, 'unauthenticated', 'Sign in to see your requests', 'Ask for a sign-in link with your email address.').said('portal.signInToSee');

/** Find the requester an email names, or make them, named for the email until they say otherwise. */
async function requesterByEmail(db: Db, email: string): Promise<RequesterRow> {
  const clean = email.trim();
  const res = await db.execute(sql`
    INSERT INTO requesters (id, email, name) VALUES (${newId()}, ${clean}, ${clean.split('@')[0] || clean})
    ON CONFLICT ((lower(email))) DO UPDATE SET updated_at = requesters.updated_at
    RETURNING id`);
  const id = String((res as unknown as { rows: { id: string }[] }).rows[0]!.id);
  const [row] = await db.select().from(requesters).where(eq(requesters.id, id));
  return row!;
}

/**
 * Send a sign-in link. It says the same whether or not the address has asked for help before, so
 * the answer gives nothing away; the email itself makes the link, as tracking links are made.
 */
export async function requestSignIn(app: AppServices, email: string, desk?: string): Promise<void> {
  if (!mailConfigured(app)) {
    throw new AppError(503, 'mail_unavailable', "Signing in needs email, and this server doesn't send any", 'Use the link in an email about your request, or ask the team.').said('portal.noEmail');
  }
  const requester = await requesterByEmail(app.db, email);
  await enqueueMail(app.db, app, {
    kind: 'portal-sign-in',
    dedupeKey: `portal:${requester.id}:${Date.now()}`,
    payload: { requesterId: requester.id, desk: desk?.toUpperCase() ?? null },
    messageId: `portal.${randomToken('', 12)}`,
  });
  kickMail(app);
}

/** The team invites a request's requester to the portal: the same link, sent to them. */
export async function inviteRequester(app: AppServices, issueId: string, deskKey: string): Promise<void> {
  const [row] = await app.db.select({ requester: requesters }).from(helpdeskRequests).innerJoin(requesters, eq(requesters.id, helpdeskRequests.requesterId)).where(eq(helpdeskRequests.issueId, issueId));
  if (!row) throw new AppError(404, 'not_found', 'This issue is no help desk request', 'Only requests have requesters to invite.').said('portal.notARequest');
  await requestSignIn(app, row.requester.email, deskKey);
}

export async function renderPortalSignIn(app: AppServices, mail: MailRow): Promise<RenderedMail | null> {
  const p = mail.payload as { requesterId?: string; desk?: string | null };
  const [requester] = await app.db.select().from(requesters).where(eq(requesters.id, String(p.requesterId ?? '')));
  if (!requester) return null;
  const token = randomToken(SIGN_IN_PREFIX, 32);
  await app.db.insert(requesterSignIns).values({ tokenHash: sha256(token), requesterId: requester.id, expiresAt: new Date(Date.now() + SIGN_IN_TTL_MS) });
  const s = await app.schema.get();
  const desk = p.desk ? s.projectsByKey.get(p.desk) : undefined;
  // A requester has no profile: the server's language (D49).
  const tr = translatorFor(app.config.defaultLocale);
  const where = desk ? tr.t('server.portal.deskOf', { project: desk.name }) : tr.t('server.portal.theDesk');
  const subject = tr.t('server.portal.subject', { where });
  const { text, html } = composeMail(subject, {
    lead: tr.t('server.portal.lead', { where }),
    sections: [],
    action: { label: tr.t('server.portal.signIn'), url: `${app.config.publicUrl}/portal#${token}` },
    why: tr.t('server.portal.why'),
  });
  return {
    to: requester.email,
    subject,
    text,
    html,
    headers: { ...AUTOMATIC },
    onFailed: async () => void (await app.db.delete(requesterSignIns).where(eq(requesterSignIns.tokenHash, sha256(token)))),
  };
}

/** Trade a sign-in link's token, once, for a session's. */
export async function redeemSignIn(app: AppServices, token: string): Promise<{ session: string; me: PortalMe }> {
  const now = new Date();
  const [used] = await app.db
    .update(requesterSignIns)
    .set({ usedAt: now })
    .where(and(eq(requesterSignIns.tokenHash, sha256(token)), isNull(requesterSignIns.usedAt), gt(requesterSignIns.expiresAt, now)))
    .returning();
  if (!used) throw new AppError(401, 'link_expired', 'This sign-in link has expired or was used', 'Ask for a new one: it comes by email in a minute.').said('portal.linkExpired');
  const session = randomToken(SESSION_PREFIX, 32);
  await app.db.insert(requesterSessions).values({ tokenHash: sha256(session), requesterId: used.requesterId, expiresAt: new Date(now.getTime() + PORTAL_SESSION_MS) });
  const [requester] = await app.db.select().from(requesters).where(eq(requesters.id, used.requesterId));
  return { session, me: await meOf(app, requester!) };
}

/** The requester a portal session is theirs, or a 401. Seen at most once a minute, to keep writes down. */
export async function portalRequester(app: AppServices, session: string | undefined): Promise<RequesterRow> {
  if (!session?.startsWith(SESSION_PREFIX)) throw signedOut();
  const [row] = await app.db
    .select({ requester: requesters, s: requesterSessions })
    .from(requesterSessions)
    .innerJoin(requesters, eq(requesters.id, requesterSessions.requesterId))
    .where(and(eq(requesterSessions.tokenHash, sha256(session)), gt(requesterSessions.expiresAt, new Date())));
  if (!row) throw signedOut();
  if (Date.now() - row.s.lastSeenAt.getTime() > 60_000) {
    await app.db.update(requesterSessions).set({ lastSeenAt: new Date() }).where(eq(requesterSessions.tokenHash, row.s.tokenHash));
  }
  return row.requester;
}

export async function signOut(app: AppServices, session: string | undefined): Promise<void> {
  if (session) await app.db.delete(requesterSessions).where(eq(requesterSessions.tokenHash, sha256(session)));
}

async function meOf(app: AppServices, r: RequesterRow): Promise<PortalMe> {
  const s = await app.schema.get();
  const domain = emailDomain(r.email);
  const shared = [...s.projects.values()].some((p) => projectSettings(p).helpdesk.organizations.includes(domain));
  return { name: r.name, email: r.email, organization: shared ? domain : null };
}

export async function portalMe(app: AppServices, r: RequesterRow): Promise<PortalMe> {
  return meOf(app, r);
}

export async function renameRequester(app: AppServices, r: RequesterRow, name: string): Promise<PortalMe> {
  await app.db.update(requesters).set({ name: name.trim().replace(/\s+/g, ' '), updatedAt: new Date() }).where(eq(requesters.id, r.id));
  const [fresh] = await app.db.select().from(requesters).where(eq(requesters.id, r.id));
  return meOf(app, fresh!);
}

/** The desks whose requests they see: their own requests', and those that share within their organization. */
function sharingDeskIds(s: SchemaSnapshot, email: string): string[] {
  const domain = emailDomain(email);
  return [...s.projects.values()].filter((p) => projectSettings(p).helpdesk.organizations.includes(domain)).map((p) => p.id);
}

type Row = { request: typeof helpdeskRequests.$inferSelect; issue: typeof issues.$inferSelect; requester: RequesterRow; copied: boolean };

async function visibleRows(app: AppServices, r: RequesterRow, only?: string): Promise<Row[]> {
  const s = await app.schema.get();
  const desks = sharingDeskIds(s, r.email);
  const domain = emailDomain(r.email);
  // Theirs, and those they're copied on (D57).
  const theirs = sql`(${helpdeskRequests.requesterId} = ${r.id} OR ${copiedSql(r.email)})`;
  // Colleagues': in a desk that shares within this domain, from a requester of the same domain.
  const colleagues = desks.length ? and(inArray(helpdeskRequests.projectId, desks), sql`lower(split_part(${requesters.email}, '@', 2)) = ${domain}`) : undefined;
  const rows = await app.db
    .select({ request: helpdeskRequests, issue: issues, requester: requesters, copied: sql<boolean>`${copiedSql(r.email)}` })
    .from(helpdeskRequests)
    .innerJoin(issues, eq(issues.id, helpdeskRequests.issueId))
    .innerJoin(requesters, eq(requesters.id, helpdeskRequests.requesterId))
    .where(and(colleagues ? sql`(${theirs} OR ${colleagues})` : theirs, only ? eq(issues.id, only) : undefined))
    .orderBy(desc(issues.updatedAt))
    .limit(only ? 1 : 200);
  // The seam decides, row by row, whatever the query found.
  return rows
    .map((row) => ({ ...row, copied: row.copied === true || String(row.copied) === 'true' }))
    .filter((row) => {
      const project = s.projects.get(row.issue.projectId);
      return project ? requesterSees(project, r, row.requester, row.copied) : false;
    });
}

/** Whether this address is copied on the request now (D57), as SQL over the request's row. */
function copiedSql(email: string) {
  return sql`EXISTS (SELECT 1 FROM request_ccs c WHERE c.issue_id = ${helpdeskRequests.issueId} AND c.removed_at IS NULL AND lower(c.email) = ${email.trim().toLowerCase()})`;
}

async function summaries(app: AppServices, r: RequesterRow, rows: Row[]): Promise<PortalRequest[]> {
  const s = await app.schema.get();
  const states = await stateNames(app.db, s, rows.map((x) => x.issue.id));
  return rows.map(({ issue, requester, copied }) => {
    const project = s.projects.get(issue.projectId)!;
    return {
      copied: copied && requester.id !== r.id,
      id: readableId(s, issue),
      desk: { key: project.key, name: project.name },
      summary: issue.summary,
      state: { name: states.get(issue.id) ?? null, resolved: issue.resolvedAt !== null },
      createdAt: issue.createdAt.toISOString(),
      updatedAt: issue.updatedAt.toISOString(),
      requester: { name: requester.name, mine: requester.id === r.id },
    };
  });
}

export async function portalRequests(app: AppServices, r: RequesterRow): Promise<PortalRequest[]> {
  return summaries(app, r, await visibleRows(app, r));
}

/** A request by its readable id, when they see it; missing otherwise, alike. */
async function oneRow(app: AppServices, r: RequesterRow, id: string): Promise<Row> {
  const s = await app.schema.get();
  const m = /^([A-Za-z][A-Za-z0-9_]*)-(\d+)$/.exec(id.trim());
  const project = m ? s.projectsByKey.get(m[1]!.toUpperCase()) : undefined;
  if (!m || !project) throw missing();
  const [issue] = await app.db.select({ id: issues.id }).from(issues).where(and(eq(issues.projectId, project.id), eq(issues.number, Number(m[2]))));
  const row = issue ? (await visibleRows(app, r, issue.id))[0] : undefined;
  if (!row) throw missing();
  return row;
}

export async function portalRequest(app: AppServices, r: RequesterRow, id: string): Promise<PortalRequestDetail> {
  const row = await oneRow(app, r, id);
  const [summary] = await summaries(app, r, [row]);
  const s = await app.schema.get();
  const rows = await app.db
    .select()
    .from(comments)
    .where(and(eq(comments.issueId, row.issue.id), eq(comments.visibility, 'public'), isNull(comments.deletedAt)))
    .orderBy(asc(comments.createdAt));
  const byId = new Map<string, string>();
  const ids = [...new Set(rows.map((c) => c.requesterId).filter((x): x is string => Boolean(x)))];
  // Who wrote as someone copied on it: an address on its list, now or before, that isn't its requester's.
  const copiedIds = new Set<string>();
  if (ids.length) {
    const listed = new Set((await app.db.select({ email: requestCcs.email }).from(requestCcs).where(eq(requestCcs.issueId, row.issue.id))).map((c) => c.email.toLowerCase()));
    for (const q of await app.db.select().from(requesters).where(inArray(requesters.id, ids))) {
      byId.set(q.id, q.name);
      if (q.id !== row.requester.id && listed.has(q.email.toLowerCase())) copiedIds.add(q.id);
    }
  }
  return {
    ...summary!,
    // Its requester sees who is copied, and copies more; anyone else isn't shown the list.
    ccs: row.requester.id === r.id ? await portalCcsOf(app.db, row.issue.id) : null,
    description: row.issue.description,
    // The team by name, them as "you", its requester or a colleague by name, someone copied on it
    // (D57) by name; never anything internal.
    messages: rows.map((c) => {
      const author = c.authorId ? s.users.get(c.authorId) : undefined;
      const from = c.requesterId === r.id ? ('you' as const) : c.requesterId && copiedIds.has(c.requesterId) ? ('cc' as const) : c.requesterId ? ('colleague' as const) : ('team' as const);
      return {
        id: c.id,
        from,
        name: c.requesterId ? (byId.get(c.requesterId) ?? 'Someone') : author ? (author.isBot ? author.login : author.name) : 'The team',
        text: c.text,
        at: c.createdAt.toISOString(),
      };
    }),
  };
}

/** Their reply, on a request of their own or one they're copied on (D57): a public comment in their name, as on the tracking page. */
export async function portalReply(app: AppServices, r: RequesterRow, id: string, text: string): Promise<PortalRequestDetail> {
  const row = await oneRow(app, r, id);
  if (row.requester.id !== r.id && !row.copied) {
    throw new AppError(403, 'forbidden', "This is a colleague's request: you can read it, and they reply", 'Open a request of your own to ask something.').said('portal.colleaguesRequest');
  }
  await postRequesterReply(app, row.issue, { id: r.id, name: r.name }, text, 'page');
  return portalRequest(app, r, id);
}

/** The desks they may open a request at from the portal: open desks they've asked before, or whose page they came from. */
export async function portalDesks(app: AppServices, r: RequesterRow): Promise<PortalDesk[]> {
  const s = await app.schema.get();
  const used = await app.db.selectDistinct({ projectId: helpdeskRequests.projectId }).from(helpdeskRequests).where(eq(helpdeskRequests.requesterId, r.id));
  const ids = new Set([...used.map((u) => u.projectId), ...sharingDeskIds(s, r.email)]);
  return [...s.projects.values()]
    .filter((p) => ids.has(p.id) && !p.archived && projectSettings(p).helpdesk.enabled)
    .map((p) => ({ key: p.key, name: p.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** A new request from the portal: they're known, so no proof of work; as the form files one. */
export async function portalNewRequest(app: AppServices, r: RequesterRow, input: { desk: string; summary: string; description: string }): Promise<PortalRequestDetail> {
  const project = await deskProject(app, input.desk);
  const issue = await openRequest(app, project, { name: r.name, email: r.email, summary: input.summary, description: input.description, via: 'form' });
  return portalRequest(app, r, issue.id);
}

/** Forget sessions and links past their time (a chore). */
export async function prunePortal(db: Db): Promise<void> {
  await db.delete(requesterSessions).where(sql`${requesterSessions.expiresAt} < now()`);
  await db.delete(requesterSignIns).where(sql`${requesterSignIns.expiresAt} < now() - interval '1 day'`);
}

/**
 * The requester copies someone on a request of theirs, on the portal (D57): anyone they choose, as
 * forwarding its emails would. Someone copied on it, or a colleague, can't copy others.
 */
export async function portalCopy(app: AppServices, r: RequesterRow, id: string, person: { email: string; name?: string }): Promise<PortalRequestDetail> {
  const row = await oneRow(app, r, id);
  if (row.requester.id !== r.id) {
    throw new AppError(403, 'forbidden', 'Only the person who asked can copy others on a request', 'Ask them, or the team.').said('portal.onlyTheRequesterCopies');
  }
  await copyFromPortal(app, row.issue, r.name, person);
  return portalRequest(app, r, id);
}
