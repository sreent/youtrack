/**
 * Apps (docs/architecture.md, D48): extensions an administrator installs from a package or a
 * catalog, which add widgets to a4a's pages, handlers to its API and rules to its workflows, within
 * what the administrator granted.
 *
 * - Installing, updating and removing is a person's decision, made signed in: never a token's, an
 *   agent's or MCP's. The administrator accepts what it asks for, exactly; an update asks again
 *   only for what it adds.
 * - An app runs where it's enabled: everywhere, or in the projects chosen, less those whose managers
 *   turned it off. Its rules act only there, as its agent; its widgets show only there; its handlers
 *   answer only about issues and projects there.
 * - Its files are served from addresses a4a signs for a while (fileToken), with a strict content
 *   security policy and a sandbox of their own, so a widget is never a4a's page.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  APP_PERMISSION_WORDS,
  type App,
  type AppExtension,
  type AppExtensionPoint,
  type AppHandlerResult,
  type AppPackagePreview,
  type AppPermissions,
  type AppRemoval,
  type AppRun,
  type AppSettingDef,
  type AppSettings,
  type AppStorage,
  type CatalogList,
  type ProjectApp,
} from '@a4a/shared';
import { and, asc, count, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { requireScope, type AppServices, type Ctx } from '../context';
import type { Db } from '../db/client';
import { appFiles, appProjects, appRuns, appSettings, apps, appStorage, comments, ruleRuns, rules, users, workItems } from '../db/schema';
import { publishActivities } from '../events/activity';
import { AppError, badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { newId } from '../lib/ids';
import { open, seal, secretKey } from '../lib/secret-box';
import { checkSignature, downloadPackage, entryOf, readCatalog } from '../apps/catalog';
import { granted, throughApp } from '../apps/actor';
import { beyond, describe, isEmpty, newerVersion, readPackage, samePermissions, type Manifest, type ManifestRule, type ReadPackage } from '../apps/package';
import { checkScript, runScript } from '../workflow/sandbox';
import { changeOf, scriptInput } from '../workflow/script-issue';
import { applyPlanned, plannedChanges } from '../workflow/scripts';
import { nextRunAfter } from '../workflow/words';
import { accessChanged, projectAccess, requireProject } from './access';
import { getArticle } from './articles';
import { readableId } from './issue-refs';
import { resolveIssue, type IssueRow } from './issues';
import { appEnabledIn, appProjectIds, type AppRow, type SchemaSnapshot } from './schema-cache';
import { insertUser } from './users';
import { userRefDto } from './values';

type AppDbRow = typeof apps.$inferSelect;

/** How long a widget's file address works: a page open longer asks for new ones. */
const FILE_TOKEN_SECONDS = 12 * 3600;
/** What an app may keep, per app or per project, as JSON characters. */
export const STORAGE_LIMIT_BYTES = 1024 * 1024;
const STORAGE_VALUE_BYTES = 64 * 1024;
const STORAGE_KEYS = 1000;
const RUNS_KEPT = 200;

const keySource = (app: AppServices) => ({ secretKey: app.config.secretKey, dataDir: app.config.dataDir });

// ---------------------------------------------------------------------------
// Words, and who may
// ---------------------------------------------------------------------------

/** What permissions let an app do, as its consent says it. */
export function permissionWords(p: AppPermissions): string[] {
  return [...p.read.map((r) => APP_PERMISSION_WORDS.read[r]), ...p.write.map((r) => APP_PERMISSION_WORDS.write[r])];
}

/** Installing, updating and removing an app is a person's decision, made signed in as an administrator. */
function requirePerson(ctx: Ctx): void {
  requireScope(ctx, 'admin');
  if (ctx.actor.user.isBot || ctx.actor.authMethod === 'token' || ctx.actor.channel === 'mcp' || ctx.actor.app) {
    throw forbidden('Installing, updating or removing an app is a person’s decision, made signed in', 'Sign in to a4a as an administrator, and do it under Administration → Apps.').said('apps.personsDecision');
  }
}

const decode = (base64: string): Buffer => {
  const clean = base64.replace(/^data:[^,]*,/, '').trim();
  if (!/^[A-Za-z0-9+/=\s_-]+$/.test(clean)) throw badRequest("The package isn't base64", 'Send the zip, base64-encoded, as "package".').said('apps.notBase64');
  return Buffer.from(clean, 'base64');
};

function permissionsOf(v: unknown): AppPermissions {
  const o = (v ?? {}) as { read?: string[]; write?: string[] };
  return { read: (o.read ?? []) as AppPermissions['read'], write: (o.write ?? []) as AppPermissions['write'] };
}

function manifestOf(row: AppDbRow): Manifest {
  return row.manifest as Manifest;
}

async function rowByName(db: Db, name: string): Promise<AppDbRow | undefined> {
  const [row] = await db.select().from(apps).where(eq(apps.name, name.trim().toLowerCase()));
  return row;
}

async function requireApp(ctx: Ctx, name: string): Promise<AppDbRow> {
  const row = await rowByName(ctx.db, name);
  if (!row) throw notFound(`App ${name}`, 'See the apps installed under Administration → Apps.').said('apps.notInstalled', { name });
  return row;
}

function snapshotApp(s: SchemaSnapshot, id: string): AppRow {
  const a = s.apps.get(id);
  if (!a) throw notFound('App').said('notFound.appUnnamed');
  return a;
}

// ---------------------------------------------------------------------------
// What an administrator sees
// ---------------------------------------------------------------------------

