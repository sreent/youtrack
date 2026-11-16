/**
 * Your week of logged time (docs/architecture.md, D43): a row per issue and work type, a cell per
 * day, each day's total against your working hours. A cell logs, corrects or (emptied) deletes
 * its entry; a day of several entries is changed on the issue.
 */
import type { Timesheet } from '@a4a/shared';
import { formatPeriod, parsePeriod } from '@a4a/shared/periods';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { get, put, qs } from '../api/client';
import { ErrorLine, ErrorNote, Loading, PageHead } from '../components/States';
import { errorText } from '../features/issues/api';

const localToday = () => new Date().toLocaleDateString('en-CA');
const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const dayName = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const shown = (minutes: number) => (minutes ? formatPeriod(minutes) : '');
const hoursText = (h: number) => `${Math.round(h * 10) / 10}h`;

interface Row {
  issue: string;
  summary: string;
  type: string | null;
  minutes: number[];
  entries: number[];
}

/** One day of one row: the time, typed as "1h 30m" or minutes, saved when it's left. */
function Cell({ row, date, index, label, onSave }: { row: Row; date: string; index: number; label: string; onSave: (row: Row, date: string, minutes: number) => Promise<void> }) {
  const [text, setText] = useState<string | null>(null);
  const value = text ?? shown(row.minutes[index] ?? 0);
  if ((row.entries[index] ?? 0) > 1) {
    return (
      <td className="num mono" title="Several entries: change them on the issue">
        <Link to={`/issues/${row.issue}`} aria-label={`${label}: ${shown(row.minutes[index] ?? 0)} in ${row.entries[index]} entries, changed on ${row.issue}`}>
          {shown(row.minutes[index] ?? 0)}
        </Link>
      </td>
    );
  }
  const commit = async () => {
    if (text === null) return;
    const minutes = text.trim() === '' ? 0 : parsePeriod(text.trim());
    if (minutes === null || minutes < 0) return;
    if (minutes !== (row.minutes[index] ?? 0)) await onSave(row, date, minutes);
    setText(null);
  };
  return (
    <td className="num">
      <input
        className="mono"
        aria-label={label}
        value={value}
        placeholder="–"
        size={6}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') setText(null);
        }}
      />
    </td>
  );
}

