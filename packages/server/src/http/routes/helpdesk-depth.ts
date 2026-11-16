/**
 * The help desk in depth (docs/architecture.md, D45): SLA policies and their report, a desk's own
 * mailbox, the requesters' portal, and the kinds of change a person is told of.
 */
import type { OpenAPIHono } from '@hono/zod-openapi';
import { SlaPolicyBody, SlaPolicyOrderBody, SlaPolicySchema, SlaReportSchema } from '@a4a/shared';
import { z } from 'zod';
import { createPolicy, deletePolicy, listPolicies, reorderPolicies, slaReport, updatePolicy } from '../../services/sla';
import type { HttpEnv } from '../env';
import { route } from '../route';

const Key = z.object({ key: z.string().min(1).max(10) });
const KeyId = Key.extend({ id: z.string().min(1) });

export function helpdeskDepthRoutes(app: OpenAPIHono<HttpEnv>) {
  const tags = ['Help desk'];

  route(
    app,
    { method: 'get', path: '/projects/{key}/sla-policies', tags, summary: "A desk's SLA policies, in the order they're tried", params: Key, response: z.array(SlaPolicySchema) },
    ({ ctx, params }) => listPolicies(ctx, params.key),
  );
  route(
    app,
    {
      method: 'post',
      path: '/projects/{key}/sla-policies',
      tags,
      summary: 'Add an SLA policy',
      description:
        "The project's managers. Targets are business minutes, in the desk's working hours (`settings.helpdesk.businessHours`). The first policy also puts the \"SLA status\" field on the project, which the help desk's agent keeps.",
      params: Key,
      body: SlaPolicyBody,
      response: SlaPolicySchema,
      status: 201,
    },
    ({ ctx, params, body }) => createPolicy(ctx, params.key, body),
  );
  route(
    app,
    { method: 'put', path: '/projects/{key}/sla-policies/{id}', tags, summary: 'Change an SLA policy', description: 'Its open requests follow it now.', params: KeyId, body: SlaPolicyBody, response: SlaPolicySchema },
    ({ ctx, params, body }) => updatePolicy(ctx, params.key, params.id, body),
  );
  route(
    app,
    { method: 'delete', path: '/projects/{key}/sla-policies/{id}', tags, summary: 'Delete an SLA policy', description: "Targets it stopped stay as they were; ones still counting follow the desk's other policies.", params: KeyId, status: 204 },
    async ({ ctx, params }) => {
      await deletePolicy(ctx, params.key, params.id);
      return null;
    },
  );
  route(
    app,
    { method: 'put', path: '/projects/{key}/sla-policies-order', tags, summary: 'Order the SLA policies', params: Key, body: SlaPolicyOrderBody, response: z.array(SlaPolicySchema) },
    ({ ctx, params, body }) => reorderPolicies(ctx, params.key, body.ids),
  );
  route(
    app,
    {
      method: 'get',
      path: '/projects/{key}/sla-report',
      tags,
      summary: 'Met and breached, by policy, per week',
      description: "Each target counts in the week it was met or went past. Weeks start on Monday, in `tz` (the desk's working hours' zone by default). Twelve weeks to `to` (today) unless `from` says.",
      params: Key,
      query: z.object({ from: z.string().optional(), to: z.string().optional(), tz: z.string().optional() }),
      response: SlaReportSchema,
    },
    ({ ctx, params, query }) => slaReport(ctx, params.key, { from: query.from, to: query.to, timeZone: query.tz }),
  );
}
