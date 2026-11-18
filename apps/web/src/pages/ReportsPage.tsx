import type { ReportKind } from '@a4a/shared';
import { useEffect, useId, useState } from 'react';
import { Navigate, useNavigate, useParams, useSearchParams } from 'react-router';
import { useBoards, useBoardView, useFields, useProjects, useUsers } from '../api/queries';
import { PageHead } from '../components/States';
import { addDays, localToday, span } from '../features/plan/dates';
import { csvHref, type ReportParams } from '../features/reports/api';
import { REPORTS, ReportView } from '../features/reports/ReportView';
import { formatItems, t, tr } from '../i18n';

const WINDOWS = [7, 14, 30, 90, 365] as const;

/** The window the page shows: a number of days up to today, or dates someone chose. */
function windowOf(params: URLSearchParams, kind: ReportKind): { days: number | null; from: string; to: string } {
  const today = localToday();
  const fallback = kind === 'cycle-time' || kind === 'time-in-state' ? 90 : 30;
  if (params.get('from') || params.get('to')) {
    const to = params.get('to') || today;
    return { days: null, from: params.get('from') || addDays(to, -(fallback - 1)), to };
  }
  const days = Number(params.get('days')) || fallback;
  return { days, from: addDays(today, -(days - 1)), to: today };
}

function InlineSelect({ label, value, onChange, children }: { label: string; value: string; onChange: (v: string) => void; children: React.ReactNode }) {
  const id = useId();
  return (
    <span className="form-field inline">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        {children}
      </select>
    </span>
  );
}

function BurndownControls({ params, set }: { params: URLSearchParams; set: (k: string, v: string | null) => void }) {
  const boards = (useBoards().data ?? []).filter((b) => b.sprintsEnabled);
  const board = params.get('board') ?? '';
  const view = useBoardView(board || undefined);
  const by = params.get('by') === 'count' ? 'count' : 'estimate';
  return (
    <>
      <InlineSelect label={t('page.reports.board')} value={board} onChange={(v) => {
        set('sprint', null);
        set('board', v || null);
      }}>
        <option value="">{t('page.reports.chooseABoard')}</option>
        {boards.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name}
          </option>
        ))}
      </InlineSelect>
      {board && view.data?.sprints.length ? (
        <InlineSelect label={t('page.reports.sprint')} value={params.get('sprint') ?? ''} onChange={(v) => set('sprint', v || null)}>
          <option value="">{t('page.reports.theCurrentOne')}</option>
          {view.data.sprints.map((s) => (
            <option key={s.id} value={s.id}>
              {formatItems(s.startDate && s.endDate ? [s.name, span(s.startDate, s.endDate)] : [s.name])}
            </option>
          ))}
        </InlineSelect>
      ) : null}
      <div className="modes" role="group" aria-label={t('page.reports.whatToBurnDown')}>
        <button type="button" aria-pressed={by === 'estimate'} onClick={() => set('by', null)}>{t('page.reports.byEstimate')}</button>
        <button type="button" aria-pressed={by === 'count'} onClick={() => set('by', 'count')}>{t('page.reports.byIssues')}</button>
      </div>
    </>
  );
}

/** A field to count or follow by: any field, or Project. */
function FieldSelect({ label, name, params, set, fallback }: { label: string; name: string; params: URLSearchParams; set: (k: string, v: string | null) => void; fallback: string }) {
  const fields = useFields().data ?? [];
  const value = params.get(name) ?? fallback;
  const names = ['Project', ...fields.map((f) => f.name).sort((a, b) => a.localeCompare(b))];
  return (
    <InlineSelect label={label} value={value} onChange={(v) => set(name, v || null)}>
      {fallback === '' ? <option value="">{t('page.reports.none')}</option> : null}
      {value && !names.includes(value) ? <option value={value}>{value}</option> : null}
      {names.map((n) => (
        <option key={n} value={n}>
          {n}
        </option>
      ))}
    </InlineSelect>
  );
}

