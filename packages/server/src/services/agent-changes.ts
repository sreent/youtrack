/**
 * What a change an agent made on its own keeps, so a person can undo it (docs/architecture.md, D34).
 *
 * The write path (applyChanges) keeps it in the change's own transaction. The undo itself, and
 * reading where each change stands, are in services/agents.ts, which needs the write path; this
 * module doesn't, so the write path can use it without a cycle.
 */
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

export const textHash = (text: string): string => sha256(text);

/** Keep what undoing an agent's change needs, beside its activity, in the change's transaction. */
export async function keepAgentChange(
  tx: Db,
  ctx: Ctx,
  input: { issueId: string; activityId: number; pairActivityId?: number | null; undo: AgentUndo },
): Promise<void> {
  await tx.insert(agentChanges).values({
    id: newId(),
    issueId: input.issueId,
    activityId: input.activityId,
    pairActivityId: input.pairActivityId ?? null,
    undo: input.undo,
    actorId: ctx.actor.user.id,
  });
}
