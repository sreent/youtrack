/**
 * A project's help desk: a public form at /help/<KEY> that files an issue for someone who isn't a
 * user, and a tracking page that shows them that one request's public conversation and state.
 *
 * - A requester isn't a user. They're a row of their own (email and name), so they never appear
 *   among people to assign or mention, can't sign in, and can be forgotten by email. Their issue is
 *   reported by the help desk's agent, `helpdesk`, through the `helpdesk` channel, and its history
 *   names them.
 * - Their way back is a tracking token: random, stored as a SHA-256 hash, and sent in each email to
 *   them, minted as the email goes (helpdesk/mails.ts). Only without SMTP is one shown on the page,
 *   once, since no email will carry it.
 * - Everything public answers for one request only, and the same way whether a project, request or
 *   token is missing or just not theirs.
 */
import type { CustomerSharing, HelpdeskRequest, HelpForm, HelpRequestReceived, Sla, TrackedRequest } from '@a4a/shared';
import { and, asc, eq, inArray, isNull, min, sql } from 'drizzle-orm';
import { adminCtx } from '../app-services';
import { requireScope, type AppServices, type Ctx, type UserRow } from '../context';
import type { Db } from '../db/client';
import { comments, customerGroups, helpdeskMailboxes, helpdeskRequests, helpdeskTokens, issues, requesters, users } from '../db/schema';
import { assignToGroupAgent, GROUP_CHANGE, groupByRef, groupOfRequester } from './customer-groups';
import { requesterPasskeyCount } from './portal-passkeys';
import { publishActivities, type ActivityRow } from '../events/activity';
import { captchaChallenge } from '../helpdesk/captcha';
import { randomToken, sha256 } from '../lib/crypto';
import { AppError, notFound } from '../lib/errors';
import { newId } from '../lib/ids';
import { enqueueMail, kickMail, mailHost } from '../mail/outbox';
import { mailConfigured, sign, verify } from '../notify/state';
import { issueRef, readableId, stateNames } from './issue-refs';
import { applyChanges, createIssue, resolveIssue } from './issues';
import { projectSettings } from './projects';
import { requestSla, resumeFields, syncClocks } from './sla';
import { projectByKey, type ProjectRow, type SchemaSnapshot } from './schema-cache';
import { insertUser } from './users';
import { ccsOf, copyOnNewRequest, deskCcsMax, heldOf, holdOnNewRequest, type Person } from './request-ccs';
import { noteNotRelayed, relayChoice, type RelayChoice, type RelayHow } from '../helpdesk/relay';
import { outsideAuthors, outsideKey } from './request-authors';
import { addWatchers } from './watchers';

/** The agent that files requests and posts requesters' replies. Agents go by their id in lower case. */
export const HELPDESK_BOT = 'helpdesk';
const TOKEN_PREFIX = 'hdt_';
const TOKEN = /^hdt_[A-Za-z0-9_-]{43}$/;
/** How long a form may be open before it's sent. */
const FORM_TTL_MS = 6 * 3_600_000;

const nothingHere = () => new AppError(404, 'not_found', "There's no help desk here", 'Check the address you were given.').said('helpdesk.noDesk');
const noRequest = () => new AppError(404, 'not_found', "This link doesn't open a request", 'Use the link in your latest email about it, whole.').said('helpdesk.linkOpensNoRequest');

/** The project whose help desk is open at this key, or nothing, whether it's missing or closed. */
function openDesk(s: SchemaSnapshot, key: string): ProjectRow | undefined {
  const p = projectByKey(s, key);
  return p && !p.archived && projectSettings(p).helpdesk.enabled ? p : undefined;
}

/** The help desk's agent, made the first time a request comes in. */
export async function helpdeskBot(app: AppServices): Promise<UserRow> {
  const find = async () => (await app.db.select().from(users).where(sql`lower(${users.login}) = ${HELPDESK_BOT}`))[0];
  let bot = await find();
  if (!bot) {
    try {
      bot = await insertUser(app.db, { login: HELPDESK_BOT, name: HELPDESK_BOT, role: 'member', isBot: true, capacityHoursPerDay: 0 });
      app.schema.invalidate();
    } catch {
      bot = await find(); // another request made it first
    }
  }
  if (!bot?.isBot) {
    throw new AppError(503, 'helpdesk_unavailable', "The help desk can't take requests right now", 'An administrator should give the person with the login "helpdesk" another login.').said('helpdesk.deskClosed');
  }
  return bot;
}

