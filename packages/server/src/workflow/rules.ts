/**
 * Workflow rules, as people manage them: made, changed, turned off, previewed, and their run log.
 * The engine that applies them is ./engine.ts; the guards on the write path are ./guards.ts.
 *
 * A rule is project-scoped (its query only ever matches its project's issues), or global, for
 * every project, which only administrators manage. Managing a project's rules needs its manager
 * or an administrator (services/access.ts); reading them needs only to read the project.
 */
import {
  RULE_TRIGGERS,
  type Change,
  type QueryProblem,
  type Rule,
  type RuleInput,
  type RuleKind,
  type RulePreview,
  type RuleProblem,
  type RuleRun,
  type RuleSchedule,
  type RuleTrigger,
  type SuggestItem,
} from '@a4a/shared';
import { and, asc, desc, eq, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import { adminCtx } from '../app-services';
import { runCommand } from '../commands/executor';
import { describeCommand, parseCommand, suggestCommand } from '../commands/parser';
import { requireScope, type Ctx } from '../context';
import type { Db } from '../db/client';
import { WORKFLOW_BOT } from '../db/defaults';
import { issues, ruleRuns, rules } from '../db/schema';
import { AppError, badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { newId } from '../lib/ids';
import { compileQuery } from '../search/compiler';
import { explainParsed } from '../search/explain';
import { lex } from '../search/lexer';
import { suggest } from '../search/suggest';
import { assertCanManageProject, assertCanReadProject, canReadProject, visibleProjectIds } from '../services/access';
import { issueRefsById } from '../services/issue-refs';
import { resolveIssue } from '../services/issues';
import { projectByKey, type RuleRow, type SchemaSnapshot } from '../services/schema-cache';
import { resolveFieldInput, userRefDto } from '../services/values';
import { condition, parsedQuery } from './match';
import { DEFAULT_AT, nextRunAfter, ruleSentence, scheduleWords, triggerWords } from './words';

/** A rule as the service works with it: names resolved, every part present. */
export interface Draft {
  projectId: string | null;
  name: string;
  kind: RuleKind;
  trigger: RuleTrigger | null;
  field: string | null;
  schedule: RuleSchedule | null;
  query: string;
  command: string;
  comment: string | null;
  requires: string | null;
  message: string | null;
  enabled: boolean;
}

/** Fields an "updated" rule can wait for besides the project's own. */
const BUILT_IN_FIELDS = ['Summary', 'Description', 'Tags'];
const PREVIEW_SAMPLE = 5;

const trimmed = (v: string | null | undefined): string | null => {
  const t = v?.trim();
  return t ? t : null;
};

export function draftOf(row: RuleRow): Draft {
  return {
    projectId: row.projectId,
    name: row.name,
    kind: row.kind as RuleKind,
    trigger: (row.trigger as RuleTrigger | null) ?? null,
    field: row.triggerField,
    schedule: (row.schedule as RuleSchedule | null) ?? null,
    query: row.query,
    command: row.command,
    comment: row.comment,
    requires: row.requires,
    message: row.message,
    enabled: row.enabled,
  };
}

/** Only the parts that belong to the rule's kind, tidied. */
function tidy(d: Draft): Draft {
  return {
    ...d,
    name: d.name.trim(),
    trigger: d.kind === 'change' ? d.trigger : null,
    field: d.kind === 'change' && d.trigger === 'updated' ? trimmed(d.field) : null,
    schedule: d.kind === 'schedule' && d.schedule ? { every: d.schedule.every, ...(d.schedule.every === 'hour' ? {} : { at: d.schedule.at ?? DEFAULT_AT }) } : null,
    query: d.query.trim(),
    command: d.kind === 'guard' ? '' : d.command.trim(),
    comment: d.kind === 'guard' ? null : trimmed(d.comment),
    requires: d.kind === 'guard' ? trimmed(d.requires) : null,
    message: d.kind === 'guard' ? trimmed(d.message) : null,
  };
}

function projectIdOf(s: SchemaSnapshot, key: string | null | undefined): string | null {
  if (!key) return null;
  const p = projectByKey(s, key);
  if (!p) throw notFound(`Project ${key}`, `Projects: ${[...s.projectsByKey.keys()].join(', ')}`);
  return p.id;
}

function draftFrom(s: SchemaSnapshot, input: RuleInput): Draft {
  return tidy({
    projectId: projectIdOf(s, input.project),
    name: input.name,
    kind: input.kind,
    trigger: input.trigger ?? null,
    field: input.field ?? null,
    schedule: input.schedule ?? null,
    query: input.query ?? '',
    command: input.command ?? '',
    comment: input.comment ?? null,
    requires: input.requires ?? null,
    message: input.message ?? null,
    enabled: input.enabled ?? true,
  });
}

// ---------------------------------------------------------------------------
// What needs fixing in a rule
// ---------------------------------------------------------------------------

const whole = (text: string) => ({ start: 0, end: text.length });

/** A scheduled rule runs on its own: "me" there means nobody. */
function meProblems(text: string): QueryProblem[] {
  return lex(text)
    .tokens.filter((t) => (t.kind === 'word' && /^me$/i.test(t.value)) || (t.kind === 'hash' && /^(me|my)$/i.test(t.value)))
    .map((t) => ({ message: 'A scheduled rule runs on its own, so "me" stands for nobody', start: t.start, end: t.end, hint: 'Name the person instead, e.g. anna.' }));
}

function projectIdsFor(s: SchemaSnapshot, d: Draft): string[] {
  return d.projectId ? [d.projectId] : [...s.projects.keys()];
}

/** Who "me" reads as when a rule is checked: the workflow agent stands in for whoever sets it off. */
function standInFor(s: SchemaSnapshot): string {
  return s.usersByLogin.get(WORKFLOW_BOT)?.id ?? '';
}

function queryProblems(s: SchemaSnapshot, d: Draft, text: string): QueryProblem[] {
  const compiled = compileQuery(parsedQuery(s, text), { s, meId: standInFor(s) });
  return d.kind === 'schedule' ? [...meProblems(text), ...compiled.problems] : compiled.problems;
}

/**
 * What no longer reads in a rule, with no one's access involved: the engine runs a rule only when
 * this is empty, and the rule's page shows it. Pure, over the snapshot.
 */
export function readingProblems(s: SchemaSnapshot, d: Draft): RuleProblem[] {
  const out: RuleProblem[] = [];
  const add = (part: RuleProblem['part'], problems: QueryProblem[]) => out.push(...problems.map((p) => ({ ...p, part })));
  if (!d.name.trim()) add('name', [{ message: 'Give it a name that says what it is for', ...whole('') }]);
  if (d.kind === 'change') {
    if (!d.trigger || !RULE_TRIGGERS.includes(d.trigger)) {
      add('trigger', [{ message: 'Say what sets it off: an issue is created, changes, or gets a comment', ...whole('') }]);
    }
    if (d.field) {
      const known = new Set([...BUILT_IN_FIELDS.map((f) => f.toLowerCase())]);
      for (const pid of projectIdsFor(s, d)) for (const pf of s.projectFields.get(pid) ?? []) known.add(s.fields.get(pf.fieldId)?.name.toLowerCase() ?? '');
      if (!known.has(d.field.toLowerCase())) add('field', [{ message: `There is no field "${d.field}" here`, hint: 'Name a field of the project, such as State or Priority.', ...whole(d.field) }]);
    }
  }
  if (d.kind === 'schedule' && !d.schedule) add('schedule', [{ message: 'Say how often it runs: every hour, every day or every weekday', ...whole('') }]);
  if (d.kind === 'guard') {
    if (!d.query) add('query', [{ message: 'Say which changes it checks: what they would make an issue match', hint: "e.g. State: {Won't fix}", ...whole('') }]);
    if (!d.requires) add('requires', [{ message: 'Say what such an issue must also match', hint: 'e.g. has: comments', ...whole('') }]);
  }
  if (d.query) add('query', queryProblems(s, d, d.query));
  if (d.kind === 'guard' && d.requires) add('requires', queryProblems(s, d, d.requires));
  if (d.kind !== 'guard') {
    if (!d.command && !d.comment) add('command', [{ message: 'Say what it changes, or a comment for it to post', hint: 'e.g. tag urgent', ...whole('') }]);
    if (d.command) {
      const parsed = parseCommand(d.command, s, projectIdsFor(s, d));
      add('command', d.kind === 'schedule' ? [...meProblems(d.command), ...parsed.problems] : parsed.problems);
    }
  }
  return out;
}

/**
 * Everything that must be fixed before the rule is saved: what doesn't read, and what its command
 * names that the person making it can't use (an issue they can't see, a value the project lacks).
 */
export async function ruleProblems(ctx: Ctx, s: SchemaSnapshot, d: Draft): Promise<RuleProblem[]> {
  const out = readingProblems(s, d);
  if (d.kind === 'guard' || !d.command || out.some((p) => p.part === 'command')) return out;
  const parsed = parseCommand(d.command, s, projectIdsFor(s, d));
  for (const op of parsed.ops) {
    if (op.kind === 'link') {
      for (const t of op.targets) {
        try {
          await resolveIssue(ctx, t);
        } catch {
          out.push({ part: 'command', message: `There is no issue ${t}, or you can't see it`, ...whole(d.command) });
        }
      }
    }
    // Values are resolved per project when it runs; a project rule's can be checked now.
    if (op.kind === 'field' && d.projectId) {
      for (const raw of op.raw) {
        try {
          resolveFieldInput(s, op.field, d.projectId, raw, ctx.actor.user.id);
        } catch (e) {
          if (!(e instanceof AppError)) throw e;
          out.push({ part: 'command', message: e.message, ...(e.hint ? { hint: e.hint } : {}), ...whole(d.command) });
        }
      }
    }
  }
  return out;
}

function problemText(problems: RuleProblem[]): string {
  return problems.map((p) => (p.hint ? `${p.message} (${p.hint})` : p.message)).join('; ');
}

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

type RunRow = typeof ruleRuns.$inferSelect;

function runDto(s: SchemaSnapshot, row: RunRow, ruleName: string): RuleRun {
  const by = row.actorId ? s.users.get(row.actorId) : undefined;
  return {
    id: row.id,
    rule: { id: row.ruleId, name: ruleName },
    issue: row.issueKey,
    outcome: row.outcome as RuleRun['outcome'],
    message: row.message,
    changes: (row.changes as Change[] | null) ?? [],
    by: by ? userRefDto(by) : null,
    at: row.createdAt.toISOString(),
  };
}

export function ruleDto(s: SchemaSnapshot, row: RuleRow, lastRun: RunRow | undefined): Rule {
  const d = draftOf(row);
  const by = row.createdById ? s.users.get(row.createdById) : undefined;
  return {
    id: row.id,
    project: row.projectId ? (s.projects.get(row.projectId)?.key ?? null) : null,
    name: row.name,
    kind: d.kind,
    trigger: d.trigger,
    field: d.field,
    schedule: d.schedule,
    query: row.query,
    command: row.command,
    comment: row.comment,
    requires: row.requires,
    message: row.message,
    enabled: row.enabled,
    sentence: ruleSentence(d),
    problems: readingProblems(s, d),
    nextRunAt: row.kind === 'schedule' && row.enabled ? (row.nextRunAt?.toISOString() ?? null) : null,
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
    lastRun: lastRun ? runDto(s, lastRun, row.name) : null,
    version: row.version,
    createdBy: by ? userRefDto(by) : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function lastRuns(db: Db, ids: string[]): Promise<Map<string, RunRow>> {
  if (!ids.length) return new Map();
  const res = await db.execute(sql`
    SELECT DISTINCT ON (rule_id) id FROM rule_runs WHERE rule_id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
    ORDER BY rule_id, id DESC`);
  const runIds = (res as unknown as { rows: { id: number | string }[] }).rows.map((r) => Number(r.id));
  if (!runIds.length) return new Map();
  const rows = await db.select().from(ruleRuns).where(inArray(ruleRuns.id, runIds));
  return new Map(rows.map((r) => [r.ruleId, r]));
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

async function loadRule(ctx: Ctx, id: string): Promise<RuleRow> {
  const [row] = await ctx.db.select().from(rules).where(eq(rules.id, id));
  if (!row) throw notFound('Rule');
  if (row.projectId) {
    await assertCanReadProject(ctx, row.projectId).catch(() => {
      throw notFound('Rule');
    });
  }
  return row;
}

/** Rules that apply in a project (its own and the global ones), or every rule you can see. */
export async function listRules(ctx: Ctx, opts: { project?: string } = {}): Promise<Rule[]> {
  requireScope(ctx, 'read');
  const s = await ctx.app.schema.get();
  let rows: RuleRow[];
  if (opts.project) {
    const projectId = projectIdOf(s, opts.project)!;
    await assertCanReadProject(ctx, projectId);
    rows = await ctx.db
      .select()
      .from(rules)
      .where(or(eq(rules.projectId, projectId), isNull(rules.projectId)))
      .orderBy(asc(rules.createdAt), asc(rules.id));
  } else {
    const all = await ctx.db.select().from(rules).orderBy(asc(rules.createdAt), asc(rules.id));
    rows = [];
    for (const r of all) if (!r.projectId || (await canReadProject(ctx, r.projectId))) rows.push(r);
  }
  const last = await lastRuns(ctx.db, rows.map((r) => r.id));
  return rows.map((r) => ruleDto(s, r, last.get(r.id)));
}

export async function getRule(ctx: Ctx, id: string): Promise<Rule> {
  requireScope(ctx, 'read');
  const row = await loadRule(ctx, id);
  const s = await ctx.app.schema.get();
  return ruleDto(s, row, (await lastRuns(ctx.db, [row.id])).get(row.id));
}

/** What rules did: a rule's runs, or those in a project, newest first. */
export async function listRuleRuns(ctx: Ctx, opts: { project?: string; rule?: string; limit?: number } = {}): Promise<RuleRun[]> {
  requireScope(ctx, 'read');
  const s = await ctx.app.schema.get();
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const conds: SQL[] = [];
  if (opts.rule) {
    const rule = await loadRule(ctx, opts.rule);
    conds.push(eq(ruleRuns.ruleId, rule.id));
  }
  if (opts.project) {
    const projectId = projectIdOf(s, opts.project)!;
    await assertCanReadProject(ctx, projectId);
    conds.push(eq(ruleRuns.projectId, projectId));
  }
  if (!opts.rule && !opts.project) {
    const visible = await visibleProjectIds(ctx);
    if (visible !== null) conds.push(visible.length ? inArray(ruleRuns.projectId, visible) : sql`FALSE`);
  }
  const rows = await ctx.db
    .select({ run: ruleRuns, name: rules.name })
    .from(ruleRuns)
    .innerJoin(rules, eq(rules.id, ruleRuns.ruleId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(ruleRuns.id))
    .limit(limit);
  return rows.map((r) => runDto(s, r.run, r.name));
}

// ---------------------------------------------------------------------------
// Changing
// ---------------------------------------------------------------------------

async function assertCanManage(ctx: Ctx, projectId: string | null): Promise<void> {
  if (projectId) return assertCanManageProject(ctx, projectId);
  requireScope(ctx, 'write');
  if (!ctx.actor.scopes.includes('admin')) {
    throw forbidden('Only administrators can make or change a rule for every project', 'Make it a rule of one project instead.');
  }
}

function refuseProblems(problems: RuleProblem[]): never {
  throw badRequest(`The rule needs fixing: ${problemText(problems)}`, 'Preview it to see each problem where it is.', { problems });
}

export async function createRule(ctx: Ctx, input: RuleInput): Promise<Rule> {
  requireScope(ctx, 'write');
  const s = await ctx.app.schema.get();
  const d = draftFrom(s, input);
  await assertCanManage(ctx, d.projectId);
  const problems = await ruleProblems(ctx, s, d);
  if (problems.length) refuseProblems(problems);
  const [row] = await ctx.db
    .insert(rules)
    .values({
      id: newId(),
      projectId: d.projectId,
      name: d.name,
      kind: d.kind,
      trigger: d.trigger,
      triggerField: d.field,
      schedule: d.schedule,
      query: d.query,
      command: d.command,
      comment: d.comment,
      requires: d.requires,
      message: d.message,
      enabled: d.enabled,
      nextRunAt: d.schedule && d.enabled ? nextRunAfter(d.schedule, new Date()) : null,
      createdById: ctx.actor.user.id,
      updatedById: ctx.actor.user.id,
    })
    .returning();
  ctx.app.schema.invalidate();
  return ruleDto(await ctx.app.schema.get(), row!, undefined);
}

export type RuleChange = Partial<Omit<RuleInput, 'project' | 'kind'>> & { expectedVersion?: number };

export async function updateRule(ctx: Ctx, id: string, input: RuleChange): Promise<Rule> {
  requireScope(ctx, 'write');
  const row = await loadRule(ctx, id);
  await assertCanManage(ctx, row.projectId);
  if (input.expectedVersion !== undefined && input.expectedVersion !== row.version) {
    throw conflict(`The rule "${row.name}" was changed by someone else`, 'Reload it and make your change again.', { currentVersion: row.version });
  }
  const s = await ctx.app.schema.get();
  const before = draftOf(row);
  const d = tidy({
    ...before,
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.trigger !== undefined ? { trigger: input.trigger } : {}),
    ...(input.field !== undefined ? { field: input.field } : {}),
    ...(input.schedule !== undefined ? { schedule: input.schedule } : {}),
    ...(input.query !== undefined ? { query: input.query } : {}),
    ...(input.command !== undefined ? { command: input.command } : {}),
    ...(input.comment !== undefined ? { comment: input.comment } : {}),
    ...(input.requires !== undefined ? { requires: input.requires } : {}),
    ...(input.message !== undefined ? { message: input.message } : {}),
    ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
  });
  // Turning a rule off, or renaming it, never waits on fixing it: a rule that no longer reads
  // must be easy to stop. What it does, and turning it on, is checked.
  const reworked = (['trigger', 'field', 'schedule', 'query', 'command', 'comment', 'requires'] as const).some((k) => input[k] !== undefined);
  if (reworked || (d.enabled && !before.enabled)) {
    const problems = await ruleProblems(ctx, s, d);
    if (problems.length) refuseProblems(problems);
  } else if (!d.name) {
    refuseProblems([{ part: 'name', message: 'Give it a name that says what it is for', start: 0, end: 0 }]);
  }
  const scheduleMoved = JSON.stringify(d.schedule) !== JSON.stringify(before.schedule) || (d.enabled && !before.enabled);
  const [updated] = await ctx.db
    .update(rules)
    .set({
      name: d.name,
      trigger: d.trigger,
      triggerField: d.field,
      schedule: d.schedule,
      query: d.query,
      command: d.command,
      comment: d.comment,
      requires: d.requires,
      message: d.message,
      enabled: d.enabled,
      ...(scheduleMoved ? { nextRunAt: d.schedule && d.enabled ? nextRunAfter(d.schedule, new Date()) : null } : {}),
      version: sql`${rules.version} + 1`,
      updatedById: ctx.actor.user.id,
      updatedAt: new Date(),
    })
    .where(and(eq(rules.id, row.id), eq(rules.version, row.version)))
    .returning();
  if (!updated) throw conflict(`The rule "${row.name}" was changed by someone else`, 'Reload it and make your change again.');
  ctx.app.schema.invalidate();
  return ruleDto(await ctx.app.schema.get(), updated, (await lastRuns(ctx.db, [updated.id])).get(updated.id));
}

export async function deleteRule(ctx: Ctx, id: string): Promise<void> {
  requireScope(ctx, 'write');
  const row = await loadRule(ctx, id);
  await assertCanManage(ctx, row.projectId);
  await ctx.db.delete(rules).where(eq(rules.id, row.id));
  ctx.app.schema.invalidate();
}

// ---------------------------------------------------------------------------
// Before saving: its problems, the issues it would touch now, and what it would change
// ---------------------------------------------------------------------------

async function visibleScope(ctx: Ctx): Promise<SQL> {
  const visible = await visibleProjectIds(ctx);
  if (visible === null) return sql`TRUE`;
  return visible.length ? inArray(issues.projectId, visible) : sql`FALSE`;
}

/**
 * A rule before it's saved (or as it is): what needs fixing, how many issues match it now, and
 * what its command would change on a few of them, through the command executor's dry run.
 */
export async function previewRule(ctx: Ctx, input: RuleInput): Promise<RulePreview> {
  requireScope(ctx, 'read');
  const s = await ctx.app.schema.get();
  const d = draftFrom(s, input);
  if (d.projectId) await assertCanReadProject(ctx, d.projectId);
  const problems = await ruleProblems(ctx, s, d);
  const sentence = ruleSentence(d);
  const empty = { matching: 0, breaking: null, sample: [] };
  if (problems.some((p) => p.part === 'query' || p.part === 'requires')) {
    return { ok: false, problems, sentence, ...empty, note: 'Fix what is underlined to see the issues it would touch.' };
  }
  const me = ctx.actor.user.id;
  const when = condition(s, d.query, { meId: me, projectId: d.projectId });
  const scope = await visibleScope(ctx);
  const where = when.where ? and(scope, when.where)! : scope;
  const count = async (w: SQL) => Number((await ctx.db.select({ n: sql<number>`count(*)::int` }).from(issues).where(w))[0]?.n ?? 0);
  const matching = await count(where);
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

  if (d.kind === 'guard') {
    const requires = condition(s, d.requires ?? '', { meId: me });
    const breakingWhere = requires.where ? and(where, sql`NOT ${requires.where}`)! : sql`FALSE`;
    const breaking = await count(breakingWhere);
    const rows = await ctx.db.select().from(issues).where(breakingWhere).orderBy(desc(issues.updatedAt), asc(issues.id)).limit(PREVIEW_SAMPLE);
    const refs = await issueRefsById(ctx.db, s, rows.map((r) => r.id));
    return {
      ok: problems.length === 0,
      problems,
      sentence,
      matching,
      breaking,
      sample: rows.map((r) => ({ issue: refs.get(r.id)!, changes: [], errors: [`Already breaks it: it matches “${d.query}” but not “${d.requires}”`] })),
      note: breaking
        ? `${plural(matching, 'issue matches', 'issues match')} “${d.query}” now, and ${plural(breaking, 'of them breaks', 'of them break')} the rule: they were changed before it. It doesn't change them; it refuses only a change that makes an issue break it.`
        : `${plural(matching, 'issue matches', 'issues match')} “${d.query}” now, and all of them keep the rule. From now on it refuses a change that would make an issue break it.`,
    };
  }

  const rows = await ctx.db.select().from(issues).where(where).orderBy(desc(issues.updatedAt), asc(issues.id)).limit(PREVIEW_SAMPLE);
  const refs = await issueRefsById(ctx.db, s, rows.map((r) => r.id));
  let sample: RulePreview['sample'] = rows.map((r) => ({ issue: refs.get(r.id)!, changes: [], errors: [] }));
  if (rows.length && !problems.some((p) => p.part === 'command')) {
    // Exactly what it would do: the executor's dry run, as the workflow agent, with "me" as you.
    const bot = s.usersByLogin.get(WORKFLOW_BOT);
    if (bot) {
      const dry = await runCommand(adminCtx(ctx.app, bot, 'automation'), {
        issues: rows.map((r) => r.id),
        command: d.command,
        comment: d.comment ?? undefined,
        dryRun: true,
        meId: me,
      });
      const byId = new Map(dry.results.map((r) => [r.issue, r]));
      sample = sample.map((x) => {
        const r = byId.get(x.issue.id);
        return r ? { issue: x.issue, changes: r.changes, errors: r.errors } : x;
      });
    }
  }
  const acts = d.kind === 'change' ? `It acts on one only when ${triggerWords(d.trigger, d.field)}.` : `${scheduleWords(d.schedule)}, each of them gets the command.`;
  const shown = sample.length ? ` Here is what it would change on ${sample.length} of them, as they are now.` : '';
  return {
    ok: problems.length === 0,
    problems,
    sentence,
    matching,
    breaking: null,
    sample,
    note: `${plural(matching, 'issue matches', 'issues match')} it now. ${acts}${shown}`,
  };
}

/** Live problems, a reading and suggestions for one part of a rule as it's typed, as the command bar has them. */
export async function checkRulePart(
  ctx: Ctx,
  body: { project: string | null; kind: RuleKind; part: 'query' | 'requires' | 'command'; text: string; caret?: number },
): Promise<{ problems: QueryProblem[]; description: string; suggestions: SuggestItem[] }> {
  requireScope(ctx, 'read');
  const s = await ctx.app.schema.get();
  const projectId = projectIdOf(s, body.project);
  if (projectId) await assertCanReadProject(ctx, projectId);
  const caret = Math.min(body.caret ?? body.text.length, body.text.length);
  const scheduled = body.kind === 'schedule';
  if (body.part === 'command') {
    const projectIds = projectId ? [projectId] : [...s.projects.keys()];
    const parsed = parseCommand(body.text, s, projectIds);
    return {
      problems: [...(scheduled ? meProblems(body.text) : []), ...parsed.problems].sort((a, b) => a.start - b.start),
      description: describeCommand(parsed.ops),
      suggestions: suggestCommand(body.text, caret, s, projectIds),
    };
  }
  const p = parsedQuery(s, body.text);
  const compiled = compileQuery(p, { s, meId: ctx.actor.user.id });
  return {
    problems: [...(scheduled ? meProblems(body.text) : []), ...compiled.problems].sort((a, b) => a.start - b.start),
    description: explainParsed(p),
    suggestions: suggest(s, body.text, caret),
  };
}

/** Runs older than this are forgotten. */
export const RUN_LOG_DAYS = 30;

export async function pruneRuleRuns(db: Db, now = new Date()): Promise<void> {
  await db.delete(ruleRuns).where(lt(ruleRuns.createdAt, new Date(now.getTime() - RUN_LOG_DAYS * 86_400_000)));
}
