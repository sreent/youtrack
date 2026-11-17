import type { Article, ArticleDetail, ArticleRef, ArticleSearchResult, ArticleVersion, ArticleVersionDetail } from '@a4a/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { get, qs } from '../../api/client';

/** Everything about articles sits under "articles", so a live event about one refreshes them all. */
export const articleKeys = {
  all: ['articles'] as const,
  tree: (project: string) => ['articles', 'tree', project] as const,
  one: (id: string) => ['articles', 'one', id] as const,
  versions: (id: string) => ['articles', 'one', id, 'versions'] as const,
  version: (id: string, v: number) => ['articles', 'one', id, 'versions', v] as const,
  search: (project: string, query: string) => ['articles', 'search', project, query] as const,
  ofIssue: (id: string) => ['issues', 'one', id, 'articles'] as const,
};

export const useArticleTree = (project: string | undefined) =>
  useQuery({ queryKey: articleKeys.tree(project ?? ''), queryFn: () => get<Article[]>(`/projects/${project}/articles`), enabled: Boolean(project) });
export const useArticle = (id: string | undefined) =>
  useQuery({ queryKey: articleKeys.one(id ?? ''), queryFn: () => get<ArticleDetail>(`/articles/${id}`), enabled: Boolean(id), retry: false });
export const useArticleVersions = (id: string) => useQuery({ queryKey: articleKeys.versions(id), queryFn: () => get<ArticleVersion[]>(`/articles/${id}/versions`) });
export const useArticleVersion = (id: string, version: number | undefined) =>
  useQuery({
    queryKey: articleKeys.version(id, version ?? 0),
    queryFn: () => get<ArticleVersionDetail>(`/articles/${id}/versions/${version}`),
    enabled: Boolean(version),
  });
export const useArticleSearch = (project: string | undefined, query: string) =>
  useQuery({
    queryKey: articleKeys.search(project ?? '', query),
    queryFn: () => get<ArticleSearchResult>(`/articles${qs({ project, query, limit: 30 })}`),
    placeholderData: keepPreviousData,
  });
export const useIssueArticles = (issueId: string) => useQuery({ queryKey: articleKeys.ofIssue(issueId), queryFn: () => get<ArticleRef[]>(`/issues/${issueId}/articles`) });

export interface TreeNode {
  article: Article;
  children: TreeNode[];
}

/** The flat tree the API gives, in reading order, as nested nodes. */
export function nest(flat: Article[]): TreeNode[] {
  const byId = new Map<string, TreeNode>(flat.map((a) => [a.id, { article: a, children: [] }]));
  const roots: TreeNode[] = [];
  for (const a of flat) {
    const node = byId.get(a.id)!;
    const parent = a.parent ? byId.get(a.parent) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

/** The ids of an article and every article under it, which it can't be moved under. */
export function subtreeOf(flat: Article[], id: string): Set<string> {
  const out = new Set([id]);
  for (const a of flat) if (a.parent && out.has(a.parent)) out.add(a.id); // reading order: parents come first
  return out;
}

/** The project's key in a readable id: "BACK" of "BACK-A-3". */
export const projectOf = (id: string) => id.split('-')[0]!.toUpperCase();
