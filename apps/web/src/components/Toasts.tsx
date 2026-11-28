import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type FocusEvent, type ReactNode } from 'react';
import { sentences, t } from '../i18n';
import { Icon } from './Icon';

/**
 * Ocean's toasts: what was just done, said once at the foot of the window, with Undo while it can be
 * undone (D72). The provider is mounted in the shell. Their region is a landmark that's always in the
 * page, reached with F8, with a status line of its own that says each toast once, politely: its words,
 * and with Undo how to undo from the keyboard, unless the page said it already. The toasts themselves
 * aren't live, so nothing is said twice. A toast is never the only place something is said: the page
 * says it too, and never shows one for what went wrong or needs the person.
 */

/** What a toast says, and what it offers. */
export interface ToastInput {
  /** What was just done, named in the past tense, in the reader's language: "Moved BACK-12 to 3 March." */
  words: string;
  /**
   * Undo, while it can be undone: a button, and the page's key too (Ctrl+Z, ⌘Z on a Mac), which the
   * status line says. Pressing it closes the toast and runs it, once.
   */
  undo?: () => void;
  /** Another button beside the words: pressing it closes the toast and runs `run`, once. */
  action?: { label: string; run: () => void };
  /** A toast shown with the key of one still standing takes its place, rather than standing beside it. */
  key?: string;
  /** The page said it already where it happened (its own live region): shown, and not said again. */
  saidOnPage?: boolean;
}

export interface ToastApi {
  /** Show a toast; its id, to take it away early. */
  show: (toast: ToastInput) => string;
  /** Take a toast away at once, as when what it offers can no longer be done. */
  dismiss: (id: string) => void;
}

interface Shown extends ToastInput {
  id: string;
  /** How long it stands, unheld. */
  ms: number;
}

/** Six seconds, ten with Undo: something to decide, and to reach. */
const MIN_MS = 6000;
const UNDO_MS = 10_000;
/** And a second more for every ten words past the first ten. */
const WORDS_FREE = 10;
const PER_TEN_WORDS_MS = 1000;
/** At most three at a time, the newest at the foot. */
const AT_MOST = 3;
/** The key that reaches the region, said to assistive technology on it. */
const REGION_KEY = 'F8';

/** Its words, counted as its language counts them: by the spaces between them, or by Intl's segments where there are none (Japanese, Chinese, Thai). */
function wordCount(text: string): number {
  const Segmenter = (Intl as { Segmenter?: new (locale?: string, o?: { granularity: 'word' }) => { segment(s: string): Iterable<{ isWordLike?: boolean }> } }).Segmenter;
  if (Segmenter) {
    let n = 0;
    for (const part of new Segmenter(undefined, { granularity: 'word' }).segment(text)) if (part.isWordLike) n += 1;
    return n;
  }
  return text.split(/\s+/).filter(Boolean).length;
}

/** How long a toast stands before it goes, unless held (Ocean's Toast). */
export function readingTime(toast: Pick<ToastInput, 'words' | 'undo' | 'action'>): number {
  const extra = Math.max(0, Math.ceil((wordCount(toast.words) - WORDS_FREE) / 10)) * PER_TEN_WORDS_MS;
  return (toast.undo || toast.action ? UNDO_MS : MIN_MS) + extra;
}

/** Whether this is a Mac, whose undo is ⌘Z. */
export function onMac(): boolean {
  const nav = typeof navigator === 'undefined' ? undefined : (navigator as Navigator & { userAgentData?: { platform?: string } });
  return /mac|iphone|ipad/i.test(nav?.userAgentData?.platform ?? nav?.platform ?? '');
}

const ToastContext = createContext<ToastApi | null>(null);
/** Outside the shell (a guest's page, the portal), where nothing is undone, a toast shows nowhere. */
const NOWHERE: ToastApi = { show: () => '', dismiss: () => {} };

/** Show what was just done. Outside the shell, showing one does nothing. */
export function useToast(): ToastApi {
  return useContext(ToastContext) ?? NOWHERE;
}

