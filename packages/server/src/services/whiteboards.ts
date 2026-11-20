/**
 * Whiteboards (docs/architecture.md, D58): a project's canvas of notes, text, issue and article cards,
 * arrows and sections. Who reads the project reads its whiteboards, and who may change its issues
 * changes them, as articles follow their project; to anyone else a whiteboard is missing.
 *
 * - **Changes are batches of operations on elements**, each naming only what it changes, so an edit to
 *   one element never touches another. Each batch takes the whiteboard's row lock and its next `seq`.
 *   Where and how big things are, and their order, go to the last writer, property by property: two
 *   people moving one note end where the later put it, and one moving it while another rewrites it both
 *   land. An operation can carry `expect`, values the element must still have; the page sends one with
 *   words (what they were when the person began typing) and with every undo, so neither overwrites
 *   someone else's change: that element alone is refused, with what it is now, and the rest goes on.
 * - **Element edits aren't events.** They go to the whiteboard's own short log, which its live streams
 *   read (events/whiteboard-live.ts). The event log hears the whiteboard's life: made, renamed, deleted,
 *   and the issues and links made from it.
 * - **Cards are read for whoever looks** (`cardsFor`): through the seam, so an issue or article they may
 *   not see, for any reason, is `shown: false` and nothing else. A card's issue is never in an element.
 */
import {
  WHITEBOARD_LIMITS,
  WhiteboardBatchBody,
  WhiteboardConvertBody,
  noteAsIssue,
  type ItemProblem,
  type Whiteboard,
  type WhiteboardBatchInput,
  type WhiteboardBatchResult,
  type WhiteboardCard,
  type WhiteboardConvertInput,
  type WhiteboardConvertResult,
  type WhiteboardDetail,
  type WhiteboardElement,
  type WhiteboardViewer,
} from '@a4a/shared';
import { and, count, desc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { requireScope, type Ctx } from '../context';
import type { Db } from '../db/client';
import { articles, issues, whiteboardChanges, whiteboardElements, whiteboards, whiteboardViewers } from '../db/schema';
import { publishActivities, recordActivity, type ActivityRow } from '../events/activity';
import { whiteboardLive } from '../events/whiteboard-live';
import { AppError, badRequest, conflict, errorWords, forbidden, notFound, pageWords, unauthorized } from '../lib/errors';
import { newId } from '../lib/ids';
import { assertCanProject, projectAccess, requireProject, seenArticleIds, seenIssueIds, type AccessView } from './access';
import { articleReadableId, resolveArticle } from './article-refs';
import { resolveVisibleTo, visibleToDtos } from './visibility';
import { readableId } from './issue-refs';
import { applyChanges, createIssueInTx, issueDtos, resolveIssue, resolveLinkPhrase } from './issues';
import type { SchemaSnapshot } from './schema-cache';
import { userRefDto } from './values';

type BoardRow = typeof whiteboards.$inferSelect;
type ElementRow = typeof whiteboardElements.$inferSelect;
type Geometry = 'x' | 'y' | 'w' | 'h' | 'z';
type Settable = Geometry | 'text' | 'tone' | 'label';

/** How many of a whiteboard's latest changes its log keeps for streams that resume. */
export const CHANGES_KEPT = 500;
/** A viewer who hasn't been seen this long has gone. Open streams refresh every 15 seconds. */
export const VIEWER_SECONDS = 45;

/** Each kind's size when it's added without one, and what it may set. */
const KINDS: Record<string, { w: number; h: number; sets: readonly Settable[] }> = {
  note: { w: 200, h: 140, sets: ['x', 'y', 'w', 'h', 'z', 'text', 'tone'] },
  text: { w: 240, h: 48, sets: ['x', 'y', 'w', 'h', 'z', 'text'] },
  issue: { w: 240, h: 112, sets: ['x', 'y', 'w', 'h', 'z'] },
  article: { w: 240, h: 112, sets: ['x', 'y', 'w', 'h', 'z'] },
  section: { w: 520, h: 360, sets: ['x', 'y', 'w', 'h', 'z', 'text'] },
  arrow: { w: WHITEBOARD_LIMITS.minSize, h: WHITEBOARD_LIMITS.minSize, sets: ['z', 'label'] },
};

const missing = () => notFound('Whiteboard').said('notFound.whiteboard');

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * Who the caller is on a person's own whiteboard: nobody at all for a guest; the owner, or a named
 * person, or a named group's member, or everyone signed in, as its sharing says (D58's revisit).
 */
export function personalAccess(view: AccessView, row: BoardRow) {
  const owner = !view.guest && row.createdById === view.userId;
  if (row.share === 'everyone') return { owner, read: !view.guest, edit: !view.guest } as const;
  const with_: { people?: string[]; groups?: string[] } = (row.sharedWith as { people?: string[]; groups?: string[] }) ?? {};
  const named = Boolean((with_.people ?? []).includes(view.userId) || (with_.groups ?? []).some((g) => view.groupIds.includes(g)));
  return { owner, read: owner || named, edit: owner || named } as const;
}

/**
 * The whiteboard, if the caller may do `need` with it: one in a project they can't read is missing, in
 * the words of one that doesn't exist; one they read but may not change is 403, naming the permission.
 */
export async function requireWhiteboard(ctx: Ctx, id: string, need: 'read' | 'edit' = 'read', db: Db = ctx.db, lock = false): Promise<BoardRow> {
  requireScope(ctx, need === 'read' ? 'read' : 'write');
  const view = await projectAccess(ctx, db);
  const query = db.select().from(whiteboards).where(eq(whiteboards.id, id.trim()));
  const [row] = lock ? await query.for('no key update') : await query;
  if (!row) throw missing();
  if (row.projectId) {
    if (!view.canRead(row.projectId)) throw missing();
    if (need === 'edit') await assertCanProject(ctx, row.projectId, 'edit', db);
    return row;
  }
  // A person's own whiteboard: its sharing says who reads and changes it.
  const personal = personalAccess(view, row);
  if (!personal.read) throw missing();
  if (need === 'edit' && !personal.edit) throw forbidden('You may read this whiteboard, but its owner is the one who changes it', 'Ask its owner to share it with you.').said('whiteboards.readOnlyShared');
  return row;
}

