/**
 * The assistant's turn while it streams: what the person said, and what the agent says and does
 * as it happens. It lives outside React (a tiny store per conversation), so a turn keeps going,
 * and keeps its view, when the person opens another conversation or the page changes its address.
 * When the turn is done, the stored conversation takes its place.
 */
import type { ChatPart, ChatStreamEvent, ConversationDetail } from '@a4a/shared';
import type { QueryClient } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { ApiError, get, postStream } from '../../api/client';
import { keys } from '../../api/queries';

export type Approval = ConversationDetail['pendingApprovals'][number];
export type ToolStatus = Extract<ChatPart, { type: 'tool' }>['status'];

export interface LiveTool {
  kind: 'tool';
  id: string;
  name: string;
  input: unknown;
  write: boolean;
  status: ToolStatus;
  summary: string | null;
  /** When it started, and how long it took once it ended. */
  at: string;
  ms?: number;
  /** A change made without asking, because the person let it act. */
  onItsOwn: boolean;
}

export type LivePart =
  | { kind: 'text'; text: string }
  | { kind: 'progress'; text: string }
  | LiveTool
  | { kind: 'notice'; text: string }
  | { kind: 'error'; text: string };

export interface LiveTurn {
  conversationId: string;
  /** How many stored messages show above the live turn (the rest arrive with it). */
  base: number;
  /** What the person just said, shown at once. */
  said?: string;
  parts: LivePart[];
  /** Changes waiting on the person, as they arrive. */
  approvals: Approval[];
  /** Results for tools already stored (the ones the person just decided on). */
  results: Record<string, { ok: boolean; summary: string; declined: boolean }>;
  running: boolean;
  auto: boolean;
  /** A step began; the next words start a new part. */
  fresh: boolean;
  /** It changed something, so the tracker's lists are re-read when it ends. */
  wrote: boolean;
  /** The request failed before the agent could answer (the turn wasn't stored). */
  failed?: { message: string; hint?: string };
  /** Who decided what, in an approve turn. */
  decisions?: Record<string, boolean>;
  /** Which turn this is, so a late refresh never clears a newer one. */
  seq: number;
}

const turns = new Map<string, LiveTurn>();
let seqs = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function set(id: string, turn: LiveTurn | undefined) {
  if (turn) turns.set(id, turn);
  else turns.delete(id);
  emit();
}

function update(id: string, fn: (t: LiveTurn) => LiveTurn) {
  const t = turns.get(id);
  if (t) set(id, fn(t));
}

export function useLiveTurn(id: string | undefined): LiveTurn | undefined {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => (id ? turns.get(id) : undefined),
  );
}

/** Any conversation with a turn under way (for the list). */
export function useRunningIds(): Set<string> {
  const snapshot = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => runningKey,
  );
  return new Set(snapshot ? snapshot.split(',') : []);
}
let runningKey = '';
listeners.add(() => {
  runningKey = [...turns.values()]
    .filter((t) => t.running)
    .map((t) => t.conversationId)
    .sort()
    .join(',');
});

export function forget(id: string) {
  const t = turns.get(id);
  if (t && !t.running) set(id, undefined);
}

function addWords(parts: LivePart[], kind: 'text' | 'progress', text: string, fresh: boolean): LivePart[] {
  const last = parts[parts.length - 1];
  if (!fresh && last && last.kind === kind) return [...parts.slice(0, -1), { kind, text: last.text + text }];
  return [...parts, { kind, text }];
}

