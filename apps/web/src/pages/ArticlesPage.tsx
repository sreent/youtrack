import type { Article, ArticleDetail } from '@a4a/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Fragment, useEffect, useId, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import { ApiError, del, patch, post } from '../api/client';
import { useProject, useProjects } from '../api/queries';
import { Badge } from '../components/Badges';
import { Markdown } from '../components/Markdown';
import { Empty, ErrorLine, ErrorNote, Loading, PageHead } from '../components/States';
import { actorWho, Who } from '../components/Who';
import { articleKeys, subtreeOf, useArticle, useArticleSearch, useArticleTree, useArticleVersion, useArticleVersions } from '../features/articles/api';
import { ArticleTree } from '../features/articles/ArticleTree';
import { Diff, diffWords } from '../features/articles/Diff';
import { attachmentKeys, useArticleAttachments, useAttachmentLimits } from '../features/attachments/api';
import { AttachmentList } from '../features/attachments/AttachmentList';
import { FormField, Said } from '../features/common/bits';
import { Confirm } from '../features/common/Confirm';
import { whenRead } from '../features/common/format';
import { errorText, useStateTones } from '../features/issues/api';

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
      <Link to="/articles">Knowledge base</Link> / <Link to={`/articles?project=${project}`}>{name}</Link>
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
      <PageHead title={id} crumbs={<Link to="/articles">Knowledge base</Link>} />
      {error instanceof ApiError && error.status === 404 ? (
        <section className="card stack tight">
          <p>There's no article {id}, or you can't see it.</p>
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
      title="Knowledge base"
      about="What the team knows, written down: each project's articles, in a tree. Write an article's id anywhere, such as BACK-A-3, and it links both ways."
      actions={
        canWrite && project ? (
          <Link className="button primary" to={`/articles/new?project=${project.key}`}>
            New article
          </Link>
        ) : null
      }
    />
  );
  if (projects.isLoading || projects.error) {
    return (
      <>
        {head}
        {projects.error ? <ErrorNote error={projects.error} /> : <Loading what="projects" />}
      </>
    );
  }
  if (!project) {
    return (
      <>
        {head}
        <Empty title="No projects yet">Articles belong to a project, as its issues do. Make a project first, under Projects.</Empty>
      </>
    );
  }
  return (
    <div className="stack">
      {head}
      <form role="search" className="cluster" onSubmit={(e) => e.preventDefault()}>
        <div className="form-field inline">
          <label htmlFor={projectId}>Project</label>
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
          <label htmlFor={searchId}>Find</label>
          <input id={searchId} className="grow" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Words in titles and articles" />
        </div>
      </form>
      <Beside project={project.key} name={project.name}>
        <section className="card stack" aria-labelledby="kb-found" aria-busy={found.isFetching}>
          <h2 id="kb-found">
            {words ? `${found.data?.total ?? 0} ${found.data?.total === 1 ? 'article' : 'articles'} for “${words}”` : `Latest changed in ${project.name}`}
          </h2>
          {found.error ? <ErrorNote error={found.error} /> : null}
          {found.data && !found.data.items.length ? (
            <p className="note">{words ? 'Nothing matches. Try fewer words, or the start of one.' : 'No articles yet. Write the first with New article.'}</p>
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
      <h2 id="mentioned-title">Mentioned in</h2>
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
        <p className="note">No issue or article mentions {a.id} yet. Write its id in one, and it shows here.</p>
      )}
    </section>
  );
}

