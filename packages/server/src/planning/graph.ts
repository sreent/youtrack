/**
 * The plan's structure: the parent/child hierarchy, and the finish-to-start
 * dependency graph between leaf tasks. A summary's dependencies are expanded
 * to its leaves, invalid links are dropped and cycles are broken, each with a
 * warning, so the schedule can always be computed.
 */
import type { PlanTaskInput } from './types';
import { compareIds, pushTo } from './util';

export interface PlanGraph {
  /** All task ids, natural order. */
  ids: string[];
  parent: Map<string, string | null>;
  /** Direct children, natural order. */
  children: Map<string, string[]>;
  depth: Map<string, number>;
  /** Ancestors, nearest first. */
  ancestors: Map<string, string[]>;
  /** Leaf tasks (no children in the plan), natural order. */
  leaves: string[];
  isLeaf: (id: string) => boolean;
  /** Leaf descendants of each summary task. */
  leafDescendants: Map<string, string[]>;
  /** All descendants of each summary task, summaries included. */
  descendants: Map<string, string[]>;
  /** Valid in-plan predecessors as given (summary ids kept): what the UI draws. */
  predecessors: Map<string, string[]>;
  /** Scheduling edges between leaves, acyclic. */
  leafPreds: Map<string, string[]>;
  leafSuccs: Map<string, string[]>;
  /** Leaves in topological order (ties by id). */
  order: string[];
}

/** Builds the hierarchy and the leaf dependency graph; `tasks` must have unique ids. */
export function buildGraph(tasks: readonly PlanTaskInput[], warn: (message: string) => void): PlanGraph {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const ids = [...byId.keys()].sort(compareIds);
  const parent = resolveParents(byId, ids, warn);

  const children = new Map<string, string[]>();
  for (const id of ids) {
    const p = parent.get(id);
    if (p) pushTo(children, p, id);
  }
  const isLeaf = (id: string): boolean => !children.has(id);
  const ancestors = new Map(ids.map((id) => [id, ancestorsOf(id, parent)]));
  const depth = new Map(ids.map((id) => [id, ancestors.get(id)!.length]));
  const leaves = ids.filter(isLeaf);
  const descendants = new Map<string, string[]>();
  const leafDescendants = new Map<string, string[]>();
  for (const id of ids) {
    if (isLeaf(id)) continue;
    const all = descendantsOf(id, children);
    descendants.set(id, all);
    leafDescendants.set(id, all.filter(isLeaf));
  }

  const predecessors = validPredecessors(byId, ids, ancestors, warn);
  // Cycles between issues as written (clear messages), then any the hierarchy adds.
  const issueEdges = new Map(ids.map((id) => [id, [...predecessors.get(id)!]]));
  for (const cycle of breakCycles(ids, issueEdges)) warn(`Dependency cycle: ${cycle.join(' → ')}`);
  const leafPreds = expandToLeaves(leaves, ancestors, issueEdges, isLeaf, leafDescendants);
  for (const cycle of breakCycles(leaves, leafPreds)) warn(`Dependency cycle: ${cycle.join(' → ')}`);

  const leafSuccs = new Map<string, string[]>(leaves.map((id) => [id, []]));
  for (const id of leaves) for (const p of leafPreds.get(id)!) leafSuccs.get(p)!.push(id);
  for (const list of leafSuccs.values()) list.sort(compareIds);

  return {
    ids,
    parent,
    children,
    depth,
    ancestors,
    leaves,
    isLeaf,
    leafDescendants,
    descendants,
    predecessors,
    leafPreds,
    leafSuccs,
    order: topologicalOrder(leaves, leafPreds, leafSuccs),
  };
}

/** In-plan parent of each task; parent cycles are broken at their smallest id. */
function resolveParents(
  byId: Map<string, PlanTaskInput>,
  ids: readonly string[],
  warn: (message: string) => void,
): Map<string, string | null> {
  const parent = new Map<string, string | null>();
  for (const id of ids) {
    const p = byId.get(id)!.parent;
    parent.set(id, p && p !== id && byId.has(p) ? p : null);
  }
  for (const id of ids) {
    const walk: string[] = [];
    for (let cur: string | null = id; cur !== null; cur = parent.get(cur) ?? null) {
      const at = walk.indexOf(cur);
      if (at >= 0) {
        const loop = walk.slice(at);
        const top = [...loop].sort(compareIds)[0]!;
        parent.set(top, null);
        warn(`Parent cycle: ${[...loop, cur].join(' → ')}; ${top} is treated as a top-level task`);
        break;
      }
      walk.push(cur);
    }
  }
  return parent;
}