function onEvent(id: string, e: ChatStreamEvent) {
  update(id, (t) => {
    switch (e.type) {
      case 'message_start':
        return { ...t, fresh: true };
      case 'text_delta':
        return { ...t, parts: addWords(t.parts, 'text', e.text, t.fresh), fresh: false };
      case 'progress':
        return { ...t, parts: addWords(t.parts, 'progress', e.text, t.fresh), fresh: false };
      case 'tool_start':
        return {
          ...t,
          fresh: true,
          parts: [
            ...t.parts,
            { kind: 'tool', id: e.id, name: e.name, input: e.input, write: e.write, status: 'running', summary: null, at: new Date().toISOString(), onItsOwn: t.auto && e.write },
          ],
        };
      case 'tool_result': {
        const declined = t.decisions?.[e.id] === false;
        let found = false;
        let wrote = t.wrote;
        const parts = t.parts.map((p) => {
          if (p.kind !== 'tool' || p.id !== e.id) return p;
          found = true;
          if (e.ok && p.write) wrote = true;
          return { ...p, status: e.ok ? 'done' : declined ? 'rejected' : 'error', summary: e.summary, ms: Date.now() - new Date(p.at).getTime() } as LiveTool;
        });
        if (found) return { ...t, parts, wrote };
        // A tool stored before this turn: one the person just decided on.
        if (e.ok && t.decisions?.[e.id]) wrote = true;
        return { ...t, wrote, results: { ...t.results, [e.id]: { ok: e.ok, summary: e.summary, declined } } };
      }
      case 'approval_required': {
        const waiting = new Set(e.approvals.map((a) => a.toolUseId));
        return {
          ...t,
          approvals: e.approvals,
          parts: t.parts.map((p) => (p.kind === 'tool' && waiting.has(p.id) ? { ...p, status: 'pending_approval' as const } : p)),
        };
      }
      case 'notice':
        return { ...t, fresh: true, parts: [...t.parts, { kind: 'notice', text: e.text }] };
      case 'error':
        return { ...t, fresh: true, parts: [...t.parts, { kind: 'error', text: e.message }] };
      case 'done':
        return t;
      default:
        return t;
    }
  });
}

/**
 * Say something, or answer the changes waiting on the person, and stream the agent's turn. When
 * it ends, the stored conversation replaces the live view, and what it changed is re-read.
 */
export async function runTurn(
  qc: QueryClient,
  opts: {
    conversationId: string;
    base: number;
    said?: string;
    auto: boolean;
    path: 'messages' | 'approve';
    body: unknown;
    decisions?: Record<string, boolean>;
  },
): Promise<void> {
  const id = opts.conversationId;
  if (turns.get(id)?.running) return;
  const seq = ++seqs;
  const mine = () => turns.get(id)?.seq === seq;
  set(id, {
    seq,
    conversationId: id,
    base: opts.base,
    said: opts.said,
    parts: [],
    approvals: [],
    results: {},
    running: true,
    auto: opts.auto,
    fresh: true,
    wrote: Boolean(opts.decisions && Object.values(opts.decisions).some(Boolean)),
    decisions: opts.decisions,
  });
  let failed: LiveTurn['failed'];
  try {
    await postStream<ChatStreamEvent>(`/ai/conversations/${id}/${opts.path}`, opts.body, (e) => onEvent(id, e));
  } catch (err) {
    failed = err instanceof ApiError ? { message: err.message, hint: err.hint } : { message: err instanceof Error ? err.message : 'The assistant could not be reached' };
  }
  const wrote = turns.get(id)?.wrote ?? false;
  // The turn stays "running" until the stored conversation is read back, so nobody answers a
  // card the stored conversation doesn't have yet.
  try {
    const detail = await get<ConversationDetail>(`/ai/conversations/${id}`);
    qc.setQueryData(keys.conversation(id), detail);
    // A failed request stored nothing: keep it in view, so the person sees why.
    if (mine()) {
      if (failed) update(id, (t) => ({ ...t, running: false, failed }));
      else set(id, undefined);
    }
  } catch {
    // The conversation could not be read back; keep what streamed.
    if (mine()) update(id, (t) => ({ ...t, running: false, failed }));
  }
  void qc.invalidateQueries({ queryKey: keys.conversations });
  if (wrote) {
    for (const k of [['issues'], ['boards'], ['events'], ['plan'], ['ai', 'suggestions']]) void qc.invalidateQueries({ queryKey: k });
  }
}
