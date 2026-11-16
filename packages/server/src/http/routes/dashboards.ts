import type { OpenAPIHono } from '@hono/zod-openapi';
import { DashboardBody, DashboardSchema, UpdateDashboardBody } from '@a4a/shared';
import { z } from 'zod';
import { createDashboard, defaultDashboard, deleteDashboard, getDashboard, listDashboards, updateDashboard } from '../../services/dashboards';
import type { HttpEnv } from '../env';
import { route } from '../route';

const Id = z.object({ id: z.string() });

export function dashboardRoutes(app: OpenAPIHono<HttpEnv>) {
  const tags = ['Dashboards'];
  route(app, { method: 'get', path: '/dashboards', tags, summary: 'Your dashboards, and the shared ones', response: z.array(DashboardSchema) }, ({ ctx }) => listDashboards(ctx));
  route(
    app,
    {
      method: 'get',
      path: '/dashboards/default',
      tags,
      summary: 'The dashboard a4a starts someone with: worked out, not saved',
      description: 'Your open issues, the current sprint of a board you can see, created against resolved, and cycle time. Save it with POST /dashboards to make it yours.',
      response: DashboardSchema,
    },
    ({ ctx }) => defaultDashboard(ctx),
  );
  route(
    app,
    {
      method: 'post',
      path: '/dashboards',
      tags,
      summary: 'Create a dashboard',
      description: 'Widgets are a report with its parameters (`kind: "report"`), a saved search or query shown as a count or a list (`kind: "search"`), or a note in Markdown (`kind: "note"`), each half or full width, in order.',
      body: DashboardBody,
      response: DashboardSchema,
    },
    ({ ctx, body }) => createDashboard(ctx, body),
  );
  route(app, { method: 'get', path: '/dashboards/{id}', tags, summary: 'Get a dashboard', params: Id, response: DashboardSchema }, ({ ctx, params }) => getDashboard(ctx, params.id));
  route(
    app,
    {
      method: 'patch',
      path: '/dashboards/{id}',
      tags,
      summary: 'Change a dashboard: its name, whether it is shared, its widgets and their order',
      description: 'Send expectedVersion to get 409 instead of overwriting a change someone else made meanwhile.',
      params: Id,
      body: UpdateDashboardBody,
      response: DashboardSchema,
    },
    ({ ctx, params, body }) => updateDashboard(ctx, params.id, body),
  );
  route(app, { method: 'delete', path: '/dashboards/{id}', tags, summary: 'Delete a dashboard', params: Id, status: 204 }, async ({ ctx, params }) => {
    await deleteDashboard(ctx, params.id);
    return null;
  });
}