function boardDto(s: SchemaSnapshot, view: AccessView, ctx: Ctx, row: BoardRow, elements: number, shared: Whiteboard['sharedWith'] | null = null, personal: ReturnType<typeof personalAccess> | null = null): Whiteboard {
  const p = row.projectId ? s.projects.get(row.projectId) : undefined;
  const by = row.createdById ? s.users.get(row.createdById) : undefined;
  const edit = personal ? personal.edit : view.canWrite(row.projectId!);
  return {
    id: row.id,
    name: row.name,
    project: row.projectId ? { id: row.projectId, key: p?.key ?? '?', name: p?.name ?? '' } : null,
    owner: personal && by ? userRefDto(by) : null,
    createdBy: by ? userRefDto(by) : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    seq: Number(row.seq),
    elements,
    share: personal ? ((row.share as 'everyone' | 'limited') ?? 'everyone') : 'everyone',
    sharedWith: personal ? (shared ?? { users: [], groups: [] }) : { users: [], groups: [] },
    access: { edit, delete: personal ? personal.owner : view.canManage(row.projectId!) || (edit && row.createdById === ctx.actor.user.id), share: personal ? personal.owner : false },
  };
}

export function elementDto(s: SchemaSnapshot, r: ElementRow): WhiteboardElement {
  const by = r.updatedById ? s.users.get(r.updatedById) : undefined;
  return {
    id: r.id,
    kind: r.kind as WhiteboardElement['kind'],
    x: r.x,
    y: r.y,
    w: r.w,
    h: r.h,
    z: r.z,
    text: r.text,
    tone: (r.tone as WhiteboardElement['tone']) ?? null,
    label: r.label,
    from: r.fromId,
    to: r.toId,
    linked: r.linked,
    seq: Number(r.seq),
    version: r.version,
    updatedAt: new Date(r.updatedAt).toISOString(),
    updatedBy: by ? userRefDto(by) : null,
  };
}

async function countsOf(db: Db, ids: string[]): Promise<Map<string, number>> {
  if (!ids.length) return new Map();
  const rows = await db
    .select({ id: whiteboardElements.whiteboardId, n: count() })
    .from(whiteboardElements)
    .where(inArray(whiteboardElements.whiteboardId, ids))
    .groupBy(whiteboardElements.whiteboardId);
  return new Map(rows.map((r) => [r.id, Number(r.n)]));
}

/** Each personal whiteboard's named readers, as the API shows them: people and groups by name. */
async function sharedWithDtos(ctx: Ctx, rows: BoardRow[]): Promise<Map<string, Whiteboard['sharedWith']>> {
  const personal = rows.filter((r) => !r.projectId);
  if (!personal.length) return new Map();
  const [s, db] = [await ctx.app.schema.get(), ctx.db];
  const dtos = await visibleToDtos(db, s, personal.map((r) => ({ limited: true, visibleUserIds: ((r.sharedWith as { people?: string[] })?.people ?? []), visibleGroupIds: ((r.sharedWith as { groups?: string[] })?.groups ?? []) })));
  return new Map(personal.map((r, i) => [r.id, dtos[i] ?? { users: [], groups: [] }]));
}

/** The whiteboards the caller can see, in one project or all, the latest changed first. Without a
 * project, a person's own whiteboards and those shared with them come too (D58's revisit). */
export async function listWhiteboards(ctx: Ctx, opts: { project?: string } = {}): Promise<Whiteboard[]> {
  requireScope(ctx, 'read');
  const [view, s] = [await projectAccess(ctx), await ctx.app.schema.get()];
  let projectIds = view.visibleIds();
  if (opts.project) projectIds = [(await requireProject(ctx, opts.project)).id];
  if (projectIds && !projectIds.length && !view.userId) return [];
  // A person's own whiteboards and those shared with them come with the rest, never beside a project's list.
  const where = opts.project
    ? inArray(whiteboards.projectId, projectIds!)
    : projectIds === null
      ? undefined
      : projectIds.length
        ? or(inArray(whiteboards.projectId, projectIds), isNull(whiteboards.projectId))
        : isNull(whiteboards.projectId);
  const rows = await ctx.db
    .select()
    .from(whiteboards)
    .where(where)
    .orderBy(desc(whiteboards.updatedAt))
    .limit(500);
  const counts = await countsOf(ctx.db, rows.map((r) => r.id));
  const shared = await sharedWithDtos(ctx, rows);
  const out: Whiteboard[] = [];
  for (const r of rows) {
    if (r.projectId) {
      if (view.canRead(r.projectId)) out.push(boardDto(s, view, ctx, r, counts.get(r.id) ?? 0));
      continue;
    }
    const personal = personalAccess(view, r);
    if (personal.read) out.push(boardDto(s, view, ctx, r, counts.get(r.id) ?? 0, shared.get(r.id), personal));
  }
  return out;
}

/** What each card holds, as the caller may see it now: nothing at all of what they may not (D58). */
export async function cardsFor(ctx: Ctx, rows: readonly ElementRow[], db: Db = ctx.db): Promise<WhiteboardCard[]> {
  const cards = rows.filter((r) => r.kind === 'issue' || r.kind === 'article');
  if (!cards.length) return [];
  const s = await ctx.app.schema.get(db);
  const issueIds = cards.map((r) => r.issueId).filter((id): id is string => Boolean(id));
  const articleIds = cards.map((r) => r.articleId).filter((id): id is string => Boolean(id));
  const [seenIssues, seenArticles] = [await seenIssueIds(ctx, issueIds, db), await seenArticleIds(ctx, articleIds, db)];
  const issueRows = seenIssues.size ? await db.select().from(issues).where(inArray(issues.id, [...seenIssues])) : [];
  // Its fields as the caller reads them: a private field kept from them isn't there (D50).
  const dtos = new Map((await issueDtos(ctx, issueRows)).map((d) => [d.uid, d]));
  const articleRows = seenArticles.size ? await db.select().from(articles).where(inArray(articles.id, [...seenArticles])) : [];
  const byArticle = new Map(articleRows.map((a) => [a.id, a]));
  return cards.map((r): WhiteboardCard => {
    if (r.kind === 'issue') {
      const d = r.issueId ? dtos.get(r.issueId) : undefined;
      if (!d) return { element: r.id, shown: false };
      const state = d.fields.find((f) => f.type === 'state')?.value;
      const people = d.fields.filter((f) => f.type === 'user');
      const assignee = (people.find((f) => f.name.toLowerCase() === 'assignee') ?? people[0])?.value;
      return {
        element: r.id,
        shown: true,
        id: d.id,
        summary: d.summary,
        state: state && typeof state === 'object' && !Array.isArray(state) && 'ordinal' in state ? state : null,
        assignee: assignee && typeof assignee === 'object' && !Array.isArray(assignee) && 'login' in assignee ? assignee : null,
        resolved: d.resolvedAt !== null,
      };
    }
    const a = r.articleId ? byArticle.get(r.articleId) : undefined;
    if (!a) return { element: r.id, shown: false };
    return { element: r.id, shown: true, id: articleReadableId(s, a), summary: a.title };
  });
}

