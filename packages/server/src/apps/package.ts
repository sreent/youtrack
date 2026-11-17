/**
 * An app's package (docs/architecture.md, D48): a zip with manifest.json at its root, read in
 * memory and checked before anything of it is kept.
 *
 * - Its files are named by safe relative paths: no absolute path, no `..`, no backslash, no drive.
 *   a4a never writes them to disk: they're kept in the database and served from there, so a path
 *   can't reach anything else, and a link in the zip is only a small file.
 * - Sizes are bounded before anything is inflated (the zip's own sizes) and after (what came out):
 *   so many files, so large each, so large in all.
 * - Only the kinds of file a widget needs are taken, each served as what its name says.
 * - The manifest says what the app asks for, and each part (a widget, a handler, a rule) says what
 *   it uses. It asks for exactly what its parts use: asking for what no part uses, or a part using
 *   what the app doesn't ask for, is refused, so what an administrator accepts is what runs.
 */
import { createHash } from 'node:crypto';
import { APP_EXTENSION_POINTS, APP_RESOURCES, APP_SETTING_TYPES, type AppExtensionPoint, type AppPermissions, type AppResource, type AppSettingDef } from '@a4a/shared';
import { unzipSync, zipSync, type Unzipped } from 'fflate';
import { asSentence, badRequest } from '../lib/errors';
import { SCRIPT_LIMITS } from '../workflow/sandbox';

export const PACKAGE_LIMITS = {
  files: 200,
  fileBytes: 2 * 1024 * 1024,
  totalBytes: 20 * 1024 * 1024,
  pathLength: 200,
} as const;

/** The a4a version apps are checked against: the API's. */
export const A4A_VERSION = '1.0.0';

const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  woff2: 'font/woff2',
  txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
};

export interface ManifestPart {
  name: string;
  title: string;
  uses: AppPermissions;
}
export interface ManifestWidget extends ManifestPart {
  at: AppExtensionPoint;
  entry: string;
  height: number;
}
export interface ManifestHandler extends ManifestPart {
  file: string;
}
export interface ManifestRule extends ManifestPart {
  file: string;
  kind: 'change' | 'schedule';
  /** A rule on a change: created, updated or commented. */
  on: 'created' | 'updated' | 'commented' | null;
  /** On 'updated': only when this field changes. */
  field: string | null;
  query: string;
  schedule: { every: 'hour' } | { every: 'day' | 'weekday'; at: string } | null;
}
export interface Manifest {
  name: string;
  title: string;
  version: string;
  vendor: string | null;
  description: string;
  icon: string | null;
  a4a: string | null;
  permissions: AppPermissions;
  settings: AppSettingDef[];
  widgets: ManifestWidget[];
  handlers: ManifestHandler[];
  rules: ManifestRule[];
}

export interface AppFile {
  path: string;
  contentType: string;
  content: Buffer;
}

export interface ReadPackage {
  manifest: Manifest;
  files: AppFile[];
  sha256: string;
  bytes: number;
}

export const sha256Hex = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

const NAME = /^[a-z][a-z0-9-]{1,39}$/;
const PART = /^[a-z][a-z0-9-]{0,39}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** A path inside a package, or why it isn't one a4a takes. */
export function safePath(raw: string): string | null {
  if (!raw || raw.length > PACKAGE_LIMITS.pathLength) return null;
  if (raw.startsWith('/') || raw.includes('\\') || raw.includes('\0') || /^[a-zA-Z]:/.test(raw)) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) return null;
  const parts = raw.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return null;
  return parts.join('/');
}

export function contentTypeOf(path: string): string | null {
  const ext = path.toLowerCase().split('.').pop() ?? '';
  return TYPES[ext] ?? null;
}

/**
 * What's wrong with a package, for whoever wrote the app: a page in another language frames it in
 * its words, and says the problem itself as a4a wrote it, since the manifest's names are English (D49).
 */
const fix = (message: string, hint: string): never => {
  throw badRequest(message, hint).said('apps.packageProblem', { problem: asSentence(message), fix: asSentence(hint) });
};

