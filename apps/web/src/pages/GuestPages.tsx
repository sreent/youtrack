import type { ArticleDetail, Board, BoardView, Comment, GuestInfo, IssueDetail, IssueField, IssueList, Schedule, Whiteboard, WhiteboardDetail } from '@a4a/shared';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useId, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { ApiError, get, qs } from '../api/client';
import { Lone } from '../app/Auth';
import { GUEST_PLACES, IssueLink, PlacesProvider } from '../app/places';
import { ago, agoSaid, StateBadge } from '../components/Badges';
import { Markdown } from '../components/Markdown';
import { ErrorNote, Loading, PageHead } from '../components/States';
import { ReadOnlyBoard } from '../features/board/Board';
import { addDays, localToday, workCalendar } from '../features/plan/dates';
import { Gantt } from '../features/plan/Gantt';
import { ganttRows } from '../features/plan/gantt';
import { Facts, Warnings } from '../features/plan/Timeline';
import { csvHref, type ReportParams } from '../features/reports/api';
import { REPORTS, ReportView } from '../features/reports/ReportView';
import { formatItems, formatList, t, tr } from '../i18n';
import { SprintPicker } from './BoardPage';
import { WhiteboardView } from './WhiteboardPage';

/**
 * Pages for guests (D37), who aren't signed in: the projects open to anyone, their issues, and an
 * issue with its comments, to read; and (D64) their boards, reports, plans and whiteboards. Nothing
 * here changes anything or names anyone looking; signing in is a link away.
 */

export const useGuestInfo = () => useQuery({ queryKey: ['guest'], queryFn: () => get<GuestInfo>('/guest'), staleTime: 60_000 });

/** A field's value in words, for reading. */
function fieldText(f: IssueField): string | null {
  const one = (x: unknown): string => {
    if (x === null || x === undefined) return '';
    if (typeof x !== 'object') return String(x);
    const o = x as { name?: string; presentation?: string; login?: string };
    return o.presentation ?? o.name ?? o.login ?? '';
  };
  const v = f.value as unknown;
  if (v === null || v === undefined) return null;
  const text = Array.isArray(v) ? formatItems(v.map(one).filter(Boolean)) : one(v);
  return text || null;
}

function SignIn({ next }: { next: string }) {
  return (
    <Link className="button" to={`/login?next=${encodeURIComponent(next)}`}>{t('page.guestPages.signIn')}</Link>
  );
}