export async function elementRows(db: Db, id: string): Promise<ElementRow[]> {
  return db.select().from(whiteboardElements).where(eq(whiteboardElements.whiteboardId, id));
}

/** A whiteboard whole: its elements, its cards as the caller sees them, and who's looking. */
export async function getWhiteboard(ctx: Ctx, id: string): Promise<WhiteboardDetail> {
  const row = await requireWhiteboard(ctx, id);
  const [view, s] = [await projectAccess(ctx), await ctx.app.schema.get()];
  const rows = await elementRows(ctx.db, row.id);
  const [shared, personal] = row.projectId ? [undefined, null] : [(await sharedWithDtos(ctx, [row])).get(row.id), personalAccess(view, row)];
  return {
    whiteboard: boardDto(s, view, ctx, row, rows.length, shared, personal),
    elements: rows.map((r) => elementDto(s, r)),
    cards: await cardsFor(ctx, rows),
    viewers: seesViewers(ctx) ? await viewersOf(ctx.db, s, row.id) : [],
  };
}

/**
 * Whether the caller is told who's looking, and counted among them. Not a guest (D64): who has a
 * whiteboard open is what people are doing now, the team's to know, and a guest reaches no people
 * (D37); nor is a guest, who is nobody in particular, anyone to show the team.
 */
export function seesViewers(ctx: Ctx): boolean {
  return !ctx.actor.guest;
}

/** Just the cards, for a page to read again when an issue or article on it changes. */
export async function getWhiteboardCards(ctx: Ctx, id: string): Promise<WhiteboardCard[]> {
  const row = await requireWhiteboard(ctx, id);
  return cardsFor(ctx, await elementRows(ctx.db, row.id));
}

// ---------------------------------------------------------------------------
// The whiteboard itself: made, renamed, deleted (events, D58)
// ---------------------------------------------------------------------------

export async function createWhiteboard(ctx: Ctx, input: { project?: string; name: string; share?: 'everyone' | 'limited'; sharedWith?: { users: string[]; groups: string[] } }): Promise<Whiteboard> {
  requireScope(ctx, 'write');
  const name = input.name.trim();
  if (!name) throw badRequest('Give the whiteboard a name').said('whiteboards.nameNeeded');
  // A person's own whiteboard (no project): its owner, shared as it says. A guest makes nothing (D37).
  if (!input.project && ctx.actor.guest) throw unauthorized('Sign in to make a whiteboard of your own', 'Sign in, or make one on a project you may read.').said('whiteboards.signInForOwn');
  const project = input.project ? await requireProject(ctx, input.project, 'edit') : null;
  const sharing = project ? null : await resolveVisibleTo(ctx.db, await ctx.app.schema.get(), { users: input.sharedWith?.users ?? [], groups: input.sharedWith?.groups ?? [] });
  if (!project && input.share === 'limited' && !sharing!.visibleUserIds.length && !sharing!.visibleGroupIds.length) {
    throw badRequest('Name who else reads it, or share it with everyone', 'Limited to some, a whiteboard needs people or groups in sharedWith.').said('whiteboards.limitedNeedsPeople');
  }
  const { row, activity } = await ctx.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [row] = await tx
      .insert(whiteboards)
      .values({ id: newId(), projectId: project?.id ?? null, name, createdById: ctx.actor.user.id, share: project ? 'everyone' : (input.share ?? 'everyone'), sharedWith: sharing ? { people: sharing.visibleUserIds, groups: sharing.visibleGroupIds } : { people: [], groups: [] } })
      .returning();
    const activity = await recordActivity(tx, ctx, { type: 'whiteboard.created', projectId: project?.id ?? null, issueId: null, payload: { data: { whiteboard: { id: row!.id, name, ...(personalFacts(row!) ? { personal: personalFacts(row!) } : {}) } } } });
    return { row: row!, activity };
  });
  await publishActivities(ctx.app, [activity]);
  const [view, s] = [await projectAccess(ctx), await ctx.app.schema.get()];
  const [shared, personal] = project ? [undefined, null] : [(await sharedWithDtos(ctx, [row])).get(row.id), personalAccess(view, row)];
  return boardDto(s, view, ctx, row, 0, shared, personal);
}

export async function renameWhiteboard(ctx: Ctx, id: string, input: { name: string }): Promise<Whiteboard> {
  const name = input.name.trim();
  if (!name) throw badRequest('Give the whiteboard a name').said('whiteboards.nameNeeded');
  const { row, activity, elements } = await ctx.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const before = await requireWhiteboard(ctx, id, 'edit', tx, true);
    const [row] = await tx.update(whiteboards).set({ name, updatedAt: new Date() }).where(eq(whiteboards.id, before.id)).returning();
    const activity =
      before.name === name
        ? null
        : await recordActivity(tx, ctx, { type: 'whiteboard.renamed', projectId: before.projectId, issueId: null, payload: { data: { whiteboard: { id: before.id, name, ...(personalFacts(before) ? { personal: personalFacts(before) } : {}) }, from: before.name, to: name } } });
    return { row: row!, activity, elements: (await countsOf(tx, [before.id])).get(before.id) ?? 0 };
  });
  if (activity) await publishActivities(ctx.app, [activity]);
  whiteboardLive(ctx.app).changed([row.id]);
  const [view, s] = [await projectAccess(ctx), await ctx.app.schema.get()];
  const [shared, personal] = row.projectId ? [undefined, null] : [(await sharedWithDtos(ctx, [row])).get(row.id), personalAccess(view, row)];
  return boardDto(s, view, ctx, row, elements, shared, personal);
}

