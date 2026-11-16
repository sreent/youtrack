/**
 * The knowledge base: articles in a tree per project, with every saved version kept.
 *
 * - An article belongs to a project, and the project's access is the article's.
 * - Its id is BACK-A-3: numbered per project, gap-free and never reused, so links stay good.
 * - Changes to a project's tree serialise on its counter row, so concurrent moves can't make
 *   a cycle, and siblings keep a dense order.
 * - Saving content writes a version, the article's mentions and its activity in one transaction.
 */
import type {
  Article,
  ArticleDetail,
  ArticleSearchResult,
  ArticleVersion,
  ArticleVersionDetail,
  Change,
  CreateArticleInput,
  UpdateArticleInput,
} from '@a4a/shared';
import { and, asc, count, desc, eq, inArray, isNull, ne, sql, type SQL } from 'drizzle-orm';
import { requireScope, type Ctx } from '../context';
import type { Db } from '../db/client';
import { articleCounters, articles, articleVersions, attachments } from '../db/schema';
import { publishActivities, recordActivity, type ActivityRow } from '../events/activity';
import { diffLines, diffStats } from '../lib/diff';
import { badRequest, conflict, notFound } from '../lib/errors';
import { newId } from '../lib/ids';
import { excerpt } from '../lib/text';
import { prefixTsQuery } from '../search/compiler';
import { assertCanReadProject, assertCanWriteProject, requireProject, visibleProjectIds } from './access';
import { articleReadableId, articleRef, findArticle, resolveArticle, type ArticleRow } from './article-refs';
import { readableId } from './issue-refs';
import { resolveIssue } from './issues';
import { indexMentions, mentionsOf } from './mentions';
import { projectByKey, type ProjectRow, type SchemaSnapshot } from './schema-cache';
import { userRefDto } from './values';

export { findArticle, resolveArticle };

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

async function childCounts(db: Db, ids: string[]): Promise<Map<string, number>> {
  if (!ids.length) return new Map();
  const rows = await db
    .select({ parentId: articles.parentId, n: count() })
    .from(articles)
    .where(inArray(articles.parentId, ids))
    .groupBy(articles.parentId);
  return new Map(rows.map((r) => [r.parentId!, Number(r.n)]));
}

function articleDto(s: SchemaSnapshot, row: ArticleRow, parents: Map<string, ArticleRow | { projectId: string; number: number }>, children: number): Article {
  const project = s.projects.get(row.projectId)!;
  const parent = row.parentId ? parents.get(row.parentId) : undefined;
  const by = (id: string | null) => {
    const u = id ? s.users.get(id) : undefined;
    return u ? userRefDto(u) : null;
  };
  return {
    id: articleReadableId(s, row),
    uid: row.id,
    number: row.number,
    project: { id: project.id, key: project.key, name: project.name },
    title: row.title,
    parent: parent ? articleReadableId(s, parent) : null,
    position: row.position,
    childCount: children,
    version: row.version,
    createdBy: by(row.createdById),
    updatedBy: by(row.updatedById),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function articleDtos(ctx: Ctx, rows: ArticleRow[], known: ArticleRow[] = rows): Promise<Article[]> {
  const s = await ctx.app.schema.get();
  const byId = new Map<string, ArticleRow | { projectId: string; number: number }>(known.map((r) => [r.id, r]));
  const missing = [...new Set(rows.map((r) => r.parentId).filter((p): p is string => Boolean(p) && !byId.has(p!)))];
  if (missing.length) {
    const parents = await ctx.db.select({ id: articles.id, projectId: articles.projectId, number: articles.number }).from(articles).where(inArray(articles.id, missing));
    for (const p of parents) byId.set(p.id, p);
  }
  const counts = await childCounts(ctx.db, rows.map((r) => r.id));
  return rows.map((r) => articleDto(s, r, byId, counts.get(r.id) ?? 0));
}

/** The articles a row sits under, from the top. */
async function ancestors(db: Db, row: ArticleRow): Promise<ArticleRow[]> {
  if (!row.parentId) return [];
  const res = await db.execute(sql`
    WITH RECURSIVE up AS (
      SELECT a.*, 0 AS depth FROM articles a WHERE a.id = ${row.parentId}
      UNION ALL
      SELECT a.*, up.depth + 1 FROM articles a JOIN up ON a.id = up.parent_id WHERE up.depth < 200
    )
    SELECT id FROM up ORDER BY depth DESC
  `);
  const ids = (res as unknown as { rows: { id: string }[] }).rows.map((r) => r.id);
  if (!ids.length) return [];
  const rows = await db.select().from(articles).where(inArray(articles.id, ids));
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id)!).filter(Boolean);
}

