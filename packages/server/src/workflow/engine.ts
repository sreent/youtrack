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
import { and, asc, eq, gt, lte, sql } from 'drizzle-orm';
import { commandSpec } from '../commands/executor';
import { parseCommand } from '../commands/parser';
import type { AppServices, AutomationCause, Ctx } from '../context';
import type { Db } from '../db/client';
import { WORKFLOW_BOT } from '../db/defaults';
import { issues, ruleRuns, rules } from '../db/schema';
import { publishActivities } from '../events/activity';
import type { Chore, OutboxConsumer } from '../events/worker';
import { AppError } from '../lib/errors';
import { readableId } from '../services/issue-refs';
import { applyChanges, findIssue, type ChangeSpec, type IssueRow } from '../services/issues';
import { rulesFor, type RuleRow, type SchemaSnapshot } from '../services/schema-cache';
import { condition, meets, ruleWorld } from './match';
import { botCtx, draftOf, pruneRuleRuns, readingProblems } from './rules';
import { nextRunAfter } from './words';

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
    const s = await this.app.schema.get();
    const project = s.projectsByKey.get(event.project.toUpperCase());
    if (!project) return;
    const fired = rulesFor(s, project.id).filter((r) => firesOn(r, event));
    if (!fired.length) return;
    const issue = await findIssue(this.app.db, s, event.issue.id);
    if (!issue) return;
    const cause = causeOf(event);
    const chain: Chain = {
      origin: cause?.origin ?? String(event.id),
      depth: cause?.depth ?? 0,
      me: cause ? cause.by : event.actor.id,
      eventId: event.id,
      actorId: cause ? cause.by : event.actor.id,
    };
    const readable: RuleRow[] = [];
    for (const rule of fired) if (await this.reads(s, rule)) readable.push(rule);
    // Every rule the change sets off sees the issue as the change left it, all in one read: one rule's
    // change is a change of its own, which sets off rules in turn, one step deeper.
    const matched = await meets(
      this.app.db,
      issue.id,
      readable.map((r) => condition(ruleWorld(s, r.projectId), r.query, { meId: chain.me, projectId: r.projectId }).where),
    );
    for (const [i, rule] of readable.entries()) {
      if (!matched[i]) continue;
      try {
        if (chain.depth >= MAX_DEPTH) {
          await this.record(s, rule, issue, chain, 'skipped', `Rules set off by other rules stop after ${MAX_DEPTH} steps, so it didn't act on this change.`);
          continue;
        }
        await this.apply(s, rule, issue, chain);
      } catch (e) {
        // One rule failing never stops the others, nor the outbox.
        this.log(`workflow rule ${rule.id} failed on event ${event.id}`, e);
        await this.record(s, rule, issue, chain, 'failed', errorText(e));
      }
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
  // Applying a rule to one issue
  // -------------------------------------------------------------------------

  /** Apply a rule's command to one issue, as the workflow agent, and write down what happened. */
  async apply(s: SchemaSnapshot, rule: RuleRow, issue: IssueRow, chain: Chain): Promise<Outcome> {
    const bot = s.usersByLogin.get(WORKFLOW_BOT);
    if (!bot) throw new Error('The workflow agent is missing: restart the server to create it');
    const ctx: Ctx = { ...botCtx(this.app, bot, issue.projectId), automation: { rule: rule.id, name: rule.name, origin: chain.origin, depth: chain.depth + 1, by: chain.me } };
    // A replayed event, or a loop come round: this rule already acted on this issue for this change.
    if (chain.origin !== null && (await this.actedFor(rule, issue, chain.origin))) return 'duplicate';

    let spec: ChangeSpec;
    try {
      const parsed = parseCommand(rule.command, s, [issue.projectId]);
      if (parsed.problems.length) {
        const key = s.projects.get(issue.projectId)?.key ?? 'this project';
        throw new AppError(400, 'bad_request', `Its command doesn't fit ${key}: ${parsed.problems.map((p) => p.message).join('; ')}`);
      }
      spec = await commandSpec(ctx, issue, parsed.ops, rule.comment ?? undefined, { meId: chain.me ?? undefined });
    } catch (e) {
      await this.record(s, rule, issue, chain, 'failed', errorText(e));
      return 'failed';
    }

    try {
      const result = await this.app.db.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Db;
        // applyChanges locks the issue's row first, as every write to an issue does.
        const fresh = (await findIssue(tx, s, issue.id)) ?? issue;
        const res = await applyChanges(tx, ctx, fresh, spec);
        const changed = res.changes.length > 0;
        if (chain.origin !== null || changed) {
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
              outcome: changed ? 'applied' : 'unchanged',
              message: changed ? changeWords(res.changes) : 'Nothing to change: it was so already.',
              changes: res.changes,
            })
            .onConflictDoNothing()
            .returning({ id: ruleRuns.id });
          // The run log says it acted for this change first: take this change back.
          if (!claimed.length) throw new AlreadyActed();
        }
        return res;
      });
      await publishActivities(this.app, result.activities);
      return result.changes.length ? 'applied' : 'unchanged';
    } catch (e) {
      if (e instanceof AlreadyActed) return 'duplicate';
      await this.record(s, rule, issue, chain, 'failed', errorText(e));
      return 'failed';
    }
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
    const where = condition(ruleWorld(s, rule.projectId), rule.query, { meId: null, projectId: rule.projectId }).where ?? sql`TRUE`;
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
        const outcome = await this.apply(s, rule, issue, { origin: null, depth: 0, me: null, eventId: null, actorId: null });
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
