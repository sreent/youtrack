/**
 * Builds from CI (docs/architecture.md, D46).
 *
 * A build is a project's: its number or name, how it ended, a link, and the commits it holds. Once
 * one succeeds, its name becomes a value of the project's build field (D41), and the resolved
 * issues its commits name get it, "Fixed in build", through the write path, as the build source
 * (channel `ci`): in their history, and to the rules that act on such a change. What it did to each
 * issue is kept beside it (`build_issues`), so a build says what it marked and why it left the rest.
 *
 * Builds come three ways:
 * - A GitHub integration's `workflow_run` deliveries (receive.ts, signed as pushes are): a run of
 *   the chosen workflow on the chosen branch that finishes is a build. Its commits are those since
 *   the source's last build on that branch: asked of GitHub's compare API with the integration's
 *   token, or else those a4a has seen pushed to that branch, by when they were made.
 * - A Gitea or Forgejo integration's Actions runs (D55), the same way: Forgejo's own run events,
 *   or Gitea's `workflow_run`. With no token, a run holds what a4a saw pushed, and the commits of
 *   the push that started it, which Forgejo's run carries.
 * - Anything else (Jenkins, TeamCity, GitLab CI, a script) posts to /builds/hooks/{source} with
 *   the source's token as a Bearer token: the build, and its commits (their shas, their messages,
 *   or a range a4a asks GitHub about).
 *
 * A build reported again (a re-run, a retry of the request) is the same build: what it holds now is
 * added, and an issue it left open before is marked once it's resolved. Reports of one build are
 * taken one at a time, and one that comes late never steps it back: a success stays one.
 */
import {
  BuildSourceBody,
  ReportBuildBody,
  type Build,
  type BuildIssueOutcome,
  type BuildReported,
  type BuildSource,
  type BuildSourceCreated,
  type BuildSourceKind,
  type BuildStatus,
  type IssueBuild,
} from '@a4a/shared';
import { createHash, timingSafeEqual } from 'node:crypto';
import { and, desc, eq, gt, inArray, isNotNull, lte, ne, sql } from 'drizzle-orm';
import { z, ZodError } from 'zod';
import { adminCtx } from '../app-services';
import { requireScope, type AppServices, type Ctx } from '../context';
import type { Db } from '../db/client';
import { BUILDS_BOT, WORKFLOW_BOT } from '../db/defaults';
import { buildIssues, buildSources, builds, issues, vcsIntegrations, vcsLinks } from '../db/schema';
import { publishActivities, recordActivity, type ActivityRow } from '../events/activity';
import { RateLimiter } from '../http/middleware';
import { randomToken, sha256 } from '../lib/crypto';
import { AppError, asSentence, badRequest, notFound } from '../lib/errors';
import { newId } from '../lib/ids';
import { excerpt } from '../lib/text';
import { requireProject, seenIssueIds } from '../services/access';
import { addFieldValue, attachField, createField } from '../services/fields';
import { issueRefsById, type IssueRow } from '../services/issue-refs';
import { applyChanges, fieldValuesOf, findIssue, resolveIssue } from '../services/issues';
import { fieldByName, type FieldRow, type SchemaSnapshot } from '../services/schema-cache';
import { getJson, ReadError } from '../vcs/commits';
import { NOBODY, type IntegrationRow } from '../vcs/links';
import { mentions } from '../vcs/mentions';
import { link, when } from '../vcs/payloads';
import { tokenOf } from '../vcs/tokens';

type SourceRow = typeof buildSources.$inferSelect;
type BuildRow = typeof builds.$inferSelect;

/** The build field a4a makes for a project that has none. */
export const FIXED_IN_BUILD = 'Fixed in build';
export const GITHUB_API = 'https://api.github.com';
/** Commits one build may hold, as a4a reads them. */
export const MAX_BUILD_COMMITS = 2000;
/** What GitHub's compare answers on its first page. */
const COMPARE_MAX = 250;
const MAX_BODY = 1024 * 1024;

const perSource = new RateLimiter(120, 60_000);
const refusedFrom = new RateLimiter(30, 600_000);

export function buildHookUrl(app: AppServices, id: string): string {
  return `${app.config.publicUrl}/api/v1/builds/hooks/${id}`;
}

/**
 * A build's changes are made by a4a's builds agent, through the source: with administrator scopes,
 * as the workflow agent acts (D25), but in its project alone, and shown as the source.
 */
function ciCtx(app: AppServices, s: SchemaSnapshot, source: Pick<SourceRow, 'name' | 'projectId'>): Ctx {
  const own = (login: string) => {
    const u = s.usersByLogin.get(login);
    return u?.isBot ? u : undefined;
  };
  const ctx = adminCtx(app, own(BUILDS_BOT) ?? own(WORKFLOW_BOT) ?? NOBODY, 'ci');
  ctx.actor.tokenName = source.name;
  ctx.actor.projectIds = [source.projectId];
  return ctx;
}

/** The build field a source fills: its own choice, else the project's "Fixed in build", or its one build field. */
export function buildFieldOf(s: SchemaSnapshot, projectId: string, fieldId: string | null): FieldRow | null {
  const attached = (s.projectFields.get(projectId) ?? []).map((pf) => s.fields.get(pf.fieldId)).filter((f): f is FieldRow => f?.type === 'build');
  if (fieldId) return attached.find((f) => f.id === fieldId) ?? null;
  return attached.find((f) => f.name.toLowerCase() === FIXED_IN_BUILD.toLowerCase()) ?? (attached.length === 1 ? attached[0]! : null);
}