export async function articleDetail(ctx: Ctx, row: ArticleRow): Promise<ArticleDetail> {
  const s = await ctx.app.schema.get();
  const [path, children, files] = await Promise.all([
    ancestors(ctx.db, row),
    ctx.db.select().from(articles).where(eq(articles.parentId, row.id)).orderBy(asc(articles.position), asc(articles.number)),
    ctx.db.select({ n: count() }).from(attachments).where(eq(attachments.articleId, row.id)),
  ]);
  const [base] = await articleDtos(ctx, [row], [row, ...path]);
  const rid = articleReadableId(s, row);
  return {
    ...base!,
    body: row.body,
    path: path.map((p) => articleRef(s, p)),
    children: children.map((c) => articleRef(s, c)),
    mentionedIn: await mentionsOf(ctx, rid, { exceptArticle: row.id }),
    attachmentCount: Number(files[0]?.n ?? 0),
  };
}

export async function getArticle(ctx: Ctx, id: string): Promise<ArticleDetail> {
  requireScope(ctx, 'read');
  return articleDetail(ctx, await resolveArticle(ctx, id));
}

/** A project's whole tree, flat, in reading order: each article, then what's under it. */
export async function articleTree(ctx: Ctx, projectKey: string): Promise<Article[]> {
  requireScope(ctx, 'read');
  const s = await ctx.app.schema.get();
  // A project the caller can't see is missing, in the same words, and no hint names others.
  const project = await requireProject(ctx, projectKey, 'read');
  const rows = await ctx.db.select().from(articles).where(eq(articles.projectId, project.id)).orderBy(asc(articles.position), asc(articles.number));
  const under = new Map<string | null, ArticleRow[]>();
  for (const r of rows) under.set(r.parentId, [...(under.get(r.parentId) ?? []), r]);
  const ordered: ArticleRow[] = [];
  const seen = new Set<string>();
  const walk = (parent: string | null) => {
    for (const r of under.get(parent) ?? []) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      ordered.push(r);
      walk(r.id);
    }
  };
  walk(null);
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ordered.map((r) => articleDto(s, r, byId, (under.get(r.id) ?? []).length));
}

// ---------------------------------------------------------------------------
// The tree: numbering, order and moves
// ---------------------------------------------------------------------------

/** The next number in the project, taking its tree's lock for the rest of the transaction. */
async function nextNumber(tx: Db, projectId: string): Promise<number> {
  const [row] = await tx
    .insert(articleCounters)
    .values({ projectId, nextNumber: 2 })
    .onConflictDoUpdate({ target: articleCounters.projectId, set: { nextNumber: sql`${articleCounters.nextNumber} + 1` } })
    .returning({ number: sql<number>`${articleCounters.nextNumber} - 1` });
  return Number(row!.number);
}

/** Hold the project's tree until the transaction ends. */
async function lockTree(tx: Db, projectId: string): Promise<void> {
  await tx
    .insert(articleCounters)
    .values({ projectId })
    .onConflictDoUpdate({ target: articleCounters.projectId, set: { nextNumber: sql`${articleCounters.nextNumber}` } });
}

const parentIs = (parentId: string | null): SQL => (parentId ? eq(articles.parentId, parentId) : isNull(articles.parentId));

/**
 * Put `articleId` at `index` among the articles under `parentId` (last when undefined), and
 * number them all 0, 1, 2… Returns the place it got.
 */
async function place(tx: Db, projectId: string, parentId: string | null, articleId: string, index: number | undefined): Promise<number> {
  const siblings = await tx
    .select({ id: articles.id, position: articles.position })
    .from(articles)
    .where(and(eq(articles.projectId, projectId), parentIs(parentId), ne(articles.id, articleId)))
    .orderBy(asc(articles.position), asc(articles.number));
  const at = Math.min(Math.max(index ?? siblings.length, 0), siblings.length);
  const order = siblings.map((x) => x.id);
  order.splice(at, 0, articleId);
  const current = new Map(siblings.map((x) => [x.id, x.position]));
  for (let i = 0; i < order.length; i++) {
    const id = order[i]!;
    if (current.get(id) !== i) await tx.update(articles).set({ position: i }).where(eq(articles.id, id));
  }
  return at;
}

