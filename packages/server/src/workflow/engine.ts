/**
 * The rule engine. It applies rules as the workflow agent, through the command executor, with
 * channel "automation":
 *
 * - Rules on a change run from the outbox, as a consumer: after an issue is created, changes or
 *   gets a comment, each rule set off by it acts if the issue, as it is when the rule runs (after
 *   the change, and any made since), matches the rule's query.
 * - Scheduled rules run as one of the worker's chores, which only the instance holding the worker's
 *   lease runs. A turn is claimed by moving the rule's next run on before running it, so a turn runs
 *   once even if the lease changes hands.
 *
 * Loops. Every change a rule makes records its cause (context.ts, AutomationCause): the rule, the
 * change that started the chain, and how deep in the chain it is. A rule's change can set off other
 * rules, to a depth of MAX_DEPTH, and a rule acts on an issue at most once for each change that
 * starts a chain: the run log's unique (rule, issue, origin) holds that, inside the transaction that
 * makes the change. The same key makes a replayed event (the outbox is at least once) do nothing.
 *
 * Failures. A rule that fails (its command no longer fits, a guard refuses its change, a value it
 * names is gone) is written in the run log with why, and never stops the other rules or the outbox.
 *
 * Reach. The workflow agent has administrator scopes, as triage's agent does, but acts on one issue
 * at a time and reaches only that issue's project (`actor.projectIds`), members only or not: a
 * rule never reads, links to or changes another project's issues. A project's rule reads only its
 * own project's names (match.ts, ruleWorld), as it was checked when it was made.
 */
