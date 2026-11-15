import type { PlanSettings as Plan, Project } from '@a4a/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { patch } from '../../api/client';
import { keys } from '../../api/queries';
import { Icon } from '../../components/Icon';
import { errorText, Said } from '../common/bits';
import { dateRead } from '../common/format';

const DAYS: { n: number; name: string; short: string }[] = [
  { n: 1, name: 'Monday', short: 'Mon' },
  { n: 2, name: 'Tuesday', short: 'Tue' },
  { n: 3, name: 'Wednesday', short: 'Wed' },
  { n: 4, name: 'Thursday', short: 'Thu' },
  { n: 5, name: 'Friday', short: 'Fri' },
  { n: 6, name: 'Saturday', short: 'Sat' },
  { n: 0, name: 'Sunday', short: 'Sun' },
];

interface Form {
  startDate: string;
  workingDays: number[];
  hoursPerDay: string;
  holidays: string[];
  budget: string;
  currency: string;
}

function toForm(plan: Plan): Form {
  return {
    startDate: plan.startDate ?? '',
    workingDays: [...plan.workingDays].sort(),
    hoursPerDay: String(plan.hoursPerDay),
    holidays: [...plan.holidays].sort(),
    budget: plan.budget === null ? '' : String(plan.budget),
    currency: plan.currency,
  };
}

/** The plan's calendar and money: when it starts, which days people work and for how long, days off, and the budget. */
export function PlanSettings({ project, canEdit }: { project: Project; canEdit: boolean }) {
  const qc = useQueryClient();
  const [form, setForm] = useState<Form>(() => toForm(project.settings.plan));
  const [day, setDay] = useState('');
  const [said, setSaid] = useState<string | null>(null);
  const saved = JSON.stringify(toForm(project.settings.plan));
  useEffect(() => setForm(JSON.parse(saved) as Form), [saved]);
  const dirty = JSON.stringify({ ...form, workingDays: [...form.workingDays].sort(), holidays: [...form.holidays].sort() }) !== saved;

  const save = useMutation({
    mutationFn: () =>
      patch<Project>(`/projects/${project.key}`, {
        settings: {
          plan: {
            startDate: form.startDate || null,
            workingDays: [...form.workingDays].sort(),
            hoursPerDay: Number(form.hoursPerDay),
            holidays: [...form.holidays].sort(),
            budget: form.budget === '' ? null : Number(form.budget),
            currency: form.currency.trim().toUpperCase() || 'USD',
          },
        },
      }),
    onSuccess: (p) => {
      qc.setQueryData(keys.project(p.key), p);
      void qc.invalidateQueries({ queryKey: keys.projects });
      void qc.invalidateQueries({ queryKey: ['plan'] });
      setSaid('The plan settings are saved. The plan uses them from now on.');
    },
    onError: (e) => setSaid(errorText(e)),
  });

  const toggleDay = (n: number) =>
    setForm((f) => ({ ...f, workingDays: f.workingDays.includes(n) ? f.workingDays.filter((d) => d !== n) : [...f.workingDays, n] }));
  const addDay = () => {
    if (!day || form.holidays.includes(day)) return;
    setForm((f) => ({ ...f, holidays: [...f.holidays, day].sort() }));
    setDay('');
  };

  return (
    <form
      className="a4p-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!form.workingDays.length) {
          setSaid('Choose at least one working day.');
          return;
        }
        save.mutate();
      }}
    >
      <fieldset className="a4p-bare" disabled={!canEdit || save.isPending}>
        <div className="a4p-fields">
          <label className="a4p-field">
            <span>Starts</span>
            <input type="date" value={form.startDate} onChange={(e) => setForm((f) => ({ ...f, startDate: e.target.value }))} />
            <small>Empty: from its earliest task, or today.</small>
          </label>
          <label className="a4p-field">
            <span>Hours in a working day</span>
            <input
              type="number"
              min={1}
              max={24}
              step={0.5}
              value={form.hoursPerDay}
              onChange={(e) => setForm((f) => ({ ...f, hoursPerDay: e.target.value }))}
              required
            />
            <small>A day of estimate, such as “2d”, is this many hours.</small>
          </label>
          <label className="a4p-field">
            <span>Budget</span>
            <input type="number" min={0} step="any" value={form.budget} onChange={(e) => setForm((f) => ({ ...f, budget: e.target.value }))} />
            <small>Empty: no budget to compare costs with.</small>
          </label>
          <label className="a4p-field">
            <span>Currency</span>
            <input
              value={form.currency}
              maxLength={8}
              onChange={(e) => setForm((f) => ({ ...f, currency: e.target.value }))}
              className="a4p-key-input"
              required
            />
          </label>
        </div>
        <fieldset className="a4p-checks a4p-days">
          <legend>Working days</legend>
          {DAYS.map((d) => (
            <label key={d.n} className="a4p-check">
              <input type="checkbox" checked={form.workingDays.includes(d.n)} onChange={() => toggleDay(d.n)} />
              <span>
                <span aria-hidden="true">{d.short}</span>
                <span className="a4-sr-only">{d.name}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <div className="a4p-holidays">
          <span className="a4p-holidays-label" id={`holidays-${project.key}`}>
            Days off
          </span>
          {form.holidays.length ? (
            <ul className="chips a4p-holiday-list" aria-labelledby={`holidays-${project.key}`}>
              {form.holidays.map((h) => (
                <li key={h} className="chip a4p-holiday">
                  <time dateTime={h}>{dateRead(h)}</time>
                  {canEdit ? (
                    <button
                      type="button"
                      className="a4p-chip-x"
                      aria-label={`Remove ${dateRead(h)}`}
                      onClick={() => setForm((f) => ({ ...f, holidays: f.holidays.filter((x) => x !== h) }))}
                    >
                      <Icon name="cross" />
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <span className="note">None: every working day counts.</span>
          )}
          {canEdit ? (
            <span className="a4p-holiday-add">
              <input type="date" value={day} onChange={(e) => setDay(e.target.value)} aria-label="A day off to add" />
              <button type="button" onClick={addDay} disabled={!day}>
                Add the day
              </button>
            </span>
          ) : null}
        </div>
      </fieldset>
      {canEdit ? (
        <div className="a4p-actions">
          <button type="submit" disabled={!dirty || save.isPending}>
            {save.isPending ? 'Saving…' : 'Save the plan settings'}
          </button>
          {dirty ? (
            <button type="button" className="link" onClick={() => setForm(JSON.parse(saved) as Form)}>
              Put them back
            </button>
          ) : null}
          <Said text={said} tone={save.isError ? 'bad' : undefined} />
        </div>
      ) : null}
    </form>
  );
}
