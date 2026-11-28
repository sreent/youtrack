import type { OpenAPIHono } from '@hono/zod-openapi';
import type { HttpEnv } from '../env';

/**
 * Plans of a search (docs/architecture.md, D72): the routes under /plans, each taking a PlanScope, and a
 * saved search's baselines and order. Registered in http/app.ts, so the packages that bring them add
 * their routes here and touch no registry: P2 `GET /plans/schedule` and `POST /plans/what-if`, P6
 * moves, drafts, checks and a search's order, and Phase 2 the table, workload and summary.
 */
export function plansRoutes(app: OpenAPIHono<HttpEnv>) {
  // Nothing yet: each route comes with its package, through route() and its schemas in @a4a/shared.
  void app;
}
