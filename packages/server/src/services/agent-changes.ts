/**
 * What a change keeps so it can be undone (docs/architecture.md, D34 and its revisit): a change an
 * agent made on its own, which a person who may change the issue undoes, and a person's edit in a
 * view, which only that person undoes, for VIEW_EDIT_UNDO_DAYS.
 *
 * The write path (applyChanges) keeps it in the change's own transaction. The undo itself, and
 * reading where each change stands, are in services/agents.ts, which needs the write path; this
 * module doesn't, so the write path can use it without a cycle.
 */
import { VIEW_EDIT_UNDO_DAYS, type ViewKind } from '@a4a/shared';
import { and, eq, lt } from 'drizzle-orm';
import type { Ctx } from '../context';
import type { Db } from '../db/client';
import { agentChanges } from '../db/schema';
import { sha256 } from '../lib/crypto';
import { newId } from '../lib/ids';
import type { ResolvedValue } from './values';

/** An agent changed fields, the summary or description, or tags: what they were, and what it left. */
export interface FieldsUndo {
  kind: 'fields';
  /** Each field it changed, by id (a field can be renamed; its name then is for words alone), as stored. */
  fields: { fieldId: string; name: string; before: ResolvedValue[]; after: ResolvedValue[] }[];
  summary?: { before: string; after: string };
  /** The description before, whole. What it left is on the issue, so only its hash is kept. */
  description?: { before: string; afterHash: string };
  /** Tags it added, and tags it took off, by their names. */
  tags?: { added: string[]; removed: string[] };
}

/** An agent made a link (undoing it takes it away) or took one away (undoing it makes it again). */
export interface LinkUndo {
  kind: 'link';
  typeId: string;
  sourceId: string;
  targetId: string;
  created: boolean;
}

export type AgentUndo = FieldsUndo | LinkUndo;

/**
 * Whose undo a kept change is: an agent's change on its own, which anyone who may change the issue
 * undoes (D34); or a person's edit in a view, which only they undo (D34's revisit).
 */
export type ChangeKind = 'agent' | 'view';

/**
 * Whether a change is an agent's own, so a person may undo it: made by an agent's account (one an
 * administrator added and gave a token, or a4a's own, such as triage and the workflow agent), or by an
 * agent for a person: over MCP, or the assistant. A person's own change (on the web, through the API,
 * by their commit), a requester's through the help desk, and a4a's own housekeeping aren't.
 */
export function actsAsAgent(ctx: Ctx): boolean {
  const { user, channel } = ctx.actor;
  if (user.id === 'system' || channel === 'helpdesk' || channel === 'vcs' || channel === 'ci' || channel === 'system') return false;
  return user.isBot || channel === 'mcp' || channel === 'assistant' || channel === 'automation';
}

/** How a change that's kept is kept: whose undo it is, the view it was made in, and its group. */
export interface Keeping {
  kind: ChangeKind;
  view: ViewKind | null;
  /** The change it is part of; null while it is one row on its own. */
  groupId: string | null;
}

/**
 * Whether the write path keeps what undoing a change needs, and how (D34 and its revisit). An agent's
 * change on its own is kept as an agent's, even made in a view: anyone who may change the issue undoes
 * it, as ever. A person's edit in a view is kept as theirs. Anything else isn't kept: a person's own
 * change elsewhere, an import (history, not news), an undo (redone by making the change again), and a
 * requester's words or a commit's command, which aren't an agent's.
 */
export function keepingFor(ctx: Ctx, spec: { view?: { name: ViewKind; group?: string }; data?: Record<string, unknown> }): Keeping | null {
  const data = spec.data as { imported?: unknown; undoes?: unknown } | undefined;
  if (data?.imported || data?.undoes !== undefined) return null;
  const agent = actsAsAgent(ctx);
  const inView = spec.view !== undefined && ctx.actor.user.id !== 'system' && !['helpdesk', 'vcs', 'ci', 'system'].includes(ctx.actor.channel);
  if (!agent && !inView) return null;
  return { kind: agent ? 'agent' : 'view', view: spec.view?.name ?? null, groupId: spec.view?.group ?? null };
}

export const textHash = (text: string): string => sha256(text);

/** Keep what undoing a change needs, beside its activity, in the change's transaction. */
export async function keepAgentChange(
  tx: Db,
  ctx: Ctx,
  input: { issueId: string; activityId: number; pairActivityId?: number | null; undo: AgentUndo; keeping?: Keeping },
): Promise<void> {
  await tx.insert(agentChanges).values({
    id: newId(),
    issueId: input.issueId,
    activityId: input.activityId,
    pairActivityId: input.pairActivityId ?? null,
    undo: input.undo,
    actorId: ctx.actor.user.id,
    kind: input.keeping?.kind ?? 'agent',
    groupId: input.keeping?.groupId ?? null,
    view: input.keeping?.view ?? null,
  });
}

/** A new group, for a request that makes several changes at once and was given none. */
export const newGroupId = (): string => newId(20);

/**
 * Housekeeping: what undoing a person's view edit needs is kept VIEW_EDIT_UNDO_DAYS, then goes; the
 * edit stays in the history, as any change. An agent's change stays undoable for good (D34).
 */
export async function pruneViewEdits(db: Db, now: Date = new Date()): Promise<number> {
  const before = new Date(now.getTime() - VIEW_EDIT_UNDO_DAYS * 86_400_000);
  const gone = await db
    .delete(agentChanges)
    .where(and(eq(agentChanges.kind, 'view'), lt(agentChanges.createdAt, before)))
    .returning({ id: agentChanges.id });
  return gone.length;
}