/** Read a zip into its files, bounded: the files a4a takes, or why it takes none. */
export function unpack(bytes: Uint8Array, maxBytes: number): { files: AppFile[]; sha256: string } {
  if (bytes.length > maxBytes) fix(`The package is ${mb(bytes.length)}, and a4a takes apps of ${mb(maxBytes)} at most`, 'Make it smaller, or ask for APP_MAX_MB to be raised.');
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) fix("The package isn't a zip", 'Zip the app, with manifest.json at the root of the zip.');
  let total = 0;
  let count = 0;
  let unzipped: Unzipped;
  try {
    unzipped = unzipSync(bytes, {
      filter: (f) => {
        if (f.name.endsWith('/')) return false;
        count += 1;
        total += f.originalSize;
        if (count > PACKAGE_LIMITS.files) fix(`The package has more than ${PACKAGE_LIMITS.files} files`, 'Bundle its scripts and styles into fewer files.');
        if (f.originalSize > PACKAGE_LIMITS.fileBytes) fix(`${f.name} is ${mb(f.originalSize)}: a file can be ${mb(PACKAGE_LIMITS.fileBytes)} at most`, 'Make it smaller.');
        if (total > PACKAGE_LIMITS.totalBytes) fix(`The package unzips to more than ${mb(PACKAGE_LIMITS.totalBytes)}`, 'Make its files smaller.');
        return true;
      },
    });
  } catch (e) {
    if (e instanceof Error && 'status' in e) throw e;
    throw badRequest(`The zip can't be read: ${e instanceof Error ? e.message : String(e)}`, 'Zip it again, with manifest.json at the root of the zip.').said('apps.zipUnreadable', { error: asSentence(e instanceof Error ? e.message : String(e)) });
  }
  const files: AppFile[] = [];
  let out = 0;
  for (const [raw, content] of Object.entries(unzipped)) {
    const path = safePath(raw);
    if (!path) fix(`The package names a file "${raw.slice(0, 80)}" a4a won't take`, 'Name files by plain relative paths: no leading /, no .., no backslashes.');
    const type = contentTypeOf(path!);
    if (!type) fix(`${path} is a kind of file a4a doesn't serve`, `Apps hold ${Object.keys(TYPES).join(', ')} files.`);
    out += content.length;
    if (content.length > PACKAGE_LIMITS.fileBytes || out > PACKAGE_LIMITS.totalBytes) fix('The package unzips to more than it says', 'Zip it again: its sizes are wrong.');
    files.push({ path: path!, contentType: type!, content: Buffer.from(content) });
  }
  return { files, sha256: sha256Hex(bytes) };
}

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(n < 1024 * 1024 ? 2 : 1)} MB`;

// ---------------------------------------------------------------------------
// The manifest
// ---------------------------------------------------------------------------

type Raw = Record<string, unknown>;
const isObj = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

function permissionsOf(v: unknown, where: string): AppPermissions {
  if (v === undefined || v === null) return { read: [], write: [] };
  if (!isObj(v)) return fix(`${where}: "permissions" lists what it reads and writes`, 'e.g. "permissions": { "read": ["issues", "time"], "write": [] }');
  const list = (k: 'read' | 'write'): AppResource[] => {
    const raw = v[k] ?? [];
    if (!Array.isArray(raw)) return fix(`${where}: "${k}" is a list`, `Name what it ${k}s: ${APP_RESOURCES.join(', ')}.`);
    const out: AppResource[] = [];
    for (const r of raw) {
      if (typeof r !== 'string' || !(APP_RESOURCES as readonly string[]).includes(r)) {
        fix(`${where}: "${String(r)}" isn't something an app can ${k}`, `It ${k}s ${APP_RESOURCES.join(', ')}.`);
      }
      if (!out.includes(r as AppResource)) out.push(r as AppResource);
    }
    return out.sort();
  };
  return { read: list('read'), write: list('write') };
}

export function sortedPermissions(p: AppPermissions): AppPermissions {
  return { read: [...new Set(p.read)].sort(), write: [...new Set(p.write)].sort() };
}

/** Everything in `a` and in `b`. */
export function unionOf(a: AppPermissions, b: AppPermissions): AppPermissions {
  return sortedPermissions({ read: [...a.read, ...b.read], write: [...a.write, ...b.write] });
}

