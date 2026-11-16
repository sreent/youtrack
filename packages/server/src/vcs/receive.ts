/**
 * Deliveries from GitHub and GitLab, at POST /api/v1/vcs/hooks/{integration}.
 *
 * 1. Who sent it: GitHub's X-Hub-Signature-256 (an HMAC-SHA256 of the raw body with the secret)
 *    or GitLab's X-Gitlab-Token, each compared in constant time. What fails is refused (401) and
 *    logged, at most so many times an hour from one address, so the log can't be flooded.
 * 2. How often: deliveries per integration are rate-limited.
 * 3. Once: the provider's delivery id (X-GitHub-Delivery; GitLab's Idempotency-Key, else
 *    X-Gitlab-Event-UUID) is claimed before the work, so a delivery sent again is answered as a
 *    duplicate and does nothing. One that failed may be sent again and is handled again; linking
 *    is idempotent per commit and issue, so what it did the first time isn't done twice.
 * 4. What it says: pushes link their commits, and run the commands they give; pull and merge
 *    requests are linked and kept current.
 */
import type { VcsDeliveryOutcome } from '@a4a/shared';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { and, eq, lt, or } from 'drizzle-orm';
import { ZodError } from 'zod';
import type { AppServices } from '../context';
import { vcsDeliveries, vcsIntegrations } from '../db/schema';
import { RateLimiter } from '../http/middleware';
import { newId } from '../lib/ids';
import { excerpt } from '../lib/text';
import { findIssue } from '../services/issues';
import type { SchemaSnapshot } from '../services/schema-cache';
import { authorByEmail, linkCommit, syncPullRequest, type IntegrationRow } from './links';
import { mentions } from './mentions';
import { readDelivery, type Delivery } from './payloads';

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
  body: Record<string, unknown>;
  retryAfter?: number;
}

const refuse = (status: number, code: string, message: string, hint?: string): Answer => ({
  status,
  body: { error: { code, message, ...(hint ? { hint } : {}) } },
});

function sameDigest(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Whether the provider sent it, and if not, why, in words an administrator can act on. */
function verify(integration: IntegrationRow, req: Incoming): string | null {
  if (integration.provider === 'github') {
    const given = req.header('x-hub-signature-256') ?? '';
    if (!given) return 'No X-Hub-Signature-256: give the webhook in GitHub the secret a4a showed when it was added.';
    if (!integration.signingKey || !/^sha256=[0-9a-f]{64}$/i.test(given)) return 'The signature is not an HMAC-SHA256.';
    const expected = createHmac('sha256', integration.signingKey).update(req.body).digest();
    return sameDigest(Buffer.from(given.slice(7), 'hex'), expected) ? null : 'The signature does not match: is the secret in GitHub the one a4a gave?';
  }
  const token = req.header('x-gitlab-token') ?? '';
  if (!token) return 'No X-Gitlab-Token: give the webhook in GitLab the secret token a4a showed when it was added.';
  if (!integration.tokenHash) return 'This integration has no token.';
  const given = createHash('sha256').update(token).digest();
  return sameDigest(given, Buffer.from(integration.tokenHash, 'hex')) ? null : 'The secret token does not match: is the one in GitLab the one a4a gave?';
}

function eventOf(integration: IntegrationRow, req: Incoming): string {
  const raw = integration.provider === 'github' ? req.header('x-github-event') : req.header('x-gitlab-event');
  return excerpt((raw ?? 'unknown').trim(), 60) || 'unknown';
}

function deliveryIdOf(integration: IntegrationRow, req: Incoming): string | null {
  const raw = integration.provider === 'github' ? req.header('x-github-delivery') : (req.header('idempotency-key') ?? req.header('x-gitlab-event-uuid'));
  const id = raw?.trim();
  return id && /^[A-Za-z0-9._:-]{1,200}$/.test(id) ? id : null;
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
  message: string;
  linked: number;
  applied: number;
}

/** The projects whose issue ids this integration looks for, by key. */
function keysFor(s: SchemaSnapshot, integration: IntegrationRow): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of s.projects.values()) if (!integration.projectIds.length || integration.projectIds.includes(p.id)) out.set(p.key.toUpperCase(), p.id);
  return out;
}