/** A personal whiteboard's owner says who else reads and changes it: everyone signed in, or the named people and groups. */
export async function setWhiteboardSharing(ctx: Ctx, id: string, input: { share: 'everyone' | 'limited'; sharedWith?: { users: string[]; groups: string[] } }): Promise<Whiteboard> {
  requireScope(ctx, 'write');
  const sharing = await resolveVisibleTo(ctx.db, await ctx.app.schema.get(), { users: input.sharedWith?.users ?? [], groups: input.sharedWith?.groups ?? [] });
  if (input.share === 'limited' && !sharing.visibleUserIds.length && !sharing.visibleGroupIds.length) {
    throw badRequest('Name who else reads it, or share it with everyone', 'Limited to some, a whiteboard needs people or groups in sharedWith.').said('whiteboards.limitedNeedsPeople');
  }
  const row = await ctx.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const before = await requireWhiteboard(ctx, id, 'edit', tx, true);
    if (before.projectId) throw badRequest('A project’s whiteboard follows its project', 'Who reads the project reads it, and sharing is its project’s.').said('whiteboards.projectBoardNoShare');
    const view = await projectAccess(ctx, tx);
    if (!personalAccess(view, before).owner) throw forbidden('Only its owner says who else reads this whiteboard', 'Ask its owner.').said('whiteboards.onlyOwnerShares');
    const [row] = await tx.update(whiteboards).set({ share: input.share, sharedWith: { people: sharing.visibleUserIds, groups: sharing.visibleGroupIds }, updatedAt: new Date() }).where(eq(whiteboards.id, before.id)).returning();
    return row!;
  });
  const [view, s] = [await projectAccess(ctx), await ctx.app.schema.get()];
  return boardDto(s, view, ctx, row, (await countsOf(ctx.db, [row.id])).get(row.id) ?? 0, (await sharedWithDtos(ctx, [row])).get(row.id), personalAccess(view, row));
}

/** What a personal whiteboard's life events carry, so its readers see them after it's gone (D58's revisit). */
function personalFacts(row: Pick<BoardRow, 'projectId' | 'share' | 'sharedWith'>) {
  if (row.projectId) return null;
  return { share: (row.share ?? 'everyone') as 'everyone' | 'limited', people: ((row.sharedWith as { people?: string[] })?.people ?? []), groups: ((row.sharedWith as { groups?: string[] })?.groups ?? []) };
}

/** Its elements and their log go with it; the issues and articles on its cards stay as they are. */
export async function deleteWhiteboard(ctx: Ctx, id: string): Promise<void> {
  const activity = await ctx.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const row = await requireWhiteboard(ctx, id, 'read', tx, true);
    const view = await projectAccess(ctx, tx);
    const may = row.projectId ? view.canManage(row.projectId) || (row.createdById === ctx.actor.user.id && view.canWrite(row.projectId)) : personalAccess(view, row).owner;
    if (!may) {
      requireScope(ctx, 'write');
      const key = row.projectId ? (view.keyOf(row.projectId) ?? 'its project') : 'its owner';
      throw forbidden(`Only whoever made it, or a manager of ${key}, can delete this whiteboard`, `Ask a manager of ${key}.`).said('whiteboards.onlyMakerOrManagers', { key });
    }
    const elements = (await countsOf(tx, [row.id])).get(row.id) ?? 0;
    await tx.delete(whiteboards).where(eq(whiteboards.id, row.id));
    return recordActivity(tx, ctx, { type: 'whiteboard.deleted', projectId: row.projectId, issueId: null, payload: { data: { whiteboard: { id: row.id, name: row.name, ...(personalFacts(row) ? { personal: personalFacts(row) } : {}) }, elements } } });
  });
  await publishActivities(ctx.app, [activity]);
  whiteboardLive(ctx.app).changed([id.trim()]);
}

// ---------------------------------------------------------------------------
// Changes to elements: batches, merged property by property
// ---------------------------------------------------------------------------

/** Values alike: no words is no words, whether it was kept as empty or as nothing. */
const norm = (v: unknown) => (v === '' || v === undefined ? null : v);
const equal = (a: unknown, b: unknown) => norm(a) === norm(b);

function holds(row: ElementRow, expect: Partial<Record<Settable, unknown>> | undefined): boolean {
  if (!expect) return true;
  return (Object.keys(expect) as Settable[]).every((k) => equal(row[k], expect[k]));
}

/**
 * Record a change the transaction made: the whiteboard's next `seq`, its log's entry for the streams,
 * and the oldest entries let go. The caller holds the whiteboard's row lock.
 */
async function logChange(tx: Db, ctx: Ctx, s: SchemaSnapshot, board: BoardRow, seq: number, rows: ElementRow[], removed: string[], client: string | null) {
  await tx.update(whiteboards).set({ seq, updatedAt: new Date() }).where(eq(whiteboards.id, board.id));
  await tx.insert(whiteboardChanges).values({
    whiteboardId: board.id,
    seq,
    actorId: ctx.actor.user.id === 'system' ? null : ctx.actor.user.id,
    client,
    elements: rows.map((r) => elementDto(s, r)),
    removed,
  });
  await tx.delete(whiteboardChanges).where(and(eq(whiteboardChanges.whiteboardId, board.id), lte(whiteboardChanges.seq, seq - CHANGES_KEPT)));
}

