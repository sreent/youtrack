/**
 * Check runs on pull requests, written as a GitHub integration's app (docs/architecture.md, D66).
 *
 * A GitHub integration that reads as its app can report to each pull request as a check run named
 * "a4a", off by default. It names the issues the pull request names, in its title, its branch, its
 * description and its commits, as D26 reads them, each with a link.
 *
 * - **Whoever sees the repository reads it**, which may be the whole world, so it says what anyone may
 *   know: ids and links alone by default; each issue's state when the integration says so; a summary
 *   only for an issue a guest reads (a project open to guests, D37, D64), whose words are public
 *   already. An issue limited to some people, or one whose project the integration isn't given (it
 *   moved out of them), is never named: it reads as an id that names nothing, as one that doesn't
 *   exist does, so the check can't tell the two apart.
 * - **Its conclusion is neutral.** The integration's rule can make it a failure while an issue it names
 *   isn't resolved, or an id names nothing a4a shows.
 * - **Kept current.** A pull request's delivery keeps its row and makes it due; the outbox's consumer
 *   makes due the rows that name an issue that changed (at least once, so marking is idempotent); the
 *   sender, on every instance, claims what's due, words it as it stands then, and writes it only when
 *   the words changed, so an event handed over twice writes nothing twice. Writes through one
 *   installation are counted in Postgres, VCS_CHECKS_PER_MINUTE across every instance, and GitHub's
 *   own limits are waited out.
 */
import type { TrackerEvent } from '@a4a/shared';
import { createHash } from 'node:crypto';
import { and, arrayContains, asc, desc, eq, inArray, isNotNull, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { AppServices } from '../context';
import type { Db } from '../db/client';
import { activities, vcsChecks, vcsInstallations, vcsIntegrations } from '../db/schema';
import type { OutboxConsumer } from '../events/worker';
import { translatorFor } from '../i18n';
import { AppError, pageWords } from '../lib/errors';
import { newId } from '../lib/ids';
import { excerpt } from '../lib/text';
import { privateFieldIds, projectAccess, seesIssueRow } from '../services/access';
import { outsiderCtx } from '../services/guests';
import { readableId, stateNames, type IssueRow } from '../services/issue-refs';
import { findIssue } from '../services/issues';
import { stateField } from '../services/schema-cache';
import { getJson, ReadError } from './commits';
import { forgetInstallationToken, GITHUB_API, repoPath } from './github-app';
import type { IntegrationRow } from './links';
import { integrationKeys, mentions } from './mentions';
import { appCredentials, asApp } from './tokens';

type Row = typeof vcsChecks.$inferSelect;

export const CHECK_NAME = 'a4a';
const POLL_MS = 5_000;
const BATCH = 10;
const LEASE_MS = 2 * 60_000;
const TIMEOUT_MS = 10_000;
/** The issues a check lists; past them it says how many more. */
const LISTED = 50;
/** What the commits of one pull request can add, read from GitHub's compare. */
const COMMITS_READ = 250;
/** Waits after each failed write; after the last, the row waits for its pull request or an issue to change. */
export const CHECK_BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000];

/** GitHub said to wait: its rate limit, or a4a's own per installation. */
class Wait extends Error {
  constructor(readonly ms: number) {
    super('wait');
  }
}

/** Wake this instance's sender. */
const kicks = new WeakMap<AppServices, () => void>();
export const kickChecks = (app: AppServices) => kicks.get(app)?.();

/** Whether an integration reports checks: GitHub's, as its app, switched on. */
export const reportsChecks = (i: Pick<IntegrationRow, 'provider' | 'checks' | 'githubAppId' | 'githubInstallationId'>) =>
  i.provider === 'github' && i.checks && Boolean(i.githubAppId && i.githubInstallationId);

export interface PullForCheck {
  repository: string;
  number: number;
  title: string;
  body: string;
  branch: string | null;
  state: 'open' | 'merged' | 'closed';
  headSha?: string | null;
  baseSha?: string | null;
}

