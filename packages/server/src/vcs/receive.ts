/**
 * Deliveries from GitHub, GitLab, Bitbucket (Cloud and Data Center), Gitea and Forgejo, at
 * POST /api/v1/vcs/hooks/{integration}.
 *
 * 1. Who sent it: an HMAC-SHA256 of the raw body with the secret (GitHub's X-Hub-Signature-256,
 *    Bitbucket's X-Hub-Signature, Gitea's and Forgejo's own headers), or GitLab's X-Gitlab-Token,
 *    each compared in constant time. What fails is refused (401) and logged, at most so many
 *    times an hour from one address, so the log can't be flooded.
 * 2. How often: deliveries per integration are rate-limited.
 * 3. Once: the provider's delivery id (X-GitHub-Delivery; GitLab's Idempotency-Key, else
 *    X-Gitlab-Event-UUID; Bitbucket's X-Request-UUID or X-Request-Id; X-Gitea-Delivery) is
 *    claimed before the work, so a delivery sent again is answered as a duplicate and does
 *    nothing. One that failed may be sent again and is handled again; linking is idempotent per
 *    commit and issue, so what it did the first time isn't done twice.
 * 4. What it says: pushes link their commits, and run the commands they give; pull and merge
 *    requests are linked and kept current. Commits a delivery leaves out are read from Bitbucket
 *    with the integration's token (commits.ts). Actions runs, GitHub's, Gitea's and Forgejo's,
 *    become builds of the sources that take them (ci/builds.ts, D46 and D55).
 */
import { VCS_PROVIDER_NAMES, type VcsDeliveryOutcome, type VcsProvider } from '@a4a/shared';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { and, eq, lt, or } from 'drizzle-orm';
import { ZodError } from 'zod';
import type { AppServices } from '../context';
import { vcsDeliveries, vcsIntegrations } from '../db/schema';
import { RateLimiter } from '../http/middleware';
import { newId } from '../lib/ids';
import { excerpt } from '../lib/text';
import { findIssue } from '../services/issues';
import { buildsFromRun } from '../ci/builds';
import { authorOf } from './authors';
import { queueCheck } from './checks';
import { moreCommits } from './commits';
import { linkCommit, syncPullRequest, type IntegrationRow } from './links';
import { integrationKeys, mentions } from './mentions';
import { readDelivery, type Delivery } from './payloads';
import { tokenOf } from './tokens';

export const MAX_BODY = 5 * 1024 * 1024;
/** Commits read from one push; GitHub sends up to 2048. */
export const MAX_COMMITS = 500;
const KEEP_DAYS = 14;
/** A claim this old that never finished came from a delivery that died: it may be taken again. */
const STALE_CLAIM_MS = 10 * 60_000;

const perIntegration = new RateLimiter(300, 60_000);
const refusedFrom = new RateLimiter(30, 600_000);

export interface Incoming {
  header(name: string): string | undefined;
  body: Uint8Array;
  ip: string;
}

export interface Answer {
  status: number;
  /** What the provider is told. */
  body: Record<string, unknown>;
  retryAfter?: number;
  /** What a4a's own log says, for a4a's callers (a test from the Integrations page). */
  said?: string;
}

const refuse = (status: number, code: string, message: string, hint?: string): Answer => ({
  status,
  body: { error: { code, message, ...(hint ? { hint } : {}) } },
});