async function writeRows(tx: Db, rows: ElementRow[]) {
  for (let i = 0; i < rows.length; i += 200) {
    await tx
      .insert(whiteboardElements)
      .values(rows.slice(i, i + 200))
      .onConflictDoUpdate({
        target: [whiteboardElements.whiteboardId, whiteboardElements.id],
        set: {
          kind: sql`excluded.kind`,
          x: sql`excluded.x`,
          y: sql`excluded.y`,
          w: sql`excluded.w`,
          h: sql`excluded.h`,
          z: sql`excluded.z`,
          text: sql`excluded.text`,
          tone: sql`excluded.tone`,
          label: sql`excluded.label`,
          fromId: sql`excluded.from_id`,
          toId: sql`excluded.to_id`,
          issueId: sql`excluded.issue_id`,
          articleId: sql`excluded.article_id`,
          linked: sql`excluded.linked`,
          seq: sql`excluded.seq`,
          version: sql`excluded.version`,
          updatedById: sql`excluded.updated_by_id`,
          updatedAt: sql`excluded.updated_at`,
        },
      });
  }
}

/** The longest common subsequence of two line arrays, as the pairs of indexes it keeps. */
function lcsPairs(a: string[], b: string[]): [number, number][] {
  // A plain DP: a note's words are a few dozen lines at most, so this stays small.
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const out: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push([i, j]);
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) i++;
    else j++;
  }
  return out;
}

/**
 * Two people's changes to the same note's words, merged rather than refused (D58's revisit): each
 * side's lines kept and changed land, by the lines both kept in order; a line both changed keeps
 * both, so nobody's typing is lost.
 */
export function mergeWords(base: string, mine: string, theirs: string): string {
  if (mine === theirs || mine === base) return theirs;
  if (theirs === base) return mine;
  const b = base.split('\n');
  const m = mine.split('\n');
  const t = theirs.split('\n');
  const mPairs = lcsPairs(b, m);
  const tPairs = lcsPairs(b, t);
  const mAt = new Map<number, number>(mPairs.map(([bi, mi]) => [bi, mi]));
  const tAt = new Map<number, number>(tPairs.map(([bi, ti]) => [bi, ti]));
  /** The side's lines after its kept pair at `bi`, before its next kept one: its changes for what follows. */
  const gapAfter = (pairs: [number, number][], side: string[], bi: number): string[] => {
    const k = pairs.findIndex(([x]) => x === bi);
    if (k < 0) return [];
    return side.slice(pairs[k]![1] + 1, k + 1 < pairs.length ? pairs[k + 1]![1] : side.length);
  };
  const out: string[] = [];
  // What each side put before its first kept line: its changes to the top of the note.
  out.push(...(mPairs.length ? m.slice(0, mPairs[0]![1]) : m.slice()), ...(tPairs.length ? t.slice(0, tPairs[0]![1]) : t.slice()));
  for (let bi = 0; bi < b.length; bi++) {
    const mm = mAt.get(bi);
    const tt = tAt.get(bi);
    if (mm !== undefined && tt !== undefined) {
      // Kept by both: once when it reads alike; both when each changed it, so nobody's typing is lost.
      if (m[mm] === t[tt]) out.push(m[mm]!);
      else out.push(m[mm]!, t[tt]!);
    }
    // Kept by one side alone, the other's change stands in its place: the base line the keeper kept is gone there.
    if (mm !== undefined) out.push(...gapAfter(mPairs, m, bi));
    if (tt !== undefined) out.push(...gapAfter(tPairs, t, bi));
  }
  return out.join('\n');
}

/**
 * Apply a batch of changes to a whiteboard's elements, in order, in one transaction. Each operation
 * stands alone: one whose element has gone, or no longer has what it `expect`s, or whose id is taken,
 * is refused with the element as it is, and the rest go on. What doesn't fit (too many elements, an
 * arrow without two ends, a card without its issue) refuses the whole batch, saying so.
 */
