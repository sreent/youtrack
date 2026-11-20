import type { OpenAPIHono } from '@hono/zod-openapi';
import {
  IssueDetailSchema,
  IssueWorkflowSchema,
  RuleBody,
  RuleCheckBody,
  RuleCheckResultSchema,
  RulePreviewSchema,
  RuleRunSchema,
  RuleSchema,
  RuleTestBody,
  RunActionBody,
  ScriptRunSchema,
  StateMachineBody,
  StateMachineSchema,
  TransitionBody,
  UpdateRuleBody,
  UpdateStateMachineBody,
  UpdateWorkflowActionBody,
  WorkflowActionBody,
  WorkflowActionSchema,
} from '@a4a/shared';
import { z } from 'zod';
import { createAction, deleteAction, issueWorkflow, listActions, runAction, runTransition, updateAction } from '../../workflow/actions';
import { createMachine, deleteMachine, getMachine, listMachines, updateMachine } from '../../workflow/machines';
import { checkRulePart, createRule, deleteRule, getRule, listRuleRuns, listRules, previewRule, scriptLibrary, setScriptLibrary, testRule, updateRule } from '../../workflow/rules';
import type { HttpEnv } from '../env';
import { route } from '../route';
import { SCRIPT_LIMITS } from '../../workflow/sandbox';

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
  route(
    app,
    {
      method: 'post',
      path: '/rules/test',
      tags,
      summary: "Run a rule's script on one issue, as a dry run (administrators)",
      description:
        'A scripted rule (D40) runs its JavaScript in a sandbox: no network, files or timers, 250 ms and 16 MB a run (a guard: 60 ms). This runs it on `issue` as it is now and says what it would do: what it logged, what it refused, and what each command it asked for would change (the executor\'s dry run). Nothing is saved or changed.',
      body: RuleTestBody,
      response: ScriptRunSchema,
      status: 200,
    },
    ({ ctx, body }) => testRule(ctx, body),
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

  // A project's shared code for its scripts (D40's revisit): every script in it runs with it as `library`.
  route(
    app,
    {
      method: 'get',
      path: '/projects/{key}/script-library',
      tags,
      summary: "A project's script library",
      description: "The shared code every script in the project runs with, as `library`. Its managers read it; its administrators write it, its syntax checked as a script's is.",
      params: z.object({ key: z.string().min(1).max(40) }),
      response: z.object({ source: z.string() }),
    },
    async ({ ctx, params }) => ({ source: await scriptLibrary(ctx, params.key) }),
  );
  route(
    app,
    {
      method: 'put',
      path: '/projects/{key}/script-library',
      tags,
      summary: "Save a project's script library",
      description: "Administrators alone. Every script in the project runs with it as `library`, whatever the library returns. Nothing in it runs on its own: only as a script's shared code.",
      params: z.object({ key: z.string().min(1).max(40) }),
      body: z.object({ source: z.string().max(SCRIPT_LIMITS.librarySource) }),
      response: z.object({ source: z.string() }),
    },
    async ({ ctx, params, body }) => ({ source: await setScriptLibrary(ctx, params.key, body.source) }),
  );

  const machineTags = ['State machines'];
  route(
    app,
    {
      method: 'get',
      path: '/state-machines',
      tags: machineTags,
      summary: "A project's state machines",
      description: 'For each state field it governs: its states, its named transitions (from, to, an optional condition and command), and what in it no longer reads.',
      query: z.object({ project: z.string().describe('Project key') }),
      response: z.array(StateMachineSchema),
    },
    ({ ctx, query }) => listMachines(ctx, query.project),
  );
  route(
    app,
    {
      method: 'post',
      path: '/state-machines',
      tags: machineTags,
      summary: "Make a state machine for a state field (the project's manager)",
      description:
        'From then on a change to the field must be one of its transitions, however it is made (the issue page, a board, a command, an agent, a rule): otherwise it is refused with 422 `refused_by_state_machine`, saying where the issue can go. A transition with a condition needs the issue to match it first; one with a command applies it too, as whoever makes the move. A change from or to no value, an import and an undo are free.',
      body: StateMachineBody,
      response: StateMachineSchema,
    },
    ({ ctx, body }) => createMachine(ctx, body),
  );
  route(app, { method: 'get', path: '/state-machines/{id}', tags: machineTags, summary: 'A state machine', params: Id, response: StateMachineSchema }, ({ ctx, params }) => getMachine(ctx, params.id));
  route(
    app,
    {
      method: 'patch',
      path: '/state-machines/{id}',
      tags: machineTags,
      summary: 'Change a state machine, or turn it off',
      params: Id,
      body: UpdateStateMachineBody,
      response: StateMachineSchema,
    },
    ({ ctx, params, body }) => updateMachine(ctx, params.id, body),
  );
  route(app, { method: 'delete', path: '/state-machines/{id}', tags: machineTags, summary: 'Delete a state machine', params: Id, status: 204 }, async ({ ctx, params }) => {
    await deleteMachine(ctx, params.id);
    return null;
  });

  const actionTags = ['Custom actions'];
  route(
    app,
    {
      method: 'get',
      path: '/workflow-actions',
      tags: actionTags,
      summary: "A project's custom actions",
      query: z.object({ project: z.string().describe('Project key') }),
      response: z.array(WorkflowActionSchema),
    },
    ({ ctx, query }) => listActions(ctx, query.project),
  );
  route(
    app,
    {
      method: 'post',
      path: '/workflow-actions',
      tags: actionTags,
      summary: "Make a custom action (the project's manager; a scripted one, an administrator)",
      description:
        "A named action: a command, or a script run in the sandbox. The issue page shows it as a button where its condition holds, and its name reads as a command (e.g. `apply_command` with `Escalate`), for anyone who may change the issue. It runs as them.",
      body: WorkflowActionBody,
      response: WorkflowActionSchema,
    },
    ({ ctx, body }) => createAction(ctx, body),
  );
  route(
    app,
    {
      method: 'patch',
      path: '/workflow-actions/{id}',
      tags: actionTags,
      summary: 'Change a custom action, or turn it off',
      params: Id,
      body: UpdateWorkflowActionBody,
      response: WorkflowActionSchema,
    },
    ({ ctx, params, body }) => updateAction(ctx, params.id, body),
  );
  route(app, { method: 'delete', path: '/workflow-actions/{id}', tags: actionTags, summary: 'Delete a custom action', params: Id, status: 204 }, async ({ ctx, params }) => {
    await deleteAction(ctx, params.id);
    return null;
  });

  const IssueId = z.object({ id: z.string().describe('Readable id, e.g. BACK-12') });
  route(
    app,
    {
      method: 'get',
      path: '/issues/{id}/workflow',
      tags: actionTags,
      summary: 'What you can do to an issue by its workflows: transitions and actions',
      description: "The transitions out of the state it is in (with why one can't be made now) and the actions offered for it. Empty for someone who can't change it.",
      params: IssueId,
      response: IssueWorkflowSchema,
    },
    ({ ctx, params }) => issueWorkflow(ctx, params.id),
  );
  route(
    app,
    {
      method: 'post',
      path: '/issues/{id}/transitions',
      tags: actionTags,
      summary: 'Make a transition, by name',
      params: IssueId,
      body: TransitionBody,
      response: IssueDetailSchema,
      status: 200,
    },
    ({ ctx, params, body }) => runTransition(ctx, params.id, body),
  );
  route(
    app,
    {
      method: 'post',
      path: '/issues/{id}/actions/{action}',
      tags: actionTags,
      summary: 'Run a custom action on an issue',
      description: 'As you: you must be able to change the issue. A scripted action may change the issue and issues linked to it in its project, all or nothing; `refuse()` in it answers 422 `refused_by_action`.',
      params: z.object({ id: z.string(), action: z.string().describe('The action id') }),
      body: RunActionBody,
      response: IssueDetailSchema,
      status: 200,
    },
    ({ ctx, params, body }) => runAction(ctx, params.id, params.action, body),
  );
}