/** Number the articles under `parentId` 0, 1, 2… again, after one left. */
async function closeUp(tx: Db, projectId: string, parentId: string | null): Promise<void> {
  const siblings = await tx
    .select({ id: articles.id, position: articles.position })
    .from(articles)
    .where(and(eq(articles.projectId, projectId), parentIs(parentId)))
    .orderBy(asc(articles.position), asc(articles.number));
  for (let i = 0; i < siblings.length; i++) {
    if (siblings[i]!.position !== i) await tx.update(articles).set({ position: i }).where(eq(articles.id, siblings[i]!.id));
  }
}

/** Whether `candidate` sits somewhere under `ancestor`. */
async function isUnder(tx: Db, candidate: string, ancestor: string): Promise<boolean> {
  const res = await tx.execute(sql`
    WITH RECURSIVE up AS (
      SELECT id, parent_id, 0 AS depth FROM articles WHERE id = ${candidate}
      UNION ALL
      SELECT a.id, a.parent_id, up.depth + 1 FROM articles a JOIN up ON a.id = up.parent_id WHERE up.depth < 200
    )
    SELECT 1 AS found FROM up WHERE id = ${ancestor} LIMIT 1
  `);
  return (res as unknown as { rows: unknown[] }).rows.length > 0;
}

async function parentInProject(tx: Db, s: SchemaSnapshot, project: ProjectRow, parent: string): Promise<ArticleRow> {
  const row = await findArticle(tx, s, parent);
  if (!row || row.projectId !== project.id) {
    throw badRequest(`${parent} is not an article in ${project.key}`, `An article sits under another article of its own project, such as ${project.key}-A-1.`);
  }
  return row;
}

// ---------------------------------------------------------------------------
// Create, update, delete
// ---------------------------------------------------------------------------

function cleanTitle(title: string): string {
  const t = title.replace(/\s+/g, ' ').trim();
  if (!t) throw badRequest('An article needs a title');
  return t;
}

function versionRow(ctx: Ctx, articleId: string, version: number, title: string, body: string) {
  return { articleId, version, title, body, authorId: ctx.actor.user.id, channel: ctx.actor.channel, tokenName: ctx.actor.tokenName };
}

export async function createArticle(ctx: Ctx, input: CreateArticleInput): Promise<ArticleDetail> {
  requireScope(ctx, 'write');
  const s = await ctx.app.schema.get();
  const project = await requireProject(ctx, input.project, 'write');
  if (project.archived) throw badRequest(`Project ${project.key} is archived`);
  const title = cleanTitle(input.title);
  const body = input.body ?? '';
  const { row, activity } = await ctx.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const number = await nextNumber(tx, project.id);
    const parent = input.parent ? await parentInProject(tx, s, project, input.parent) : null;
    const id = newId();
    await tx.insert(articles).values({
      id,
      projectId: project.id,
      number,
      parentId: parent?.id ?? null,
      position: 0,
      title,
      body,
      createdById: ctx.actor.user.id,
      updatedById: ctx.actor.user.id,
    });
    await place(tx, project.id, parent?.id ?? null, id, input.position);
    const [row] = await tx.select().from(articles).where(eq(articles.id, id));
    await tx.insert(articleVersions).values(versionRow(ctx, id, 1, title, body));
    const rid = articleReadableId(s, row!);
    await indexMentions(tx, s, { type: 'article', id, projectId: project.id }, `${title}\n${body}`, rid);
    const activity = await recordActivity(tx, ctx, {
      type: 'article.created',
      projectId: project.id,
      issueId: null,
      payload: { data: { article: { ...articleRef(s, row!), url: articleUrl(ctx, rid) }, parent: parent ? articleRef(s, parent) : null, version: 1, chars: body.length } },
    });
    return { row: row!, activity };
  });
  await publishActivities(ctx.app, [activity]);
  return articleDetail(ctx, row);
}

export function articleUrl(ctx: Ctx, readable: string): string {
  return `${ctx.app.config.publicUrl}/articles/${readable}`;
}

/**
 * Change an article's title or body (a new version), or move it (parent, place). Only what's
 * sent changes. With expectedVersion, a newer save by someone else fails with 409.
 */
