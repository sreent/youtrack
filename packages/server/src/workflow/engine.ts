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
import type { Change, RuleSchedule, TrackerEvent } from '@a4a/shared';
import { and, asc, eq, gt, lte, sql, type SQL } from 'drizzle-orm';
import { commandSpec } from '../commands/executor';
import { parseCommand } from '../commands/parser';
import type { AppServices, AutomationCause, Ctx, UserRow } from '../context';
import type { Db } from '../db/client';
import { WORKFLOW_BOT } from '../db/defaults';
import { issues, ruleRuns, rules, webhooks } from '../db/schema';
import { publishActivities, recordActivity, type ActivityRow } from '../events/activity';
import { callableUrl, webhookOrigin } from '../events/webhooks';
import type { Chore, OutboxConsumer } from '../events/worker';
import { AppError } from '../lib/errors';
import { issueRef, readableId, stateNames } from '../services/issue-refs';
import { findIssue, type IssueRow } from '../services/issues';
import { rulesFor, type RuleRow, type SchemaSnapshot } from '../services/schema-cache';
import { condition, meets, relatedSql, ruleWorld, TARGETS_CAP, targetIssues } from './match';
import { botCtx, draftOf, pruneRuleRuns, readingProblems, relatedCondition } from './rules';
import { runScript } from './sandbox';
import { changeOf, scriptInput, type ScriptChange } from './script-issue';
import { applyPlanned, plannedChanges, scriptErrorText, type Planned } from './scripts';
import { recipientsFor } from './tell';
import { listWords, nextRunAfter } from './words';

/** How many rules deep a chain may go: a rule's change sets off rules, whose changes set off rules… */
export const MAX_DEPTH = 3;
/** Issues one scheduled run changes at most. */
export const SCHEDULED_CAP = 2000;
const PAGE = 50;
const CHECK_EVERY_MS = 15_000;
const PRUNE_EVERY_MS = 3_600_000;
const BROKEN_NOTE_EVERY_MS = 3_600_000;