/**
 * A pull request's delivery, for an integration that reports checks: its row kept as the pull request
 * is now, and due while it's open. Returns whether its check is due.
 */
export async function queueCheck(app: AppServices, integration: IntegrationRow, pr: PullForCheck): Promise<boolean> {
  if (!reportsChecks(integration) || !pr.headSha) return false;
  const open = pr.state === 'open';
  const facts = {
    title: excerpt(pr.title, 500),
    body: excerpt(pr.body, 4000),
    branch: pr.branch,
    state: pr.state,
    headSha: pr.headSha,
    baseSha: pr.baseSha ?? null,
    updatedAt: new Date(),
  };
  await app.db
    .insert(vcsChecks)
    .values({ id: newId(), integrationId: integration.id, repository: pr.repository, number: pr.number, ...facts, marks: 1, dueAt: open ? new Date() : null })
    .onConflictDoUpdate({
      target: [vcsChecks.integrationId, vcsChecks.repository, vcsChecks.number],
      set: { ...facts, marks: sql`${vcsChecks.marks} + 1`, ...(open ? { dueAt: sql`coalesce(${vcsChecks.dueAt}, now())`, attempts: 0 } : { dueAt: null }) },
    });
  if (open) kickChecks(app);
  return open;
}

/** Make these rows due (idempotent: marking twice is marking once), and wake the sender. */
async function markDue(app: AppServices, where: ReturnType<typeof and>): Promise<number> {
  const rows = await app.db
    .update(vcsChecks)
    .set({ marks: sql`${vcsChecks.marks} + 1`, dueAt: sql`coalesce(${vcsChecks.dueAt}, now())`, attempts: 0, updatedAt: new Date() })
    .where(and(eq(vcsChecks.state, 'open'), where))
    .returning({ id: vcsChecks.id });
  if (rows.length) kickChecks(app);
  return rows.length;
}

/** Every open check of an integration, due: its settings changed, so its words may have. */
export async function markIntegrationChecks(app: AppServices, integrationId: string): Promise<number> {
  return markDue(app, eq(vcsChecks.integrationId, integrationId));
}

const ISSUE_EVENTS = ['issue.created', 'issue.updated', 'issue.deleted', 'issue.moved'] as const;
const PROJECT_EVENTS = ['project.visibility.changed', 'project.key.changed'] as const;

/** The checks an event reaches: those naming its issue (by its id, or as typed), or every one over its project. */
export async function markForEvent(app: AppServices, event: TrackerEvent): Promise<number> {
  if ((event.data as { imported?: unknown }).imported) return 0;
  const reporting = await app.db.select({ id: vcsIntegrations.id, projectIds: vcsIntegrations.projectIds }).from(vcsIntegrations).where(eq(vcsIntegrations.checks, true));
  if (!reporting.length) return 0;
  const [row] = await app.db.select({ issueId: activities.issueId, projectId: activities.projectId, payload: activities.payload }).from(activities).where(eq(activities.id, event.id));
  if ((PROJECT_EVENTS as readonly string[]).includes(event.type)) {
    const over = reporting.filter((i) => !i.projectIds.length || (row?.projectId && i.projectIds.includes(row.projectId))).map((i) => i.id);
    return over.length ? markDue(app, inArray(vcsChecks.integrationId, over)) : 0;
  }
  // A deleted issue's event keeps every id it had (D37), never shown to a reader: a check typed with any of them is reached.
  const gone = (row?.payload as { gone?: { ids?: unknown } } | undefined)?.gone?.ids;
  const typed = [event.issue?.id, typeof event.data.from === 'string' ? event.data.from : null, ...(Array.isArray(gone) ? gone : [])]
    .filter((x): x is string => typeof x === 'string' && x.length > 0)
    .map((x) => x.toUpperCase());
  const matches = [...(row?.issueId ? [arrayContains(vcsChecks.issueIds, [row.issueId])] : []), ...typed.map((id) => arrayContains(vcsChecks.mentioned, [id]))];
  if (!matches.length) return 0;
  return markDue(app, and(inArray(vcsChecks.integrationId, reporting.map((i) => i.id)), or(...matches)));
}