async function handle(app: AppServices, integration: IntegrationRow, delivery: Delivery): Promise<Done> {
  const s = await app.schema.get();
  const keys = keysFor(s, integration);
  const keySet = new Set(keys.keys());
  const provider = integration.provider === 'github' ? 'GitHub' : 'GitLab';
  switch (delivery.kind) {
    case 'ping':
      return { outcome: 'processed', message: `${provider} can reach a4a, and the signature is right.`, linked: 0, applied: 0 };
    case 'other':
      return { outcome: 'ignored', message: `a4a reads pushes and pull requests; this was "${delivery.event}".`, linked: 0, applied: 0 };
    case 'push': {
      if (delivery.deleted) return { outcome: 'ignored', message: 'A branch was deleted: nothing to link.', linked: 0, applied: 0 };
      if (!delivery.branch) return { outcome: 'ignored', message: 'A tag: nothing to link.', linked: 0, applied: 0 };
      const said: string[] = [];
      let linked = 0;
      let applied = 0;
      const commits = delivery.commits.slice(0, MAX_COMMITS);
      for (const commit of commits) {
        const found = mentions(commit.message, keySet);
        if (!found.length) continue;
        const author = authorByEmail(s, commit.author.email);
        for (const m of found) {
          const issue = await findIssue(app.db, s, m.id);
          if (!issue) {
            said.push(`${m.id}: no such issue`);
            continue;
          }
          const r = await linkCommit(app, s, integration, delivery, commit, issue, m.command, author);
          if (r.linked) linked++;
          if (r.applied) applied++;
          said.push(r.said);
        }
      }
      const more = delivery.commits.length > commits.length ? ` Read the first ${MAX_COMMITS} of ${delivery.commits.length} commits.` : '';
      if (!said.length) {
        return { outcome: 'processed', message: `${count(commits.length, 'commit')} on ${delivery.branch}; none mentions an issue.${more}`, linked, applied };
      }
      return { outcome: 'processed', message: `${count(commits.length, 'commit')} on ${delivery.branch}. ${said.join('; ')}.${more}`, linked, applied };
    }
    case 'pull_request': {
      const found = mentions([delivery.title, delivery.branch ?? '', delivery.body].join('\n'), keySet, false);
      const issues = [];
      for (const m of found) {
        const issue = await findIssue(app.db, s, m.id);
        if (issue) issues.push(issue);
      }
      const r = await syncPullRequest(app, s, integration, delivery, issues);
      if (!r.said.length) {
        return {
          outcome: 'processed',
          message: found.length ? `#${delivery.number} (${delivery.state}): nothing new.` : `#${delivery.number} (${delivery.state}) mentions no issue.`,
          linked: 0,
          applied: 0,
        };
      }
      return { outcome: 'processed', message: `#${delivery.number} (${delivery.state}). ${r.said.join('; ')}.`, linked: r.linked, applied: 0 };
    }
  }
}

/** What a test showed: a4a sends itself a delivery as the provider would (see testIntegration). */
function testWords(integration: IntegrationRow, done: Done): string {
  if (done.outcome !== 'processed') return `A test. ${done.message}`;
  return integration.provider === 'github'
    ? 'A test: a4a sent itself a ping as GitHub sends one, signed with the secret, and the signature checked out.'
    : "A test: a4a read a push as GitLab sends one. It keeps only a hash of the secret token, so the token is the one part a test can't check; GitLab's own Test button checks it.";
}

/** Take one delivery for an integration: check it, claim it, handle it, and log how it went. */
export async function receive(app: AppServices, integrationId: string, req: Incoming, opts: { test?: boolean; trusted?: boolean } = {}): Promise<Answer> {
  const [integration] = await app.db.select().from(vcsIntegrations).where(eq(vcsIntegrations.id, integrationId));
  if (!integration) return refuse(404, 'not_found', 'No such integration', 'Check the webhook URL a4a showed for it.');
  const event = eventOf(integration, req);
  const test = Boolean(opts.test);

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
    done = await handle(app, integration, readDelivery(integration.provider as 'github' | 'gitlab', event, bodyJson(req)));
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
  if (status >= 400) return refuse(status, status === 400 ? 'bad_request' : 'internal', message);
  return { status, body: { ok: true, outcome: done.outcome, message, linked: done.linked, applied: done.applied } };
}
