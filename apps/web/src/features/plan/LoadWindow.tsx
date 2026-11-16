/**
 * Which days the load grid shows (docs/architecture.md, D36): from today for two weeks, a month
 * or a quarter, or to the plan's end; or between two dates. Each person's choice is kept for them,
 * on every device, and the same on every plan.
 */
import type { LoadWindow, LoadWindowPreset } from '@a4a/shared';
import { useEffect, useState } from 'react';
import { FormField } from '../common/bits';
import { addDays, addMonths, localToday } from './dates';

const PRESETS: { value: LoadWindowPreset; words: string }[] = [
  { value: '2w', words: 'Two weeks' },
  { value: '1m', words: 'A month' },
  { value: '3m', words: 'A quarter' },
  { value: 'plan', words: 'To the plan’s end' },
];

/** The days a window shows, from `today`; none for the plan's own (today to its end). */
export function windowRange(w: LoadWindow | null, today = localToday()): { from?: string; to?: string } {
  if (!w) return {};
  if ('from' in w) return { from: w.from, to: w.to };
  if (w.preset === '2w') return { from: today, to: addDays(today, 13) };
  if (w.preset === '1m') return { from: today, to: addDays(addMonths(today, 1), -1) };
  if (w.preset === '3m') return { from: today, to: addDays(addMonths(today, 3), -1) };
  return {};
}

/** Ocean's choice of views for the presets, then two dates and a button. */
export function WindowChoice({ chosen, onChoose, busy }: { chosen: LoadWindow | null; onChoose: (w: LoadWindow | null) => void; busy?: boolean }) {
  const preset = !chosen ? 'plan' : 'preset' in chosen ? chosen.preset : null;
  const [from, setFrom] = useState(chosen && 'from' in chosen ? chosen.from : '');
  const [to, setTo] = useState(chosen && 'from' in chosen ? chosen.to : '');
  useEffect(() => {
    if (chosen && 'from' in chosen) {
      setFrom(chosen.from);
      setTo(chosen.to);
    }
  }, [chosen]);
  const ready = Boolean(from && to && to >= from);
  return (
    <div className="cluster load-window">
      <div className="modes" role="group" aria-label="Which days, from today">
        {PRESETS.map((p) => (
          <button key={p.value} type="button" aria-pressed={preset === p.value} disabled={busy} onClick={() => onChoose(p.value === 'plan' ? null : { preset: p.value })}>
            {p.words}
          </button>
        ))}
      </div>
      <form
        className="cluster"
        aria-label="Or the days between two dates"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) onChoose({ from, to });
        }}
      >
        <FormField label="From" className="inline">
          {(id) => <input id={id} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}
        </FormField>
        <FormField label="to" className="inline">
          {(id) => <input id={id} type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />}
        </FormField>
        <button type="submit" disabled={!ready || busy}>
          Show these days
        </button>
      </form>
    </div>
  );
}
