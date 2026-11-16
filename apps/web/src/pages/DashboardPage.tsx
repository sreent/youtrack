import type { Dashboard, ReportWidgetParams, Widget } from '@a4a/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { ApiError, del } from '../api/client';
import { useBoards, useFields, useMe, useProjects, useSavedSearches } from '../api/queries';
import { ErrorNote, Loading, PageHead } from '../components/States';
import { Confirm } from '../features/common/Confirm';
import { Said } from '../features/common/bits';
import { createDashboard, reportKeys, saveDashboard, useDashboards, useDefaultDashboard } from '../features/reports/api';
import { REPORTS } from '../features/reports/ReportView';
import { WidgetBody, widgetTitle } from '../features/reports/Widgets';
import { AppWidgets } from '../features/apps/AppWidgets';
import { t, tr } from '../i18n';

const newWidgetId = () => Math.random().toString(36).slice(2, 10);

/** A widget being made: what kind, and what it shows. */
function AddWidget({ onAdd }: { onAdd: (w: Widget) => void }) {
  const id = useId();
  const projects = (useProjects().data ?? []).filter((p) => !p.archived);
  const boards = (useBoards().data ?? []).filter((b) => b.sprintsEnabled);
  const saved = useSavedSearches().data ?? [];
  const [kind, setKind] = useState<'report' | 'search' | 'note'>('report');
  const [report, setReport] = useState<ReportWidgetParams['report']>('burndown');
  const [board, setBoard] = useState('');
  const [project, setProject] = useState('');
  const [days, setDays] = useState(30);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [show, setShow] = useState<'count' | 'list'>('list');
  const [text, setText] = useState('');
  const [title, setTitle] = useState('');
  const [width, setWidth] = useState<'half' | 'full'>('half');
  // The reports D44 adds: a field (or two), or a board's columns.
  const fieldNames = ['Project', ...(useFields().data ?? []).map((f) => f.name).sort((a, b) => a.localeCompare(b))];
  const allBoards = useBoards().data ?? [];
  const [field, setField] = useState('');
  const [rows, setRows] = useState('Priority');
  const [columns, setColumns] = useState('State');
  const [columnsOf, setColumnsOf] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const build = (): Widget | string => {
    const base = { id: newWidgetId(), width, ...(title.trim() ? { title: title.trim() } : {}) };
    if (kind === 'note') return text.trim() ? { ...base, kind: 'note', text: text.trim() } : t('page.dashboard.writeWhatTheNoteSays');
    if (kind === 'search') {
      if (search === 'query') return query.trim() ? { ...base, kind: 'search', query: query.trim(), show, limit: 8 } : t('page.dashboard.writeTheQueryItRuns');
      return search ? { ...base, kind: 'search', savedSearch: search, show, limit: 8 } : t('page.dashboard.chooseASavedSearchOr');
    }
    if (report === 'burndown') return board ? { ...base, kind: 'report', params: { report: 'burndown', board, by: 'estimate' } } : t('page.dashboard.chooseTheBoardWhoseCurrent');
    const scope = { ...(project ? { project } : {}), ...(query.trim() ? { query: query.trim() } : {}), days };
    const extra =
      report === 'issues-per-field'
        ? { field: field || 'Priority' }
        : report === 'matrix'
          ? { rows, columns }
          : report === 'average-age'
            ? field ? { field } : {}
            : report === 'time-in-state' && columnsOf
              ? { board: columnsOf }
              : {};
    return { ...base, kind: 'report', params: { report, ...scope, ...extra } as ReportWidgetParams };
  };

  return (
    <section className="card widget adding" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>{t('page.dashboard.addAWidget')}</h2>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          const w = build();
          if (typeof w === 'string') return setProblem(w);
          setProblem(null);
          onAdd(w);
          setTitle('');
          setText('');
        }}
      >
        <div className="form-fields">
          <div className="form-field">
            <label htmlFor={`${id}-kind`}>{t('page.dashboard.whatItShows')}</label>
            <select id={`${id}-kind`} value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
              <option value="report">{t('page.dashboard.aReport')}</option>
              <option value="search">{t('page.dashboard.aSearchAsACount')}</option>
              <option value="note">{t('page.dashboard.aNote')}</option>
            </select>
          </div>
          {kind === 'report' ? (
            <div className="form-field">
              <label htmlFor={`${id}-report`}>{t('page.dashboard.report')}</label>
              <select id={`${id}-report`} value={report} onChange={(e) => setReport(e.target.value as typeof report)}>
                {REPORTS.map((r) => (
                  <option key={r.kind} value={r.kind}>
                    {r.label}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
        </div>
        {kind === 'report' && report === 'burndown' ? (
          <div className="form-field">
            <label htmlFor={`${id}-board`}>{t('page.dashboard.board')}</label>
            <select id={`${id}-board`} value={board} onChange={(e) => setBoard(e.target.value)} aria-describedby={`${id}-board-help`}>
              <option value="">{t('page.dashboard.chooseABoard')}</option>
              {boards.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
            <small className="field-help" id={`${id}-board-help`}>{t('page.dashboard.itShowsWhicheverSprintIs')}</small>
          </div>
        ) : null}
        {kind === 'report' && report !== 'burndown' ? (
          <div className="form-fields">
            <div className="form-field">
              <label htmlFor={`${id}-project`}>{t('page.dashboard.project')}</label>
              <select id={`${id}-project`} value={project} onChange={(e) => setProject(e.target.value)}>
                <option value="">{t('page.dashboard.everyProject')}</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.key}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-field">
              <label htmlFor={`${id}-days`}>{t('page.dashboard.days')}</label>
              <select id={`${id}-days`} value={days} onChange={(e) => setDays(Number(e.target.value))}>
                {[7, 14, 30, 90, 365].map((d) => (
                  <option key={d} value={d}>{tr('page.dashboard.theLastDays', { d: d })}</option>
                ))}
              </select>
            </div>
          </div>
        ) : null}
        {kind === 'report' && (report === 'issues-per-field' || report === 'average-age') ? (
          <div className="form-fields">
            <div className="form-field">
              <label htmlFor={`${id}-field`}>{report === 'average-age' ? t('page.dashboard.byField') : t('page.dashboard.field')}</label>
              <select id={`${id}-field`} value={field || (report === 'average-age' ? '' : 'Priority')} onChange={(e) => setField(e.target.value)}>
                {report === 'average-age' ? <option value="">{t('page.dashboard.noneTheAverageOnly')}</option> : null}
                {fieldNames.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </div>
          </div>
        ) : null}
        {kind === 'report' && report === 'matrix' ? (
          <div className="form-fields">
            <div className="form-field">
              <label htmlFor={`${id}-rows`}>{t('page.dashboard.rows')}</label>
              <select id={`${id}-rows`} value={rows} onChange={(e) => setRows(e.target.value)}>
                {fieldNames.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-field">
              <label htmlFor={`${id}-columns`}>{t('page.dashboard.columns')}</label>
              <select id={`${id}-columns`} value={columns} onChange={(e) => setColumns(e.target.value)}>
                {fieldNames.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </div>
          </div>
        ) : null}
        {kind === 'report' && report === 'time-in-state' ? (
          <div className="form-fields">
            <div className="form-field">
              <label htmlFor={`${id}-columns-of`}>{t('page.dashboard.columnsOf')}</label>
              <select id={`${id}-columns-of`} value={columnsOf} onChange={(e) => setColumnsOf(e.target.value)}>
                <option value="">{t('page.dashboard.noBoardStates')}</option>
                {allBoards.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        ) : null}
        {kind === 'search' ? (
          <div className="form-fields">
            <div className="form-field">
              <label htmlFor={`${id}-search`}>{t('page.dashboard.search')}</label>
              <select id={`${id}-search`} value={search} onChange={(e) => setSearch(e.target.value)}>
                <option value="">{t('page.dashboard.chooseASavedSearch')}</option>
                {saved.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
                <option value="query">{t('page.dashboard.aQueryIWrite')}</option>
              </select>
            </div>
            <div className="form-field">
              <label htmlFor={`${id}-show`}>{t('page.dashboard.show')}</label>
              <select id={`${id}-show`} value={show} onChange={(e) => setShow(e.target.value as typeof show)}>
                <option value="list">{t('page.dashboard.theIssues')}</option>
                <option value="count">{t('page.dashboard.howMany')}</option>
              </select>
            </div>
          </div>
        ) : null}
        {(kind === 'report' && report !== 'burndown') || (kind === 'search' && search === 'query') ? (
          <div className="form-field">
            <label htmlFor={`${id}-query`}>{kind === 'search' ? t('page.dashboard.query') : t('page.dashboard.onlyIssuesMatchingOptional')}</label>
            <input id={`${id}-query`} className="mono" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="#Unresolved Type: Bug" />
          </div>
        ) : null}
        {kind === 'note' ? (
          <div className="form-field">
            <label htmlFor={`${id}-text`}>{t('page.dashboard.note')}</label>
            <textarea id={`${id}-text`} rows={4} value={text} onChange={(e) => setText(e.target.value)} aria-describedby={`${id}-text-help`} />
            <small className="field-help" id={`${id}-text-help`}>{t('page.dashboard.markdownAsInComments')}</small>
          </div>
        ) : null}
        <div className="form-fields">
          <div className="form-field">
            <label htmlFor={`${id}-title-input`}>{t('page.dashboard.titleOptional')}</label>
            <input id={`${id}-title-input`} value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="form-field">
            <label htmlFor={`${id}-width`}>{t('page.dashboard.width')}</label>
            <select id={`${id}-width`} value={width} onChange={(e) => setWidth(e.target.value as typeof width)}>
              <option value="half">{t('page.dashboard.halfThePage')}</option>
              <option value="full">{t('page.dashboard.theWholePage')}</option>
            </select>
          </div>
        </div>
        {problem ? <Said text={problem} tone="bad" /> : null}
        <div className="cluster end">
          <button type="submit" className="primary">{t('page.dashboard.addIt')}</button>
        </div>
      </form>
    </section>
  );
}

function DashboardView({ d, editing, onChange }: { d: Dashboard; editing: boolean; onChange: (widgets: Widget[], focus?: { widget: string; act: string }) => void }) {
  const saved = useSavedSearches().data;
  const move = (i: number, by: number, act: string) => {
    const next = [...d.widgets];
    const [w] = next.splice(i, 1);
    next.splice(i + by, 0, w!);
    onChange(next, { widget: w!.id, act });
  };
  return (
    <div className="dashboard-box">
      <div className="dashboard">
        {d.widgets.map((w, i) => {
          const title = widgetTitle(w, saved);
          return (
            <section key={w.id} className={w.width === 'full' ? 'card widget full' : 'card widget'} aria-label={title} data-widget={w.id}>
              <div className="widget-head">
                <h2>{title}</h2>
                {editing ? (
                  <div className="widget-actions" role="group" aria-label={t('page.dashboard.arrange', { title: title })}>
                    <button type="button" className="small" data-act="earlier" disabled={i === 0} onClick={() => move(i, -1, 'earlier')}>{t('page.dashboard.moveEarlier')}</button>
                    <button type="button" className="small" data-act="later" disabled={i === d.widgets.length - 1} onClick={() => move(i, 1, 'later')}>{t('page.dashboard.moveLater')}</button>
                    <button
                      type="button"
                      className="small"
                      data-act="width"
                      onClick={() =>
                        onChange(
                          d.widgets.map((x) => (x.id === w.id ? { ...x, width: x.width === 'full' ? 'half' : 'full' } : x)),
                          { widget: w.id, act: 'width' },
                        )
                      }
                    >
                      {w.width === 'full' ? t('page.dashboard.makeItHalf') : t('page.dashboard.makeItWide')}
                    </button>
                    <button type="button" className="small danger" onClick={() => onChange(d.widgets.filter((x) => x.id !== w.id))}>{t('page.dashboard.remove')}</button>
                  </div>
                ) : null}
              </div>
              <WidgetBody w={w} />
            </section>
          );
        })}
      </div>
    </div>
  );
}

export default function DashboardPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const me = useMe();
  const list = useDashboards();
  const mine = (list.data ?? []).filter((x) => x.mine);
  const shared = (list.data ?? []).filter((x) => !x.mine);
  const chosen = id ? list.data?.find((x) => x.id === id) : (mine[0] ?? shared[0]);
  const fallback = useDefaultDashboard(Boolean(list.data && !id && !chosen));
  const [editing, setEditing] = useState(false);
  const [said, setSaid] = useState<{ text: string; tone?: 'bad' } | null>(null);
  const [focus, setFocus] = useState<{ widget: string; act: string } | null>(null);
  const pickId = useId();
  const nameId = useId();
  const sharedId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const canWrite = Boolean(me.data?.auth.scopes.includes('write'));

  useEffect(() => {
    if (!focus) return;
    document.querySelector<HTMLButtonElement>(`[data-widget="${focus.widget}"] [data-act="${focus.act}"]`)?.focus();
    setFocus(null);
  }, [focus, list.data]);

  if (list.isLoading) return <Loading what={t('page.dashboard.yourDashboards')} />;
  if (list.error) return <ErrorNote error={list.error} />;
  if (id && !chosen) return <ErrorNote error={new ApiError(404, 'not_found', t('page.dashboard.dashboardNotFound'), t('page.dashboard.itMayHaveBeenDeleted'))} />;
  const d = chosen ?? fallback.data;
  if (!d) return fallback.error ? <ErrorNote error={fallback.error} /> : <Loading what={t('page.dashboard.yourDashboard')} />;

  const refresh = () => qc.invalidateQueries({ queryKey: reportKeys.dashboards });
  const save = async (body: { name?: string; shared?: boolean; widgets?: Widget[] }, nextFocus?: { widget: string; act: string }) => {
    if (!d.id) return;
    try {
      const saved = await saveDashboard(d.id, { ...body, expectedVersion: d.version });
      qc.setQueryData<Dashboard[]>(reportKeys.dashboards, (old) => old?.map((x) => (x.id === saved.id ? saved : x)));
      setSaid({ text: t('page.dashboard.saved') });
      if (nextFocus) setFocus(nextFocus);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        await refresh();
        setSaid({ text: t('page.dashboard.someoneElseChangedThisDashboard'), tone: 'bad' });
      } else setSaid({ text: e instanceof Error ? e.message : t('page.dashboard.itCouldNotBeSaved'), tone: 'bad' });
    }
  };
  const makeOwn = async (from: Dashboard, name: string) => {
    const made = await createDashboard({ name, widgets: from.widgets });
    await refresh();
    navigate(`/dashboard/${made.id}`);
    setEditing(true);
  };

  const picker =
    list.data && list.data.length ? (
      <span className="form-field inline">
        <label htmlFor={pickId}>{t('page.dashboard.dashboard')}</label>
        <select id={pickId} value={d.id ?? ''} onChange={(e) => navigate(`/dashboard/${e.target.value}`)}>
          {!d.id ? <option value="">{d.name}</option> : null}
          {mine.length ? (
            <optgroup label={t('page.dashboard.yours')}>
              {mine.map((x) => (
                <option key={x.id} value={x.id!}>
                  {x.name}
                </option>
              ))}
            </optgroup>
          ) : null}
          {shared.length ? (
            <optgroup label={t('page.dashboard.shared')}>
              {shared.map((x) => (
                <option key={x.id} value={x.id!}>{tr('page.dashboard.s', { name: x.name, v: x.owner?.name ?? t('page.dashboard.someone2') })}</option>
              ))}
            </optgroup>
          ) : null}
        </select>
      </span>
    ) : null;

  return (
    <>
      <PageHead
        title={d.name}
        about={
          !d.id
            ? t('page.dashboard.theDashboardA4aStartsYou')
            : d.mine
              ? d.shared
                ? t('page.dashboard.yoursAndSharedEveryoneCan')
                : t('page.dashboard.yoursAlone')
              : t('page.dashboard.sSharedWithEveryoneEach', { v: d.owner?.name ?? t('page.dashboard.someone') })
        }
        actions={
          <>
            {picker}
            {!d.id && canWrite ? (
              <button type="button" className="primary" onClick={() => makeOwn(d, t('page.dashboard.yourDashboard2'))}>{t('page.dashboard.makeItYours')}</button>
            ) : null}
            {d.id && !d.mine && canWrite ? (
              <button type="button" onClick={() => makeOwn(d, t('page.dashboard.yourCopy', { name: d.name }))}>{t('page.dashboard.copyIt')}</button>
            ) : null}
            {d.canEdit ? (
              <button type="button" aria-pressed={editing} onClick={() => setEditing((e) => !e)}>
                {editing ? t('page.dashboard.doneArranging') : t('page.dashboard.arrange2')}
              </button>
            ) : null}
            {canWrite && d.id ? (
              <button type="button" onClick={async () => {
                const made = await createDashboard({ name: t('page.dashboard.newDashboard') });
                await refresh();
                navigate(`/dashboard/${made.id}`);
                setEditing(true);
              }}>{t('page.dashboard.newDashboard')}</button>
            ) : null}
          </>
        }
      />
      <div className="stack">
        <Said text={said?.text} tone={said?.tone} />
        {editing && d.canEdit ? (
          <section className="card" aria-labelledby={`${nameId}-h`}>
            <h2 id={`${nameId}-h`} ref={heading}>{t('page.dashboard.aboutThisDashboard')}</h2>
            <form
              className="form"
              onSubmit={(e) => {
                e.preventDefault();
                const data = new FormData(e.currentTarget);
                save({ name: String(data.get('name') ?? '').trim() || d.name, shared: data.get('shared') === 'on' });
              }}
            >
              <div className="form-fields">
                <div className="form-field">
                  <label htmlFor={nameId}>{t('page.dashboard.name')}</label>
                  <input id={nameId} name="name" defaultValue={d.name} maxLength={80} required />
                </div>
                <label className="choice" htmlFor={sharedId}>{tr('page.dashboard.sharedWithEveryone', { el: <input id={sharedId} name="shared" type="checkbox" defaultChecked={d.shared} /> })}</label>
              </div>
              <div className="cluster spread">
                <Confirm
                  label={t('page.dashboard.deleteIt')}
                  title={t('page.dashboard.deleteTheDashboard', { name: d.name })}
                  about={t('page.dashboard.itsWidgetsGoWithIt')}
                  confirm={t('page.dashboard.deleteIt')}
                  onConfirm={async () => {
                    await del(`/dashboards/${d.id}`);
                    await refresh();
                    setEditing(false);
                    navigate('/dashboard');
                  }}
                />
                <button type="submit">{t('page.dashboard.save')}</button>
              </div>
            </form>
          </section>
        ) : null}
        {d.widgets.length ? (
          <DashboardView d={d} editing={editing && d.canEdit} onChange={(widgets, f) => save({ widgets }, f)} />
        ) : (
          <p className="note">{d.canEdit ? t('page.dashboard.nothingOnItYetChoose') : t('page.dashboard.nothingOnItYet')}</p>
        )}
        {editing && d.canEdit ? <AddWidget onAdd={(w) => save({ widgets: [...d.widgets, w] }, { widget: w.id, act: 'earlier' })} /> : null}
        <AppWidgets at="dashboard" />
      </div>
    </>
  );
}