/**
 * The help desk acts for the requester with an elevated system context that reaches one project
 * only: the request's. So it files and replies in a members-only project, and nowhere else.
 */
export async function botCtx(app: AppServices, projectId: string): Promise<Ctx> {
  const ctx = adminCtx(app, await helpdeskBot(app), 'helpdesk');
  ctx.actor.projectIds = [projectId];
  return ctx;
}

/** A request, its issue and who asked, by the issue's id; null when the issue is no request. */
export async function requestWithRequester(db: Db, issueId: string) {
  const [row] = await db
    .select({ request: helpdeskRequests, requester: requesters, issue: issues })
    .from(helpdeskRequests)
    .innerJoin(requesters, eq(requesters.id, helpdeskRequests.requesterId))
    .innerJoin(issues, eq(issues.id, helpdeskRequests.issueId))
    .where(eq(helpdeskRequests.issueId, issueId));
  return row ?? null;
}

// ---------------------------------------------------------------------------
// The form, and its token against forged posts
// ---------------------------------------------------------------------------

/**
 * A form token ties a post to the form it came from: it is signed, names the project and a nonce
 * kept in a SameSite=Strict cookie, and expires. Another site can neither read it nor send the cookie.
 */
export async function formToken(app: AppServices, key: string, nonce: string, issuedAt = Date.now()): Promise<string> {
  return `${issuedAt}.${await sign(app, 'help-form', `${key.toUpperCase()}.${nonce}.${issuedAt}`)}`;
}

export async function formTokenValid(app: AppServices, key: string, nonce: string | undefined, token: string, now = Date.now()): Promise<boolean> {
  const [at, sig, ...rest] = token.split('.');
  const issuedAt = Number(at);
  if (!nonce || rest.length || !sig || !Number.isFinite(issuedAt) || issuedAt > now + 60_000 || now - issuedAt > FORM_TTL_MS) return false;
  return verify(app, 'help-form', `${key.toUpperCase()}.${nonce}.${issuedAt}`, sig);
}

export async function helpForm(app: AppServices, key: string, nonce: string): Promise<HelpForm> {
  const s = await app.schema.get();
  const p = openDesk(s, key);
  if (!p) throw nothingHere();
  const settings = projectSettings(p).helpdesk;
  return {
    project: { key: p.key, name: p.name },
    intro: settings.intro,
    csrf: await formToken(app, p.key, nonce),
    mail: mailConfigured(app),
    captcha: settings.captcha ? await captchaChallenge(app, p.key) : null,
    email: await deskAddress(app, p.id),
  };
}

/**
 * The address a desk takes mail at (D30): only once mail can reach it, by its webhook's secret or
 * the shared mailbox, so nobody is offered an address, or a reply address, that leads nowhere.
 */
export async function deskAddress(app: AppServices, projectId: string): Promise<string | null> {
  const [row] = await app.db
    .select({ address: helpdeskMailboxes.address, secret: helpdeskMailboxes.secretHash, imap: helpdeskMailboxes.imapUrlSealed })
    .from(helpdeskMailboxes)
    .where(eq(helpdeskMailboxes.projectId, projectId));
  return row && (row.secret || row.imap || app.config.helpdeskImapUrl) ? row.address : null;
}

/**
 * A Message-ID for mail to a requester: random, so knowing one is proof of having had the email
 * (an answer that cites it is threaded to its request, D30), and stable across retries, being kept
 * in the outbox. The local part, without the host, as the outbox takes it.
 */
export function requestMessageId(kind: string): string {
  return `${kind}.${randomToken('', 12)}`;
}

/** The project of an open help desk, or a 404 that says nothing more. */
export async function deskProject(app: AppServices, key: string): Promise<ProjectRow> {
  const p = openDesk(await app.schema.get(), key);
  if (!p) throw nothingHere();
  return p;
}

