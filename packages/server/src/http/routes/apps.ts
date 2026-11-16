import type { OpenAPIHono } from '@hono/zod-openapi';
import {
  APP_EXTENSION_POINTS,
  AppExtensionSchema,
  AppHandlerBody,
  AppHandlerResultSchema,
  AppPackageBody,
  AppPackagePreviewSchema,
  AppRemovalSchema,
  AppRunSchema,
  AppSchema,
  AppSettingsSchema,
  AppStorageBody,
  AppStorageSchema,
  CatalogInstallBody,
  CatalogListSchema,
  CatalogPickBody,
  InstallAppBody,
  ProjectAppSchema,
  SetAppSettingsBody,
  UpdateAppBody,
  UpdateAppPackageBody,
} from '@a4a/shared';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { Runtime } from '../../app-services';
import { WIDGET_KIT } from '../../apps/kit';
import { safePath } from '../../apps/package';
import {
  appExtensions,
  appFile,
  appRemoval,
  callHandler,
  getApp,
  getAppSettings,
  getAppStorage,
  installFromCatalog,
  installPackage,
  listAppRuns,
  listApps,
  listCatalog,
  previewFromCatalog,
  previewPackage,
  projectApps,
  removeApp,
  setAppSettings,
  setAppStorage,
  setProjectApp,
  updateApp,
  updatePackage,
} from '../../services/apps';
import type { HttpEnv } from '../env';
import { route } from '../route';

const name = z.object({ name: z.string().describe('The app, by its name') });