import type { Change, NoteSaid, RuleSchedule, TrackerEvent } from '@a4a/shared';
import { and, asc, eq, gt, inArray, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import { commandSpec } from '../commands/executor';
import { parseCommand } from '../commands/parser';
import type { AppServices, AutomationCause, Ctx, UserRow } from '../context';
import type { Db } from '../db/client';
import { WORKFLOW_BOT } from '../db/defaults';
import { issues, ruleRuns, rules, scriptJobs, webhooks } from '../db/schema';
import { publishActivities, recordActivity, type ActivityRow } from '../events/activity';
import { callableUrl, webhookOrigin } from '../events/webhooks';
import type { Chore, OutboxConsumer } from '../events/worker';
import { AppError, asSentence, saidProblems } from '../lib/errors';
import { newId } from '../lib/ids';
import { issueRef, readableId, stateNames } from '../services/issue-refs';
import { findIssue, type IssueRow } from '../services/issues';
import { rulesFor, type RuleRow, type SchemaSnapshot } from '../services/schema-cache';
import { condition, meets, relatedSql, ruleWorld, TARGETS_CAP, targetIssues } from './match';
import { botCtx, draftOf, pruneRuleRuns, readingProblems, relatedCondition } from './rules';
import { runScript } from './sandbox';
import { changeOf, scriptInput, type ScriptChange } from './script-issue';
import { applyPlanned, plannedChanges, scriptErrorSaid, scriptErrorText, type OtherChanged, type Planned } from './scripts';
import { recipientsFor } from './tell';
import { appAgentCtx } from '../apps/actor';
import { settingsForRule } from '../services/apps';
import { listWords, nextRunAfter } from './words';

/** How many rules deep a chain may go: a rule's change sets off rules, whose changes set off rules… */
export const MAX_DEPTH = 3;
/** Issues one scheduled run changes at most. */
export const SCHEDULED_CAP = 2000;
const PAGE = 50;
const CHECK_EVERY_MS = 15_000;
const PRUNE_EVERY_MS = 3_600_000;
const BROKEN_NOTE_EVERY_MS = 3_600_000;

export type Outcome = 'applied' | 'unchanged' | 'failed' | 'skipped' | 'duplicate' | 'queued';

/** What became of a script's call(): the webhook it names, and whether it will be called. */
interface CallOutcome {
  name: string;
  body: string;
  ok: boolean;
  hook: { id: string; url: string; active: boolean } | null;
  why: string;
  whyKey: string;
}

interface Chain {
  /** The change that started the chain (an event id), or null for a scheduled run. */
  origin: string | null;
  depth: number;
  /** Who "me" is: whoever made the change that started the chain. */
  me: string | null;
  eventId: number | null;
  actorId: string | null;
  /** What happened, as a scripted rule is told it (D40); a scheduled turn when absent. */
  change?: ScriptChange;
}

/** Whether this instance still holds the worker's lease (the worker renews it while a chore runs). */
export type StillHolder = () => boolean;

function causeOf(event: TrackerEvent): AutomationCause | null {
  const a = event.data.automation as Partial<AutomationCause> | undefined;
  return a && typeof a.depth === 'number' && typeof a.rule === 'string' ? (a as AutomationCause) : null;
}

/** Whether a rule on a change is set off by the event. */
export function firesOn(rule: RuleRow, event: TrackerEvent): boolean {
  if (!rule.enabled || rule.kind !== 'change') return false;
  switch (rule.trigger) {
    case 'created':
      return event.type === 'issue.created';
    case 'commented':
      return event.type === 'comment.created';
    case 'updated': {
      if (event.type !== 'issue.updated') return false;
      const field = rule.triggerField?.toLowerCase();
      return !field || event.changes.some((c) => c.field.toLowerCase() === field);
    }
    default:
      return false;
  }
}

function errorText(e: unknown): string {
  if (e instanceof AppError) return e.hint ? `${e.message} (${e.hint})` : e.message;
  return e instanceof Error ? e.message : String(e);
}

function changeWords(changes: Change[]): string {
  return changes.map((c) => (c.field === 'Comment' ? 'Commented' : `${c.field}: ${c.from ?? '—'} → ${c.to ?? '—'}`)).join('; ');
}

// What a run did, in the catalogs, a sentence each, beside its English message (D49): a page says it
// in its person's language. What people named (fields, values, a rule's or a script's own words) stays as written.

/** What went wrong, as a page says it: a keyed problem by its words; anything else in the English it came in. */
function errorSaid(e: unknown): NoteSaid {
  if (e instanceof AppError && e.words) return { key: `problem.${e.words.key}`, ...(e.words.values ? { values: e.words.values } : {}) };
  return { key: 'problem.inItsOwnWords', values: { words: asSentence(errorText(e)) } };
}

/**
 * The fields it changed (their names and values, as named), and whether it commented. Each change is
 * a note of its own, so a page says them as its language's list, with its own colon (「State：Open → Fixed」).
 */
function changesSaid(changes: Change[]): NoteSaid[] {
  const fields = changes.filter((c) => c.field !== 'Comment');
  return [
    ...(fields.length ? [{ key: 'rules.run.changed', values: { changes: fields.map((c) => ({ key: 'rules.run.fieldChange', values: { field: c.field, from: c.from ?? '—', to: c.to ?? '—' } })) } }] : []),
    ...(changes.length > fields.length ? [{ key: 'rules.run.commented' }] : []),
  ];
}

/** What it changed on other issues, as the API says it: "BACK-12: State → Fixed, Priority → High; BACK-13: …". */
function othersWords(others: OtherChanged[]): string {
  return others.map((o) => `${o.issue}: ${o.changes.map((c) => `${c.field} → ${c.to ?? '—'}`).join(', ')}`).join('; ');
}

/** The same, kept as data (D49): each issue a note, its changes a list in it, joined as a page's language joins them. */
function othersSaid(others: OtherChanged[]): NoteSaid {
  return {
    key: 'rules.run.alsoChanged',
    values: { others: others.map((o) => ({ key: 'rules.run.otherChanged', values: { issue: o.issue, changes: o.changes.map((c) => ({ key: 'rules.run.fieldTo', values: { field: c.field, to: c.to ?? '—' } })) } })) },
  };
}

/** What a script logged, the first few lines, as it wrote them. */
function logSaid(logs: string[]): NoteSaid[] {
  if (!logs.length) return [];
  const shown = logs.slice(0, 5).map((l) => (l.length > 200 ? `${l.slice(0, 199)}…` : l));
  return [{ key: 'rules.run.logged', values: { lines: shown.join(' | '), more: Math.max(0, logs.length - 5) } }];
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What a script logged, for its run: the first few lines. */
function logWords(logs: string[]): string {
  if (!logs.length) return '';
  const shown = logs.slice(0, 5).map((l) => (l.length > 200 ? `${l.slice(0, 199)}…` : l));
  return ` Logged: ${shown.join(' | ')}${logs.length > 5 ? ` (and ${logs.length - 5} more)` : ''}`;
}

/**
 * A rule's whole condition on the issue it acts for, as SQL on `issues`: its query, and its further
 * condition on related issues, each over what the rule reads (match.ts).
 */
export function whenSql(s: SchemaSnapshot, rule: RuleRow, meId: string | null): SQL | null {
  const query = condition(ruleWorld(s, rule.projectId), rule.query, { meId, projectId: rule.projectId }).where;
  const d = draftOf(rule);
  if (!d.related) return query;
  const related = relatedSql(s, relatedCondition(s, d, d.related, meId));
  return query ? sql`(${query} AND ${related})` : related;
}

async function refOf(db: Db, s: SchemaSnapshot, issue: IssueRow) {
  const states = await stateNames(db, s, [issue.id]);
  return issueRef(s, issue, states.get(issue.id) ?? null);
}

/** "Anna Schmidt", "Anna Schmidt and Ben Okafor", "Anna Schmidt, Ben Okafor and 3 others". */
function people(users: UserRow[]): string {
  const names = users.map((u) => u.name);
  return names.length <= 3 ? listWords(names) : `${names.slice(0, 2).join(', ')} and ${names.length - 2} others`;
}

/**
 * Whom it told, for a page: up to three names, or two and how many more, as a list the page says as
 * its language's ("Anna, Ben and 3 others", "Anna、Ben、ほか3人"), the more a note of its own.
 */
export function toldSaid(users: UserRow[]): NoteSaid {
  const names = users.map((u) => u.name);
  if (names.length <= 3) return { key: 'rules.run.told', values: { names } };
  // Two names and how many more, counted as each language counts the rest ("Anna, Ben 외 3명",
  // 「Anna、Benほか3人」), rather than "3 others" joined into the list as its last name.
  return { key: 'rules.run.toldTwoAndOthers', values: { first: names[0]!, second: names[1]!, more: names.length - 2 } };
}

/** What notes kept before still say: "3 others" as the last item of whom a rule told, before toldTwoAndOthers. */
export const KEPT_NOTE_KEYS = ['rules.run.toldOthers'] as const;

/** Thrown inside a run's transaction when the run log says the rule already acted for this change. */
class AlreadyActed extends Error {}

export class RuleEngine {
  private brokenNoted = new Map<string, number>();

  constructor(
    private app: AppServices,
    private log: (msg: string, err?: unknown) => void = (m, e) => console.error(m, e ?? ''),
  ) {}

  consumer(): OutboxConsumer {
    return {
      name: 'workflow-rules',
      types: ['issue.created', 'issue.updated', 'comment.created'],
      handle: (event) => this.onEvent(event),
    };
  }

  /** The worker's chores for rules: scheduled turns, and forgetting old runs. Only the lease holder runs them. */
  chores(stillHolder: StillHolder = () => true): Chore[] {
    return [
      { name: 'workflow-schedule', everyMs: CHECK_EVERY_MS, run: async () => void (await this.runDue(stillHolder)) },
      { name: 'workflow-run-log', everyMs: PRUNE_EVERY_MS, run: () => pruneRuleRuns(this.app.db) },
    ];
  }

  // -------------------------------------------------------------------------
  // Rules on a change
  // -------------------------------------------------------------------------

  async onEvent(event: TrackerEvent): Promise<void> {
    if (!event.issue || !event.project) return;
    // An import brings history in; it isn't a change happening now (D21). Rules on a change leave it
    // be, as notifications and triage do. Scheduled rules see imported issues as any others.
    if ((event.data as { imported?: unknown } | undefined)?.imported) return;
    // An undo puts back what an agent changed (D34). Rules saw the issue that way already; acting on it
    // again, a rule could redo at once what a person just undid.
    if ((event.data as { undoes?: unknown } | undefined)?.undoes !== undefined) return;
    const s = await this.app.schema.get();
    const project = s.projectsByKey.get(event.project.toUpperCase());
    if (!project) return;
    const fired = rulesFor(s, project.id).filter((r) => firesOn(r, event));
    if (!fired.length) return;
    const issue = await findIssue(this.app.db, s, event.issue.id);
    if (!issue) return;
    const cause = causeOf(event);
    const kind = event.type === 'issue.created' ? 'created' : event.type === 'comment.created' ? 'commented' : 'updated';
    const text = (event.data as { text?: unknown } | undefined)?.text;
    const chain: Chain = {
      origin: cause?.origin ?? String(event.id),
      depth: cause?.depth ?? 0,
      me: cause ? cause.by : event.actor.id,
      eventId: event.id,
      actorId: cause ? cause.by : event.actor.id,
      change: changeOf(kind, event.actor.id ? s.users.get(event.actor.id) : null, event.changes, { comment: typeof text === 'string' ? text : null }),
    };
    const readable: RuleRow[] = [];
    for (const rule of fired) if (await this.reads(s, rule)) readable.push(rule);
    // Every rule the change sets off sees the issue as the change left it, all in one read: one rule's
    // change is a change of its own, which sets off rules in turn, one step deeper.
    const matched = await meets(
      this.app.db,
      issue.id,
      readable.map((r) => whenSql(s, r, chain.me)),
    );
    for (const [i, rule] of readable.entries()) {
      if (!matched[i]) continue;
      try {
        if (chain.depth >= MAX_DEPTH) {
          await this.tooDeep(s, rule, issue, chain);
          continue;
        }
        await this.act(s, rule, issue, chain);
      } catch (e) {
        // One rule failing never stops the others, nor the outbox.
        this.log(`workflow rule ${rule.id} failed on event ${event.id}`, e);
        await this.record(s, rule, issue, chain, 'failed', errorText(e), [errorSaid(e)]);
      }
    }
  }

  /**
   * A chain that went as deep as it may: the run log says so on each issue the rule would have acted
   * on (the issue that set it off may have been acted on already in this chain, under the same key).
   */
  private async tooDeep(s: SchemaSnapshot, rule: RuleRow, issue: IssueRow, chain: Chain): Promise<void> {
    const d = draftOf(rule);
    const targets = d.target
      ? (await targetIssues(this.app.db, s, d.target.to, d.target.phrase ?? null, issue.id)).slice(0, TARGETS_CAP).filter((t) => !rule.projectId || t.projectId === rule.projectId)
      : [issue];
    for (const target of targets) {
      await this.record(s, rule, target, chain, 'skipped', `Rules set off by other rules stop after ${MAX_DEPTH} steps, so it didn't act on this change.`, [
        { key: 'rules.run.tooDeep', values: { max: MAX_DEPTH } },
      ]);
    }
  }

  /** Whether a rule still reads; one that doesn't does nothing, and says so once an hour. */
  private async reads(s: SchemaSnapshot, rule: RuleRow): Promise<boolean> {
    const problems = readingProblems(ruleWorld(s, rule.projectId), draftOf(rule));
    if (!problems.length) return true;
    const last = this.brokenNoted.get(rule.id) ?? 0;
    if (Date.now() - last >= BROKEN_NOTE_EVERY_MS) {
      this.brokenNoted.set(rule.id, Date.now());
      await this.record(s, rule, null, null, 'failed', `It no longer reads (${problems.map((p) => p.message).join('; ')}), so it does nothing until it is fixed.`, [
        { key: 'problem.rule.noLongerReads', values: { guard: 'no', problems: saidProblems(problems) } },
      ]);
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // Acting for one issue: on it, or on the issues related to it
  // -------------------------------------------------------------------------

  /**
   * Act for one issue that set the rule off (or matched, on a schedule): on the issue itself, or on
   * each issue related to it as the rule says, once for each. A project's rule leaves alone the
   * related issues of other projects, and says so in the run of the issue it acted for, without
   * naming them.
   */
  async act(s: SchemaSnapshot, rule: RuleRow, issue: IssueRow, chain: Chain): Promise<Outcome> {
    const d = draftOf(rule);
    if (!d.target) return this.apply(s, rule, issue, chain);
    const found = await targetIssues(this.app.db, s, d.target.to, d.target.phrase ?? null, issue.id);
    const capped = found.length > TARGETS_CAP;
    const targets = found.slice(0, TARGETS_CAP);
    const reach = targets.filter((t) => !rule.projectId || t.projectId === rule.projectId);
    const outside = targets.length - reach.length;
    let applied = 0;
    let failed = 0;
    for (const target of reach) {
      const outcome = await this.apply(s, rule, target, chain);
      if (outcome === 'applied') applied++;
      else if (outcome === 'failed') failed++;
    }
    if (outside || capped) {
      const said = [
        outside ? `Left ${plural(outside, 'issue')} alone: ${outside === 1 ? 'it is' : 'they are'} in another project, and a rule acts only on its own project's issues` : '',
        capped ? `Acted on the first ${TARGETS_CAP} only` : '',
      ].filter(Boolean);
      await this.record(s, rule, issue, chain, 'skipped', `${said.join('. ')}.`, [
        ...(outside ? [{ key: 'rules.run.leftOutside', values: { outside } }] : []),
        ...(capped ? [{ key: 'rules.run.firstOnly', values: { cap: TARGETS_CAP } }] : []),
      ]);
    }
    return failed ? 'failed' : applied ? 'applied' : 'unchanged';
  }

  /**
   * A queued script's run (D40's revisit): the worker's turn, on the input its rule saw when it fired.
   * The same discipline as an inline run - the run's claim, the changes as the workflow agent, the
   * run log - only it may take its time, and the issue as it is now gets the change (it is read fresh).
   */
  async applyQueued(s: SchemaSnapshot, rule: RuleRow, job: typeof scriptJobs.$inferSelect): Promise<void> {
    const issue = await findIssue(this.app.db, s, job.issueId);
    if (!issue) {
      await this.record(s, rule, null, { origin: job.origin, depth: 0, me: null, eventId: null, actorId: null }, 'failed', 'The issue was gone when the queued script ran.');
      return;
    }
    const chain: Chain = { origin: job.origin, depth: 0, me: null, eventId: null, actorId: null };
    if (job.origin !== null && (await this.actedFor(rule, issue, job.origin))) return;
    const bot = s.usersByLogin.get(WORKFLOW_BOT);
    if (!bot) return;
    const ctx: Ctx = { ...botCtx(this.app, bot, issue.projectId), automation: { rule: rule.id, name: rule.name, origin: job.origin, depth: 1, by: null } };
    const d = draftOf(rule);
    const out = await runScript(rule.script!, job.input as never, { timeMs: 30_000, library: s.projects.get(issue.projectId)?.scriptLibrary ?? undefined });
    const logged = logWords(out.intents.logs);
    if (out.error) {
      await this.record(s, rule, issue, chain, 'failed', `${scriptErrorText(out)}.${logged}`, [
        { key: 'problem.rule.scriptStopped', values: { error: scriptErrorSaid(out.error) } },
        ...logSaid(out.intents.logs),
      ]);
      return;
    }
    if (out.intents.refusal !== null) {
      await this.record(s, rule, issue, chain, 'skipped', `It did nothing: ${out.intents.refusal}${logged}`, [
        { key: 'rules.run.didNothing', values: { refusal: out.intents.refusal } },
        ...logSaid(out.intents.logs),
      ]);
      return;
    }
    let planned: Planned[] = [];
    try {
      planned = await plannedChanges(ctx, this.app.db, s, issue, (job.input as { issue: never }).issue, out.intents, { meId: undefined });
    } catch (err) {
      await this.record(s, rule, issue, chain, 'failed', `${errorText(err)}${logged}`, [errorSaid(err), ...logSaid(out.intents.logs)]);
      return;
    }
    try {
      const out2 = await this.app.db.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Db;
        const res = planned.length ? await applyPlanned(tx, ctx, s, issue, planned) : { changes: [] as Change[], others: [] as OtherChanged[], activities: [] as ActivityRow[] };
        const after = planned.length ? ((await findIssue(tx, s, issue.id)) ?? issue) : issue;
        const ref = d.notify && after ? await refOf(tx, s, after) : null;
        let told: UserRow[] = [];
        if (d.notify && ref) {
          told = await recipientsFor(tx, s, d.notify, after, {});
          if (told.length) {
            res.activities.push(await recordActivity(tx, ctx, { type: 'rule.notified', projectId: after.projectId, issueId: after.id, payload: { issue: ref, data: { message: d.notify.message, to: d.notify.to, people: told.map((u) => u.login) } } }));
          }
        }
        const changed = res.changes.length > 0 || res.others.length > 0;
        const acted = changed || told.length > 0;
        const said = [
          res.changes.length ? changeWords(res.changes) : '',
          res.others.length ? `Also changed ${othersWords(res.others)}` : '',
          told.length ? `Told ${people(told)}` : d.notify ? 'Had nobody to tell' : '',
        ].filter(Boolean).join('. ');
        return { after, acted, changed, said, activities: res.activities };
      });
      const { after, acted, changed, said, activities } = out2;
      await this.record(s, rule, after, chain, acted ? (changed ? 'applied' : 'unchanged') : 'unchanged', said || 'Its script ran from the queue and changed nothing.');
      await publishActivities(this.app, activities);
    } catch (err) {
      await this.record(s, rule, issue, chain, 'failed', `${errorText(err)}${logged}`, [errorSaid(err), ...logSaid(out.intents.logs)]);
    }
  }

  /**
   * Do what a rule does to one issue, as the workflow agent, all in one transaction with its run:
   * apply its command, tell the people it tells (the notifier delivers the message, as for any
   * event), and ask the webhook sender to call its webhook. If the run log says the rule already
   * acted on this issue for this change, all of it is taken back.
   */
  async apply(s: SchemaSnapshot, rule: RuleRow, issue: IssueRow, chain: Chain): Promise<Outcome> {
    // An app's rule acts as the app's agent, within its grant (D48); any other, as the workflow agent.
    const owner = rule.appId ? s.apps.get(rule.appId) : undefined;
    const bot = owner ? s.users.get(owner.agentId) : s.usersByLogin.get(WORKFLOW_BOT);
    if (!bot) throw new Error('The workflow agent is missing: restart the server to create it');
    const base = owner ? appAgentCtx(this.app, s, owner, bot, issue.projectId) : botCtx(this.app, bot, issue.projectId);
    const ctx: Ctx = { ...base, automation: { rule: rule.id, name: rule.name, origin: chain.origin, depth: chain.depth + 1, by: chain.me } };
    // A replayed event, or a loop come round: this rule already acted on this issue for this change.
    if (chain.origin !== null && (await this.actedFor(rule, issue, chain.origin))) return 'duplicate';
    const d = draftOf(rule);

    // What it changes: its command, or what its script asks for (D40), worked out before the
    // transaction, as the workflow agent, with "me" as whoever set it off.
    let planned: Planned[] = [];
    let logs: string[] = [];
    let calls: CallOutcome[] = [];
    if (rule.script) {
      // An app's rule reads comments only if its app was granted them (D48), and never a limited one.
      const input = await scriptInput(this.app.db, s, issue, chain.change ?? changeOf('scheduled', null), { unlimited: Boolean(owner) });
      if (owner && !owner.granted.read.includes('comments')) input.issue.comments = [];
      // A queued script (D40's revisit): the worker runs it later, on what it saw now, so it may take its time.
      if (rule.queued) {
        await this.app.db
          .insert(scriptJobs)
          .values({ id: newId(), ruleId: rule.id, projectId: issue.projectId, issueId: issue.id, origin: chain.origin, input: input as unknown as Record<string, unknown> })
          .onConflictDoNothing({ target: [scriptJobs.ruleId, scriptJobs.issueId, scriptJobs.origin] });
        return 'queued';
      }
      // And its app's settings, the project's over the app's.
      const out = await runScript(rule.script, owner ? { ...input, settings: await settingsForRule(this.app, owner.id, issue.projectId) } : input, { library: s.projects.get(issue.projectId)?.scriptLibrary ?? undefined });
      const logged = logWords(out.intents.logs);
      if (out.error) {
        await this.record(s, rule, issue, chain, 'failed', `${scriptErrorText(out)}.${logged}`, [
          { key: 'problem.rule.scriptStopped', values: { error: scriptErrorSaid(out.error) } },
          ...logSaid(out.intents.logs),
        ]);
        return 'failed';
      }
      if (out.intents.refusal !== null) {
        await this.record(s, rule, issue, chain, 'skipped', `It did nothing: ${out.intents.refusal}${logged}`, [
          { key: 'rules.run.didNothing', values: { refusal: out.intents.refusal } },
          ...logSaid(out.intents.logs),
        ]);
        return 'unchanged';
      }
      try {
        planned = await plannedChanges(ctx, this.app.db, s, issue, input.issue, out.intents, { meId: chain.me ?? undefined });
      } catch (e) {
        await this.record(s, rule, issue, chain, 'failed', `${errorText(e)}${logged}`, [errorSaid(e), ...logSaid(out.intents.logs)]);
        return 'failed';
      }
      logs = out.intents.logs;
      calls = await this.callsOf(issue.projectId, out.intents.calls);
    } else if (d.command || d.comment) {
      try {
        const parsed = parseCommand(rule.command, s, [issue.projectId]);
        if (parsed.problems.length) {
          const key = s.projects.get(issue.projectId)?.key ?? 'this project';
          // Its parser's problems as words of their own, said whole on a page (D49).
          throw new AppError(400, 'bad_request', `Its command doesn't fit ${key}: ${parsed.problems.map((p) => p.message).join('; ')}`).said('workflow.commandMisfit', { project: key, problems: saidProblems(parsed.problems) });
        }
        planned = [{ issue, spec: await commandSpec(ctx, issue, parsed.ops, rule.comment ?? undefined, { meId: chain.me ?? undefined }), command: rule.command }];
      } catch (e) {
        await this.record(s, rule, issue, chain, 'failed', errorText(e), [errorSaid(e)]);
        return 'failed';
      }
    }
    const call = d.callWebhookId ? await this.callable(d.callWebhookId) : null;

    try {
      const result = await this.app.db.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Db;
        // applyChanges locks the issue's row first, as every write to an issue does.
        const fresh = (await findIssue(tx, s, issue.id)) ?? issue;
        const res = planned.length ? await applyPlanned(tx, ctx, s, issue, planned) : { changes: [] as Change[], others: [] as OtherChanged[], activities: [] as ActivityRow[] };
        const activities = [...res.activities];
        const after = planned.length ? ((await findIssue(tx, s, issue.id)) ?? fresh) : fresh;
        const ref = (d.notify || call?.ok || calls.some((x) => x.ok)) && after ? await refOf(tx, s, after) : null;

        // Whom it tells, as the issue is after its change: "its assignee" is whoever it just assigned.
        let told: UserRow[] = [];
        if (d.notify && ref) {
          told = await recipientsFor(tx, s, d.notify, after, { exclude: chain.me });
          if (told.length) {
            activities.push(
              await recordActivity(tx, ctx, {
                type: 'rule.notified',
                projectId: after.projectId,
                issueId: after.id,
                payload: { issue: ref, data: { message: d.notify.message, to: d.notify.to, people: told.map((u) => u.login) } },
              }),
            );
          }
        }
        if (call?.ok && ref) {
          activities.push(
            await recordActivity(tx, ctx, {
              type: 'rule.called',
              projectId: after.projectId,
              issueId: after.id,
              payload: { issue: ref, changes: res.changes, data: { webhook: d.callWebhookId } },
            }),
          );
        }
        for (const x of calls) {
          if (x.ok && ref) {
            activities.push(
              await recordActivity(tx, ctx, {
                type: 'script.called',
                projectId: after.projectId,
                issueId: after.id,
                payload: { issue: ref, data: { webhook: x.hook!.id, name: x.name, body: x.body } },
              }),
            );
          }
        }

        const changed = res.changes.length > 0 || res.others.length > 0;
        const acted = changed || told.length > 0 || Boolean(call?.ok) || calls.some((x) => x.ok);
        if (chain.origin !== null || acted) {
          const said = [
            res.changes.length ? changeWords(res.changes) : '',
            res.others.length ? `Also changed ${othersWords(res.others)}` : '',
            told.length ? `Told ${people(told)}` : d.notify ? 'Had nobody to tell: whoever set it off isn’t told, and only people who can see the issue are' : '',
            call?.ok ? `Called ${call.origin ?? 'its webhook'}` : call ? call.why : '',
            ...calls.map((x) => (x.ok ? `Called ${x.name}` : x.why)),
          ].filter(Boolean);
          const words: NoteSaid[] = [
            ...changesSaid(res.changes),
            ...(res.others.length ? [othersSaid(res.others)] : []),
            ...(told.length ? [toldSaid(told)] : d.notify ? [{ key: 'rules.run.toldNobody' }] : []),
            ...(call?.ok ? [call.origin ? { key: 'rules.run.called', values: { origin: call.origin } } : { key: 'rules.run.calledItsWebhook' }] : call ? [{ key: call.whyKey }] : []),
            // Why a script's call wasn't made names the origin it asked for, where its words do.
            ...calls.map((x) => (x.ok ? { key: 'rules.run.called', values: { origin: x.name } } : { key: x.whyKey, values: { name: x.name } })),
          ];
          const claimed = await tx
            .insert(ruleRuns)
            .values({
              ruleId: rule.id,
              projectId: issue.projectId,
              issueId: issue.id,
              issueKey: readableId(s, issue),
              eventId: chain.eventId,
              originId: chain.origin,
              actorId: chain.actorId,
              outcome: acted ? 'applied' : 'unchanged',
              message: `${said.length ? said.join('; ') : 'Nothing to change: it was so already.'}${logWords(logs)}`,
              said: [...(words.length ? words : [{ key: 'rules.run.nothingToChange' }]), ...logSaid(logs)],
              changes: res.changes,
            })
            .onConflictDoNothing()
            .returning({ id: ruleRuns.id });
          // The run log says it acted for this change first: take all of this back.
          if (!claimed.length) throw new AlreadyActed();
        }
        return { activities, acted };
      });
      await publishActivities(this.app, result.activities);
      return result.acted ? 'applied' : 'unchanged';
    } catch (e) {
      if (e instanceof AlreadyActed) return 'duplicate';
      await this.record(s, rule, issue, chain, 'failed', errorText(e), [errorSaid(e)]);
      return 'failed';
    }
  }

  /** A script's call, resolved: which webhook it names, and whether it can be called now. */
  private async callsOf(projectId: string, asked: { webhook: string; body: string }[]): Promise<CallOutcome[]> {
    // A script names a webhook as its page does: by origin, never its path, which can hold a secret (D32).
    const rows = await this.app.db.select().from(webhooks).where(or(eq(webhooks.projectId, projectId), isNull(webhooks.projectId)));
    return asked.map((x) => {
      const named = rows.filter((h) => webhookOrigin(h.url) === x.webhook);
      if (!named.length) return { name: x.webhook, body: x.body, ok: false, hook: null, why: `It called ${x.webhook}, which isn't a webhook of this project`, whyKey: 'problem.rules.run.scriptCalledNobody' };
      if (named.length > 1) return { name: x.webhook, body: x.body, ok: false, hook: null, why: `More than one webhook has the origin ${x.webhook}, so nothing was called`, whyKey: 'problem.rules.run.scriptCalledAmbiguous' };
      const hook = named[0]!;
      if (!callableUrl(hook.url)) return { name: x.webhook, body: x.body, ok: false, hook: null, why: `Its webhook's address isn't https, so ${x.webhook} wasn't called`, whyKey: 'rules.run.webhookNotHttps' };
      if (!hook.active) return { name: x.webhook, body: x.body, ok: false, hook: null, why: `Its webhook is paused, so ${x.webhook} wasn't called`, whyKey: 'rules.run.webhookPaused' };
      return { name: x.webhook, body: x.body, ok: true, hook, why: '', whyKey: '' };
    });
  }

  /** Whether the webhook a rule calls can be called now: there, on, and https (or this machine). */
  private async callable(webhookId: string): Promise<{ ok: boolean; origin: string | null; why: string; whyKey: string }> {
    const [hook] = await this.app.db.select({ url: webhooks.url, active: webhooks.active }).from(webhooks).where(eq(webhooks.id, webhookId));
    if (!hook) return { ok: false, origin: null, why: 'Its webhook is gone, so nothing was called', whyKey: 'rules.run.webhookGone' };
    const origin = webhookOrigin(hook.url);
    if (!callableUrl(hook.url)) return { ok: false, origin, why: "Its webhook's address isn't https, so it wasn't called", whyKey: 'rules.run.webhookNotHttps' };
    if (!hook.active) return { ok: false, origin, why: 'Its webhook is paused, so nothing was sent', whyKey: 'rules.run.webhookPaused' };
    return { ok: true, origin, why: '', whyKey: '' };
  }

  private async actedFor(rule: RuleRow, issue: IssueRow, origin: string): Promise<boolean> {
    const [row] = await this.app.db
      .select({ id: ruleRuns.id })
      .from(ruleRuns)
      .where(and(eq(ruleRuns.ruleId, rule.id), eq(ruleRuns.issueId, issue.id), eq(ruleRuns.originId, origin)))
      .limit(1);
    return Boolean(row);
  }

  /** A run in the log: its message in English, for the API, and `said`, its words for a page (D49). */
  private async record(s: SchemaSnapshot, rule: RuleRow, issue: IssueRow | null, chain: Chain | null, outcome: Outcome, message: string, said: NoteSaid[] | null = null): Promise<void> {
    if (outcome === 'duplicate') return;
    await this.app.db
      .insert(ruleRuns)
      .values({
        ruleId: rule.id,
        projectId: issue?.projectId ?? rule.projectId,
        issueId: issue?.id ?? null,
        issueKey: issue ? readableId(s, issue) : null,
        eventId: chain?.eventId ?? null,
        originId: issue ? (chain?.origin ?? null) : null,
        actorId: chain?.actorId ?? null,
        outcome,
        message,
        said,
      })
      .onConflictDoNothing()
      .catch((e) => this.log(`could not write the run of workflow rule ${rule.id}`, e));
  }

  // -------------------------------------------------------------------------
  // Scheduled rules
  // -------------------------------------------------------------------------

  /** Run every scheduled rule whose turn has come. The worker calls this only while it holds its lease. */
  async runDue(stillHolder: StillHolder = () => true, now = new Date()): Promise<number> {
    const due = await this.app.db
      .select()
      .from(rules)
      .where(and(eq(rules.kind, 'schedule'), eq(rules.enabled, true), lte(rules.nextRunAt, now)))
      .orderBy(asc(rules.nextRunAt))
      .limit(20);
    let ran = 0;
    for (const rule of due) {
      if (!stillHolder()) return ran;
      const schedule = rule.schedule as RuleSchedule | null;
      if (!schedule || !rule.nextRunAt) continue;
      // Take the turn before running it: moving the next run on can succeed only once.
      const [claimed] = await this.app.db
        .update(rules)
        .set({ nextRunAt: nextRunAfter(schedule, now), lastRunAt: now })
        .where(and(eq(rules.id, rule.id), eq(rules.nextRunAt, rule.nextRunAt)))
        .returning({ id: rules.id });
      if (!claimed) continue;
      await this.runScheduled(rule, stillHolder);
      ran++;
    }
    return ran;
  }

  /** Every issue that matches the rule's query gets its command, in pages; it stops if the lease goes elsewhere. */
  async runScheduled(rule: RuleRow, stillHolder: StillHolder = () => true): Promise<void> {
    const s = await this.app.schema.get();
    if (!(await this.reads(s, rule))) return;
    const where = whenSql(s, rule, null) ?? sql`TRUE`;
    let checked = 0;
    let changed = 0;
    let failed = 0;
    let after = '';
    let capped = false;
    let lost = false;
    for (;;) {
      if (!stillHolder()) {
        lost = true;
        break;
      }
      // By id, so a page is never read twice even as the rule changes what matches.
      const page = await this.app.db.select().from(issues).where(and(where, gt(issues.id, after))).orderBy(asc(issues.id)).limit(PAGE);
      for (const issue of page) {
        if (checked >= SCHEDULED_CAP) {
          capped = true;
          break;
        }
        checked++;
        const outcome = await this.act(s, rule, issue, { origin: null, depth: 0, me: null, eventId: null, actorId: null });
        if (outcome === 'applied') changed++;
        else if (outcome === 'failed') failed++;
      }
      if (capped || page.length < PAGE) break;
      after = page[page.length - 1]!.id;
    }
    const said = [
      `Checked ${plural(checked, 'issue')}, changed ${changed}`,
      failed ? `${failed} failed` : '',
      capped ? `and stopped at ${SCHEDULED_CAP}: narrow its query so it matches fewer` : '',
      lost ? 'and stopped because another instance took over the worker' : '',
    ]
      .filter(Boolean)
      .join(', ');
    await this.record(s, rule, null, null, failed ? 'failed' : changed ? 'applied' : 'unchanged', `${said}.`, [
      { key: 'rules.run.scheduled', values: { checked, changed, failed, capped: capped ? 'yes' : 'no', cap: SCHEDULED_CAP, lost: lost ? 'yes' : 'no' } },
    ]);
  }
}

