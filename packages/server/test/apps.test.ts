/**
 * Apps (docs/architecture.md, D48): packages and what they may ask, installing with consent, widgets'
 * files and calls, handlers, rules acting as an app's agent, catalogs and their signatures, updates
 * asking again only for more, and removal leaving nothing behind.
 */
import { generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { forgetCatalogs, signedText } from '../src/apps/catalog';
import { packDirectory } from '../src/apps/pack-dir';
import { packApp, sha256Hex } from '../src/apps/package';
import type { Ctx } from '../src/context';
import { activities, appFiles, appProjects, appRuns, apps, appSettings, appStorage, rules, users } from '../src/db/schema';
import { OutboxWorker } from '../src/events/worker';
import { createHttpApp } from '../src/http/app';
import { AppError } from '../src/lib/errors';
import {
  appExtensions,
  appRemoval,
  callHandler,
  installFromCatalog,
  installPackage,
  listCatalog,
  previewFromCatalog,
  previewPackage,
  removeApp,
  setAppSettings,
  setProjectApp,
  updatePackage,
} from '../src/services/apps';
import { startSession } from '../src/services/auth';
import { createIssue, findIssue, getIssue, setIssueVisibility } from '../src/services/issues';
import { updateProject } from '../src/services/projects';
import { logWork } from '../src/services/workitems';
import { RuleEngine } from '../src/workflow/engine';
import { updateRule } from '../src/workflow/rules';
import { createWorld, type TestWorld } from './helpers';

const here = path.dirname(fileURLToPath(import.meta.url));
const examples = path.resolve(here, '../../../examples/apps');
const BASE = 'http://a4a.test';
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const TIME = { read: ['issues', 'time'] as const, write: [] as const };
const timeAccept = { read: ['issues', 'time'] as ('issues' | 'time')[], write: [] };

/** The example's files, with its manifest changed as `change` says. */
function variant(dir: string, change: (m: Record<string, unknown>) => void, extra: Record<string, string> = {}): Uint8Array {
  const root = path.join(examples, dir);
  const files: Record<string, string | Uint8Array> = {};
  const walk = (rel: string) => {
    for (const f of ['manifest.json', 'icon.svg', 'widgets/time.html', 'widgets/time.js', 'handlers/by-person.js', 'rules/tag-keyword.js']) {
      try {
        files[f] = readFileSync(path.join(root, f));
      } catch {
        // not in this app
      }
    }
    void rel;
  };
  walk('');
  const m = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8')) as Record<string, unknown>;
  change(m);
  files['manifest.json'] = JSON.stringify(m);
  return packApp({ ...files, ...extra });
}

async function failure(run: () => Promise<unknown>): Promise<AppError> {
  try {
    await run();
  } catch (e) {
    if (e instanceof AppError) return e;
    throw e;
  }
  throw new Error('expected a refusal');
}

let w: TestWorld;
let admin: Ctx;
let anna: Ctx;
let ben: Ctx;
let http: ReturnType<typeof createHttpApp>;
let worker: OutboxWorker;
let catalogServer: Server;
let catalogBase = '';
const served = new Map<string, Buffer>();
const keys = generateKeyPairSync('ed25519');
const otherKeys = generateKeyPairSync('ed25519');

async function settle() {
  for (let i = 0; i < 6; i++) await worker.drain();
}

beforeAll(async () => {
  catalogServer = createServer((req, res) => {
    const body = served.get(req.url ?? '');
    if (!body) return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': req.url?.endsWith('.json') ? 'application/json' : 'application/zip' }).end(body);
  });
  await new Promise<void>((r) => catalogServer.listen(0, '127.0.0.1', () => r()));
  catalogBase = `http://127.0.0.1:${(catalogServer.address() as AddressInfo).port}`;
  w = await createWorld({
    config: {
      publicUrl: BASE,
      webDist: undefined,
      appAllowHttpLoopback: true,
      appCatalogs: [`${catalogBase}/signed.json`, `${catalogBase}/plain.json`, `${catalogBase}/tampered.json`],
      appTrustedKeys: [keys.publicKey.export({ format: 'pem', type: 'spki' }).toString()],
    },
  });
  admin = w.adminCtx;
  anna = w.as(w.anna);
  ben = w.as(w.ben);
  http = createHttpApp(w.app);
  const engine = new RuleEngine(w.app, () => {});
  worker = new OutboxWorker(w.app, [engine.consumer()], {}, [], () => {});
  await worker.drain();
});

afterAll(async () => {
  await worker?.stop();
  await w?.close();
  await new Promise<void>((r) => catalogServer?.close(() => r()));
});

describe('a package', () => {
  it("is refused when it isn't a zip, or names a file outside itself, or a kind a4a doesn't serve", async () => {
    expect((await failure(() => previewPackage(admin, b64(Buffer.from('not a zip'))))).message).toMatch(/isn't a zip/);
    const escaping = variant('time-by-person', () => {}, { '../outside.js': 'alert(1)' });
    expect((await failure(() => previewPackage(admin, b64(escaping)))).message).toMatch(/won't take/);
    const exe = variant('time-by-person', () => {}, { 'widgets/tool.exe': 'MZ' });
    expect((await failure(() => previewPackage(admin, b64(exe)))).message).toMatch(/kind of file a4a doesn't serve/);
  });

  it("is refused when it asks for what none of its parts uses, or a part uses what it doesn't ask for", async () => {
    const greedy = variant('time-by-person', (m) => {
      m.permissions = { read: ['issues', 'time', 'comments'], write: ['issues'] };
    });
    const asked = await failure(() => previewPackage(admin, b64(greedy)));
    expect(asked.message).toMatch(/asks for what none of its parts uses: read comments; write issues/);
    const sly = variant('time-by-person', (m) => {
      m.permissions = { read: ['issues'], write: [] };
    });
    expect((await failure(() => previewPackage(admin, b64(sly)))).message).toMatch(/use what the app doesn't ask for: read time/);
  });

  it('says what it is and asks for, in words, before anything is kept', async () => {
    const p = await previewPackage(admin, b64(packDirectory(path.join(examples, 'time-by-person'))));
    expect(p).toMatchObject({ name: 'time-by-person', version: '1.0.0', asks: TIME, installed: null, more: null, signedBy: null });
    expect(p.words).toEqual(['Read issues: their summaries, descriptions, fields, tags and links', 'Read logged time']);
    expect(p.widgets.map((x) => x.at)).toEqual(['issue-panel']);
    expect(await w.app.db.select().from(apps)).toEqual([]);
  });
});

describe('installing', () => {
  it("is a person's decision: a token or an agent can't, and what's accepted must be what it asks", async () => {
    const bytes = b64(packDirectory(path.join(examples, 'time-by-person')));
    const token: Ctx = { ...admin, actor: { ...admin.actor, authMethod: 'token' } };
    expect((await failure(() => installPackage(token, { package: bytes, accept: timeAccept }))).status).toBe(403);
    expect((await failure(() => installPackage(anna, { package: bytes, accept: timeAccept }))).status).toBe(403);
    const less = await failure(() => installPackage(admin, { package: bytes, accept: { read: ['issues'], write: [] } }));
    expect(less.message).toMatch(/isn't what it asks for/);
  });

  it('makes its agent, and runs it where it was chosen', async () => {
    const app = await installPackage(admin, { package: b64(packDirectory(path.join(examples, 'time-by-person'))), accept: timeAccept, projects: ['BACK'] });
    expect(app).toMatchObject({ name: 'time-by-person', version: '1.0.0', granted: TIME, allProjects: false });
    expect(app.agent.login).toBe('app-time-by-person');
    expect(app.projects).toEqual([{ key: 'BACK', name: 'Backend', enabled: true, off: false }]);
    const again = await failure(() => installPackage(admin, { package: b64(packDirectory(path.join(examples, 'time-by-person'))), accept: timeAccept }));
    expect(again.status).toBe(409);
  });
});

describe('its widgets', () => {
  let back = '';
  let web = '';
  beforeAll(async () => {
    back = (await createIssue(anna, { project: 'BACK', summary: 'The export is slow' })).id;
    web = (await createIssue(anna, { project: 'WEB', summary: 'The menu flickers' })).id;
  });

  it('show only where the app runs, from addresses a4a signed, in a sandbox of their own', async () => {
    const [ext, ...more] = await appExtensions(anna, { at: 'issue-panel', issue: back });
    expect(more).toEqual([]);
    expect(ext).toMatchObject({ app: 'time-by-person', name: 'time', at: 'issue-panel', height: 160 });
    expect(await appExtensions(anna, { at: 'issue-panel', issue: web })).toEqual([]);
    expect(await appExtensions(anna, { at: 'dashboard' })).toEqual([]);
    const res = await http.request(ext!.url);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    expect(res.headers.get('content-security-policy')).toMatch(/sandbox allow-scripts allow-forms/);
    expect(res.headers.get('content-security-policy')).toMatch(/connect-src 'none'/);
    expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    expect(await res.text()).toMatch(/\/app-kit\/a4a-app\.js/);
    const token = ext!.url.split('/')[2]!;
    const forged = `${token.slice(0, -2)}${token.endsWith('AA') ? 'BB' : 'AA'}`;
    expect((await http.request(`/app-files/${forged}/widgets/time.html`)).status).toBe(404);
    expect((await http.request(`/app-files/${token}/%2e%2e/manifest.json`)).status).toBe(404);
    expect((await http.request(`/app-files/${token}/nothing.html`)).status).toBe(404);
    const kit = await http.request('/app-kit/a4a-app.js');
    expect(kit.headers.get('content-type')).toMatch(/javascript/);
  });

  it('call a4a only within the grant, and what the widget says it uses, as the person through the app', async () => {
    const { token } = await startSession(w.app.db, w.anna.id, 1);
    const call = (method: string, p: string, headers: Record<string, string> = {}, body?: unknown) =>
      http.request(`/api/v1${p}`, {
        method,
        headers: { cookie: `a4a_session=${token}`, origin: BASE, 'x-a4a-app': 'time-by-person', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    const id = (await getIssue(anna, back)).id;
    expect((await call('GET', `/issues/${id}`)).status).toBe(200);
    // Its widget said it uses nothing directly: only its own handler.
    expect((await call('GET', `/issues/${id}`, { 'x-a4a-widget': 'time' })).status).toBe(403);
    expect((await call('GET', `/issues/${id}/comments`)).status).toBe(403);
    expect((await call('POST', `/issues/${id}/comments`, {}, { text: 'Hello' })).status).toBe(403);
    expect((await call('GET', '/users')).status).toBe(403);
    expect((await call('POST', '/apps/time-by-person/handlers/by-person', { 'x-a4a-widget': 'time' }, { issue: id })).status).toBe(200);
    // Only where it runs: WEB's issue is missing to it.
    expect((await call('GET', `/issues/${(await getIssue(anna, web)).id}`)).status).toBe(404);
    // A token never calls through an app.
    const bearer = await http.request(`/api/v1/issues/${id}`, { headers: { authorization: 'Bearer a4a_nope', 'x-a4a-app': 'time-by-person' } });
    expect(bearer.status).toBe(401);
  });
});

describe('its handlers', () => {
  let issue = '';
  beforeAll(async () => {
    issue = (await createIssue(anna, { project: 'BACK', summary: 'Rewrite the importer' })).id;
    await logWork(anna, issue, { duration: '2h' });
    await logWork(ben, issue, { duration: '30m' });
  });

  it('answer with what the caller may see, and are logged', async () => {
    const res = await callHandler(anna, 'time-by-person', 'by-person', { issue }, { method: 'POST', query: {} });
    expect(res.response).toEqual({ issue, rows: [{ person: 'anna', minutes: 120 }, { person: 'ben', minutes: 30 }], total: 150 });
    const [run] = await w.app.db.select().from(appRuns).where(and(eq(appRuns.handler, 'by-person'), eq(appRuns.issueKey, issue)));
    expect(run).toMatchObject({ outcome: 'ok', actorId: w.anna.id });
  });

  it("answer as missing about an issue limited away from the caller", async () => {
    await setIssueVisibility(anna, issue, { visibleTo: { users: ['anna'], groups: [] } });
    const hidden = await failure(() => callHandler(ben, 'time-by-person', 'by-person', { issue }, { method: 'POST', query: {} }));
    const none = await failure(() => callHandler(ben, 'time-by-person', 'by-person', { issue: 'BACK-999' }, { method: 'POST', query: {} }));
    expect(hidden.status).toBe(404);
    expect(hidden.message.replace(issue, 'X')).toBe(none.message.replace('BACK-999', 'X'));
    await setIssueVisibility(anna, issue, { visibleTo: null });
  });

  it('are stopped past their limits, and say so', async () => {
    const busy = packApp({
      'manifest.json': JSON.stringify({ name: 'busy-loop', title: 'Busy loop', version: '1.0.0', permissions: { read: ['issues'] }, handlers: [{ name: 'spin', file: 'spin.js', uses: { read: ['issues'] } }] }),
      'spin.js': 'while (true) {}',
    });
    await installPackage(admin, { package: b64(busy), accept: { read: ['issues'], write: [] }, allProjects: true });
    const stopped = await failure(() => callHandler(anna, 'busy-loop', 'spin', { issue }, { method: 'POST', query: {} }));
    expect(stopped.message).toMatch(/ran past 250 ms/);
    const [run] = await w.app.db.select().from(appRuns).where(eq(appRuns.handler, 'spin'));
    expect(run!.outcome).toBe('failed');
    await removeApp(admin, 'busy-loop');
  });
});

describe('its rules', () => {
  it('act as its agent where it runs, with its settings, and change with the app', async () => {
    await installPackage(admin, { package: b64(packDirectory(path.join(examples, 'keyword-tags'))), accept: { read: ['issues'], write: ['issues'] }, projects: ['BACK'] });
    const tagged = async (project: string, summary: string) => {
      const i = await createIssue(anna, { project, summary });
      await settle();
      return { id: i.id, tags: (await getIssue(admin, i.id)).tags.map((t) => t.name) };
    };
    const crash = await tagged('BACK', 'A crash on saving drafts');
    expect(crash.tags).toEqual(['needs-triage']);
    const internal = (await findIssue(w.app.db, await w.app.schema.get(), crash.id))!.id;
    const [act] = await w.app.db.select().from(activities).where(and(eq(activities.issueId, internal), eq(activities.channel, 'app')));
    const agent = (await w.app.db.select().from(users).where(eq(users.login, 'app-keyword-tags')))[0]!;
    expect(act).toMatchObject({ actorId: agent.id, tokenName: 'Keyword tags' });
    // Not where it doesn't run.
    expect((await tagged('WEB', 'A crash in the menu')).tags).toEqual([]);
    // A project's own keyword.
    await setAppSettings(admin, 'keyword-tags', { project: 'BACK', values: { keyword: 'freeze' } });
    expect((await tagged('BACK', 'The screen may freeze')).tags).toEqual(['needs-triage']);
    // Its managers turn it off there.
    await updateProject(admin, 'BACK', { lead: 'ben' });
    await setProjectApp(ben, 'BACK', 'keyword-tags', false);
    expect((await tagged('BACK', 'Another freeze')).tags).toEqual([]);
    await setProjectApp(ben, 'BACK', 'keyword-tags', true);
    const [rule] = await w.app.db.select().from(rules).where(eq(rules.name, 'Keyword tags: Tag issues that say the keyword'));
    expect((await failure(() => updateRule(admin, rule!.id, { name: 'Mine now' }))).message).toMatch(/came with an app/);
  });
});

describe('catalogs', () => {
  const entry = (bytes: Uint8Array, name: string, version: string, signWith?: typeof keys.privateKey, sha = sha256Hex(bytes)) => ({
    name,
    title: name,
    version,
    url: `${name}-${version}.zip`,
    sha256: sha,
    ...(signWith ? { signature: sign(null, signedText(name, version, sha), signWith).toString('base64') } : {}),
  });

  beforeAll(() => {
    const v1 = packDirectory(path.join(examples, 'time-by-person'));
    const v2 = variant('time-by-person', (m) => {
      m.version = '1.1.0';
      m.permissions = { read: ['comments', 'issues', 'time'], write: [] };
      (m.handlers as { uses: unknown }[])[0]!.uses = { read: ['issues', 'time', 'comments'], write: [] };
    });
    served.set('/time-by-person-1.0.0.zip', Buffer.from(v1));
    served.set('/time-by-person-1.1.0.zip', Buffer.from(v2));
    const kw = packDirectory(path.join(examples, 'keyword-tags'));
    served.set('/keyword-tags-1.0.0.zip', Buffer.from(kw));
    served.set('/signed.json', Buffer.from(JSON.stringify({ name: 'Signed apps', signed: true, apps: [entry(v1, 'time-by-person', '1.0.0', keys.privateKey), entry(v2, 'time-by-person', '1.1.0', keys.privateKey), entry(kw, 'keyword-tags', '1.0.0')] })));
    served.set('/plain.json', Buffer.from(JSON.stringify({ name: 'Plain apps', apps: [entry(kw, 'keyword-tags', '1.0.0', otherKeys.privateKey)] })));
    served.set('/tampered.json', Buffer.from(JSON.stringify({ name: 'Tampered', apps: [entry(v1, 'time-by-person', '1.0.0', undefined, sha256Hex(kw))] })));
    forgetCatalogs();
  });

  it("list their newest versions beside what's installed", async () => {
    const list = await listCatalog(admin);
    expect(list.problems).toEqual([]);
    const signed = list.apps.filter((a) => a.catalog.endsWith('/signed.json'));
    expect(signed.find((a) => a.name === 'time-by-person')).toMatchObject({ version: '1.1.0', installed: '1.0.0', update: true, signed: true });
  });

  it('refuse a package that differs from its digest, a signature by a key not trusted, and an unsigned app from a catalog that signs', async () => {
    const tampered = await failure(() => previewFromCatalog(admin, { catalog: `${catalogBase}/tampered.json`, name: 'time-by-person' }));
    expect(tampered.message).toMatch(/SHA-256 differs/);
    const untrusted = await failure(() => previewFromCatalog(admin, { catalog: `${catalogBase}/plain.json`, name: 'keyword-tags' }));
    expect(untrusted.message).toMatch(/isn't by a key this a4a trusts/);
    const unsigned = await failure(() => previewFromCatalog(admin, { catalog: `${catalogBase}/signed.json`, name: 'keyword-tags' }));
    expect(unsigned.message).toMatch(/isn't signed, and its catalog signs/);
    const elsewhere = await failure(() => previewFromCatalog(admin, { catalog: 'https://apps.example.com/catalog.json', name: 'x' }));
    expect(elsewhere.message).toMatch(/isn't one of the catalogs/);
  });

  it('update an app, asking again only for what it adds', async () => {
    const preview = await previewFromCatalog(admin, { catalog: `${catalogBase}/signed.json`, name: 'time-by-person' });
    expect(preview).toMatchObject({ version: '1.1.0', installed: { version: '1.0.0' }, more: { read: ['comments'], write: [] } });
    expect(preview.signedBy).toMatch(/^[0-9a-f]{16}$/);
    const asks = await failure(() => installFromCatalog(admin, { catalog: `${catalogBase}/signed.json`, name: 'time-by-person' }));
    expect(asks).toMatchObject({ status: 409, code: 'consent_required' });
    const updated = await installFromCatalog(admin, { catalog: `${catalogBase}/signed.json`, name: 'time-by-person', accept: { read: ['comments', 'issues', 'time'], write: [] } });
    expect(updated).toMatchObject({ version: '1.1.0', granted: { read: ['comments', 'issues', 'time'], write: [] }, source: { kind: 'catalog' } });
    // Back to what it was: asking for less needs no consent, and the grant narrows with it.
    const narrower = variant('time-by-person', (m) => {
      m.version = '1.2.0';
    });
    const back = await updatePackage(admin, 'time-by-person', { package: b64(narrower) });
    expect(back).toMatchObject({ version: '1.2.0', granted: TIME });
  });
});

describe('removing', () => {
  it('says what goes, then takes it all: rules, files, settings, storage, runs and its agent', async () => {
    const said = await appRemoval(admin, 'keyword-tags');
    expect(said).toMatchObject({ name: 'keyword-tags', rules: 1, widgets: 0, handlers: 0, agent: 'app-keyword-tags' });
    expect(said.settings).toBe(1);
    const [row] = await w.app.db.select().from(apps).where(eq(apps.name, 'keyword-tags'));
    await removeApp(admin, 'keyword-tags');
    for (const table of [appFiles, appSettings, appStorage, appRuns, appProjects, rules] as const) {
      expect(await w.app.db.select().from(table).where(eq(table.appId, row!.id))).toEqual([]);
    }
    expect(await w.app.db.select().from(apps).where(eq(apps.id, row!.id))).toEqual([]);
    // History names its agent (what its rule tagged), so the account stays, banned.
    const [agent] = await w.app.db.select().from(users).where(eq(users.id, row!.agentId));
    expect(agent?.banned ?? true).toBe(true);
  });
});