/** The outbox's consumer (D5): what an issue's change makes due. At least once, and marking is idempotent. */
export function checksConsumer(app: AppServices): OutboxConsumer {
  return { name: 'vcs-checks', types: [...ISSUE_EVENTS, ...PROJECT_EVENTS], handle: async (event) => void (await markForEvent(app, event)) };
}

// ---------------------------------------------------------------------------
// The words: what anyone who sees the repository may read
// ---------------------------------------------------------------------------

/** Markdown's own characters in someone's words, so a summary or a state can't make a link or a heading. */
const md = (text: string, max = 200) => excerpt(text.replace(/\s+/g, ' ').trim(), max).replace(/[\\`*_{}[\]()<>#|~!]/g, (c) => `\\${c}`);

export interface Worded {
  title: string;
  summary: string;
  conclusion: 'neutral' | 'failure';
  /** The issues named, by id, and the ids it names as typed: a change to either makes it due. */
  issueIds: string[];
  mentioned: string[];
  hash: string;
}

/**
 * The check as it stands now, in the server's language (D49: whoever reads it reads it together, as a
 * channel's people do). Through the access seam, as a guest reads: an issue a guest may not see isn't
 * summarised, and one limited to some people isn't named at all.
 */
export async function wordCheck(app: AppServices, integration: IntegrationRow, check: Pick<Row, 'title' | 'body' | 'branch' | 'commitIds'>): Promise<Worded> {
  const s = await app.schema.get();
  const tr = translatorFor(app.config.defaultLocale);
  const keys = new Set(integrationKeys(s, integration.projectIds).keys());
  const said = mentions([check.title, check.branch ?? '', check.body].join('\n'), keys, false).map((m) => m.id.toUpperCase());
  const mentioned = [...new Set([...said, ...check.commitIds.map((id) => id.toUpperCase())])];
  const outsider = outsiderCtx(app);
  const view = await projectAccess(outsider);
  const named: IssueRow[] = [];
  let unseen = 0;
  for (const id of mentioned) {
    const issue = await findIssue(app.db, s, id);
    // Moved into a project the integration isn't given, limited to some people, or not there: all read alike.
    const given = issue && (!integration.projectIds.length || integration.projectIds.includes(issue.projectId));
    if (!issue || !given || !(await seesIssueRow(view, app.db, s, issue))) {
      unseen++;
      continue;
    }
    if (!named.some((n) => n.id === issue.id)) named.push(issue);
  }
  const states = integration.checksStates || integration.checksResolved ? await stateNames(app.db, s, named.map((i) => i.id)) : new Map<string, string>();
  const sf = stateField(s);
  const base = app.config.publicUrl.replace(/\/+$/, '');
  let unresolved = 0;
  const lines: string[] = [];
  for (const issue of named) {
    const id = readableId(s, issue);
    // A guest reads it: its words are public already, and its link opens without signing in.
    const public_ = view.canRead(issue.projectId);
    const link = `[${id}](${base}${public_ ? '/public' : ''}/issues/${encodeURIComponent(id)})`;
    const summary = public_ ? md(issue.summary) : null;
    // A project that keeps its State private says no state, and its issues aren't held to the rule (D50).
    const statePrivate = sf ? privateFieldIds(s, issue.projectId).has(sf.id) : true;
    const state = integration.checksStates && !statePrivate ? states.get(issue.id) : undefined;
    const notResolved = integration.checksResolved && !statePrivate && issue.resolvedAt === null;
    if (notResolved) unresolved++;
    if (lines.length >= LISTED) continue;
    const line = state
      ? summary
        ? tr.t('server.checks.line.summaryState', { link, summary, state: md(state, 80) })
        : tr.t('server.checks.line.state', { link, state: md(state, 80) })
      : notResolved
        ? summary
          ? tr.t('server.checks.line.summaryNotResolved', { link, summary })
          : tr.t('server.checks.line.notResolved', { link })
        : summary
          ? tr.t('server.checks.line.summary', { link, summary })
          : link;
    lines.push(`- ${line}`);
  }
  const failure = integration.checksResolved && (unresolved > 0 || unseen > 0);
  const title = failure
    ? unresolved
      ? tr.t('server.checks.title.unresolved', { n: unresolved })
      : tr.t('server.checks.title.unseen', { n: unseen })
    : named.length
      ? tr.t('server.checks.title.named', { n: named.length })
      : tr.t('server.checks.title.none');
  const parts = [named.length ? tr.t('server.checks.summary.intro') : unseen ? null : tr.t('server.checks.summary.none')].filter((p): p is string => Boolean(p));
  if (lines.length) parts.push(lines.join('\n'));
  if (named.length > LISTED) parts.push(tr.t('server.checks.summary.more', { n: named.length - LISTED }));
  if (unseen) parts.push(tr.t(named.length ? 'server.checks.summary.unseenMore' : 'server.checks.summary.unseen', { n: unseen }));
  if (integration.checksResolved) parts.push(tr.t('server.checks.summary.rule'));
  const summary = parts.join('\n\n');
  const conclusion = failure ? 'failure' : 'neutral';
  return {
    title: excerpt(title, 255),
    // Markdown, its lines kept: GitHub takes 65,535 characters.
    summary: summary.length > 60_000 ? `${summary.slice(0, 59_999)}…` : summary,
    conclusion,
    issueIds: named.map((i) => i.id),
    mentioned,
    hash: createHash('sha256').update(JSON.stringify([title, summary, conclusion])).digest('hex'),
  };
}

// ---------------------------------------------------------------------------
// Writing to GitHub
// ---------------------------------------------------------------------------

/** One request to GitHub's check runs API, with an installation's token: a 401 says to take a new one. */
async function checksApi(method: 'GET' | 'POST' | 'PATCH', url: string, token: string, body?: unknown): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
        'user-agent': 'a4a',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new ReadError(e instanceof Error && e.name === 'TimeoutError' ? `GitHub didn’t answer in ${TIMEOUT_MS / 1000}s` : 'GitHub couldn’t be reached');
  }
  const json = (await res.json().catch(() => null)) as { message?: unknown } | null;
  // GitHub's rate limits: its primary (remaining 0, until reset), and its secondary (Retry-After).
  const retry = Number(res.headers.get('retry-after'));
  const reset = Number(res.headers.get('x-ratelimit-reset'));
  if (res.status === 429 || (res.status === 403 && (res.headers.get('x-ratelimit-remaining') === '0' || Number.isFinite(retry) && retry > 0))) {
    throw new Wait(Number.isFinite(retry) && retry > 0 ? retry * 1000 : Number.isFinite(reset) && reset > 0 ? Math.max(1_000, reset * 1000 - Date.now()) : 60_000);
  }
  if (res.status === 401) throw new ReadError('GitHub refused the installation’s token (401)', 401);
  if (res.status === 403) throw new ReadError(`GitHub refused to let the app write checks (403: ${excerpt(String(json?.message ?? ''), 120)}): has it Checks: Read and write, accepted on this installation?`, 403);
  if (res.status === 404) throw new ReadError('GitHub has no such repository, commit or check run for the app (404)', 404);
  if (!res.ok) throw new ReadError(`GitHub answered ${res.status}${json?.message ? `: ${excerpt(String(json.message), 120)}` : ''}`, res.status);
  return json;
}

const RunAnswer = z.object({ id: z.number().int() });
const RunsAnswer = z.object({ check_runs: z.array(z.object({ id: z.number().int(), external_id: z.string().nullish() })).default([]) });
const Compared = z.object({ commits: z.array(z.object({ commit: z.object({ message: z.string().nullish() }) })).default([]) });

/** One more check run written through an installation, if its minute has room: else how long to wait. Counted in Postgres, so instances count as one. */
async function takeTurn(db: Db, integrationId: string, installationId: string, perMinute: number): Promise<number> {
  await db.insert(vcsInstallations).values({ integrationId, installationId }).onConflictDoNothing();
  const fresh = sql`(${vcsInstallations.checksWindowAt} is null or ${vcsInstallations.checksWindowAt} <= now() - interval '1 minute')`;
  const [hit] = await db
    .update(vcsInstallations)
    .set({ checksWindowAt: sql`case when ${fresh} then now() else ${vcsInstallations.checksWindowAt} end`, checksInWindow: sql`case when ${fresh} then 1 else ${vcsInstallations.checksInWindow} + 1 end` })
    .where(
      and(
        eq(vcsInstallations.integrationId, integrationId),
        eq(vcsInstallations.installationId, installationId),
        or(isNull(vcsInstallations.checksPausedUntil), lte(vcsInstallations.checksPausedUntil, sql`now()`)),
        or(fresh, lt(vcsInstallations.checksInWindow, perMinute)),
      ),
    )
    .returning({ installationId: vcsInstallations.installationId });
  if (hit) return 0;
  const [r] = await db
    .select({
      ms: sql<number>`ceil(extract(epoch from (greatest(coalesce(${vcsInstallations.checksPausedUntil}, now()), coalesce(${vcsInstallations.checksWindowAt} + interval '1 minute', now())) - now())) * 1000)`,
    })
    .from(vcsInstallations)
    .where(and(eq(vcsInstallations.integrationId, integrationId), eq(vcsInstallations.installationId, installationId)));
  return Math.max(1_000, Number(r?.ms ?? 60_000));
}

/** GitHub said to wait: nothing more goes through that installation until then. */
async function pause(db: Db, integrationId: string, installationId: string, ms: number): Promise<void> {
  await db
    .update(vcsInstallations)
    .set({ checksPausedUntil: new Date(Date.now() + ms) })
    .where(and(eq(vcsInstallations.integrationId, integrationId), eq(vcsInstallations.installationId, installationId)));
}

type Outcome = { done: 'written' | 'same' | 'skipped' } | { wait: number } | { problem: string };

/** Write one claimed row's check as it stands now; what happened. */
export async function writeCheck(app: AppServices, row: Row): Promise<Outcome> {
  const [integration] = await app.db.select().from(vcsIntegrations).where(eq(vcsIntegrations.id, row.integrationId));
  if (!integration || !integration.active || !reportsChecks(integration) || row.state !== 'open') return { done: 'skipped' };
  const c = appCredentials(app, integration);
  if (!c) return { problem: 'The GitHub App’s key can’t be opened: was SECRET_KEY changed? Give the integration its app again.' };
  const api = (integration.baseUrl ?? GITHUB_API).replace(/\/+$/, '');
  const repo = `${api}/repos/${repoPath(row.repository)}`;
  const notes: string[] = [];
  let commitIds = row.commitIds;
  try {
    // The ids its commits name, read once per head, as the app, from its base to its head.
    if (row.commitsOf !== row.headSha && row.baseSha) {
      const got = Compared.parse(
        await asApp(app, integration, c, row.repository, 'read', (token) => getJson(`${repo}/compare/${encodeURIComponent(row.baseSha!)}...${encodeURIComponent(row.headSha)}`, token)),
      );
      const s = await app.schema.get();
      const keys = new Set(integrationKeys(s, integration.projectIds).keys());
      commitIds = [...new Set(got.commits.slice(0, COMMITS_READ).flatMap((m) => mentions(m.commit.message ?? '', keys, false).map((x) => x.id.toUpperCase())))];
      await app.db.update(vcsChecks).set({ commitIds, commitsOf: row.headSha }).where(eq(vcsChecks.id, row.id));
    }
  } catch (e) {
    if (e instanceof Wait) throw e;
    if (!(e instanceof ReadError) && !(e instanceof AppError) && !(e instanceof z.ZodError)) throw e;
    // Its title and description are worded all the same; the log says why its commits weren't read.
    notes.push(`Its commits weren’t read: ${e instanceof AppError ? pageWords(e.message, e.hint) : e instanceof ReadError ? e.message : 'GitHub’s compare didn’t answer as it does'}`);
  }
  const words = await wordCheck(app, integration, { ...row, commitIds });
  await app.db.update(vcsChecks).set({ issueIds: words.issueIds, mentioned: words.mentioned }).where(eq(vcsChecks.id, row.id));
  if (row.written === words.hash && row.checkSha === row.headSha && row.checkRunId) return { done: 'same' };
  const body = {
    name: CHECK_NAME,
    status: 'completed',
    conclusion: words.conclusion,
    completed_at: new Date().toISOString(),
    output: { title: words.title, summary: words.summary },
  };
  try {
    const runId = await asApp(app, integration, c, row.repository, 'checks', async (token, installationId) => {
      const wait = await takeTurn(app.db, integration.id, installationId, app.config.vcsChecksPerMinute);
      if (wait) throw new Wait(wait);
      try {
        let id = row.checkSha === row.headSha ? row.checkRunId : null;
        // A write that died after GitHub made the run, before a4a kept its id: found by a4a's own id for it.
        if (!id && row.checkSha === row.headSha) {
          const runs = RunsAnswer.parse(await checksApi('GET', `${repo}/commits/${encodeURIComponent(row.headSha)}/check-runs?check_name=${CHECK_NAME}&filter=all`, token));
          id = runs.check_runs.find((r) => r.external_id === row.id)?.id.toString() ?? null;
        }
        if (id) {
          try {
            await checksApi('PATCH', `${repo}/check-runs/${encodeURIComponent(id)}`, token, body);
            return id;
          } catch (e) {
            // Gone from GitHub: written anew.
            if (!(e instanceof ReadError) || e.status !== 404) throw e;
          }
        }
        await app.db.update(vcsChecks).set({ checkSha: row.headSha, checkRunId: null }).where(eq(vcsChecks.id, row.id));
        const made = RunAnswer.parse(await checksApi('POST', `${repo}/check-runs`, token, { ...body, head_sha: row.headSha, external_id: row.id }));
        return String(made.id);
      } catch (e) {
        if (e instanceof Wait) await pause(app.db, integration.id, installationId, e.ms);
        // Its permissions changed since the token was taken: the next try takes a new one, which says so.
        if (e instanceof ReadError && e.status === 403) forgetInstallationToken(integration.id, installationId, 'checks');
        throw e;
      }
    });
    await app.db
      .update(vcsChecks)
      .set({ checkRunId: runId, checkSha: row.headSha, written: words.hash, conclusion: words.conclusion, writtenAt: new Date(), problem: notes.length ? notes.join(' ') : null, problemAt: notes.length ? new Date() : null })
      .where(eq(vcsChecks.id, row.id));
    return { done: 'written' };
  } catch (e) {
    if (e instanceof Wait) return { wait: e.ms };
    if (e instanceof AppError) return { problem: `${row.repository}#${row.number}: as the GitHub App: ${pageWords(e.message, e.hint)}` };
    if (e instanceof ReadError || e instanceof z.ZodError) return { problem: `${row.repository}#${row.number}: ${e instanceof ReadError ? e.message : 'GitHub didn’t answer as it does'}.` };
    throw e;
  }
}

