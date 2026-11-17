/**
 * Reports and dashboards: what they take and what they answer. Every report is worked out on
 * request from the activity log (states, estimates, sprint changes) and the logged work.
 */
import { z } from 'zod';
import { ProjectRefSchema, ToneSchema, UserRefSchema } from './schemas';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a date as YYYY-MM-DD');
const timestamp = z.string().describe('ISO 8601 timestamp');

export const REPORT_KINDS = ['burndown', 'flow', 'created-resolved', 'cycle-time', 'time', 'issues-per-field', 'matrix', 'average-age', 'time-in-state'] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

const timeZone = z
  .string()
  .max(64)
  .optional()
  .describe("IANA time zone the report's days begin and end in, e.g. Europe/Berlin. Defaults to the server's.");
const project = z.string().max(40).optional().describe('Project key. Without a query, deleted issues count on the days they existed.');
const query = z.string().max(2000).optional().describe('Only issues that match this query as they are now (within the project, when one is given)');
const from = isoDate.optional().describe('First day, YYYY-MM-DD');
const to = isoDate.optional().describe('Last day, YYYY-MM-DD; default today');

/** What a report counted, over which days, in which time zone. */
export const ReportScopeSchema = z
  .object({
    projects: z.array(ProjectRefSchema),
    query: z.string().nullable(),
    issues: z.number().int().describe('Issues the report looked at'),
    includesDeleted: z.boolean().describe('Deleted issues count on the days they existed (a project without a query)'),
    from: isoDate,
    to: isoDate,
    today: isoDate,
    timeZone: z.string(),
  })
  .meta({ id: 'ReportScope' });
export type ReportScope = z.infer<typeof ReportScopeSchema>;

// ---------------------------------------------------------------------------
// Sprint burndown
// ---------------------------------------------------------------------------

export const BurndownQuery = z.object({
  sprint: z.string().optional().describe('Sprint id, or its name with board'),
  board: z.string().optional().describe("Board id or name: its current sprint, unless a sprint is named"),
  by: z.enum(['estimate', 'count']).default('estimate').describe('Remaining work by Estimation, or by number of issues'),
  timeZone,
});

export const BurndownDaySchema = z
  .object({
    date: isoDate,
    remaining: z.number().nullable().describe('At the end of the day (now, for today); null for days to come'),
    ideal: z.number().describe('Where the work would be by the end of the day, burned evenly over the working days'),
    completed: z.number().describe('Resolved that day'),
    added: z.number().describe('Scope added: issues joining the sprint, or estimates raised'),
    removed: z.number().describe('Scope taken away: issues leaving the sprint or deleted, or estimates lowered'),
    reopened: z.number().describe('Resolved issues opened again'),
    spentMinutes: z.number().int().describe("Work logged that day on the sprint's issues"),
  })
  .meta({ id: 'BurndownDay' });
export type BurndownDay = z.infer<typeof BurndownDaySchema>;

export const BURNDOWN_VERDICTS = ['on_track', 'behind', 'ahead', 'done', 'not_started', 'ended', 'empty'] as const;

export const BurndownSchema = z
  .object({
    sprint: z.object({
      id: z.string(),
      name: z.string(),
      goal: z.string(),
      startDate: isoDate,
      endDate: isoDate,
      board: z.object({ id: z.string(), name: z.string() }),
    }),
    projects: z.array(ProjectRefSchema),
    by: z.enum(['estimate', 'count']),
    unit: z.enum(['minutes', 'issues']),
    timeZone: z.string(),
    today: isoDate,
    start: z.number().describe('Committed at the start of the sprint'),
    remaining: z.number().describe('Left now (or at the end, for a sprint that has ended)'),
    completed: z.number(),
    added: z.number(),
    removed: z.number(),
    workingDays: z.number().int(),
    workingDaysLeft: z.number().int().describe('Working days after today, in the sprint'),
    days: z.array(BurndownDaySchema).describe('Each working day of the sprint'),
    status: z.object({
      verdict: z.enum(BURNDOWN_VERDICTS),
      words: z.string().describe('How it stands, in a sentence'),
      idealNow: z.number().nullable(),
      forecastEnd: isoDate.nullable().describe('When the work would be done at the pace so far'),
    }),
    changes: z
      .array(
        z.object({
          at: timestamp,
          date: isoDate,
          issue: z.string(),
          summary: z.string(),
          kind: z.enum(['added', 'removed', 'deleted', 'resolved', 'reopened', 'estimate']),
          amount: z.number().describe('In the report\'s unit; negative when it lowers what is left'),
        }),
      )
      .describe('Each change of scope or progress during the sprint, in order'),
    unestimated: z.array(z.string()).describe('Issues in the sprint without an estimate; by estimate they count as nothing'),
    warnings: z.array(z.string()),
  })
  .meta({ id: 'Burndown' });