/** The projects anyone may read, and one's issues. */
export function GuestHome() {
  const info = useGuestInfo();
  const [params, setParams] = useSearchParams();
  const projects = info.data?.projects ?? [];
  const key = params.get('project') ?? projects[0]?.key ?? '';
  // A report's count opens its issues here, as its query (D64): the list is that query's, then.
  const asked = params.get('q');
  const [page, setPage] = useState(0);
  const issues = useQuery({
    queryKey: ['guest', 'issues', key, page, asked],
    queryFn: () =>
      get<IssueList>(
        asked === null
          ? `/issues?query=${encodeURIComponent(`project: ${key} sort by: updated desc`)}&offset=${page * 25}&limit=25`
          : `/issues?query=${encodeURIComponent(asked)}&offset=${page * 25}&limit=25`,
      ),
    enabled: Boolean(key) || asked !== null,
  });
  return (
    <Lone wide>
      <div className="cluster spread">
        <span className="brand">
          <span className="mark">{t('page.guestPages.a4')}</span>
          <span>{t('page.guestPages.a4a')}</span>
        </span>
        <SignIn next="/issues" />
      </div>
      <h1>{t('page.guestPages.openToAnyone')}</h1>
      {info.isLoading ? <Loading what="loadingLine.projects" /> : null}
      {info.error ? <ErrorNote error={info.error} /> : null}
      {info.data && !projects.length ? <p className="note">{t('page.guestPages.noProjectHereIsOpen')}</p> : null}
      {projects.length > 1 ? (
        <nav className="cluster" aria-label={t('page.guestPages.projectsOpenToAnyone')}>
          {projects.map((p) => (
            <button
              key={p.key}
              type="button"
              aria-pressed={p.key === key}
              onClick={() => {
                setPage(0);
                setParams({ project: p.key });
              }}
            >
              {p.name}
            </button>
          ))}
        </nav>
      ) : null}
      {key && projects.some((p) => p.key === key) ? <MoreToRead project={projects.find((p) => p.key === key)!} /> : null}
      {key || asked !== null ? (
        <section className="stack" aria-labelledby="guest-issues">
          <h2 id="guest-issues">
            {asked === null
              ? tr('page.guestPages.itsIssues', { v: projects.find((p) => p.key === key)?.name ?? key })
              : tr('page.guestPages.issuesMatching', { query: asked })}
          </h2>
          {issues.isLoading ? <Loading what="loadingLine.issues" /> : null}
          {issues.error ? <ErrorNote error={issues.error} /> : null}
          {issues.data && !issues.data.items.length ? <p className="note">{t('page.guestPages.noIssuesYet')}</p> : null}
          {issues.data?.items.length ? (
            <ul className="plain stack tight">
              {issues.data.items.map((i) => {
                return (
                  <li key={i.id} className="cluster">
                    <Link to={`/public/issues/${i.id}`}>
                      <strong>{i.id}</strong> {i.summary}
                    </Link>
                    <StateBadge fields={i.fields} />
                    <span className="note">{tr('page.guestPages.updated', { when: agoSaid(i.updatedAt) })}</span>
                  </li>
                );
              })}
            </ul>
          ) : null}
          {issues.data && issues.data.total > 25 ? (
            <div className="cluster">
              <button type="button" disabled={page === 0} onClick={() => setPage(page - 1)}>{t('page.guestPages.newer')}</button>
              <button type="button" disabled={(page + 1) * 25 >= issues.data.total} onClick={() => setPage(page + 1)}>{t('page.guestPages.older')}</button>
            </div>
          ) : null}
        </section>
      ) : null}
    </Lone>
  );
}