export async function applyWhiteboardBatch(ctx: Ctx, id: string, input: WhiteboardBatchInput): Promise<WhiteboardBatchResult> {
  requireScope(ctx, 'write');
  const body = WhiteboardBatchBody.parse(input);
  const s = await ctx.app.schema.get();
  // What cards name, resolved first through the seam: a hidden issue is as missing as one that isn't there.
  const targets = new Map<string, { issueId?: string; articleId?: string }>();
  for (const op of body.ops) {
    if (op.op !== 'add') continue;
    if (op.kind === 'issue' || op.kind === 'article') {
      const ref = op.kind === 'issue' ? op.issue : op.article;
      if (!ref) throw badRequest('An issue card needs its issue, and an article card its article', 'Give "issue", such as BACK-12, or "article", such as BACK-A-3.').said('whiteboards.cardNeedsItsItem');
      if (op.kind === 'issue') {
        targets.set(op.id, { issueId: (await resolveIssue(ctx, ref)).id });
      } else targets.set(op.id, { articleId: (await resolveArticle(ctx, ref)).id });
    }
    if (op.kind === 'arrow' && (!op.from || !op.to || op.from === op.to)) {
      throw badRequest('An arrow goes from one element to another', 'Give "from" and "to": two different elements on the whiteboard.').said('whiteboards.arrowNeedsTwoEnds');
    }
  }
  const out = await ctx.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const board = await requireWhiteboard(ctx, id, 'edit', tx, true);
    const current = await elementRows(tx, board.id);
    const els = new Map(current.map((r) => [r.id, r]));
    const seq = Number(board.seq) + 1;
    const now = new Date();
    const touched = new Map<string, ElementRow>();
    const removed = new Set<string>();
    const refused: WhiteboardBatchResult['refused'] = [];
    const me = ctx.actor.user.id === 'system' ? null : ctx.actor.user.id;
    const drop = (rid: string) => {
      els.delete(rid);
      touched.delete(rid);
      if (current.some((r) => r.id === rid)) removed.add(rid);
    };
    let top = Math.max(0, ...current.map((r) => r.z));
    for (let op of body.ops) {
      if (op.op === 'add') {
        const there = els.get(op.id);
        if (there) {
          refused.push({ id: op.id, op: 'add', reason: 'exists', element: elementDto(s, there) });
          continue;
        }
        if (op.kind === 'arrow') {
          const from = els.get(op.from!);
          const to = els.get(op.to!);
          // An arrow joins two of what's there; one end gone (removed meanwhile) refuses this arrow alone.
          if (!from || !to || from.kind === 'arrow' || to.kind === 'arrow') {
            refused.push({ id: op.id, op: 'add', reason: 'gone', element: null });
            continue;
          }
        }
        const kind = KINDS[op.kind]!;
        const row: ElementRow = {
          whiteboardId: board.id,
          id: op.id,
          kind: op.kind,
          x: op.kind === 'arrow' ? 0 : op.x,
          y: op.kind === 'arrow' ? 0 : op.y,
          w: op.kind === 'arrow' ? kind.w : (op.w ?? kind.w),
          h: op.kind === 'arrow' ? kind.h : (op.h ?? kind.h),
          z: op.z ?? (top += 1),
          text: op.kind === 'note' || op.kind === 'text' || op.kind === 'section' ? (op.text ?? '') : null,
          tone: op.kind === 'note' ? (op.tone ?? 'plain') : null,
          label: op.kind === 'arrow' ? (op.label?.trim() || null) : null,
          fromId: op.kind === 'arrow' ? op.from! : null,
          toId: op.kind === 'arrow' ? op.to! : null,
          issueId: targets.get(op.id)?.issueId ?? null,
          articleId: targets.get(op.id)?.articleId ?? null,
          linked: null,
          seq,
          version: 1,
          updatedById: me,
          updatedAt: now,
        };
        els.set(op.id, row);
        touched.set(op.id, row);
        removed.delete(op.id);
        continue;
      }
      const row = els.get(op.id);
      if (!row) {
        refused.push({ id: op.id, op: op.op, reason: 'gone', element: null });
        continue;
      }
      if (!holds(row, op.expect)) {
        // Words are merged rather than refused (D58's revisit): when only the words have moved on,
        // the change is merged into what's there, and the rest of its expect must still hold.
        if (op.op === 'update' && typeof op.expect?.text === 'string' && typeof op.set?.text === 'string' && (() => { const { text: _held, ...rest } = op.expect ?? {}; return holds(row, rest); })()) {
          op = { ...op, set: { ...op.set, text: mergeWords(op.expect.text, op.set.text, row.text ?? '') } };
        } else {
          refused.push({ id: op.id, op: op.op, reason: 'changed', element: elementDto(s, row) });
          continue;
        }
      }
      if (op.op === 'remove') {
        drop(op.id);
        // What an arrow joins goes, and the arrow with it.
        for (const other of [...els.values()]) if (other.kind === 'arrow' && (other.fromId === op.id || other.toId === op.id)) drop(other.id);
        continue;
      }
      const allowed = KINDS[row.kind]?.sets ?? [];
      const next: ElementRow = { ...row };
      let changed = false;
      for (const [k, v] of Object.entries(op.set) as [Settable, unknown][]) {
        if (!allowed.includes(k) || equal(row[k], k === 'label' && typeof v === 'string' ? v.trim() || null : v)) continue;
        (next as Record<string, unknown>)[k] = k === 'label' && typeof v === 'string' ? v.trim() || null : v;
        changed = true;
      }
      if (!changed) continue;
      if (next.z > top) top = next.z;
      Object.assign(next, { seq, version: row.version + 1, updatedById: me, updatedAt: now });
      els.set(op.id, next);
      touched.set(op.id, next);
    }
    if (els.size > WHITEBOARD_LIMITS.elements && els.size > current.length) {
      throw conflict(`A whiteboard holds ${WHITEBOARD_LIMITS.elements} elements at most`, 'Remove some, or start another whiteboard.').said('whiteboards.full', { n: WHITEBOARD_LIMITS.elements });
    }
    if (!touched.size && !removed.size) return { seq: Number(board.seq), rows: [] as ElementRow[], removed: [] as string[], refused };
    if (removed.size) await tx.delete(whiteboardElements).where(and(eq(whiteboardElements.whiteboardId, board.id), inArray(whiteboardElements.id, [...removed])));
    const rows = [...touched.values()];
    await writeRows(tx, rows);
    await logChange(tx, ctx, s, board, seq, rows, [...removed], body.client ?? null);
    return { seq, rows, removed: [...removed], refused };
  });
  if (out.rows.length || out.removed.length) whiteboardLive(ctx.app).changed([id.trim()], { look: false });
  return {
    seq: out.seq,
    applied: [...out.rows.map((r) => r.id), ...out.removed],
    elements: out.rows.map((r) => elementDto(s, r)),
    removed: out.removed,
    refused: out.refused,
  };
}

// ---------------------------------------------------------------------------
// Converting: notes into issues, arrows into links
// ---------------------------------------------------------------------------

/** A dry run's way out of its transaction, with what it would have made. */
class DryRun extends Error {
  constructor(readonly made: { summary?: string; link?: string; relation?: string; made?: boolean }) {
    super('dry run');
  }
}

function problemOf(e: unknown): ItemProblem {
  if (e instanceof AppError) return { message: e.message, ...(e.hint ? { hint: e.hint } : {}), said: errorWords(e, e.message) as ItemProblem['said'] };
  console.error('whiteboards: converting one item failed', e);
  const message = 'This one could not be converted';
  const hint = 'Try it again.';
  return { message, hint, said: { key: 'inItsOwnWords', values: { words: pageWords(message, hint) } } };
}

interface Origin {
  id: string;
  name: string;
  project: string;
}

/**
 * Make issues of notes, and links of arrows, each in a transaction of its own: one that fails says why,
 * and the rest still convert. A note becomes its issue's card where it was, so its arrows stay; an arrow
 * whose two ends are issues (or became issues just now) becomes a link of the type asked for, which is
 * never made twice. Each new issue's history, and each link's, says which whiteboard it came from.
 * A dry run does each the same way and rolls it back, so it says exactly what would happen.
 */