async function claim(db: Db): Promise<Row[]> {
  const due = db
    .select({ id: vcsChecks.id })
    .from(vcsChecks)
    .where(and(isNotNull(vcsChecks.dueAt), lte(vcsChecks.dueAt, sql`now()`), or(isNull(vcsChecks.lockedUntil), lt(vcsChecks.lockedUntil, sql`now()`))))
    .orderBy(asc(vcsChecks.dueAt))
    .limit(BATCH)
    .for('update', { skipLocked: true });
  return db
    .update(vcsChecks)
    .set({ lockedUntil: new Date(Date.now() + LEASE_MS) })
    .where(inArray(vcsChecks.id, due))
    .returning();
}

/** Write a claimed row, and settle it: done unless something newer made it due meanwhile, or wait, or try again later. */
export async function sendCheck(app: AppServices, row: Row): Promise<Outcome> {
  let outcome: Outcome;
  try {
    outcome = await writeCheck(app, row);
  } catch (e) {
    console.error(`check run ${row.id} failed`, e);
    outcome = { problem: `${row.repository}#${row.number}: something went wrong while writing it; a4a tries again.` };
  }
  // Due again if it was marked while it was written: what made it due may not be in what went.
  const again = sql`case when ${vcsChecks.marks} = ${row.marks} then null else now() end`;
  if ('done' in outcome) {
    await app.db.update(vcsChecks).set({ dueAt: again, lockedUntil: null, attempts: 0, ...(outcome.done === 'same' ? { problem: null, problemAt: null } : {}) }).where(eq(vcsChecks.id, row.id));
  } else if ('wait' in outcome) {
    await app.db.update(vcsChecks).set({ dueAt: new Date(Date.now() + outcome.wait), lockedUntil: null }).where(eq(vcsChecks.id, row.id));
  } else {
    const wait = CHECK_BACKOFF_MS[row.attempts];
    await app.db
      .update(vcsChecks)
      .set({ dueAt: wait === undefined ? again : new Date(Date.now() + wait), lockedUntil: null, attempts: row.attempts + 1, problem: excerpt(outcome.problem, 1000), problemAt: new Date() })
      .where(eq(vcsChecks.id, row.id));
  }
  return outcome;
}

