/**
 * State machines (docs/architecture.md, D40): for a state field of a project, its states and the
 * named transitions between them, each with an optional condition (a query the issue must match as
 * the transition finds it) and an optional action (a command, applied as whoever makes the move).
 *
 * The write path holds it: applyChanges asks machineMoves which transition each change to a
 * governed field makes, before writing, and refuses (422 refused_by_state_machine) a change that
 * no transition allows. Every way of changing an issue goes through there (the issue page, a board,
 * a command, an agent, a rule), so none of them skips the machine. A change from or to no state
 * at all is free (a new issue starts where it's put); an import (history) and an undo (D34, putting
 * back what was) are free too. A machine with problems (a state renamed since) refuses nothing
 * until it is fixed, and says what to fix.
 *
 * Managing a machine is the project manager's; it holds only commands and queries, no script.
 */
import type { StateMachine, StateMachineInput, StateTransition, WorkflowProblem } from '@a4a/shared';
import { and, asc, eq, sql } from 'drizzle-orm';
import { commandSpec } from '../commands/executor';
import { parseCommand } from '../commands/parser';
import { requireScope, type Ctx } from '../context';
import type { Db } from '../db/client';
import { WORKFLOW_BOT } from '../db/defaults';
import { stateMachines } from '../db/schema';
import { AppError, badRequest, conflict, keyedProblem, notFound, saidProblems, type QueryProblemWords } from '../lib/errors';
import { newId } from '../lib/ids';
import { assertCanManageProject, assertCanWriteProject, canReadProject, requireProject } from '../services/access';
import { readableId, type IssueRow } from '../services/issue-refs';
import type { ChangeSpec } from '../services/issues';
import { actionsFor, allowedValues, machinesFor, transitionsOf, type FieldRow, type MachineRow, type SchemaSnapshot } from '../services/schema-cache';
import type { ResolvedValue } from '../services/values';
import { condition, meets, ruleWorld } from './match';

/** Words that start a clause of the command language, so a transition's or action's name can't. */
export const RESERVED_WORDS = ['add', 'remove', 'tag', 'tags', 'untag', 'for', 'comment'];
const MACHINE_TYPES = new Set(['state', 'enum']);

const whole = (text: string) => ({ start: 0, end: text.length });

/** A name for a transition or an action that the command language can read as itself and nothing else. */
export function nameProblems(s: SchemaSnapshot, projectId: string, name: string, own: { actionId?: string; machineId?: string }): NameProblem[] {
  const n = name.trim().toLowerCase();
  if (!n) return [keyedProblem({ message: 'Give it a name' }, 'rule.giveItAName')];
  const out: NameProblem[] = [];
  const first = n.split(/\s+/)[0]!;
  if (RESERVED_WORDS.includes(first)) out.push(keyedProblem({ message: `It can't start with “${first}”, which starts a command of its own` }, 'rule.nameStartsCommand', { word: first }));
  if (/^[A-Za-z][A-Za-z0-9]*-\d+$/.test(name.trim())) out.push(keyedProblem({ message: "It can't look like an issue id" }, 'rule.nameLooksLikeId'));
  for (const pf of s.projectFields.get(projectId) ?? []) {
    const f = s.fields.get(pf.fieldId);
    if (f?.name.toLowerCase() === n) out.push(keyedProblem({ message: `${f.name} is a field` }, 'rule.nameIsField', { field: f.name }));
  }
  if (s.linkPhrases.some((p) => p.phrase === n)) out.push(keyedProblem({ message: `“${name.trim()}” is how a link reads` }, 'rule.nameIsLink', { name: name.trim() }));
  for (const a of actionsFor(s, projectId)) {
    if (a.id !== own.actionId && a.name.toLowerCase() === n) out.push(keyedProblem({ message: `There is an action “${a.name}” already` }, 'rule.actionExists', { name: a.name }));
  }
  for (const m of machinesFor(s, projectId)) {
    if (m.id === own.machineId) continue;
    if (transitionsOf(m).some((t) => t.name.toLowerCase() === n)) {
      out.push(keyedProblem({ message: `Another state machine has a transition “${name.trim()}”` }, 'rule.transitionElsewhere', { name: name.trim() }));
    }
  }
  return out;
}

/** What's wrong with a name, in the API's English and with its words for a page (D49). */
export type NameProblem = { message: string } & QueryProblemWords;