export type Burndown = z.infer<typeof BurndownSchema>;

// ---------------------------------------------------------------------------
// Cumulative flow
// ---------------------------------------------------------------------------

export const FlowQuery = z.object({ project, query, from, to, timeZone });

export const FlowStateSchema = z
  .object({
    name: z.string(),
    resolved: z.boolean(),
    tone: ToneSchema,
    current: z.boolean().describe('Still a value of the field; false for a name only history knows, such as a value renamed since'),
  })
  .meta({ id: 'FlowState' });
export type FlowState = z.infer<typeof FlowStateSchema>;

export const FlowSchema = z
  .object({
    scope: ReportScopeSchema,
    states: z.array(FlowStateSchema).describe('In workflow order: open states, then resolved ones'),
    days: z.array(
      z.object({
        date: isoDate,
        counts: z.array(z.number().int()).describe('Issues in each state at the end of the day (now, for today), in the order of states'),
        total: z.number().int(),
      }),
    ),
    noState: z.number().int().describe('Issues counted with no state at the end of the last day'),
  })
  .meta({ id: 'CumulativeFlow' });
export type Flow = z.infer<typeof FlowSchema>;

// ---------------------------------------------------------------------------
// Created against resolved
// ---------------------------------------------------------------------------

export const INTERVALS = ['day', 'week', 'month'] as const;
export type Interval = (typeof INTERVALS)[number];

export const CreatedResolvedQuery = z.object({
  project,
  query,
  from,
  to,
  interval: z.enum(INTERVALS).optional().describe('Default: by day up to 31 days, by week up to 26 weeks, else by month'),
  timeZone,
});

export const CreatedResolvedSchema = z
  .object({
    scope: ReportScopeSchema,
    interval: z.enum(INTERVALS),
    buckets: z.array(
      z.object({
        from: isoDate,
        to: isoDate.describe('Last day of the bucket'),
        created: z.number().int(),
        resolved: z.number().int().describe('Issues resolved; one resolved twice counts twice'),
        reopened: z.number().int(),
        open: z.number().int().describe('Unresolved at the end of the bucket'),
      }),
    ),
    totals: z.object({ created: z.number().int(), resolved: z.number().int(), reopened: z.number().int() }),
  })
  .meta({ id: 'CreatedResolved' });
export type CreatedResolved = z.infer<typeof CreatedResolvedSchema>;

// ---------------------------------------------------------------------------
// Cycle time
// ---------------------------------------------------------------------------

export const CycleTimeQuery = z.object({
  project,
  query,
  from,
  to,
  start: z.string().max(500).optional().describe('States that start the clock, comma-separated. Default: In Progress'),
  timeZone,
});

export const CycleTimeSchema = z
  .object({
    scope: ReportScopeSchema,
    startStates: z.array(z.string()),
    count: z.number().int().describe('Issues resolved in the window that had started'),
    percentiles: z.object({ p50: z.number().nullable(), p75: z.number().nullable(), p85: z.number().nullable(), p95: z.number().nullable() }).describe('In days'),
    mean: z.number().nullable(),
    bucketDays: z.number().describe('Width of each bucket, in days'),
    buckets: z.array(z.object({ from: z.number(), to: z.number(), count: z.number().int() })),
    issues: z.array(
      z.object({
        issue: z.string(),
        summary: z.string(),
        started: timestamp,
        resolved: timestamp,
        days: z.number(),
        reopened: z.boolean().describe('Resolved before, and opened again'),
      }),
    ),
    notStarted: z
      .array(z.object({ issue: z.string(), summary: z.string(), resolved: timestamp }))
      .describe('Resolved in the window without ever being in a start state: left out of the figures'),
  })
  .meta({ id: 'CycleTime' });
