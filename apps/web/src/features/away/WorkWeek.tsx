/**
 * A person's working week (docs/architecture.md, D43): hours on each weekday, which the timesheet,
 * the load grid, scheduling and levelling use. Stored Sunday first; shown Monday first.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { patch } from '../../api/client';
import { keys } from '../../api/queries';
import { ErrorLine } from '../../components/States';
import { errorText } from '../issues/api';

const ORDER = [1, 2, 3, 4, 5, 6, 0];
const NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function WorkWeek({ week, capacity, canChange }: { week: number[] | null; capacity: number; canChange: boolean }) {
  const id = useId();
  const qc = useQueryClient();
  const usual = [0, capacity, capacity, capacity, capacity, capacity, 0];
  const [hours, setHours] = useState<string[]>(() => (week ?? usual).map((h) => String(h)));
  const save = useMutation({
    mutationFn: (next: number[] | null) => patch('/me', { workWeek: next }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.me }),
  });
  const parsed = hours.map((h) => Number(h));
  const valid = parsed.every((h) => Number.isFinite(h) && h >= 0 && h <= 24);
  const total = valid ? parsed.reduce((a, b) => a + b, 0) : null;
  return (
    <form
      className="form"
      aria-labelledby={`${id}-title`}
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) save.mutate(parsed);
      }}
    >
      <h3 id={`${id}-title`} className="hidden">
        Hours each day
      </h3>
      <div className="work-week">
        {ORDER.map((d) => (
          <div className="form-field" key={d}>
            <label htmlFor={`${id}-${d}`}>{NAMES[d]!.slice(0, 3)}</label>
            <input
              id={`${id}-${d}`}
              inputMode="decimal"
              aria-label={`Hours on ${NAMES[d]}`}
              value={hours[d]}
              disabled={!canChange}
              onChange={(e) => setHours((h) => h.map((x, i) => (i === d ? e.target.value : x)))}
            />
          </div>
        ))}
      </div>
      <p className="field-help">
        {total === null ? 'Each day takes from 0 to 24 hours.' : `${Math.round(total * 10) / 10} hours a week.`} {week ? '' : 'Until you save one, you work the plan’s working days at your capacity.'}
      </p>
      {canChange ? (
        <div className="cluster">
          <button type="submit" className="primary" disabled={!valid || save.isPending}>
            {save.isPending ? 'Saving…' : 'Save my week'}
          </button>
          {week ? (
            <button
              type="button"
              className="link"
              onClick={() => {
                setHours(usual.map(String));
                save.mutate(null);
              }}
            >
              Use the plan’s working days
            </button>
          ) : null}
          {save.isSuccess ? (
            <p role="status" className="outcome">
              Saved. Plans and your timesheet use it.
            </p>
          ) : null}
        </div>
      ) : null}
      {save.error ? <ErrorLine>{errorText(save.error)}</ErrorLine> : null}
    </form>
  );
}
