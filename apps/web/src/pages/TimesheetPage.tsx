/**
 * Your week of logged time (docs/architecture.md, D43): a row per issue and work type, a cell per
 * day, each day's total against your working hours. A cell logs, corrects or (emptied) deletes
 * its entry; a day of several entries is changed on the issue.
 */
import type { Timesheet } from '@a4a/shared';
import { hoursWords, periodWords } from '../features/common/format';
import { formatPeriod, parsePeriod } from '@a4a/shared/periods';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { get, put, qs } from '../api/client';
import { ErrorLine, ErrorNote, Loading, PageHead } from '../components/States';
import { errorText } from '../features/issues/api';
import { formatItems, intlLocale, t as tx, tr } from '../i18n';

const localToday = () => new Date().toLocaleDateString('en-CA');
const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const dayName = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString(intlLocale(), { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const shown = (minutes: number) => (minutes ? formatPeriod(minutes) : '');
const hoursText = (h: number) => hoursWords(h);

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
      <td className="num mono" title={tx('page.timesheet.severalEntriesChangeThemOn')}>
        <Link to={`/issues/${row.issue}`} aria-label={tx('page.timesheet.inEntriesChangedOn', { label: label, shown: shown(row.minutes[index] ?? 0), v: row.entries[index], issue: row.issue })}>
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
      setSaid(minutes ? tx('page.timesheet.savedOn', { formatPeriod: periodWords(minutes), issue: row.issue, dayName: dayName(date) }) : tx('page.timesheet.removedTheTimeOn', { issue: row.issue, dayName: dayName(date) }));
      await qc.invalidateQueries({ queryKey: ['issues', 'one', row.issue] });
    } catch (e) {
      setError(errorText(e));
    }
  };

  if (sheet.isLoading) return <Loading what="loadingLine.timesheet" />;
  if (sheet.error || !sheet.data) {
    return (
      <>
        <PageHead title={tx('page.timesheet.timesheet')} />
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
        title={tx('page.timesheet.timesheet')}
        about={
          // A week with nothing logged says so in a sentence of its own, not "nothing" where a period goes.
          periodWords(total)
            ? tx('page.timesheet.yourWeekFromToLogged', { dayName: dayName(t.days[0]!), dayName2: dayName(t.days[6]!), v: periodWords(total), hoursText: hoursText(planned) })
            : tx('page.timesheet.yourWeekFromToNothingLogged', { dayName: dayName(t.days[0]!), dayName2: dayName(t.days[6]!), hoursText: hoursText(planned) })
        }
        actions={
          <div className="cluster">
            <button type="button" onClick={() => go(addDays(week0, -7))}>{tx('page.timesheet.previousWeek')}</button>
            <button type="button" onClick={() => go(localToday())}>{tx('page.timesheet.thisWeek')}</button>
            <button type="button" onClick={() => go(addDays(week0, 7))}>{tx('page.timesheet.nextWeek')}</button>
          </div>
        }
      />
      <section className="card stack" aria-labelledby="sheet">
        <h2 id="sheet" className="hidden">{tx('page.timesheet.timeByIssueAndDay')}</h2>
        <p role="status" className="hidden">
          {said}
        </p>
        <div className="figures-scroll" role="region" aria-label={tx('page.timesheet.yourWeek')} tabIndex={0}>
          <table className="figures middle timesheet">
            <thead>
              <tr>
                <th scope="col">{tx('page.timesheet.issue')}</th>
                {t.days.map((d, i) => (
                  <th key={d} scope="col" className="num">
                    {dayName(d)}
                    <span className="day-hours">{t.hours[i] ? hoursText(t.hours[i]!) : tx('page.timesheet.off')}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={8} className="muted">{tx('page.timesheet.nothingLoggedThisWeekYet')}</td>
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
                    <Cell key={d} row={r} date={d} index={i} label={formatItems([r.issue, r.type ?? '', dayName(d)].filter(Boolean))} onSave={save} />
                  ))}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row">{tx('page.timesheet.eachDay')}</th>
                {t.totals.map((m, i) => {
                  const hours = t.hours[i] ?? 0;
                  const over = m / 60 > hours + 1e-9;
                  return (
                    <td key={t.days[i]} className={over ? 'num mono over' : m / 60 < hours ? 'num mono short' : 'num mono'}>
                      {periodWords(m)}
                      <span className="day-hours">{tr('page.timesheet.of', { hoursText: hoursText(hours) })}</span>
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
          <h3 id={`${formId}-title`} className="hidden">{tx('page.timesheet.addARow')}</h3>
          <input className="mono" aria-label={tx('page.timesheet.issue')} placeholder={tx('page.timesheet.back12')} size={10} value={issue} onChange={(e) => setIssue(e.target.value)} />
          <input aria-label={tx('page.timesheet.workTypeIfAny')} placeholder={tx('page.timesheet.workTypeIfAny')} value={type} onChange={(e) => setType(e.target.value)} />
          <button type="submit" disabled={!issue.trim()}>{tx('page.timesheet.addARow')}</button>
        </form>
        {error ? <ErrorLine>{error}</ErrorLine> : null}
      </section>
    </>
  );
}