/** A requester by their email, made when new; their name as they last gave it. */
export async function requesterFor(db: Db, email: string, name: string): Promise<string> {
  const res = await db.execute(sql`
    INSERT INTO requesters (id, email, name) VALUES (${newId()}, ${email}, ${name})
    ON CONFLICT ((lower(email))) DO UPDATE SET name = EXCLUDED.name, updated_at = now()
    RETURNING id`);
  return String((res as unknown as { rows: { id: string }[] }).rows[0]!.id);
}

/** Mint a tracking token for a request: only its hash is kept. */
export async function mintTrackingToken(db: Db, issueId: string): Promise<string> {
  const token = randomToken(TOKEN_PREFIX, 32);
  await db.insert(helpdeskTokens).values({ tokenHash: sha256(token), issueId });
  return token;
}

export function trackingUrl(app: AppServices, token: string): string {
  // In the fragment, so it never reaches a server's logs or another site's Referer.
  return `${app.config.publicUrl}/request#${token}`;
}

export interface NewRequest {
  name: string;
  email: string;
  summary: string;
  description: string;
  /** The public form, or an email to the desk (D30). */
  via: 'form' | 'email';
  /** The requester's own Message-ID, when they wrote in: the conversation threads under it. */
  threadId?: string | null;
  /** Whom their email copied (its Cc), to copy on the request (D57). */
  cc?: Person[];
  /** Hold its Cc for the requester to confirm rather than copy it (D67): a4a can't trust who sent it. */
  ccHeld?: boolean;
  /** Kept from their customer group's other members from the start (D56). */
  private?: boolean;
}

/**
 * Open a request in a desk's project, as the help desk's agent: the issue, reported for whoever
 * asked; its request row; the lead watching; and the email that says it came in, all in one
 * transaction. The form and email both come here.
 */
export async function openRequest(app: AppServices, project: ProjectRow, input: NewRequest) {
  const settings = projectSettings(project).helpdesk;
  const ctx = await botCtx(app, project.id);
  const email = input.email.trim();
  const name = input.name.trim().replace(/\s+/g, ' ');
  const requesterId = await requesterFor(app.db, email, name);
  const s = await app.schema.get();
  const lead = project.leadId ? s.users.get(project.leadId) : undefined;
  const received = requestMessageId('request-received');
  // What later emails thread under: the requester's message, else the first one a4a sends them.
  const threadId = input.threadId ?? (mailConfigured(app) ? `<${received}@${mailHost(app)}>` : null);
  // Filed under its requester's customer group now, and kept (D56).
  const group = await groupOfRequester(app.db, project.id, { id: requesterId, email });
  let slaActivities: ActivityRow[] = [];
  let copied: { copied: string[]; left: string[] } | null = null;
  let heldCcs: { held: string[]; left: string[] } | null = null;
  const issue = await createIssue(
    ctx,
    { project: project.key, summary: input.summary.trim(), description: input.description.trim() },
    {
      data: { requester: { name }, ...(input.via === 'email' ? { via: 'email' } : {}), ...(group ? { customerGroup: group.name } : {}) },
      inTransaction: async (tx, row) => {
        const due = settings.firstResponseHours ? new Date(row.createdAt.getTime() + settings.firstResponseHours * 3_600_000) : null;
        // Held until this commits, so a group deleted meanwhile can't leave the request pointing at nothing.
        const held = group ? await tx.select({ id: customerGroups.id }).from(customerGroups).where(eq(customerGroups.id, group.id)).for('key share') : [];
        const [request] = await tx
          .insert(helpdeskRequests)
          .values({ issueId: row.id, projectId: project.id, requesterId, firstResponseDueAt: due, via: input.via, threadId, groupId: held.length ? group!.id : null, private: input.private ?? false })
          .returning();
        // Its SLA clocks start with it (D45), counted from when it was filed, in its group's hours where it has some.
        slaActivities = await syncClocks(tx, app, await app.schema.get(tx), row, request!);
        // Whom their email copied, before the email that says it came in is sent (D57); held for
        // them to confirm instead, when nobody can vouch that they sent it (D67).
        if (input.cc?.length && input.ccHeld) heldCcs = await holdOnNewRequest(tx, app, row, input.cc);
        else if (input.cc?.length) {
          const done = await copyOnNewRequest(tx, ctx, row, name, input.cc);
          copied = done.words;
          slaActivities.push(...done.activities);
        }
        // The project's lead watches each request, so the requester's replies reach someone.
        if (lead) await addWatchers(tx, s, row, [{ login: lead.login, reason: 'lead' }]);
        // Its group's dedicated agent takes it (D56), as the help desk's agent, in its history.
        if (group && held.length) slaActivities.push(...(await assignToGroupAgent(tx, ctx, row, group)));
        // `replyable`: its Message-ID is random, so an answer that cites it is the requester's (D30).
        await enqueueMail(tx, app, { kind: 'request-received', dedupeKey: `request:${row.id}:received`, payload: { issueId: row.id, replyable: true }, messageId: received });
      },
    },
  );
  kickMail(app);
  await publishActivities(app, slaActivities);
  return { ...issue, copied, held: heldCcs };
}