export async function convertWhiteboard(ctx: Ctx, id: string, input: WhiteboardConvertInput): Promise<WhiteboardConvertResult> {
  requireScope(ctx, 'write');
  const body = WhiteboardConvertBody.parse(input);
  const board = await requireWhiteboard(ctx, id, 'edit');
  const s = await ctx.app.schema.get();
  if (body.notes.length && !body.project) {
    throw badRequest('Say which project the notes’ issues go in', 'Give "project", a key such as BACK.').said('whiteboards.projectNeeded');
  }
  // A project they can't report in refuses the whole request: it would refuse every note.
  const project = body.project && body.notes.length ? await requireProject(ctx, body.project, 'create') : null;
  const origin: Origin = { id: board.id, name: board.name, project: board.projectId ? (s.projects.get(board.projectId)?.key ?? '') : '' };
  const notes: WhiteboardConvertResult['notes'] = [];
  const links: WhiteboardConvertResult['links'] = [];
  let seq = Number(board.seq);
  const made: string[] = [];
  const linked: { from: string; to: string; relation: string }[] = [];
  for (const noteId of [...new Set(body.notes)]) {
    try {
      const out = await convertNote(ctx, board.id, noteId, project!.key, origin, body.dryRun);
      if (out.seq) seq = out.seq;
      if (out.issue && !out.already) made.push(out.issue);
      notes.push({ element: noteId, ok: true, ...(out.issue ? { issue: out.issue } : {}), ...(out.summary ? { summary: out.summary } : {}), ...(out.already ? { already: true } : {}) });
    } catch (e) {
      if (e instanceof DryRun) notes.push({ element: noteId, ok: true, ...(e.made.summary ? { summary: e.made.summary } : {}) });
      else notes.push({ element: noteId, ok: false, problem: problemOf(e) });
    }
  }
  for (const l of body.links) {
    try {
      const out = await linkArrow(ctx, board.id, l.arrow, l.relation, origin, body.dryRun, new Set(notes.filter((n) => n.ok && body.dryRun).map((n) => n.element)));
      if (out.seq) seq = out.seq;
      if (out.made) linked.push(out.made);
      links.push({ element: l.arrow, ok: true, link: out.link, relation: out.relation, made: Boolean(out.made) });
    } catch (e) {
      if (e instanceof DryRun) links.push({ element: l.arrow, ok: true, ...(e.made.link ? { link: e.made.link } : {}), ...(e.made.relation ? { relation: e.made.relation } : {}), made: e.made.made ?? true });
      else links.push({ element: l.arrow, ok: false, problem: problemOf(e) });
    }
  }
  if (!body.dryRun && (made.length || linked.length)) {
    const activity = await ctx.db.transaction(async (tx) =>
      recordActivity(tx as unknown as Db, ctx, {
        type: 'whiteboard.converted',
        projectId: board.projectId,
        issueId: null,
        payload: { data: { whiteboard: { id: board.id, name: board.name, ...(personalFacts(board) ? { personal: personalFacts(board) } : {}) }, issues: made, links: linked, failed: [...notes, ...links].filter((n) => !n.ok).length } },
      }),
    );
    await publishActivities(ctx.app, [activity]);
  }
  return { dryRun: body.dryRun, seq, notes, links };
}

async function convertNote(ctx: Ctx, boardId: string, noteId: string, projectKey: string, origin: Origin, dryRun: boolean) {
  const out = await ctx.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const board = await requireWhiteboard(ctx, boardId, 'edit', tx, true);
    const [el] = await tx.select().from(whiteboardElements).where(and(eq(whiteboardElements.whiteboardId, board.id), eq(whiteboardElements.id, noteId)));
    if (!el) throw notFound('Note', 'It may have just been removed from the whiteboard.').said('whiteboards.noSuchNote');
    const s = await ctx.app.schema.get(tx);
    if (el.kind === 'issue') {
      // Converted already, by a retry or by someone else: nothing is made twice, and a hidden issue isn't named.
      const seen = el.issueId ? await seenIssueIds(ctx, [el.issueId], tx) : new Set<string>();
      const [row] = el.issueId && seen.has(el.issueId) ? await tx.select().from(issues).where(eq(issues.id, el.issueId)) : [];
      return { already: true, issue: row ? readableId(s, row) : undefined, seq: 0, activities: [] as ActivityRow[], created: null as string | null };
    }
    if (el.kind !== 'note') throw badRequest('Only a note becomes an issue').said('whiteboards.notANote');
    const { summary, description } = noteAsIssue(el.text ?? '');
    if (!summary) throw badRequest('This note says nothing yet', 'Write what the issue is first.').said('whiteboards.emptyNote');
    const { issue, activities } = await createIssueInTx(tx, ctx, { project: projectKey, summary, description }, { data: { whiteboard: origin } });
    if (dryRun) throw new DryRun({ summary });
    const seq = Number(board.seq) + 1;
    const [row] = await tx
      .update(whiteboardElements)
      .set({ kind: 'issue', issueId: issue.id, text: null, tone: null, seq, version: el.version + 1, updatedById: ctx.actor.user.id, updatedAt: new Date() })
      .where(and(eq(whiteboardElements.whiteboardId, board.id), eq(whiteboardElements.id, noteId)))
      .returning();
    await logChange(tx, ctx, s, board, seq, [row!], [], null);
    return { already: false, issue: readableId(s, issue), summary, seq, activities, created: issue.id };
  });
  if (out.activities.length) await publishActivities(ctx.app, out.activities);
  // New work, as any new issue: triage reads it as it reads one made on the issues page.
  if (out.created) ctx.app.hooks.onIssueCreated?.(out.created, ctx.actor);
  if (out.seq) whiteboardLive(ctx.app).changed([boardId], { look: false });
  return out;
}

