/**
 * Imports read from YouTrack's and Jira's APIs (docs/architecture.md, D29): the issues a query
 * there matches, read page by page into the same rows a file's upload fills, so the mapping, the
 * check, the run, running again and undo are the CSV importer's.
 *
 * The token is used for the fetch, and again for the run when files come, and is never kept: it
 * lives in the job's memory while the job works. A fetch that stops (the server restarted, the
 * other tracker went quiet) carries on from its last page when someone gives the token again; each
 * page's rows and the place after it commit together, so carrying on reads nothing twice.
 *
 * Issues and comments only some people may see there are left out: a4a can't tell who they were
 * for, and here they would reach everyone who can see the project.
 */
import type { ApiImportSource, Import, ImportBring, ImportCredentials } from '@a4a/shared';
import { and, asc, eq, gt, sql } from 'drizzle-orm';
import type { Ctx } from '../context';
import type { Db } from '../db/client';
import { importRows, imports, providerLogins, users } from '../db/schema';
import { readerFor, type Reader, type RemotePerson, type StoredOrigin } from '../imports/readers';
import { badRequest, conflict } from '../lib/errors';
import { newId } from '../lib/ids';
import { ColumnTally, contextFor, firstMapping, getImport, loadImport, projectFor, remotePolicy, sourceError, statusOf } from './imports';

const BATCH = 500;
const MAX_ROWS = 50_000;
/** A fetch whose heartbeat is older than this has stopped; while it waits on the other tracker it keeps beating. */
const BEAT_EVERY_MS = 10_000;
const KEYS_SHOWN = 20;
const NAMES = { youtrack: 'YouTrack', jira: 'Jira', github: 'GitHub', redmine: 'Redmine', zendesk: 'Zendesk' } as const;

const fetching = new Map<string, Promise<void>>();

/** For tests: wait for a fetch started here to finish. */
export async function waitForFetch(id: string): Promise<void> {
  await fetching.get(id);
}

/** What a person reads an import from an API as, in the list: where it reads, and which issues. */
function labelOf(origin: StoredOrigin): string {
  return `${NAMES[origin.kind]} ${new URL(origin.url).host}: ${origin.query}`.slice(0, 200);
}

/**
 * People a4a knows by their GitHub login (an administrator's record, or an account they connected,
 * D33 and D46), with the email the mapping finds them by: GitHub names people by login alone.
 */
export async function githubPeople(db: Db): Promise<Map<string, RemotePerson>> {
  const rows = await db
    .select({ login: providerLogins.login, name: users.name, email: users.email })
    .from(providerLogins)
    .innerJoin(users, eq(users.id, providerLogins.userId))
    .where(eq(providerLogins.provider, 'github'));
  return new Map(rows.map((r) => [r.login.toLowerCase(), { name: r.name, login: r.login, email: r.email }]));
}

/** A reader with the credentials given now, its refusals in the API's words. */
async function signIn(ctx: Ctx, origin: StoredOrigin, credentials: ImportCredentials): Promise<{ reader: Reader; account: string | null }> {
  try {
    const known = origin.kind === 'github' ? await githubPeople(ctx.db) : undefined;
    const reader = readerFor(remotePolicy(ctx), origin, credentials, known);
    return { reader, account: await reader.probe() };
  } catch (e) {
    throw sourceError(e);
  }
}

/**
 * Start an import from YouTrack's or Jira's API: the token is tried and the query counted first,
 * so a wrong address, token or query says so at once; then the issues are read as a job, which
 * GET /imports/{id} follows.
 */
export async function importFromApi(
  ctx: Ctx,
  body: { project: string; source: ApiImportSource; url: string; query: string; credentials: ImportCredentials; bring?: Partial<ImportBring> },
): Promise<Import> {
  const project = await projectFor(ctx, body.project);
  if (body.source === 'youtrack' && body.credentials.email) {
    throw badRequest('YouTrack takes a token alone', 'Leave the email empty: a permanent token says whose it is.').said('apiImports.youtrackTokenAlone');
  }
  const origin: StoredOrigin = {
    kind: body.source,
    deployment: body.source === 'jira' ? (body.credentials.email ? 'cloud' : 'datacenter') : null,
    url: body.url,
    query: body.query.trim(),
    account: null,
    bring: { comments: true, work: true, files: true, ...body.bring },
    fetch: { complete: false, cursor: null, issues: 0, comments: 0, work: 0, files: 0, fileBytes: 0, total: null, left: { issues: 0, comments: 0, keys: [] } },
  };
  const { reader, account } = await signIn(ctx, origin, body.credentials);
  origin.url = reader.remote.base.href.replace(/\/$/, '');
  origin.account = account;
  try {
    origin.fetch.total = await reader.count();
  } catch (e) {
    throw sourceError(e);
  }
  if (origin.fetch.total === 0) {
    const hint = { youtrack: 'Check the query, such as project: BACK.', jira: 'Check the JQL, such as project = BACK.', github: 'Check the repository, and state: or label: after it.', redmine: "Check the project's identifier.", zendesk: 'Check the date: since 2026-01-01.' }[origin.kind];
    throw badRequest(`Nothing in ${NAMES[origin.kind]} matches ${origin.query}`, hint).said('apiImports.nothingMatches', { source: NAMES[origin.kind], query: origin.query, kind: origin.kind });
  }
  if (origin.fetch.total !== null && origin.fetch.total > MAX_ROWS) {
    throw badRequest(`${origin.fetch.total.toLocaleString('en')} issues match, more than the ${MAX_ROWS.toLocaleString('en')} one import takes`, 'Narrow the query, and import the rest in another.').said('apiImports.tooManyMatch', { total: origin.fetch.total, max: MAX_ROWS });
  }
  const id = newId();
  await ctx.db.insert(imports).values({
    id,
    projectId: project.id,
    source: origin.kind,
    fileName: labelOf(origin),
    createdById: ctx.actor.user.id,
    status: 'fetching',
    header: [],
    mapping: {},
    origin,
    heartbeatAt: new Date(),
    progressPhase: 'fetching',
    progressDone: 0,
    progressTotal: origin.fetch.total ?? 0,
  });
  start(ctx, id, reader);
  return getImport(ctx, id);
}