export type Outcome = 'applied' | 'unchanged' | 'failed' | 'skipped' | 'duplicate';

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
        await this.record(s, rule, issue, chain, 'failed', errorText(e));
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
      await this.record(s, rule, target, chain, 'skipped', `Rules set off by other rules stop after ${MAX_DEPTH} steps, so it didn't act on this change.`);
    }
  }

  /** Whether a rule still reads; one that doesn't does nothing, and says so once an hour. */
  private async reads(s: SchemaSnapshot, rule: RuleRow): Promise<boolean> {
    const problems = readingProblems(ruleWorld(s, rule.projectId), draftOf(rule));
    if (!problems.length) return true;
    const last = this.brokenNoted.get(rule.id) ?? 0;
    if (Date.now() - last >= BROKEN_NOTE_EVERY_MS) {
      this.brokenNoted.set(rule.id, Date.now());
      await this.record(s, rule, null, null, 'failed', `It no longer reads (${problems.map((p) => p.message).join('; ')}), so it does nothing until it is fixed.`);
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
      await this.record(s, rule, issue, chain, 'skipped', `${said.join('. ')}.`);
    }
    return failed ? 'failed' : applied ? 'applied' : 'unchanged';
  }

  /**
   * Do what a rule does to one issue, as the workflow agent, all in one transaction with its run:
   * apply its command, tell the people it tells (the notifier delivers the message, as for any
   * event), and ask the webhook sender to call its webhook. If the run log says the rule already
   * acted on this issue for this change, all of it is taken back.
   */
  async apply(s: SchemaSnapshot, rule: RuleRow, issue: IssueRow, chain: Chain): Promise<Outcome> {
    const bot = s.usersByLogin.get(WORKFLOW_BOT);
    if (!bot) throw new Error('The workflow agent is missing: restart the server to create it');
    const ctx: Ctx = { ...botCtx(this.app, bot, issue.projectId), automation: { rule: rule.id, name: rule.name, origin: chain.origin, depth: chain.depth + 1, by: chain.me } };
    // A replayed event, or a loop come round: this rule already acted on this issue for this change.
    if (chain.origin !== null && (await this.actedFor(rule, issue, chain.origin))) return 'duplicate';
    const d = draftOf(rule);

    // What it changes: its command, or what its script asks for (D40), worked out before the
    // transaction, as the workflow agent, with "me" as whoever set it off.
    let planned: Planned[] = [];
    let logs: string[] = [];
    if (rule.script) {
      const input = await scriptInput(this.app.db, s, issue, chain.change ?? changeOf('scheduled', null));
      const out = await runScript(rule.script, input);
      const logged = logWords(out.intents.logs);
      if (out.error) {
        await this.record(s, rule, issue, chain, 'failed', `${scriptErrorText(out)}.${logged}`);
        return 'failed';
      }
      if (out.intents.refusal !== null) {
        await this.record(s, rule, issue, chain, 'skipped', `It did nothing: ${out.intents.refusal}${logged}`);
        return 'unchanged';
      }
      try {
        planned = await plannedChanges(ctx, this.app.db, s, issue, input.issue, out.intents, { meId: chain.me ?? undefined });
      } catch (e) {
        await this.record(s, rule, issue, chain, 'failed', `${errorText(e)}${logged}`);
        return 'failed';
      }
      logs = out.intents.logs;
    } else if (d.command || d.comment) {
      try {
        const parsed = parseCommand(rule.command, s, [issue.projectId]);
        if (parsed.problems.length) {
          const key = s.projects.get(issue.projectId)?.key ?? 'this project';
          throw new AppError(400, 'bad_request', `Its command doesn't fit ${key}: ${parsed.problems.map((p) => p.message).join('; ')}`);
        }
        planned = [{ issue, spec: await commandSpec(ctx, issue, parsed.ops, rule.comment ?? undefined, { meId: chain.me ?? undefined }), command: rule.command }];
      } catch (e) {
        await this.record(s, rule, issue, chain, 'failed', errorText(e));
        return 'failed';
      }
    }
    const call = d.callWebhookId ? await this.callable(d.callWebhookId) : null;

    try {
      const result = await this.app.db.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Db;
        // applyChanges locks the issue's row first, as every write to an issue does.
        const fresh = (await findIssue(tx, s, issue.id)) ?? issue;
        const res = planned.length ? await applyPlanned(tx, ctx, s, issue, planned) : { changes: [] as Change[], others: [] as string[], activities: [] as ActivityRow[] };
        const activities = [...res.activities];
        const after = planned.length ? ((await findIssue(tx, s, issue.id)) ?? fresh) : fresh;
        const ref = (d.notify || call?.ok) && after ? await refOf(tx, s, after) : null;

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

        const changed = res.changes.length > 0 || res.others.length > 0;
        const acted = changed || told.length > 0 || Boolean(call?.ok);
        if (chain.origin !== null || acted) {
          const said = [
            res.changes.length ? changeWords(res.changes) : '',
            res.others.length ? `Also changed ${res.others.join('; ')}` : '',
            told.length ? `Told ${people(told)}` : d.notify ? 'Had nobody to tell: whoever set it off isn’t told, and only people who can see the issue are' : '',
            call?.ok ? `Called ${call.origin ?? 'its webhook'}` : call ? call.why : '',
          ].filter(Boolean);
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
      await this.record(s, rule, issue, chain, 'failed', errorText(e));
      return 'failed';
    }
  }

  /** Whether the webhook a rule calls can be called now: there, on, and https (or this machine). */
  private async callable(webhookId: string): Promise<{ ok: boolean; origin: string | null; why: string }> {
    const [hook] = await this.app.db.select({ url: webhooks.url, active: webhooks.active }).from(webhooks).where(eq(webhooks.id, webhookId));
    if (!hook) return { ok: false, origin: null, why: 'Its webhook is gone, so nothing was called' };
    const origin = webhookOrigin(hook.url);
    if (!callableUrl(hook.url)) return { ok: false, origin, why: "Its webhook's address isn't https, so it wasn't called" };
    if (!hook.active) return { ok: false, origin, why: 'Its webhook is paused, so nothing was sent' };
    return { ok: true, origin, why: '' };
  }

  private async actedFor(rule: RuleRow, issue: IssueRow, origin: string): Promise<boolean> {
    const [row] = await this.app.db
      .select({ id: ruleRuns.id })
      .from(ruleRuns)
      .where(and(eq(ruleRuns.ruleId, rule.id), eq(ruleRuns.issueId, issue.id), eq(ruleRuns.originId, origin)))
      .limit(1);
    return Boolean(row);
  }

  private async record(s: SchemaSnapshot, rule: RuleRow, issue: IssueRow | null, chain: Chain | null, outcome: Outcome, message: string): Promise<void> {
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
    await this.record(s, rule, null, null, failed ? 'failed' : changed ? 'applied' : 'unchanged', `${said}.`);
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