async function appDto(ctx: Ctx, row: AppDbRow): Promise<App> {
  const s = await ctx.app.schema.get();
  const m = manifestOf(row);
  const a = s.apps.get(row.id);
  const projectRows = await ctx.db.select().from(appProjects).where(eq(appProjects.appId, row.id));
  const ruleRows = await ctx.db.select({ id: rules.id, name: rules.name, enabled: rules.enabled, lastRunAt: rules.lastRunAt }).from(rules).where(eq(rules.appId, row.id)).orderBy(asc(rules.createdAt));
  const agent = s.users.get(row.agentId);
  const installer = row.installedById ? s.users.get(row.installedById) : undefined;
  const source = row.source as { kind: 'upload' | 'catalog'; catalog?: string };
  const g = permissionsOf(row.granted);
  return {
    name: row.name,
    title: row.title,
    version: row.version,
    vendor: row.vendor,
    description: row.description,
    iconUrl: m.icon ? fileUrl(ctx.app, row, m.icon) : null,
    enabled: row.enabled,
    allProjects: row.allProjects,
    projects: projectRows
      .map((r) => ({ r, p: s.projects.get(r.projectId) }))
      .filter((x) => x.p)
      .map(({ r, p }) => ({ key: p!.key, name: p!.name, enabled: a ? appEnabledIn(a, p!.id) : false, off: r.off }))
      .sort((x, y) => x.key.localeCompare(y.key)),
    granted: g,
    words: permissionWords(g),
    widgets: m.widgets.map((w) => ({ name: w.name, title: w.title, uses: w.uses, at: w.at, height: w.height })),
    handlers: m.handlers.map((h) => ({ name: h.name, title: h.title, uses: h.uses })),
    rules: ruleRows.map((r) => ({ id: r.id, name: r.name, enabled: r.enabled, lastRunAt: r.lastRunAt?.toISOString() ?? null })),
    settings: m.settings,
    source: { kind: source.kind, catalog: source.catalog ?? null },
    sha256: row.sha256,
    agent: agent ? userRefDto(agent) : { id: row.agentId, login: `app-${row.name}`, name: row.title, avatarColor: '#888888', isBot: true },
    installedBy: installer ? userRefDto(installer) : null,
    installedAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listApps(ctx: Ctx): Promise<App[]> {
  requireScope(ctx, 'admin');
  const rows = await ctx.db.select().from(apps).orderBy(asc(apps.name));
  return Promise.all(rows.map((r) => appDto(ctx, r)));
}

export async function getApp(ctx: Ctx, name: string): Promise<App> {
  requireScope(ctx, 'admin');
  return appDto(ctx, await requireApp(ctx, name));
}

function previewOf(pkg: ReadPackage, installed: AppDbRow | undefined, signedBy: string | null): AppPackagePreview {
  const m = pkg.manifest;
  const g = installed ? permissionsOf(installed.granted) : null;
  return {
    name: m.name,
    title: m.title,
    version: m.version,
    vendor: m.vendor,
    description: m.description,
    sha256: pkg.sha256,
    bytes: pkg.bytes,
    files: pkg.files.length,
    asks: m.permissions,
    words: permissionWords(m.permissions),
    widgets: m.widgets.map((w) => ({ name: w.name, title: w.title, uses: w.uses, at: w.at, height: w.height })),
    handlers: m.handlers.map((h) => ({ name: h.name, title: h.title, uses: h.uses })),
    rules: m.rules.map((r) => ({ name: r.name, title: r.title, uses: r.uses, kind: r.kind })),
    settings: m.settings,
    signedBy,
    installed: installed && g ? { version: installed.version, granted: g } : null,
    more: g ? beyond(m.permissions, g) : null,
  };
}

/** Read a package and check its scripts compile: what it is and asks for, before anything is kept. */
async function readChecked(app: AppServices, bytes: Buffer): Promise<ReadPackage> {
  const pkg = readPackage(bytes, app.config.appMaxBytes);
  const scripts = [...pkg.manifest.handlers.map((h) => ({ what: `The handler "${h.name}"`, file: h.file })), ...pkg.manifest.rules.map((r) => ({ what: `The rule "${r.name}"`, file: r.file }))];
  for (const sc of scripts) {
    const source = pkg.files.find((f) => f.path === sc.file)!.content.toString('utf8');
    const problems = await checkScript(source);
    if (problems.length) throw badRequest(`${sc.what}'s script doesn't compile: ${problems[0]!.message}`, `Fix ${sc.file}, and package the app again.`).said('apps.scriptDoesNotCompile', { what: sc.what, message: problems[0]!.message, file: sc.file });
  }
  return pkg;
}

export async function previewPackage(ctx: Ctx, base64: string): Promise<AppPackagePreview> {
  requirePerson(ctx);
  const pkg = await readChecked(ctx.app, decode(base64));
  return previewOf(pkg, await rowByName(ctx.db, pkg.manifest.name), null);
}

// ---------------------------------------------------------------------------
// Installing and updating
// ---------------------------------------------------------------------------

async function projectIdsOf(ctx: Ctx, keys: string[] | undefined): Promise<string[]> {
  const ids: string[] = [];
  for (const key of keys ?? []) ids.push((await requireProject(ctx, key)).id);
  return [...new Set(ids)];
}

function ruleValues(row: { id: string; title: string }, r: ManifestRule, source: string, by: string) {
  return {
    id: newId(),
    projectId: null,
    name: `${row.title}: ${r.title}`.slice(0, 120),
    kind: r.kind,
    trigger: r.on,
    triggerField: r.field,
    schedule: r.schedule,
    query: r.query,
    command: '',
    script: source,
    appId: row.id,
    enabled: true,
    nextRunAt: r.schedule ? nextRunAfter(r.schedule, new Date()) : null,
    createdById: by,
    updatedById: by,
  };
}

async function writeFiles(tx: Db, appId: string, pkg: ReadPackage): Promise<void> {
  await tx.delete(appFiles).where(eq(appFiles.appId, appId));
  for (const f of pkg.files) await tx.insert(appFiles).values({ appId, path: f.path, contentType: f.contentType, content: f.content });
}

async function writeRules(tx: Db, row: { id: string; title: string }, pkg: ReadPackage, by: string): Promise<void> {
  await tx.delete(rules).where(eq(rules.appId, row.id));
  for (const r of pkg.manifest.rules) {
    const source = pkg.files.find((f) => f.path === r.file)!.content.toString('utf8');
    await tx.insert(rules).values(ruleValues(row, r, source, by));
  }
}

function changed(app: AppServices): void {
  app.schema.invalidate();
  accessChanged(app);
}

async function install(ctx: Ctx, pkg: ReadPackage, input: { accept: AppPermissions; allProjects?: boolean; projects?: string[] }, source: Record<string, unknown>): Promise<App> {
  const m = pkg.manifest;
  if (await rowByName(ctx.db, m.name)) throw conflict(`${m.title} is installed already`, 'Update it instead: a4a asks again only for what the new version adds.').said('apps.installedAlready', { title: m.title });
  if (!samePermissions(input.accept, m.permissions)) {
    throw badRequest("What you accept isn't what it asks for", `It asks for: ${describe(m.permissions).join('; ') || 'nothing'}. Accept exactly that, or don't install it.`).said('apps.acceptWhatItAsks', { asks: describe(m.permissions).join('; ') || 'nothing' });
  }
  const chosen = await projectIdsOf(ctx, input.projects);
  const login = `app-${m.name}`;
  const s = await ctx.app.schema.get();
  if (s.usersByLogin.get(login)) throw conflict(`The login ${login} is taken, and it's what ${m.title}'s agent would be called`, `Rename the account called ${login}, then install it.`).said('apps.agentLoginTaken', { login, title: m.title });
  const id = newId();
  await ctx.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const agent = await insertUser(tx, { login, name: m.title, role: 'member', isBot: true, capacityHoursPerDay: 0 });
    await tx.insert(apps).values({
      id,
      name: m.name,
      title: m.title,
      version: m.version,
      vendor: m.vendor,
      description: m.description,
      manifest: m,
      granted: m.permissions,
      sha256: pkg.sha256,
      source,
      agentId: agent.id,
      enabled: true,
      allProjects: input.allProjects ?? false,
      installedById: ctx.actor.user.id,
    });
    await writeFiles(tx, id, pkg);
    for (const projectId of chosen) await tx.insert(appProjects).values({ appId: id, projectId, chosen: true });
    await writeRules(tx, { id, title: m.title }, pkg, ctx.actor.user.id);
  });
  changed(ctx.app);
  return appDto(ctx, (await rowByName(ctx.db, m.name))!);
}

