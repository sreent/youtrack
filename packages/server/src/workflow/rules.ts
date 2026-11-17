/**
 * Workflow rules, as people manage them: made, changed, turned off, previewed, and their run log.
 * The engine that applies them is ./engine.ts; the guards on the write path are ./guards.ts.
 *
 * A rule is project-scoped (its query only ever matches its project's issues), or global, for
 * every project, which only administrators manage. Managing a project's rules needs its manager
 * or an administrator (services/access.ts); reading them needs only to read the project. A rule of
 * a project someone can't see answers as one that doesn't exist, and a project's rule reads only
 * its own project's names (match.ts, ruleWorld), so nothing in it can probe another.
 */
import {
  type ScriptRun,
  RULE_MATCH,
  RULE_RELATIONS,
  RULE_TARGETS,
  RULE_TELL,
  RULE_TRIGGERS,
  type Change,
  type QueryProblem,
  type Rule,
  type RuleInput,
  type RuleKind,
  type RuleNotify,
  type RulePreview,
  type RuleProblem,
  type RuleRelated,
  type RuleRun,
  type RuleSchedule,
  type RuleTarget,
  type RuleTrigger,
  type SuggestItem,
} from '@a4a/shared';
import { and, asc, desc, eq, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import { adminCtx } from '../app-services';
import { runCommand } from '../commands/executor';
import { describeCommand, parseCommand, suggestCommand } from '../commands/parser';
import { requireScope, type AppServices, type Ctx, type UserRow } from '../context';
import type { Db } from '../db/client';
import { WORKFLOW_BOT } from '../db/defaults';
import { issues, ruleRuns, rules, webhooks } from '../db/schema';
import { callableUrl, webhookOrigin } from '../events/webhooks';
import { AppError, badRequest, conflict, errorWords, forbidden, keyedProblem, noted, notFound, saidProblems, wordsOf } from '../lib/errors';
import { translatorFor } from '../i18n';
import { newId } from '../lib/ids';
import { compileQuery } from '../search/compiler';
import { explainParsed } from '../search/explain';
import { lex } from '../search/lexer';
import { suggest } from '../search/suggest';
import {
  assertCanManageProject,
  canReadProject,
  goneIssueSql,
  issueSeenSql,
  projectAccess,
  requireProject,
  scopeFields,
  touchesNoHiddenSql,
  visibleProjectIds,
  visibleSchema,
  type ProjectNeed,
} from '../services/access';
import { issueRefsById } from '../services/issue-refs';
import { findVisibleIssue } from '../services/issues';
import type { RuleRow, SchemaSnapshot } from '../services/schema-cache';
import { resolveFieldInput, userRefDto } from '../services/values';
import { aggregationTypeIds, condition, parsedQuery, relatedSql, ruleWorld, rulePhrase, rulePhrases, targetIssues, type RelatedCondition } from './match';
import { assertCanScript } from './actions';
import { checkScript, SCRIPT_LIMITS } from './sandbox';
import { changeOf, type ScriptChange } from './script-issue';
import { dryRunScript } from './scripts';
import { recipientsFor, seeingProject, tidyLogins } from './tell';
import { DEFAULT_AT, nextRunAfter, ruleSentence, scheduleWords, targetWords, triggerWords } from './words';

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
  /** A further condition, on issues related to the one it acts for. */
  related: RuleRelated | null;
  /** The issues it acts on; null: the issue itself. */
  target: RuleTarget | null;
  notify: RuleNotify | null;
  /** The webhook it calls, if any. */
  callWebhookId: string | null;
  /** A scripted rule's JavaScript (D40): it runs in place of the command, or of what a guard requires. */
  script: string | null;
  enabled: boolean;
}

/**
 * The workflow agent, as it acts on an issue of `projectId`: with administrator scopes, as triage's
 * agent has, but in that project only, members only or not (engine.ts, "Reach").
 */
export function botCtx(app: AppServices, bot: UserRow, projectId: string): Ctx {
  const ctx = adminCtx(app, bot, 'automation');
  ctx.actor.projectIds = [projectId];
  return ctx;
}

/** Fields an "updated" rule can wait for besides the project's own. */
const BUILT_IN_FIELDS = ['Summary', 'Description', 'Tags'];
const PREVIEW_SAMPLE = 5;

/** What went wrong for an issue in a preview, as a page says it (D49): a problem's key and values. */
type Words = NonNullable<RulePreview['sample'][number]['errorWords']>[number];

const trimmed = (v: string | null | undefined): string | null => {
  const t = v?.trim();
  return t ? t : null;
};

const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === 'string' && (list as readonly string[]).includes(v);

/** The stored parts, read back as they were checked when they were saved. */
function relatedOf(v: unknown): RuleRelated | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  if (!oneOf(RULE_RELATIONS, r.of) || typeof r.query !== 'string') return null;
  return { of: r.of, phrase: typeof r.phrase === 'string' ? r.phrase : null, match: oneOf(RULE_MATCH, r.match) ? r.match : 'all', query: r.query };
}

function targetOf(v: unknown): RuleTarget | null {
  if (!v || typeof v !== 'object') return null;
  const t = v as Record<string, unknown>;
  if (!oneOf(RULE_TARGETS, t.to) || t.to === 'issue') return null;
  return { to: t.to, phrase: typeof t.phrase === 'string' ? t.phrase : null };
}

function notifyOf(v: unknown): RuleNotify | null {
  if (!v || typeof v !== 'object') return null;
  const n = v as Record<string, unknown>;
  if (typeof n.message !== 'string') return null;
  const to = Array.isArray(n.to) ? n.to.filter((x): x is RuleNotify['to'][number] => oneOf(RULE_TELL, x)) : [];
  const people = Array.isArray(n.people) ? n.people.filter((x): x is string => typeof x === 'string') : [];
  return { to, people, message: n.message };
}

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
    related: relatedOf(row.related),
    target: targetOf(row.target),
    notify: notifyOf(row.notify),
    callWebhookId: row.callWebhookId,
    script: row.script ?? null,
    enabled: row.enabled,
  };
}

