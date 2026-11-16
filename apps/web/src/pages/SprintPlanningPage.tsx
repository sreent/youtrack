/**
 * Planning a board's sprints (docs/architecture.md, D43): its backlog in rank order, ranked by
 * dragging or from the keyboard, issues moved into a sprint by dragging or a button, the sprint's
 * load against its people's capacity, and the board's velocity.
 */
import type { Backlog, Board, Field, Issue, Sprint, SprintPlan, Velocity } from '@a4a/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { Link, useParams } from 'react-router';
import { get, patch, post } from '../api/client';
import { keys, useBoardView } from '../api/queries';
import { Badge, fieldOf, StateBadge } from '../components/Badges';
import { ErrorLine, ErrorNote, Loading, PageHead } from '../components/States';
import { errorText } from '../features/issues/api';
import { span } from '../features/plan/dates';

const backlogKey = (id: string) => ['boards', id, 'backlog'] as const;

function pointsOf(issue: Issue, field: string | null): number | null {
  if (!field) return null;
  const v = fieldOf(issue.fields, field)?.value;
  return typeof v === 'number' ? v : null;
}

const hours = (n: number) => `${Math.round(n * 10) / 10}h`;

/** The backlog: a list in rank order, each issue draggable onto another place or onto a sprint. */
function BacklogList({ board, backlog, target, onMoved }: { board: Board; backlog: Backlog; target: Sprint | null; onMoved: (said: string) => void }) {
  const qc = useQueryClient();
  const [dragged, setDragged] = useState<string | null>(null);
  const [over, setOver] = useState<{ id: string; after: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const items = backlog.issues;
  const refresh = () => qc.invalidateQueries({ queryKey: ['boards', board.id] });

  const rank = async (issue: string, place: { after?: string; before?: string }, said: string) => {
    setError(null);
    try {
      await post(`/boards/${board.id}/rank`, { issue, ...place });
      await refresh();
      onMoved(said);
    } catch (e) {
      setError(errorText(e));
    }
  };
  const toSprint = async (issue: string, sprint: Sprint) => {
    setError(null);
    try {
      await post(`/sprints/${sprint.id}/issues`, { issues: [issue] });
      await refresh();
      onMoved(`Moved ${issue} into ${sprint.name}.`);
    } catch (e) {
      setError(errorText(e));
    }
  };
  const keyMove = (e: React.KeyboardEvent, i: number) => {
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    const issue = items[i]!;
    if (e.key === 'ArrowUp' && i > 0) void rank(issue.id, { before: items[i - 1]!.id }, `Moved ${issue.id} above ${items[i - 1]!.id}.`);
    if (e.key === 'ArrowDown' && i < items.length - 1) void rank(issue.id, { after: items[i + 1]!.id }, `Moved ${issue.id} below ${items[i + 1]!.id}.`);
  };

  return (
    <>
      {error ? <ErrorLine>{error}</ErrorLine> : null}
      {items.length === 0 ? (
        <p className="note">Nothing is waiting: every issue the backlog holds is in a sprint.</p>
      ) : (
        <ol className={dragged ? 'backlog dragging' : 'backlog'} aria-label="Backlog, in rank order">
          {items.map((issue, i) => {
            const pts = pointsOf(issue, board.pointsField);
            const cls = ['backlog-item', dragged === issue.id ? 'moving' : '', over?.id === issue.id ? (over.after ? 'drop-after' : 'drop-before') : ''].filter(Boolean).join(' ');
            return (
              <li
                key={issue.id}
                className={cls}
                data-issue={issue.id}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData('text/plain', issue.id);
                  e.dataTransfer.effectAllowed = 'move';
                  setDragged(issue.id);
                }}
                onDragEnd={() => {
                  setDragged(null);
                  setOver(null);
                }}
                onDragOver={(e) => {
                  if (!dragged || dragged === issue.id) return;
                  e.preventDefault();
                  const box = e.currentTarget.getBoundingClientRect();
                  setOver({ id: issue.id, after: e.clientY > box.top + box.height / 2 });
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  const moving = e.dataTransfer.getData('text/plain') || dragged;
                  const place = over?.after ? { after: issue.id } : { before: issue.id };
                  setDragged(null);
                  setOver(null);
                  if (moving && moving !== issue.id) void rank(moving, place, `Moved ${moving} ${over?.after ? 'below' : 'above'} ${issue.id}.`);
                }}
              >
                <button type="button" className="backlog-handle" aria-label={`Move ${issue.id}`} aria-describedby="backlog-keys" onKeyDown={(e) => keyMove(e, i)}>
                  <span aria-hidden="true">⋮⋮</span>
                </button>
                <Link className="issue-id mono" to={`/issues/${issue.id}`}>
                  {issue.id}
                </Link>
                <span className="backlog-summary">{issue.summary}</span>
                <span className="backlog-facts">
                  <StateBadge fields={issue.fields} />
                  {pts !== null ? <span className="chip mono">{pts} pts</span> : null}
                  {target ? (
                    <button type="button" className="small" onClick={() => void toSprint(issue.id, target)}>
                      To {target.name}
                    </button>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ol>
      )}
      <p className="field-help" id="backlog-keys">
        Drag an issue to rank it, or onto a sprint. From the keyboard, Alt and an arrow key moves it a place.
      </p>
      <SprintTargets board={board} dragging={dragged} onDrop={(issue, sprint) => void toSprint(issue, sprint)} />
    </>
  );
}

/** The board's open sprints, each a place to drop an issue. */
function SprintTargets({ board, dragging, onDrop }: { board: Board; dragging: string | null; onDrop: (issue: string, sprint: Sprint) => void }) {
  const view = useBoardView(board.id);
  const [over, setOver] = useState<string | null>(null);
  const open = (view.data?.sprints ?? []).filter((s) => !s.archived);
  if (!open.length) return null;
  return (
    <ul className={dragging ? 'sprint-targets ready' : 'sprint-targets'} aria-label="Sprints to drop an issue on">
      {open.map((s) => (
        <li
          key={s.id}
          className={over === s.id ? 'sprint-target over' : 'sprint-target'}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(s.id);
          }}
          onDragLeave={() => setOver(null)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(null);
            const issue = e.dataTransfer.getData('text/plain');
            if (issue) onDrop(issue, s);
          }}
        >
          <span className="item-name">{s.name}</span>
          <span className="item-about">
            {s.issueCount} {s.issueCount === 1 ? 'issue' : 'issues'}
            {s.startDate && s.endDate ? `, ${span(s.startDate, s.endDate)}` : ''}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** A sprint's load against what its people can work in it. */
function SprintLoad({ plan }: { plan: SprintPlan }) {
  const over = (p: SprintPlan['people'][number]) => p.capacityHours !== null && p.loadHours > p.capacityHours;
  return (
    <div className="figures-scroll" role="region" aria-label={`${plan.sprint.name}: load against capacity`} tabIndex={0}>
      <table className="figures middle capacity">
        <thead>
          <tr>
            <th scope="col">Who</th>
            <th scope="col" className="num">Issues</th>
            <th scope="col" className="num">Points</th>
            <th scope="col" className="num">Left to do</th>
            <th scope="col" className="num">Can work</th>
            <th scope="col">Load</th>
          </tr>
        </thead>
        <tbody>
          {plan.people.map((p) => (
            <tr key={p.user?.id ?? 'nobody'}>
              <th scope="row" className="row-head">
                {p.user ? p.user.name : <span className="muted">Nobody yet</span>}
              </th>
              <td className="num mono">{p.issues}</td>
              <td className="num mono">{p.points ?? '–'}</td>
              <td className="num mono">{hours(p.loadHours)}</td>
              <td className="num mono">{p.capacityHours === null ? '–' : hours(p.capacityHours)}</td>
              <td>
                {p.capacityHours === null ? null : (
                  <span className="capacity-cell">
                    <meter className="capacity-meter" min={0} max={Math.max(p.capacityHours, p.loadHours, 1)} high={p.capacityHours} value={p.loadHours}>
                      {hours(p.loadHours)} of {hours(p.capacityHours)}
                    </meter>
                    {over(p) ? <Badge tone="warn">{hours(p.loadHours - p.capacityHours)} over</Badge> : null}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row">All of it</th>
            <td className="num mono">{plan.totals.issues}</td>
            <td className="num mono">{plan.totals.points ?? '–'}</td>
            <td className="num mono">{hours(plan.totals.loadHours)}</td>
            <td className="num mono">{plan.totals.capacityHours === null ? '–' : hours(plan.totals.capacityHours)}</td>
            <td />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

/** Committed and done per sprint, as bars, with the average of the last three; and the figures. */
function VelocityChart({ v }: { v: Velocity }) {
  const titleId = useId();
  if (!v.sprints.length) return <p className="note">No sprint has begun yet, so there's no velocity to show.</p>;
  if (v.sprints.every((s) => s.committed === 0 && s.done === 0)) {
    return <p className="note">Nothing was committed to or done in {v.sprints.length === 1 ? v.sprints[0]!.name : 'its sprints'} yet, in {v.unit}.</p>;
  }
  const top = Math.max(1, ...v.sprints.map((s) => Math.max(s.committed, s.done)));
  const H = 140;
  const slot = 56;
  const y = (n: number) => H - (n / top) * (H - 10);
  const width = v.sprints.length * slot + 8;
  return (
    <figure className="velocity" aria-labelledby={titleId}>
      <figcaption id={titleId} className="note">
        {v.average === null ? 'No sprint is over yet.' : `On average, ${v.average} ${v.unit} done over the last ${Math.min(3, v.sprints.filter((s) => s.finished).length)} sprints that are over.`}
      </figcaption>
      <div className="velocity-scroll">
        <svg className="chart velocity-chart" viewBox={`0 0 ${width} ${H + 22}`} width={width} height={H + 22} aria-hidden="true">
          <line className="chart-axis" x1={0} x2={width} y1={H} y2={H} />
          {v.sprints.map((s, i) => (
            <g key={s.id}>
              <rect className="velocity-committed" x={i * slot + 8} y={y(s.committed)} width={18} height={H - y(s.committed)} rx={2} />
              <rect className={s.finished ? 'velocity-done' : 'velocity-done open'} x={i * slot + 28} y={y(s.done)} width={18} height={H - y(s.done)} rx={2} />
              <text className="velocity-label" x={i * slot + 27} y={H + 15} textAnchor="middle">
                {s.name}
              </text>
            </g>
          ))}
          {v.average !== null ? <line className="velocity-average" x1={0} x2={width} y1={y(v.average)} y2={y(v.average)} /> : null}
        </svg>
      </div>
      <ul className="chart-key" aria-hidden="true">
        <li>
          <span className="chart-swatch s1" />
          Committed
        </li>
        <li>
          <span className="chart-swatch s2" />
          Done
        </li>
        {v.average !== null ? (
          <li>
            <svg width="16" height="8" aria-hidden="true">
              <line className="velocity-average" x1="0" x2="16" y1="4" y2="4" />
            </svg>
            Average of the last three
          </li>
        ) : null}
      </ul>
      <table className="figures">
        <caption className="hidden">Velocity, in {v.unit}</caption>
        <thead>
          <tr>
            <th scope="col">Sprint</th>
            <th scope="col" className="num">Committed</th>
            <th scope="col" className="num">Done</th>
          </tr>
        </thead>
        <tbody>
          {v.sprints.map((s) => (
            <tr key={s.id}>
              <th scope="row">
                {s.name}
                {s.finished ? null : <span className="item-about">Under way</span>}
              </th>
              <td className="num mono">{s.committed}</td>
              <td className="num mono">{s.done}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

/** What the backlog holds and which field holds story points: for managers of the board's projects. */
function BoardSettings({ board }: { board: Board }) {
  const qc = useQueryClient();
  const fields = useQuery({ queryKey: keys.fields, queryFn: () => get<Field[]>('/fields'), staleTime: 60_000 });
  const [query, setQuery] = useState(board.backlogQuery ?? '');
  const [points, setPoints] = useState(board.pointsField ?? '');
  const save = useMutation({
    mutationFn: () => patch<Board>(`/boards/${board.id}`, { backlogQuery: query.trim() || null, pointsField: points || null }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['boards'] }),
  });
  const numbers = (fields.data ?? []).filter((f) => f.type === 'integer' || f.type === 'float');
  return (
    <form
      className="form"
      aria-label="Backlog and story points"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <div className="form-fields">
        <div className="form-field">
          <label htmlFor="backlog-query">What the backlog holds</label>
          <input id="backlog-query" className="mono" value={query} placeholder="#Unresolved" onChange={(e) => setQuery(e.target.value)} aria-describedby="backlog-query-help" />
          <small className="field-help" id="backlog-query-help">A search; issues in the board's open sprints are left out.</small>
        </div>
        <div className="form-field">
          <label htmlFor="points-field">Story points</label>
          <select id="points-field" value={points} onChange={(e) => setPoints(e.target.value)}>
            <option value="">No story points</option>
            {numbers.map((f) => (
              <option key={f.id} value={f.name}>
                {f.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="cluster">
        <button type="submit" disabled={save.isPending}>
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
        {save.isSuccess ? <p role="status" className="outcome">Saved.</p> : null}
      </div>
      {save.error ? <ErrorLine>{errorText(save.error)}</ErrorLine> : null}
    </form>
  );
}

export default function SprintPlanningPage() {
  const { id = '' } = useParams();
  const view = useBoardView(id);
  const backlog = useQuery({ queryKey: backlogKey(id), queryFn: () => get<Backlog>(`/boards/${id}/backlog`), enabled: Boolean(id) });
  const [chosen, setChosen] = useState<string | null>(null);
  const [said, setSaid] = useState('');
  const v = view.data;
  const open = (v?.sprints ?? []).filter((s) => !s.archived);
  const sprint = open.find((s) => s.id === chosen) ?? (v?.sprint && !v.sprint.archived ? v.sprint : null) ?? open[0] ?? null;
  const plan = useQuery({ queryKey: ['boards', id, 'plan', sprint?.id ?? ''], queryFn: () => get<SprintPlan>(`/sprints/${sprint!.id}/plan`), enabled: Boolean(sprint) });
  const velocity = useQuery({ queryKey: ['boards', id, 'velocity'], queryFn: () => get<Velocity>(`/boards/${id}/velocity`), enabled: Boolean(v?.board.sprintsEnabled) });
  const pickId = useId();

  const crumbs = (
    <>
      <Link to="/boards">Boards</Link>
      <span className="sep" aria-hidden="true">/</span>
      {v ? <Link to={`/boards/${v.board.id}`}>{v.board.name}</Link> : null}
      <span className="sep" aria-hidden="true">/</span>
    </>
  );
  if (view.isLoading) return <Loading what="the board" />;
  if (view.error || !v) {
    return (
      <>
        <PageHead title="Plan sprints" crumbs={crumbs} />
        <ErrorNote error={view.error} />
      </>
    );
  }
  return (
    <>
      <PageHead title="Plan sprints" crumbs={crumbs} about={`${v.board.name}'s backlog, its sprints, and how much they get done.`} />
      <p role="status" className="hidden">{said}</p>
      <div className="split">
        <div className="stack">
        <section className="card stack" aria-labelledby="backlog">
          <div className="section-head">
            <h2 id="backlog">Backlog</h2>
            {backlog.data ? (
              <span className="note">
                {backlog.data.count} {backlog.data.count === 1 ? 'issue' : 'issues'}
                {backlog.data.points !== null ? `, ${backlog.data.points} pts` : ''}
              </span>
            ) : null}
          </div>
          {backlog.error ? <ErrorNote error={backlog.error} /> : null}
          {backlog.data ? <BacklogList board={v.board} backlog={backlog.data} target={sprint} onMoved={setSaid} /> : <Loading what="the backlog" />}
        </section>
          <section className="card stack" aria-labelledby="sprint-load">
            <div className="section-head">
              <h2 id="sprint-load">Load against capacity</h2>
              {open.length > 1 ? (
                <span className="form-field inline">
                  <label htmlFor={pickId}>Sprint</label>
                  <select id={pickId} value={sprint?.id ?? ''} onChange={(e) => setChosen(e.target.value)}>
                    {open.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </span>
              ) : null}
            </div>
            {!v.board.sprintsEnabled ? <p className="note">This board doesn't use sprints.</p> : null}
            {v.board.sprintsEnabled && !sprint ? <p className="note">This board has no open sprint to plan.</p> : null}
            {plan.error ? <ErrorNote error={plan.error} /> : null}
            {plan.data ? (
              <>
                <p className="section-note">
                  {plan.data.from && plan.data.to
                    ? `${plan.data.sprint.name}, ${span(plan.data.from, plan.data.to)}: what's left of each person's issues, against the hours they can work, by their working week and days away.`
                    : `${plan.data.sprint.name} has no dates, so it has no capacity yet.`}
                </p>
                <SprintLoad plan={plan.data} />
              </>
            ) : null}
          </section>
        </div>
        <div className="stack">
          <section className="card stack" aria-labelledby="velocity">
            <div className="section-head">
              <h2 id="velocity">Velocity</h2>
              {velocity.data ? <span className="note">In {velocity.data.unit}</span> : null}
            </div>
            {velocity.error ? <ErrorNote error={velocity.error} /> : null}
            {velocity.data ? <VelocityChart v={velocity.data} /> : null}
          </section>
          <section className="card stack" aria-labelledby="board-settings">
            <h2 id="board-settings">Backlog and story points</h2>
            <BoardSettings board={v.board} />
          </section>
        </div>
      </div>
    </>
  );
}