export async function installPackage(ctx: Ctx, input: { package: string; accept: AppPermissions; allProjects?: boolean; projects?: string[] }): Promise<App> {
  requirePerson(ctx);
  const pkg = await readChecked(ctx.app, decode(input.package));
  return install(ctx, pkg, input, { kind: 'upload' });
}

async function update(ctx: Ctx, row: AppDbRow, pkg: ReadPackage, accept: AppPermissions | undefined, source: Record<string, unknown>): Promise<App> {
  const m = pkg.manifest;
  if (m.name !== row.name) throw badRequest(`This package is ${m.name}, not ${row.name}`, `Update ${row.title} with a package of its own.`).said('apps.otherPackage', { name: m.name, name2: row.name, title: row.title });
  if (pkg.sha256 === row.sha256) throw conflict(`${row.title} ${row.version} is installed from this very package`, 'Nothing to update.').said('apps.samePackage', { title: row.title, version: row.version });
  if (!newerVersion(m.version, row.version)) throw badRequest(`${row.title} ${row.version} is installed, and this is ${m.version}`, 'Install a newer version, or remove it first to go back to an older one.').said('apps.olderVersion', { title: row.title, version: row.version, version2: m.version });
  const more = beyond(m.permissions, permissionsOf(row.granted));
  if (!isEmpty(more) && !(accept && samePermissions(accept, m.permissions))) {
    throw new AppError(409, 'consent_required', `${m.title} ${m.version} asks for more: ${describe(more).join('; ')}`, 'Accept all it asks for now, or keep the version installed.', {
      asks: m.permissions,
      more,
    }).said('apps.asksForMore', { title: m.title, version: m.version, more: describe(more).join('; ') });
  }
  await ctx.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    await tx
      .update(apps)
      .set({ title: m.title, version: m.version, vendor: m.vendor, description: m.description, manifest: m, granted: m.permissions, sha256: pkg.sha256, source, updatedAt: new Date() })
      .where(eq(apps.id, row.id));
    await tx.update(users).set({ name: m.title }).where(eq(users.id, row.agentId));
    await writeFiles(tx, row.id, pkg);
    await writeRules(tx, { id: row.id, title: m.title }, pkg, ctx.actor.user.id);
  });
  changed(ctx.app);
  return appDto(ctx, (await rowByName(ctx.db, row.name))!);
}

export async function updatePackage(ctx: Ctx, name: string, input: { package: string; accept?: AppPermissions }): Promise<App> {
  requirePerson(ctx);
  const row = await requireApp(ctx, name);
  const pkg = await readChecked(ctx.app, decode(input.package));
  return update(ctx, row, pkg, input.accept, { kind: 'upload' });
}

// ---------------------------------------------------------------------------
// Catalogs
// ---------------------------------------------------------------------------

export async function listCatalog(ctx: Ctx): Promise<CatalogList> {
  requireScope(ctx, 'admin');
  const installed = new Map((await ctx.db.select({ name: apps.name, version: apps.version }).from(apps)).map((r) => [r.name, r.version]));
  const out: CatalogList = { apps: [], problems: [] };
  for (const url of ctx.app.config.appCatalogs) {
    try {
      const c = await readCatalog(ctx.app.config, url);
      const newest = new Map<string, (typeof c.apps)[number]>();
      for (const a of c.apps) {
        const best = newest.get(a.name);
        if (!best || newerVersion(a.version, best.version)) newest.set(a.name, a);
      }
      for (const a of newest.values()) {
        const have = installed.get(a.name) ?? null;
        out.apps.push({
          catalog: url,
          catalogName: c.name,
          name: a.name,
          title: a.title,
          version: a.version,
          vendor: a.vendor,
          description: a.description,
          sha256: a.sha256,
          signed: Boolean(a.signature),
          installed: have,
          update: have !== null && newerVersion(a.version, have),
        });
      }
    } catch (e) {
      out.problems.push({ catalog: url, message: e instanceof Error ? e.message : String(e) });
    }
  }
  out.apps.sort((a, b) => a.title.localeCompare(b.title));
  return out;
}

async function fromCatalog(ctx: Ctx, pick: { catalog: string; name: string; version?: string }) {
  const catalog = await readCatalog(ctx.app.config, pick.catalog);
  const entry = entryOf(catalog, pick.name, pick.version, newerVersion);
  const signedBy = checkSignature(ctx.app.config, catalog, entry);
  const bytes = await downloadPackage(ctx.app.config, catalog, entry);
  const pkg = await readChecked(ctx.app, bytes);
  if (pkg.manifest.name !== entry.name || pkg.manifest.version !== entry.version) {
    throw badRequest(`The catalog lists ${entry.name} ${entry.version}, and its package is ${pkg.manifest.name} ${pkg.manifest.version}`, 'Tell whoever keeps the catalog: install nothing from it until it agrees.').said('apps.catalogDisagrees', { name: entry.name, version: entry.version, name2: pkg.manifest.name, version2: pkg.manifest.version });
  }
  return { pkg, signedBy, source: { kind: 'catalog', catalog: catalog.url, url: new URL(entry.url, catalog.url).href } };
}