/** File a request from the public form, as an issue in the project. */
export async function fileRequest(app: AppServices, key: string, input: { name: string; email: string; summary: string; description: string }): Promise<HelpRequestReceived> {
  const project = await deskProject(app, key);
  const issue = await openRequest(app, project, { ...input, via: 'form' });
  const email = input.email.trim();
  if (mailConfigured(app)) return { received: true, email, tracking: null };
  // No email will carry a link, so the page shows this one, once.
  return { received: true, email, tracking: trackingUrl(app, await mintTrackingToken(app.db, issue.uid)) };
}

// ---------------------------------------------------------------------------
// The tracking page: one request, its public conversation, its state
// ---------------------------------------------------------------------------

async function requestByToken(app: AppServices, token: string | undefined) {
  if (!token || !TOKEN.test(token)) throw noRequest();
  const [row] = await app.db
    .select({ request: helpdeskRequests, requester: requesters, issue: issues })
    .from(helpdeskTokens)
    .innerJoin(helpdeskRequests, eq(helpdeskRequests.issueId, helpdeskTokens.issueId))
    .innerJoin(requesters, eq(requesters.id, helpdeskRequests.requesterId))
    .innerJoin(issues, eq(issues.id, helpdeskRequests.issueId))
    .where(eq(helpdeskTokens.tokenHash, sha256(token)));
  if (!row) throw noRequest();
  return row;
}

export async function trackRequest(app: AppServices, token: string | undefined): Promise<TrackedRequest> {
  const { request, requester, issue } = await requestByToken(app, token);
  const s = await app.schema.get();
  const project = s.projects.get(issue.projectId);
  const rows = await app.db
    .select()
    .from(comments)
    .where(and(eq(comments.issueId, issue.id), eq(comments.visibility, 'public'), isNull(comments.deletedAt)))
    .orderBy(asc(comments.createdAt));
  const state = (await stateNames(app.db, s, [issue.id])).get(issue.id) ?? null;
  // Others outside the team who answered, by the names they go by: someone copied on it (D57), or
  // someone of its customer group (D56).
  const outside = await outsideAuthors(app.db, rows);
  return {
    project: { name: project?.name ?? '' },
    summary: issue.summary,
    description: issue.description,
    createdAt: issue.createdAt.toISOString(),
    state: { name: state, resolved: issue.resolvedAt !== null },
    requester: { name: requester.name, email: requester.email },
    // The team by name, the requester as "you", someone copied on it (D57) or of its group (D56) by name; never anything internal.
    messages: rows.map((c) => {
      const author = c.authorId ? s.users.get(c.authorId) : undefined;
      const mine = c.requesterId === requester.id;
      const other = c.requesterId && !mine ? outside.get(outsideKey(c.issueId, c.requesterId)) : undefined;
      return {
        id: c.id,
        from: mine ? ('you' as const) : c.requesterId ? (other?.as === 'copied' ? ('cc' as const) : ('colleague' as const)) : ('team' as const),
        name: mine ? requester.name : c.requesterId ? (other?.name ?? '') : author ? (author.isBot ? author.login : author.name) : 'The team',
        text: c.text,
        at: c.createdAt.toISOString(),
      };
    }),
    emailMuted: request.emailMutedAt !== null,
  };
}