async function linkArrow(ctx: Ctx, boardId: string, arrowId: string, relation: string, origin: Origin, dryRun: boolean, wouldBeIssues: Set<string>) {
  const out = await ctx.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const board = await requireWhiteboard(ctx, boardId, 'edit', tx, true);
    const s = await ctx.app.schema.get(tx);
    const rows = await tx
      .select()
      .from(whiteboardElements)
      .where(and(eq(whiteboardElements.whiteboardId, board.id), inArray(whiteboardElements.id, [arrowId])));
    const arrow = rows[0];
    if (!arrow) throw notFound('Arrow', 'It may have just been removed from the whiteboard.').said('whiteboards.noSuchArrow');
    if (arrow.kind !== 'arrow') throw badRequest('Only an arrow becomes a link').said('whiteboards.notAnArrow');
    const ends = await tx
      .select()
      .from(whiteboardElements)
      .where(and(eq(whiteboardElements.whiteboardId, board.id), inArray(whiteboardElements.id, [arrow.fromId ?? '', arrow.toId ?? ''])));
    const from = ends.find((e) => e.id === arrow.fromId);
    const to = ends.find((e) => e.id === arrow.toId);
    const phrase = resolveLinkPhrase(s, relation);
    // In a dry run, a note this request would make an issue of counts as one.
    if (dryRun && from && to && [from, to].every((e) => e.kind === 'issue' || wouldBeIssues.has(e.id)) && [from, to].some((e) => e.kind !== 'issue')) {
      throw new DryRun({ relation: phrase.display });
    }
    const ids = [from?.issueId, to?.issueId].filter((x): x is string => Boolean(x));
    const seen = await seenIssueIds(ctx, ids, tx);
    // An end that isn't an issue, or is one they can't see, reads the same: no hidden issue is named.
    if (!from?.issueId || !to?.issueId || !seen.has(from.issueId) || !seen.has(to.issueId)) {
      throw badRequest('Both ends of the arrow must be issues you can see', 'Make issues of its notes first, or put the issues on the whiteboard as cards.').said('whiteboards.endsNotIssues');
    }
    const [a] = await tx.select().from(issues).where(eq(issues.id, from.issueId));
    const [b] = await tx.select().from(issues).where(eq(issues.id, to.issueId));
    const res = await applyChanges(tx, ctx, a!, { links: [{ phrase, target: b! }], data: { whiteboard: origin } }, { dryRun });
    const link = `${readableId(s, a!)} ${phrase.display} ${readableId(s, b!)}`;
    const made = res.changes.length ? { from: readableId(s, a!), to: readableId(s, b!), relation: phrase.display } : null;
    if (dryRun) throw new DryRun({ link, relation: phrase.display, made: Boolean(made) });
    let seq = 0;
    if (arrow.linked !== phrase.display) {
      seq = Number(board.seq) + 1;
      const [row] = await tx
        .update(whiteboardElements)
        .set({ linked: phrase.display, seq, version: arrow.version + 1, updatedById: ctx.actor.user.id, updatedAt: new Date() })
        .where(and(eq(whiteboardElements.whiteboardId, board.id), eq(whiteboardElements.id, arrow.id)))
        .returning();
      await logChange(tx, ctx, s, board, seq, [row!], [], null);
    }
    return { link, relation: phrase.display, made, seq, activities: res.activities };
  });
  if (out.activities.length) await publishActivities(ctx.app, out.activities);
  if (out.seq) whiteboardLive(ctx.app).changed([boardId], { look: false });
  return out;
}

// ---------------------------------------------------------------------------
// Who's looking
// ---------------------------------------------------------------------------

export async function viewersOf(db: Db, s: SchemaSnapshot, id: string): Promise<WhiteboardViewer[]> {
  const rows = await db
    .select({ userId: whiteboardViewers.userId, since: sql<Date>`min(${whiteboardViewers.since})` })
    .from(whiteboardViewers)
    .where(and(eq(whiteboardViewers.whiteboardId, id), sql`${whiteboardViewers.seenAt} > now() - make_interval(secs => ${VIEWER_SECONDS})`))
    .groupBy(whiteboardViewers.userId);
  return rows
    .flatMap((r) => {
      const u = s.users.get(r.userId);
      return u ? [{ user: userRefDto(u), since: new Date(r.since).toISOString() }] : [];
    })
    .sort((a, b) => a.since.localeCompare(b.since) || a.user.name.localeCompare(b.user.name));
}

/** Someone looks at it, by a stream or a client: in the list from now until they stop, or go quiet. */
export async function markViewing(ctx: Ctx, id: string, session: string): Promise<void> {
  const fresh = await ctx.db
    .insert(whiteboardViewers)
    .values({ whiteboardId: id, session, userId: ctx.actor.user.id })
    .onConflictDoUpdate({ target: [whiteboardViewers.whiteboardId, whiteboardViewers.session], set: { seenAt: sql`now()` } })
    .returning({ since: whiteboardViewers.since, seenAt: whiteboardViewers.seenAt });
  // Rows a crashed instance left behind are let go, now and then, by whoever is still looking.
  await ctx.db.delete(whiteboardViewers).where(sql`${whiteboardViewers.seenAt} < now() - interval '10 minutes'`);
  const row = fresh[0];
  if (row && Math.abs(row.since.getTime() - row.seenAt.getTime()) < 1000) whiteboardLive(ctx.app).changed([id]);
}

export async function stopViewing(ctx: Ctx, id: string, session: string): Promise<void> {
  const gone = await ctx.db
    .delete(whiteboardViewers)
    .where(and(eq(whiteboardViewers.whiteboardId, id), eq(whiteboardViewers.session, session)))
    .returning({ session: whiteboardViewers.session });
  if (gone.length) whiteboardLive(ctx.app).changed([id]);
}

/** Who's looking is for people who sign in (D64), as anything else a guest may not do. */
function requireViewersSeen(ctx: Ctx): void {
  if (!seesViewers(ctx)) throw unauthorized('Sign in to do that', 'Guests can read the projects open to them, and nothing else.').said('access.signInFirst');
}

export async function listViewers(ctx: Ctx, id: string): Promise<WhiteboardViewer[]> {
  requireViewersSeen(ctx);
  const row = await requireWhiteboard(ctx, id);
  return viewersOf(ctx.db, await ctx.app.schema.get(), row.id);
}

/** An API client says it's looking, for the next 45 seconds: one row per token, or per person. */
export async function lookAt(ctx: Ctx, id: string): Promise<WhiteboardViewer[]> {
  requireViewersSeen(ctx);
  const row = await requireWhiteboard(ctx, id);
  await markViewing(ctx, row.id, `api:${ctx.actor.tokenId ?? ctx.actor.user.id}`);
  return viewersOf(ctx.db, await ctx.app.schema.get(), row.id);
}
