/**
 * The requesters' portal (D45): a requester signs in with a link sent to their email, or as their
 * desks allow, with a password or through an identity provider (D63, services/portal-sign-in.ts),
 * and sees the requests they made, with public comments only; and those filed under a customer
 * group they're in, where the group shares them (D56), unless one was kept private. They reply on
 * their own requests, and on their group's where it lets its members answer, and open new ones on a
 * desk's form without its proof of work.
 *
 * A requester is never a member: the portal answers for requests alone, through the access seam's
 * `requesterSees` (services/access.ts), and anything else, or anything not theirs, as missing. A
 * session opens only the desks that take the way it was opened (`portalSessionOpens`).
 */
import type { CustomerSharing, PortalDesk, PortalDeskSignIn, PortalMe, PortalRequest, PortalRequestDetail } from '@a4a/shared';
import { and, asc, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import type { AppServices } from '../context';
import type { Db } from '../db/client';
import { comments, customerGroups, helpdeskRequests, issues, requesterSessions, requesterSignIns, requesters } from '../db/schema';
import { AUTOMATIC, composeMail, type RenderedMail } from '../mail/compose';
import { langTag, matchLocale } from '@a4a/shared/i18n';
import { enqueueMail, kickMail, type MailRow } from '../mail/outbox';
import { randomToken, sha256 } from '../lib/crypto';
import { AppError } from '../lib/errors';
import { mailConfigured } from '../notify/state';
import { portalSessionOpens, requesterMayComment, requesterSees, type PortalSignedIn } from './access';
import { groupsOfRequester, requesterByEmail, sharingOf, type GroupRow } from './customer-groups';
import { botCtx, deskProject, openRequest, postRequesterReply } from './helpdesk';
import { applyChanges } from './issues';
import { publishActivities } from '../events/activity';
import { copyFromPortal, deskCcsMax, heldOf, portalCcsOf, refusalProblem, settleHeld, uncopyFromPortal } from './request-ccs';
import { outsideAuthors, outsideKey } from './request-authors';
import { readableId, stateNames } from './issue-refs';
import { projectSettings } from './projects';
import { translatorFor } from '../i18n';
import { assertWayTaken, deskSignIn, providerNames, prunePortalSso, requestPasswordLink, startPortalSession } from './portal-sign-in';

const SIGN_IN_PREFIX = 'hdl_';
const SESSION_PREFIX = 'hds_';
const SIGN_IN_TTL_MS = 20 * 60_000;
export const PORTAL_SESSION_MS = 30 * 24 * 3_600_000;
export const PORTAL_COOKIE = 'a4a_portal';

type RequesterRow = typeof requesters.$inferSelect;
/** A requester as their portal session knows them: how it was opened decides which desks it opens (D63). */
export type PortalViewer = RequesterRow & { signedIn: PortalSignedIn };

const missing = () => new AppError(404, 'not_found', "There's no request here", 'Open it from your list of requests.').said('portal.noRequestHere');
const signedOut = () => new AppError(401, 'unauthenticated', 'Sign in to see your requests', 'Ask for a sign-in link with your email address.').said('portal.signInToSee');

/**
 * Send a sign-in link. It says the same whether or not the address has asked for help before, so
 * the answer gives nothing away; the email itself makes the link, as tracking links are made.
 */
export async function requestSignIn(app: AppServices, email: string, desk?: string): Promise<void> {
  if (!mailConfigured(app)) {
    throw new AppError(503, 'mail_unavailable', "Signing in needs email, and this server doesn't send any", 'Use the link in an email about your request, or ask the team.').said('portal.noEmail');
  }
  await assertWayTaken(app, desk, 'link');
  const requester = await requesterByEmail(app.db, email);
  await enqueueMail(app.db, app, {
    kind: 'portal-sign-in',
    dedupeKey: `portal:${requester.id}:${Date.now()}`,
    payload: { requesterId: requester.id, desk: desk?.toUpperCase() ?? null },
    messageId: `portal.${randomToken('', 12)}`,
  });
  kickMail(app);
}

/**
 * The team invites a request's requester to the portal, the way the desk takes: the same sign-in
 * link, else a link to set a password (D63). A desk, or the requester's customer group, that signs
 * people in through a provider alone has nothing to send: they sign in there from the portal.
 */
export async function inviteRequester(app: AppServices, issueId: string, deskKey: string): Promise<void> {
  const [row] = await app.db.select({ requester: requesters, request: helpdeskRequests }).from(helpdeskRequests).innerJoin(requesters, eq(requesters.id, helpdeskRequests.requesterId)).where(eq(helpdeskRequests.issueId, issueId));
  if (!row) throw new AppError(404, 'not_found', 'This issue is no help desk request', 'Only requests have requesters to invite.').said('portal.notARequest');
  const s = await app.schema.get();
  const project = s.projects.get(row.request.projectId);
  const choice = project ? deskSignIn(project) : { link: true, password: false, providers: [] as string[] };
  const tied = (await groupsOfRequester(app.db, row.requester)).find((g) => g.projectId === row.request.projectId)?.providerId;
  if (!tied && choice.link) return requestSignIn(app, row.requester.email, deskKey);
  if (!tied && choice.password) return requestPasswordLink(app, row.requester.email, deskKey);
  throw new AppError(400, 'bad_request', 'They sign in through an identity provider, which sends no invitation', 'Send them the portal’s address: they sign in there.').said('portal.inviteThroughProvider');
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
    lang: langTag(tr.locale),
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
    .where(and(eq(requesterSignIns.tokenHash, sha256(token)), eq(requesterSignIns.purpose, 'sign-in'), isNull(requesterSignIns.usedAt), gt(requesterSignIns.expiresAt, now)))
    .returning();
  if (!used) throw new AppError(401, 'link_expired', 'This sign-in link has expired or was used', 'Ask for a new one: it comes by email in a minute.').said('portal.linkExpired');
  const signedIn: PortalSignedIn = { method: 'link', providerId: null };
  const session = await startPortalSession(app.db, used.requesterId, signedIn, PORTAL_SESSION_MS);
  const [requester] = await app.db.select().from(requesters).where(eq(requesters.id, used.requesterId));
  return { session, me: await meOf(app, { ...requester!, signedIn }) };
}

/** The requester a portal session is theirs, and how it was opened, or a 401. Seen at most once a minute, to keep writes down. */
export async function portalRequester(app: AppServices, session: string | undefined, acceptLanguage?: string | null): Promise<PortalViewer> {
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
  // Their own language (D63's revisit): the browser's, when it is one a4a speaks; the emails follow it.
  if (acceptLanguage) {
    const asked = matchLocale(acceptLanguage, app.config.defaultLocale);
    if (asked !== row.requester.locale) {
      await app.db.update(requesters).set({ locale: asked }).where(eq(requesters.id, row.requester.id));
      row.requester.locale = asked;
    }
  }
  const method = row.s.method === 'password' || row.s.method === 'sso' || row.s.method === 'passkey' ? row.s.method : 'link';
  return { ...row.requester, signedIn: { method, providerId: row.s.providerId ?? null } };
}

export async function signOut(app: AppServices, session: string | undefined): Promise<void> {
  if (session) await app.db.delete(requesterSessions).where(eq(requesterSessions.tokenHash, sha256(session)));
}

/**
 * What a session shows its requester: the groups they're in whose members share requests (those
 * are the ones they see others' requests of), and which desks it opens (D63): those that take the
 * way it was opened, through the provider their group there signs in through, if it has one.
 */
async function viewOf(app: AppServices, r: PortalViewer): Promise<{ sharing: GroupRow[]; opens: (projectId: string) => boolean; tiedAt: Map<string, string> }> {
  const s = await app.schema.get();
  const groups = await groupsOfRequester(app.db, r);
  const tiedAt = new Map(groups.flatMap((g) => (g.providerId ? [[g.projectId, g.providerId] as const] : [])));
  const opens = (projectId: string) => {
    const p = s.projects.get(projectId);
    return Boolean(p) && portalSessionOpens(deskSignIn(p!), tiedAt.get(projectId) ?? null, r.signedIn);
  };
  return { sharing: groups.filter((g) => g.sharing !== 'none' && opens(g.projectId)), opens, tiedAt };
}

async function sharingGroups(app: AppServices, r: PortalViewer): Promise<GroupRow[]> {
  return (await viewOf(app, r)).sharing;
}

async function meOf(app: AppServices, r: PortalViewer): Promise<PortalMe> {
  const s = await app.schema.get();
  const view = await viewOf(app, r);
  const groups = view.sharing.flatMap((g) => {
    const desk = s.projects.get(g.projectId);
    return desk && !desk.archived ? [{ desk: { key: desk.key, name: desk.name }, name: g.name, sharing: g.sharing as 'read' | 'comment' }] : [];
  });
  // Desks with requests of their own this session doesn't open: how each signs them in instead.
  const asked = await app.db.selectDistinct({ projectId: helpdeskRequests.projectId }).from(helpdeskRequests).where(eq(helpdeskRequests.requesterId, r.id));
  const closed = asked.map((a) => s.projects.get(a.projectId)).filter((p): p is NonNullable<typeof p> => Boolean(p) && !p!.archived && !view.opens(p!.id));
  const ways = closed.map((p) => {
    const tied = view.tiedAt.get(p.id);
    const choice = deskSignIn(p);
    return { desk: { key: p.key, name: p.name }, link: !tied && choice.link, password: !tied && choice.password, passkey: !tied && Boolean(choice.passkey), ids: tied ? [tied] : choice.providers };
  });
  const names = await providerNames(app.db, [...new Set([...ways.flatMap((w) => w.ids), ...(r.signedIn.providerId ? [r.signedIn.providerId] : [])])]);
  const elsewhere: PortalDeskSignIn[] = ways
    .map(({ ids, ...w }) => ({ ...w, providers: ids.flatMap((id) => (names.has(id) ? [{ id, name: names.get(id)! }] : [])) }))
    .sort((a, b) => a.desk.name.localeCompare(b.desk.name));
  const via = r.signedIn.providerId;
  return {
    name: r.name,
    email: r.email,
    groups,
    signedInWith: { method: r.signedIn.method, provider: via && names.has(via) ? { id: via, name: names.get(via)! } : null },
    password: Boolean(r.passwordHash),
    passwords: [...s.projects.values()].some((p) => !p.archived && projectSettings(p).helpdesk.enabled && deskSignIn(p).password),
    elsewhere,
  };
}

export async function portalMe(app: AppServices, r: PortalViewer): Promise<PortalMe> {
  return meOf(app, r);
}

export async function renameRequester(app: AppServices, r: PortalViewer, name: string): Promise<PortalMe> {
  await app.db.update(requesters).set({ name: name.trim().replace(/\s+/g, ' '), updatedAt: new Date() }).where(eq(requesters.id, r.id));
  const [fresh] = await app.db.select().from(requesters).where(eq(requesters.id, r.id));
  return meOf(app, { ...fresh!, signedIn: r.signedIn });
}

type Row = { request: typeof helpdeskRequests.$inferSelect; issue: typeof issues.$inferSelect; requester: RequesterRow; copied: boolean };
type Sharing = Map<string, CustomerSharing>;

async function visibleRows(app: AppServices, r: PortalViewer, groups: Sharing, only?: string): Promise<Row[]> {
  // Only at the desks this session opens (D63): at any other, nothing of theirs is here.
  const s = await app.schema.get();
  const { opens } = await viewOf(app, r);
  const desks = [...s.projects.values()].filter((p) => opens(p.id)).map((p) => p.id);
  if (!desks.length) return [];
  // Theirs, and those they're copied on (D57).
  const theirs = sql`(${helpdeskRequests.requesterId} = ${r.id} OR ${copiedSql(r.email)})`;
  // Their groups': filed under a group of theirs that shares, and not kept private (D56).
  const shared = groups.size ? and(inArray(helpdeskRequests.groupId, [...groups.keys()]), eq(helpdeskRequests.private, false)) : undefined;
  const rows = await app.db
    .select({ request: helpdeskRequests, issue: issues, requester: requesters, copied: sql<boolean>`${copiedSql(r.email)}` })
    .from(helpdeskRequests)
    .innerJoin(issues, eq(issues.id, helpdeskRequests.issueId))
    .innerJoin(requesters, eq(requesters.id, helpdeskRequests.requesterId))
    .where(and(inArray(helpdeskRequests.projectId, desks), shared ? sql`(${theirs} OR ${shared})` : theirs, only ? eq(issues.id, only) : undefined))
    .orderBy(desc(issues.updatedAt))
    .limit(only ? 1 : 200);
  // The seam decides, row by row, whatever the query found.
  return rows
    .map((row) => ({ ...row, copied: row.copied === true || String(row.copied) === 'true' }))
    .filter((row) => opens(row.request.projectId) && requesterSees(row.request, r, groups, row.copied));
}

/** Whether this address is copied on the request now (D57), as SQL over the request's row. */
function copiedSql(email: string) {
  // A group's members are copied to hear by email (D56's revisit), not to open the portal's replying: the sharing decides that.
  return sql`EXISTS (SELECT 1 FROM request_ccs c WHERE c.issue_id = ${helpdeskRequests.issueId} AND c.removed_at IS NULL AND c.via <> 'group' AND lower(c.email) = ${email.trim().toLowerCase()})`;
}

async function summaries(app: AppServices, r: PortalViewer, groups: Sharing, rows: Row[]): Promise<PortalRequest[]> {
  const s = await app.schema.get();
  const states = await stateNames(app.db, s, rows.map((x) => x.issue.id));
  const ids = [...new Set(rows.map((x) => x.request.groupId).filter((id): id is string => Boolean(id)))];
  const named = new Map(ids.length ? (await app.db.select().from(customerGroups).where(inArray(customerGroups.id, ids))).map((g) => [g.id, g]) : []);
  return rows.map(({ issue, requester, request, copied }) => {
    const project = s.projects.get(issue.projectId)!;
    const group = request.groupId ? named.get(request.groupId) : undefined;
    return {
      copied: copied && requester.id !== r.id,
      id: readableId(s, issue),
      desk: { key: project.key, name: project.name },
      summary: issue.summary,
      state: { name: states.get(issue.id) ?? null, resolved: issue.resolvedAt !== null },
      createdAt: issue.createdAt.toISOString(),
      updatedAt: issue.updatedAt.toISOString(),
      requester: { name: requester.name, mine: requester.id === r.id },
      // The group it's shared with, when its members share; a group that shares nothing isn't news to them.
      group: group && group.sharing !== 'none' ? group.name : null,
      private: request.private,
      canReply: requesterMayComment(request, r, groups, copied),
    };
  });
}

export async function portalRequests(app: AppServices, r: PortalViewer): Promise<PortalRequest[]> {
  const groups = sharingOf(await sharingGroups(app, r));
  return summaries(app, r, groups, await visibleRows(app, r, groups));
}

/** A request by its readable id, when they see it; missing otherwise, alike. */
async function oneRow(app: AppServices, r: PortalViewer, id: string, groups: Sharing): Promise<Row> {
  const s = await app.schema.get();
  const m = /^([A-Za-z][A-Za-z0-9_]*)-(\d+)$/.exec(id.trim());
  const project = m ? s.projectsByKey.get(m[1]!.toUpperCase()) : undefined;
  if (!m || !project) throw missing();
  const [issue] = await app.db.select({ id: issues.id }).from(issues).where(and(eq(issues.projectId, project.id), eq(issues.number, Number(m[2]))));
  const row = issue ? (await visibleRows(app, r, groups, issue.id))[0] : undefined;
  if (!row) throw missing();
  return row;
}

export async function portalRequest(app: AppServices, r: PortalViewer, id: string): Promise<PortalRequestDetail> {
  const groups = sharingOf(await sharingGroups(app, r));
  const row = await oneRow(app, r, id, groups);
  const [summary] = await summaries(app, r, groups, [row]);
  const s = await app.schema.get();
  const rows = await app.db
    .select()
    .from(comments)
    .where(and(eq(comments.issueId, row.issue.id), eq(comments.visibility, 'public'), isNull(comments.deletedAt)))
    .orderBy(asc(comments.createdAt));
  // Who outside the team wrote each: its requester, someone copied on it (D57), or a colleague (D56).
  const outside = await outsideAuthors(app.db, rows);
  return {
    ...summary!,
    // Its requester sees who is copied, copies more and takes anyone off (D67); anyone else isn't shown the list.
    ccs: row.requester.id === r.id ? await portalCcsOf(app.db, row.issue.id) : null,
    // And whom the Cc of the email that opened it named, waiting for them to confirm (D67).
    held: row.requester.id === r.id ? await heldOf(app.db, row.issue.id) : null,
    ccsMax: deskCcsMax(s, row.issue.projectId),
    description: row.issue.description,
    // The team by name, them as "you", its requester or a colleague by name, someone copied on it
    // (D57) by name; never anything internal.
    messages: rows.map((c) => {
      const author = c.authorId ? s.users.get(c.authorId) : undefined;
      const other = c.requesterId ? outside.get(outsideKey(c.issueId, c.requesterId)) : undefined;
      const from = c.requesterId === r.id ? ('you' as const) : other?.as === 'copied' ? ('cc' as const) : c.requesterId ? ('colleague' as const) : ('team' as const);
      return {
        id: c.id,
        from,
        name: c.requesterId ? (other?.name ?? 'Someone') : author ? (author.isBot ? author.login : author.name) : 'The team',
        text: c.text,
        at: c.createdAt.toISOString(),
        aiDrafted: c.aiDrafted,
      };
    }),
  };
}

/**
 * Their reply: on a request of their own; on one they're copied on (D57); or on one of their group's
 * where the group lets its members answer each other's (D56). A public comment in their name, as on
 * the tracking page. A colleague's reaches the request's requester by email too; a4a carries no words
 * of someone copied to anyone (D57).
 */
/** A request of theirs, their group's (where it shares) or one they're copied on, for what their
 * pages' own seam needs (D39's pictures, D59's writing help): its issue and whether they may
 * answer it. Missing to anyone else, in the portal's words.
 */
export async function requesterRequest(app: AppServices, r: PortalViewer, id: string): Promise<{ issue: Row['issue']; canReply: boolean }> {
  const groups = sharingOf(await sharingGroups(app, r));
  const row = await oneRow(app, r, id, groups);
  return { issue: row.issue, canReply: requesterMayComment(row.request, r, groups, row.copied) };
}

export async function portalReply(app: AppServices, r: PortalViewer, id: string, text: string, aiDrafted = false): Promise<PortalRequestDetail> {
  const groups = sharingOf(await sharingGroups(app, r));
  const row = await oneRow(app, r, id, groups);
  if (!requesterMayComment(row.request, r, groups, row.copied)) {
    throw new AppError(403, 'forbidden', "This is a colleague's request: you can read it, and they reply", 'Open a request of your own to ask something.').said('portal.colleaguesRequest');
  }
  // Theirs, or a colleague's; one copied on it writes as themselves. Signed in, a4a knows who wrote it, so
  // where the desk relays, everyone else on it hears it (D67).
  const colleague = row.requester.id !== r.id && !row.copied;
  await postRequesterReply(app, row.issue, { id: r.id, name: r.name }, text, 'page', { colleague, relay: { on: 'portal', sender: r.email, trusted: true }, aiDrafted });
  return portalRequest(app, r, id);
}

/**
 * Keep a request of theirs from their group's other members, or share it again (D56): a change to
 * the request, by the help desk's agent in their name, in its history. Only its requester does this
 * here; the team does it on the request's page.
 */
export async function portalSetPrivate(app: AppServices, r: PortalViewer, id: string, value: boolean): Promise<PortalRequestDetail> {
  const groups = sharingOf(await sharingGroups(app, r));
  const row = await oneRow(app, r, id, groups);
  if (row.requester.id !== r.id) {
    throw new AppError(403, 'forbidden', 'Only its requester keeps a request private', 'Ask them, or the team.').said('portal.onlyRequesterKeepsPrivate');
  }
  const ctx = await botCtx(app, row.issue.projectId);
  const res = await app.db.transaction(async (tx) => applyChanges(tx as unknown as Db, ctx, row.issue, { requestPrivate: value, data: { requester: { name: r.name } } }));
  await publishActivities(app, res.activities);
  return portalRequest(app, r, id);
}

/** The desks they may open a request at from the portal: open desks they've asked before, or whose page they came from, that this session opens. */
export async function portalDesks(app: AppServices, r: PortalViewer): Promise<PortalDesk[]> {
  const s = await app.schema.get();
  const view = await viewOf(app, r);
  const used = await app.db.selectDistinct({ projectId: helpdeskRequests.projectId }).from(helpdeskRequests).where(eq(helpdeskRequests.requesterId, r.id));
  const ids = new Set([...used.map((u) => u.projectId), ...view.sharing.map((g) => g.projectId)]);
  return [...s.projects.values()]
    .filter((p) => ids.has(p.id) && !p.archived && projectSettings(p).helpdesk.enabled && view.opens(p.id))
    .map((p) => ({ key: p.key, name: p.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** A new request from the portal: they're known, so no proof of work; as the form files one. */
export async function portalNewRequest(app: AppServices, r: PortalViewer, input: { desk: string; summary: string; description: string; private?: boolean }): Promise<PortalRequestDetail> {
  const project = await deskProject(app, input.desk);
  // A desk this session doesn't open takes nothing from it either: what they ask there, they'd not see.
  if (!(await viewOf(app, r)).opens(project.id)) {
    throw new AppError(403, 'method_off', `${project.name} signs you in another way`, 'Sign out, and sign in from its page.').said('portal.deskSignsInAnotherWay', { desk: project.name });
  }
  const issue = await openRequest(app, project, { name: r.name, email: r.email, summary: input.summary, description: input.description, via: 'form', private: input.private ?? false });
  return portalRequest(app, r, issue.id);
}

/** Forget sessions and links past their time (a chore). */
export async function prunePortal(db: Db): Promise<void> {
  await db.delete(requesterSessions).where(sql`${requesterSessions.expiresAt} < now()`);
  await db.delete(requesterSignIns).where(sql`${requesterSignIns.expiresAt} < now() - interval '1 day'`);
  await prunePortalSso(db);
}

/**
 * The requester copies someone on a request of theirs, on the portal (D57): anyone they choose, as
 * forwarding its emails would. Someone copied on it, or a colleague, can't copy others.
 */
export async function portalCopy(app: AppServices, r: PortalViewer, id: string, person: { email: string; name?: string }): Promise<PortalRequestDetail> {
  const groups = sharingOf(await sharingGroups(app, r));
  const row = await oneRow(app, r, id, groups);
  if (row.requester.id !== r.id) {
    throw new AppError(403, 'forbidden', 'Only the person who asked can copy others on a request', 'Ask them, or the team.').said('portal.onlyTheRequesterCopies');
  }
  await copyFromPortal(app, row.issue, r.name, person);
  return portalRequest(app, r, id);
}

/** Only a request's requester changes whom it copies on the portal (D67): a colleague or someone copied is told so. */
function onlyTheRequester(): AppError {
  return new AppError(403, 'forbidden', 'Only the person who asked can change who is copied on a request', 'Ask them, or the team. To stop being copied yourself, use the link at the end of any email about it.').said(
    'portal.onlyTheRequesterChangesCopies',
  );
}

/**
 * The requester takes someone off a request of theirs, on the portal (D67): anyone copied on it, those
 * the team copied too, since what they're told is the requester's request. Kept as D57 keeps them, so
 * an email's Cc doesn't put them back, and the history names the requester. A colleague (D56) or
 * someone copied can't.
 */
export async function portalUncopy(app: AppServices, r: PortalViewer, id: string, email: string): Promise<PortalRequestDetail> {
  const groups = sharingOf(await sharingGroups(app, r));
  const row = await oneRow(app, r, id, groups);
  if (row.requester.id !== r.id) throw onlyTheRequester();
  await uncopyFromPortal(app, row.issue, r.name, email);
  return portalRequest(app, r, id);
}

/**
 * The requester copies or drops someone the Cc of their new request's email named, held for them to
 * confirm (D67). Copied, they hear the team's replies from now on; dropped, they're told nothing. A
 * cap that keeps them out is said as a copy's is, and they stay held.
 */
export async function portalSettleHeld(app: AppServices, r: PortalViewer, id: string, email: string, copy: boolean): Promise<PortalRequestDetail> {
  const groups = sharingOf(await sharingGroups(app, r));
  const row = await oneRow(app, r, id, groups);
  if (row.requester.id !== r.id) throw onlyTheRequester();
  const done = await settleHeld(app, row.issue, r.name, copy ? [email] : [], copy ? [] : [email]);
  if (done.refused[0]) throw refusalProblem(done.refused[0]);
  return portalRequest(app, r, id);
}