export async function updateArticle(ctx: Ctx, id: string, input: UpdateArticleInput): Promise<ArticleDetail> {
  requireScope(ctx, 'write');
  const s = await ctx.app.schema.get();
  const found = await resolveArticle(ctx, id);
  await assertCanWriteProject(ctx, found.projectId);
  const project = s.projects.get(found.projectId)!;
  const moving = input.parent !== undefined || input.position !== undefined;
  const result = await ctx.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    // The tree's lock first, then the row: every path that takes both takes them in this order.
    if (moving) await lockTree(tx, found.projectId);
    const [row] = await tx.select().from(articles).where(eq(articles.id, found.id)).for('update');
    if (!row) throw notFound(`Article ${id}`, 'It was deleted just now.');
    const rid = articleReadableId(s, row);
    if (input.expectedVersion !== undefined && input.expectedVersion !== row.version) {
      throw conflict(`${rid} was saved by someone else (version ${row.version}, you sent ${input.expectedVersion})`, 'Reload the article, then make your change again.', {
        currentVersion: row.version,
      });
    }
    const changes: Change[] = [];
    const title = input.title !== undefined ? cleanTitle(input.title) : row.title;
    const body = input.body ?? row.body;
    if (title !== row.title) changes.push({ field: 'Title', from: row.title, to: title });
    if (body !== row.body) changes.push({ field: 'Content', from: null, to: diffStats(diffLines(row.body, body)).words });

    let parentId = row.parentId;
    let moved = false;
    if (moving) {
      if (input.parent === null) parentId = null;
      else if (input.parent !== undefined) {
        const parent = await parentInProject(tx, s, project, input.parent);
        if (parent.id === row.id) throw badRequest(`${rid} can't sit under itself`);
        if (await isUnder(tx, parent.id, row.id)) {
          throw badRequest(`${articleReadableId(s, parent)} sits under ${rid}, so ${rid} can't go under it`, `Move ${articleReadableId(s, parent)} out from under ${rid} first, or choose another place.`);
        }
        parentId = parent.id;
      }
      const at = await place(tx, row.projectId, parentId, row.id, input.position ?? (parentId === row.parentId ? row.position : undefined));
      if (parentId !== row.parentId) {
        await tx.update(articles).set({ parentId }).where(eq(articles.id, row.id));
        await closeUp(tx, row.projectId, row.parentId);
        const ids = [row.parentId, parentId].filter((x): x is string => Boolean(x));
        const named = new Map((ids.length ? await tx.select().from(articles).where(inArray(articles.id, ids)) : []).map((a) => [a.id, articleReadableId(s, a)]));
        changes.push({ field: 'Parent', from: row.parentId ? (named.get(row.parentId) ?? null) : null, to: parentId ? (named.get(parentId) ?? null) : null });
        moved = true;
      } else if (at !== row.position) {
        changes.push({ field: 'Position', from: String(row.position + 1), to: String(at + 1) });
        moved = true;
      }
    }

    if (!changes.length) return { row, activity: null as ActivityRow | null };
    const contentChanged = title !== row.title || body !== row.body;
    const version = contentChanged ? row.version + 1 : row.version;
    await tx
      .update(articles)
      .set({ ...(contentChanged ? { title, body, version } : {}), updatedAt: new Date(), updatedById: ctx.actor.user.id })
      .where(eq(articles.id, row.id));
    if (contentChanged) {
      await tx.insert(articleVersions).values(versionRow(ctx, row.id, version, title, body));
      await indexMentions(tx, s, { type: 'article', id: row.id, projectId: row.projectId }, `${title}\n${body}`, rid);
    }
    const [after] = await tx.select().from(articles).where(eq(articles.id, row.id));
    const activity = await recordActivity(tx, ctx, {
      type: 'article.updated',
      projectId: row.projectId,
      issueId: null,
      payload: { changes, data: { article: { ...articleRef(s, after!), url: articleUrl(ctx, rid) }, version, moved } },
    });
    return { row: after!, activity };
  });
  if (result.activity) await publishActivities(ctx.app, [result.activity]);
  return articleDetail(ctx, result.row);
}

