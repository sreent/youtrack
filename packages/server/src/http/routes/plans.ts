import type { OpenAPIHono } from '@hono/zod-openapi';
import { BaselineSchema, planScopeOf, PlanScheduleQuery, PlanScheduleSchema, PlanWhatIfBody, PlanWhatIfResultSchema, SavedSearchBaselineBody } from '@a4a/shared';
import { z } from 'zod';
import { createSearchBaseline, getPlanSchedule, listSearchBaselines, whatIfPlan } from '../../services/planning';
import type { HttpEnv } from '../env';
import { route } from '../route';

/**
 * Plans of a search (docs/architecture.md, D72): the routes under /plans, each taking a PlanScope, and a
 * saved search's baselines and order. Registered in http/app.ts, so the packages that bring them add
 * their routes here and touch no registry: P2 `GET /plans/schedule` and `POST /plans/what-if`, P6
 * moves, drafts, checks and a search's order, and Phase 2 the table, workload and summary.
 */
export function plansRoutes(app: OpenAPIHono<HttpEnv>) {
  const tags = ['Planning'];
  route(
    app,
    {
      method: 'get',
      path: '/plans/schedule',
      tags,
      summary: 'The plan of a search, in one project or several: critical path, slack, late tasks, baseline variance',
      description:
        'The issues a saved search (`savedSearch`) or a query (`query`, empty for every issue you can see) finds, narrowed to one project by `project`, planned as GET /projects/{key}/schedule plans a project: each issue on its own project\'s calendar, then its assignee\'s week and days away (D73). A plan holds at most 2,000 issues, the first by project and number: `total` says how many the scope holds, and `truncated` that the plan holds fewer. Each task says its project and calendar, whether you may change it (`editable`), and the dates and work people set, in its project\'s fields (`set`). Money takes the costs permission in each task\'s project.',
      query: PlanScheduleQuery,
      response: PlanScheduleSchema,
    },
    ({ ctx, query }) => getPlanSchedule(ctx, planScopeOf(query), { baseline: query.baseline }),
  );
  route(
    app,
    {
      method: 'post',
      path: '/plans/what-if',
      tags,
      summary: 'What if tasks of a plan of a search slip, are re-estimated or re-assigned? (nothing is saved)',
      description: 'The plan of `scope`, as GET /plans/schedule reads it, with each override applied as POST /projects/{key}/schedule/what-if applies it.',
      body: PlanWhatIfBody,
      response: PlanWhatIfResultSchema,
      status: 200,
    },
    ({ ctx, body }) => whatIfPlan(ctx, body),
  );
  const SearchId = z.object({ id: z.string().max(64) });
  route(
    app,
    {
      method: 'get',
      path: '/saved-searches/{id}/baselines',
      tags,
      summary: "A saved search's baselines",
      description: 'Whoever reads the saved search reads its baselines (D72), as they see them: its tasks they see, and money only where they have the costs permission.',
      params: SearchId,
      response: z.array(BaselineSchema),
    },
    ({ ctx, params }) => listSearchBaselines(ctx, params.id),
  );
  route(
    app,
    {
      method: 'post',
      path: '/saved-searches/{id}/baselines',
      tags,
      summary: "Save a saved search's plan as it stands as a baseline",
      description:
        "Its owner takes it, managing every project the search holds at that moment, or an administrator (D72). Compare with it through GET /plans/schedule?savedSearch={id}&baseline=…; GET and DELETE /baselines/{id} read and delete it.",
      params: SearchId,
      body: SavedSearchBaselineBody,
      response: BaselineSchema,
    },
    ({ ctx, params, body }) => createSearchBaseline(ctx, params.id, body),
  );
}