// ---------------------------------------------------------------------------
// Sources, as administrators manage them
// ---------------------------------------------------------------------------

async function sourceDto(app: AppServices, s: SchemaSnapshot, row: SourceRow): Promise<BuildSource> {
  const field = buildFieldOf(s, row.projectId, row.fieldId);
  let integration: BuildSource['integration'] = null;
  if (row.vcsIntegrationId) {
    const [i] = await app.db.select({ id: vcsIntegrations.id, name: vcsIntegrations.name }).from(vcsIntegrations).where(eq(vcsIntegrations.id, row.vcsIntegrationId));
    integration = i ?? null;
  }
  return {
    id: row.id,
    kind: row.kind as BuildSourceKind,
    name: row.name,
    project: s.projects.get(row.projectId)?.key ?? '?',
    field: field?.name ?? null,
    integration,
    branch: row.branch,
    workflow: row.workflow,
    hookUrl: row.kind === 'generic' ? buildHookUrl(app, row.id) : null,
    tokenPrefix: row.tokenPrefix,
    active: row.active,
    createdAt: row.createdAt.toISOString(),
    lastBuildAt: row.lastBuildAt?.toISOString() ?? null,
  };
}

/**
 * The build field to fill: one named, which must be a build field (given the project, if it hasn't
 * it), or the project's own; a project with none gets "Fixed in build", made if it isn't there.
 */
async function fieldFor(ctx: Ctx, projectKey: string, projectId: string, named: string | null | undefined): Promise<string | null> {
  let s = await ctx.app.schema.get();
  if (named) {
    const f = s.fields.get(named) ?? fieldByName(s, named);
    if (!f) throw notFound(`Field ${named}`, 'Name a build field, or leave it out for the project’s own.').said('ci.fieldNotFound', { field: named });
    if (f.type !== 'build') throw badRequest(`${f.name} is a ${f.type} field, not a build field`, 'A build goes in a build field: make one under Fields, or leave it out and a4a makes "Fixed in build".').said('ci.notABuildField', { field: f.name, type: f.type });
    if (!buildFieldOf(s, projectId, f.id)) await attachField(ctx, projectKey, f.id, {});
    return f.id;
  }
  const own = buildFieldOf(s, projectId, null);
  if (own) return null;
  const attached = (s.projectFields.get(projectId) ?? []).map((pf) => s.fields.get(pf.fieldId)).filter((f) => f?.type === 'build');
  if (attached.length > 1) throw badRequest(`${projectKey} has ${attached.length} build fields`, `Say which one its builds go in: ${attached.map((f) => f!.name).join(', ')}.`).said('ci.manyBuildFields', { project: projectKey, count: attached.length, fields: attached.map((f) => f!.name).join(', ') });
  let made = fieldByName(s, FIXED_IN_BUILD);
  if (made && made.type !== 'build') throw badRequest(`"${FIXED_IN_BUILD}" is a ${made.type} field here`, 'Name a build field for the builds to go in.').said('ci.fixedInBuildTaken', { field: FIXED_IN_BUILD, type: made.type });
  if (!made) {
    await createField(ctx, { name: FIXED_IN_BUILD, type: 'build', multi: false, description: 'The build the fix first went out in: CI sets it on the resolved issues its commits name (D46).', values: [] });
    s = await ctx.app.schema.get();
    made = fieldByName(s, FIXED_IN_BUILD)!;
  }
  await attachField(ctx, projectKey, made.id, {});
  return null;
}

async function loadSource(db: Db, id: string): Promise<SourceRow> {
  const [row] = await db.select().from(buildSources).where(eq(buildSources.id, id));
  if (!row) throw notFound('Build source').said('ci.sourceNotFound');
  return row;
}

export async function listBuildSources(ctx: Ctx): Promise<BuildSource[]> {
  requireScope(ctx, 'admin');
  const s = await ctx.app.schema.get();
  const rows = await ctx.db.select().from(buildSources).orderBy(desc(buildSources.createdAt));
  return Promise.all(rows.map((r) => sourceDto(ctx.app, s, r)));
}

function tokenFor(): { token: string; hash: string; prefix: string } {
  const token = randomToken('a4a_ci_', 24);
  return { token, hash: sha256(token), prefix: token.slice(0, 11) };
}