export async function previewFromCatalog(ctx: Ctx, pick: { catalog: string; name: string; version?: string }): Promise<AppPackagePreview> {
  requirePerson(ctx);
  const { pkg, signedBy } = await fromCatalog(ctx, pick);
  return previewOf(pkg, await rowByName(ctx.db, pkg.manifest.name), signedBy);
}

/** Install an app from a catalog, or update the one installed to the version picked. */
export async function installFromCatalog(
  ctx: Ctx,
  input: { catalog: string; name: string; version?: string; accept?: AppPermissions; allProjects?: boolean; projects?: string[] },
): Promise<App> {
  requirePerson(ctx);
  const { pkg, source } = await fromCatalog(ctx, input);
  const row = await rowByName(ctx.db, pkg.manifest.name);
  if (row) return update(ctx, row, pkg, input.accept, source);
  if (!input.accept) throw badRequest('Say what you accept', `It asks for: ${describe(pkg.manifest.permissions).join('; ') || 'nothing'}.`).said('apps.sayWhatYouAccept', { asks: describe(pkg.manifest.permissions).join('; ') || 'nothing' });
  return install(ctx, pkg, { accept: input.accept, allProjects: input.allProjects, projects: input.projects }, source);
}

// ---------------------------------------------------------------------------
// Where it runs
// ---------------------------------------------------------------------------

export async function updateApp(ctx: Ctx, name: string, input: { enabled?: boolean; allProjects?: boolean; projects?: string[] }): Promise<App> {
  requireScope(ctx, 'admin');
  const row = await requireApp(ctx, name);
  const chosen = input.projects ? await projectIdsOf(ctx, input.projects) : null;
  await ctx.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    await tx
      .update(apps)
      .set({ ...(input.enabled !== undefined ? { enabled: input.enabled } : {}), ...(input.allProjects !== undefined ? { allProjects: input.allProjects } : {}), updatedAt: new Date() })
      .where(eq(apps.id, row.id));
    if (chosen) {
      const rows = await tx.select().from(appProjects).where(eq(appProjects.appId, row.id));
      for (const r of rows) {
        const want = chosen.includes(r.projectId);
        if (want !== r.chosen) await tx.update(appProjects).set({ chosen: want, updatedAt: new Date() }).where(and(eq(appProjects.appId, row.id), eq(appProjects.projectId, r.projectId)));
      }
      for (const id of chosen.filter((p) => !rows.some((r) => r.projectId === p))) await tx.insert(appProjects).values({ appId: row.id, projectId: id, chosen: true });
      // A row neither chosen nor turned off says nothing.
      await tx.delete(appProjects).where(and(eq(appProjects.appId, row.id), eq(appProjects.chosen, false), eq(appProjects.off, false)));
    }
  });
  changed(ctx.app);
  return appDto(ctx, (await requireApp(ctx, name))!);
}

function projectAppDto(s: SchemaSnapshot, row: AppDbRow, projectId: string): ProjectApp {
  const a = snapshotApp(s, row.id);
  const m = manifestOf(row);
  return {
    name: row.name,
    title: row.title,
    version: row.version,
    description: row.description,
    enabled: appEnabledIn(a, projectId),
    off: a.off.has(projectId),
    words: permissionWords(permissionsOf(row.granted)),
    settings: m.settings.filter((d) => d.scope === 'project'),
  };
}

/** The apps chosen for a project (or for every project), for its managers. */
export async function projectApps(ctx: Ctx, key: string): Promise<ProjectApp[]> {
  const project = await requireProject(ctx, key, 'manage');
  const s = await ctx.app.schema.get();
  const rows = await ctx.db.select().from(apps).orderBy(asc(apps.name));
  return rows
    .filter((r) => {
      const a = s.apps.get(r.id);
      return a && a.enabled && (a.allProjects || a.chosen.has(project.id));
    })
    .map((r) => projectAppDto(s, r, project.id));
}

/** A project's managers turn an app off in it, or back on: never on where an administrator didn't choose it. */
export async function setProjectApp(ctx: Ctx, key: string, name: string, on: boolean): Promise<ProjectApp> {
  requireScope(ctx, 'write');
  const project = await requireProject(ctx, key, 'manage');
  const row = await requireApp(ctx, name);
  const s = await ctx.app.schema.get();
  const a = snapshotApp(s, row.id);
  if (!a.enabled || !(a.allProjects || a.chosen.has(project.id))) throw notFound(`App ${name}`, `It isn't chosen for ${project.key}: an administrator chooses where an app runs.`).said('apps.notChosenFor', { name, key: project.key });
  const [existing] = await ctx.db.select().from(appProjects).where(and(eq(appProjects.appId, row.id), eq(appProjects.projectId, project.id)));
  if (existing) await ctx.db.update(appProjects).set({ off: !on, updatedAt: new Date() }).where(and(eq(appProjects.appId, row.id), eq(appProjects.projectId, project.id)));
  else await ctx.db.insert(appProjects).values({ appId: row.id, projectId: project.id, chosen: false, off: !on });
  if (on && existing && !existing.chosen) await ctx.db.delete(appProjects).where(and(eq(appProjects.appId, row.id), eq(appProjects.projectId, project.id), eq(appProjects.chosen, false)));
  changed(ctx.app);
  return projectAppDto(await ctx.app.schema.get(), row, project.id);
}

// ---------------------------------------------------------------------------
// Removing
// ---------------------------------------------------------------------------

export async function appRemoval(ctx: Ctx, name: string): Promise<AppRemoval> {
  requireScope(ctx, 'admin');
  const row = await requireApp(ctx, name);
  const m = manifestOf(row);
  const n = async (table: typeof rules | typeof appSettings | typeof appStorage | typeof appRuns) =>
    Number((await ctx.db.select({ n: count() }).from(table).where(eq(table.appId, row.id)))[0]?.n ?? 0);
  const settingRows = await ctx.db.select({ values: appSettings.values }).from(appSettings).where(eq(appSettings.appId, row.id));
  const ruleIds = (await ctx.db.select({ id: rules.id }).from(rules).where(eq(rules.appId, row.id))).map((r) => r.id);
  const ruleRunCount = ruleIds.length ? Number((await ctx.db.select({ n: count() }).from(ruleRuns).where(inArray(ruleRuns.ruleId, ruleIds)))[0]?.n ?? 0) : 0;
  const s = await ctx.app.schema.get();
  return {
    name: row.name,
    title: row.title,
    rules: await n(rules),
    widgets: m.widgets.length,
    handlers: m.handlers.length,
    settings: settingRows.reduce((sum, r) => sum + Object.keys((r.values ?? {}) as object).length, 0),
    stored: await n(appStorage),
    runs: (await n(appRuns)) + ruleRunCount,
    agent: s.users.get(row.agentId)?.login ?? `app-${row.name}`,
  };
}