/** Only the parts that belong to the rule's kind, tidied. */
function tidy(d: Draft): Draft {
  const acts = d.kind !== 'guard';
  const script = d.script?.trim() ? d.script : null;
  // A script reads related issues and changes them itself: a scripted rule has no further condition
  // on them, nor a target, nor a command of its own.
  const r = acts && !script ? d.related : null;
  const t = acts && !script && d.target && d.target.to !== 'issue' ? d.target : null;
  const n = acts ? d.notify : null;
  return {
    ...d,
    name: d.name.trim(),
    trigger: d.kind === 'change' ? d.trigger : null,
    field: d.kind === 'change' && d.trigger === 'updated' ? trimmed(d.field) : null,
    schedule: d.kind === 'schedule' && d.schedule ? { every: d.schedule.every, ...(d.schedule.every === 'hour' ? {} : { at: d.schedule.at ?? DEFAULT_AT }) } : null,
    query: d.query.trim(),
    command: d.kind === 'guard' || script ? '' : d.command.trim(),
    comment: d.kind === 'guard' || script ? null : trimmed(d.comment),
    requires: d.kind === 'guard' && !script ? trimmed(d.requires) : null,
    message: d.kind === 'guard' && !script ? trimmed(d.message) : null,
    script,
    // A parent is one issue: it matches or it doesn't.
    related: r ? { of: r.of, phrase: r.of === 'linked' ? trimmed(r.phrase) : null, match: r.of === 'parent' ? 'any' : (r.match ?? 'all'), query: r.query.trim() } : null,
    target: t ? { to: t.to, phrase: t.to === 'linked' ? trimmed(t.phrase) : null } : null,
    notify: n ? { to: RULE_TELL.filter((k) => n.to.includes(k)), people: tidyLogins(n.people), message: n.message.trim() } : null,
    callWebhookId: acts ? d.callWebhookId : null,
  };
}

/** A rule's project, by key, if the caller may do `need` in it: one they can't see answers as one that doesn't exist. */
async function projectIdOf(ctx: Ctx, key: string | null | undefined, need: ProjectNeed = 'read'): Promise<string | null> {
  return key ? (await requireProject(ctx, key, need)).id : null;
}

/**
 * The tracker as a rule reads it, for someone checking or reading it: a project's rule reads its
 * own project (which they can see); a rule for every project, the projects they can see.
 */
async function worldFor(ctx: Ctx, projectId: string | null): Promise<SchemaSnapshot> {
  // Without the private fields kept from them (D50): a rule's words are theirs to read.
  return projectId ? scopeFields(ruleWorld(await ctx.app.schema.get(), projectId), await projectAccess(ctx)) : visibleSchema(ctx);
}

