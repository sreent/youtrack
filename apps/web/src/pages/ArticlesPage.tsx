import type { Article, ArticleDetail } from '@a4a/shared';
import { toggleTask } from '@a4a/shared/markdown';
import { useQueryClient } from '@tanstack/react-query';
import { Fragment, useEffect, useId, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import { ApiError, del, patch, post } from '../api/client';
import { useProject, useProjects } from '../api/queries';
import { Badge } from '../components/Badges';
import { Markdown } from '../components/Markdown';
import { RichField } from '../features/editor/RichField';
import { Empty, ErrorLine, ErrorNote, Loading, PageHead } from '../components/States';
import { actorWho, Who } from '../components/Who';
import { articleKeys, subtreeOf, useArticle, useArticleSearch, useArticleTree, useArticleVersion, useArticleVersions } from '../features/articles/api';
import { ArticleTree } from '../features/articles/ArticleTree';
import { ArticleVisibleTo } from '../features/articles/ArticleVisibleTo';
import { Diff, diffWords } from '../features/articles/Diff';
import { attachmentKeys, useArticleAttachments, useAttachmentLimits } from '../features/attachments/api';
import { AttachmentList } from '../features/attachments/AttachmentList';
import { FormField, Said } from '../features/common/bits';
import { Confirm } from '../features/common/Confirm';
import { whenRead } from '../features/common/format';
import { errorText, useStateTones } from '../features/issues/api';
import { LimitPicker, type Limit } from '../features/issues/VisibleTo';
import { AppWidgets } from '../features/apps/AppWidgets';
import { intlLocale, t, tr } from '../i18n';
import type { ReactNode } from 'react';

type View = 'home' | 'article' | 'new' | 'edit' | 'history';

export default function ArticlesPage({ view }: { view: View }) {
  const { id } = useParams();
  const { search } = useLocation();
  if (view === 'article') return <ArticleView />;
  // A fresh editor for each article, and for each place a new one goes.
  if (view === 'new' || view === 'edit') return <Editor key={`${view}:${id ?? ''}:${search}`} mode={view} />;
  if (view === 'history') return <History />;
  return <Home />;
}

/** Whether the person may change a project's articles: their role in it, not only their token's scope. */
function useCanWrite(projectKey: string | undefined): boolean {
  const project = useProject(projectKey);
  return Boolean(project.data?.access.write);
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

const REMEMBERED = 'a4a.kb.project';
function remembered(): string | null {
  try {
    return localStorage.getItem(REMEMBERED);
  } catch {
    return null;
  }
}

/** The project's tree beside what's open; on a phone, what's open comes first. */
function Beside({ project, name, current, children }: { project: string; name: string; current?: string; children: React.ReactNode }) {
  const canWrite = useCanWrite(project);
  return (
    <div className="tw:grid tw:grid-cols-[17rem_minmax(0,1fr)] tw:items-start tw:gap-4 tw:max-[900px]:grid-cols-1">
      <ArticleTree project={project} name={name} current={current} canWrite={canWrite} />
      <div className="stack tw:max-[900px]:-order-1">{children}</div>
    </div>
  );
}

function Crumbs({ project, name, path }: { project: string; name: string; path?: { id: string; title: string }[] }) {
  return (
    <>
      <Link to="/articles">{t('page.articles.knowledgeBase')}</Link> / <Link to={`/articles?project=${project}`}>{name}</Link>
      {(path ?? []).map((p) => (
        <Fragment key={p.id}>
          {' '}
          / <Link to={`/articles/${p.id}`}>{p.title}</Link>
        </Fragment>
      ))}
    </>
  );
}

function NotHere({ id, error }: { id: string; error: unknown }) {
  return (
    <>
      <PageHead title={id} crumbs={<Link to="/articles">{t('page.articles.knowledgeBase')}</Link>} />
      {error instanceof ApiError && error.status === 404 ? (
        <section className="card stack tight">
          <p>{tr('page.articles.thereSNoArticleOr', { id: id })}</p>
          {error.hint ? <p className="note">{error.hint}</p> : null}
        </section>
      ) : (
        <ErrorNote error={error} />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// The knowledge base's front: a project's tree, and a search in it
// ---------------------------------------------------------------------------

function Home() {
  const projects = useProjects();
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useState(params.get('q') ?? '');
  const words = useDebounced(query.trim(), 250);
  const wanted = (params.get('project') ?? remembered() ?? '').toUpperCase();
  const project = projects.data?.find((p) => p.key.toUpperCase() === wanted) ?? projects.data?.[0];
  const canWrite = Boolean(project?.access.write);
  const found = useArticleSearch(project?.key, words);
  const projectId = useId();
  const searchId = useId();

  useEffect(() => {
    if (!project) return;
    try {
      localStorage.setItem(REMEMBERED, project.key);
    } catch {
      // a private window: nothing to remember
    }
  }, [project]);
  useEffect(() => {
    const next = new URLSearchParams(params);
    if (words) next.set('q', words);
    else next.delete('q');
    if (next.toString() !== params.toString()) setParams(next, { replace: true });
  }, [words, params, setParams]);

  const head = (
    <PageHead
      title={t('page.articles.knowledgeBase')}
      about={t('page.articles.whatTheTeamKnowsWritten')}
      actions={
        canWrite && project ? (
          <Link className="button primary" to={`/articles/new?project=${project.key}`}>{t('page.articles.newArticle')}</Link>
        ) : null
      }
    />
  );
  if (projects.isLoading || projects.error) {
    return (
      <>
        {head}
        {projects.error ? <ErrorNote error={projects.error} /> : <Loading what="loadingLine.projects" />}
      </>
    );
  }
  if (!project) {
    return (
      <>
        {head}
        <Empty title={t('page.articles.noProjectsYet')}>{t('page.articles.articlesBelongToAProject')}</Empty>
      </>
    );
  }
  return (
    <div className="stack">
      {head}
      <form role="search" className="cluster" onSubmit={(e) => e.preventDefault()}>
        <div className="form-field inline">
          <label htmlFor={projectId}>{t('page.articles.project')}</label>
          <select
            id={projectId}
            value={project.key}
            onChange={(e) => {
              const next = new URLSearchParams(params);
              next.set('project', e.target.value);
              setParams(next);
            }}
          >
            {(projects.data ?? []).map((p) => (
              <option key={p.id} value={p.key}>
                {p.name} ({p.key})
              </option>
            ))}
          </select>
        </div>
        <div className="form-field inline grow">
          <label htmlFor={searchId}>{t('page.articles.find')}</label>
          <input id={searchId} className="grow" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('page.articles.wordsInTitlesAndArticles')} />
        </div>
      </form>
      <Beside project={project.key} name={project.name}>
        <section className="card stack" aria-labelledby="kb-found" aria-busy={found.isFetching}>
          <h2 id="kb-found">
            {words ? t('page.articles.countFor', { n: found.data?.total ?? 0, words: words }) : t('page.articles.latestChangedIn', { name: project.name })}
          </h2>
          {found.error ? <ErrorNote error={found.error} /> : null}
          {found.data && !found.data.items.length ? (
            <p className="note">{words ? t('page.articles.nothingMatchesTryFewerWords') : t('page.articles.noArticlesYetWriteThe')}</p>
          ) : null}
          {found.data?.items.length ? (
            <ul className="article-results">
              {found.data.items.map((a) => (
                <li key={a.id}>
                  <Link to={`/articles/${a.id}`}>{a.title}</Link>
                  <span className="article-meta">
                    {a.path.length ? <span>{a.path.join(' / ')}</span> : null}
                    <span className="issue-id">{a.id}</span>
                    <time dateTime={a.updatedAt}>{whenRead(a.updatedAt)}</time>
                  </span>
                  {a.snippet.some((p) => p.text.trim()) ? (
                    <p>
                      {a.snippet.map((p, i) => (p.match ? <mark key={i}>{p.text}</mark> : <Fragment key={i}>{p.text}</Fragment>))}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      </Beside>
    </div>
  );
}

// ---------------------------------------------------------------------------
// An article
// ---------------------------------------------------------------------------

function MentionedIn({ a }: { a: ArticleDetail }) {
  const tones = useStateTones();
  const { issues, articles } = a.mentionedIn;
  return (
    <section className="card issue-links-box stack" aria-labelledby="mentioned-title">
      <h2 id="mentioned-title">{t('page.articles.mentionedIn')}</h2>
      {issues.length || articles.length ? (
        <ul className="link-list">
          {issues.map((i) => (
            <li key={i.id} className={i.resolved ? 'resolved' : undefined}>
              <span className="issue-id">{i.id}</span>
              <Link to={`/issues/${i.id}`}>{i.summary}</Link>
              {i.state ? <Badge tone={tones.get(i.state) ?? null}>{i.state}</Badge> : null}
            </li>
          ))}
          {articles.map((x) => (
            <li key={x.id}>
              <span className="issue-id">{x.id}</span>
              <Link to={`/articles/${x.id}`}>{x.title}</Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="note">{tr('page.articles.noIssueOrArticleMentions', { id: a.id })}</p>
      )}
    </section>
  );
}

function ArticleFiles({ a, canWrite }: { a: ArticleDetail; canWrite: boolean }) {
  const qc = useQueryClient();
  const files = useArticleAttachments(a.id);
  const limits = useAttachmentLimits();
  if (files.isLoading) return <Loading what="loadingLine.files" />;
  if (files.error) return <ErrorNote error={files.error} />;
  return (
    <AttachmentList
      label={t('page.articles.files')}
      owner={a.id}
      files={files.data ?? []}
      limits={limits.data}
      uploadPath={canWrite ? `/articles/${a.id}/attachments` : undefined}
      canDelete={() => canWrite}
      onChanged={() => qc.invalidateQueries({ queryKey: attachmentKeys.article(a.id) })}
    />
  );
}

/** Where an article sits: under which article, and its place among those beside it; and deleting it. */
function MoveOrDelete({ a }: { a: ArticleDetail }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const tree = useArticleTree(a.project.key);
  const flat = useMemo(() => tree.data ?? [], [tree.data]);
  const [parent, setParent] = useState(a.parent ?? '');
  const [place, setPlace] = useState('stay');
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  const parentId = useId();
  const placeId = useId();
  useEffect(() => {
    setParent(a.parent ?? '');
    setPlace('stay');
  }, [a.parent, a.position]);

  const own = subtreeOf(flat, a.id);
  const depth = (x: Article) => {
    let d = 0;
    const byId = new Map(flat.map((f) => [f.id, f]));
    for (let p = x.parent ? byId.get(x.parent) : undefined; p && d < 50; p = p.parent ? byId.get(p.parent) : undefined) d++;
    return d;
  };
  const siblings = flat.filter((x) => (x.parent ?? '') === parent && x.id !== a.id);
  const same = parent === (a.parent ?? '');
  // Who sees it there (D51): only who sees the nearest limited article above the new place, or,
  // out from under every limited one, everyone in the project unless it's limited itself.
  const limitedThere = (() => {
    const byId = new Map(flat.map((f) => [f.id, f]));
    for (let x = parent ? byId.get(parent) : undefined, n = 0; x && n < 200; x = x.parent ? byId.get(x.parent) : undefined, n++) if (x.limited) return x;
    return undefined;
  })();
  const whoThere = same
    ? null
    : limitedThere
      ? t('page.articles.movingUnderLimited', { title: limitedThere.title })
      : a.limitedAbove.length && !a.limited
        ? t('page.articles.movingOutOfLimited', { key: a.project.key })
        : null;
  const position =
    place === 'stay' ? undefined : place === 'first' ? 0 : place === 'last' ? siblings.length : siblings.findIndex((s) => s.id === place.slice(6)) + 1;
  const changes = !same || position !== undefined;

  const move = async () => {
    setBusy(true);
    setSaid(null);
    try {
      const next = await patch<ArticleDetail>(`/articles/${a.id}`, { parent: parent || null, ...(position !== undefined ? { position } : {}) });
      qc.setQueryData(articleKeys.one(a.id), next);
      await qc.invalidateQueries({ queryKey: articleKeys.all });
      setSaid({ text: next.parent ? t('page.articles.sitsUnderNowInPlace', { id: a.id, parent: next.parent, v: next.position + 1 }) : t('page.articles.sitsAtTheTopOf', { id: a.id, v: next.position + 1 }) });
    } catch (e) {
      setSaid({ text: errorText(e), bad: true });
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    setSaid(null);
    try {
      await del(`/articles/${a.id}`);
      await qc.invalidateQueries({ queryKey: articleKeys.all });
      navigate(a.parent ? `/articles/${a.parent}` : `/articles?project=${a.project.key}`, { state: { said: t('page.articles.isGone', { id: a.id, title: a.title }) } });
    } catch (e) {
      setSaid({ text: errorText(e), bad: true });
    }
  };

  return (
    <section className="card stack" aria-labelledby="move-title">
      <h2 id="move-title">{t('page.articles.moveOrDelete')}</h2>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          if (changes) void move();
        }}
      >
        <div className="form-fields">
          <div className="form-field">
            <label htmlFor={parentId}>{t('page.articles.putItUnder')}</label>
            <select
              id={parentId}
              value={parent}
              onChange={(e) => {
                setParent(e.target.value);
                setPlace(e.target.value === (a.parent ?? '') ? 'stay' : 'last');
              }}
            >
              <option value="">{t('page.articles.theTopOfTheTree')}</option>
              {flat
                .filter((x) => !own.has(x.id))
                .map((x) => (
                  <option key={x.id} value={x.id}>
                    {' '.repeat(depth(x))}
                    {x.title} ({x.id})
                  </option>
                ))}
            </select>
          </div>
          <div className="form-field">
            <label htmlFor={placeId}>{t('page.articles.itsPlace')}</label>
            <select id={placeId} value={place} onChange={(e) => setPlace(e.target.value)}>
              {same ? <option value="stay">{t('page.articles.whereItIsNow')}</option> : null}
              <option value="first">{t('page.articles.first')}</option>
              {siblings.map((s) => (
                <option key={s.id} value={`after:${s.id}`}>{tr('page.articles.after', { title: s.title })}</option>
              ))}
              <option value="last">{t('page.articles.last')}</option>
            </select>
          </div>
        </div>
        {whoThere ? <p className="note">{whoThere}</p> : null}
        <div className="cluster spread">
          <Confirm
            label={t('page.articles.deleteIt')}
            title={t('page.articles.delete', { id: a.id, title: a.title })}
            about={t('page.articles.itsVersionsAndFilesGo', { n: a.version, v2: a.childCount ? t('page.articles.moveOrDeleteTheArticles') : '' })}
            confirm={t('page.articles.deleteIt')}
            onConfirm={() => void remove()}
          />
          <button type="submit" disabled={!changes || busy}>
            {busy ? t('page.articles.moving') : t('page.articles.moveIt')}
          </button>
        </div>
      </form>
      <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />
    </section>
  );
}

function ArticleView() {
  const { id = '' } = useParams();
  const location = useLocation();
  const qc = useQueryClient();
  const article = useArticle(id);
  const canWrite = useCanWrite(article.data?.project.key);
  const said = (location.state as { said?: string } | null)?.said;
  // A box ticked shows ticked while it's saved, as a new version, against the version read (D39).
  const [ticked, setTicked] = useState<string | null>(null);
  const [tickSaid, setTickSaid] = useState<string | null>(null);
  if (article.isLoading) return <Loading named={id} />;
  if (article.error || !article.data) return <NotHere id={id} error={article.error} />;
  const a = article.data;
  const tick = async (index: number, checked: boolean) => {
    const next = toggleTask(a.body, index, checked);
    if (next === null) return;
    setTickSaid(null);
    setTicked(next);
    try {
      const saved = await patch<ArticleDetail>(`/articles/${a.id}`, { body: next, expectedVersion: a.version });
      qc.setQueryData(articleKeys.one(saved.id), saved);
    } catch (e) {
      setTickSaid(e instanceof ApiError && e.status === 409 ? t('page.articles.someoneSavedANewerVersion2') : errorText(e));
    } finally {
      await qc.invalidateQueries({ queryKey: articleKeys.all });
      setTicked(null);
    }
  };
  const by = a.updatedBy?.name ?? t('page.articles.someone');
  return (
    <>
      <PageHead
        crumbs={<Crumbs project={a.project.key} name={a.project.name} path={a.path} />}
        title={a.title}
        badges={
          <>
            <span className="issue-id">{a.id}</span>
            {a.limited || a.limitedAbove.length ? <Badge tone="idle" title={t('articles.articleTree.onlySomeSeeIt')}>{t('articles.articleTree.limited')}</Badge> : null}
          </>
        }
        meta={
          <>
            <span>{tr('page.articles.by', { v: a.version === 1 ? t('page.articles.written') : t('page.articles.changed'), by: by, whenRead: whenRead(a.updatedAt), t0: (c: ReactNode) => <time dateTime={a.updatedAt} title={new Date(a.updatedAt).toLocaleString(intlLocale())}>{c}</time> })}</span>
            <span>{tr('page.articles.version', { version: a.version })}</span>
          </>
        }
        actions={
          <>
            <Link className="button" to={`/articles/${a.id}/history`}>{t('page.articles.history')}</Link>
            {canWrite ? (
              <>
                <Link className="button" to={`/articles/new?project=${a.project.key}&parent=${a.id}`}>{t('page.articles.newArticleUnderIt')}</Link>
                <Link className="button primary" to={`/articles/${a.id}/edit`}>{t('page.articles.edit')}</Link>
              </>
            ) : null}
          </>
        }
      />
      <div className="stack">
        {said ? <Said text={said} /> : null}
        <Beside project={a.project.key} name={a.project.name} current={a.id}>
          <article className="card" aria-label={a.title}>
            {a.body.trim() ? (
              <Markdown text={ticked ?? a.body} className="article-body" headingsFrom={2} onToggleTask={canWrite && ticked === null ? (i, on) => void tick(i, on) : undefined} />
            ) : (
              <p className="article-empty">{tr('page.articles.nothingWrittenYet', { v: canWrite ? <Link to={`/articles/${a.id}/edit`}>{t('page.articles.writeIt')}</Link> : null })}</p>
            )}
            {tickSaid ? <ErrorLine>{tickSaid}</ErrorLine> : null}
          </article>
          {a.children.length ? (
            <section className="card stack" aria-labelledby="under-title">
              <h2 id="under-title">{t('page.articles.underIt')}</h2>
              <ul className="directory">
                {a.children.map((c) => (
                  <li key={c.id}>
                    <div className="directory-name">
                      <Link to={`/articles/${c.id}`}>{c.title}</Link>
                      <span className="issue-id">{c.id}</span>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          <ArticleVisibleTo key={`visible-${a.id}`} a={a} canWrite={canWrite} />
          <MentionedIn a={a} />
          <ArticleFiles key={`files-${a.id}`} a={a} canWrite={canWrite} />
          <AppWidgets at="article-panel" article={a.id} />
          {canWrite ? <MoveOrDelete key={`move-${a.id}`} a={a} /> : null}
        </Beside>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Writing: a new article, or a new version of one
// ---------------------------------------------------------------------------

function Editor({ mode }: { mode: 'new' | 'edit' }) {
  const { id } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const projects = useProjects();
  const existing = useArticle(mode === 'edit' ? id : undefined);
  const project = (mode === 'edit' ? existing.data?.project.key : params.get('project')) ?? projects.data?.[0]?.key ?? '';
  const tree = useArticleTree(project || undefined);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [parent, setParent] = useState(params.get('parent')?.toUpperCase() ?? '');
  const [limit, setLimit] = useState<Limit | null>(null);
  const [show, setShow] = useState<'write' | 'read'>('write');
  const [loadedVersion, setLoadedVersion] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState<number | null>(null);
  const titleId = useId();
  const bodyId = useId();
  const parentId = useId();

  // What's being changed, as it was when the editor opened; a reload takes the newest.
  useEffect(() => {
    if (mode === 'edit' && existing.data && loadedVersion === null) {
      setTitle(existing.data.title);
      setBody(existing.data.body);
      setLoadedVersion(existing.data.version);
    }
  }, [mode, existing.data, loadedVersion]);
  const dirty = mode === 'new' ? Boolean(title.trim() || body.trim()) : existing.data ? title !== existing.data.title || body !== existing.data.body : false;
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  if (mode === 'edit' && existing.isLoading) return <Loading named={id} />;
  if (mode === 'edit' && (existing.error || !existing.data)) return <NotHere id={id ?? ''} error={existing.error} />;
  const projectRow = projects.data?.find((p) => p.key.toUpperCase() === project.toUpperCase());
  const name = existing.data?.project.name ?? projectRow?.name ?? project;
  const back = mode === 'edit' ? `/articles/${id}` : parent ? `/articles/${parent}` : `/articles?project=${project}`;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      if (mode === 'new') {
        const made = await post<ArticleDetail>('/articles', { project, title, body, ...(parent ? { parent } : {}), ...(limit ? { visibleTo: limit } : {}) });
        await qc.invalidateQueries({ queryKey: articleKeys.all });
        navigate(`/articles/${made.id}`, { state: { said: t('page.articles.isWritten', { id: made.id }) } });
      } else {
        const next = await patch<ArticleDetail>(`/articles/${id}`, { title, body, expectedVersion: loadedVersion ?? undefined });
        qc.setQueryData(articleKeys.one(next.id), next);
        await qc.invalidateQueries({ queryKey: articleKeys.all });
        navigate(`/articles/${next.id}`, { state: { said: next.version === loadedVersion ? t('page.articles.nothingChangedSoThereIs') : t('page.articles.savedAsVersion', { version: next.version }) } });
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        const current = (e.details as { currentVersion?: number } | undefined)?.currentVersion ?? null;
        setStale(current);
        setError(t('page.articles.someoneSavedVersionOfWhile', { v: current ?? t('page.articles.aNewerVersion'), id: id }));
      } else setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const reload = async () => {
    const fresh = await existing.refetch();
    if (fresh.data) {
      setTitle(fresh.data.title);
      setBody(fresh.data.body);
      setLoadedVersion(fresh.data.version);
    }
    setStale(null);
    setError(null);
  };

  const flat = tree.data ?? [];
  return (
    <>
      <PageHead
        crumbs={<Crumbs project={project} name={name} path={mode === 'edit' ? [...(existing.data?.path ?? []), { id: id!, title: existing.data!.title }] : undefined} />}
        title={mode === 'new' ? t('page.articles.newArticle') : t('page.articles.editing', { title: existing.data!.title })}
        badges={mode === 'edit' ? <span className="issue-id">{id}</span> : null}
        about={mode === 'edit' ? t('page.articles.savingMakesVersionEveryEarlier', { v: (loadedVersion ?? 0) + 1 }) : t('page.articles.inSKnowledgeBaseMarkdown', { name: name })}
      />
      <form
        className="card article-editor"
        data-show={show}
        aria-label={mode === 'new' ? t('page.articles.aNewArticle') : t('page.articles.editing2', { id: id })}
        onSubmit={(e) => {
          e.preventDefault();
          if (title.trim()) void save();
        }}
      >
        <div className="form-fields">
          <div className="form-field">
            <label htmlFor={titleId}>{t('page.articles.title')}</label>
            <input id={titleId} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={250} required autoFocus={mode === 'new'} />
          </div>
          {mode === 'new' ? (
            <div className="form-field">
              <label htmlFor={parentId}>{t('page.articles.whereItGoes')}</label>
              <select id={parentId} value={parent} onChange={(e) => setParent(e.target.value)}>
                <option value="">{t('page.articles.theTopOfTheTree')}</option>
                {flat.map((x) => (
                  <option key={x.id} value={x.id}>{tr('page.articles.under', { title: x.title, id: x.id })}</option>
                ))}
              </select>
            </div>
          ) : null}
        </div>
        {mode === 'new' ? (
          <div className="stack tight">
            <label className="choice">
              <input type="checkbox" checked={limit !== null} onChange={(e) => setLimit(e.target.checked ? { users: [], groups: [] } : null)} />
              <span>{t('page.articles.limitWhoSeesIt')}</span>
            </label>
            {limit ? <LimitPicker value={limit} onChange={setLimit} legend={t('articles.visibleTo.whoElseSeesIt')} always={t('articles.visibleTo.always', { key: project })} /> : null}
          </div>
        ) : null}
        <div className="modes" role="group" aria-label={t('page.articles.show')}>
          <button type="button" aria-pressed={show === 'write'} onClick={() => setShow('write')}>{t('page.articles.write')}</button>
          <button type="button" aria-pressed={show === 'read'} onClick={() => setShow('read')}>{t('page.articles.preview')}</button>
        </div>
        <div className="article-editor-panes">
          <div className="form-field article-editor-write">
            <label htmlFor={bodyId}>{t('page.articles.whatItSays')}</label>
            <RichField
              id={bodyId}
              label={t('page.articles.whatItSays')}
              value={body}
              onChange={setBody}
              tall
              uploadTo={mode === 'edit' && id ? `/articles/${id}/attachments` : undefined}
              onUploaded={() => void qc.invalidateQueries({ queryKey: attachmentKeys.article(id ?? '') })}
            />
          </div>
          <div className="article-preview" role="region" aria-label={t('page.articles.howItWillRead')}>
            {body.trim() ? <Markdown text={body} className="article-body" headingsFrom={2} /> : <p className="article-empty">{t('page.articles.howItReadsShowsHere')}</p>}
          </div>
        </div>
        {error ? <ErrorLine>{error}</ErrorLine> : null}
        <div className="cluster end">
          {stale !== null ? (
            <Confirm
              label={t('page.articles.reloadIt')}
              title={t('page.articles.reload', { id: id })}
              about={t('page.articles.versionTakesThePlaceOf', { stale: stale })}
              confirm={t('page.articles.reloadIt')}
              onConfirm={() => void reload()}
            />
          ) : null}
          <Link className="button" to={back}>{t('page.articles.cancel')}</Link>
          <button type="submit" className="primary" disabled={busy || !title.trim()}>
            {busy ? t('page.articles.saving') : mode === 'new' ? t('page.articles.saveIt') : t('page.articles.saveVersion', { v: (loadedVersion ?? 0) + 1 })}
          </button>
        </div>
      </form>
    </>
  );
}

// ---------------------------------------------------------------------------
// Its history: every version, and each against the one before
// ---------------------------------------------------------------------------

function History() {
  const { id = '' } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const article = useArticle(id);
  const canWrite = useCanWrite(article.data?.project.key);
  const versions = useArticleVersions(id);
  const latest = versions.data?.[0]?.version;
  const chosen = Number(params.get('v')) || latest;
  const detail = useArticleVersion(id, chosen);
  const [said, setSaid] = useState<string | null>(null);

  if (article.isLoading || versions.isLoading) return <Loading what="loadingLine.articleHistory" />;
  if (article.error || !article.data) return <NotHere id={id} error={article.error} />;
  const a = article.data;
  const restore = async (version: number) => {
    setSaid(null);
    try {
      const next = await post<ArticleDetail>(`/articles/${a.id}/versions/${version}/restore`, { expectedVersion: a.version });
      await qc.invalidateQueries({ queryKey: articleKeys.all });
      navigate(`/articles/${a.id}`, { state: { said: t('page.articles.versionIsBackAsVersion', { version: version, version2: next.version }) } });
    } catch (e) {
      setSaid(e instanceof ApiError && e.status === 409 ? t('page.articles.someoneSavedANewerVersion') : errorText(e));
      await qc.invalidateQueries({ queryKey: articleKeys.one(a.id) });
    }
  };
  const d = detail.data;
  const who = d ? actorWho({ id: d.author?.id ?? null, login: d.author?.login ?? null, name: d.author?.name ?? null, channel: d.channel, token: d.token, isBot: d.author?.isBot ?? false }) : null;
  return (
    <>
      <PageHead
        crumbs={<Crumbs project={a.project.key} name={a.project.name} path={[...a.path, { id: a.id, title: a.title }]} />}
        title={t('page.articles.historyOf', { title: a.title })}
        badges={<span className="issue-id">{a.id}</span>}
        about={t('page.articles.everySavedVersionNewestFirst')}
      />
      <div className="stack">
        {versions.error ? <ErrorNote error={versions.error} /> : null}
        <div className="tw:grid tw:grid-cols-[17rem_minmax(0,1fr)] tw:items-start tw:gap-4 tw:max-[900px]:grid-cols-1">
          <nav className="card side-card nav-card" aria-label={t('page.articles.versionsOf', { title: a.title })}>
            <h2>{versions.data?.length === 1 ? t('page.articles.n1Version') : t('page.articles.versions2', { v: versions.data?.length ?? 0 })}</h2>
            <ul className="nav-list scrolls">
              {(versions.data ?? []).map((v) => {
                const by = actorWho({ id: v.author?.id ?? null, login: v.author?.login ?? null, name: v.author?.name ?? null, channel: v.channel, token: v.token, isBot: v.author?.isBot ?? false });
                return (
                  <li key={v.version}>
                    <Link to={`/articles/${a.id}/history?v=${v.version}`} aria-current={v.version === chosen ? 'page' : undefined}>
                      <span className="nav-list-name">{tr('page.articles.version', { version: v.version })}</span>
                      <span className="nav-list-about">
                        <span>
                          {by.name}
                          {by.about ? ` ${by.about}` : ''}
                        </span>
                        <span>{whenRead(v.createdAt)}</span>
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>
          <section className="card stack tw:max-[900px]:-order-1" aria-labelledby="version-title" aria-busy={detail.isFetching}>
            <div className="cluster spread">
              <h2 id="version-title">{chosen ? t('page.articles.version2', { chosen: chosen }) : t('page.articles.noVersions')}</h2>
              {canWrite && chosen && chosen !== latest ? (
                <button type="button" className="small" onClick={() => void restore(chosen)}>{t('page.articles.bringItBack')}</button>
              ) : null}
            </div>
            {detail.error ? <ErrorNote error={detail.error} /> : null}
            {d && who ? (
              <>
                <p className="article-meta">
                  <Who kind={who.kind} name={who.name} about={who.about || undefined} small />
                  <time dateTime={d.createdAt} title={new Date(d.createdAt).toLocaleString(intlLocale())}>
                    {whenRead(d.createdAt)}
                  </time>
                  <span>{d.against ? t('page.articles.againstVersion', { diffWords: diffWords(d.diff), against: d.against }) : t('page.articles.theFirstVersion')}</span>
                </p>
                {d.titleBefore !== null && d.titleBefore !== d.title ? (
                  <ul className="change-lines">
                    <li>
                      <span className="change-field">{t('page.articles.title2')}</span> <del>{d.titleBefore}</del> → <ins>{d.title}</ins>
                    </li>
                  </ul>
                ) : null}
                <Diff lines={d.diff} label={d.against ? t('page.articles.versionAgainstVersion', { version: d.version, against: d.against }) : t('page.articles.version', { version: d.version })} />
              </>
            ) : detail.isLoading ? (
              <Loading what="loadingLine.version" />
            ) : null}
            <Said text={said} tone={said ? 'bad' : undefined} />
            <p className="note">
              <Link to={`/articles/${a.id}`}>{tr('page.articles.backTo', { title: a.title })}</Link>
            </p>
          </section>
        </div>
      </div>
    </>
  );
}