/** Remove an app and all it brought: its rules, files, settings, storage, runs and agent. */
export async function removeApp(ctx: Ctx, name: string): Promise<void> {
  requirePerson(ctx);
  const row = await requireApp(ctx, name);
  await ctx.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    await tx.delete(apps).where(eq(apps.id, row.id));
    // Its agent goes too, unless history names it (what its rules did): then it stays, banned, so
    // that history still says who.
    try {
      await tx.transaction(async (inner) => {
        await (inner as unknown as Db).delete(users).where(eq(users.id, row.agentId));
      });
    } catch {
      await tx.update(users).set({ banned: true }).where(eq(users.id, row.agentId));
    }
  });
  changed(ctx.app);
}

export async function listAppRuns(ctx: Ctx, name: string): Promise<AppRun[]> {
  requireScope(ctx, 'admin');
  const row = await requireApp(ctx, name);
  const s = await ctx.app.schema.get();
  const handlerRows = await ctx.db.select().from(appRuns).where(eq(appRuns.appId, row.id)).orderBy(desc(appRuns.id)).limit(100);
  const ruleRows = await ctx.db
    .select({ id: ruleRuns.id, rule: rules.name, outcome: ruleRuns.outcome, message: ruleRuns.message, issueKey: ruleRuns.issueKey, actorId: ruleRuns.actorId, at: ruleRuns.createdAt })
    .from(ruleRuns)
    .innerJoin(rules, eq(rules.id, ruleRuns.ruleId))
    .where(eq(rules.appId, row.id))
    .orderBy(desc(ruleRuns.id))
    .limit(100);
  const who = (id: string | null) => {
    const u = id ? s.users.get(id) : undefined;
    return u ? userRefDto(u) : null;
  };
  return [
    ...handlerRows.map((r) => ({ id: `h${r.id}`, kind: 'handler' as const, name: r.handler, outcome: r.outcome, message: r.message, ms: r.ms, issue: r.issueKey, by: who(r.actorId), at: r.createdAt.toISOString() })),
    ...ruleRows.map((r) => ({ id: `r${r.id}`, kind: 'rule' as const, name: r.rule, outcome: r.outcome, message: r.message, ms: null, issue: r.issueKey, by: who(r.actorId), at: r.at.toISOString() })),
  ]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 100);
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

async function settingsRow(db: Db, appId: string, projectId: string | null) {
  const [row] = await db
    .select()
    .from(appSettings)
    .where(and(eq(appSettings.appId, appId), projectId ? eq(appSettings.projectId, projectId) : isNull(appSettings.projectId)));
  return row;
}

/** Who may read and change an app's settings: administrators its own, a project's managers the project's. */
async function settingsScope(ctx: Ctx, row: AppDbRow, project: string | null | undefined): Promise<string | null> {
  if (!project) {
    requireScope(ctx, 'admin');
    return null;
  }
  const p = await requireProject(ctx, project, 'manage');
  const a = snapshotApp(await ctx.app.schema.get(), row.id);
  if (!appEnabledIn(a, p.id) && !(a.allProjects || a.chosen.has(p.id))) throw notFound(`App ${row.name}`, `It isn't chosen for ${p.key}.`).said('apps.notChosenForProject', { name: row.name, key: p.key });
  return p.id;
}

function shownSettings(defs: AppSettingDef[], values: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const d of defs) {
    const v = values[d.name];
    out[d.name] = d.type === 'secret' ? { set: typeof v === 'string' && v !== '' } : v === undefined ? d.default : v;
  }
  return out;
}

export async function getAppSettings(ctx: Ctx, name: string, project?: string | null): Promise<AppSettings> {
  const row = await requireApp(ctx, name);
  const projectId = await settingsScope(ctx, row, project);
  const defs = manifestOf(row).settings.filter((d) => d.scope === (projectId ? 'project' : 'app'));
  const stored = (await settingsRow(ctx.db, row.id, projectId))?.values as Record<string, unknown> | undefined;
  return { project: project ?? null, values: shownSettings(defs, stored ?? {}) };
}

export async function setAppSettings(ctx: Ctx, name: string, input: { project?: string | null; values: Record<string, string | number | boolean | null> }): Promise<AppSettings> {
  requireScope(ctx, 'write');
  const row = await requireApp(ctx, name);
  const projectId = await settingsScope(ctx, row, input.project);
  const defs = manifestOf(row).settings.filter((d) => d.scope === (projectId ? 'project' : 'app'));
  const existing = await settingsRow(ctx.db, row.id, projectId);
  const values = { ...((existing?.values ?? {}) as Record<string, unknown>) };
  for (const [k, v] of Object.entries(input.values)) {
    const d = defs.find((x) => x.name === k);
    if (!d) throw badRequest(`${row.title} has no ${projectId ? "project's " : ''}setting called ${k}`, `Its settings here: ${defs.map((x) => x.name).join(', ') || 'none'}.`).said('apps.noSuchSetting', { title: row.title, scope: projectId ? 'project' : 'app', k, count: defs.length, names: defs.map((x) => x.name).join(', ') });
    if (v === null || v === '') {
      delete values[k];
      continue;
    }
    if (d.type === 'number' && typeof v !== 'number') throw badRequest(`${d.title} is a number`, 'Give it as a number.').said('apps.settingIsNumber', { title: d.title });
    if (d.type === 'boolean' && typeof v !== 'boolean') throw badRequest(`${d.title} is yes or no`, 'Give it as true or false.').said('apps.settingIsYesNo', { title: d.title });
    if ((d.type === 'text' || d.type === 'secret' || d.type === 'choice') && typeof v !== 'string') throw badRequest(`${d.title} is text`, 'Give it as text.').said('apps.settingIsText', { title: d.title });
    if (d.type === 'choice' && !d.choices?.includes(v as string)) throw badRequest(`${d.title} is one of ${d.choices?.join(', ')}`, 'Pick one of them.').said('apps.settingIsChoice', { title: d.title, choices: String(d.choices?.join(', ')) });
    if (typeof v === 'string' && v.length > 2000) throw badRequest(`${d.title} is too long`, 'Keep it to 2000 characters.').said('apps.settingTooLong', { title: d.title });
    // A secret is kept sealed, and never sent back (D38's secret box).
    values[k] = d.type === 'secret' ? seal(keySource(ctx.app), v as string) : v;
  }
  if (existing) await ctx.db.update(appSettings).set({ values, updatedAt: new Date() }).where(eq(appSettings.id, existing.id));
  else await ctx.db.insert(appSettings).values({ id: newId(), appId: row.id, projectId, values });
  return { project: input.project ?? null, values: shownSettings(defs, values) };
}