export type CycleTime = z.infer<typeof CycleTimeSchema>;

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

export const TimeReportQuery = z.object({
  project,
  query,
  from,
  to,
  author: z.string().max(100).optional().describe('Only work logged by this person (login)'),
});

const TimeGroupSchema = z.object({ key: z.string(), label: z.string(), minutes: z.number().int(), entries: z.number().int() });

export const TimeReportSchema = z
  .object({
    projects: z.array(ProjectRefSchema),
    query: z.string().nullable(),
    from: isoDate,
    to: isoDate,
    author: UserRefSchema.nullable(),
    totalMinutes: z.number().int(),
    entries: z.number().int(),
    byPerson: z.array(TimeGroupSchema.extend({ user: UserRefSchema.nullable() })),
    byProject: z.array(TimeGroupSchema),
    byWeek: z.array(TimeGroupSchema.extend({ from: isoDate }).describe('key is the Monday the week starts on')),
    byIssue: z.array(
      z.object({
        issue: z.string(),
        summary: z.string(),
        project: z.string(),
        minutes: z.number().int().describe('Logged in the window'),
        spentMinutes: z.number().int().describe('Logged on the issue all told'),
        estimateMinutes: z.number().int().nullable(),
        overMinutes: z.number().int().nullable().describe('Spent past the estimate, all told; null without an estimate'),
        resolved: z.boolean(),
      }),
    ),
    weeks: z.array(isoDate).describe('The Mondays of the weeks in the window'),
    matrix: z
      .array(z.object({ user: UserRefSchema.nullable(), label: z.string(), minutes: z.array(z.number().int()) }))
      .describe('Each person\'s minutes per week, in the order of weeks'),
  })
  .meta({ id: 'TimeReport' });
export type TimeReport = z.infer<typeof TimeReportSchema>;

export const TimeCsvQuery = TimeReportQuery.extend({
  rows: z.enum(['entries', 'person', 'issue', 'project', 'week']).default('entries').describe('One row per work item, or per group'),
});

// ---------------------------------------------------------------------------
// Dashboards
// ---------------------------------------------------------------------------

const widgetBase = {
  id: z.string().min(1).max(40).regex(/^[A-Za-z0-9_-]+$/),
  title: z.string().max(80).optional(),
  width: z.enum(['half', 'full']).default('half'),
};
const days = z.number().int().min(7).max(366).default(30).describe('The window: this many days up to today');
const fieldName = z.string().min(1).max(100).describe('A field, by name, or Project');

export const ReportWidgetParams = z.discriminatedUnion('report', [
  z.object({
    report: z.literal('burndown'),
    board: z.string().max(80).optional().describe("A board: its current sprint, whichever that is"),
    sprint: z.string().max(80).optional(),
    by: z.enum(['estimate', 'count']).default('estimate'),
  }),
  z.object({ report: z.literal('flow'), project, query, days }),
  z.object({ report: z.literal('created-resolved'), project, query, days, interval: z.enum(INTERVALS).optional() }),
  z.object({ report: z.literal('cycle-time'), project, query, days, start: z.string().max(500).optional() }),
  z.object({ report: z.literal('time'), project, query, days, author: z.string().max(100).optional() }),
  // More reports (D44)
  z.object({ report: z.literal('issues-per-field'), project, query, field: fieldName, interval: z.enum(INTERVALS).optional() }),
  z.object({ report: z.literal('matrix'), project, query, rows: fieldName, columns: fieldName, interval: z.enum(INTERVALS).optional() }),
  z.object({ report: z.literal('average-age'), project, query, days, field: fieldName.optional() }),
  z.object({ report: z.literal('time-in-state'), project, query, days, board: z.string().max(80).optional() }),
]);
export type ReportWidgetParams = z.infer<typeof ReportWidgetParams>;

