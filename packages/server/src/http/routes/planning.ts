import type { OpenAPIHono } from '@hono/zod-openapi';
import {
  BaselineBody,
  BaselineSchema,
  CostReportSchema,
  LevelBody,
  LevelingResultSchema,
  ResourceLoadSchema,
  ResourceQuery,
  ScheduleQuery,
  ScheduleSchema,
  WhatIfBody,
  WhatIfResultSchema,
} from '@a4a/shared';
import { z } from 'zod';
import {
  createBaseline,
  deleteBaseline,
  getBaseline,
  getCostReport,
  getResourceLoad,
  getSchedule,
  level,
  listBaselines,
  whatIfSchedule,
} from '../../services/planning';
import type { HttpEnv } from '../env';
import { route } from '../route';

const Key = z.object({ key: z.string() });

export function planningRoutes(app: OpenAPIHono<HttpEnv>) {
  const tags = ['Planning'];
  route(
    app,
    {
      method: 'get',
      path: '/projects/{key}/schedule', guests: true,
      tags,
      summary: "The project's schedule: critical path, slack, late tasks, baseline variance",
      description:
        'Computed on request from Estimation, Start date, Due date, Assignee, subtask links (summary rows) and "depends on" links (finish-to-start), over the project\'s working calendar.',
      params: Key,
      query: ScheduleQuery,
      response: ScheduleSchema,
    },
    ({ ctx, params, query }) => getSchedule(ctx, params.key, query),
  );
  route(
    app,
    {
      method: 'post',
      path: '/projects/{key}/schedule/what-if',
      tags,
      summary: 'What if a task slips, is re-estimated or re-assigned? (nothing is saved)',
      params: Key,
      body: WhatIfBody,
      response: WhatIfResultSchema,
      status: 200,
    },
    ({ ctx, params, body }) => whatIfSchedule(ctx, params.key, body),
  );
  route(app, { method: 'get', path: '/projects/{key}/resources', tags, summary: 'Load per person and day against capacity', params: Key, query: ResourceQuery, response: ResourceLoadSchema }, ({ ctx, params, query }) =>
    getResourceLoad(ctx, params.key, query),
  );
  route(
    app,
    {
      method: 'post',
      path: '/projects/{key}/level',
      tags,
      summary: 'Level resources: propose (dryRun, default) or apply new task starts',
      description: 'Applying writes each moved task\'s Start date; due dates never change. within_slack never moves the finish date.',
      params: Key,
      body: LevelBody,
      response: LevelingResultSchema,
      status: 200,
    },
    ({ ctx, params, body }) => level(ctx, params.key, body),
  );
  route(app, { method: 'get', path: '/projects/{key}/costs', tags, summary: 'Budget, planned, actual and forecast cost; earned value with a baseline', params: Key, query: z.object({ baseline: z.string().optional() }), response: CostReportSchema }, ({ ctx, params, query }) =>
    getCostReport(ctx, params.key, query),
  );
  route(app, { method: 'get', path: '/projects/{key}/baselines', tags, summary: "A project's baselines", params: Key, response: z.array(BaselineSchema) }, ({ ctx, params }) => listBaselines(ctx, params.key));
  route(app, { method: 'post', path: '/projects/{key}/baselines', tags, summary: 'Save the current plan as a baseline', params: Key, body: BaselineBody, response: BaselineSchema }, ({ ctx, params, body }) =>
    createBaseline(ctx, params.key, body),
  );
  route(app, { method: 'get', path: '/baselines/{id}', tags, summary: 'Get a baseline', params: z.object({ id: z.string() }), response: BaselineSchema }, ({ ctx, params }) => getBaseline(ctx, params.id));
  route(app, { method: 'delete', path: '/baselines/{id}', tags, summary: 'Delete a baseline', params: z.object({ id: z.string() }), status: 204 }, async ({ ctx, params }) => {
    await deleteBaseline(ctx, params.id);
    return null;
  });
}