function ancestorsOf(id: string, parent: Map<string, string | null>): string[] {
  const out: string[] = [];
  for (let p = parent.get(id) ?? null; p !== null; p = parent.get(p) ?? null) out.push(p);
  return out;
}

function descendantsOf(id: string, children: Map<string, string[]>): string[] {
  const out: string[] = [];
  const stack = [...(children.get(id) ?? [])].reverse();
  while (stack.length > 0) {
    const cur = stack.pop()!;
    out.push(cur);
    stack.push(...[...(children.get(cur) ?? [])].reverse());
  }
  return out;
}

/** Drops self links, links outside the plan, and links to a task's own ancestor or subtask. */
function validPredecessors(
  byId: Map<string, PlanTaskInput>,
  ids: readonly string[],
  ancestors: Map<string, string[]>,
  warn: (message: string) => void,
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const id of ids) {
    const kept: string[] = [];
    for (const p of new Set(byId.get(id)!.predecessors)) {
      if (p === id) warn(`Dependency cycle: ${id} → ${id}`);
      else if (!byId.has(p)) warn(`${id} depends on ${p}, which is outside this plan`);
      else if (ancestors.get(id)!.includes(p)) warn(`${id} depends on ${p}, which contains it; ignored`);
      else if (ancestors.get(p)!.includes(id)) warn(`${id} depends on its own subtask ${p}; ignored`);
      else kept.push(p);
    }
    result.set(id, kept.sort(compareIds));
  }
  return result;
}

/** A leaf inherits its ancestors' predecessors; a summary predecessor stands for its leaves. */
function expandToLeaves(
  leaves: readonly string[],
  ancestors: Map<string, string[]>,
  edges: Map<string, string[]>,
  isLeaf: (id: string) => boolean,
  leafDescendants: Map<string, string[]>,
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const leaf of leaves) {
    const preds = new Set<string>();
    for (const source of [leaf, ...ancestors.get(leaf)!]) {
      for (const p of edges.get(source)!) {
        for (const l of isLeaf(p) ? [p] : leafDescendants.get(p)!) if (l !== leaf) preds.add(l);
      }
    }
    result.set(leaf, [...preds].sort(compareIds));
  }
  return result;
}

/**
 * Removes the back edges a depth-first search finds (visiting `nodes` and each
 * predecessor list in order), which leaves `preds` acyclic. Mutates the lists
 * in `preds`. Returns each cycle as a path that starts and ends at the same id,
 * read as "depends on".
 */
export function breakCycles(nodes: readonly string[], preds: Map<string, string[]>): string[][] {
  const state = new Map<string, 'open' | 'done'>();
  const cycles: string[][] = [];
  for (const root of nodes) {
    if (state.has(root)) continue;
    const stack: { id: string; next: number }[] = [{ id: root, next: 0 }];
    state.set(root, 'open');
    while (stack.length > 0) {
      const top = stack[stack.length - 1]!;
      const list = preds.get(top.id) ?? [];
      if (top.next >= list.length) {
        state.set(top.id, 'done');
        stack.pop();
        continue;
      }
      const p = list[top.next]!;
      if (state.get(p) === 'open') {
        const path = stack.map((s) => s.id);
        cycles.push([...path.slice(path.indexOf(p)), p]);
        list.splice(top.next, 1);
        continue;
      }
      top.next++;
      if (!state.has(p)) {
        state.set(p, 'open');
        stack.push({ id: p, next: 0 });
      }
    }
  }
  return cycles;
}

/** Kahn's algorithm; among ready tasks the smallest id goes first. */
function topologicalOrder(
  nodes: readonly string[],
  preds: Map<string, string[]>,
  succs: Map<string, string[]>,
): string[] {
  const waiting = new Map(nodes.map((id) => [id, preds.get(id)!.length]));
  const ready = nodes.filter((id) => waiting.get(id) === 0);
  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const s of succs.get(id)!) {
      const left = waiting.get(s)! - 1;
      waiting.set(s, left);
      if (left === 0) insertSorted(ready, s);
    }
  }
  // Unreachable after breakCycles; kept so a bug can never drop a task.
  if (order.length < nodes.length) order.push(...nodes.filter((id) => !order.includes(id)));
  return order;
}

function insertSorted(list: string[], id: string): void {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (compareIds(list[mid]!, id) < 0) lo = mid + 1;
    else hi = mid;
  }
  list.splice(lo, 0, id);
}