/** Its settings as a handler reads them: its own, then the project's over them, secrets opened. */
async function settingsForRun(app: AppServices, row: AppDbRow, projectId: string | null): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const defs = manifestOf(row).settings;
  const own = ((await settingsRow(app.db, row.id, null))?.values ?? {}) as Record<string, unknown>;
  const theirs = projectId ? (((await settingsRow(app.db, row.id, projectId))?.values ?? {}) as Record<string, unknown>) : {};
  for (const d of defs) {
    const v = d.scope === 'project' ? theirs[d.name] : own[d.name];
    if (v === undefined) out[d.name] = d.default;
    else out[d.name] = d.type === 'secret' && typeof v === 'string' ? open(keySource(app), v) : v;
  }
  return out;
}

/** An app's settings as its rules read them, in a project (D48). */
export async function settingsForRule(app: AppServices, appId: string, projectId: string): Promise<Record<string, unknown>> {
  const [row] = await app.db.select().from(apps).where(eq(apps.id, appId));
  return row ? settingsForRun(app, row, projectId) : {};
}

// ---------------------------------------------------------------------------
// Files, and the addresses widgets load from
// ---------------------------------------------------------------------------

const b64url = (b: Buffer) => b.toString('base64url');

/** A key of its own for file addresses, from the secret box's (SECRET_KEY): the same on every instance. */
function fileKey(app: AppServices): Buffer {
  return createHmac('sha256', secretKey(keySource(app))).update('a4a-app-files').digest();
}

/** A signed, expiring path segment that names an app's files at a version. */
export function fileToken(app: AppServices, row: { id: string; version: string }, now = Date.now()): string {
  const body = b64url(Buffer.from(JSON.stringify({ a: row.id, v: row.version, e: Math.floor(now / 1000) + FILE_TOKEN_SECONDS })));
  const mac = createHmac('sha256', fileKey(app)).update(body).digest();
  return `${body}.${b64url(mac.subarray(0, 24))}`;
}

export function readFileToken(app: AppServices, token: string, now = Date.now()): { appId: string; version: string } | null {
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const want = createHmac('sha256', fileKey(app)).update(body).digest().subarray(0, 24);
  const got = Buffer.from(mac, 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const t = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { a?: string; v?: string; e?: number };
    if (!t.a || !t.v || !t.e || t.e * 1000 < now) return null;
    return { appId: t.a, version: t.v };
  } catch {
    return null;
  }
}

function fileUrl(app: AppServices, row: { id: string; version: string }, path: string): string {
  return `/app-files/${fileToken(app, row)}/${path.split('/').map(encodeURIComponent).join('/')}`;
}

/** A file of an installed app, by a token a4a signed and the path in its package. */
export async function appFile(app: AppServices, token: string, path: string): Promise<{ contentType: string; content: Buffer } | null> {
  const t = readFileToken(app, token);
  if (!t) return null;
  const [row] = await app.db.select({ id: apps.id, version: apps.version, enabled: apps.enabled }).from(apps).where(eq(apps.id, t.appId));
  if (!row || row.version !== t.version || !row.enabled) return null;
  const [file] = await app.db
    .select({ contentType: appFiles.contentType, content: appFiles.content })
    .from(appFiles)
    .where(and(eq(appFiles.appId, row.id), eq(appFiles.path, path)));
  return file ?? null;
}

// ---------------------------------------------------------------------------
// Where widgets show
// ---------------------------------------------------------------------------