/** Carry on a fetch that stopped, with the token again: from its last page, reading nothing twice. */
export async function continueFetch(ctx: Ctx, id: string, credentials: ImportCredentials): Promise<Import> {
  const { row } = await loadImport(ctx, id);
  const origin = row.origin as StoredOrigin | null;
  if (!origin) throw badRequest('This import came from a file', 'Upload the file again to import it afresh.').said('apiImports.cameFromFile');
  if (origin.fetch.complete) throw conflict('Every issue has been read already', `Check the import, then run it. To read the issues afresh, import from ${NAMES[origin.kind]} again.`).said('apiImports.allReadAlready', { source: NAMES[origin.kind] });
  if (statusOf(row) === 'fetching') throw conflict('It is reading the issues already', 'Its progress is on the import.').said('apiImports.readingAlready');
  const { reader, account } = await signIn(ctx, origin, credentials);
  const stale = new Date(Date.now() - 60_000);
  const [claimed] = await ctx.db
    .update(imports)
    .set({ status: 'fetching', heartbeatAt: new Date(), error: null, progressPhase: 'fetching', origin: { ...origin, account: account ?? origin.account } })
    .where(and(eq(imports.id, id), sql`(${imports.status} IN ('failed', 'ready') OR (${imports.status} = 'fetching' AND (${imports.heartbeatAt} IS NULL OR ${imports.heartbeatAt} < ${stale})))`))
    .returning({ id: imports.id });
  if (!claimed) throw conflict('It is reading the issues already', 'Its progress is on the import.').said('apiImports.readingAlready');
  start(ctx, id, reader);
  return getImport(ctx, id);
}

function start(ctx: Ctx, id: string, reader: Reader): void {
  const job = fetchAll(ctx, id, reader).catch(async (e) => {
    const err = sourceError(e) as { message?: string; hint?: string };
    // Never the request itself: its headers hold the token.
    console.error(`import ${id} stopped reading: ${err.message ?? String(e)}`);
    await ctx.app.db
      .update(imports)
      .set({ status: 'failed', error: `It stopped reading: ${err.message ?? String(e)}${err.hint ? ` ${err.hint}` : ''}`, progressPhase: null })
      .where(eq(imports.id, id))
      .catch(() => {});
  });
  fetching.set(id, job);
  job.finally(() => fetching.delete(id)).catch(() => {});
}

/** The keys read so far, from the rows, when carrying on. */
async function keysRead(db: Db, id: string, column: number): Promise<Set<string>> {
  const out = new Set<string>();
  if (column < 0) return out;
  for (let after = 0; ; ) {
    const batch = await db
      .select({ n: importRows.n, cells: importRows.cells })
      .from(importRows)
      .where(and(eq(importRows.importId, id), gt(importRows.n, after)))
      .orderBy(asc(importRows.n))
      .limit(BATCH);
    if (!batch.length) break;
    after = batch[batch.length - 1]!.n;
    for (const r of batch) {
      const key = (r.cells as string[])[column];
      if (key) out.add(key);
    }
  }
  return out;
}

/**
 * The fetch: page after page, each issue a row whose cells line up with the header (a column
 * first seen on a later page joins its end), each page's rows and the place after it committed
 * together. Then the columns are counted and mapped, as an upload's are.
 */
async function fetchAll(ctx: Ctx, id: string, reader: Reader): Promise<void> {
  const [row] = await ctx.db.select().from(imports).where(eq(imports.id, id));
  if (!row) return;
  const origin = structuredClone(row.origin as StoredOrigin);
  const header = [...(row.header as string[])];
  const index = new Map(header.map((h, i) => [h, i]));
  const n = row.rowCount;
  const seen = n ? await keysRead(ctx.db, id, header.indexOf(reader.keyColumn)) : new Set<string>();
  const leftSeen = new Set(origin.fetch.left.keys);
  // A page of fifty issues can take a while (Jira's comments past the first page come one issue at a
  // time, and Retry-After can ask for minutes): the job says it's alive on a timer, not per page.
  const timer = setInterval(() => {
    ctx.db
      .update(imports)
      .set({ heartbeatAt: new Date() })
      .where(and(eq(imports.id, id), eq(imports.status, 'fetching')))
      .catch(() => {});
  }, BEAT_EVERY_MS);
  try {
    await readPages(ctx, id, reader, origin, header, index, seen, leftSeen, n);
  } finally {
    clearInterval(timer);
  }
}