function ArticleFiles({ a, canWrite }: { a: ArticleDetail; canWrite: boolean }) {
  const qc = useQueryClient();
  const files = useArticleAttachments(a.id);
  const limits = useAttachmentLimits();
  if (files.isLoading) return <Loading what="files" />;
  if (files.error) return <ErrorNote error={files.error} />;
  return (
    <AttachmentList
      label="Files"
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
      setSaid({ text: next.parent ? `${a.id} sits under ${next.parent} now, in place ${next.position + 1}.` : `${a.id} sits at the top of the tree now, in place ${next.position + 1}.` });
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
      navigate(a.parent ? `/articles/${a.parent}` : `/articles?project=${a.project.key}`, { state: { said: `${a.id} ${a.title} is gone.` } });
    } catch (e) {
      setSaid({ text: errorText(e), bad: true });
    }
  };

  return (
    <section className="card stack" aria-labelledby="move-title">
      <h2 id="move-title">Move or delete</h2>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          if (changes) void move();
        }}
      >
        <div className="form-fields">
          <div className="form-field">
            <label htmlFor={parentId}>Put it under</label>
            <select
              id={parentId}
              value={parent}
              onChange={(e) => {
                setParent(e.target.value);
                setPlace(e.target.value === (a.parent ?? '') ? 'stay' : 'last');
              }}
            >
              <option value="">The top of the tree</option>
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
            <label htmlFor={placeId}>Its place</label>
            <select id={placeId} value={place} onChange={(e) => setPlace(e.target.value)}>
              {same ? <option value="stay">Where it is now</option> : null}
              <option value="first">First</option>
              {siblings.map((s) => (
                <option key={s.id} value={`after:${s.id}`}>
                  After {s.title}
                </option>
              ))}
              <option value="last">Last</option>
            </select>
          </div>
        </div>
        <div className="cluster spread">
          <Confirm
            label="Delete it"
            title={`Delete ${a.id} ${a.title}?`}
            about={`Its ${a.version === 1 ? 'version' : `${a.version} versions`} and its files go with it, and nobody can bring them back.${a.childCount ? ' Move or delete the articles under it first.' : ''}`}
            confirm="Delete it"
            onConfirm={() => void remove()}
          />
          <button type="submit" disabled={!changes || busy}>
            {busy ? 'Moving…' : 'Move it'}
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
  const article = useArticle(id);
  const canWrite = useCanWrite(article.data?.project.key);
  const said = (location.state as { said?: string } | null)?.said;
  if (article.isLoading) return <Loading what={id} />;
  if (article.error || !article.data) return <NotHere id={id} error={article.error} />;
  const a = article.data;
  const by = a.updatedBy?.name ?? 'someone';
  return (
    <>
      <PageHead
        crumbs={<Crumbs project={a.project.key} name={a.project.name} path={a.path} />}
        title={a.title}
        badges={<span className="issue-id">{a.id}</span>}
        meta={
          <>
            <span>
              {a.version === 1 ? 'Written' : 'Changed'} by {by}{' '}
              <time dateTime={a.updatedAt} title={new Date(a.updatedAt).toLocaleString()}>
                {whenRead(a.updatedAt)}
              </time>
            </span>
            <span>Version {a.version}</span>
          </>
        }
        actions={
          <>
            <Link className="button" to={`/articles/${a.id}/history`}>
              History
            </Link>
            {canWrite ? (
              <>
                <Link className="button" to={`/articles/new?project=${a.project.key}&parent=${a.id}`}>
                  New article under it
                </Link>
                <Link className="button primary" to={`/articles/${a.id}/edit`}>
                  Edit
                </Link>
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
              <Markdown text={a.body} className="article-body" headingsFrom={2} />
            ) : (
              <p className="article-empty">
                Nothing written yet.{' '}
                {canWrite ? <Link to={`/articles/${a.id}/edit`}>Write it</Link> : null}
              </p>
            )}
          </article>
          {a.children.length ? (
            <section className="card stack" aria-labelledby="under-title">
              <h2 id="under-title">Under it</h2>
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
          <MentionedIn a={a} />
          <ArticleFiles key={`files-${a.id}`} a={a} canWrite={canWrite} />
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

  if (mode === 'edit' && existing.isLoading) return <Loading what={id} />;
  if (mode === 'edit' && (existing.error || !existing.data)) return <NotHere id={id ?? ''} error={existing.error} />;
  const projectRow = projects.data?.find((p) => p.key.toUpperCase() === project.toUpperCase());
  const name = existing.data?.project.name ?? projectRow?.name ?? project;
  const back = mode === 'edit' ? `/articles/${id}` : parent ? `/articles/${parent}` : `/articles?project=${project}`;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      if (mode === 'new') {
        const made = await post<ArticleDetail>('/articles', { project, title, body, ...(parent ? { parent } : {}) });
        await qc.invalidateQueries({ queryKey: articleKeys.all });
        navigate(`/articles/${made.id}`, { state: { said: `${made.id} is written.` } });
      } else {
        const next = await patch<ArticleDetail>(`/articles/${id}`, { title, body, expectedVersion: loadedVersion ?? undefined });
        qc.setQueryData(articleKeys.one(next.id), next);
        await qc.invalidateQueries({ queryKey: articleKeys.all });
        navigate(`/articles/${next.id}`, { state: { said: next.version === loadedVersion ? 'Nothing changed, so there is no new version.' : `Saved as version ${next.version}.` } });
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        const current = (e.details as { currentVersion?: number } | undefined)?.currentVersion ?? null;
        setStale(current);
        setError(`Someone saved version ${current ?? 'a newer version'} of ${id} while you were writing. What you wrote is still here: copy what you need, reload it, and make your change again.`);
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
        title={mode === 'new' ? 'New article' : `Editing ${existing.data!.title}`}
        badges={mode === 'edit' ? <span className="issue-id">{id}</span> : null}
        about={mode === 'edit' ? `Saving makes version ${(loadedVersion ?? 0) + 1}; every earlier one stays in its history.` : `In ${name}'s knowledge base. Markdown works here; write an issue's or an article's id, such as BACK-12 or BACK-A-3, to link it.`}
      />
      <form
        className="card article-editor"
        data-show={show}
        aria-label={mode === 'new' ? 'A new article' : `Editing ${id}`}
        onSubmit={(e) => {
          e.preventDefault();
          if (title.trim()) void save();
        }}
      >
        <div className="form-fields">
          <div className="form-field">
            <label htmlFor={titleId}>Title</label>
            <input id={titleId} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={250} required autoFocus={mode === 'new'} />
          </div>
          {mode === 'new' ? (
            <div className="form-field">
              <label htmlFor={parentId}>Where it goes</label>
              <select id={parentId} value={parent} onChange={(e) => setParent(e.target.value)}>
                <option value="">The top of the tree</option>
                {flat.map((x) => (
                  <option key={x.id} value={x.id}>
                    Under {x.title} ({x.id})
                  </option>
                ))}
              </select>
            </div>
          ) : null}
        </div>
        <div className="modes" role="group" aria-label="Show">
          <button type="button" aria-pressed={show === 'write'} onClick={() => setShow('write')}>
            Write
          </button>
          <button type="button" aria-pressed={show === 'read'} onClick={() => setShow('read')}>
            Preview
          </button>
        </div>
        <div className="article-editor-panes">
          <div className="form-field article-editor-write">
            <label htmlFor={bodyId}>Markdown</label>
            <textarea id={bodyId} value={body} onChange={(e) => setBody(e.target.value)} maxLength={200_000} spellCheck />
          </div>
          <div className="article-preview" role="region" aria-label="How it will read">
            {body.trim() ? <Markdown text={body} className="article-body" headingsFrom={2} /> : <p className="article-empty">How it reads shows here as you write.</p>}
          </div>
        </div>
        {error ? <ErrorLine>{error}</ErrorLine> : null}
        <div className="cluster end">
          {stale !== null ? (
            <Confirm
              label="Reload it"
              title={`Reload ${id}?`}
              about={`Version ${stale} takes the place of what you wrote here, which goes for good. Copy anything you want to keep first.`}
              confirm="Reload it"
              onConfirm={() => void reload()}
            />
          ) : null}
          <Link className="button" to={back}>
            Cancel
          </Link>
          <button type="submit" className="primary" disabled={busy || !title.trim()}>
            {busy ? 'Saving…' : mode === 'new' ? 'Save it' : `Save version ${(loadedVersion ?? 0) + 1}`}
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

  if (article.isLoading || versions.isLoading) return <Loading what="its history" />;
  if (article.error || !article.data) return <NotHere id={id} error={article.error} />;
  const a = article.data;
  const restore = async (version: number) => {
    setSaid(null);
    try {
      const next = await post<ArticleDetail>(`/articles/${a.id}/versions/${version}/restore`, { expectedVersion: a.version });
      await qc.invalidateQueries({ queryKey: articleKeys.all });
      navigate(`/articles/${a.id}`, { state: { said: `Version ${version} is back, as version ${next.version}.` } });
    } catch (e) {
      setSaid(e instanceof ApiError && e.status === 409 ? `Someone saved a newer version just now. Look at it first, then bring this one back if you still want it.` : errorText(e));
      await qc.invalidateQueries({ queryKey: articleKeys.one(a.id) });
    }
  };
  const d = detail.data;
  const who = d ? actorWho({ id: d.author?.id ?? null, login: d.author?.login ?? null, name: d.author?.name ?? null, channel: d.channel, token: d.token, isBot: d.author?.isBot ?? false }) : null;
  return (
    <>
      <PageHead
        crumbs={<Crumbs project={a.project.key} name={a.project.name} path={[...a.path, { id: a.id, title: a.title }]} />}
        title={`History of ${a.title}`}
        badges={<span className="issue-id">{a.id}</span>}
        about="Every saved version, newest first. Each opens against the one before it."
      />
      <div className="stack">
        {versions.error ? <ErrorNote error={versions.error} /> : null}
        <div className="tw:grid tw:grid-cols-[17rem_minmax(0,1fr)] tw:items-start tw:gap-4 tw:max-[900px]:grid-cols-1">
          <nav className="card side-card nav-card" aria-label={`Versions of ${a.title}`}>
            <h2>{versions.data?.length === 1 ? '1 version' : `${versions.data?.length ?? 0} versions`}</h2>
            <ul className="nav-list scrolls">
              {(versions.data ?? []).map((v) => {
                const by = actorWho({ id: v.author?.id ?? null, login: v.author?.login ?? null, name: v.author?.name ?? null, channel: v.channel, token: v.token, isBot: v.author?.isBot ?? false });
                return (
                  <li key={v.version}>
                    <Link to={`/articles/${a.id}/history?v=${v.version}`} aria-current={v.version === chosen ? 'page' : undefined}>
                      <span className="nav-list-name">Version {v.version}</span>
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
              <h2 id="version-title">{chosen ? `Version ${chosen}` : 'No versions'}</h2>
              {canWrite && chosen && chosen !== latest ? (
                <button type="button" className="small" onClick={() => void restore(chosen)}>
                  Bring it back
                </button>
              ) : null}
            </div>
            {detail.error ? <ErrorNote error={detail.error} /> : null}
            {d && who ? (
              <>
                <p className="article-meta">
                  <Who kind={who.kind} name={who.name} about={who.about || undefined} small />
                  <time dateTime={d.createdAt} title={new Date(d.createdAt).toLocaleString()}>
                    {whenRead(d.createdAt)}
                  </time>
                  <span>{d.against ? `${diffWords(d.diff)} against version ${d.against}` : 'The first version'}</span>
                </p>
                {d.titleBefore !== null && d.titleBefore !== d.title ? (
                  <ul className="change-lines">
                    <li>
                      <span className="change-field">Title:</span> <del>{d.titleBefore}</del> → <ins>{d.title}</ins>
                    </li>
                  </ul>
                ) : null}
                <Diff lines={d.diff} label={d.against ? `Version ${d.version} against version ${d.against}` : `Version ${d.version}`} />
              </>
            ) : detail.isLoading ? (
              <Loading what="the version" />
            ) : null}
            <Said text={said} tone={said ? 'bad' : undefined} />
            <p className="note">
              <Link to={`/articles/${a.id}`}>Back to {a.title}</Link>
            </p>
          </section>
        </div>
      </div>
    </>
  );
}