/** What the reports D44 adds take beyond a scope: fields, a board, how dates group. */
function MoreControls({ kind, params, set }: { kind: ReportKind; params: URLSearchParams; set: (k: string, v: string | null) => void }) {
  const boards = useBoards().data ?? [];
  return (
    <>
      {kind === 'issues-per-field' ? <FieldSelect label={t('page.reports.field')} name="field" params={params} set={set} fallback={t('page.reports.priority')} /> : null}
      {kind === 'matrix' ? (
        <>
          <FieldSelect label={t('page.reports.rows')} name="rows" params={params} set={set} fallback={t('page.reports.priority')} />
          <FieldSelect label={t('page.reports.columns')} name="columns" params={params} set={set} fallback={t('page.reports.state')} />
        </>
      ) : null}
      {kind === 'issues-per-field' || kind === 'matrix' ? (
        <InlineSelect label={t('page.reports.datesBy')} value={params.get('interval') ?? ''} onChange={(v) => set('interval', v || null)}>
          <option value="">{t('page.reports.dayWeekOrMonthBy')}</option>
          <option value="day">{t('page.reports.day')}</option>
          <option value="week">{t('page.reports.week')}</option>
          <option value="month">{t('page.reports.month')}</option>
        </InlineSelect>
      ) : null}
      {kind === 'average-age' ? <FieldSelect label={t('page.reports.by')} name="field" params={params} set={set} fallback="" /> : null}
      {kind === 'time-in-state' ? (
        <InlineSelect label={t('page.reports.columnsOf')} value={params.get('board') ?? ''} onChange={(v) => set('board', v || null)}>
          <option value="">{t('page.reports.noBoardStates')}</option>
          {boards.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </InlineSelect>
      ) : null}
    </>
  );
}

function ScopeControls({ kind, params, set }: { kind: ReportKind; params: URLSearchParams; set: (k: string, v: string | null) => void }) {
  const projects = useProjects().data ?? [];
  const users = (useUsers().data ?? []).filter((u) => !u.banned);
  const now = kind === 'issues-per-field' || kind === 'matrix';
  const queryId = useId();
  const startId = useId();
  const [query, setQuery] = useState(params.get('query') ?? '');
  const [start, setStart] = useState(params.get('start') ?? '');
  useEffect(() => setQuery(params.get('query') ?? ''), [params]);
  const w = windowOf(params, kind);
  const choosing = w.days === null;
  return (
    <>
      <InlineSelect label={t('page.reports.project')} value={params.get('project') ?? ''} onChange={(v) => set('project', v || null)}>
        <option value="">{t('page.reports.everyProject')}</option>
        {projects
          .filter((p) => !p.archived)
          .map((p) => (
            <option key={p.id} value={p.key}>
              {p.name}
            </option>
          ))}
      </InlineSelect>
      {now ? null : (
      <InlineSelect
        label={t('page.reports.days')}
        value={choosing ? 'dates' : String(w.days)}
        onChange={(v) => {
          if (v === 'dates') {
            set('days', null);
            set('from', w.from);
            set('to', w.to);
          } else {
            set('from', null);
            set('to', null);
            set('days', v);
          }
        }}
      >
        {WINDOWS.map((d) => (
          <option key={d} value={d}>{tr('page.reports.theLastDays', { d: d })}</option>
        ))}
        <option value="dates">{t('page.reports.datesIChoose')}</option>
      </InlineSelect>
      )}
      <MoreControls kind={kind} params={params} set={set} />
      {choosing && !now ? (
        <>
          <span className="form-field inline">
            <label htmlFor={`${queryId}-from`}>{t('page.reports.from')}</label>
            <input id={`${queryId}-from`} type="date" value={w.from} max={w.to} onChange={(e) => set('from', e.target.value || null)} />
          </span>
          <span className="form-field inline">
            <label htmlFor={`${queryId}-to`}>{t('page.reports.to')}</label>
            <input id={`${queryId}-to`} type="date" value={w.to} min={w.from} max={localToday()} onChange={(e) => set('to', e.target.value || null)} />
          </span>
        </>
      ) : null}
      {kind === 'created-resolved' ? (
        <InlineSelect label={t('page.reports.by')} value={params.get('interval') ?? ''} onChange={(v) => set('interval', v || null)}>
          <option value="">{t('page.reports.dayWeekOrMonthBy2')}</option>
          <option value="day">{t('page.reports.day')}</option>
          <option value="week">{t('page.reports.week')}</option>
          <option value="month">{t('page.reports.month')}</option>
        </InlineSelect>
      ) : null}
      {kind === 'time' ? (
        <InlineSelect label={t('page.reports.person')} value={params.get('author') ?? ''} onChange={(v) => set('author', v || null)}>
          <option value="">{t('page.reports.everyone')}</option>
          {users.map((u) => (
            <option key={u.id} value={u.login}>
              {u.isBot ? u.login : u.name}
            </option>
          ))}
        </InlineSelect>
      ) : null}
      <form
        className="cluster grow"
        onSubmit={(e) => {
          e.preventDefault();
          set('query', query.trim() || null);
          if (kind === 'cycle-time') set('start', start.trim() || null);
        }}
      >
        <span className="form-field inline grow">
          <label htmlFor={queryId}>{t('page.reports.onlyIssuesMatching')}</label>
          <input id={queryId} className="mono" value={query} placeholder={t('page.reports.typeBug')} onChange={(e) => setQuery(e.target.value)} />
        </span>
        {kind === 'cycle-time' ? (
          <span className="form-field inline">
            <label htmlFor={startId}>{t('page.reports.clockStartsAt')}</label>
            <input id={startId} value={start} placeholder={t('page.reports.inProgress')} onChange={(e) => setStart(e.target.value)} />
          </span>
        ) : null}
        <button type="submit">{t('page.reports.show')}</button>
      </form>
    </>
  );
}

export default function ReportsPage() {
  const { kind: raw } = useParams();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const kind = REPORTS.find((r) => r.kind === raw)?.kind;
  if (!raw) return <Navigate to="/reports/burndown" replace />;
  if (!kind) return <Navigate to="/reports/burndown" replace />;
  const report = REPORTS.find((r) => r.kind === kind)!;
  const set = (k: string, v: string | null) =>
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        if (v === null) next.delete(k);
        else next.set(k, v);
        return next;
      },
      { replace: true },
    );

  let query: ReportParams;
  let ready = true;
  if (kind === 'burndown') {
    query = { board: params.get('board') ?? undefined, sprint: params.get('sprint') ?? undefined, by: params.get('by') ?? undefined };
    ready = Boolean(query.board || query.sprint);
  } else if (kind === 'issues-per-field' || kind === 'matrix') {
    // Issues as they are now: no window of days.
    query = {
      project: params.get('project') ?? undefined,
      query: params.get('query') ?? undefined,
      interval: params.get('interval') ?? undefined,
      ...(kind === 'matrix' ? { rows: params.get('rows') || 'Priority', columns: params.get('columns') || 'State' } : { field: params.get('field') || 'Priority' }),
    };
  } else {
    const w = windowOf(params, kind);
    query = {
      project: params.get('project') ?? undefined,
      query: params.get('query') ?? undefined,
      from: w.from,
      to: w.to,
      ...(kind === 'created-resolved' ? { interval: params.get('interval') ?? undefined } : {}),
      ...(kind === 'cycle-time' ? { start: params.get('start') ?? undefined } : {}),
      ...(kind === 'time' ? { author: params.get('author') ?? undefined } : {}),
      ...(kind === 'average-age' ? { field: params.get('field') ?? undefined } : {}),
      ...(kind === 'time-in-state' ? { board: params.get('board') ?? undefined } : {}),
    };
  }

  return (
    <>
      <PageHead title={t('page.reports.reports')} about={t('page.reports.workedOutFromEachIssue')} />
      <div className="stack">
        <div className="modes report-choice" role="group" aria-label={t('page.reports.whichReport')}>
          {REPORTS.map((r) => (
            <button key={r.kind} type="button" aria-pressed={r.kind === kind} onClick={() => navigate(`/reports/${r.kind}`)}>
              {r.label}
            </button>
          ))}
        </div>
        <p className="note">{report.about}</p>
        <div className="cluster">{kind === 'burndown' ? <BurndownControls params={params} set={set} /> : <ScopeControls key={kind} kind={kind} params={params} set={set} />}</div>
        <section className="card" aria-label={report.label}>
          {ready ? <ReportView kind={kind} params={query} /> : <p className="note">{t('page.reports.chooseABoardWithSprints')}</p>}
        </section>
        {ready ? (
          <div className="cluster">
            <a className="button" href={csvHref(kind, query)} download>{t('page.reports.downloadTheFiguresCsv')}</a>
            {kind === 'time' ? (
              <a className="button" href={csvHref(kind, query, { rows: 'issue' })} download>{t('page.reports.downloadByIssueCsv')}</a>
            ) : null}
          </div>
        ) : null}
      </div>
    </>
  );
}