/** What's wrong with a machine for `field` in the project, transition by transition. */
export function machineProblems(s: SchemaSnapshot, projectId: string, field: FieldRow | undefined, transitions: StateTransition[], own: { machineId?: string } = {}): WorkflowProblem[] {
  const out: WorkflowProblem[] = [];
  if (!field || !(s.projectFields.get(projectId) ?? []).some((pf) => pf.fieldId === field.id)) {
    return [keyedProblem({ part: 'field', message: 'The project has no such field', ...whole('') }, 'rule.noSuchField')];
  }
  if (!MACHINE_TYPES.has(field.type) || field.multi) {
    return [
      keyedProblem(
        { part: 'field', message: `${field.name} isn't a state field`, hint: 'A state machine is for a field with one value from a list, such as State.', ...whole(field.name) },
        'rule.notAStateField',
        { field: field.name },
      ),
    ];
  }
  const states = allowedValues(s, field.id, projectId).map((v) => v.name);
  const state = (name: string) => states.find((x) => x.toLowerCase() === name.trim().toLowerCase());
  if (!transitions.length) out.push(keyedProblem({ part: 'transitions', message: 'Add a transition: a move from one state to another', ...whole('') }, 'rule.addTransition'));
  const names = new Map<string, number>();
  const pairs = new Map<string, string>();
  const standIn = s.usersByLogin.get(WORKFLOW_BOT)?.id ?? '';
  transitions.forEach((t, i) => {
    const at = (part: WorkflowProblem['part'], words: QueryProblemWords, message: string, text = '', hint?: string) =>
      out.push(keyedProblem({ part, message, transition: i, ...whole(text), ...(hint ? { hint } : {}) }, words.key, words.values));
    for (const m of nameProblems(s, projectId, t.name, { machineId: own.machineId })) out.push({ part: 'name', transition: i, ...whole(t.name), ...m });
    const key = t.name.trim().toLowerCase();
    if (names.has(key)) at('name', { key: 'rule.transitionNameTwice', values: { name: t.name.trim() } }, `Two transitions are called “${t.name.trim()}”`, t.name);
    names.set(key, i);
    const to = state(t.to);
    if (!to) at('to', { key: 'rule.noState', values: { field: field.name, state: t.to, states: states.join(', ') } }, `${field.name} has no state “${t.to}”`, t.to, `Its states: ${states.join(', ')}`);
    const from = t.from.map((f) => f.trim()).filter(Boolean);
    if (!from.length) at('from', { key: 'rule.sayFromStates' }, 'Say which states it leaves, or * for any', '');
    for (const f of from) {
      if (f === '*') continue;
      if (!state(f)) at('from', { key: 'rule.noState', values: { field: field.name, state: f, states: states.join(', ') } }, `${field.name} has no state “${f}”`, f, `Its states: ${states.join(', ')}`);
      else if (to && state(f) === to) at('from', { key: 'rule.leavesForItself', values: { state: to } }, `It leaves ${to} for ${to}`, f, 'A transition goes from one state to another.');
    }
    if (to) {
      // One move between two states has one transition. A transition from any state (*) gives way
      // to one that names its state, so "Reopen from anywhere" sits beside "Accept from Submitted".
      const leaves = from.includes('*') ? ['*'] : from.map(state).filter((x): x is string => Boolean(x) && x !== to);
      for (const f of leaves) {
        const pair = `${f.toLowerCase()}→${to.toLowerCase()}`;
        const other = pairs.get(pair);
        if (other !== undefined && other !== key) {
          at(
            'from',
            f === '*' ? { key: 'rule.twoFromAny', values: { state: to } } : { key: 'rule.twoTransitions', values: { name: t.name.trim(), from: f, to } },
            f === '*' ? `Two transitions go from any state to ${to}` : `“${t.name.trim()}” and another transition both go from ${f} to ${to}`,
            f,
            'One move between two states has one transition.',
          );
        }
        pairs.set(pair, key);
      }
    }
    if (t.condition?.trim()) {
      const c = condition(ruleWorld(s, projectId), t.condition, { meId: standIn });
      for (const p of c.problems) out.push({ ...p, part: 'condition', transition: i });
    }
    if (t.command?.trim()) {
      const parsed = parseCommand(t.command, s, [projectId]);
      for (const p of parsed.problems) out.push({ ...p, part: 'command', transition: i });
      if (parsed.ops.some((op) => op.kind === 'field' && op.field.id === field.id)) at('command', { key: 'rule.commandSetsMachineField', values: { field: field.name } }, `Its command sets ${field.name}, which the transition itself moves`, t.command);
      if (parsed.ops.some((op) => op.kind === 'action' || op.kind === 'transition')) at('command', { key: 'rule.transitionRunsAction' }, 'Its command runs an action or another transition, and a transition can’t', t.command);
    }
  });
  return out;
}