/** How long a closed pull request's row is kept: its run on GitHub stays as last written. */
const KEEP_CLOSED_DAYS = 30;

/** Forget the rows of pull requests closed a while ago (the lease holder's chore). */
export async function pruneChecks(app: AppServices): Promise<void> {
  await app.db.delete(vcsChecks).where(and(sql`${vcsChecks.state} <> 'open'`, lt(vcsChecks.updatedAt, new Date(Date.now() - KEEP_CLOSED_DAYS * 86_400_000))));
}

/** The latest problem of each integration's checks, for the integrations page. */
export async function checkProblems(db: Db, integrationIds: string[]): Promise<Map<string, { problem: string; at: Date }>> {
  const out = new Map<string, { problem: string; at: Date }>();
  if (!integrationIds.length) return out;
  const rows = await db
    .select({ integrationId: vcsChecks.integrationId, problem: vcsChecks.problem, at: vcsChecks.problemAt })
    .from(vcsChecks)
    .where(and(inArray(vcsChecks.integrationId, integrationIds), isNotNull(vcsChecks.problem), isNotNull(vcsChecks.problemAt)))
    .orderBy(desc(vcsChecks.problemAt))
    .limit(200);
  for (const r of rows) if (!out.has(r.integrationId)) out.set(r.integrationId, { problem: r.problem!, at: r.at! });
  return out;
}

/** Writes what's due, every few seconds and when woken; one per instance, kept apart by claims. */
export class ChecksSender {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private kicked = false;
  private stopped = false;

  constructor(private app: AppServices) {}

  start(): void {
    this.stopped = false;
    kicks.set(this.app, () => this.kick());
    this.timer = setInterval(() => this.kick(), POLL_MS);
    this.timer.unref?.();
    this.kick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    kicks.delete(this.app);
    await this.running;
  }

  kick(): void {
    if (this.stopped) return;
    if (this.running) {
      this.kicked = true;
      return;
    }
    this.running = this.tick()
      .catch((e) => console.error('check run sender tick failed', e))
      .finally(() => {
        this.running = null;
        if (this.kicked) {
          this.kicked = false;
          this.kick();
        }
      });
  }

  /** Write everything due now (tests). */
  async drain(): Promise<void> {
    await this.running;
    await this.tick();
  }

  private async tick(): Promise<void> {
    for (;;) {
      if (this.stopped) return;
      const batch = await claim(this.app.db);
      for (const row of batch) await sendCheck(this.app, row);
      if (batch.length < BATCH) return;
    }
  }
}