/**
 * The requester's own reply, from their tracking page or by email: a public comment by the help
 * desk's agent in their name, which tells the issue's watchers. Says which comment it made.
 */
export async function postRequesterReply(
  app: AppServices,
  issue: typeof issues.$inferSelect,
  requester: { id: string; name: string },
  text: string,
  via: 'page' | 'email',
  opts: { colleague?: boolean; relay?: RelayHow; files?: number } = {},
): Promise<{ commentId: string | null; activities: ActivityRow[]; relay: RelayChoice }> {
  const ctx = await botCtx(app, issue.projectId);
  // Whether everyone else on it hears these words (D67): the desk's switch, whether a4a can trust who
  // wrote them, and the limits, decided as they come in, so the desk's log can say why not.
  const relay: RelayChoice = opts.relay ? await relayChoice(app, issue, opts.relay, Boolean(opts.colleague)) : { relay: false, why: null };
  // Someone of its customer group answering it (D56): their own words, which reach its requester too.
  const data = {
    ...(via === 'email' ? { via: 'email' } : {}),
    ...(opts.colleague ? { colleague: true } : {}),
    ...(relay.relay ? { relay: true } : {}),
    ...(opts.files ? { files: opts.files } : {}),
  };
  const reply = (withResume: boolean) =>
    app.db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      // Their answer ends the wait (D45): a desk that says so moves the request out of its waiting state.
      const fields = withResume ? await resumeFields(tx, await app.schema.get(tx), issue) : [];
      return applyChanges(
        tx,
        ctx,
        issue,
        {
          comment: text,
          commentVisibility: 'public',
          commentRequester: requester,
          ...(fields.length ? { fields } : {}),
          ...(Object.keys(data).length ? { data } : {}),
        },
        fields.length ? { machines: false } : {},
      );
    });
  let result: Awaited<ReturnType<typeof reply>>;
  try {
    result = await reply(true);
  } catch (e) {
    // A rule that refuses the move mustn't lose their words: the answer goes in, the state stays.
    if (!(e instanceof AppError) || e.status >= 500) throw e;
    result = await reply(false);
  }
  await publishActivities(app, result.activities);
  const created = result.activities.find((a) => a.type === 'comment.created');
  const commentId = (created?.payload as { data?: { commentId?: unknown } } | undefined)?.data?.commentId;
  // Words written on a page that a desk that relays didn't pass on: its log says why (D67). Mail's own line says it.
  if (opts.relay && opts.relay.on !== 'email' && !relay.relay && relay.why) await noteNotRelayed(app, issue, opts.relay, typeof commentId === 'string' ? commentId : null, relay.why);
  return { commentId: typeof commentId === 'string' ? commentId : null, activities: result.activities, relay };
}

/** The requester replies on their tracking page: a public comment, theirs, that tells the issue's watchers. */
export async function replyToRequest(app: AppServices, token: string | undefined, text: string): Promise<TrackedRequest> {
  const { requester, issue } = await requestByToken(app, token);
  // A tracking link can be forwarded, and lives as long as the request: words written by it aren't passed on to others (D67).
  await postRequesterReply(app, issue, { id: requester.id, name: requester.name }, text, 'page', { relay: { on: 'page', sender: requester.email, trusted: false, why: 'page' } });
  return trackRequest(app, token);
}

// ---------------------------------------------------------------------------
// For the team: who asked, and the first-response target
// ---------------------------------------------------------------------------

/**
 * Where a request stands against its first-response target. The first public reply from the team
 * answers it; so does resolving it without one, since then nothing waits on the team.
 */
export function slaOf(dueAt: Date | null, answeredAt: Date | null, respondedAt: Date | null, now = new Date()): Sla {
  const out = { dueAt: dueAt?.toISOString() ?? null, respondedAt: respondedAt?.toISOString() ?? null };
  if (!dueAt) return { state: 'none', ...out };
  if (answeredAt) return { state: answeredAt <= dueAt ? 'met' : 'missed', ...out };
  return { state: now > dueAt ? 'overdue' : 'due', ...out };
}

export async function firstResponseAt(db: Db, issueId: string): Promise<Date | null> {
  const [row] = await db
    .select({ at: min(comments.createdAt) })
    .from(comments)
    .where(and(eq(comments.issueId, issueId), eq(comments.visibility, 'public'), isNull(comments.requesterId)));
  return row?.at ? new Date(row.at) : null;
}