/** The widgets to draw at a place: of apps that run in its project (or, for the main menu and dashboards, anywhere the viewer reads). */
export async function appExtensions(ctx: Ctx, opts: { at: AppExtensionPoint; issue?: string; project?: string; article?: string }): Promise<AppExtension[]> {
  requireScope(ctx, 'read');
  if (ctx.actor.guest) return [];
  const s = await ctx.app.schema.get();
  let projectIds: string[] | null = null;
  if (opts.issue) projectIds = [(await resolveIssue(ctx, opts.issue)).projectId];
  else if (opts.article) projectIds = [(await getArticle(ctx, opts.article)).project.id];
  else if (opts.project) projectIds = [(await requireProject(ctx, opts.project)).id];
  const view = await projectAccess(ctx);
  const rows = await ctx.db.select().from(apps).where(eq(apps.enabled, true)).orderBy(asc(apps.title));
  const out: AppExtension[] = [];
  for (const row of rows) {
    const a = s.apps.get(row.id);
    if (!a) continue;
    const here = projectIds ?? appProjectIds(s, a).filter((id) => view.canRead(id));
    if (!here.some((id) => appEnabledIn(a, id))) continue;
    for (const w of manifestOf(row).widgets.filter((x) => x.at === opts.at)) {
      out.push({ app: row.name, appTitle: row.title, name: w.name, title: w.title, at: w.at, url: fileUrl(ctx.app, row, w.entry), height: w.height, uses: w.uses });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Calls through an app: its storage and its handlers
// ---------------------------------------------------------------------------

/** The app as a call through it sees it: installed, on, and running where the call is about. */
async function appForCall(ctx: Ctx, name: string, projectId: string | null): Promise<{ row: AppDbRow; a: AppRow; s: SchemaSnapshot }> {
  const row = await rowByName(ctx.db, name);
  const s = await ctx.app.schema.get();
  const a = row ? s.apps.get(row.id) : undefined;
  if (!row || !a || !a.enabled) throw notFound(`App ${name}`).said('notFound.app', { id: name });
  if (ctx.actor.app && ctx.actor.app.id !== row.id) throw forbidden(`The ${ctx.actor.app.title} app can't reach another app`, 'An app calls its own handlers and storage.').said('apps.cantReachOtherApp', { title: ctx.actor.app.title });
  if (projectId && !appEnabledIn(a, projectId)) throw notFound(`App ${name}`, 'It doesn’t run in this project.').said('apps.notInThisProject', { name });
  return { row, a, s };
}

async function storageRows(db: Db, appId: string, projectId: string | null) {
  return db
    .select()
    .from(appStorage)
    .where(and(eq(appStorage.appId, appId), projectId ? eq(appStorage.projectId, projectId) : isNull(appStorage.projectId)))
    .orderBy(asc(appStorage.key));
}

function storageDto(rows: Awaited<ReturnType<typeof storageRows>>, project: string | null): AppStorage {
  return { project, values: Object.fromEntries(rows.map((r) => [r.key, r.value])), bytes: rows.reduce((n, r) => n + r.bytes, 0), limitBytes: STORAGE_LIMIT_BYTES };
}

export async function getAppStorage(ctx: Ctx, name: string, project?: string): Promise<AppStorage> {
  requireScope(ctx, 'read');
  const p = project ? await requireProject(ctx, project) : null;
  const { row } = await appForCall(ctx, name, p?.id ?? null);
  return storageDto(await storageRows(ctx.db, row.id, p?.id ?? null), p?.key ?? null);
}

async function store(db: Db, appId: string, projectId: string | null, key: string, value: unknown): Promise<void> {
  const k = key.trim();
  if (!k || k.length > 200) throw badRequest('A key is 1 to 200 characters', 'Name what it keeps.').said('apps.keyLength');
  const where = and(eq(appStorage.appId, appId), projectId ? eq(appStorage.projectId, projectId) : isNull(appStorage.projectId), eq(appStorage.key, k));
  if (value === null || value === undefined) {
    await db.delete(appStorage).where(where);
    return;
  }
  const text = JSON.stringify(value);
  if (text.length > STORAGE_VALUE_BYTES) throw badRequest(`A stored value is ${STORAGE_VALUE_BYTES / 1024} KB at most, as JSON`, 'Keep less under one key.').said('apps.valueTooBig', { kb: STORAGE_VALUE_BYTES / 1024 });
  const rows = await storageRows(db, appId, projectId);
  const others = rows.filter((r) => r.key !== k);
  if (others.length >= STORAGE_KEYS) throw badRequest(`An app keeps ${STORAGE_KEYS} keys at most here`, 'Remove some first.').said('apps.tooManyKeys', { STORAGE_KEYS });
  if (others.reduce((n, r) => n + r.bytes, 0) + text.length > STORAGE_LIMIT_BYTES) throw badRequest(`An app keeps ${STORAGE_LIMIT_BYTES / 1024 / 1024} MB at most here`, 'Remove some first.').said('apps.storageFull', { mb: STORAGE_LIMIT_BYTES / 1024 / 1024 });
  if (rows.some((r) => r.key === k)) await db.update(appStorage).set({ value, bytes: text.length, updatedAt: new Date() }).where(where);
  else await db.insert(appStorage).values({ id: newId(), appId, projectId, key: k, value, bytes: text.length });
}

/** Keep a value for an app: a project's needs someone who may change its issues; the app's own, an administrator. */
export async function setAppStorage(ctx: Ctx, name: string, key: string, value: unknown, project?: string): Promise<AppStorage> {
  requireScope(ctx, 'write');
  const p = project ? await requireProject(ctx, project, 'write') : null;
  if (!p) requireScope(ctx, 'admin');
  const { row } = await appForCall(ctx, name, p?.id ?? null);
  await store(ctx.db, row.id, p?.id ?? null, key, value);
  return storageDto(await storageRows(ctx.db, row.id, p?.id ?? null), p?.key ?? null);
}

async function logRun(db: Db, row: { id: string }, entry: { handler: string; actorId: string | null; projectId: string | null; issueKey: string | null; outcome: string; message: string; ms: number | null }) {
  await db.insert(appRuns).values({ appId: row.id, ...entry });
  // The log keeps its latest runs.
  await db.execute(sql`DELETE FROM app_runs WHERE app_id = ${row.id} AND id NOT IN (SELECT id FROM app_runs WHERE app_id = ${row.id} ORDER BY id DESC LIMIT ${RUNS_KEPT})`);
}

/** An issue as an app sees it: what D40's scripts get, its comments only if it reads them (and none limited), its logged time if it reads that. */
async function issueForApp(db: Db, s: SchemaSnapshot, issue: IssueRow, uses: AppPermissions, by: Ctx['actor']['user'] | null) {
  const input = await scriptInput(db, s, issue, changeOf('action', by), { unlimited: true });
  const seen = input.issue as unknown as Record<string, unknown>;
  if (uses.read.includes('comments')) {
    const rows = await db
      .select({ authorId: comments.authorId, text: comments.text, createdAt: comments.createdAt })
      .from(comments)
      .where(and(eq(comments.issueId, issue.id), isNull(comments.deletedAt), eq(comments.limited, false), eq(comments.visibility, 'internal')))
      .orderBy(desc(comments.createdAt))
      .limit(20);
    seen.comments = rows.reverse().map((c) => ({ author: c.authorId ? (s.users.get(c.authorId)?.login ?? null) : null, text: c.text, created: c.createdAt.toISOString() }));
  } else seen.comments = [];
  if (uses.read.includes('time')) {
    const rows = await db.select().from(workItems).where(eq(workItems.issueId, issue.id)).orderBy(asc(workItems.date)).limit(500);
    seen.workItems = rows.map((w) => ({ author: w.authorId ? (s.users.get(w.authorId)?.login ?? null) : null, minutes: w.minutes, date: w.date, description: w.description }));
  }
  return input;
}

/**
 * Call an app's handler, about an issue or a project the caller can see, where the app runs. It's
 * given what the handler uses and the caller may see; what it changes is done as the caller through
 * the app, so the caller's permissions hold and history says the app did it for them.
 */
export async function callHandler(ctx: Ctx, name: string, handlerName: string, input: { issue?: string; project?: string; body?: unknown }, request: { method: string; query: Record<string, string> }): Promise<AppHandlerResult> {
  requireScope(ctx, 'read');
  if (ctx.actor.guest) throw forbidden('Guests don’t call apps', 'Sign in.').said('apps.guestsDontCall');
  const row0 = await rowByName(ctx.db, name);
  const handler = row0 ? manifestOf(row0).handlers.find((h) => h.name === handlerName) : undefined;
  if (!row0 || !handler) throw notFound(`Handler ${name}/${handlerName}`).said('apps.handlerNotFound', { name, handlerName });
  const s0 = await ctx.app.schema.get();
  const a0 = s0.apps.get(row0.id);
  if (!a0) throw notFound(`App ${name}`).said('notFound.app', { id: name });
  // The caller through the app: within what it runs in and was granted.
  const via = ctx.actor.app ? ctx : throughApp(ctx, s0, a0);
  const issue = input.issue ? await resolveIssue(via, input.issue) : undefined;
  const project = issue ? s0.projects.get(issue.projectId) : input.project ? await requireProject(via, input.project) : undefined;
  const { row, s } = await appForCall(via, name, project?.id ?? null);
  const started = Date.now();
  const log = (outcome: string, message: string) =>
    logRun(ctx.db, row, { handler: handlerName, actorId: ctx.actor.user.id, projectId: project?.id ?? null, issueKey: issue ? readableId(s, issue) : null, outcome, message: message.slice(0, 2000), ms: Date.now() - started });
  const uses = handler.uses;
  const source = (await ctx.db.select({ content: appFiles.content }).from(appFiles).where(and(eq(appFiles.appId, row.id), eq(appFiles.path, handler.file))))[0]?.content.toString('utf8');
  if (!source) throw notFound(`Handler ${name}/${handlerName}`).said('apps.handlerNotFound', { name, handlerName });
  const base = issue && uses.read.includes('issues') ? await issueForApp(ctx.db, s, issue, uses, ctx.actor.user) : null;
  const stored = await storageRows(ctx.db, row.id, project?.id ?? null);
  const out = await runScript(source, {
    issue: base?.issue ?? null,
    change: null,
    project: project ? { key: project.key, name: project.name } : null,
    request: { method: request.method, query: request.query, body: input.body ?? null },
    settings: await settingsForRun(ctx.app, row, project?.id ?? null),
    storage: Object.fromEntries(stored.map((r) => [r.key, r.value])),
    app: { name: row.name, version: row.version },
  });
  if (out.error) {
    await log('failed', out.error.message);
    throw badRequest(`${row.title}'s handler ${handlerName} stopped: ${out.error.message}`, 'Tell whoever made the app; its run log says the same.').said('apps.handlerStopped', { title: row.title, handlerName, message: out.error.message });
  }
  if (out.intents.refusal !== null) {
    await log('refused', out.intents.refusal);
    throw badRequest(out.intents.refusal, `${row.title} said so.`).said('apps.handlerRefused', { refusal: /[.!?…:]["”’)]*$/.test(out.intents.refusal.trim()) ? out.intents.refusal.trim() : `${out.intents.refusal.trim()}.`, title: row.title });
  }
  // What it asks to change: only what it uses, as the caller through the app.
  const wants = { applies: out.intents.applies.length, comments: out.intents.comments.length };
  if (wants.applies && !uses.write.includes('issues')) {
    await log('refused', 'It tried to change an issue, which it doesn’t write');
    throw forbidden(`${row.title}'s handler ${handlerName} tried to change an issue, and it doesn't write issues`, 'Tell whoever made the app.').said('apps.handlerCantWriteIssues', { title: row.title, handlerName });
  }
  if (wants.comments && !uses.write.includes('comments')) {
    await log('refused', 'It tried to comment, which it doesn’t write');
    throw forbidden(`${row.title}'s handler ${handlerName} tried to comment, and it doesn't write comments`, 'Tell whoever made the app.').said('apps.handlerCantComment', { title: row.title, handlerName });
  }
  if ((wants.applies || wants.comments) && !issue) throw badRequest(`${row.title}'s handler ${handlerName} changes an issue, and wasn't given one`, 'Call it with "issue".').said('apps.handlerNeedsIssue', { title: row.title, handlerName });
  let applied = 0;
  let commented = 0;
  try {
    if (issue && (wants.applies || wants.comments)) {
      const planned = await plannedChanges(via, ctx.db, s, issue, base!.issue, out.intents, { meId: ctx.actor.user.id, onlySelf: true });
      const { activities } = await ctx.db.transaction(async (txRaw) => applyPlanned(txRaw as unknown as Db, via, s, issue, planned, { app: row.name }));
      await publishActivities(ctx.app, activities);
      applied = wants.applies;
      commented = wants.comments;
    }
    for (const st of out.intents.stores ?? []) await store(ctx.db, row.id, project?.id ?? null, st.key, st.value);
  } catch (e) {
    await log('failed', e instanceof Error ? e.message : String(e));
    throw e;
  }
  await log('ok', out.intents.logs.join('\n'));
  return { response: out.intents.response ?? null, applied, commented };
}

// ---------------------------------------------------------------------------
// For agents (MCP): what's installed where they can see, and nothing to change
// ---------------------------------------------------------------------------

export async function appsForAgent(ctx: Ctx): Promise<{ name: string; title: string; version: string; description: string; projects: string[]; widgets: { name: string; title: string; at: string }[]; handlers: { name: string; title: string }[]; may: string[] }[]> {
  requireScope(ctx, 'read');
  const s = await ctx.app.schema.get();
  const view = await projectAccess(ctx);
  const rows = await ctx.db.select().from(apps).where(eq(apps.enabled, true)).orderBy(asc(apps.name));
  const out = [];
  for (const row of rows) {
    const a = s.apps.get(row.id);
    if (!a) continue;
    const here = appProjectIds(s, a).filter((id) => view.canRead(id));
    if (!here.length) continue;
    const m = manifestOf(row);
    out.push({
      name: row.name,
      title: row.title,
      version: row.version,
      description: row.description,
      projects: here.map((id) => s.projects.get(id)!.key).sort(),
      widgets: m.widgets.map((w) => ({ name: w.name, title: w.title, at: w.at })),
      handlers: m.handlers.map((h) => ({ name: h.name, title: h.title })),
      may: permissionWords(permissionsOf(row.granted)),
    });
  }
  return out;
}

/** Whether a widget's call may go ahead: what it needs is within the app's grant. */
export function appMay(row: { granted: { read: string[]; write: string[] } }, need: string): boolean {
  return granted(row, need);
}