export async function createBuildSource(ctx: Ctx, input: z.input<typeof BuildSourceBody>): Promise<BuildSourceCreated> {
  requireScope(ctx, 'admin');
  const body = BuildSourceBody.parse(input);
  const project = await requireProject(ctx, body.project, 'manage');
  let integrationId: string | null = null;
  if (body.kind === 'github') {
    if (!body.integration) throw badRequest('Say which GitHub integration’s workflow runs are builds', 'Add a GitHub integration first, then give its id.').said('ci.githubIntegrationNeeded');
    const [i] = await ctx.db.select().from(vcsIntegrations).where(eq(vcsIntegrations.id, body.integration));
    if (!i) throw notFound('Integration').said('ci.integrationNotFound');
    if (i.provider !== 'github') throw badRequest(`${i.name} isn't a GitHub integration`, 'Workflow runs come from GitHub Actions; any other CI posts its builds with a token: choose "Any CI".').said('ci.notGithub', { integration: i.name });
    integrationId = i.id;
  } else if (body.kind === 'gitea') {
    if (!body.integration) throw badRequest('Say which Gitea or Forgejo integration’s Actions runs are builds', 'Add a Gitea or Forgejo integration first, then give its id.').said('ci.giteaIntegrationNeeded');
    const [i] = await ctx.db.select().from(vcsIntegrations).where(eq(vcsIntegrations.id, body.integration));
    if (!i) throw notFound('Integration').said('ci.integrationNotFound');
    if (i.provider !== 'gitea') {
      throw badRequest(`${i.name} isn't a Gitea or Forgejo integration`, 'Choose one that is; for a GitHub integration, choose GitHub Actions, and for any other CI, "Any CI".').said('ci.notGitea', { integration: i.name });
    }
    integrationId = i.id;
  } else if (body.integration || body.branch || body.workflow) {
    throw badRequest('A CI that posts its builds takes no integration, branch or workflow', 'It says which build it is, and its branch, as it posts each one.').said('ci.postingTakesNoSource');
  }
  const fieldId = await fieldFor(ctx, project.key, project.id, body.field);
  const minted = body.kind === 'generic' ? tokenFor() : null;
  const [row] = await ctx.db
    .insert(buildSources)
    .values({
      id: newId(),
      kind: body.kind,
      name: body.name,
      projectId: project.id,
      fieldId,
      vcsIntegrationId: integrationId,
      branch: body.branch?.trim() || null,
      workflow: body.workflow?.trim() || null,
      tokenHash: minted?.hash ?? null,
      tokenPrefix: minted?.prefix ?? null,
      active: body.active,
      createdById: ctx.actor.user.id,
    })
    .returning();
  return { ...(await sourceDto(ctx.app, await ctx.app.schema.get(), row!)), token: minted?.token ?? null };
}

export async function updateBuildSource(
  ctx: Ctx,
  id: string,
  input: { name?: string; field?: string | null; branch?: string | null; workflow?: string | null; active?: boolean },
): Promise<BuildSource> {
  requireScope(ctx, 'admin');
  const row = await loadSource(ctx.db, id);
  const s = await ctx.app.schema.get();
  const key = s.projects.get(row.projectId)?.key ?? '';
  if (row.kind === 'generic' && (input.branch || input.workflow)) throw badRequest('A CI that posts its builds takes no branch or workflow', 'It says its branch as it posts each build.').said('ci.postingTakesNoBranch');
  const fieldId = input.field !== undefined ? await fieldFor(ctx, key, row.projectId, input.field) : undefined;
  const [updated] = await ctx.db
    .update(buildSources)
    .set({
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(fieldId !== undefined ? { fieldId } : {}),
      ...(input.branch !== undefined ? { branch: input.branch?.trim() || null } : {}),
      ...(input.workflow !== undefined ? { workflow: input.workflow?.trim() || null } : {}),
      ...(input.active !== undefined ? { active: input.active } : {}),
    })
    .where(eq(buildSources.id, row.id))
    .returning();
  return sourceDto(ctx.app, await ctx.app.schema.get(), updated!);
}

export async function deleteBuildSource(ctx: Ctx, id: string): Promise<void> {
  requireScope(ctx, 'admin');
  const row = await loadSource(ctx.db, id);
  await ctx.db.delete(buildSources).where(eq(buildSources.id, row.id));
}

/** A new token, shown once; the old one stops working at once. */
export async function rotateBuildToken(ctx: Ctx, id: string): Promise<BuildSourceCreated> {
  requireScope(ctx, 'admin');
  const row = await loadSource(ctx.db, id);
  if (row.kind === 'gitea') throw badRequest('Its builds come signed by its Gitea or Forgejo integration', 'Give the integration a new secret instead.').said('ci.signedByGiteaIntegration');
  if (row.kind !== 'generic') throw badRequest('Its builds come signed by its GitHub integration', 'Give the integration a new secret instead.').said('ci.signedByIntegration');
  const minted = tokenFor();
  const [updated] = await ctx.db.update(buildSources).set({ tokenHash: minted.hash, tokenPrefix: minted.prefix }).where(eq(buildSources.id, row.id)).returning();
  return { ...(await sourceDto(ctx.app, await ctx.app.schema.get(), updated!)), token: minted.token };
}

// ---------------------------------------------------------------------------
// Recording a build
// ---------------------------------------------------------------------------

export interface CommitSeen {
  sha: string | null;
  message: string | null;
}

export interface BuildFacts {
  name: string;
  status: BuildStatus;
  url: string | null;
  repository: string | null;
  branch: string | null;
  headSha: string | null;
  headAt: Date | null;
  finishedAt: Date | null;
  commits: CommitSeen[];
}

export interface Recorded {
  build: BuildRow;
  again: boolean;
  /** Nothing new: it was reported in this state, with these commits, already (`quietIfSame`). */
  same: boolean;
  marked: number;
  /** For the log a person reads: what it did, issue by issue. */
  said: string[];
}

