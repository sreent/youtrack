import type { OpenAPIHono } from '@hono/zod-openapi';
import { RuleBody, RuleCheckBody, RuleCheckResultSchema, RulePreviewSchema, RuleRunSchema, RuleSchema, UpdateRuleBody } from '@a4a/shared';
import { z } from 'zod';
import { checkRulePart, createRule, deleteRule, getRule, listRuleRuns, listRules, previewRule, updateRule } from '../../workflow/rules';
import type { HttpEnv } from '../env';
import { route } from '../route';

const Id = z.object({ id: z.string() });

export function workflowRoutes(app: OpenAPIHono<HttpEnv>) {
  const tags = ['Workflow rules'];
  route(
    app,
    {
      method: 'get',
      path: '/rules',
      tags,
      summary: 'Workflow rules',
      description: "With `project`, the rules that apply in it: its own and the global ones. Without, every rule you can see. Each says itself in words, and lists what in it no longer reads.",
      query: z.object({ project: z.string().optional().describe('Project key') }),
      response: z.array(RuleSchema),
    },
    ({ ctx, query }) => listRules(ctx, { project: query.project }),
  );
  route(
    app,
    {
      method: 'post',
      path: '/rules',
      tags,
      summary: "Make a rule (the project's manager, or an administrator)",
      description:
        'Three kinds. **change**: when an issue is created, changes (optionally only a named field) or gets a comment, and the issue then matches `query`, `command` is applied. **schedule**: every hour, day or weekday at a time, every issue matching `query` gets `command`. **guard**: a change that would make an issue match `query` must leave it matching `requires` too, or it is refused with `message`. Rules apply as the workflow agent, with channel `automation`. Global rules (`project: null`) are for administrators.',
      body: RuleBody,
      response: RuleSchema,
    },
    ({ ctx, body }) => createRule(ctx, body),
  );
  route(
    app,
    {
      method: 'post',
      path: '/rules/preview',
      tags,
      summary: 'Preview a rule before saving it',
      description:
        'Its problems, each where it is; how many issues match it now; and what its command would change on a few of them, through the command executor\'s dry run. A guard says how many issues already break it. Nothing is saved or changed.',
      body: RuleBody,
      response: RulePreviewSchema,
      status: 200,
    },
    ({ ctx, body }) => previewRule(ctx, body),
  );
  route(
    app,
    {
      method: 'post',
      path: '/rules/check',
      tags,
      summary: "Check one part of a rule as it's typed, with completions at the caret",
      body: RuleCheckBody,
      response: RuleCheckResultSchema,
      status: 200,
    },
    ({ ctx, body }) => checkRulePart(ctx, body),
  );
  route(app, { method: 'get', path: '/rules/{id}', tags, summary: 'A rule', params: Id, response: RuleSchema }, ({ ctx, params }) => getRule(ctx, params.id));
  route(
    app,
    {
      method: 'patch',
      path: '/rules/{id}',
      tags,
      summary: 'Change a rule, or turn it off (`enabled: false`)',
      description: 'Only what is sent changes. Turning a rule off never waits on fixing it. Send `expectedVersion` to get 409 rather than overwrite someone else\'s change.',
      params: Id,
      body: UpdateRuleBody,
      response: RuleSchema,
    },
    ({ ctx, params, body }) => updateRule(ctx, params.id, body),
  );
  route(app, { method: 'delete', path: '/rules/{id}', tags, summary: 'Delete a rule and its run log', params: Id, status: 204 }, async ({ ctx, params }) => {
    await deleteRule(ctx, params.id);
    return null;
  });
  route(
    app,
    {
      method: 'get',
      path: '/rule-runs',
      tags,
      summary: 'The run log: what rules did, issue by issue',
      description: 'Each run: the rule, the issue, how it went (applied, unchanged, failed, skipped, refused), why, the changes and when. Newest first; kept for 30 days.',
      query: z.object({
        project: z.string().optional().describe('Project key'),
        rule: z.string().optional().describe('Rule id'),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      }),
      response: z.array(RuleRunSchema),
    },
    ({ ctx, query }) => listRuleRuns(ctx, query),
  );
}
