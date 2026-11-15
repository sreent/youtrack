/**
 * Baselines: which one the plan is compared against (kept in the page's address, so the
 * timeline and the costs share it), and saving the plan as it stands as a new one.
 */
import type { Baseline } from '@a4a/shared';
import { useEffect, useId, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { ApiError } from '../../api/client';
import { useBaselines, useSaveBaseline } from './api';
import { dayMonth, localToday } from './dates';

export interface BaselineChoice {
  baselines: Baseline[];
  /** The one in force: chosen in the address, else the latest; null for none. */
  chosen: Baseline | null;
  choose(id: string | null): void;
  /** False until the list is known, so nothing is read against the wrong one. */
  ready: boolean;
  error: unknown;
}

export function useBaselineChoice(projectKey: string): BaselineChoice {
  const list = useBaselines(projectKey);
  const [params, setParams] = useSearchParams();
  const raw = params.get('baseline');
  const baselines = list.data ?? [];
  const chosen = raw === 'none' ? null : ((raw ? baselines.find((b) => b.id === raw) : undefined) ?? baselines[0] ?? null);
  return {
    baselines,
    chosen,
    ready: !list.isLoading,
    error: list.error,
    choose: (id) =>
      setParams(
        (p) => {
          const next = new URLSearchParams(p);
          next.set('baseline', id ?? 'none');
          return next;
        },
        { replace: true },
      ),
  };
}

const savedOn = (b: Baseline) => dayMonth(b.createdAt.slice(0, 10));

export function BaselinePicker({ choice, label = 'Compare with' }: { choice: BaselineChoice; label?: string }) {
  const id = useId();
  if (!choice.baselines.length) return null;
  return (
    <span className="a4-inline-field">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={choice.chosen?.id ?? 'none'} onChange={(e) => choice.choose(e.target.value === 'none' ? null : e.target.value)}>
        {choice.baselines.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name}, saved {savedOn(b)}
          </option>
        ))}
        <option value="none">No baseline</option>
      </select>
    </span>
  );
}

/** Save the plan as it stands as a baseline, in the browser's own dialog. */
export function SaveBaselineDialog({ projectKey, open, onClose, onSaved }: { projectKey: string; open: boolean; onClose: () => void; onSaved: (b: Baseline) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const save = useSaveBaseline(projectKey);
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; hint?: string } | null>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      setName(`Plan of ${dayMonth(localToday())}`);
      setNote('');
      setError(null);
      d.showModal();
    } else if (!open && d.open) d.close();
  }, [open]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const b = await save({ name: name.trim(), note: note.trim() });
      onSaved(b);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? { text: err.message, hint: err.hint } : { text: "The baseline wasn't saved: a4a couldn't reach the server." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog ref={ref} className="dialog" aria-labelledby={titleId} onClose={onClose}>
      <h2 id={titleId}>Save a baseline</h2>
      <p>A baseline keeps the plan as it stands now: each task's dates, effort and cost. The timeline then shows how far each task has moved from it, and the costs what's been earned against it.</p>
      <form className="a4-form" onSubmit={submit}>
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} autoFocus />
        </label>
        <label>
          A note, if you want one
          <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} rows={3} placeholder="Why now, and who agreed it" />
        </label>
        {error ? (
          <div className="a4-error" role="alert">
            <p>{error.text}</p>
            {error.hint ? <p className="note">{error.hint}</p> : null}
          </div>
        ) : null}
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy || !name.trim()}>
            {busy ? 'Saving…' : 'Save the baseline'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
