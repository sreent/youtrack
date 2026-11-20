import type { OpenAPIHono } from '@hono/zod-openapi';
import {
  BacklogSchema,
  RankBody,
  SprintPlanSchema,
  StopTimerBody,
  StopTimerResultSchema,
  TimerSchema,
  TimesheetCellBody,
  TimesheetQuery,
  TimesheetSchema,
  UpdateWorkTypeBody,
  VELOCITY_MEASURES,
  VelocitySchema,
  WorkItemBody,
  WorkItemSchema,
  WorkTypeBody,
  WorkTypeSchema,
} from '@a4a/shared';
import { z } from 'zod';
import { getBacklog, rankIssue, sprintPlan, velocity } from '../../services/agile';
import { approveTimesheet, discardTimer, getTimesheet, listTimers, pauseTimer, reopenTimesheet, setTimesheetCell, startTimer, stopTimer, submitTimesheet } from '../../services/time';
import { updateWorkItem } from '../../services/workitems';
import { createWorkType, deleteWorkType, listWorkTypes, updateWorkType } from '../../services/work-types';
import type { HttpEnv } from '../env';
import { route } from '../route';

const Id = z.object({ id: z.string() });
const Key = z.object({ key: z.string() });

/** Planning sprints from a board, and tracking time (docs/architecture.md, D43). */
export function agileRoutes(app: OpenAPIHono<HttpEnv>) {
  const boards = ['Agile boards'];
  route(
    app,
    {
      method: 'get',
      path: '/boards/{id}/backlog',
      tags: boards,
      summary: "The board's backlog, in rank order",
      description: "Issues matching the board's backlog query (#Unresolved by default) that aren't in one of its open sprints. Move one into a sprint with PUT /sprints/{id}/issues, or the command `sprint <name>`.",
      params: Id,
      response: BacklogSchema,
    },
    ({ ctx, params }) => getBacklog(ctx, params.id),
  );
  route(
    app,
    {
      method: 'post',
      path: '/boards/{id}/rank',
      tags: boards,
      summary: 'Put an issue just after or before another on the board, and its card into a column',
      description:
        'The rank is the board’s, shared by its backlog and its cards (D43). With neither after nor before, the issue goes to the top. ' +
        'On the board (D53), `column` (and `lane`) move its card too, in the same change as its place: its column field becomes the column’s first value its project has, through the issue’s one write path, so a state machine, guard or condition that refuses it refuses the whole move (its place included), and `expectedVersion` makes it 409 when the issue changed since it was read. ' +
        'With `column` and neither after nor before, it keeps its place. Ranking takes the edit permission in the issue’s project; within its column it needs nothing of its state. Every move is the event `board.issue_ranked`. ' +
        'On a board whose lanes keep their own order (`laneOrder`, D65), a move with `column` places the card among its lane’s cards (the lane it goes into, or is in), and one without leaves the board’s order, the backlog’s, as it ranks. A move reads only the keys beside its place, and writes one.',
      params: Id,
      body: RankBody,
      status: 204,
    },
    async ({ ctx, params, body }) => {
      await rankIssue(ctx, params.id, body);
      return null;
    },
  );
  route(
    app,
    {
      method: 'get',
      path: '/boards/{id}/velocity',
      tags: boards,
      summary: 'Committed and done per sprint, with the average of the last three',
      description: 'By story points when the board has a points field, else by estimate; or as asked.',
      params: Id,
      query: z.object({ by: z.enum(VELOCITY_MEASURES).optional() }),
      response: VelocitySchema,
    },
    ({ ctx, params, query }) => velocity(ctx, params.id, query.by),
  );
  route(
    app,
    { method: 'get', path: '/sprints/{id}/plan', tags: boards, summary: "A sprint's load against its people's capacity", params: Id, response: SprintPlanSchema },
    ({ ctx, params }) => sprintPlan(ctx, params.id),
  );

  const time = ['Time tracking'];
  route(app, { method: 'get', path: '/timers', tags: time, summary: 'Your timers', response: z.array(TimerSchema) }, ({ ctx }) => listTimers(ctx));
  route(
    app,
    { method: 'post', path: '/issues/{id}/timer/start', tags: time, summary: 'Start (or resume) your timer on an issue', description: 'One runs at a time: one running on another issue is paused.', params: Id, response: TimerSchema },
    ({ ctx, params }) => startTimer(ctx, params.id),
  );
  route(app, { method: 'post', path: '/issues/{id}/timer/pause', tags: time, summary: 'Pause your timer on an issue', params: Id, response: TimerSchema }, ({ ctx, params }) => pauseTimer(ctx, params.id));
  route(
    app,
    {
      method: 'post',
      path: '/issues/{id}/timer/stop',
      tags: time,
      summary: 'Stop your timer and log its time',
      description: 'Logs the minutes it counted (or `duration`) as a work item; under half a minute logs nothing.',
      params: Id,
      body: StopTimerBody,
      response: StopTimerResultSchema,
    },
    ({ ctx, params, body }) => stopTimer(ctx, params.id, body),
  );
  route(app, { method: 'delete', path: '/issues/{id}/timer', tags: time, summary: 'Discard your timer on an issue', params: Id, status: 204 }, async ({ ctx, params }) => {
    await discardTimer(ctx, params.id);
    return null;
  });
  route(
    app,
    { method: 'patch', path: '/work-items/{id}', tags: time, summary: 'Correct logged work', params: Id, body: WorkItemBody.partial().omit({ author: true }), response: WorkItemSchema },
    ({ ctx, params, body }) => updateWorkItem(ctx, params.id, body),
  );
  route(
    app,
    { method: 'get', path: '/timesheet', tags: time, summary: 'A week of your logged time, by issue and work type', query: TimesheetQuery, response: TimesheetSchema },
    ({ ctx, query }) => getTimesheet(ctx, query),
  );
  route(
    app,
    {
      method: 'put',
      path: '/timesheet/cell',
      tags: time,
      summary: 'Set the time of one issue, work type and day',
      description: 'Logs an entry where there is none, corrects the one there, or deletes it at 0. A day of several entries is changed on the issue instead (409).',
      body: TimesheetCellBody,
      response: TimesheetSchema,
    },
    ({ ctx, body }) => setTimesheetCell(ctx, body),
  );
  route(
    app,
    { method: 'get', path: '/projects/{key}/work-types', tags: time, summary: "A project's work types", params: Key, response: z.array(WorkTypeSchema) },
    ({ ctx, params }) => listWorkTypes(ctx, params.key),
  );
  route(
    app,
    { method: 'post', path: '/projects/{key}/work-types', tags: time, summary: 'Add a work type (managers of the project)', params: Key, body: WorkTypeBody, response: WorkTypeSchema },
    ({ ctx, params, body }) => createWorkType(ctx, params.key, body),
  );
  route(
    app,
    { method: 'patch', path: '/work-types/{id}', tags: time, summary: 'Rename, reorder or archive a work type', params: Id, body: UpdateWorkTypeBody, response: WorkTypeSchema },
    ({ ctx, params, body }) => updateWorkType(ctx, params.id, body),
  );
  route(
    app,
    { method: 'delete', path: '/work-types/{id}', tags: time, summary: 'Delete a work type nobody has logged work as', params: Id, status: 204 },
    async ({ ctx, params }) => {
      await deleteWorkType(ctx, params.id);
      return null;
    },
  );
}