export interface RecordOptions {
  /**
   * A host's run told again in a state the build has already (a delivery sent twice, or Forgejo's
   * old run event beside its new one) only looks again at the issues the build left open, and
   * records no event unless it marks one.
   */
  quietIfSame?: boolean;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The issues of the build's project its commits name: by the links pushes made (D26), and by what their messages say. */
async function issuesNamed(db: Db, s: SchemaSnapshot, projectId: string, facts: BuildFacts): Promise<Map<string, { issue: IssueRow; commit: string | null }>> {
  const out = new Map<string, { issue: IssueRow; commit: string | null }>();
  const shas = [...new Set(facts.commits.map((c) => c.sha?.toLowerCase()).filter((x): x is string => Boolean(x)))];
  for (let i = 0; i < shas.length; i += 500) {
    const part = shas.slice(i, i + 500);
    const rows = await db
      .select({ issue: issues, sha: vcsLinks.ref })
      .from(vcsLinks)
      .innerJoin(issues, eq(issues.id, vcsLinks.issueId))
      .where(and(eq(vcsLinks.kind, 'commit'), inArray(vcsLinks.ref, part), eq(issues.projectId, projectId), ...(facts.repository ? [eq(vcsLinks.repository, facts.repository)] : [])));
    for (const r of rows) if (!out.has(r.issue.id)) out.set(r.issue.id, { issue: r.issue, commit: r.sha });
  }
  // Short shas (a CI may send seven characters): matched by prefix against what was linked.
  const project = s.projects.get(projectId);
  const keys = new Set(project ? [project.key.toUpperCase()] : []);
  for (const c of facts.commits) {
    if (!c.message) continue;
    for (const m of mentions(c.message, keys, false)) {
      const issue = await findIssue(db, s, m.id);
      if (issue && issue.projectId === projectId && !out.has(issue.id)) out.set(issue.id, { issue, commit: c.sha });
    }
  }
  return out;
}

/**
 * Where a build stands after a report. A success is final: it's a value, and it has marked
 * issues. Otherwise the report says how it ended, unless it came late: older, by when each says
 * the build finished, than the report the build holds (a delivery sent again later, or an
 * earlier attempt's). A late report changes nothing but what the build holds.
 */
function settle(before: BuildRow | undefined, facts: BuildFacts): { status: BuildStatus; url: string | null; finishedAt: Date } {
  const url = link(facts.url);
  if (!before) return { status: facts.status, url, finishedAt: facts.finishedAt ?? new Date() };
  const late = Boolean(facts.finishedAt && before.finishedAt && facts.finishedAt < before.finishedAt);
  const status: BuildStatus = before.status === 'success' || facts.status === 'success' ? 'success' : late ? (before.status as BuildStatus) : facts.status;
  if (late) return { status, url: before.url ?? url, finishedAt: before.finishedAt! };
  return { status, url: url ?? before.url, finishedAt: facts.finishedAt ?? before.finishedAt ?? new Date() };
}

/** Record a build, and if it succeeded, mark the resolved issues its commits name. */
export async function recordBuild(app: AppServices, source: SourceRow, facts: BuildFacts, opts: RecordOptions = {}): Promise<Recorded> {
  const s = await app.schema.get();
  const project = s.projects.get(source.projectId);
  if (!project) throw notFound('Project').said('ci.projectNotFound');
  const ctx = ciCtx(app, s, source);
  const field = buildFieldOf(s, source.projectId, source.fieldId);
  const shas = [...new Set(facts.commits.map((c) => c.sha?.toLowerCase()).filter((x): x is string => Boolean(x)))].slice(0, MAX_BUILD_COMMITS);
  const said: string[] = [];

  // A build's reports are taken one at a time, across instances (D17): two deliveries of one run
  // come together (Forgejo sends its old run event beside the new one), and each must see what the
  // other did, so one value is made and what's marked is marked once.
  let madeValue = false;
  const { build, before, same } = await app.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`a4a:build:${source.projectId}|${facts.name}`}))`);
    const [before] = await tx.select().from(builds).where(and(eq(builds.projectId, source.projectId), eq(builds.name, facts.name)));
    const next = settle(before, facts);
    const merged = [...new Set([...(before?.commits ?? []), ...shas])].slice(0, MAX_BUILD_COMMITS);
    const same = Boolean(before && before.status === next.status && before.url === next.url && merged.length === before.commits.length);
    if (same && opts.quietIfSame) return { build: before!, before, same };
    let valueId: string | null = before?.valueId ?? null;
    if (next.status === 'success' && field && !valueId) {
      valueId = (await addFieldValue({ ...ctx, db: tx }, field.id, { name: facts.name, project: project.key })).id;
      madeValue = true;
    }
    const values = {
      sourceId: source.id,
      fieldId: field?.id ?? null,
      valueId,
      status: next.status,
      url: next.url,
      repository: facts.repository ?? before?.repository ?? null,
      branch: facts.branch ?? before?.branch ?? null,
      headSha: facts.headSha ?? before?.headSha ?? null,
      headAt: facts.headAt ?? before?.headAt ?? null,
      commits: merged,
      finishedAt: next.finishedAt,
      updatedAt: new Date(),
    };
    const [row] = await tx
      .insert(builds)
      .values({ id: newId(), projectId: source.projectId, name: facts.name, ...values })
      .onConflictDoUpdate({ target: [builds.projectId, builds.name], set: values })
      .returning();
    return { build: row!, before, same };
  });
  // The value was made inside the transaction: a schema read before it committed mustn't stay.
  if (madeValue) app.schema.invalidate();
  // Told nothing new, it still looks again at what the build left open, as D46 has a later report
  // do; only those, since a report beside it may be marking the rest now. It says nothing unless
  // it marks one.
  const quiet = same && Boolean(opts.quietIfSame);
  const succeeded = build.status === 'success';
  const valueId = build.valueId;
  if (succeeded && !field && !quiet) said.push(`${project.key} has no build field, so the build is kept but marks nothing: give it one under Integrations`);

  let marked = 0;
  const activities: ActivityRow[] = [];
  if (field) {
    const named = quiet
      ? new Map<string, { issue: IssueRow; commit: string | null }>()
      : await issuesNamed(app.db, s, source.projectId, { ...facts, commits: [...facts.commits, ...(before?.commits ?? []).map((sha) => ({ sha, message: null }))] });
    const earlier = await app.db.select().from(buildIssues).where(eq(buildIssues.buildId, build.id));
    const done = new Map(earlier.map((r) => [r.issueId, r.outcome as BuildIssueOutcome]));
    // What it held when reported before (by a message, say) and didn't mark then is looked at again.
    const again = earlier.filter((r) => r.outcome === 'open' || r.outcome === 'refused').map((r) => r.issueId).filter((id) => !named.has(id));
    if (again.length) for (const issue of await app.db.select().from(issues).where(inArray(issues.id, again))) named.set(issue.id, { issue, commit: earlier.find((r) => r.issueId === issue.id)?.commit ?? null });
    for (const { issue, commit } of named.values()) {
      if (done.get(issue.id) === 'marked' || done.get(issue.id) === 'already') continue;
      if (!succeeded || !valueId) {
        // A build that didn't succeed marks nothing; what it holds is kept, for when it's run again and passes.
        const { note, said } = build.status === 'cancelled' ? noted('The build was cancelled', 'builds.note.cancelled') : noted('The build failed', 'builds.note.failed');
        await app.db
          .insert(buildIssues)
          .values({ buildId: build.id, issueId: issue.id, outcome: 'refused', note, said, commit })
          .onConflictDoUpdate({ target: [buildIssues.buildId, buildIssues.issueId], set: { outcome: 'refused', note, said, commit }, setWhere: ne(buildIssues.outcome, 'marked') });
        continue;
      }
      const r = await markIssue(app, ctx, s, build, field, valueId, issue, commit);
      if (r.outcome === 'marked') marked++;
      activities.push(...r.activities);
      said.push(r.said);
    }
  }
  const total = (await app.db.select({ id: buildIssues.issueId }).from(buildIssues).where(and(eq(buildIssues.buildId, build.id), eq(buildIssues.outcome, 'marked')))).length;
  const [finalRow] = await app.db.update(builds).set({ marked: total }).where(eq(builds.id, build.id)).returning();
  if (quiet && !marked) {
    await publishActivities(app, activities);
    return { build: finalRow!, again: true, same: true, marked: 0, said };
  }
  await app.db.update(buildSources).set({ lastBuildAt: new Date() }).where(eq(buildSources.id, source.id));
  activities.push(
    await recordActivity(app.db, ctx, {
      type: 'build.recorded',
      projectId: source.projectId,
      issueId: null,
      payload: { data: { build: facts.name, status: build.status, url: build.url, source: source.name, commits: build.commits.length, marked, again: Boolean(before) } },
    }),
  );
  await publishActivities(app, activities);
  return { build: finalRow!, again: Boolean(before), same: false, marked, said };
}

/** Why a build left an issue as it did: in English for the API, and its words in the catalogs for a page (D49). */
type Noted = { note: string | null; said: { key: string; values?: Record<string, unknown> } | null };
const noted = (note: string, key: string, values?: Record<string, unknown>): Noted => ({ note, said: values ? { key, values } : { key } });

/** One issue a build's commits name: marked when it's resolved and names no build yet, in a transaction of its own. */
async function markIssue(
  app: AppServices,
  ctx: Ctx,
  s: SchemaSnapshot,
  build: BuildRow,
  field: FieldRow,
  valueId: string,
  issue: IssueRow,
  commit: string | null,
): Promise<{ outcome: BuildIssueOutcome; said: string; activities: ActivityRow[] }> {
  const key = `${s.projects.get(issue.projectId)?.key ?? '?'}-${issue.number}`;
  const activities: ActivityRow[] = [];
  const outcome = await app.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [locked] = await tx.select().from(issues).where(eq(issues.id, issue.id)).for('update');
    if (!locked) return { outcome: 'refused' as const, ...noted('It was deleted', 'builds.note.deleted') };
    let out: { outcome: BuildIssueOutcome } & Noted;
    const has = (await fieldValuesOf(tx, locked.id)).get(field.id) ?? [];
    const other = has.length ? s.values.get(has[0]!.valueId ?? '')?.name : undefined;
    if (!locked.resolvedAt) out = { outcome: 'open', ...noted('Not resolved yet', 'builds.note.notResolved') };
    else if (has.some((v) => v.valueId === valueId)) out = { outcome: 'already', note: null, said: null };
    else if (has.length && !field.multi) out = { outcome: 'already', ...(other ? noted(`It says ${other} already`, 'builds.note.saysAlready', { build: other }) : noted('It says another build already', 'builds.note.saysAnother')) };
    else {
      try {
        const res = await tx.transaction(async (spRaw) =>
          applyChanges(spRaw as unknown as Db, ctx, locked, {
            fields: [{ field, mode: field.multi ? 'add' : 'set', values: [{ valueId }] }],
            data: { build: { name: build.name, url: build.url } },
          }),
        );
        activities.push(...res.activities);
        out = { outcome: 'marked', note: null, said: null };
      } catch (e) {
        if (!(e instanceof AppError)) throw e;
        // A guard's or a permission's refusal: a page says it as the problem it is, in its language.
        out = { outcome: 'refused', note: excerpt(e.message, 500), said: e.words ? { key: `problem.${e.words.key}`, ...(e.words.values ? { values: e.words.values } : {}) } : null };
      }
    }
    // Another report of the same build may have marked it a moment ago: what it marked stays marked.
    await tx
      .insert(buildIssues)
      .values({ buildId: build.id, issueId: locked.id, outcome: out.outcome, note: out.note, said: out.said, commit })
      .onConflictDoUpdate({ target: [buildIssues.buildId, buildIssues.issueId], set: { outcome: out.outcome, note: out.note, said: out.said, commit }, setWhere: ne(buildIssues.outcome, 'marked') });
    return out;
  });
  const words: Record<BuildIssueOutcome, string> = {
    marked: `${key}: ${field.name} is ${build.name}`,
    already: `${key}: ${outcome.note ?? `it says ${build.name} already`}`,
    open: `${key}: left, not resolved yet`,
    refused: `${key}: not marked: ${outcome.note}`,
  };
  return { outcome: outcome.outcome, said: words[outcome.outcome], activities };
}

// ---------------------------------------------------------------------------
// GitHub's workflow runs
// ---------------------------------------------------------------------------

export interface WorkflowRun {
  action: string;
  repository: string;
  runId: string;
  workflow: string | null;
  path: string | null;
  number: number | null;
  branch: string | null;
  headSha: string;
  headAt: Date | null;
  headMessage: string;
  conclusion: string | null;
  url: string | null;
  at: Date | null;
  /** The commits of the push that started it, when the run carries them (Forgejo's). */
  pushed: { sha: string; message: string; at: Date | null }[];
}

/** A workflow's file by its name alone. */
const fileOf = (path: string): string => path.split('/').pop() ?? '';

function takes(source: SourceRow, run: WorkflowRun): boolean {
  if (source.branch && source.branch !== run.branch) return false;
  if (!source.workflow) return true;
  const w = source.workflow.trim().toLowerCase();
  // GitHub names .github/workflows/ci.yml; Forgejo ci.yml alone; Gitea ci.yml@refs/heads/main.
  const path = (run.path ?? '').toLowerCase().replace(/@.*$/, '');
  const fileAlone = path !== '' && !path.includes('/') && fileOf(w) === path;
  return (run.workflow ?? '').toLowerCase() === w || path === w || path.endsWith(`/${w}`) || fileAlone;
}

const statusOf = (conclusion: string | null): BuildStatus => (conclusion === 'success' ? 'success' : conclusion === 'cancelled' ? 'cancelled' : 'failure');

/** What GitHub says lies between two commits, with the integration's token: newest last. */
async function compare(app: AppServices, integration: IntegrationRow, repository: string, from: string, to: string): Promise<{ commits: CommitSeen[]; more: number } | { problem: string }> {
  const token = tokenOf(app, integration.accessToken);
  if (!token) return { problem: 'no access token' };
  const base = (integration.baseUrl ?? GITHUB_API).replace(/\/+$/, '');
  const repo = repository.split('/').map(encodeURIComponent).join('/');
  try {
    const got = z
      .object({ total_commits: z.number().int().nullish(), commits: z.array(z.object({ sha: z.string(), commit: z.object({ message: z.string().nullish() }) })).default([]) })
      .parse(await getJson(`${base}/repos/${repo}/compare/${encodeURIComponent(from)}...${encodeURIComponent(to)}`, token));
    const commits = got.commits.slice(0, COMPARE_MAX).map((c) => ({ sha: c.sha, message: c.commit.message ?? null }));
    return { commits, more: Math.max(0, (got.total_commits ?? commits.length) - commits.length) };
  } catch (e) {
    if (e instanceof ReadError) return { problem: `GitHub's compare couldn't be read: ${e.message}` };
    if (e instanceof ZodError) return { problem: "GitHub's compare didn't answer as it does" };
    throw e;
  }
}

/** The commits a4a has seen pushed to a branch of a repository, between two moments. */
async function seenBetween(db: Db, repository: string, branch: string | null, after: Date | null, upTo: Date | null): Promise<CommitSeen[]> {
  const rows = await db
    .selectDistinct({ sha: vcsLinks.ref })
    .from(vcsLinks)
    .where(
      and(
        eq(vcsLinks.kind, 'commit'),
        eq(vcsLinks.repository, repository),
        ...(branch ? [eq(vcsLinks.branch, branch)] : []),
        ...(after ? [gt(vcsLinks.happenedAt, after)] : []),
        ...(upTo ? [lte(vcsLinks.happenedAt, upTo)] : []),
        isNotNull(vcsLinks.happenedAt),
      ),
    )
    .limit(MAX_BUILD_COMMITS);
  return rows.map((r) => ({ sha: r.sha, message: null }));
}

/** The commits a run holds: since the source's last successful build on its branch. */
async function runCommits(app: AppServices, integration: IntegrationRow, source: SourceRow, run: WorkflowRun): Promise<{ commits: CommitSeen[]; note: string | null }> {
  const head: CommitSeen = { sha: run.headSha, message: run.headMessage || null };
  const [last] = await app.db
    .select()
    .from(builds)
    .where(and(eq(builds.sourceId, source.id), eq(builds.status, 'success'), isNotNull(builds.headSha), ...(run.branch ? [eq(builds.branch, run.branch)] : []), ne(builds.headSha, run.headSha)))
    .orderBy(desc(builds.createdAt))
    .limit(1);
  // The push that started the run, when the run carries it (Forgejo's): its commits and their messages.
  const pushed: CommitSeen[] = run.pushed.map((c) => ({ sha: c.sha, message: c.message }));
  // Since the last passing build's head commit; one whose head's time isn't known, since it was recorded.
  const since = last ? (last.headAt ?? last.createdAt) : source.createdAt;
  // Only GitHub's compare is asked, and only of a GitHub integration: no other host's token goes to GitHub.
  if (last?.headSha && integration.provider === 'github' && integration.accessToken) {
    const got = await compare(app, integration, run.repository, last.headSha, run.headSha);
    if ('commits' in got) return { commits: [...got.commits, head], note: got.more ? `GitHub named ${got.commits.length} of its commits; the ${got.more} before them weren't read` : null };
    const seen = await seenBetween(app.db, run.repository, run.branch, since, run.headAt ?? run.at);
    return { commits: [...seen, head], note: `${got.problem}; read the commits a4a saw pushed instead` };
  }
  // Without a token, or a first build: what a4a saw pushed to the branch since the last build, or since the source began.
  const seen = await seenBetween(app.db, run.repository, run.branch, since, run.headAt ?? run.at);
  return { commits: [...seen, ...pushed, head], note: null };
}