/** An article with articles under it stays until they're moved or deleted. */
export async function deleteArticle(ctx: Ctx, id: string): Promise<void> {
  requireScope(ctx, 'write');
  const s = await ctx.app.schema.get();
  const found = await resolveArticle(ctx, id);
  await assertCanWriteProject(ctx, found.projectId);
  const activity = await ctx.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    await lockTree(tx, found.projectId);
    const [row] = await tx.select().from(articles).where(eq(articles.id, found.id)).for('update');
    if (!row) throw notFound(`Article ${id}`, 'It was deleted just now.');
    const rid = articleReadableId(s, row);
    const [{ n } = { n: 0 }] = await tx.select({ n: count() }).from(articles).where(eq(articles.parentId, row.id));
    if (Number(n) > 0) {
      throw conflict(`${rid} has ${Number(n) === 1 ? 'an article' : `${n} articles`} under it`, 'Move them elsewhere, or delete them first.');
    }
    await tx.delete(articles).where(eq(articles.id, row.id));
    await closeUp(tx, row.projectId, row.parentId);
    return recordActivity(tx, ctx, {
      type: 'article.deleted',
      projectId: row.projectId,
      issueId: null,
      payload: { data: { article: articleRef(s, row), version: row.version } },
    });
  });
  await publishActivities(ctx.app, [activity]);
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

export async function listArticleVersions(ctx: Ctx, id: string): Promise<ArticleVersion[]> {
  requireScope(ctx, 'read');
  const s = await ctx.app.schema.get();
  const article = await resolveArticle(ctx, id);
  const rows = await ctx.db
    .select({
      version: articleVersions.version,
      title: articleVersions.title,
      authorId: articleVersions.authorId,
      channel: articleVersions.channel,
      tokenName: articleVersions.tokenName,
      createdAt: articleVersions.createdAt,
      chars: sql<number>`length(${articleVersions.body})`,
    })
    .from(articleVersions)
    .where(eq(articleVersions.articleId, article.id))
    .orderBy(desc(articleVersions.version));
  return rows.map((r) => {
    const u = r.authorId ? s.users.get(r.authorId) : undefined;
    return {
      version: r.version,
      title: r.title,
      author: u ? userRefDto(u) : null,
      channel: r.channel as ArticleVersion['channel'],
      token: r.tokenName,
      createdAt: r.createdAt.toISOString(),
      chars: Number(r.chars),
    };
  });
}

/** One version in full, with its body's lines against the version before it. */
export async function getArticleVersion(ctx: Ctx, id: string, version: number): Promise<ArticleVersionDetail> {
  requireScope(ctx, 'read');
  const s = await ctx.app.schema.get();
  const article = await resolveArticle(ctx, id);
  const rows = await ctx.db
    .select()
    .from(articleVersions)
    .where(and(eq(articleVersions.articleId, article.id), inArray(articleVersions.version, [version, version - 1])));
  const cur = rows.find((r) => r.version === version);
  if (!cur) throw notFound(`Version ${version} of ${articleReadableId(s, article)}`, `It has versions 1 to ${article.version}.`);
  const prev = rows.find((r) => r.version === version - 1) ?? null;
  const u = cur.authorId ? s.users.get(cur.authorId) : undefined;
  return {
    version: cur.version,
    title: cur.title,
    author: u ? userRefDto(u) : null,
    channel: cur.channel as ArticleVersion['channel'],
    token: cur.tokenName,
    createdAt: cur.createdAt.toISOString(),
    chars: cur.body.length,
    body: cur.body,
    against: prev?.version ?? null,
    titleBefore: prev?.title ?? null,
    diff: diffLines(prev?.body ?? '', cur.body),
  };
}

/** Bring an old version back, as a new one: nothing in between is lost. */
export async function restoreArticleVersion(ctx: Ctx, id: string, version: number, expectedVersion?: number): Promise<ArticleDetail> {
  const v = await getArticleVersion(ctx, id, version);
  return updateArticle(ctx, id, { title: v.title, body: v.body, expectedVersion });
}

// ---------------------------------------------------------------------------
// Search, and what mentions an issue
// ---------------------------------------------------------------------------

const MARK_ON = '\u0001';
const MARK_OFF = '\u0002';

/**
 * Markdown as it reads, for a snippet: no heading, quote or list marks at the start of a line,
 * no code ticks or bold marks, and a link as its words.
 */
