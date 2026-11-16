import type { ReportKind } from '@a4a/shared';
import { useEffect, useId, useState } from 'react';
import { Navigate, useNavigate, useParams, useSearchParams } from 'react-router';
import { useBoards, useBoardView, useFields, useProjects, useUsers } from '../api/queries';
import { PageHead } from '../components/States';
import { addDays, localToday, span } from '../features/plan/dates';
import { csvHref, type ReportParams } from '../features/reports/api';
import { REPORTS, ReportView } from '../features/reports/ReportView';

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
      <InlineSelect label="Board" value={board} onChange={(v) => {
        set('sprint', null);
        set('board', v || null);
      }}>
        <option value="">Choose a board</option>
        {boards.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name}
          </option>
        ))}
      </InlineSelect>
      {board && view.data?.sprints.length ? (
        <InlineSelect label="Sprint" value={params.get('sprint') ?? ''} onChange={(v) => set('sprint', v || null)}>
          <option value="">The current one</option>
          {view.data.sprints.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
              {s.startDate && s.endDate ? `, ${span(s.startDate, s.endDate)}` : ''}
            </option>
          ))}
        </InlineSelect>
      ) : null}
      <div className="modes" role="group" aria-label="What to burn down">
        <button type="button" aria-pressed={by === 'estimate'} onClick={() => set('by', null)}>
          By estimate
        </button>
        <button type="button" aria-pressed={by === 'count'} onClick={() => set('by', 'count')}>
          By issues
        </button>
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
      {fallback === '' ? <option value="">None</option> : null}
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
      {kind === 'issues-per-field' ? <FieldSelect label="Field" name="field" params={params} set={set} fallback="Priority" /> : null}
      {kind === 'matrix' ? (
        <>
          <FieldSelect label="Rows" name="rows" params={params} set={set} fallback="Priority" />
          <FieldSelect label="Columns" name="columns" params={params} set={set} fallback="State" />
        </>
      ) : null}
      {kind === 'issues-per-field' || kind === 'matrix' ? (
        <InlineSelect label="Dates by" value={params.get('interval') ?? ''} onChange={(v) => set('interval', v || null)}>
          <option value="">Day, week or month, by their spread</option>
          <option value="day">Day</option>
          <option value="week">Week</option>
          <option value="month">Month</option>
        </InlineSelect>
      ) : null}
      {kind === 'average-age' ? <FieldSelect label="By" name="field" params={params} set={set} fallback="" /> : null}
      {kind === 'time-in-state' ? (
        <InlineSelect label="Columns of" value={params.get('board') ?? ''} onChange={(v) => set('board', v || null)}>
          <option value="">No board: states</option>
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
      <InlineSelect label="Project" value={params.get('project') ?? ''} onChange={(v) => set('project', v || null)}>
        <option value="">Every project</option>
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
        label="Days"
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
          <option key={d} value={d}>
            The last {d} days
          </option>
        ))}
        <option value="dates">Dates I choose</option>
      </InlineSelect>
      )}
      <MoreControls kind={kind} params={params} set={set} />
      {choosing && !now ? (
        <>
          <span className="form-field inline">
            <label htmlFor={`${queryId}-from`}>From</label>
            <input id={`${queryId}-from`} type="date" value={w.from} max={w.to} onChange={(e) => set('from', e.target.value || null)} />
          </span>
          <span className="form-field inline">
            <label htmlFor={`${queryId}-to`}>To</label>
            <input id={`${queryId}-to`} type="date" value={w.to} min={w.from} max={localToday()} onChange={(e) => set('to', e.target.value || null)} />
          </span>
        </>
      ) : null}
      {kind === 'created-resolved' ? (
        <InlineSelect label="By" value={params.get('interval') ?? ''} onChange={(v) => set('interval', v || null)}>
          <option value="">Day, week or month, by the window</option>
          <option value="day">Day</option>
          <option value="week">Week</option>
          <option value="month">Month</option>
        </InlineSelect>
      ) : null}
      {kind === 'time' ? (
        <InlineSelect label="Person" value={params.get('author') ?? ''} onChange={(v) => set('author', v || null)}>
          <option value="">Everyone</option>
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
          <label htmlFor={queryId}>Only issues matching</label>
          <input id={queryId} className="mono" value={query} placeholder="Type: Bug" onChange={(e) => setQuery(e.target.value)} />
        </span>
        {kind === 'cycle-time' ? (
          <span className="form-field inline">
            <label htmlFor={startId}>Clock starts at</label>
            <input id={startId} value={start} placeholder="In Progress" onChange={(e) => setStart(e.target.value)} />
          </span>
        ) : null}
        <button type="submit">Show</button>
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
      <PageHead title="Reports" about="Worked out from each issue's history and the work logged on it, as of now. Days begin and end in your time zone." />
      <div className="stack">
        <div className="modes report-choice" role="group" aria-label="Which report">
          {REPORTS.map((r) => (
            <button key={r.kind} type="button" aria-pressed={r.kind === kind} onClick={() => navigate(`/reports/${r.kind}`)}>
              {r.label}
            </button>
          ))}
        </div>
        <p className="note">{report.about}</p>
        <div className="cluster">{kind === 'burndown' ? <BurndownControls params={params} set={set} /> : <ScopeControls key={kind} kind={kind} params={params} set={set} />}</div>
        <section className="card" aria-label={report.label}>
          {ready ? <ReportView kind={kind} params={query} /> : <p className="note">Choose a board with sprints to see its sprint's burndown.</p>}
        </section>
        {ready ? (
          <div className="cluster">
            <a className="button" href={csvHref(kind, query)} download>
              Download the figures (CSV)
            </a>
            {kind === 'time' ? (
              <a className="button" href={csvHref(kind, query, { rows: 'issue' })} download>
                Download by issue (CSV)
              </a>
            ) : null}
          </div>
        ) : null}
      </div>
    </>
  );
}
