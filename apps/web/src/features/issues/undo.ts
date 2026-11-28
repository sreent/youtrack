import type { UndoResult, ViewUndo } from '@a4a/shared';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { ApiError, post } from '../../api/client';
import { onMac, useToast, type ToastApi } from '../../components/Toasts';
import { problemWords, t } from '../../i18n';

/**
 * Undo for your edits in a view (D34's revisit): a command on the list's chosen issues today, a drag
 * or a typed cell on the timeline next. Each edit you make on this page is remembered here, newest
 * last; its toast offers Undo, and so does Ctrl+Z (⌘Z on a Mac) with the focus anywhere but a field
 * that takes text, before its toast goes and after. Ctrl+Shift+Z makes the newest undone edit again,
 * by sending it again, as a new edit. What a key did is said in the toasts' status line; what stopped
 * it is said on the page (`useViewUndoProblem`), never in a toast.
 */

/** What a view that made an edit tells of it: what it said, what undoes it, and how to make it again. */
export interface ViewEditDone {
  /** What was just done, as its toast says it: "Changed 3 issues." */
  words: string;
  /** Said once it's undone: "Put 3 issues back as they were." */
  undoneWords: string;
  /** From the answer: POST /events/{event}/undo undoes it, with its group. */
  undo: ViewUndo;
  /** Make it again as a new edit (a redo): what that one is, or null when it changed nothing. */
  again: () => Promise<ViewEditDone | null>;
  /** The view said it already in its own live region (a timeline's keyboard move): its toast is shown, not said again. */
  saidOnPage?: boolean;
}

interface Edit extends ViewEditDone {
  id: number;
}

/** What a redo met that stopped it, already in the page's language: a view throws it from `again`. */
export class Refused extends Error {}

/** This page's edits: those standing, newest last, and those undone, which a redo makes again. */
const store = {
  done: [] as Edit[],
  undone: [] as Edit[],
  problem: null as string | null,
  busy: false,
  users: 0,
  listeners: new Set<() => void>(),
  /** The toasts and the cache of the page that uses it now. */
  toasts: null as ToastApi | null,
  qc: null as QueryClient | null,
};
let made = 0;
const changed = () => store.listeners.forEach((l) => l());
const setProblem = (problem: string | null) => {
  store.problem = problem;
  changed();
};

async function refresh(): Promise<void> {
  await Promise.all(['issues', 'boards', 'plan'].map((key) => store.qc?.invalidateQueries({ queryKey: [key] })));
}

function remember(edit: ViewEditDone, opts: { redo?: boolean } = {}): void {
  made += 1;
  const kept: Edit = { ...edit, id: made };
  store.done.push(kept);
  // A new edit of your own starts again what a redo makes; a redo leaves the rest of them.
  if (!opts.redo) store.undone = [];
  setProblem(null);
  store.toasts?.show({ words: edit.words, undo: () => void undoEdit(kept), key: 'view-edit', saidOnPage: edit.saidOnPage });
}

/** Undo one of your edits here: all of it or none, as you, through the write path. */
async function undoEdit(edit: Edit): Promise<void> {
  if (store.busy || !store.done.includes(edit)) return;
  store.busy = true;
  setProblem(null);
  try {
    await post<UndoResult>(`/events/${edit.undo.event}/undo`);
    store.done = store.done.filter((e) => e !== edit);
    store.undone.push(edit);
    store.toasts?.show({ words: edit.undoneWords, key: 'view-edit' });
  } catch (e) {
    // What changed since, and who changed it: said on the page, and that edit can't be undone now.
    store.done = store.done.filter((x) => x !== edit);
    setProblem(e instanceof ApiError ? (problemWords(e) ?? e.message) : t('issues.undo.couldNotUndo'));
  } finally {
    store.busy = false;
    await refresh();
    changed();
  }
}

/** Make the newest undone edit again, as a new edit, sent as it was the first time. */
async function redoNewest(): Promise<void> {
  const edit = store.undone[store.undone.length - 1];
  if (store.busy || !edit) return;
  store.busy = true;
  setProblem(null);
  store.undone = store.undone.filter((e) => e !== edit);
  try {
    const again = await edit.again();
    store.busy = false;
    if (again) remember(again, { redo: true });
    else setProblem(t('issues.undo.redoChangedNothing'));
  } catch (e) {
    store.busy = false;
    setProblem(e instanceof ApiError ? (problemWords(e) ?? e.message) : e instanceof Refused ? e.message : t('issues.undo.couldNotRedo'));
  } finally {
    await refresh();
    changed();
  }
}

/** A field that takes text keeps its own Ctrl+Z: the words typed in it. */
function takesText(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (!(target instanceof HTMLInputElement)) return false;
  return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file', 'image'].includes(target.type);
}

function onKey(e: KeyboardEvent): void {
  if (e.defaultPrevented || e.altKey || e.key.toLowerCase() !== 'z') return;
  if (!(onMac() ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey)) return;
  if (takesText(e.target) || document.querySelector('dialog[open]')) return;
  // Nothing of yours to undo or make again here: the key is left to whatever else takes it.
  const newest = e.shiftKey ? store.undone[store.undone.length - 1] : store.done[store.done.length - 1];
  if (!newest) return;
  e.preventDefault();
  if (e.shiftKey) void redoNewest();
  else void undoEdit(newest);
}

const subscribe = (listener: () => void) => {
  store.listeners.add(listener);
  return () => store.listeners.delete(listener);
};

/**
 * A view that makes edits: `remember` each as it lands, and Ctrl+Z and Ctrl+Shift+Z work on this page
 * while it's open (`active`). When the last view using it goes, so do its edits: they were this page's.
 */
export function useViewEdits(active = true): { remember: (edit: ViewEditDone) => void } {
  const toasts = useToast();
  const qc = useQueryClient();
  if (active) {
    store.toasts = toasts;
    store.qc = qc;
  }
  useEffect(() => {
    if (!active) return;
    store.users += 1;
    if (store.users === 1) document.addEventListener('keydown', onKey);
    return () => {
      store.users -= 1;
      if (store.users > 0) return;
      document.removeEventListener('keydown', onKey);
      store.done = [];
      store.undone = [];
      store.problem = null;
    };
  }, [active]);
  return { remember: useCallback((edit: ViewEditDone) => remember(edit), []) };
}

/** What stopped the last undo or redo here, in the page's language, for the page to say; null when nothing did. */
export function useViewUndoProblem(): { problem: string | null; clear: () => void } {
  const problem = useSyncExternalStore(subscribe, () => store.problem);
  return { problem, clear: useCallback(() => setProblem(null), []) };
}