async function readPages(
  ctx: Ctx,
  id: string,
  reader: Reader,
  origin: StoredOrigin,
  header: string[],
  index: Map<string, number>,
  seen: Set<string>,
  leftSeen: Set<string>,
  rowsBefore: number,
): Promise<void> {
  let n = rowsBefore;
  let cursor = n ? reader.resumeFrom(origin.fetch.cursor) : null;
  for (;;) {
    const page = await reader.page(cursor);
    const rows: (typeof importRows.$inferInsert)[] = [];
    for (const issue of page.issues) {
      if (seen.has(issue.key)) continue;
      seen.add(issue.key);
      if (issue.restricted) {
        if (!leftSeen.has(issue.key)) {
          leftSeen.add(issue.key);
          origin.fetch.left.issues++;
          if (origin.fetch.left.keys.length < KEYS_SHOWN) origin.fetch.left.keys.push(issue.key);
        }
        continue;
      }
      if (n >= MAX_ROWS) throw badRequest(`The query matches more than the ${MAX_ROWS.toLocaleString('en')} issues one import takes`, 'Narrow the query, and import the rest in another.').said('apiImports.queryTooBig', { max: MAX_ROWS });
      const cells: string[] = [];
      for (const [name, value] of issue.cells) {
        let i = index.get(name);
        if (i === undefined) {
          i = header.length;
          header.push(name);
          index.set(name, i);
        }
        cells[i] = value;
      }
      n++;
      rows.push({ importId: id, n, cells: Array.from({ length: header.length }, (_, i) => cells[i] ?? ''), extra: issue.extra });
      origin.fetch.issues++;
      origin.fetch.comments += issue.extra.comments.length;
      origin.fetch.work += issue.extra.work.length;
      origin.fetch.files += issue.extra.files.length;
      origin.fetch.fileBytes += issue.extra.files.reduce((s, f) => s + f.size, 0);
      origin.fetch.left.comments += issue.extra.leftComments;
    }
    origin.fetch.cursor = page.next;
    await ctx.db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      for (let i = 0; i < rows.length; i += BATCH) await tx.insert(importRows).values(rows.slice(i, i + BATCH));
      await tx
        .update(imports)
        .set({ header, rowCount: n, origin, heartbeatAt: new Date(), progressPhase: 'fetching', progressDone: n, progressTotal: Math.max(origin.fetch.total ?? 0, n) })
        .where(eq(imports.id, id));
    });
    if (!page.next) break;
    cursor = page.next;
  }
  origin.fetch.complete = true;
  await finish(ctx, id, header, origin, n);
}

/** Every issue read: count the columns, map them as an upload's are, and say what was left out. */
async function finish(ctx: Ctx, id: string, header: string[], origin: StoredOrigin, rowCount: number): Promise<void> {
  const name = NAMES[origin.kind];
  const left = origin.fetch.left;
  if (!rowCount) {
    await ctx.db
      .update(imports)
      .set({
        status: 'failed',
        origin,
        progressPhase: null,
        error: left.issues
          ? `Every issue that matches is for only some people to see in ${name}, so none is imported.`
          : `Nothing in ${name} matches ${origin.query} any more.`,
      })
      .where(eq(imports.id, id));
    return;
  }
  const tally = new ColumnTally(header.length);
  for (let after = 0; ; ) {
    const batch = await ctx.db
      .select({ n: importRows.n, cells: importRows.cells })
      .from(importRows)
      .where(and(eq(importRows.importId, id), gt(importRows.n, after)))
      .orderBy(asc(importRows.n))
      .limit(BATCH);
    if (!batch.length) break;
    after = batch[batch.length - 1]!.n;
    for (const r of batch) tally.add(r.cells as string[]);
  }
  const { project } = await loadImport(ctx, id);
  const c = await contextFor(ctx, project);
  const notes: string[] = [];
  if (left.issues) {
    notes.push(
      `${left.issues} ${left.issues === 1 ? 'issue is' : 'issues are'} for only some people to see in ${name}, so ${left.issues === 1 ? 'it is' : 'they are'} left out: ${left.keys.join(', ')}${left.issues > left.keys.length ? ' and more' : ''}.`,
    );
  }
  if (left.comments) notes.push(`${left.comments} ${left.comments === 1 ? 'comment is' : 'comments are'} for only some people to see in ${name}, so ${left.comments === 1 ? 'it is' : 'they are'} left out.`);
  const mapping = firstMapping(c, header, tally.done(), notes);
  // A row read since the header grew is as wide as the header; earlier ones are shorter, and read as empty past their end.
  await ctx.db.update(imports).set({ mapping, origin, status: 'ready', progressPhase: null, progressDone: rowCount, progressTotal: rowCount, heartbeatAt: new Date() }).where(eq(imports.id, id));
}