export const WidgetSchema = z
  .discriminatedUnion('kind', [
    z.object({ ...widgetBase, kind: z.literal('report'), params: ReportWidgetParams }),
    z.object({
      ...widgetBase,
      kind: z.literal('search'),
      savedSearch: z.string().max(40).optional().describe('A saved search, by id'),
      query: z.string().max(2000).optional().describe('Or a query of its own'),
      show: z.enum(['count', 'list']).default('list'),
      limit: z.number().int().min(1).max(25).default(8),
    }),
    z.object({ ...widgetBase, kind: z.literal('note'), text: z.string().max(5000).describe('Markdown') }),
  ])
  .meta({ id: 'Widget' });
export type Widget = z.infer<typeof WidgetSchema>;
export type WidgetInput = z.input<typeof WidgetSchema>;

export const MAX_WIDGETS = 24;

export const DashboardSchema = z
  .object({
    id: z.string().nullable().describe('null for the default dashboard, which is worked out and not saved'),
    name: z.string(),
    shared: z.boolean(),
    owner: UserRefSchema.nullable(),
    mine: z.boolean(),
    canEdit: z.boolean(),
    version: z.number().int(),
    widgets: z.array(WidgetSchema),
    createdAt: timestamp.nullable(),
    updatedAt: timestamp.nullable(),
  })
  .meta({ id: 'Dashboard' });
export type Dashboard = z.infer<typeof DashboardSchema>;

export const DashboardBody = z.object({
  name: z.string().min(1).max(80),
  shared: z.boolean().default(false).describe('Everyone can see it; only its owner and admins change it'),
  widgets: z.array(WidgetSchema).max(MAX_WIDGETS).default([]),
});
export const UpdateDashboardBody = z.object({
  name: z.string().min(1).max(80).optional(),
  shared: z.boolean().optional(),
  widgets: z.array(WidgetSchema).max(MAX_WIDGETS).optional(),
  expectedVersion: z.number().int().optional().describe('Fail with 409 if it changed since this version'),
});

// ---------------------------------------------------------------------------
// More reports (D44): issues per field, matrix, average age, time in state
// ---------------------------------------------------------------------------

const fieldParam = z.string().min(1).max(100).describe('A field, by name, or Project: any type; a multi-valued one counts an issue under each value');
const interval = z.enum(INTERVALS).optional().describe('For a date or date-and-time field: by day, week or month. Default: whichever keeps the values few');

/** What a report of issues as they are now counted. */
export const CurrentScopeSchema = z
  .object({
    projects: z.array(ProjectRefSchema),
    query: z.string().nullable(),
    issues: z.number().int().describe('Issues the report counted: those the query finds now'),
    today: isoDate,
    timeZone: z.string().describe('Where a date-and-time value falls on a day'),
  })
  .meta({ id: 'CurrentReportScope' });
export type CurrentScope = z.infer<typeof CurrentScopeSchema>;

export const ReportFieldSchema = z
  .object({
    name: z.string(),
    type: z.string().describe('The field\'s type, or "project"'),
    multi: z.boolean().describe('An issue can hold several values, and counts under each'),
  })
  .meta({ id: 'ReportField' });
export type ReportField = z.infer<typeof ReportFieldSchema>;

export const ValueCountSchema = z
  .object({
    key: z.string().describe('The value: an id, a number, the first day of a date bucket; "" for no value, "*" for the rest'),
    label: z.string(),
    tone: ToneSchema,
    count: z.number().int(),
    query: z.string().nullable().describe('The query that finds these issues now; null for the rest, which no one query finds'),
  })
  .meta({ id: 'ValueCount' });
export type ValueCount = z.infer<typeof ValueCountSchema>;

export const IssuesPerFieldQuery = z.object({ project, query, field: fieldParam, interval, timeZone });