function sameDigest(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

const providerOf = (integration: IntegrationRow): VcsProvider => integration.provider as VcsProvider;
const first = (req: Incoming, ...names: string[]): string | undefined => names.map((n) => req.header(n)).find((v) => v !== undefined && v !== '');

/** The header each provider signs with, and how it writes the HMAC: "sha256=<hex>", or the hex alone. */
const SIGNED_BY: Record<Exclude<VcsProvider, 'gitlab'>, { headers: string[]; name: string }> = {
  github: { headers: ['x-hub-signature-256'], name: 'X-Hub-Signature-256' },
  bitbucket: { headers: ['x-hub-signature'], name: 'X-Hub-Signature' },
  'bitbucket-dc': { headers: ['x-hub-signature'], name: 'X-Hub-Signature' },
  gitea: { headers: ['x-hub-signature-256', 'x-forgejo-signature', 'x-gitea-signature'], name: 'X-Gitea-Signature' },
};

/** Whether the provider sent it, and if not, why, in words an administrator can act on. */
function verify(integration: IntegrationRow, req: Incoming): string | null {
  const provider = providerOf(integration);
  const at = VCS_PROVIDER_NAMES[provider];
  if (provider === 'gitlab') {
    const token = req.header('x-gitlab-token') ?? '';
    if (!token) return 'No X-Gitlab-Token: give the webhook in GitLab the secret token a4a showed when it was added.';
    if (!integration.tokenHash) return 'This integration has no token.';
    const given = createHash('sha256').update(token).digest();
    return sameDigest(given, Buffer.from(integration.tokenHash, 'hex')) ? null : 'The secret token does not match: is the one in GitLab the one a4a gave?';
  }
  const signed = SIGNED_BY[provider];
  const given = (first(req, ...signed.headers) ?? '').trim();
  if (!given) return `No ${signed.name}: give the webhook in ${at} the secret a4a showed when it was added.`;
  const hex = given.replace(/^sha256=/i, '');
  if (!integration.signingKey || !/^[0-9a-f]{64}$/i.test(hex)) return 'The signature is not an HMAC-SHA256.';
  const expected = createHmac('sha256', integration.signingKey).update(req.body).digest();
  return sameDigest(Buffer.from(hex, 'hex'), expected) ? null : `The signature does not match: is the secret in ${at} the one a4a gave?`;
}

function eventOf(integration: IntegrationRow, req: Incoming): string {
  const raw = {
    github: () => req.header('x-github-event'),
    gitlab: () => req.header('x-gitlab-event'),
    bitbucket: () => req.header('x-event-key'),
    'bitbucket-dc': () => req.header('x-event-key'),
    gitea: () => first(req, 'x-gitea-event', 'x-forgejo-event', 'x-gogs-event', 'x-github-event'),
  }[providerOf(integration)]();
  return excerpt((raw ?? 'unknown').trim(), 60) || 'unknown';
}

function deliveryIdOf(integration: IntegrationRow, req: Incoming): string | null {
  const raw = {
    github: () => req.header('x-github-delivery'),
    gitlab: () => req.header('idempotency-key') ?? req.header('x-gitlab-event-uuid'),
    bitbucket: () => req.header('x-request-uuid'),
    'bitbucket-dc': () => req.header('x-request-id'),
    gitea: () => first(req, 'x-gitea-delivery', 'x-forgejo-delivery', 'x-github-delivery'),
  }[providerOf(integration)]();
  // Bitbucket Cloud writes its UUIDs in braces.
  const id = raw?.trim().replace(/^\{(.*)\}$/, '$1');
  return id && /^[A-Za-z0-9._:-]{1,200}$/.test(id) ? id : null;
}

/**
 * Bitbucket Data Center's Test connection sends a ping without a signature, even when the webhook
 * has a secret. It asks nothing and carries nothing, so it's answered, and nothing is read or
 * logged: the secret is checked on the first real delivery.
 */
function unsignedPing(integration: IntegrationRow, req: Incoming): boolean {
  return providerOf(integration) === 'bitbucket-dc' && eventOf(integration, req) === 'diagnostics:ping' && !req.header('x-hub-signature');
}

/** The JSON a provider sent: as the body, or (GitHub's other content type) a form's "payload". */
function bodyJson(req: Incoming): unknown {
  const text = new TextDecoder().decode(req.body);
  const type = req.header('content-type') ?? '';
  if (type.includes('application/x-www-form-urlencoded')) return JSON.parse(new URLSearchParams(text).get('payload') ?? '');
  return JSON.parse(text);
}

async function log(
  app: AppServices,
  integration: IntegrationRow,
  row: { deliveryId: string | null; event: string; outcome: VcsDeliveryOutcome; statusCode: number; message: string; test?: boolean },
): Promise<void> {
  await app.db.insert(vcsDeliveries).values({ id: newId(), integrationId: integration.id, ...row, message: excerpt(row.message, 2000), finishedAt: new Date() });
}

/** The delivery's own row, claimed: null when it was handled already (or is being handled now). */
async function claim(app: AppServices, integration: IntegrationRow, deliveryId: string | null, event: string, test: boolean): Promise<{ id: string } | { duplicateOf: Date }> {
  const id = newId();
  const [claimed] = await app.db
    .insert(vcsDeliveries)
    .values({ id, integrationId: integration.id, deliveryId, event, outcome: 'received', statusCode: 202, test })
    .onConflictDoNothing()
    .returning({ id: vcsDeliveries.id });
  if (claimed) return claimed;
  const [first] = await app.db
    .select()
    .from(vcsDeliveries)
    .where(and(eq(vcsDeliveries.integrationId, integration.id), eq(vcsDeliveries.deliveryId, deliveryId!)));
  if (!first) return { duplicateOf: new Date() };
  // One that failed, or died while it was handled, may be handled again.
  const retry = first.outcome === 'failed' || (first.outcome === 'received' && Date.now() - first.createdAt.getTime() > STALE_CLAIM_MS);
  if (retry) {
    // The same test, in the update: of two retries at once, the first makes the row fresh and
    // "received", so the second no longer matches.
    const [again] = await app.db
      .update(vcsDeliveries)
      .set({ outcome: 'received', statusCode: 202, message: '', createdAt: new Date(), finishedAt: null })
      .where(
        and(
          eq(vcsDeliveries.id, first.id),
          or(eq(vcsDeliveries.outcome, 'failed'), and(eq(vcsDeliveries.outcome, 'received'), lt(vcsDeliveries.createdAt, new Date(Date.now() - STALE_CLAIM_MS)))),
        ),
      )
      .returning({ id: vcsDeliveries.id });
    if (again) return again;
  }
  return { duplicateOf: first.createdAt };
}

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

interface Done {
  outcome: VcsDeliveryOutcome;
  /** For a4a's log of deliveries, which only administrators read. */
  message: string;
  /**
   * For the provider, when the log's words would say more than it should know: the provider shows
   * its replies to the repository's administrators, who aren't a4a's, so a reply names no issue
   * and no person, and says nothing of who can do what in a4a.
   */
  reply?: string;
  linked: number;
  applied: number;
}

function replyWords(linked: number, applied: number): string {
  return `Read: ${count(linked, 'link')} made, ${count(applied, 'command')} applied. a4a's log of this integration's deliveries says what each was.`;
}

async function handle(app: AppServices, integration: IntegrationRow, delivery: Delivery): Promise<Done> {
  const s = await app.schema.get();
  const keys = integrationKeys(s, integration.projectIds);
  const keySet = new Set(keys.keys());
  const providerId = providerOf(integration);
  const provider = VCS_PROVIDER_NAMES[providerId];
  switch (delivery.kind) {
    case 'ping':
      return { outcome: 'processed', message: `${provider} can reach a4a, and the signature is right.`, linked: 0, applied: 0 };
    case 'other':
      return { outcome: 'ignored', message: delivery.note ?? `a4a reads pushes, pull requests and workflow runs; this was "${delivery.event}".`, linked: 0, applied: 0 };
    case 'workflow_run': {
      // A finished run a build source takes is a build (D46): which issues it marks is the log's.
      const r = await buildsFromRun(app, integration, delivery);
      return { outcome: r.outcome, message: r.message, reply: r.reply, linked: 0, applied: r.marked };
    }
    case 'push': {
      const branches = delivery.refs.filter((r) => !r.deleted && r.branch);
      if (!branches.length) {
        if (delivery.refs.some((r) => r.deleted)) return { outcome: 'ignored', message: 'A branch was deleted: nothing to link.', linked: 0, applied: 0 };
        if (delivery.refs.length) return { outcome: 'ignored', message: 'A tag: nothing to link.', linked: 0, applied: 0 };
        return { outcome: 'processed', message: 'Nothing was pushed: no branch moved.', reply: replyWords(0, 0), linked: 0, applied: 0 };
      }
      const said: string[] = [];
      const problems: string[] = [];
      const where: string[] = [];
      let linked = 0;
      let applied = 0;
      let budget = MAX_COMMITS;
      let offered = 0;
      for (const ref of branches) {
        if (budget <= 0) break;
        offered += ref.more ? 0 : ref.commits.length;
        // What the delivery left out (Bitbucket) is read from the provider, within what one push may read.
        const { commits, problem } = await moreCommits({ ...integration, accessToken: tokenOf(app, integration.accessToken) }, delivery.repository, ref, budget);
        if (problem) problems.push(problem);
        budget -= commits.length;
        where.push(`${count(commits.length, 'commit')} on ${ref.branch}`);
        for (const commit of commits) {
          const found = mentions(commit.message, keySet);
          if (!found.length) continue;
          const author = await authorOf(app.db, s, providerId, commit.author);
          for (const m of found) {
            const issue = await findIssue(app.db, s, m.id);
            if (!issue) {
              said.push(`${m.id}: no such issue`);
              continue;
            }
            const r = await linkCommit(app, s, integration, { repository: delivery.repository, branch: ref.branch }, commit, issue, m.command, author);
            if (r.linked) linked++;
            if (r.applied) applied++;
            said.push(r.said);
          }
        }
      }
      const read = MAX_COMMITS - budget;
      const more = offered > read ? ` Read the first ${MAX_COMMITS} of ${offered} commits.` : '';
      const notes = problems.length ? ` ${problems.join('. ')}.` : '';
      if (!said.length) {
        return { outcome: 'processed', message: `${where.join(', ')}; none mentions an issue.${more}${notes}`, reply: replyWords(0, 0), linked, applied };
      }
      return { outcome: 'processed', message: `${where.join(', ')}. ${said.join('; ')}.${more}${notes}`, reply: replyWords(linked, applied), linked, applied };
    }
    case 'pull_request': {
      const found = mentions([delivery.title, delivery.branch ?? '', delivery.body].join('\n'), keySet, false);
      const issues = [];
      for (const m of found) {
        const issue = await findIssue(app.db, s, m.id);
        if (issue) issues.push(issue);
      }
      // Who opened it, as the provider signed them in; known to a4a by their login there.
      const author = found.length ? await authorOf(app.db, s, providerId, delivery.author) : null;
      const r = await syncPullRequest(app, s, integration, delivery, issues, author?.user?.id ?? null);
      // Its check run or commit status (D66, D70): written by the sender from what it is now.
      const check = (await queueCheck(app, integration, delivery)) ? ' Its check is due.' : '';
      if (!r.said.length) {
        return {
          outcome: 'processed',
          message: `${found.length ? `#${delivery.number} (${delivery.state}): nothing new.` : `#${delivery.number} (${delivery.state}) mentions no issue.`}${check}`,
          reply: replyWords(0, 0),
          linked: 0,
          applied: 0,
        };
      }
      return { outcome: 'processed', message: `#${delivery.number} (${delivery.state}). ${r.said.join('; ')}.${check}`, reply: replyWords(r.linked, 0), linked: r.linked, applied: 0 };
    }
  }
}

/** What a test showed: a4a sends itself a delivery as the provider would (see testIntegration). */
function testWords(integration: IntegrationRow, done: Done): string {
  if (done.outcome !== 'processed') return `A test. ${done.message}`;
  const provider = providerOf(integration);
  if (provider === 'gitlab') {
    return "A test: a4a read a push as GitLab sends one. It keeps only a hash of the secret token, so the token is the one part a test can't check; GitLab's own Test button checks it.";
  }
  const what = provider === 'github' || provider === 'bitbucket-dc' ? 'a ping' : 'a push';
  const signed = `A test: a4a sent itself ${what} as ${VCS_PROVIDER_NAMES[provider]} sends one, signed with the secret, and the signature checked out.`;
  if (provider === 'bitbucket-dc' && !integration.accessToken) return `${signed} It has no access token, so it can't read the commits pushes move: give it one.`;
  if (provider === 'bitbucket' && !integration.accessToken) return `${signed} Without an access token, a4a reads the latest five commits a push gives a branch, as Bitbucket sends them.`;
  return signed;
}

/** Take one delivery for an integration: check it, claim it, handle it, and log how it went. */
export async function receive(app: AppServices, integrationId: string, req: Incoming, opts: { test?: boolean; trusted?: boolean } = {}): Promise<Answer> {
  const [integration] = await app.db.select().from(vcsIntegrations).where(eq(vcsIntegrations.id, integrationId));
  if (!integration) return refuse(404, 'not_found', 'No such integration', 'Check the webhook URL a4a showed for it.');
  const event = eventOf(integration, req);
  const test = Boolean(opts.test);

  if (!opts.trusted && unsignedPing(integration, req)) {
    const wait = refusedFrom.hit(`${integration.id} ${req.ip}`);
    if (wait) return { ...refuse(429, 'rate_limited', 'Too many unsigned pings', `Retry in ${wait}s`), retryAfter: wait };
    return { status: 200, body: { ok: true, outcome: 'ignored', message: 'a4a can be reached. The ping isn’t signed, so the secret is checked on the first push.' } };
  }
  const wrong = opts.trusted ? null : verify(integration, req);
  if (wrong) {
    const wait = refusedFrom.hit(`${integration.id} ${req.ip}`);
    if (wait) return { ...refuse(429, 'rate_limited', 'Too many refused deliveries', `Retry in ${wait}s`), retryAfter: wait };
    await log(app, integration, { deliveryId: null, event, outcome: 'refused', statusCode: 401, message: wrong, test });
    return refuse(401, 'unauthorized', wrong);
  }
  const wait = perIntegration.hit(integration.id);
  if (wait) return { ...refuse(429, 'rate_limited', 'Too many deliveries', `Retry in ${wait}s`), retryAfter: wait };
  if (!integration.active) {
    await log(app, integration, { deliveryId: null, event, outcome: 'ignored', statusCode: 202, message: 'The integration is paused: nothing was read.', test });
    return { status: 202, body: { ok: true, outcome: 'ignored', message: 'The integration is paused.' } };
  }

  const deliveryId = test ? `test-${newId()}` : deliveryIdOf(integration, req);
  const claimed = await claim(app, integration, deliveryId, event, test);
  if ('duplicateOf' in claimed) {
    const message = `Delivery ${deliveryId} was received already, at ${claimed.duplicateOf.toISOString()}: nothing was done again.`;
    await log(app, integration, { deliveryId: null, event, outcome: 'duplicate', statusCode: 200, message, test });
    return { status: 200, body: { ok: true, outcome: 'duplicate', message } };
  }

  let done: Done;
  let status = 200;
  try {
    done = await handle(app, integration, readDelivery(providerOf(integration), event, bodyJson(req)));
  } catch (e) {
    if (e instanceof SyntaxError || e instanceof ZodError) {
      status = 400;
      done = { outcome: 'failed', message: `a4a couldn't read this ${event} delivery: ${e instanceof ZodError ? e.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).slice(0, 3).join('; ') : 'not JSON'}.`, linked: 0, applied: 0 };
    } else {
      console.error(`vcs delivery ${claimed.id} for integration ${integration.id} failed`, e);
      status = 500;
      done = { outcome: 'failed', message: 'Something went wrong while handling it; it can be sent again.', linked: 0, applied: 0 };
    }
  }
  const message = test ? testWords(integration, done) : done.message;
  await app.db
    .update(vcsDeliveries)
    .set({ outcome: done.outcome, statusCode: status, message: excerpt(message, 2000), linked: done.linked, applied: done.applied, finishedAt: new Date() })
    .where(eq(vcsDeliveries.id, claimed.id));
  await app.db.update(vcsIntegrations).set({ lastDeliveryAt: new Date() }).where(eq(vcsIntegrations.id, integration.id));
  await app.db
    .delete(vcsDeliveries)
    .where(and(eq(vcsDeliveries.integrationId, integration.id), lt(vcsDeliveries.createdAt, new Date(Date.now() - KEEP_DAYS * 86_400_000))));
  if (status >= 400) return { ...refuse(status, status === 400 ? 'bad_request' : 'internal', message), said: message };
  return { status, body: { ok: true, outcome: done.outcome, message: done.reply ?? message, linked: done.linked, applied: done.applied }, said: message };
}