export async function requestOf(ctx: Ctx, issueId: string): Promise<HelpdeskRequest> {
  requireScope(ctx, 'read');
  const issue = await resolveIssue(ctx, issueId);
  const s = await ctx.app.schema.get();
  const [row] = await ctx.db
    .select({ request: helpdeskRequests, requester: requesters })
    .from(helpdeskRequests)
    .innerJoin(requesters, eq(requesters.id, helpdeskRequests.requesterId))
    .where(eq(helpdeskRequests.issueId, issue.id));
  if (!row) throw notFound(`A help desk request for ${readableId(s, issue)}`, 'Only issues filed through a help desk have one.').said('helpdesk.requestNotFound', { id: readableId(s, issue) });
  const responded = await firstResponseAt(ctx.db, issue.id);
  const sla = await requestSla(ctx.db, s, issue.id, issue.projectId, row.request.waitingSince);
  const first = sla.clocks.find((c) => c.target === 'first_response');
  const [group] = row.request.groupId ? await ctx.db.select().from(customerGroups).where(eq(customerGroups.id, row.request.groupId)) : [];
  return {
    issue: readableId(s, issue),
    requester: { name: row.requester.name, email: row.requester.email, passkeys: await requesterPasskeyCount(ctx.db, row.requester.id) },
    createdAt: row.request.createdAt.toISOString(),
    // D24's first-response target, as its clock now stands (D45); a request from before clocks, as it was.
    firstResponse: first
      ? {
          state: first.state === 'met' ? 'met' : first.state === 'missed' ? 'missed' : first.state === 'breached' ? 'overdue' : 'due',
          dueAt: first.dueAt ?? (first.metAt || first.breachedAt ? (row.request.firstResponseDueAt?.toISOString() ?? null) : null),
          respondedAt: responded?.toISOString() ?? null,
        }
      : slaOf(row.request.firstResponseDueAt, responded ?? issue.resolvedAt, responded),
    sla,
    emailMuted: row.request.emailMutedAt !== null,
    via: row.request.via === 'email' ? 'email' : 'form',
    ccs: await ccsOf(ctx.db, s, issue.id),
    ccsMax: deskCcsMax(s, issue.projectId),
    held: await heldOf(ctx.db, issue.id),
    group: group ? { id: group.id, name: group.name, sharing: group.sharing as CustomerSharing } : null,
    private: row.request.private,
  };
}

/**
 * The team gives a request another customer group, or none, or keeps it from its group (D56):
 * through the write path, with the edit permission and in its history. A request that comes into a
 * group with dedicated agents goes to one of them, as a new one does, unless someone chose its assignee.
 */
export async function updateRequest(ctx: Ctx, issueId: string, input: { group?: string | null; private?: boolean; expectedVersion?: number }): Promise<HelpdeskRequest> {
  requireScope(ctx, 'write');
  const issue = await resolveIssue(ctx, issueId);
  const group = input.group ? await groupByRef(ctx.db, issue.projectId, input.group) : null;
  const bot = group ? await botCtx(ctx.app, issue.projectId) : null;
  const activities = await ctx.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const res = await applyChanges(tx, ctx, issue, {
      ...(input.group !== undefined ? { requestGroup: { groupId: group?.id ?? null } } : {}),
      ...(input.private !== undefined ? { requestPrivate: input.private } : {}),
      expectedVersion: input.expectedVersion,
    });
    const out = [...res.activities];
    if (group && bot && res.changes.some((c) => c.field === GROUP_CHANGE) && !res.issue.resolvedAt) out.push(...(await assignToGroupAgent(tx, bot, res.issue, group)));
    return out;
  });
  await publishActivities(ctx.app, activities);
  return requestOf(ctx, issue.id);
}

/** For the issue's ref in mail: its state now. */
export async function requestIssueRef(db: Db, s: SchemaSnapshot, issueId: string) {
  const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
  if (!issue) return null;
  const states = await stateNames(db, s, [issue.id]);
  return { issue, ref: issueRef(s, issue, states.get(issue.id) ?? null) };
}