/** The rule engine as the outbox worker's consumer (registered in server.ts). */
export function rulesConsumer(app: AppServices): OutboxConsumer {
  return new RuleEngine(app).consumer();
}

/** The rule engine's chores (registered in server.ts), for the worker that holds the lease. */
export function ruleChores(app: AppServices & { worker?: { active: boolean } | null }): Chore[] {
  return new RuleEngine(app).chores(() => app.worker?.active ?? true);
}
/**
 * The queued scripts' worker (D40's revisit): claims what waited, runs each on the input it saw when
 * its rule fired, and applies what it asked for, as the workflow agent. Long scripts get their time
 * here; a job whose issue is gone, or whose rule is, is closed without a run.
 */
export async function runScriptJobs(app: AppServices): Promise<void> {
  const s = await app.schema.get();
  for (;;) {
    const batch = await app.db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      const ids = await tx
        .execute(sql`SELECT id FROM script_jobs WHERE state = 'queued' ORDER BY created_at LIMIT 10 FOR UPDATE SKIP LOCKED`);
      const rows = (ids as unknown as { rows: { id: string }[] }).rows.map((x) => x.id);
      if (!rows.length) return [];
      await tx.update(scriptJobs).set({ state: 'running', claimedAt: new Date() }).where(inArray(scriptJobs.id, rows));
      return rows.map((id) => ({ id, tx: false }));
    });
    if (!batch.length) return;
    for (const { id } of batch) {
      await runQueuedJob(app, s, id).catch((err) => console.warn(`queued script ${id} failed`, err));
    }
  }
}

async function runQueuedJob(app: AppServices, s: SchemaSnapshot, jobId: string): Promise<void> {
  const [job] = await app.db.select().from(scriptJobs).where(eq(scriptJobs.id, jobId));
  if (!job) return;
  const rule = s.rules.find((x) => x.id === job.ruleId);
  if (!rule || rule.projectId !== job.projectId) {
    await app.db.delete(scriptJobs).where(eq(scriptJobs.id, jobId));
    return;
  }
  const engine = new RuleEngine(app);
  const done = await engine.applyQueued(s, rule, job);
  await app.db.delete(scriptJobs).where(eq(scriptJobs.id, jobId));
  void done;
}