/** What `a` has that `b` doesn't. */
export function beyond(a: AppPermissions, b: AppPermissions): AppPermissions {
  return { read: a.read.filter((r) => !b.read.includes(r)), write: a.write.filter((r) => !b.write.includes(r)) };
}

export const isEmpty = (p: AppPermissions) => !p.read.length && !p.write.length;
export const samePermissions = (a: AppPermissions, b: AppPermissions) => isEmpty(beyond(a, b)) && isEmpty(beyond(b, a));

function partOf(raw: unknown, kind: string, i: number): { name: string; title: string; uses: AppPermissions; raw: Raw } {
  if (!isObj(raw)) return fix(`The manifest's ${kind} number ${i + 1} isn't an object`, `Give each ${kind} a name, a title and what it uses.`);
  const name = str(raw.name);
  if (!name || !PART.test(name)) fix(`A ${kind}'s name "${String(raw.name ?? '')}" isn't one a4a takes`, 'Use lower-case letters, digits and dashes, starting with a letter, 40 at most.');
  const where = `The ${kind} "${name}"`;
  return { name: name!, title: str(raw.title) ?? name!, uses: permissionsOf(raw.uses, where), raw };
}

function settingOf(raw: unknown, i: number): AppSettingDef {
  if (!isObj(raw)) return fix(`The manifest's setting number ${i + 1} isn't an object`, 'Give each setting a name, a title and a type.');
  const name = str(raw.name);
  if (!name || !/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(name)) fix(`A setting's name "${String(raw.name ?? '')}" isn't one a4a takes`, 'Use letters, digits and underscores, starting with a letter.');
  const type = str(raw.type) ?? 'text';
  if (!(APP_SETTING_TYPES as readonly string[]).includes(type)) fix(`The setting "${name}" has a type a4a doesn't know: ${type}`, `Settings are ${APP_SETTING_TYPES.join(', ')}.`);
  const scope = str(raw.scope) ?? 'app';
  if (scope !== 'app' && scope !== 'project') fix(`The setting "${name}" is for "${scope}"`, 'A setting is for the app ("app") or for each project ("project").');
  const choices = Array.isArray(raw.choices) ? raw.choices.filter((c): c is string => typeof c === 'string' && c.trim() !== '').map((c) => c.trim()) : null;
  if (type === 'choice' && !choices?.length) fix(`The setting "${name}" is a choice with nothing to choose`, 'List its "choices".');
  const def = raw.default;
  const defOk = def === undefined || def === null || typeof def === 'string' || typeof def === 'number' || typeof def === 'boolean';
  if (!defOk || (type === 'secret' && def !== undefined && def !== null)) fix(`The setting "${name}" has a default a4a won't take`, 'A default is a plain value, and a secret has none.');
  return {
    name: name!,
    title: str(raw.title) ?? name!,
    type: type as AppSettingDef['type'],
    scope: scope as 'app' | 'project',
    description: str(raw.description),
    required: raw.required === true,
    default: (def as string | number | boolean | undefined) ?? null,
    choices: type === 'choice' ? choices : null,
  };
}

