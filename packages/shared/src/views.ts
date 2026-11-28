/**
 * Planning as views of one search (docs/architecture.md, D72): the views a search is shown in, what a
 * saved search remembers of how it's shown, and the scope a plan is read from. The server validates
 * with these and OpenAPI is made from them; the web types its views by them.
 */
import { z } from 'zod';
import { DEFAULT_VIEW, VIEW_KINDS } from './view-kinds';

export { DEFAULT_VIEW, VIEW_KINDS, isViewKind, type ViewKind } from './view-kinds';

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export const ViewKindSchema = z.enum(VIEW_KINDS).describe('list, timeline, calendar, table or workload: views of the same search, its issues the same in each');

/** How far a timeline shows across its width: a column a day, a week, a month or a quarter. */
export const TIMELINE_ZOOMS = ['day', 'week', 'month', 'quarter'] as const;
export type TimelineZoom = (typeof TIMELINE_ZOOMS)[number];
/** A timeline's rows: by planned start (the plan's order), or as people put them (the search's own order). */
export const TIMELINE_ORDERS = ['plan', 'manual'] as const;
export type TimelineOrder = (typeof TIMELINE_ORDERS)[number];
/** What a calendar shows at once. */
export const CALENDAR_SPANS = ['month', 'week'] as const;
export type CalendarSpan = (typeof CALENDAR_SPANS)[number];
/** Which dates a table shows: those people set, those the engine plans (D10), or both side by side. */
export const TABLE_DATES = ['set', 'planned', 'both'] as const;
export type TableDates = (typeof TABLE_DATES)[number];

/** What a view's settings hold at most, so a saved search's stay small. */
export const VIEW_LIMITS = {
  /** A field's name, or a column a view names itself (`planned`, `percent` …). */
  column: 60,
  /** The side table's columns beside a timeline's bars. */
  timelineColumns: 20,
  /** A table's columns. */
  tableColumns: 60,
  /** A column's width, in CSS pixels. */
  minWidth: 40,
  maxWidth: 1200,
  /** An id, such as a baseline's. */
  id: 64,
} as const;

const column = z
  .string()
  .trim()
  .min(1)
  .max(VIEW_LIMITS.column)
  .describe('A field, by its name (Assignee, Start date …), or a column the view names itself, such as `planned` or `percent`');

export const TimelineSettingsSchema = z
  .object({
    zoom: z.enum(TIMELINE_ZOOMS).default('week').describe('How much time the width shows: a column a day, a week, a month or a quarter'),
    order: z
      .enum(TIMELINE_ORDERS)
      .default('plan')
      .describe("plan: rows by planned start; manual: as people put them, the saved search's own order (POST /saved-searches/{id}/order)"),
    columns: z.array(column).max(VIEW_LIMITS.timelineColumns).default([]).describe("The side table's columns beside the bars, in order; none for the view's own"),
    baseline: z
      .string()
      .min(1)
      .max(VIEW_LIMITS.id)
      .nullable()
      .default(null)
      .describe("A baseline of the saved search's, drawn beneath the bars; null for none"),
  })
  .meta({ id: 'TimelineSettings' });
export type TimelineSettings = z.infer<typeof TimelineSettingsSchema>;

export const CalendarSettingsSchema = z
  .object({ span: z.enum(CALENDAR_SPANS).default('month').describe('A month or a week at a time') })
  .meta({ id: 'CalendarSettings' });
export type CalendarSettings = z.infer<typeof CalendarSettingsSchema>;

export const TableSettingsSchema = z
  .object({
    columns: z
      .array(
        z.object({
          field: column,
          width: z.number().int().min(VIEW_LIMITS.minWidth).max(VIEW_LIMITS.maxWidth).optional().describe('Its width in CSS pixels; left out, the table sizes it'),
        }),
      )
      .max(VIEW_LIMITS.tableColumns)
      .default([])
      .describe("Its columns, in order; none for the view's own"),
    dates: z.enum(TABLE_DATES).default('both').describe('The dates people set, those the engine plans, or both side by side'),
  })
  .meta({ id: 'TableSettings' });
export type TableSettings = z.infer<typeof TableSettingsSchema>;

/**
 * How a saved search is shown (D72): the view it opens in, what it's grouped by, and each view's own
 * settings once someone chose them. Its owner's changes are kept; anyone else's live in the page's
 * address. The load window isn't here: it stays each person's own (D36).
 */
export const ViewSettingsSchema = z
  .object({
    kind: ViewKindSchema,
    group: column.nullable().default(null).describe('The field its issues are grouped by, by name; null when they aren’t'),
    timeline: TimelineSettingsSchema.optional(),
    calendar: CalendarSettingsSchema.optional(),
    table: TableSettingsSchema.optional(),
  })
  .meta({ id: 'ViewSettings' });
export type ViewSettings = z.infer<typeof ViewSettingsSchema>;

/**
 * A saved search's view as it's kept, read through the schema: a list, should what's kept not read
 * (written by a later version, say), so a search always opens.
 */
export function viewSettingsOf(kept: unknown): ViewSettings {
  const parsed = ViewSettingsSchema.safeParse(kept);
  return parsed.success ? parsed.data : { ...DEFAULT_VIEW };
}

// ---------------------------------------------------------------------------
// What a plan is read from
// ---------------------------------------------------------------------------

/** How many characters a scope's query may have: the same as a saved search's. */
export const SCOPE_QUERY_MAX = 2000;

const scopeProject = z
  .string()
  .trim()
  .min(2)
  .max(10)
  .regex(/^[A-Za-z][A-Za-z0-9]*$/, 'A project key: letters and digits, starting with a letter')
  .describe("A project's key, such as BACK (or a key it had, D52): the plan holds only that project's issues of the scope");
const scopeSavedSearch = z.string().trim().min(1).max(VIEW_LIMITS.id).describe("A saved search's id: yours, or one shared with you");
const scopeQuery = z.string().max(SCOPE_QUERY_MAX).describe('A query, as on the issues page; empty for every issue you can see');

/**
 * What a plan holds (D72): the issues a saved search finds, or a query finds, as its reader sees them,
 * in one project or several; `project` narrows either to one project. Exactly one of `savedSearch` and
 * `query`.
 */
export const PlanScopeSchema = z
  .union([
    z.strictObject({ savedSearch: scopeSavedSearch, project: scopeProject.optional() }),
    z.strictObject({ query: scopeQuery, project: scopeProject.optional() }),
  ])
  .meta({ id: 'PlanScope' });
export type PlanScope = z.infer<typeof PlanScopeSchema>;

/** A plan's scope in a GET route's query string: `savedSearch=…` or `query=…` (it may be empty), and `project=…`. */
export const PlanScopeQuery = z
  .object({
    savedSearch: scopeSavedSearch.optional(),
    query: scopeQuery.optional(),
    project: scopeProject.optional(),
  })
  .refine((q) => (q.savedSearch === undefined) !== (q.query === undefined), {
    message: 'Send savedSearch (a saved search’s id) or query (empty for every issue you can see): one of them',
    path: ['savedSearch'],
  });
export type PlanScopeParams = z.infer<typeof PlanScopeQuery>;

/** The scope a GET route's query string names, as a body names it. */
export function planScopeOf(q: PlanScopeParams): PlanScope {
  const project = q.project ? { project: q.project } : {};
  return q.savedSearch !== undefined ? { savedSearch: q.savedSearch, ...project } : { query: q.query ?? '', ...project };
}