function draftFrom(projectId: string | null, input: RuleInput): Draft {
  return tidy({
    projectId,
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
    related: input.related ? { of: input.related.of, phrase: input.related.phrase ?? null, match: input.related.match ?? 'all', query: input.related.query } : null,
    target: input.target ? { to: input.target.to ?? 'issue', phrase: input.target.phrase ?? null } : null,
    notify: input.notify ? { to: input.notify.to ?? [], people: input.notify.people ?? [], message: input.notify.message } : null,
    callWebhookId: input.call?.webhook ?? null,
    script: input.script ?? null,
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
    .map((t) => keyedProblem({ message: 'A scheduled rule runs on its own, so "me" stands for nobody', start: t.start, end: t.end, hint: 'Name the person instead, e.g. anna.' }, 'rule.meInSchedule'));
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
  if (!d.name.trim()) add('name', [keyedProblem({ message: 'Give it a name that says what it is for', ...whole('') }, 'rule.nameForPurpose')]);
  if (d.kind === 'change') {
    if (!d.trigger || !RULE_TRIGGERS.includes(d.trigger)) {
      add('trigger', [keyedProblem({ message: 'Say what sets it off: an issue is created, changes, or gets a comment', ...whole('') }, 'rule.sayTrigger')]);
    }
    if (d.field) {
      const known = new Set([...BUILT_IN_FIELDS.map((f) => f.toLowerCase())]);
      for (const pid of projectIdsFor(s, d)) for (const pf of s.projectFields.get(pid) ?? []) known.add(s.fields.get(pf.fieldId)?.name.toLowerCase() ?? '');
      if (!known.has(d.field.toLowerCase())) {
        add('field', [keyedProblem({ message: `There is no field "${d.field}" here`, hint: 'Name a field of the project, such as State or Priority.', ...whole(d.field) }, 'rule.noField', { field: d.field })]);
      }
    }
  }
  if (d.kind === 'schedule' && !d.schedule) add('schedule', [keyedProblem({ message: 'Say how often it runs: every hour, every day or every weekday', ...whole('') }, 'rule.saySchedule')]);
  if (d.kind === 'guard' && !d.script) {
    if (!d.query) add('query', [keyedProblem({ message: 'Say which changes it checks: what they would make an issue match', hint: "e.g. State: {Won't fix}", ...whole('') }, 'rule.sayGuardQuery')]);
    if (!d.requires) add('requires', [keyedProblem({ message: 'Say what such an issue must also match', hint: 'e.g. has: comments', ...whole('') }, 'rule.sayGuardRequires')]);
  }
  if (d.query) add('query', queryProblems(s, d, d.query));
  if (d.kind === 'guard' && d.requires) add('requires', queryProblems(s, d, d.requires));
  if (d.kind !== 'guard') {
    if (!d.script && !d.command && !d.comment && !d.notify && !d.callWebhookId) {
      add('command', [keyedProblem({ message: 'Say what it does: a change to make, a comment to post, whom to tell, or a webhook to call', hint: 'e.g. tag urgent', ...whole('') }, 'rule.sayWhatItDoes')]);
    }
    if (d.command) {
      const parsed = parseCommand(d.command, s, projectIdsFor(s, d));
      add('command', d.kind === 'schedule' ? [...meProblems(d.command), ...parsed.problems] : parsed.problems);
    }
    if (d.related) add('related', relatedProblems(s, d, d.related));
    if (d.target) add('target', linkProblems(s, d.target.to, d.target.phrase));
    if (d.notify) add('notify', notifyProblems(s, d.notify));
  }
  return out;
}

/** A link phrase a rule follows, or what's wrong with it; and that subtask links exist for a parent and subtasks. */
function linkProblems(s: SchemaSnapshot, of: RuleRelated['of'] | RuleTarget['to'], phrase: string | null | undefined): QueryProblem[] {
  if (of === 'issue') return [];
  if (of !== 'linked') {
    return aggregationTypeIds(s).length
      ? []
      : [keyedProblem({ message: 'There is no subtask link here, so no issue has a parent or subtasks', hint: 'Add a link type that makes subtasks, or follow another link.', ...whole('') }, 'rule.noSubtaskLink')];
  }
  const text = phrase?.trim() ?? '';
  if (!text) {
    const example = rulePhrases(s)[0] ?? 'depends on';
    return [keyedProblem({ message: 'Say which link: how it reads from the issue', hint: `e.g. ${example}`, ...whole('') }, 'rule.sayWhichLink', { phrase: example })];
  }
  if (rulePhrase(s, text)) return [];
  const sub = s.linkPhrases.find((x) => x.phrase === text.toLowerCase() && x.type.aggregation);
  if (sub) {
    const inward = sub.direction === 'inward';
    return [keyedProblem({ message: `“${text}” is a subtask link`, hint: inward ? 'Say “its parent” instead.' : 'Say “its subtasks” instead.', ...whole(text) }, inward ? 'rule.subtaskLinkParent' : 'rule.subtaskLinkSubtasks', { phrase: text })];
  }
  return [keyedProblem({ message: `There is no link “${text}” here`, hint: `Say one of: ${rulePhrases(s).join(', ')}.`, ...whole(text) }, 'rule.noLink', { phrase: text, phrases: rulePhrases(s).join(', ') })];
}

function relatedProblems(s: SchemaSnapshot, d: Draft, r: RuleRelated): QueryProblem[] {
  const out = linkProblems(s, r.of, r.phrase);
  if (!r.query.trim()) out.push(keyedProblem({ message: 'Say what they must match', hint: 'e.g. #Resolved', ...whole('') }, 'rule.sayRelatedQuery'));
  else out.push(...queryProblems(s, d, r.query));
  return out;
}

function notifyProblems(s: SchemaSnapshot, n: RuleNotify): QueryProblem[] {
  const out: QueryProblem[] = [];
  if (!n.to.length && !n.people.length) {
    out.push(keyedProblem({ message: "Say whom it tells: its assignee, its reporter, its watchers, the project's managers, or people by name", ...whole('') }, 'rule.sayWhom'));
  }
  if (!n.message.trim()) out.push(keyedProblem({ message: "Say what they're told", ...whole('') }, 'rule.sayMessage'));
  for (const login of n.people) {
    const u = s.usersByLogin.get(login.toLowerCase());
    if (!u) out.push(keyedProblem({ message: `There is no one called “${login}”`, hint: 'Name someone by their login, e.g. anna.', ...whole(login) }, 'rule.noOneCalled', { login }));
    else if (u.isBot) out.push(keyedProblem({ message: `${u.name} is an agent, and agents aren't told`, hint: 'Name a person.', ...whole(login) }, 'rule.agentNotTold', { name: u.name }));
  }
  return out;
}

/** What stops a rule from calling its webhook: only administrators make such rules, and only https webhooks are called. */
async function callProblems(ctx: Ctx, webhookId: string): Promise<RuleProblem[]> {
  if (!ctx.actor.scopes.includes('admin')) {
    return [keyedProblem({ part: 'call', message: 'Only administrators can make a rule call a webhook', hint: 'Tell people instead, or ask an administrator.', ...whole('') }, 'rule.callAdminOnly')];
  }
  const [hook] = await ctx.db.select({ url: webhooks.url }).from(webhooks).where(eq(webhooks.id, webhookId));
  if (!hook) return [keyedProblem({ part: 'call', message: 'There is no such webhook', hint: 'Choose one on the Webhooks page.', ...whole('') }, 'rule.noSuchWebhook')];
  if (!callableUrl(hook.url)) {
    return [keyedProblem({ part: 'call', message: "Its webhook's address isn't https", hint: 'A rule calls only https webhooks, or one on this machine.', ...whole('') }, 'rule.webhookNotHttps')];
  }
  return [];
}

/**
 * Everything that must be fixed before the rule is saved: what doesn't read, and what its command
 * names that the person making it can't use (an issue they can't see, a value the project lacks).
 * `s` is the tracker as the rule reads it (worldFor).
 */
export async function ruleProblems(ctx: Ctx, s: SchemaSnapshot, d: Draft): Promise<RuleProblem[]> {
  const out = readingProblems(s, d);
  if (d.script) for (const p of await checkScript(d.script)) out.push({ part: 'script', message: p.message, start: p.start, end: p.end, ...(p.hint ? { hint: p.hint } : {}), ...wordsOf(p) });
  if (d.kind !== 'guard' && d.callWebhookId) out.push(...(await callProblems(ctx, d.callWebhookId)));
  // A project's rule tells only people who can see the project: naming someone who can't is a mistake to say now.
  if (d.kind !== 'guard' && d.notify?.people.length && d.projectId) {
    const named = d.notify.people.map((l) => s.usersByLogin.get(l.toLowerCase())).filter((u): u is UserRow => Boolean(u && !u.isBot));
    const seeing = await seeingProject(ctx.db, d.projectId, named.map((u) => u.id));
    const key = s.projects.get(d.projectId)?.key ?? 'the project';
    for (const u of named) {
      if (!seeing.has(u.id)) {
        out.push(
          keyedProblem(
            { part: 'notify', message: `${u.name} can't see ${key}, so the rule could never tell them`, hint: 'Name someone who can see it, or tell its watchers.', ...whole(u.login) },
            'rule.cantSeeProject',
            { name: u.name, project: key },
          ),
        );
      }
    }
  }
  if (d.kind === 'guard' || !d.command || out.some((p) => p.part === 'command')) return out;
  const parsed = parseCommand(d.command, s, projectIdsFor(s, d));
  for (const op of parsed.ops) {
    if (op.kind === 'link') {
      for (const t of op.targets) {
        const target = await findVisibleIssue(ctx, t);
        if (!target) {
          out.push(keyedProblem({ part: 'command', message: `There is no issue ${t}, or you can't see it`, ...whole(d.command) }, 'rule.noIssue', { id: t }));
          continue;
        }
        // The workflow agent reaches only the project of the issue it acts on (engine.ts), and a
        // link changes both issues, so a rule links only within one project.
        if (target.projectId === d.projectId) continue;
        const theirs = (await ctx.app.schema.get()).projects.get(target.projectId)?.key ?? 'another project';
        const mine = d.projectId ? (s.projects.get(d.projectId)?.key ?? 'its project') : null;
        out.push(
          mine
            ? keyedProblem(
                { part: 'command', message: `${t} is in ${theirs}, and a rule of ${mine} changes only ${mine}'s issues`, hint: `Link to an issue of ${mine}: a link changes both issues.`, ...whole(d.command) },
                'rule.linkOtherProject',
                { id: t, theirs, mine },
              )
            : keyedProblem(
                { part: 'command', message: `A rule for every project can't link to ${t}: it would change ${theirs} from every other project`, hint: `Make it a rule of ${theirs}.`, ...whole(d.command) },
                'rule.linkFromEveryProject',
                { id: t, theirs },
              ),
        );
      }
    }
    // Values are resolved per project when it runs; a project rule's can be checked now.
    if (op.kind === 'field' && d.projectId) {
      for (const raw of op.raw) {
        try {
          resolveFieldInput(s, op.field, d.projectId, raw, ctx.actor.user.id);
        } catch (e) {
          if (!(e instanceof AppError)) throw e;
          out.push({ part: 'command', message: e.message, ...(e.hint ? { hint: e.hint } : {}), ...whole(d.command), ...wordsOf(e) });
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
    said: row.said ?? null,
    changes: (row.changes as Change[] | null) ?? [],
    by: by ? userRefDto(by) : null,
    at: row.createdAt.toISOString(),
  };
}

/**
 * A rule as a reader sees it. `seen` is the tracker as they see it: a rule for every project is
 * read over it, so what it says is wrong with the rule names nothing they can't see.
 */
export function ruleDto(s: SchemaSnapshot, seen: SchemaSnapshot, row: RuleRow, lastRun: RunRow | undefined, origins: Map<string, string | null> = new Map()): Rule {
  const d = draftOf(row);
  const by = row.createdById ? s.users.get(row.createdById) : undefined;
  const callOrigin = row.callWebhookId ? (origins.get(row.callWebhookId) ?? null) : null;
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
    related: d.related,
    target: d.target ?? { to: 'issue', phrase: null },
    notify: d.notify,
    call: row.callWebhookId ? { webhook: row.callWebhookId, origin: callOrigin } : null,
    script: row.script ?? null,
    enabled: row.enabled,
    sentence: ruleSentence({ ...d, callOrigin, calls: Boolean(row.callWebhookId) }),
    problems: readingProblems(row.projectId ? ruleWorld(s, row.projectId) : seen, d),
    nextRunAt: row.kind === 'schedule' && row.enabled ? (row.nextRunAt?.toISOString() ?? null) : null,
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
    lastRun: lastRun ? runDto(s, lastRun, row.name) : null,
    version: row.version,
    createdBy: by ? userRefDto(by) : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * The runs a reader may see: those in projects they can read, through the access seam. A rule for
 * every project runs in all of them, and its runs name their issues. What such a rule writes for no
 * one project (how a scheduled run went everywhere, that it no longer reads) counts and names
 * things in every project, so only those who see every project see it. A run names its issue and
 * what it changed there, so one on an issue limited away from the reader isn't theirs (D37).
 */
async function visibleRuns(ctx: Ctx): Promise<SQL | null> {
  const visible = await visibleProjectIds(ctx);
  const view = await projectAccess(ctx);
  const s = await ctx.app.schema.get();
  // A run that changed a private field kept from the reader isn't in their log: its words say the change (D50).
  const kept = touchesNoHiddenSql(view, s, sql`${ruleRuns.projectId}`, sql`${ruleRuns.changes}`);
  // Nor one on an issue limited away from them: standing, by its row; deleted, by what its deletion kept.
  const seen = issueSeenSql(view, s, 'seen_run');
  const gone = goneIssueSql(view, sql`${ruleRuns.issueKey}`, sql`${ruleRuns.projectId}`);
  const parts: SQL[] = [
    ...(kept ? [kept] : []),
    ...(seen ? [sql`NOT EXISTS (SELECT 1 FROM issues seen_run WHERE seen_run.id = ${ruleRuns.issueId} AND NOT ${seen})`] : []),
    ...(gone ? [sql`NOT (${ruleRuns.issueId} IS NULL AND ${gone})`] : []),
  ];
  if (visible !== null) parts.unshift(visible.length ? inArray(ruleRuns.projectId, visible) : sql`FALSE`);
  return parts.length ? sql`(${sql.join(parts, sql` AND `)})` : null;
}

async function lastRuns(ctx: Ctx, ids: string[]): Promise<Map<string, RunRow>> {
  if (!ids.length) return new Map();
  const seen = await visibleRuns(ctx);
  const res = await ctx.db.execute(sql`
    SELECT DISTINCT ON (rule_id) id FROM rule_runs
    WHERE rule_id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)}) ${seen ? sql`AND ${seen}` : sql``}
    ORDER BY rule_id, id DESC`);
  const runIds = (res as unknown as { rows: { id: number | string }[] }).rows.map((r) => Number(r.id));
  if (!runIds.length) return new Map();
  const rows = await ctx.db.select().from(ruleRuns).where(inArray(ruleRuns.id, runIds));
  return new Map(rows.map((r) => [r.ruleId, r]));
}

/** Where the webhooks some rules call are (https://host), by id: what a rule's sentence says of its call. */
async function webhookOrigins(db: Db, rows: RuleRow[]): Promise<Map<string, string | null>> {
  const ids = [...new Set(rows.map((r) => r.callWebhookId).filter((id): id is string => Boolean(id)))];
  if (!ids.length) return new Map();
  const hooks = await db.select({ id: webhooks.id, url: webhooks.url }).from(webhooks).where(inArray(webhooks.id, ids));
  return new Map(hooks.map((h) => [h.id, webhookOrigin(h.url)]));
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

async function loadRule(ctx: Ctx, id: string): Promise<RuleRow> {
  requireScope(ctx, 'read');
  const [row] = await ctx.db.select().from(rules).where(eq(rules.id, id));
  // A rule of a project the caller can't see answers as one that doesn't exist.
  if (!row || (row.projectId && !(await canReadProject(ctx, row.projectId)))) throw notFound('Rule').said('workflow.ruleNotFound');
  return row;
}

/** Rules that apply in a project (its own and the global ones), or every rule you can see. */
export async function listRules(ctx: Ctx, opts: { project?: string } = {}): Promise<Rule[]> {
  requireScope(ctx, 'read');
  const s = await ctx.app.schema.get();
  let rows: RuleRow[];
  if (opts.project) {
    const projectId = (await projectIdOf(ctx, opts.project))!;
    rows = await ctx.db
      .select()
      .from(rules)
      .where(or(eq(rules.projectId, projectId), isNull(rules.projectId)))
      .orderBy(asc(rules.createdAt), asc(rules.id));
  } else {
    const view = await projectAccess(ctx);
    const all = await ctx.db.select().from(rules).orderBy(asc(rules.createdAt), asc(rules.id));
    rows = all.filter((r) => !r.projectId || view.canRead(r.projectId));
  }
  const last = await lastRuns(ctx, rows.map((r) => r.id));
  const seen = await visibleSchema(ctx);
  const origins = await webhookOrigins(ctx.db, rows);
  return rows.map((r) => ruleDto(s, seen, r, last.get(r.id), origins));
}

export async function getRule(ctx: Ctx, id: string): Promise<Rule> {
  const row = await loadRule(ctx, id);
  return ruleDto(await ctx.app.schema.get(), await visibleSchema(ctx), row, (await lastRuns(ctx, [row.id])).get(row.id), await webhookOrigins(ctx.db, [row]));
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
  if (opts.project) conds.push(eq(ruleRuns.projectId, (await projectIdOf(ctx, opts.project))!));
  const seen = await visibleRuns(ctx);
  if (seen) conds.push(seen);
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
    throw forbidden('Only administrators can make or change a rule for every project', 'Make it a rule of one project instead.').said('workflow.globalRuleAdminOnly');
  }
  // A rule for every project reaches all of them, so a token limited to some can't make one.
  if ((await visibleProjectIds(ctx)) !== null) {
    throw forbidden('A rule for every project reaches every project, and this token reaches only some', 'Make it a rule of one project, or use a token for every project.').said('workflow.globalRuleTokenScope');
  }
}

/**
 * A rule that calls a webhook sends what it knows of issues to an address an administrator chose,
 * on its own, every time it acts: making, changing or deleting one is theirs. A project's manager
 * can still turn it off.
 */
function assertCanCall(ctx: Ctx): void {
  if (!ctx.actor.scopes.includes('admin')) {
    throw forbidden('Only administrators can make, change or delete a rule that calls a webhook', 'Turn it off instead, or ask an administrator.').said('workflow.webhookRuleAdminOnly');
  }
}

function refuseProblems(problems: RuleProblem[]): never {
  throw badRequest(`The rule needs fixing: ${problemText(problems)}`, 'Preview it to see each problem where it is.', { problems }).said('workflow.ruleNeedsFixing', { problems: saidProblems(problems) });
}

export async function createRule(ctx: Ctx, input: RuleInput): Promise<Rule> {
  requireScope(ctx, 'write');
  const d = draftFrom(await projectIdOf(ctx, input.project, 'manage'), input);
  await assertCanManage(ctx, d.projectId);
  if (d.callWebhookId) assertCanCall(ctx);
  if (d.script) assertCanScript(ctx, 'rule');
  const problems = await ruleProblems(ctx, await worldFor(ctx, d.projectId), d);
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
      related: d.related,
      target: d.target,
      notify: d.notify,
      callWebhookId: d.callWebhookId,
      script: d.script,
      enabled: d.enabled,
      nextRunAt: d.schedule && d.enabled ? nextRunAfter(d.schedule, new Date()) : null,
      createdById: ctx.actor.user.id,
      updatedById: ctx.actor.user.id,
    })
    .returning();
  ctx.app.schema.invalidate();
  return ruleDto(await ctx.app.schema.get(), await visibleSchema(ctx), row!, undefined, await webhookOrigins(ctx.db, [row!]));
}

export type RuleChange = Partial<Omit<RuleInput, 'project' | 'kind'>> & { expectedVersion?: number };

/** A rule an app installed changes and goes with its app (D48): only turning it off and on is anyone else's. */
function assertNotAppRule(row: RuleRow, input?: RuleChange): void {
  if (!row.appId) return;
  if (input && Object.keys(input).every((k) => k === 'enabled' || k === 'expectedVersion')) return;
  throw badRequest(`“${row.name}” came with an app: it changes with the app`, 'Update or remove the app under Administration → Apps; you can turn the rule off here.').said('workflow.ruleFromApp', { rule: row.name });
}

export async function updateRule(ctx: Ctx, id: string, input: RuleChange): Promise<Rule> {
  requireScope(ctx, 'write');
  const row = await loadRule(ctx, id);
  assertNotAppRule(row, input);
  await assertCanManage(ctx, row.projectId);
  if (input.expectedVersion !== undefined && input.expectedVersion !== row.version) {
    throw conflict(`The rule "${row.name}" was changed by someone else`, 'Reload it and make your change again.', { currentVersion: row.version }).said('workflow.ruleChangedMeanwhile', { rule: row.name });
  }
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
    ...(input.related !== undefined
      ? { related: input.related ? { of: input.related.of, phrase: input.related.phrase ?? null, match: input.related.match ?? 'all', query: input.related.query } : null }
      : {}),
    ...(input.target !== undefined ? { target: input.target ? { to: input.target.to ?? 'issue', phrase: input.target.phrase ?? null } : null } : {}),
    ...(input.notify !== undefined
      ? { notify: input.notify ? { to: input.notify.to ?? [], people: input.notify.people ?? [], message: input.notify.message } : null }
      : {}),
    ...(input.call !== undefined ? { callWebhookId: input.call?.webhook ?? null } : {}),
    ...(input.script !== undefined ? { script: input.script ?? null } : {}),
    ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
  });
  // Turning off a rule that calls a webhook is anyone's who manages it; anything else about one is an administrator's.
  const onlyTurningOff = input.enabled === false && Object.keys(input).every((k) => k === 'enabled' || k === 'expectedVersion');
  if ((before.callWebhookId || d.callWebhookId) && !onlyTurningOff) assertCanCall(ctx);
  // So it is with a script: code that runs on every change it is set off by is an administrator's.
  if ((before.script || d.script) && !onlyTurningOff) assertCanScript(ctx, 'rule');
  // Turning a rule off, or renaming it, never waits on fixing it: a rule that no longer reads
  // must be easy to stop. What it does, and turning it on, is checked.
  const reworked = (['trigger', 'field', 'schedule', 'query', 'command', 'comment', 'requires', 'related', 'target', 'notify', 'call', 'script'] as const).some(
    (k) => input[k] !== undefined,
  );
  if (reworked || (d.enabled && !before.enabled)) {
    const problems = await ruleProblems(ctx, await worldFor(ctx, d.projectId), d);
    if (problems.length) refuseProblems(problems);
  } else if (!d.name) {
    refuseProblems([keyedProblem({ part: 'name', message: 'Give it a name that says what it is for', start: 0, end: 0 }, 'rule.nameForPurpose')]);
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
      related: d.related,
      target: d.target,
      notify: d.notify,
      callWebhookId: d.callWebhookId,
      script: d.script,
      enabled: d.enabled,
      ...(scheduleMoved ? { nextRunAt: d.schedule && d.enabled ? nextRunAfter(d.schedule, new Date()) : null } : {}),
      version: sql`${rules.version} + 1`,
      updatedById: ctx.actor.user.id,
      updatedAt: new Date(),
    })
    .where(and(eq(rules.id, row.id), eq(rules.version, row.version)))
    .returning();
  if (!updated) throw conflict(`The rule "${row.name}" was changed by someone else`, 'Reload it and make your change again.').said('workflow.ruleChangedMeanwhile', { rule: row.name });
  ctx.app.schema.invalidate();
  return ruleDto(await ctx.app.schema.get(), await visibleSchema(ctx), updated, (await lastRuns(ctx, [updated.id])).get(updated.id), await webhookOrigins(ctx.db, [updated]));
}

export async function deleteRule(ctx: Ctx, id: string): Promise<void> {
  requireScope(ctx, 'write');
  const row = await loadRule(ctx, id);
  assertNotAppRule(row);
  await assertCanManage(ctx, row.projectId);
  if (row.callWebhookId) assertCanCall(ctx);
  if (row.script) assertCanScript(ctx, 'rule');
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
  const d = draftFrom(await projectIdOf(ctx, input.project), input);
  // A rule for every project is previewed over the projects the caller can see, and counts only their issues.
  const s = await worldFor(ctx, d.projectId);
  const problems = await ruleProblems(ctx, s, d);
  const sentence = ruleSentence(d);
  // The issues it acts on, or null for each issue itself, which a saved rule's target calls "issue".
  const reach = d.target && d.target.to !== 'issue' ? d.target : null;
  const says = (shows: RulePreview['says']['shows'], more: Partial<RulePreview['says']> = {}) => noteSays(s, d, reach, shows, more);
  const empty = { matching: 0, breaking: null, sample: [] };
  if (problems.some((p) => p.part === 'query' || p.part === 'requires')) {
    return { ok: false, problems, sentence, ...empty, note: 'Fix what is underlined to see the issues it would touch.', says: says('fixUnderlined') };
  }
  if (problems.some((p) => p.part === 'related' || p.part === 'target')) {
    return { ok: false, problems, sentence, ...empty, note: 'Fix what is underlined to see the issues it would touch.', says: says('fixUnderlined') };
  }
  const me = ctx.actor.user.id;
  const when = condition(s, d.query, { meId: me, projectId: d.projectId });
  const scope = await visibleScope(ctx);
  let where = when.where ? and(scope, when.where)! : scope;
  // Related issues count only where the rule reads: its project, or for a rule for every project, what you can see.
  if (d.kind !== 'guard' && d.related) where = and(where, relatedSql(s, relatedCondition(s, d, d.related, me, d.projectId ? null : scope)))!;
  const count = async (w: SQL) => Number((await ctx.db.select({ n: sql<number>`count(*)::int` }).from(issues).where(w))[0]?.n ?? 0);
  const matching = await count(where);
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

  if (d.kind === 'guard' && !d.script) {
    const requires = condition(s, d.requires ?? '', { meId: me });
    const breakingWhere = requires.where ? and(where, sql`NOT ${requires.where}`)! : sql`FALSE`;
    const breaking = await count(breakingWhere);
    const rows = await ctx.db.select().from(issues).where(breakingWhere).orderBy(desc(issues.updatedAt), asc(issues.id)).limit(PREVIEW_SAMPLE);
    const refs = await issueRefsById(ctx.db, s, rows.map((r) => r.id));
    const already = noted(`Already breaks it: it matches “${d.query}” but not “${d.requires ?? ''}”`, 'rule.alreadyBreaks', { query: d.query, requires: d.requires ?? '' });
    return {
      ok: problems.length === 0,
      problems,
      sentence,
      matching,
      breaking,
      sample: rows.map((r) => ({ issue: refs.get(r.id)!, changes: [], errors: [already.message], errorWords: [already.words] })),
      says: says('issues', { shown: rows.length }),
      note: breaking
        ? `${plural(matching, 'issue matches', 'issues match')} “${d.query}” now, and ${plural(breaking, 'of them breaks', 'of them break')} the rule: they were changed before it. It doesn't change them; it refuses only a change that makes an issue break it.`
        : `${plural(matching, 'issue matches', 'issues match')} “${d.query}” now, and all of them keep the rule. From now on it refuses a change that would make an issue break it.`,
    };
  }

  if (d.script) return previewScript(ctx, s, d, where, matching, problems, sentence, says);
  const rows = await ctx.db.select().from(issues).where(where).orderBy(desc(issues.updatedAt), asc(issues.id)).limit(PREVIEW_SAMPLE);
  const full = await ctx.app.schema.get();
  // The issues it would act on: each matching one, or the issues related to it that the rule reaches.
  const acted: { target: typeof issues.$inferSelect; via: typeof issues.$inferSelect | null }[] = [];
  let outside = 0;
  for (const r of rows) {
    if (!reach) {
      acted.push({ target: r, via: null });
      continue;
    }
    for (const t of await targetIssues(ctx.db, full, reach.to, reach.phrase ?? null, r.id)) {
      if (d.projectId && t.projectId !== d.projectId) outside++;
      else if (await canReadProject(ctx, t.projectId)) acted.push({ target: t, via: r });
    }
    if (acted.length >= PREVIEW_SAMPLE) break;
  }
  const shownActs = acted.slice(0, PREVIEW_SAMPLE);
  const refs = await issueRefsById(ctx.db, s, [...new Set(shownActs.flatMap((a) => [a.target.id, ...(a.via ? [a.via.id] : [])]))]);
  let sample: RulePreview['sample'] = [];
  for (const a of shownActs) {
    const told = d.notify ? (await recipientsFor(ctx.db, full, d.notify, a.target)).map(userRefDto) : undefined;
    sample.push({ issue: refs.get(a.target.id)!, changes: [], errors: [], via: a.via ? (refs.get(a.via.id) ?? null) : null, ...(told ? { told } : {}) });
  }
  const targets = shownActs.map((a) => a.target);
  if (targets.length && (d.command || d.comment) && !problems.some((p) => p.part === 'command')) {
    // Exactly what it would do: the executor's dry run, as the workflow agent, with "me" as you.
    // The agent reaches only the project of the issue it acts on, so each project's issues get their own.
    const bot = s.usersByLogin.get(WORKFLOW_BOT);
    if (bot) {
      const byId = new Map<string, { changes: Change[]; errors: string[]; errorWords?: Words[] }>();
      for (const projectId of new Set(targets.map((r) => r.projectId))) {
        const dry = await runCommand(botCtx(ctx.app, bot, projectId), {
          issues: [...new Set(targets.filter((r) => r.projectId === projectId).map((r) => r.id))],
          command: d.command,
          comment: d.comment ?? undefined,
          dryRun: true,
          meId: me,
        });
        for (const r of dry.results) byId.set(r.issue, r);
      }
      sample = sample.map((x) => {
        const r = byId.get(x.issue.id);
        return r ? { ...x, changes: r.changes, errors: r.errors, errorWords: r.errorWords ?? r.errors.map((m) => errorWords(null, m)) } : x;
      });
    }
  }
  const acts = d.kind === 'change' ? `It acts on one only when ${triggerWords(d.trigger, d.field)}.` : `${scheduleWords(d.schedule)}, ${reach ? 'it acts for each of them' : 'it acts on each of them'}.`;
  const onWhat = reach ? ` It acts on${targetWords(reach).replace(/^ to/, '')}.` : '';
  const key = d.projectId ? (s.projects.get(d.projectId)?.key ?? 'its project') : null;
  const left = outside ? ` ${plural(outside, 'issue it would act on is', 'issues it would act on are')} in another project, and a rule of ${key} leaves ${outside === 1 ? 'it' : 'them'} alone.` : '';
  const shown = sample.length
    ? ` Here is what it would do to ${sample.length} of ${reach ? 'those' : 'them'}, as they are now${d.notify ? ', and whom it would tell (whoever sets it off is never told)' : ''}.`
    : '';
  return {
    ok: problems.length === 0,
    problems,
    sentence,
    matching,
    breaking: null,
    sample,
    note: `${plural(matching, 'issue matches', 'issues match')} it now. ${acts}${onWhat}${left}${shown}`,
    says: says('issues', { outside, shown: sample.length }),
  };
}

/** What a rule's preview note says, as data a page words in its person's language (D49). The note says it in English. */
function noteSays(s: SchemaSnapshot, d: Draft, reach: RuleTarget | null, shows: RulePreview['says']['shows'], more: Partial<RulePreview['says']> = {}): RulePreview['says'] {
  return {
    shows,
    kind: d.kind,
    scripted: Boolean(d.script),
    trigger: d.trigger,
    field: d.field,
    schedule: d.schedule,
    target: reach,
    query: d.query,
    outside: 0,
    project: d.projectId ? (s.projects.get(d.projectId)?.key ?? null) : null,
    shown: 0,
    tells: Boolean(d.notify),
    ...more,
  };
}

/**
 * A rule's further condition, for relatedSql: what the related issues must match ("me" as given),
 * and which issues it reads at all: its project's, or for a rule for every project, `everywhere`
 * (null: every project; a preview passes what the person previewing can see).
 */
export function relatedCondition(s: SchemaSnapshot, d: Pick<Draft, 'projectId'>, r: RuleRelated, meId: string | null, everywhere: SQL | null = null): RelatedCondition {
  const world = ruleWorld(s, d.projectId);
  const matching = condition(world, r.query, { meId, projectId: d.projectId }).where;
  const readable = d.projectId ? sql`${issues.projectId} = ${d.projectId}` : everywhere;
  return {
    of: r.of,
    phrase: r.phrase ?? null,
    match: r.match ?? 'all',
    matching: everywhere && !d.projectId ? (matching ? sql`(${everywhere} AND ${matching})` : everywhere) : matching,
    readable,
  };
}

/** Live problems, a reading and suggestions for one part of a rule as it's typed, as the command bar has them. */
export async function checkRulePart(
  ctx: Ctx,
  body: { project: string | null; kind: RuleKind; part: 'query' | 'requires' | 'command' | 'related' | 'script'; text: string; caret?: number },
): Promise<{ problems: QueryProblem[]; description: string; suggestions: SuggestItem[] }> {
  requireScope(ctx, 'read');
  // What a part reads as, in the page's language when a page asks (D49); English for an agent or a script.
  const tr = translatorFor(ctx.pageLocale ?? 'en');
  if (body.part === 'script') {
    const problems = await checkScript(body.text);
    return {
      problems: problems.map((p) => ({ message: p.message, start: p.start, end: p.end, ...(p.hint ? { hint: p.hint } : {}), ...wordsOf(p) })),
      description: problems.length ? '' : tr.t('server.rule.itCompiles'),
      suggestions: [],
    };
  }
  const projectId = await projectIdOf(ctx, body.project);
  const s = await worldFor(ctx, projectId);
  const caret = Math.min(body.caret ?? body.text.length, body.text.length);
  const scheduled = body.kind === 'schedule';
  if (body.part === 'command') {
    const projectIds = projectId ? [projectId] : [...s.projects.keys()];
    const parsed = parseCommand(body.text, s, projectIds);
    return {
      problems: [...(scheduled ? meProblems(body.text) : []), ...parsed.problems].sort((a, b) => a.start - b.start),
      description: describeCommand(parsed.ops, tr),
      suggestions: suggestCommand(body.text, caret, s, projectIds),
    };
  }
  const p = parsedQuery(s, body.text);
  const compiled = compileQuery(p, { s, meId: ctx.actor.user.id });
  return {
    problems: [...(scheduled ? meProblems(body.text) : []), ...compiled.problems].sort((a, b) => a.start - b.start),
    description: explainParsed(p, tr),
    suggestions: suggest(s, body.text, caret),
  };
}

/** Runs older than this are forgotten. */
export const RUN_LOG_DAYS = 30;

export async function pruneRuleRuns(db: Db, now = new Date()): Promise<void> {
  await db.delete(ruleRuns).where(lt(ruleRuns.createdAt, new Date(now.getTime() - RUN_LOG_DAYS * 86_400_000)));
}

// ---------------------------------------------------------------------------
// Scripted rules: a preview, and a test run on one issue (D40)
// ---------------------------------------------------------------------------

/** What a scripted rule is told happened, when it's previewed or tested: its trigger's kind, with nothing changed. */
function testChange(ctx: Ctx, s: SchemaSnapshot, d: Draft): ScriptChange {
  const by = s.users.get(ctx.actor.user.id);
  if (d.kind === 'schedule') return changeOf('scheduled', null);
  if (d.kind === 'change' && d.trigger) return changeOf(d.trigger, by);
  return changeOf('updated', by);
}

/** A scripted rule's preview: what its script would do to a few of the issues it matches now, as the workflow agent, saving nothing. */
async function previewScript(
  ctx: Ctx,
  s: SchemaSnapshot,
  d: Draft,
  where: SQL,
  matching: number,
  problems: RuleProblem[],
  sentence: string,
  says: (shows: RulePreview['says']['shows'], more?: Partial<RulePreview['says']>) => RulePreview['says'],
): Promise<RulePreview> {
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const ok = problems.length === 0;
  const counted = `${plural(matching, 'issue matches', 'issues match')} its query now.`;
  if (problems.some((p) => p.part === 'script')) return { ok, problems, sentence, matching, breaking: null, sample: [], note: `${counted} Fix its script to see what it would do.`, says: says('fixScript') };
  const full = await ctx.app.schema.get();
  // A script runs on the server: anyone who reads the project previews one an administrator saved;
  // only an administrator runs one of their own (D40).
  const saved = full.rules.some((r) => r.script === d.script && r.projectId === d.projectId);
  if (!saved && !ctx.actor.scopes.includes('admin')) {
    return { ok, problems, sentence, matching, breaking: null, sample: [], note: `${counted} Only administrators run a script that isn't saved.`, says: says('adminOnly') };
  }
  const rows = await ctx.db.select().from(issues).where(where).orderBy(desc(issues.updatedAt), asc(issues.id)).limit(PREVIEW_SAMPLE);
  const refs = await issueRefsById(ctx.db, s, rows.map((r) => r.id));
  const bot = full.usersByLogin.get(WORKFLOW_BOT);
  const sample: RulePreview['sample'] = [];
  for (const r of rows) {
    const actor = d.kind === 'guard' || !bot ? ctx : botCtx(ctx.app, bot, r.projectId);
    const guard = d.kind === 'guard';
    const run = await dryRunScript(actor, full, r, d.script!, testChange(ctx, full, d), { meId: ctx.actor.user.id, guard, timeMs: guard ? SCRIPT_LIMITS.guardTimeMs : undefined });
    const self = refs.get(r.id)?.id;
    // Each with its words, for a page in its person's language (D49): what the script's engine said stays as it said it.
    const errors: { message: string; words: Words }[] = [
      ...(run.error ? [{ message: run.error.message, words: run.error.key ? { key: run.error.key, ...(run.error.values ? { values: run.error.values } : {}) } : errorWords(null, run.error.message) }] : []),
      ...(run.refusal !== null
        ? [guard ? noted(`Would refuse a change to it: “${run.refusal}”`, 'rule.wouldRefuse', { refusal: run.refusal }) : noted(`Would do nothing: “${run.refusal}”`, 'rule.wouldDoNothing', { refusal: run.refusal })]
        : []),
      ...run.applies.flatMap((a) => a.errors.map((message, i) => ({ message, words: a.errorWords?.[i] ?? errorWords(null, message) }))),
      ...run.applies.filter((a) => a.issue && a.issue.id !== self && a.changes.length).map((a) => noted(`Would also change ${a.issue!.id}`, 'rule.wouldAlsoChange', { id: a.issue!.id })),
    ];
    sample.push({
      issue: refs.get(r.id)!,
      changes: run.applies.filter((a) => a.issue?.id === self).flatMap((a) => a.changes),
      errors: errors.map((e) => e.message),
      errorWords: errors.map((e) => e.words),
    });
  }
  const what =
    d.kind === 'guard' ? 'It runs on every change to an issue that matches, and may refuse it' : d.kind === 'schedule' ? `${scheduleWords(d.schedule)}, it runs on each of them` : `It runs on one when ${triggerWords(d.trigger, d.field)}`;
  return {
    ok,
    problems,
    sentence,
    matching,
    breaking: null,
    sample,
    note: `${counted} ${what}.${sample.length ? ` Here is what its script would do to ${sample.length} of them, as they are now (a dry run: nothing was saved).` : ''}`,
    says: says('issues', { shown: sample.length }),
  };
}

/**
 * Run a rule's script on one issue as it is now, and show what it would do: a dry run, saving
 * nothing. For the person writing a script, so an administrator's, as writing one is.
 */
export async function testRule(ctx: Ctx, input: RuleInput & { issue: string }): Promise<ScriptRun> {
  requireScope(ctx, 'read');
  assertCanScript(ctx, 'rule');
  const d = draftFrom(await projectIdOf(ctx, input.project), input);
  if (!d.script) throw badRequest('There is no script to run', 'Write one first.').said('workflow.noScript');
  const issue = await findVisibleIssue(ctx, input.issue);
  if (!issue) throw notFound(`Issue ${input.issue}`, 'Use a readable id such as BACK-12.').said('workflow.testIssueNotFound', { id: input.issue });
  const full = await ctx.app.schema.get();
  if (d.projectId && issue.projectId !== d.projectId) {
    const key = full.projects.get(d.projectId)?.key ?? 'its project';
    throw badRequest(`${input.issue.toUpperCase()} isn't in ${key}`, `A rule of ${key} runs only on ${key}'s issues.`).said('workflow.testIssueElsewhere', { id: input.issue.toUpperCase(), project: key });
  }
  const bot = full.usersByLogin.get(WORKFLOW_BOT);
  const guard = d.kind === 'guard';
  const actor = guard || !bot ? ctx : botCtx(ctx.app, bot, issue.projectId);
  return dryRunScript(actor, full, issue, d.script, testChange(ctx, full, d), { meId: ctx.actor.user.id, guard, timeMs: guard ? SCRIPT_LIMITS.guardTimeMs : undefined });
}