/** A finished workflow run: a build of each source of this integration that takes it. */
export async function buildsFromRun(
  app: AppServices,
  integration: IntegrationRow,
  run: WorkflowRun,
): Promise<{ outcome: 'processed' | 'ignored'; message: string; reply: string; marked: number }> {
  const what = `${run.workflow ?? run.path ?? 'A workflow'}${run.number ? ` #${run.number}` : ''} on ${run.branch ?? 'no branch'}`;
  const quiet = (message: string) => ({ outcome: 'ignored' as const, message, reply: 'Read: not a build a4a takes.', marked: 0 });
  if (run.action !== 'completed') return quiet(`${what} is ${run.action}: a run is a build once it finishes.`);
  // Every job skipped (a condition said no): nothing was built.
  if (run.conclusion === 'skipped') return quiet(`${what} was skipped: it built nothing, so it isn't a build.`);
  const sources = (await app.db.select().from(buildSources).where(and(eq(buildSources.vcsIntegrationId, integration.id), eq(buildSources.active, true)))).filter((src) => takes(src, run));
  if (!sources.length) return quiet(`${what}: no build source takes runs of that workflow on that branch.`);
  const said: string[] = [];
  let marked = 0;
  let fresh = 0;
  for (const source of sources) {
    const { commits, note } = await runCommits(app, integration, source, run);
    // A source that takes one workflow names its builds by the run's number; one that takes any, by the workflow's name too.
    const name = source.workflow || !run.workflow ? String(run.number ?? run.runId) : `${run.workflow} ${run.number ?? run.runId}`;
    const r = await recordBuild(app, source, {
      name,
      status: statusOf(run.conclusion),
      url: run.url,
      repository: run.repository,
      branch: run.branch,
      headSha: run.headSha,
      headAt: run.headAt,
      finishedAt: run.at,
      commits,
    }, { quietIfSame: true });
    if (r.same) {
      said.push(`${source.name}: build ${name} was recorded already as ${r.build.status}, with these commits: nothing new`);
      continue;
    }
    fresh++;
    marked += r.marked;
    said.push(`${source.name}: build ${name} (${r.build.status}), ${plural(r.build.commits.length, 'commit')}${r.said.length ? `; ${r.said.join('; ')}` : ''}${note ? `. ${note}` : ''}`);
  }
  // The same run told twice (Forgejo sends its old run event beside the new one) is one build.
  if (!fresh) return { outcome: 'ignored', message: `${what}. ${said.join('. ')}.`, reply: 'Read: that build was recorded already.', marked: 0 };
  return { outcome: 'processed', message: `${what}. ${said.join('. ')}.`, reply: `Read: ${plural(fresh, 'build')} recorded, ${plural(marked, 'issue')} marked.`, marked };
}