function asRead(markdown: string): string {
  return markdown
    .split('\n')
    .map((line) =>
      line
        .replace(/^\s*(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/, '')
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/`+/g, '')
        .replace(/(\*\*|__)/g, ''),
    )
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function snippetParts(text: string): { text: string; match: boolean }[] {
  const parts: { text: string; match: boolean }[] = [];
  for (const piece of text.split(MARK_ON)) {
    const [hit, rest] = piece.includes(MARK_OFF) ? piece.split(MARK_OFF, 2) : [null, piece];
    if (hit) parts.push({ text: hit, match: true });
    if (rest) parts.push({ text: rest, match: false });
  }
  return parts.length ? parts : [{ text, match: false }];
}

/**
 * Full-text search over titles (weighted higher) and bodies, with trigram similarity on
 * titles for near misses, as issues have; or, with no words, the latest changed.
 */
export async function searchArticles(ctx: Ctx, opts: { query?: string; project?: string; offset?: number; limit?: number }): Promise<ArticleSearchResult> {
  requireScope(ctx, 'read');
  const s = await ctx.app.schema.get();
  const conds: SQL[] = [];
  if (opts.project) {
    const project = await requireProject(ctx, opts.project, 'read');
    conds.push(sql`a.project_id = ${project.id}`);
  }
  const visible = await visibleProjectIds(ctx);
  if (visible !== null) conds.push(visible.length ? sql`a.project_id IN (${sql.join(visible.map((v) => sql`${v}`), sql`, `)})` : sql`FALSE`);
  const text = (opts.query ?? '').trim().slice(0, 500);
  const tsq = text ? prefixTsQuery(text) : null;
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const offset = Math.max(opts.offset ?? 0, 0);
  if (text) {
    const like = `%${text.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    conds.push(
      tsq
        ? sql`(a.search_vector @@ to_tsquery('english', ${tsq}) OR ${text} <% a.title OR a.title ILIKE ${like})`
        : sql`(${text} <% a.title OR a.title ILIKE ${like})`,
    );
  }
  const where = conds.length ? sql.join(conds, sql` AND `) : sql`TRUE`;
  // Near misses on a title count by its closest words (word_similarity), not the whole title.
  const rank = tsq
    ? sql`ts_rank(a.search_vector, to_tsquery('english', ${tsq})) + word_similarity(${text}, a.title)`
    : text
      ? sql`word_similarity(${text}, a.title)`
      : sql`0`;
  const headline = tsq
    ? sql`ts_headline('english', a.body, to_tsquery('english', ${tsq}), ${`StartSel=${MARK_ON}, StopSel=${MARK_OFF}, MaxWords=28, MinWords=12, ShortWord=2, MaxFragments=1`})`
    : sql`left(a.body, 400)`;
  const res = await ctx.db.execute(sql`
    SELECT a.id, a.project_id, a.number, a.title, a.parent_id, a.updated_at, ${headline} AS snippet, ${rank} AS rank
    FROM articles a
    WHERE ${where}
    ORDER BY ${text ? sql`rank DESC, a.updated_at DESC` : sql`a.updated_at DESC`}
    LIMIT ${limit} OFFSET ${offset}
  `);
  const rows = (res as unknown as { rows: { id: string; project_id: string; number: number; title: string; parent_id: string | null; updated_at: string | Date; snippet: string | null }[] }).rows;
  const counted = await ctx.db.execute(sql`SELECT count(*)::int AS n FROM articles a WHERE ${where}`);
  const total = Number((counted as unknown as { rows: { n: number }[] }).rows[0]?.n ?? 0);

  // The titles above each result, from its project's tree.
  const projects = [...new Set(rows.map((r) => r.project_id))];
  const tree = projects.length
    ? await ctx.db.select({ id: articles.id, parentId: articles.parentId, title: articles.title }).from(articles).where(inArray(articles.projectId, projects))
    : [];
  const byId = new Map(tree.map((t) => [t.id, t]));
  const pathOf = (parentId: string | null): string[] => {
    const out: string[] = [];
    for (let p = parentId ? byId.get(parentId) : undefined, n = 0; p && n < 200; p = p.parentId ? byId.get(p.parentId) : undefined, n++) out.unshift(p.title);
    return out;
  };
  return {
    total,
    items: rows.map((r) => {
      const snippet = asRead(r.snippet ?? '');
      return {
        ...articleRef(s, { projectId: r.project_id, number: Number(r.number), title: r.title }),
        path: pathOf(r.parent_id),
        updatedAt: new Date(r.updated_at).toISOString(),
        snippet: tsq ? snippetParts(snippet) : [{ text: excerpt(snippet, 200), match: false }],
      };
    }),
  };
}

/** Articles that mention an issue by its id. */
export async function articlesMentioningIssue(ctx: Ctx, issueId: string) {
  requireScope(ctx, 'read');
  const s = await ctx.app.schema.get();
  const issue = await resolveIssue(ctx, issueId);
  return (await mentionsOf(ctx, readableId(s, issue))).articles;
}