export const IssuesPerFieldSchema = z
  .object({
    scope: CurrentScopeSchema,
    field: ReportFieldSchema,
    interval: z.enum(INTERVALS).nullable(),
    values: z.array(ValueCountSchema).describe('In the field\'s order (dates in time, free values by count); no value last'),
    total: z.number().int().describe('Issues counted; with a multi-valued field the values can add up to more'),
    noValue: z.number().int(),
  })
  .meta({ id: 'IssuesPerField' });
export type IssuesPerField = z.infer<typeof IssuesPerFieldSchema>;

export const MatrixQuery = z.object({ project, query, rows: fieldParam, columns: fieldParam, interval, timeZone });

export const MatrixSchema = z
  .object({
    scope: CurrentScopeSchema,
    rows: z.object({ field: ReportFieldSchema, values: z.array(ValueCountSchema).describe('count: the row\'s total') }),
    columns: z.object({ field: ReportFieldSchema, values: z.array(ValueCountSchema).describe('count: the column\'s total') }),
    cells: z.array(z.array(z.object({ count: z.number().int(), query: z.string().nullable() }))).describe('cells[row][column], in the order of rows and columns'),
    total: z.number().int(),
  })
  .meta({ id: 'Matrix' });
export type Matrix = z.infer<typeof MatrixSchema>;

export const AverageAgeQuery = z.object({
  project,
  query,
  from,
  to,
  field: fieldParam.optional().describe('Also by this field: its value as it stood each day'),
  timeZone,
});

export const AverageAgeSchema = z
  .object({
    scope: ReportScopeSchema,
    field: ReportFieldSchema.nullable(),
    days: z.array(
      z.object({
        date: isoDate,
        open: z.number().int().describe('Unresolved at the end of the day'),
        averageDays: z.number().nullable().describe('Their average age: days since each was created'),
        medianDays: z.number().nullable(),
      }),
    ),
    values: z
      .array(
        z.object({
          key: z.string(),
          label: z.string(),
          tone: ToneSchema,
          open: z.number().int().describe('At the end of the last day'),
          averageDays: z.number().nullable(),
          oldestDays: z.number().nullable(),
          days: z.array(z.number().nullable()).describe('Average age each day, in the order of days'),
          query: z.string().nullable().describe('Its open issues now; null unless the window ends today'),
        }),
      )
      .describe('By the field\'s value as it stood each day, most open first; empty without a field'),
    oldest: z.array(z.object({ issue: z.string(), summary: z.string(), created: timestamp, days: z.number() })).describe('The oldest open at the end, ten at most'),
  })
  .meta({ id: 'AverageAge' });
export type AverageAge = z.infer<typeof AverageAgeSchema>;

export const TimeInStateQuery = z.object({
  project,
  query,
  from,
  to,
  board: z.string().max(80).optional().describe('A board, by id or name: its columns instead of states, over its projects and query'),
  timeZone,
});

export const TimeInStateSchema = z
  .object({
    scope: ReportScopeSchema,
    board: z.object({ id: z.string(), name: z.string() }).nullable(),
    by: z.enum(['state', 'column']),
    states: z
      .array(
        z.object({
          name: z.string(),
          resolved: z.boolean(),
          tone: ToneSchema,
          issues: z.number().int().describe('Issues resolved in the window that spent time here'),
          totalDays: z.number(),
          meanDays: z.number().nullable(),
          p50: z.number().nullable().describe('Median days, among the issues that spent time here'),
          p85: z.number().nullable(),
          now: z.number().int().describe('Open issues here at the end of the window'),
        }),
      )
      .describe('In workflow order, or the board\'s'),
    issues: z
      .array(
        z.object({
          issue: z.string(),
          summary: z.string(),
          resolved: timestamp,
          days: z.array(z.number()).describe('Days in each state, in the order of states'),
          totalDays: z.number(),
        }),
      )
      .describe('Issues resolved in the window, with the time each spent in each state until then'),
    ongoing: z
      .array(z.object({ issue: z.string(), summary: z.string(), state: z.string(), daysInState: z.number(), daysOpen: z.number() }))
      .describe('Open at the end of the window: how long each has been where it is, longest first'),
  })
  .meta({ id: 'TimeInState' });
export type TimeInState = z.infer<typeof TimeInStateSchema>;