function versionAtLeast(have: string, want: string): boolean {
  const a = have.split('-')[0]!.split('.').map(Number);
  const b = want.split('-')[0]!.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

/** Whether version `a` is newer than `b` (x.y.z, a pre-release older than its release). */
export function newerVersion(a: string, b: string): boolean {
  if (a === b) return false;
  const [ma, pa] = a.split('-');
  const [mb2, pb] = b.split('-');
  if (ma !== mb2) return versionAtLeast(ma!, mb2!);
  if (!pa) return true;
  if (!pb) return false;
  return pa > pb;
}

/** The manifest, read and checked against the package's files. */
export function readManifest(files: AppFile[]): Manifest {
  const file = files.find((f) => f.path === 'manifest.json');
  if (!file) return fix('The package has no manifest.json at its root', 'Put manifest.json at the root of the zip, not in a folder.');
  let raw: unknown;
  try {
    raw = JSON.parse(file.content.toString('utf8'));
  } catch (e) {
    return fix(`manifest.json isn't JSON: ${e instanceof Error ? e.message : String(e)}`, 'Fix it, and zip the app again.');
  }
  if (!isObj(raw)) return fix('manifest.json is not an object', 'It holds the app\'s name, title, version and what it adds.');
  const name = str(raw.name);
  if (!name || !NAME.test(name)) fix(`The app's name "${String(raw.name ?? '')}" isn't one a4a takes`, 'Use 2 to 40 lower-case letters, digits and dashes, starting with a letter: e.g. "time-report".');
  const title = str(raw.title);
  if (!title || title.length > 80) fix('The app needs a title of 80 characters at most', 'e.g. "title": "Time report"');
  const version = str(raw.version);
  if (!version || !VERSION.test(version)) fix(`The version "${String(raw.version ?? '')}" isn't one a4a reads`, 'Use major.minor.patch, e.g. "1.0.0".');
  const a4a = str(raw.a4a);
  if (a4a) {
    const want = a4a.replace(/^>=\s*/, '');
    if (!VERSION.test(want)) fix(`"a4a": "${a4a}" isn't a version a4a reads`, 'Say the oldest a4a it works with, e.g. ">=1.0.0".');
    if (!versionAtLeast(A4A_VERSION, want)) fix(`It needs a4a ${want} or newer, and this is ${A4A_VERSION}`, 'Install a version of it made for this a4a, or update a4a.');
  }
  const has = new Set(files.map((f) => f.path));
  const icon = str(raw.icon);
  if (icon && (!safePath(icon) || !has.has(icon) || !/\.(svg|png)$/i.test(icon))) fix(`Its icon "${icon}" isn't a PNG or SVG in the package`, 'Name a file in the zip, e.g. "icon.svg".');

  const arr = (k: string): unknown[] => {
    const v = raw[k as keyof typeof raw];
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) return fix(`"${k}" in manifest.json is a list`, `Give "${k}" as [ … ].`);
    return v;
  };
  const named = new Set<string>();
  const unique = (kind: string, n: string) => {
    if (named.has(`${kind}:${n}`)) fix(`Two ${kind}s are called "${n}"`, `Give each ${kind} a name of its own.`);
    named.add(`${kind}:${n}`);
  };
  const fileIn = (where: string, f: unknown, ext: RegExp, what: string): string => {
    const p = str(f);
    if (!p || !safePath(p) || !has.has(p)) return fix(`${where} names "${String(f ?? '')}", which isn't in the package`, `Name ${what} in the zip by its path.`);
    if (!ext.test(p)) fix(`${where}'s file ${p} isn't ${what}`, `Name ${what}.`);
    return p;
  };
  const scriptIn = (where: string, path: string) => {
    const f = files.find((x) => x.path === path)!;
    if (f.content.length > SCRIPT_LIMITS.source) fix(`${where}'s script is longer than ${SCRIPT_LIMITS.source.toLocaleString('en')} characters`, 'Make it shorter: a script handles one thing.');
  };

  const widgets: ManifestWidget[] = arr('widgets').map((w, i) => {
    const p = partOf(w, 'widget', i);
    unique('widget', p.name);
    const at = str(p.raw.at);
    if (!at || !(APP_EXTENSION_POINTS as readonly string[]).includes(at)) {
      fix(`The widget "${p.name}" is for "${String(p.raw.at ?? '')}", which isn't a place a4a draws widgets`, `Widgets go at ${APP_EXTENSION_POINTS.join(', ')}.`);
    }
    const entry = fileIn(`The widget "${p.name}"`, p.raw.entry, /\.html?$/i, 'an HTML file');
    const height = typeof p.raw.height === 'number' && Number.isFinite(p.raw.height) ? Math.round(p.raw.height) : 200;
    return { name: p.name, title: p.title, uses: p.uses, at: at as AppExtensionPoint, entry, height: Math.min(800, Math.max(80, height)) };
  });
  const handlers: ManifestHandler[] = arr('handlers').map((h, i) => {
    const p = partOf(h, 'handler', i);
    unique('handler', p.name);
    const file = fileIn(`The handler "${p.name}"`, p.raw.file, /\.m?js$/i, 'a JavaScript file');
    scriptIn(`The handler "${p.name}"`, file);
    return { name: p.name, title: p.title, uses: p.uses, file };
  });
  const rules: ManifestRule[] = arr('rules').map((r, i) => {
    const p = partOf(r, 'rule', i);
    unique('rule', p.name);
    const where = `The rule "${p.name}"`;
    const file = fileIn(where, p.raw.file, /\.m?js$/i, 'a JavaScript file');
    scriptIn(where, file);
    const kind = str(p.raw.kind) ?? (p.raw.every ? 'schedule' : 'change');
    if (kind === 'guard') fix(`${where} is a guard`, "An app's rules act on a change or on a schedule; refusing people's changes is for the project's own guards.");
    if (kind !== 'change' && kind !== 'schedule') fix(`${where} is a "${kind}" rule`, 'An app\'s rule is "change" (when something happens) or "schedule" (every hour or day).');
    let on: ManifestRule['on'] = null;
    let schedule: ManifestRule['schedule'] = null;
    if (kind === 'change') {
      const o = str(p.raw.on) ?? 'updated';
      if (o !== 'created' && o !== 'updated' && o !== 'commented') fix(`${where} is on "${o}"`, 'A rule acts when an issue is "created", "updated" or "commented".');
      on = o as ManifestRule['on'];
    } else {
      const every = str(p.raw.every) ?? 'day';
      if (every === 'hour') schedule = { every: 'hour' };
      else if (every === 'day' || every === 'weekday') {
        const at = str(p.raw.at) ?? '09:00';
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(at)) fix(`${where} runs at "${at}"`, 'Say when as HH:MM, e.g. "09:00".');
        schedule = { every, at };
      } else fix(`${where} runs every "${every}"`, 'A scheduled rule runs every "hour", "day" or "weekday".');
    }
    if (!p.uses.read.includes('issues')) fix(`${where} reads issues without saying so`, 'A rule is given its issue: add "issues" to what it reads, under "uses".');
    return { name: p.name, title: p.title, uses: p.uses, file, kind: kind as 'change' | 'schedule', on, field: on === 'updated' ? str(p.raw.field) : null, query: str(p.raw.query) ?? '', schedule };
  });
  const settings = arr('settings').map(settingOf);
  const settingNames = new Set<string>();
  for (const s of settings) {
    if (settingNames.has(s.name)) fix(`Two settings are called "${s.name}"`, 'Give each setting a name of its own.');
    settingNames.add(s.name);
  }

  const permissions = permissionsOf(raw.permissions, 'The app');
  // What it asks for is exactly what its parts use.
  let used: AppPermissions = { read: [], write: [] };
  for (const part of [...widgets, ...handlers, ...rules]) used = unionOf(used, part.uses);
  const unused = beyond(permissions, used);
  if (!isEmpty(unused)) {
    fix(`The app asks for what none of its parts uses: ${describe(unused).join('; ')}`, 'Leave it out of "permissions", or say which widget, handler or rule uses it, under its "uses".');
  }
  const unasked = beyond(used, permissions);
  if (!isEmpty(unasked)) fix(`Its parts use what the app doesn't ask for: ${describe(unasked).join('; ')}`, 'Add it to "permissions", so whoever installs it sees it.');
  if (!widgets.length && !handlers.length && !rules.length) fix('The app adds nothing: no widgets, handlers or rules', 'Add a widget, a handler or a rule to manifest.json.');

  return {
    name: name!,
    title: title!,
    version: version!,
    vendor: str(raw.vendor),
    description: (str(raw.description) ?? '').slice(0, 1000),
    icon,
    a4a,
    permissions: sortedPermissions(permissions),
    settings,
    widgets,
    handlers,
    rules,
  };
}

/** What permissions let an app do, as short words (for messages). */
export function describe(p: AppPermissions): string[] {
  return [...p.read.map((r) => `read ${r}`), ...p.write.map((r) => `write ${r}`)];
}

/** Read and check a package: its files, its manifest, its digest. */
export function readPackage(bytes: Uint8Array, maxBytes: number): ReadPackage {
  const { files, sha256 } = unpack(bytes, maxBytes);
  return { manifest: readManifest(files), files, sha256, bytes: bytes.length };
}

/** A package from files: for tests, and for scripts that build examples. */
export function packApp(files: Record<string, string | Uint8Array>): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const [path, content] of Object.entries(files)) entries[path] = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  return zipSync(entries, { level: 6, mtime: new Date('2026-01-01T00:00:00Z') });
}