// ---------------------------------------------------------------------------
// Any CI: POST /builds/hooks/{source}, with its token
// ---------------------------------------------------------------------------

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

const refuse = (status: number, code: string, message: string, hint?: string): Answer => ({ status, body: { error: { code, message, ...(hint ? { hint } : {}) } } });

function sameToken(given: string, hash: string | null): boolean {
  if (!hash) return false;
  const a = createHash('sha256').update(given).digest();
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** A range of commits, asked of GitHub with the token of an integration that has seen the repository. */
async function rangeCommits(app: AppServices, repository: string | undefined, range: { from: string; to: string }): Promise<CommitSeen[]> {
  if (!repository) throw badRequest('A range needs its repository', 'Give "repository": "owner/name", or send the commits themselves.').said('ci.rangeNeedsRepository');
  const github = await app.db.select().from(vcsIntegrations).where(and(eq(vcsIntegrations.provider, 'github'), isNotNull(vcsIntegrations.accessToken)));
  const used = new Set(
    (await app.db.selectDistinct({ id: vcsLinks.integrationId }).from(vcsLinks).where(eq(vcsLinks.repository, repository))).map((r) => r.id).filter(Boolean),
  );
  const integration = github.find((i) => used.has(i.id) || i.name.toLowerCase() === repository.toLowerCase());
  const hint = 'Send the commits instead: their shas and messages, as git log prints them between the last build and this one.';
  if (!integration) throw badRequest(`No GitHub integration of ${repository} has an access token, so a4a can't read the range`, hint).said('ci.rangeNoToken', { repository });
  const got = await compare(app, integration, repository, range.from, range.to);
  if ('problem' in got) throw badRequest(`a4a couldn't read the range from GitHub: ${got.problem}`, hint).said('ci.rangeUnreadable', { problem: asSentence(got.problem) });
  return got.commits;
}

/** A build a CI posts: checked, then recorded, and answered with what it did. */
export async function receiveBuild(app: AppServices, sourceId: string, req: Incoming): Promise<Answer> {
  const [source] = await app.db.select().from(buildSources).where(eq(buildSources.id, sourceId));
  if (!source || source.kind !== 'generic') return refuse(404, 'not_found', 'No such build source', 'Check the address a4a showed for it.');
  const auth = req.header('authorization') ?? '';
  const given = /^Bearer\s+(\S+)$/i.exec(auth.trim())?.[1] ?? '';
  if (!sameToken(given, source.tokenHash)) {
    const wait = refusedFrom.hit(`${source.id} ${req.ip}`);
    if (wait) return { ...refuse(429, 'rate_limited', 'Too many refused builds', `Retry in ${wait}s`), retryAfter: wait };
    return refuse(401, 'unauthorized', given ? 'The token does not match' : 'No token', 'Send the token a4a showed for this source as "Authorization: Bearer <token>".');
  }
  const wait = perSource.hit(source.id);
  if (wait) return { ...refuse(429, 'rate_limited', 'Too many builds', `Retry in ${wait}s`), retryAfter: wait };
  if (!source.active) return { status: 202, body: { ok: true, outcome: 'ignored', message: 'The build source is paused: nothing was recorded.' } };
  if (req.body.length > MAX_BODY) return refuse(413, 'too_large', 'The build is too large', `a4a reads up to ${MAX_BODY / 1024} KB a build: send the commits since the last build.`);
  let body: z.infer<typeof ReportBuildBody>;
  try {
    body = ReportBuildBody.parse(JSON.parse(new TextDecoder().decode(req.body)));
  } catch (e) {
    const why = e instanceof ZodError ? e.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).slice(0, 3).join('; ') : 'not JSON';
    return refuse(400, 'bad_request', `a4a couldn't read the build: ${why}`, 'Send JSON: { "build": "1.4.207", "status": "success", "commits": [...] }.');
  }
  try {
    const commits: CommitSeen[] = (body.commits ?? []).map((c) => (typeof c === 'string' ? { sha: c, message: null } : { sha: c.sha ?? null, message: c.message ?? null }));
    if (body.range) commits.push(...(await rangeCommits(app, body.repository, body.range)));
    const r = await recordBuild(app, source, {
      name: body.build,
      status: body.status,
      url: body.url ?? null,
      repository: body.repository ?? null,
      branch: body.branch ?? null,
      headSha: body.range?.to ?? null,
      headAt: null,
      finishedAt: when(body.finishedAt),
      commits,
    });
    const answer: BuildReported = {
      build: r.build.name,
      status: r.build.status as BuildStatus,
      outcome: r.again ? 'again' : 'recorded',
      commits: r.build.commits.length,
      marked: r.marked,
      // The CI's log is read by whoever runs it: counts, not issue ids or summaries.
      message: `${r.again ? 'Reported again' : 'Recorded'}: build ${r.build.name} (${r.build.status}), ${plural(r.build.commits.length, 'commit')}, ${plural(r.marked, 'issue')} marked now.`,
    };
    return { status: 200, body: { ok: true, ...answer } };
  } catch (e) {
    if (e instanceof AppError) return refuse(e.status, e.code, e.message, e.hint);
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Reading: a project's builds, and an issue's
// ---------------------------------------------------------------------------

export async function listBuilds(ctx: Ctx, projectKey: string, opts: { limit?: number; before?: string } = {}): Promise<Build[]> {
  requireScope(ctx, 'read');
  const project = await requireProject(ctx, projectKey);
  const s = await ctx.app.schema.get();
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 200);
  const rows = await ctx.db
    .select({ build: builds, source: { id: buildSources.id, name: buildSources.name, kind: buildSources.kind } })
    .from(builds)
    .leftJoin(buildSources, eq(buildSources.id, builds.sourceId))
    .where(eq(builds.projectId, project.id))
    .orderBy(desc(builds.createdAt))
    .limit(limit);
  const ids = rows.map((r) => r.build.id);
  const touched = ids.length ? await ctx.db.select().from(buildIssues).where(inArray(buildIssues.buildId, ids)) : [];
  const seen = await seenIssueIds(ctx, touched.map((t) => t.issueId));
  const refs = await issueRefsById(ctx.db, s, [...seen]);
  return rows.map(({ build: b, source }) => ({
    id: b.id,
    project: project.key,
    name: b.name,
    status: b.status as BuildStatus,
    url: b.url,
    repository: b.repository,
    branch: b.branch,
    headSha: b.headSha,
    commits: b.commits.length,
    marked: b.marked,
    source: source?.id ? { id: source.id, name: source.name!, kind: source.kind as BuildSourceKind } : null,
    finishedAt: b.finishedAt?.toISOString() ?? null,
    createdAt: b.createdAt.toISOString(),
    issues: touched
      .filter((t) => t.buildId === b.id && refs.has(t.issueId))
      .sort((x, y) => (refs.get(x.issueId)!.id < refs.get(y.issueId)!.id ? -1 : 1))
      .map((t) => ({ issue: refs.get(t.issueId)!, outcome: t.outcome as BuildIssueOutcome, note: t.note, said: t.said ?? null, commit: t.commit })),
  }));
}

/** The builds an issue is in: which marked it, and which found it open or marked already. */
export async function issueBuilds(ctx: Ctx, idOrReadable: string): Promise<IssueBuild[]> {
  requireScope(ctx, 'read');
  const issue = await resolveIssue(ctx, idOrReadable);
  const rows = await ctx.db
    .select({ b: builds, t: buildIssues })
    .from(buildIssues)
    .innerJoin(builds, eq(builds.id, buildIssues.buildId))
    .where(eq(buildIssues.issueId, issue.id))
    .orderBy(desc(builds.createdAt))
    .limit(50);
  return rows.map(({ b, t }) => ({
    build: b.name,
    status: b.status as BuildStatus,
    url: b.url,
    outcome: t.outcome as BuildIssueOutcome,
    note: t.note,
    said: t.said ?? null,
    commit: t.commit,
    finishedAt: b.finishedAt?.toISOString() ?? null,
  }));
}
