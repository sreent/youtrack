import { articleId, parseArticleId, type ArticleRef } from '@a4a/shared';
import { and, eq, inArray } from 'drizzle-orm';
import type { Ctx } from '../context';
import type { Db } from '../db/client';
import { articles } from '../db/schema';
import { notFound } from '../lib/errors';
import { assertCanReadProject, projectAccess, seesArticleRow } from './access';
import { parseReadableId } from './issue-refs';
import { projectByKey, type SchemaSnapshot } from './schema-cache';

export type ArticleRow = typeof articles.$inferSelect;

/** "BACK-A-3". */
export function articleReadableId(s: SchemaSnapshot, row: Pick<ArticleRow, 'projectId' | 'number'>): string {
  return articleId(s.projects.get(row.projectId)?.key ?? '?', row.number);
}

export function articleRef(s: SchemaSnapshot, row: Pick<ArticleRow, 'projectId' | 'number' | 'title'>): ArticleRef {
  return { id: articleReadableId(s, row), title: row.title, project: s.projects.get(row.projectId)?.key ?? '?' };
}

/** By readable id (BACK-A-3, in any case) or internal id. */
export async function findArticle(db: Db, s: SchemaSnapshot, id: string): Promise<ArticleRow | undefined> {
  const parsed = parseArticleId(id);
  if (parsed) {
    const project = projectByKey(s, parsed.key);
    if (!project) return undefined;
    const [row] = await db
      .select()
      .from(articles)
      .where(and(eq(articles.projectId, project.id), eq(articles.number, parsed.number)));
    return row;
  }
  const [row] = await db.select().from(articles).where(eq(articles.id, id.trim()));
  return row;
}

/**
 * The article, if the actor may read its project and it isn't limited away from them, nor is any
 * article above it (D51); a hidden one looks like a missing one.
 */
export async function resolveArticle(ctx: Ctx, id: string, db: Db = ctx.db): Promise<ArticleRow> {
  const s = await ctx.app.schema.get(db);
  const row = await findArticle(db, s, id);
  const hint = parseReadableId(id) ? `${id.trim()} is an issue's id; an article's has an A in it, like BACK-A-3.` : 'Use a readable id such as BACK-A-3.';
  const missing = () => notFound(`Article ${id}`, hint).said('articles.articleNotFound', { id, idTrim: id.trim(), issueId: parseReadableId(id) ? 'yes' : 'no' });
  if (!row) throw missing();
  // One the caller can't see answers in the very words of one that doesn't exist.
  await assertCanReadProject(ctx, row.projectId, db).catch(() => {
    throw missing();
  });
  if (!(await seesArticleRow(await projectAccess(ctx, db), db, row))) throw missing();
  return row;
}

export async function articleRefsById(db: Db, s: SchemaSnapshot, ids: string[]): Promise<Map<string, ArticleRef>> {
  const out = new Map<string, ArticleRef>();
  const unique = [...new Set(ids)];
  if (!unique.length) return out;
  const rows = await db
    .select({ id: articles.id, projectId: articles.projectId, number: articles.number, title: articles.title })
    .from(articles)
    .where(inArray(articles.id, unique));
  for (const r of rows) out.set(r.id, articleRef(s, r));
  return out;
}