export default function TimesheetPage() {
  const [params, setParams] = useSearchParams();
  const week = params.get('week') ?? localToday();
  const qc = useQueryClient();
  const key = ['timesheet', week] as const;
  const sheet = useQuery({ queryKey: key, queryFn: () => get<Timesheet>(`/timesheet${qs({ week })}`) });
  const [extra, setExtra] = useState<Row[]>([]);
  const [issue, setIssue] = useState('');
  const [type, setType] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState('');
  const formId = useId();
  const go = (to: string) => setParams((p) => {
    const next = new URLSearchParams(p);
    next.set('week', to);
    return next;
  });

  const save = async (row: Row, date: string, minutes: number) => {
    setError(null);
    try {
      const next = await put<Timesheet>('/timesheet/cell', { issue: row.issue, date, minutes, type: row.type });
      qc.setQueryData(key, next);
      setExtra((rows) => rows.filter((r) => !(r.issue === row.issue && r.type === row.type)));
      setSaid(minutes ? `Saved ${formatPeriod(minutes)} on ${row.issue}, ${dayName(date)}.` : `Removed the time on ${row.issue}, ${dayName(date)}.`);
      await qc.invalidateQueries({ queryKey: ['issues', 'one', row.issue] });
    } catch (e) {
      setError(errorText(e));
    }
  };

  if (sheet.isLoading) return <Loading what="your timesheet" />;
  if (sheet.error || !sheet.data) {
    return (
      <>
        <PageHead title="Timesheet" />
        <ErrorNote error={sheet.error} />
      </>
    );
  }
  const t = sheet.data;
  const rows: Row[] = [
    ...t.rows.map((r) => ({ issue: r.issue.id, summary: r.issue.summary, type: r.type?.name ?? null, minutes: r.minutes, entries: r.entries })),
    ...extra.filter((x) => !t.rows.some((r) => r.issue.id === x.issue && (r.type?.name ?? null) === x.type)),
  ];
  const week0 = t.days[0]!;
  const total = t.totals.reduce((a, b) => a + b, 0);
  const planned = t.hours.reduce((a, b) => a + b, 0);
  return (
    <>
      <PageHead
        title="Timesheet"
        about={`Your week from ${dayName(t.days[0]!)} to ${dayName(t.days[6]!)}: ${formatPeriod(total) || 'nothing'} logged, of ${hoursText(planned)} you work.`}
        actions={
          <div className="cluster">
            <button type="button" onClick={() => go(addDays(week0, -7))}>
              Previous week
            </button>
            <button type="button" onClick={() => go(localToday())}>
              This week
            </button>
            <button type="button" onClick={() => go(addDays(week0, 7))}>
              Next week
            </button>
          </div>
        }
      />
      <section className="card stack" aria-labelledby="sheet">
        <h2 id="sheet" className="hidden">
          Time by issue and day
        </h2>
        <p role="status" className="hidden">
          {said}
        </p>
        <div className="figures-scroll" role="region" aria-label="Your week" tabIndex={0}>
          <table className="figures middle timesheet">
            <thead>
              <tr>
                <th scope="col">Issue</th>
                {t.days.map((d, i) => (
                  <th key={d} scope="col" className="num">
                    {dayName(d)}
                    <span className="day-hours">{t.hours[i] ? hoursText(t.hours[i]!) : 'Off'}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={8} className="muted">
                    Nothing logged this week yet. Add an issue below, or log time on it.
                  </td>
                </tr>
              ) : null}
              {rows.map((r) => (
                <tr key={`${r.issue}|${r.type ?? ''}`}>
                  <th scope="row" className="row-head">
                    <Link className="mono" to={`/issues/${r.issue}`}>
                      {r.issue}
                    </Link>
                    <span className="item-name">{r.summary}</span>
                    {r.type ? <span className="item-about">{r.type}</span> : null}
                  </th>
                  {t.days.map((d, i) => (
                    <Cell key={d} row={r} date={d} index={i} label={`${r.issue}${r.type ? `, ${r.type}` : ''}, ${dayName(d)}`} onSave={save} />
                  ))}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row">Each day</th>
                {t.totals.map((m, i) => {
                  const hours = t.hours[i] ?? 0;
                  const over = m / 60 > hours + 1e-9;
                  return (
                    <td key={t.days[i]} className={over ? 'num mono over' : m / 60 < hours ? 'num mono short' : 'num mono'}>
                      {formatPeriod(m) || '0m'}
                      <span className="day-hours">of {hoursText(hours)}</span>
                    </td>
                  );
                })}
              </tr>
            </tfoot>
          </table>
        </div>
        <form
          className="cluster"
          aria-labelledby={`${formId}-title`}
          onSubmit={(e) => {
            e.preventDefault();
            const id = issue.trim().toUpperCase();
            if (!id) return;
            setExtra((x) => [...x, { issue: id, summary: '', type: type.trim() || null, minutes: [0, 0, 0, 0, 0, 0, 0], entries: [0, 0, 0, 0, 0, 0, 0] }]);
            setIssue('');
            setType('');
          }}
        >
          <h3 id={`${formId}-title`} className="hidden">
            Add a row
          </h3>
          <input className="mono" aria-label="Issue" placeholder="BACK-12" size={10} value={issue} onChange={(e) => setIssue(e.target.value)} />
          <input aria-label="Work type, if any" placeholder="Work type, if any" value={type} onChange={(e) => setType(e.target.value)} />
          <button type="submit" disabled={!issue.trim()}>
            Add a row
          </button>
        </form>
        {error ? <ErrorLine>{error}</ErrorLine> : null}
      </section>
    </>
  );
}