/** One issue and its comments, to read. */
export function GuestIssue() {
  const { id = '' } = useParams();
  const issue = useQuery({ queryKey: ['guest', 'issue', id], queryFn: () => get<IssueDetail>(`/issues/${id}`), retry: false });
  const comments = useQuery({ queryKey: ['guest', 'comments', id], queryFn: () => get<Comment[]>(`/issues/${id}/comments`), enabled: Boolean(issue.data) });
  const missing = issue.error instanceof ApiError && (issue.error.status === 404 || issue.error.status === 401);
  const d = issue.data;
  return (
    // Its words' ids lead to a guest's pages too, as a card's or a count's do (D64).
    <PlacesProvider value={GUEST_PLACES}>
    <Lone wide>
      <div className="cluster spread">
        <Link to="/public">{t('page.guestPages.openToAnyone')}</Link>
        <SignIn next={`/issues/${id}`} />
      </div>
      {issue.isLoading ? <Loading what="loadingLine.issue" /> : null}
      {missing ? (
        <>
          <h1>{id}</h1>
          <p className="note">{t('page.guestPages.thereSNoSuchIssue')}</p>
        </>
      ) : issue.error ? (
        <ErrorNote error={issue.error} />
      ) : null}
      {d ? (
        <article className="stack">
          <p className="note">{tr('page.guestPages.reported', { id: d.id, name: d.project.name, when: agoSaid(d.createdAt), v: d.reporter ? t('page.guestPages.by', { name: d.reporter.name }) : '' })}</p>
          <h1>{d.summary}</h1>
          <dl className="fields-list">
            {d.fields
              .map((f) => [f.name, fieldText(f)] as const)
              .filter(([, v]) => v)
              .map(([name, v]) => (
                <div key={name}>
                  <dt>{name}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
          </dl>
          {d.description ? <Markdown text={d.description} /> : <p className="note">{t('page.guestPages.noDescription')}</p>}
          <section className="stack" aria-labelledby="guest-comments">
            <h2 id="guest-comments">{t('page.guestPages.comments')}</h2>
            {comments.data && !comments.data.length ? <p className="note">{t('page.guestPages.noComments')}</p> : null}
            <ol className="plain stack">
              {(comments.data ?? []).map((c) => (
                <li key={c.id} className="stack tight">
                  <p className="note">
                    {c.author?.name ?? c.requester?.name ?? t('page.guestPages.someone')} · {ago(c.createdAt)}
                  </p>
                  <Markdown text={c.text} />
                </li>
              ))}
            </ol>
          </section>
        </article>
      ) : null}
    </Lone>
    </PlacesProvider>
  );
}


/** An article, to read (D64): a guest's whiteboard card or link opens it here. */
export function GuestArticle() {
  const { id = '' } = useParams();
  const article = useQuery({ queryKey: ['guest', 'article', id], queryFn: () => get<ArticleDetail>(`/articles/${id}`), retry: false });
  const missing = notOpen(article.error);
  const a = article.data;
  return (
    <PlacesProvider value={GUEST_PLACES}>
    <Lone wide>
      <div className="cluster spread">
        <Link to="/public">{t('page.guestPages.openToAnyone')}</Link>
        <SignIn next={`/articles/${id}`} />
      </div>
      {article.isLoading ? <Loading named={id} /> : null}
      {missing ? (
        <>
          <h1>{id}</h1>
          <p className="note">{t('page.guestPages.noSuchArticle')}</p>
        </>
      ) : article.error ? (
        <ErrorNote error={article.error} />
      ) : null}
      {a ? (
        <article className="stack">
          <p className="note">
            {a.path.length ? (
              <>
                {a.path.map((p, i) => (
                  <span key={p.id}>
                    {i > 0 ? ' › ' : ''}
                    <Link to={`/public/articles/${p.id}`}>{p.title}</Link>
                  </span>
                ))}
                {' › '}
              </>
            ) : null}
            {a.project.name} · {tr('page.guestPages.updated', { when: agoSaid(a.updatedAt) })}
          </p>
          <h1>{a.title}</h1>
          {a.body ? <Markdown text={a.body} className="article-body" headingsFrom={2} /> : <p className="note">{t('page.guestPages.noArticleWords')}</p>}
          {a.children.length ? (
            <section className="stack" aria-labelledby="guest-articles-under">
              <h2 id="guest-articles-under">{t('page.articles.underIt')}</h2>
              <ul className="plain stack tight">
                {a.children.map((c) => (
                  <li key={c.id}>
                    <Link to={`/public/articles/${c.id}`}>{c.title}</Link>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {a.mentionedIn.issues.length ? (
            <section className="stack" aria-labelledby="guest-articles-mentioned">
              <h2 id="guest-articles-mentioned">{t('page.articles.mentionedIn')}</h2>
              <ul className="plain stack tight">
                {a.mentionedIn.issues.map((i) => (
                  <li key={i.id}>
                    <IssueLink id={i.id}>{i.id} {i.summary}</IssueLink>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </article>
      ) : null}
    </Lone>
    </PlacesProvider>
  );
}

// ---------------------------------------------------------------------------
// Beyond issues (D64): a board, the reports, a plan and a whiteboard, to read
// ---------------------------------------------------------------------------

/** A guest's page for wide work, a board, a plan or a whiteboard: as wide as the window, on the lone page. */
function Wide({ next, children }: { next: string; children: React.ReactNode }) {
  useEffect(() => {
    document.body.classList.add('lone');
    return () => document.body.classList.remove('lone');
  }, []);
  return (
    <PlacesProvider value={GUEST_PLACES}>
      <main className="stack tw:w-full tw:max-w-7xl tw:self-start">
        <div className="cluster spread">
          <Link to="/public">{t('page.guestPages.openToAnyone')}</Link>
          <SignIn next={next} />
        </div>
        {children}
      </main>
    </PlacesProvider>
  );
}

/** Whether an answer is one a guest gets for what isn't open to them: missing, or no project open at all. */
const notOpen = (e: unknown) => e instanceof ApiError && (e.status === 404 || e.status === 401);

/** What isn't open to guests, said the same whatever the reason, with the way to sign in. */
function NotOpen({ title, words }: { title: string; words: string }) {
  return (
    <section className="card stack">
      <h1>{title}</h1>
      <p className="note">{words}</p>
    </section>
  );
}

/** A project's crumb: the way back to what it opens to guests. */
function ProjectCrumb({ project }: { project: { key: string; name: string } }) {
  return (
    <>
      <Link to={`/public?project=${encodeURIComponent(project.key)}`}>{project.name}</Link>
      <span className="sep" aria-hidden="true">
        /
      </span>
    </>
  );
}

/** A board, to read: its columns and the cards a guest may see, with nothing that moves one. */
export function GuestBoard() {
  const { id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const sprint = params.get('sprint') ?? undefined;
  const view = useQuery({ queryKey: ['guest', 'board', id, sprint ?? ''], queryFn: () => get<BoardView>(`/boards/${encodeURIComponent(id)}/view${qs({ sprint })}`), retry: false });
  const v = view.data;
  return (
    <Wide next={`/boards/${id}`}>
      {view.isLoading ? <Loading what="loadingLine.board" /> : null}
      {notOpen(view.error) ? <NotOpen title={t('page.board.board')} words={t('page.guestPages.noSuchBoard')} /> : view.error ? <ErrorNote error={view.error} /> : null}
      {v ? (
        <>
          <PageHead
            title={v.board.name}
            crumbs={v.board.projects[0] ? <ProjectCrumb project={v.board.projects[0]} /> : undefined}
            about={t('page.board.forInColumnsBy', {
              kind: v.board.sprintsEnabled ? t('page.board.aSprintBoard') : t('page.board.aKanbanBoard'),
              v: formatList(v.board.projects.map((p) => p.name)),
              columnField: v.board.columnField,
              v2: v.board.swimlaneField ? t('page.board.andLanesBy', { swimlaneField: v.board.swimlaneField }) : '',
              points: v.points !== null ? t('page.board.holdsStoryPoints', { v: v.sprint?.name ?? '', named: v.sprint ? 'yes' : 'no', points: v.points }) : '',
            })}
            actions={
              v.sprints.length > 1 ? (
                <SprintPicker
                  sprints={v.sprints}
                  current={v.sprint?.id ?? null}
                  onPick={(s) =>
                    setParams((p) => {
                      const next = new URLSearchParams(p);
                      next.set('sprint', s);
                      return next;
                    })
                  }
                />
              ) : undefined
            }
          />
          {v.board.sprintsEnabled && !v.sprint ? <p className="note">{t('page.board.thisBoardHasNoSprint')}</p> : null}
          {v.columns.every((c) => c.count === 0) ? <p className="note">{v.sprint ? t('page.board.nothingIsInYet', { name: v.sprint.name }) : t('page.board.thereAreNoIssuesOn')}</p> : null}
          <ReadOnlyBoard view={v} />
        </>
      ) : null}
    </Wide>
  );
}

/** A project's plan as it stands: its tasks over time, and nothing of its money or its people's days. */
export function GuestPlan() {
  const { project: key = '' } = useParams();
  const schedule = useQuery({ queryKey: ['guest', 'plan', key], queryFn: () => get<Schedule>(`/projects/${encodeURIComponent(key)}/schedule`), retry: false });
  const s = schedule.data;
  const cal = useMemo(() => workCalendar(s?.calendar), [s?.calendar]);
  const rows = useMemo(() => (s ? ganttRows(s, cal, null) : []), [s, cal]);
  return (
    <Wide next={`/plan/${key}`}>
      {schedule.isLoading ? <Loading what="loadingLine.plan" /> : null}
      {notOpen(schedule.error) ? <NotOpen title={t('page.plan.plan')} words={t('page.guestPages.noSuchProject')} /> : schedule.error ? <ErrorNote error={schedule.error} /> : null}
      {s ? (
        <>
          <PageHead title={t('page.plan.sPlan', { name: s.project.name })} crumbs={<ProjectCrumb project={s.project} />} about={t('page.guestPages.planAbout')} />
          {s.tasks.length === 0 ? (
            <section className="card">
              <h2>{t('plan.timeline.nothingToPlanYet')}</h2>
              <p className="note">{tr('plan.timeline.hasNoIssuesAPlan', { name: s.project.name })}</p>
            </section>
          ) : (
            <>
              <Facts s={s} cal={cal} />
              <Gantt title={s.project.name} rows={rows} start={s.start} finish={s.finish} today={s.today} cal={cal} baselineName={null} whatIf={false} scrollKey={s.project.key} />
              <Warnings warnings={s.warnings} />
            </>
          )}
        </>
      ) : null}
    </Wide>
  );
}

const GUEST_REPORTS = REPORTS.filter((r) => r.kind !== 'time');
const DAYS = [7, 14, 30, 90, 365] as const;

/** The reports over what guests may see: of a project open to them, or all of them. */
export function GuestReports() {
  const { kind: raw = 'flow' } = useParams();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const info = useGuestInfo();
  const boards = useQuery({ queryKey: ['guest', 'boards'], queryFn: () => get<Board[]>('/boards'), retry: false });
  const report = GUEST_REPORTS.find((r) => r.kind === raw) ?? GUEST_REPORTS.find((r) => r.kind === 'flow')!;
  const kind = report.kind;
  const project = params.get('project') ?? '';
  const days = Number(params.get('days')) || (kind === 'cycle-time' || kind === 'time-in-state' ? 90 : 30);
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
  const sprintBoards = (boards.data ?? []).filter((b) => b.sprintsEnabled);
  const board = params.get('board') ?? '';
  const today = localToday();
  const query: ReportParams =
    kind === 'burndown'
      ? { board: board || undefined, by: 'count' }
      : kind === 'issues-per-field' || kind === 'matrix'
        ? { project: project || undefined, ...(kind === 'matrix' ? { rows: 'Priority', columns: 'State' } : { field: 'Priority' }) }
        : { project: project || undefined, from: addDays(today, -(days - 1)), to: today };
  const ready = kind !== 'burndown' || Boolean(board);
  const projectId = useId();
  const daysId = useId();
  const boardId = useId();
  return (
    <Wide next={`/reports/${kind}`}>
      <PageHead title={t('page.reports.reports')} about={t('page.guestPages.reportsAbout')} />
      <div className="modes report-choice" role="group" aria-label={t('page.reports.whichReport')}>
        {GUEST_REPORTS.map((r) => (
          <button key={r.kind} type="button" aria-pressed={r.kind === kind} onClick={() => navigate({ pathname: `/public/reports/${r.kind}`, search: params.toString() })}>
            {r.label}
          </button>
        ))}
      </div>
      <p className="note">{report.about}</p>
      <div className="cluster">
        {kind === 'burndown' ? (
          <span className="form-field inline">
            <label htmlFor={boardId}>{t('page.reports.board')}</label>
            <select id={boardId} value={board} onChange={(e) => set('board', e.target.value || null)}>
              <option value="">{t('page.reports.chooseABoard')}</option>
              {sprintBoards.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </span>
        ) : (
          <span className="form-field inline">
            <label htmlFor={projectId}>{t('page.reports.project')}</label>
            <select id={projectId} value={project} onChange={(e) => set('project', e.target.value || null)}>
              <option value="">{t('page.reports.everyProject')}</option>
              {(info.data?.projects ?? []).map((p) => (
                <option key={p.key} value={p.key}>
                  {p.name}
                </option>
              ))}
            </select>
          </span>
        )}
        {kind === 'burndown' || kind === 'issues-per-field' || kind === 'matrix' ? null : (
          <span className="form-field inline">
            <label htmlFor={daysId}>{t('page.reports.days')}</label>
            <select id={daysId} value={String(days)} onChange={(e) => set('days', e.target.value)}>
              {DAYS.map((d) => (
                <option key={d} value={d}>
                  {tr('page.reports.theLastDays', { d })}
                </option>
              ))}
            </select>
          </span>
        )}
      </div>
      <section className="card" aria-label={report.label}>
        {ready ? <ReportView kind={kind} params={query} /> : <p className="note">{t('page.reports.chooseABoardWithSprints')}</p>}
      </section>
      {ready ? (
        <div className="cluster">
          <a className="button" href={csvHref(kind, query)} download>
            {t('page.reports.downloadTheFiguresCsv')}
          </a>
        </div>
      ) : null}
    </Wide>
  );
}

/** A whiteboard, to read, live: what its team changes shows as they change it; nobody is shown looking. */
export function GuestWhiteboard() {
  const { id = '' } = useParams();
  const detail = useQuery({ queryKey: ['guest', 'whiteboard', id], queryFn: () => get<WhiteboardDetail>(`/whiteboards/${encodeURIComponent(id)}`), retry: false, staleTime: Infinity, refetchOnWindowFocus: false });
  return (
    <Wide next={`/whiteboards/${id}`}>
      {detail.isLoading ? <Loading what="loadingLine.whiteboard" /> : null}
      {notOpen(detail.error) ? <NotOpen title={t('app.shell.whiteboards')} words={t('page.guestPages.noSuchWhiteboard')} /> : detail.error ? <ErrorNote error={detail.error} /> : null}
      {detail.data ? <WhiteboardView key={detail.data.whiteboard.id} detail={detail.data} /> : null}
    </Wide>
  );
}

/** What else a project opens to guests: its plan, its reports, its boards and its whiteboards. */
function MoreToRead({ project }: { project: { key: string; name: string } }) {
  const boards = useQuery({ queryKey: ['guest', 'boards'], queryFn: () => get<Board[]>('/boards'), retry: false });
  const whiteboards = useQuery({ queryKey: ['guest', 'whiteboards', project.key], queryFn: () => get<Whiteboard[]>(`/whiteboards${qs({ project: project.key })}`), retry: false });
  const theirs = (boards.data ?? []).filter((b) => b.projects.some((p) => p.key === project.key));
  return (
    <section className="stack" aria-labelledby="guest-more">
      <h2 id="guest-more">{t('page.guestPages.alsoOpenIn', { name: project.name })}</h2>
      <p className="cluster">
        <Link to={`/public/plan/${encodeURIComponent(project.key)}`}>{t('page.guestPages.plan')}</Link>
        <Link to={`/public/reports/flow?project=${encodeURIComponent(project.key)}`}>{t('page.guestPages.reports')}</Link>
      </p>
      <div className="stack tight">
        <h3>{t('page.guestPages.boards')}</h3>
        {boards.data && !theirs.length ? <p className="note">{t('page.guestPages.noBoards')}</p> : null}
        <ul className="plain stack tight">
          {theirs.map((b) => (
            <li key={b.id}>
              <Link to={`/public/boards/${b.id}`}>{b.name}</Link>
            </li>
          ))}
        </ul>
      </div>
      <div className="stack tight">
        <h3>{t('page.guestPages.whiteboards')}</h3>
        {whiteboards.data && !whiteboards.data.length ? <p className="note">{t('page.guestPages.noWhiteboards')}</p> : null}
        <ul className="plain stack tight">
          {(whiteboards.data ?? []).map((wb) => (
            <li key={wb.id}>
              <Link to={`/public/whiteboards/${wb.id}`}>{wb.name}</Link>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
