import type { Article } from '@a4a/shared';
import { useEffect, useMemo, useState } from 'react';
import { Link, NavLink } from 'react-router';
import { Icon } from '../../components/Icon';
import { ErrorNote, Loading } from '../../components/States';
import { nest, useArticleTree, type TreeNode } from './api';
import { t } from '../../i18n';

/** The ids above an article, from its parent up. */
function above(flat: Article[], id: string | undefined): string[] {
  const byId = new Map(flat.map((a) => [a.id, a]));
  const out: string[] = [];
  for (let a = id ? byId.get(id) : undefined; a?.parent && out.length < 200; a = byId.get(a.parent)) out.push(a.parent);
  return out;
}

/**
 * Ocean's ArticleTree: a project's articles, each a link, those under it indented and folded
 * until opened. The branch of the open article starts opened. It's a list of links and buttons,
 * so the keyboard needs Tab and Enter, nothing more.
 */
export function ArticleTree({ project, name, current, canWrite }: { project: string; name: string; current?: string; canWrite: boolean }) {
  const tree = useArticleTree(project);
  const flat = useMemo(() => tree.data ?? [], [tree.data]);
  const [open, setOpen] = useState<Set<string>>(new Set());
  useEffect(() => {
    // The open article's branch opens; whatever else was opened stays open.
    const up = above(flat, current);
    if (up.length) setOpen((was) => (up.every((id) => was.has(id)) ? was : new Set([...was, ...up])));
  }, [flat, current]);
  const toggle = (id: string) =>
    setOpen((was) => {
      const next = new Set(was);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const render = (node: TreeNode) => {
    const a = node.article;
    const isOpen = open.has(a.id);
    return (
      <li key={a.id}>
        <div className="tree-row">
          {node.children.length ? (
            <button
              type="button"
              className="tree-toggle"
              aria-expanded={isOpen}
              aria-controls={`under-${a.id}`}
              aria-label={t('articles.articleTree.whatSUnder', { v: isOpen ? t('articles.articleTree.hide') : t('articles.articleTree.show'), title: a.title })}
              onClick={() => toggle(a.id)}
            >
              <Icon name="chevron" />
            </button>
          ) : (
            <span aria-hidden="true" />
          )}
          <NavLink to={`/articles/${a.id}`}>
            <span className="nav-list-name">{a.title}</span>
            <span className="nav-list-about">
              <span className="issue-id">{a.id}</span>
            </span>
          </NavLink>
        </div>
        {node.children.length ? (
          <ul id={`under-${a.id}`} hidden={!isOpen}>
            {node.children.map(render)}
          </ul>
        ) : null}
      </li>
    );
  };

  return (
    <nav className="card side-card nav-card" aria-label={t('articles.articleTree.sKnowledgeBase', { name: name })}>
      <div className="cluster spread">
        <h2>{name}</h2>
        {canWrite ? (
          <Link className="button small" to={`/articles/new?project=${project}`}>{t('articles.articleTree.newArticle')}</Link>
        ) : null}
      </div>
      {tree.isLoading ? <Loading what="articles" /> : null}
      {tree.error ? <ErrorNote error={tree.error} /> : null}
      {tree.data && !tree.data.length ? <p className="note">{t('articles.articleTree.noArticlesYet')}</p> : null}
      {flat.length ? <ul className="nav-list tree">{nest(flat).map(render)}</ul> : null}
    </nav>
  );
}