/** Apps (docs/architecture.md, D48): installing them, where they run, their settings, storage and handlers. */
export function appRoutes(app: OpenAPIHono<HttpEnv>) {
  const tags = ['Apps'];
  route(app, { method: 'get', path: '/apps', tags, summary: 'Installed apps (admin)', response: z.array(AppSchema) }, ({ ctx }) => listApps(ctx));
  route(
    app,
    {
      method: 'post',
      path: '/apps/preview',
      tags,
      summary: 'Read a package: what it is, adds and asks for (admin, signed in)',
      description: 'Nothing is kept. The zip, base64-encoded, as `package`. Its manifest, files and scripts are checked as installing would check them.',
      body: AppPackageBody,
      response: AppPackagePreviewSchema,
      status: 200,
    },
    ({ ctx, body }) => previewPackage(ctx, body.package),
  );
  route(
    app,
    {
      method: 'post',
      path: '/apps',
      tags,
      summary: 'Install an app from a package (admin, signed in)',
      description:
        "`accept` is what you accept it may do: exactly what it asks for. `allProjects`, or `projects`, say where it runs. Its agent is made for it (`app-<name>`): its rules act as that agent. A token, an agent or MCP can't install an app.",
      body: InstallAppBody,
      response: AppSchema,
    },
    ({ ctx, body }) => installPackage(ctx, body),
  );
  route(app, { method: 'get', path: '/apps/catalog', tags, summary: "The catalogs' apps (admin)", description: 'From APP_CATALOGS, newest version of each, with what is installed here.', response: CatalogListSchema }, ({ ctx }) =>
    listCatalog(ctx),
  );
  route(
    app,
    { method: 'post', path: '/apps/catalog/preview', tags, summary: "Read a catalog's app: what it is and asks for (admin, signed in)", body: CatalogPickBody, response: AppPackagePreviewSchema, status: 200 },
    ({ ctx, body }) => previewFromCatalog(ctx, body),
  );
  route(
    app,
    {
      method: 'post',
      path: '/apps/catalog/install',
      tags,
      summary: "Install a catalog's app, or update the installed one to it (admin, signed in)",
      description: "Its package must be the one the catalog names (SHA-256), and signed by a trusted key when the catalog signs. An update asks again (409 consent_required) only when it asks for more.",
      body: CatalogInstallBody,
      response: AppSchema,
    },
    ({ ctx, body }) => installFromCatalog(ctx, body),
  );
  route(
    app,
    {
      method: 'get',
      path: '/apps/extensions',
      tags,
      summary: 'The widgets to draw at a place',
      description: "For an issue, an article or a project: the widgets of apps that run in its project. For the main menu and dashboards: those of apps that run anywhere you read. Each has the signed address its frame loads from.",
      query: z.object({
        at: z.enum(APP_EXTENSION_POINTS),
        issue: z.string().optional(),
        project: z.string().optional(),
        article: z.string().optional(),
      }),
      response: z.array(AppExtensionSchema),
    },
    ({ ctx, query }) => appExtensions(ctx, query),
  );
  route(app, { method: 'get', path: '/apps/{name}', tags, summary: 'An installed app (admin)', params: name, response: AppSchema }, ({ ctx, params }) => getApp(ctx, params.name));
  route(
    app,
    { method: 'patch', path: '/apps/{name}', tags, summary: 'Turn an app on or off, or choose where it runs (admin)', params: name, body: UpdateAppBody, response: AppSchema },
    ({ ctx, params, body }) => updateApp(ctx, params.name, body),
  );
  route(
    app,
    {
      method: 'put',
      path: '/apps/{name}/package',
      tags,
      summary: 'Update an app from a newer package (admin, signed in)',
      description: 'It asks again (409 consent_required, with what more) only when the new version asks for more than it was granted: then send `accept`, all it asks for.',
      params: name,
      body: UpdateAppPackageBody,
      response: AppSchema,
    },
    ({ ctx, params, body }) => updatePackage(ctx, params.name, body),
  );
  route(app, { method: 'get', path: '/apps/{name}/removal', tags, summary: 'What removing an app takes with it (admin)', params: name, response: AppRemovalSchema }, ({ ctx, params }) =>
    appRemoval(ctx, params.name),
  );
  route(app, { method: 'delete', path: '/apps/{name}', tags, summary: 'Remove an app and all it brought (admin, signed in)', params: name, status: 204 }, async ({ ctx, params }) => {
    await removeApp(ctx, params.name);
    return null;
  });
  route(app, { method: 'get', path: '/apps/{name}/runs', tags, summary: "What an app's handlers and rules did (admin)", params: name, response: z.array(AppRunSchema) }, ({ ctx, params }) =>
    listAppRuns(ctx, params.name),
  );
  route(
    app,
    {
      method: 'get',
      path: '/apps/{name}/settings',
      tags,
      summary: "An app's settings: its own (admin), or a project's (its managers)",
      description: 'A secret reads as `{ set: true }` or `{ set: false }`, never its value.',
      params: name,
      query: z.object({ project: z.string().optional() }),
      response: AppSettingsSchema,
    },
    ({ ctx, params, query }) => getAppSettings(ctx, params.name, query.project ?? null),
  );
  route(
    app,
    { method: 'put', path: '/apps/{name}/settings', tags, summary: "Set an app's settings: its own (admin), or a project's (its managers)", params: name, body: SetAppSettingsBody, response: AppSettingsSchema },
    ({ ctx, params, body }) => setAppSettings(ctx, params.name, body),
  );
  route(
    app,
    {
      method: 'get',
      path: '/apps/{name}/storage',
      tags,
      summary: 'What an app keeps: its own, or a project’s',
      params: name,
      query: z.object({ project: z.string().optional() }),
      response: AppStorageSchema,
    },
    ({ ctx, params, query }) => getAppStorage(ctx, params.name, query.project),
  );
  route(
    app,
    {
      method: 'put',
      path: '/apps/{name}/storage/{key}',
      tags,
      summary: 'Keep a value for an app (a project’s: someone who changes its issues; its own: an administrator)',
      params: name.extend({ key: z.string() }),
      query: z.object({ project: z.string().optional() }),
      body: AppStorageBody,
      response: AppStorageSchema,
    },
    ({ ctx, params, query, body }) => setAppStorage(ctx, params.name, params.key, body.value ?? null, query.project),
  );
  route(
    app,
    {
      method: 'delete',
      path: '/apps/{name}/storage/{key}',
      tags,
      summary: 'Forget a value an app keeps',
      params: name.extend({ key: z.string() }),
      query: z.object({ project: z.string().optional() }),
      response: AppStorageSchema,
      status: 200,
    },
    ({ ctx, params, query }) => setAppStorage(ctx, params.name, params.key, null, query.project),
  );
  route(
    app,
    {
      method: 'post',
      path: '/apps/{name}/handlers/{handler}',
      tags,
      summary: "Call an app's handler, about an issue or a project",
      description:
        "It runs in D40's sandbox, with what it uses and you can see. What it changes is done as you, through the app, and its history says so. It answers what it gave respond().",
      params: name.extend({ handler: z.string() }),
      body: AppHandlerBody,
      bodyOptional: true,
      response: AppHandlerResultSchema,
      status: 200,
    },
    ({ c, ctx, params, body }) => callHandler(ctx, params.name, params.handler, body ?? {}, { method: 'POST', query: c.req.query() }),
  );
  route(
    app,
    {
      method: 'get',
      path: '/apps/{name}/handlers/{handler}',
      tags,
      summary: "Call an app's handler with a query (issue=, project=, and its own)",
      params: name.extend({ handler: z.string() }),
      query: z.object({ issue: z.string().optional(), project: z.string().optional() }).passthrough(),
      response: AppHandlerResultSchema,
    },
    ({ c, ctx, params, query }) => callHandler(ctx, params.name, params.handler, { issue: query.issue, project: query.project }, { method: 'GET', query: c.req.query() }),
  );
  route(app, { method: 'get', path: '/projects/{key}/apps', tags, summary: "The apps chosen for a project (its managers)", params: z.object({ key: z.string() }), response: z.array(ProjectAppSchema) }, ({ ctx, params }) =>
    projectApps(ctx, params.key),
  );
  route(
    app,
    {
      method: 'put',
      path: '/projects/{key}/apps/{name}',
      tags,
      summary: 'Turn an app off in a project, or back on (its managers)',
      description: 'Only where an administrator chose it, or chose every project.',
      params: z.object({ key: z.string(), name: z.string() }),
      body: z.object({ on: z.boolean() }),
      response: ProjectAppSchema,
    },
    ({ ctx, params, body }) => setProjectApp(ctx, params.key, params.name, body.on),
  );
}

/** The content security policy an app's files are served under: their own frame, sandboxed, reaching nothing. */
export const APP_FILE_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; media-src 'self'; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'; sandbox allow-scripts allow-forms";

/** The widget kit, and an app's files by the signed addresses widgets load from. */
export function mountAppFiles(root: Hono<HttpEnv>, runtime: Runtime) {
  root.get('/app-kit/a4a-app.js', (c) => {
    c.header('cache-control', 'public, max-age=3600');
    return c.body(WIDGET_KIT, 200, { 'content-type': 'text/javascript; charset=utf-8' });
  });
  root.get('/app-files/:token/*', async (c) => {
    const token = c.req.param('token');
    const rest = decodeURIComponent(c.req.path.slice(`/app-files/${token}/`.length));
    const path = safePath(rest);
    const file = path ? await appFile(runtime, token, path) : null;
    if (!file) return c.text('Not found', 404);
    c.header('content-security-policy', APP_FILE_CSP);
    c.header('x-frame-options', 'SAMEORIGIN');
    c.header('cache-control', 'private, max-age=3600');
    c.header('referrer-policy', 'no-referrer');
    return c.body(new Uint8Array(file.content), 200, { 'content-type': file.contentType });
  });
}
