import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type FocusEvent, type ReactNode } from 'react';
import { t } from '../i18n';
import { Icon } from './Icon';

/**
 * Ocean's toasts: what was just done, said once at the foot of the window, with Undo while it can be
 * undone (D72). The provider is mounted in the shell, and draws them in a live region that's always
 * there, so a screen reader says each as it comes. A toast is never the only place something is said:
 * the page says it too, and never shows one for what needs the person.
 */

/** What a toast says, and what it offers. */
export interface ToastInput {
  /** What was just done, named in the past tense, in the reader's language: "Moved BACK-12 to 3 March." */
  words: string;
  /** A button beside the words, such as Undo: pressing it closes the toast and runs `run`, once. */
  action?: { label: string; run: () => void };
  /** A toast shown with the key of one still standing takes its place, rather than standing beside it. */
  key?: string;
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

/** Ocean's six seconds, at least. */
const MIN_MS = 6000;
/** A toast that offers something (Undo) stands ten seconds at least: time to read it and reach its button. */
const ACTION_MS = 10_000;
/** And longer for more words: about a twentieth of a second a character, a slow reader's pace. */
const PER_CHARACTER_MS = 50;
/** Let go of after being held (the pointer or the focus on it), it stands at least this long more. */
const AFTER_HELD_MS = 2000;
/** At most three at a time, the newest at the foot. */
const AT_MOST = 3;

/** How long a toast stands before it goes, unless held. */
export function readingTime(toast: ToastInput): number {
  return Math.max(toast.action ? ACTION_MS : MIN_MS, toast.words.length * PER_CHARACTER_MS);
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
  const dismiss = useCallback((id: string) => setToasts((all) => all.filter((x) => x.id !== id)), []);
  const show = useCallback((toast: ToastInput) => {
    counted += 1;
    // A new id each time, so a toast that takes another's place is said again.
    const shown: Shown = { ...toast, id: `toast-${counted}`, ms: readingTime(toast) };
    setToasts((all) => [...all.filter((x) => !toast.key || x.key !== toast.key), shown].slice(-AT_MOST));
    return shown.id;
  }, []);
  const api = useMemo<ToastApi>(() => ({ show, dismiss }), [show, dismiss]);
  return (
    <ToastContext.Provider value={api}>
      {children}
      <ToastList toasts={toasts} onDismiss={dismiss} />
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

function ToastList({ toasts, onDismiss }: { toasts: Shown[]; onDismiss: (id: string) => void }) {
  const hidden = usePageHidden();
  // Where the focus was before it came to a toast, to go back to when that toast closes.
  const cameFrom = useRef<HTMLElement | null>(null);
  const arrived = (e: FocusEvent<HTMLDivElement>) => {
    const from = e.relatedTarget;
    if (from instanceof HTMLElement && !e.currentTarget.contains(from)) cameFrom.current = from;
  };
  const goBack = () => {
    const to = cameFrom.current;
    if (to?.isConnected) to.focus();
  };
  // Always there, empty or not: a live region says what comes into it only once it exists. Each toast
  // is said as it comes (not atomic), and those still standing aren't said again.
  return (
    <div className="toasts" role="status" aria-atomic="false" onFocus={arrived}>
      {toasts.map((x) => (
        <ToastItem key={x.id} toast={x} paused={hidden} onDismiss={onDismiss} goBack={goBack} />
      ))}
    </div>
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
  // It counts down only while nothing holds it and the page is in sight.
  useEffect(() => {
    if (held || paused) return;
    const began = Date.now();
    const timer = window.setTimeout(() => onDismiss(toast.id), left.current);
    return () => {
      window.clearTimeout(timer);
      left.current = Math.max(left.current - (Date.now() - began), AFTER_HELD_MS);
    };
  }, [held, paused, onDismiss, toast.id]);
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
      <p className="toast-words">{toast.words}</p>
      {toast.action ? (
        <button
          type="button"
          className="small"
          onClick={() => {
            const run = toast.action!.run;
            close();
            run();
          }}
        >
          {toast.action.label}
        </button>
      ) : null}
      <button type="button" aria-label={t('components.toasts.dismiss')} onClick={close}>
        <Icon name="cross" />
      </button>
    </div>
  );
}