let counted = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Shown[]>([]);
  // What the status line says: emptied before each toast's words, so the same words twice are said again.
  const [said, setSaid] = useState('');
  const saying = useRef<number | undefined>(undefined);
  const dismiss = useCallback((id: string) => setToasts((all) => all.filter((x) => x.id !== id)), []);
  const show = useCallback((toast: ToastInput) => {
    counted += 1;
    // A new id each time, so a toast that takes another's place is said again.
    const shown: Shown = { ...toast, id: `toast-${counted}`, ms: readingTime(toast) };
    setToasts((all) => [...all.filter((x) => !toast.key || x.key !== toast.key), shown].slice(-AT_MOST));
    if (!toast.saidOnPage) {
      window.clearTimeout(saying.current);
      setSaid('');
      const words = toast.undo ? sentences([toast.words, t('components.toasts.undoKeys', { mac: onMac() ? 'yes' : 'no' })]) : toast.words;
      saying.current = window.setTimeout(() => setSaid(words), 50);
    }
    return shown.id;
  }, []);
  useEffect(() => () => window.clearTimeout(saying.current), []);
  const api = useMemo<ToastApi>(() => ({ show, dismiss }), [show, dismiss]);
  return (
    <ToastContext.Provider value={api}>
      {children}
      <ToastList toasts={toasts} said={said} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

/** Whether the page is out of sight (another tab, a minimised window): a toast waits for it. */
function usePageHidden(): boolean {
  const [hidden, setHidden] = useState(() => typeof document !== 'undefined' && document.visibilityState === 'hidden');
  useEffect(() => {
    const seen = () => setHidden(document.visibilityState === 'hidden');
    document.addEventListener('visibilitychange', seen);
    return () => document.removeEventListener('visibilitychange', seen);
  }, []);
  return hidden;
}

function ToastList({ toasts, said, onDismiss }: { toasts: Shown[]; said: string; onDismiss: (id: string) => void }) {
  const hidden = usePageHidden();
  const region = useRef<HTMLElement>(null);
  // Where the focus was before it came to a toast, to go back to when that toast closes, or on F8.
  const cameFrom = useRef<HTMLElement | null>(null);
  const arrived = (e: FocusEvent<HTMLElement>) => {
    const from = e.relatedTarget;
    if (from instanceof HTMLElement && !e.currentTarget.contains(from)) cameFrom.current = from;
  };
  const goBack = useCallback(() => {
    const to = cameFrom.current;
    if (to?.isConnected) to.focus();
  }, []);
  // F8 reaches the newest toast's first button, and from the toasts, goes back where the focus was.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== REGION_KEY || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const here = region.current;
      if (!here) return;
      if (here.contains(document.activeElement)) {
        e.preventDefault();
        goBack();
        return;
      }
      const newest = [...here.querySelectorAll<HTMLElement>('.toast')].pop()?.querySelector<HTMLElement>('button');
      if (!newest) return;
      e.preventDefault();
      if (document.activeElement instanceof HTMLElement) cameFrom.current = document.activeElement;
      newest.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [goBack]);
  // Always there, empty or not, so what its status line says is heard; the toasts aren't live.
  return (
    <section ref={region} className="toasts" aria-label={t('components.toasts.region')} aria-keyshortcuts={REGION_KEY} onFocus={arrived}>
      <p className="hidden" role="status">
        {said}
      </p>
      {toasts.map((x) => (
        <ToastItem key={x.id} toast={x} paused={hidden} onDismiss={onDismiss} goBack={goBack} />
      ))}
    </section>
  );
}

function ToastItem({ toast, paused, onDismiss, goBack }: { toast: Shown; paused: boolean; onDismiss: (id: string) => void; goBack: () => void }) {
  const [pointed, setPointed] = useState(false);
  const [focused, setFocused] = useState(false);
  const left = useRef(toast.ms);
  const held = pointed || focused;
  const self = useRef<HTMLDivElement>(null);
  const close = useCallback(() => {
    const hadFocus = Boolean(self.current?.contains(document.activeElement));
    onDismiss(toast.id);
    if (hadFocus) goBack();
  }, [goBack, onDismiss, toast.id]);
  // It counts down only while nothing holds it and the page is in sight, from where it was.
  useEffect(() => {
    if (held || paused) return;
    const began = Date.now();
    const timer = window.setTimeout(() => onDismiss(toast.id), Math.max(0, left.current));
    return () => {
      window.clearTimeout(timer);
      left.current -= Date.now() - began;
    };
  }, [held, paused, onDismiss, toast.id]);
  const wordsId = `${toast.id}-words`;
  const press = (run: () => void) => () => {
    close();
    run();
  };
  return (
    <div
      ref={self}
      className="toast"
      onPointerEnter={() => setPointed(true)}
      onPointerLeave={() => setPointed(false)}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
      }}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        e.stopPropagation();
        close();
      }}
    >
      <Icon name="check" />
      <p className="toast-words" id={wordsId}>
        {toast.words}
      </p>
      {toast.undo ? (
        <button type="button" className="small" aria-describedby={wordsId} onClick={press(toast.undo)}>
          {t('components.toasts.undo')}
        </button>
      ) : null}
      {toast.action ? (
        <button type="button" className="small" aria-describedby={wordsId} onClick={press(toast.action.run)}>
          {toast.action.label}
        </button>
      ) : null}
      <button type="button" aria-label={t('components.toasts.dismiss')} aria-describedby={wordsId} onClick={close}>
        <Icon name="cross" />
      </button>
    </div>
  );
}
