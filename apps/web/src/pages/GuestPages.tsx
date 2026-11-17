import type { Comment, GuestInfo, IssueDetail, IssueField, IssueList } from '@a4a/shared';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { ApiError, get } from '../api/client';
import { Lone } from '../app/Auth';
import { ago, StateBadge } from '../components/Badges';
import { Markdown } from '../components/Markdown';
import { ErrorNote, Loading } from '../components/States';
import { t, tr } from '../i18n';

/**
 * Pages for guests (D37), who aren't signed in: the projects open to anyone, their issues, and an
 * issue with its comments, to read. Nothing here changes anything; signing in is a link away.
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
  const text = Array.isArray(v) ? v.map(one).filter(Boolean).join(', ') : one(v);
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
  const [page, setPage] = useState(0);
  const issues = useQuery({
    queryKey: ['guest', 'issues', key, page],
    queryFn: () => get<IssueList>(`/issues?query=${encodeURIComponent(`project: ${key} sort by: updated desc`)}&offset=${page * 25}&limit=25`),
    enabled: Boolean(key),
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
      {key ? (
        <section className="stack" aria-labelledby="guest-issues">
          <h2 id="guest-issues">{tr('page.guestPages.itsIssues', { v: projects.find((p) => p.key === key)?.name ?? key })}</h2>
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
                    <span className="note">{tr('page.guestPages.updated', { when: ago(i.updatedAt) })}</span>
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
          <p className="note">{tr('page.guestPages.reported', { id: d.id, name: d.project.name, when: ago(d.createdAt), v: d.reporter ? t('page.guestPages.by', { name: d.reporter.name }) : '' })}</p>
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
  );
}