function dto(s: SchemaSnapshot, row: MachineRow): StateMachine {
  const field = s.fields.get(row.fieldId);
  const transitions = transitionsOf(row);
  return {
    id: row.id,
    project: s.projects.get(row.projectId)?.key ?? '?',
    field: field?.name ?? '?',
    states: field ? allowedValues(s, field.id, row.projectId).map((v) => v.name) : [],
    transitions,
    enabled: row.enabled,
    problems: machineProblems(s, row.projectId, field, transitions, { machineId: row.id }),
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function tidyTransitions(list: StateTransition[]): StateTransition[] {
  return list.map((t) => ({
    name: t.name.trim(),
    from: [...new Set(t.from.map((f) => f.trim()).filter(Boolean))],
    to: t.to.trim(),
    condition: t.condition?.trim() || null,
    command: t.command?.trim() || null,
  }));
}

function refuseProblems(problems: WorkflowProblem[]): never {
  const words = problems.map((p) => (p.hint ? `${p.message} (${p.hint})` : p.message)).join('; ');
  throw badRequest(`The state machine needs fixing: ${words}`, 'Each problem says where it is.', { problems }).said('workflow.machineNeedsFixing', { problems: saidProblems(problems) });
}

async function loadMachine(ctx: Ctx, id: string): Promise<MachineRow> {
  requireScope(ctx, 'read');
  const [row] = await ctx.db.select().from(stateMachines).where(eq(stateMachines.id, id));
  if (!row || !(await canReadProject(ctx, row.projectId))) throw notFound('State machine').said('workflow.machineNotFound');
  return row;
}

export async function listMachines(ctx: Ctx, project: string): Promise<StateMachine[]> {
  requireScope(ctx, 'read');
  const p = await requireProject(ctx, project);
  const rows = await ctx.db.select().from(stateMachines).where(eq(stateMachines.projectId, p.id)).orderBy(asc(stateMachines.createdAt), asc(stateMachines.id));
  const s = await ctx.app.schema.get();
  return rows.map((r) => dto(s, r));
}

export async function getMachine(ctx: Ctx, id: string): Promise<StateMachine> {
  return dto(await ctx.app.schema.get(), await loadMachine(ctx, id));
}

export async function createMachine(ctx: Ctx, input: StateMachineInput): Promise<StateMachine> {
  requireScope(ctx, 'write');
  const project = await requireProject(ctx, input.project, 'manage');
  await assertCanManageProject(ctx, project.id);
  const s = await ctx.app.schema.get();
  const field = [...s.fields.values()].find((f) => f.name.toLowerCase() === input.field.trim().toLowerCase());
  const transitions = tidyTransitions(input.transitions);
  const problems = machineProblems(s, project.id, field, transitions);
  if (problems.length) refuseProblems(problems);
  if (machinesFor(s, project.id).some((m) => m.fieldId === field!.id)) {
    throw conflict(`${project.key} has a state machine for ${field!.name} already`, 'Change that one instead.').said('workflow.machineExists', { project: project.key, field: field!.name });
  }
  const [row] = await ctx.db
    .insert(stateMachines)
    .values({ id: newId(), projectId: project.id, fieldId: field!.id, transitions, enabled: input.enabled ?? true, createdById: ctx.actor.user.id, updatedById: ctx.actor.user.id })
    .onConflictDoNothing()
    .returning();
  if (!row) throw conflict(`${project.key} has a state machine for ${field!.name} already`, 'Change that one instead.').said('workflow.machineExists', { project: project.key, field: field!.name });
  ctx.app.schema.invalidate();
  return dto(await ctx.app.schema.get(), row);
}

export async function updateMachine(ctx: Ctx, id: string, input: { transitions?: StateTransition[]; enabled?: boolean; expectedVersion?: number }): Promise<StateMachine> {
  requireScope(ctx, 'write');
  const row = await loadMachine(ctx, id);
  await assertCanManageProject(ctx, row.projectId);
  if (input.expectedVersion !== undefined && input.expectedVersion !== row.version) {
    throw conflict('The state machine was changed by someone else', 'Reload it and make your change again.', { currentVersion: row.version }).said('workflow.machineChangedMeanwhile');
  }
  const s = await ctx.app.schema.get();
  const transitions = input.transitions ? tidyTransitions(input.transitions) : transitionsOf(row);
  const enabled = input.enabled ?? row.enabled;
  // Turning one off never waits on fixing it.
  if (input.transitions || (enabled && !row.enabled)) {
    const problems = machineProblems(s, row.projectId, s.fields.get(row.fieldId), transitions, { machineId: row.id });
    if (problems.length) refuseProblems(problems);
  }
  const [updated] = await ctx.db
    .update(stateMachines)
    .set({ transitions, enabled, version: sql`${stateMachines.version} + 1`, updatedById: ctx.actor.user.id, updatedAt: new Date() })
    .where(and(eq(stateMachines.id, row.id), eq(stateMachines.version, row.version)))
    .returning();
  if (!updated) throw conflict('The state machine was changed by someone else', 'Reload it and make your change again.').said('workflow.machineChangedMeanwhile');
  ctx.app.schema.invalidate();
  return dto(await ctx.app.schema.get(), updated);
}

export async function deleteMachine(ctx: Ctx, id: string): Promise<void> {
  requireScope(ctx, 'write');
  const row = await loadMachine(ctx, id);
  await assertCanManageProject(ctx, row.projectId);
  await ctx.db.delete(stateMachines).where(eq(stateMachines.id, row.id));
  ctx.app.schema.invalidate();
}

// ---------------------------------------------------------------------------
// In the write path
// ---------------------------------------------------------------------------

export interface Move {
  field: FieldRow;
  transition: StateTransition;
  from: string;
  to: string;
}

/** A change a state machine refuses, keyed by the way it refuses it, for a page in another language (D49). */
function refused(message: string, hint: string, details: Record<string, unknown>, key: string, values: Record<string, string | number>): AppError {
  return new AppError(422, 'refused_by_state_machine', message, hint, details).said(key, values);
}

/** The project's machine for a field, if it is on and reads. */
function liveMachine(s: SchemaSnapshot, projectId: string, field: FieldRow): { machine: MachineRow; transitions: StateTransition[] } | null {
  const machine = machinesFor(s, projectId).find((m) => m.enabled && m.fieldId === field.id);
  if (!machine) return null;
  const transitions = transitionsOf(machine);
  // A machine with problems refuses nothing until it's fixed: a renamed state mustn't stop every change.
  if (machineProblems(s, projectId, field, transitions, { machineId: machine.id }).length) return null;
  return { machine, transitions };
}

const named = (s: SchemaSnapshot, v: ResolvedValue[] | undefined) => (v?.[0]?.valueId ? (s.values.get(v[0].valueId)?.name ?? null) : null);

/** Where a state can go, in words: "In Progress (Start work), Won't fix (Decline)". */
function exits(transitions: StateTransition[], from: string): { words: string; values: { exits: string; where: 'some' | 'nowhere' } } {
  const out = transitions.filter((t) => t.to.toLowerCase() !== from.toLowerCase() && (t.from.includes('*') || t.from.some((f) => f.toLowerCase() === from.toLowerCase())));
  const list = out.map((t) => `${t.to} (${t.name})`).join(', ');
  // The words the API says; a keyed problem says them in its catalog by the code (D49).
  return out.length ? { words: list, values: { exits: list, where: 'some' } } : { words: 'nowhere: it is where its machine ends', values: { exits: '', where: 'nowhere' } };
}

/**
 * Before writing: which transition each change to a governed field makes, checking its condition on
 * the issue as it is. Throws 422 refused_by_state_machine for a change no transition allows.
 */
export async function machineMoves(
  tx: Db,
  ctx: Ctx,
  s: SchemaSnapshot,
  issue: IssueRow,
  updates: { field: FieldRow; values: ResolvedValue[] }[],
  current: Map<string, ResolvedValue[]>,
  chosen?: ChangeSpec['transition'],
): Promise<Move[]> {
  const moves: Move[] = [];
  if (!s.machines.length) return moves;
  const rid = readableId(s, issue);
  for (const u of updates) {
    const live = liveMachine(s, issue.projectId, u.field);
    if (!live) continue;
    const from = named(s, current.get(u.field.id));
    const to = named(s, u.values);
    // From no state, or to none: free. A new issue starts where it's put.
    if (!from || !to) continue;
    // One that names the state it leaves first, then one from any state.
    const toHere = live.transitions.filter((t) => t.to.toLowerCase() === to.toLowerCase());
    const fits = [...toHere.filter((t) => t.from.some((f) => f.toLowerCase() === from.toLowerCase())), ...toHere.filter((t) => t.from.includes('*'))];
    let t: StateTransition | undefined;
    if (chosen && chosen.fieldId === u.field.id) {
      t = live.transitions.find((x) => x.name.toLowerCase() === chosen.name.toLowerCase());
      const ways = exits(live.transitions, from);
      if (!t) {
        throw refused(`${u.field.name} has no transition “${chosen.name}”`, `From ${from} it can go to ${ways.words}.`, { field: u.field.name, from, to }, 'machine.noTransition', {
          field: u.field.name,
          transition: chosen.name,
          from,
          ...ways.values,
        });
      }
      if (!fits.includes(t)) {
        throw refused(`“${t.name}” doesn't go from ${from}`, `${rid} is ${from}. From there it can go to ${ways.words}.`, { field: u.field.name, from, to, transition: t.name }, 'machine.wrongStart', {
          transition: t.name,
          from,
          issue: rid,
          ...ways.values,
        });
      }
    } else t = fits[0];
    if (!t) {
      const ways = exits(live.transitions, from);
      throw refused(`${u.field.name} can't go from ${from} to ${to}`, `From ${from} it can go to ${ways.words}.`, {
        field: u.field.name,
        from,
        to,
        transitions: live.transitions.filter((x) => x.from.includes('*') || x.from.some((f) => f.toLowerCase() === from.toLowerCase())).map((x) => ({ name: x.name, to: x.to })),
      }, 'machine.cantMove', { field: u.field.name, from, to, ...ways.values });
    }
    if (t.condition) {
      const when = condition(ruleWorld(s, issue.projectId), t.condition, { meId: ctx.actor.user.id });
      if (when.where && !(await meets(tx, issue.id, [when.where]))[0]) {
        throw refused(`“${t.name}” needs ${rid} to match “${t.condition}” first`, `It's what moving ${u.field.name} from ${from} to ${to} asks.`, { field: u.field.name, from, to, transition: t.name }, 'machine.needsCondition', {
          transition: t.name,
          issue: rid,
          condition: t.condition,
          field: u.field.name,
          from,
          to,
        });
      }
    }
    moves.push({ field: u.field, transition: t, from, to });
  }
  return moves;
}

/** What the moves' transitions also do, as whoever makes them: their commands, read on the issue as it is in `tx`. */
export async function transitionSpecs(tx: Db, ctx: Ctx, s: SchemaSnapshot, issue: IssueRow, moves: Move[]): Promise<ChangeSpec[]> {
  const out: ChangeSpec[] = [];
  for (const m of moves) {
    if (!m.transition.command) continue;
    const parsed = parseCommand(m.transition.command, s, [issue.projectId]);
    if (parsed.problems.length) throw badRequest(`The transition “${m.transition.name}” no longer fits: ${parsed.problems.map((p) => p.message).join('; ')}`).said('workflow.transitionMisfit', { transition: m.transition.name, problems: saidProblems(parsed.problems) });
    out.push({ ...(await commandSpec(ctx, issue, parsed.ops, undefined, { db: tx })), data: { transition: m.transition.name } });
  }
  return out;
}

// ---------------------------------------------------------------------------
// On the issue page: the moves from where an issue is
// ---------------------------------------------------------------------------

export async function canWrite(ctx: Ctx, projectId: string): Promise<boolean> {
  return assertCanWriteProject(ctx, projectId).then(
    () => true,
    () => false,
  );
}

/** The transitions out of each governed field's state, for someone who may change the issue: whether each can be made now, and why not. */
export async function issueTransitions(ctx: Ctx, s: SchemaSnapshot, issue: IssueRow, values: Map<string, ResolvedValue[]>) {
  const out: { field: string; name: string; to: string; allowed: boolean; why: string | null }[] = [];
  for (const m of machinesFor(s, issue.projectId)) {
    const field = s.fields.get(m.fieldId);
    if (!field) continue;
    const live = liveMachine(s, issue.projectId, field);
    if (!live) continue;
    const from = named(s, values.get(field.id));
    if (!from) continue;
    for (const t of live.transitions) {
      if (t.to.toLowerCase() === from.toLowerCase()) continue;
      if (!t.from.includes('*') && !t.from.some((f) => f.toLowerCase() === from.toLowerCase())) continue;
      let why: string | null = null;
      if (t.condition) {
        const when = condition(ruleWorld(s, issue.projectId), t.condition, { meId: ctx.actor.user.id });
        if (when.where && !(await meets(ctx.db, issue.id, [when.where]))[0]) why = `It needs the issue to match “${t.condition}”`;
      }
      out.push({ field: field.name, name: t.name, to: t.to, allowed: !why, why });
    }
  }
  return out;
}
