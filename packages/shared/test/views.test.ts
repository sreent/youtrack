/**
 * The contract of planning as views (D72): a plan's scope is a saved search or a query, exactly one; a
 * saved search's view settings fill in what they leave out, refuse what's too long, and read a list
 * when what's kept doesn't read; an event's undo may name its group and who may undo it.
 */
import { describe, expect, it } from 'vitest';
import { EventSchema, PlanScheduleSchema, SavedSearchSchema } from '../src/schemas';
import { PlanScopeQuery, PlanScopeSchema, planScopeOf, VIEW_LIMITS, viewSettingsOf, ViewSettingsSchema } from '../src/views';

describe('a plan’s scope', () => {
  it('is a saved search or a query, exactly one, with a project or not', () => {
    expect(PlanScopeSchema.parse({ query: '' })).toEqual({ query: '' });
    expect(PlanScopeSchema.parse({ savedSearch: 'ss1', project: 'BACK' })).toEqual({ savedSearch: 'ss1', project: 'BACK' });
    for (const bad of [{}, { project: 'BACK' }, { query: '', savedSearch: 'ss1' }, { query: 'x'.repeat(2001) }, { query: '', project: 'not a key' }, { query: '', other: 1 }]) {
      expect(PlanScopeSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('in a query string, takes one of savedSearch and query (which may be empty), and reads as a body', () => {
    expect(planScopeOf(PlanScopeQuery.parse({ query: '', project: 'WEB' }))).toEqual({ query: '', project: 'WEB' });
    expect(planScopeOf(PlanScopeQuery.parse({ savedSearch: 'ss1' }))).toEqual({ savedSearch: 'ss1' });
    expect(PlanScopeQuery.safeParse({}).success).toBe(false);
    expect(PlanScopeQuery.safeParse({ savedSearch: 'ss1', query: 'for: me' }).success).toBe(false);
  });
});

describe('a saved search’s view', () => {
  it('fills in what it leaves out, each view’s settings once they’re there', () => {
    expect(ViewSettingsSchema.parse({ kind: 'list' })).toEqual({ kind: 'list', group: null });
    expect(ViewSettingsSchema.parse({ kind: 'timeline', group: 'Assignee', timeline: {}, calendar: {}, table: {} })).toEqual({
      kind: 'timeline',
      group: 'Assignee',
      timeline: { zoom: 'week', order: 'plan', columns: [], baseline: null },
      calendar: { span: 'month' },
      table: { columns: [], dates: 'both' },
    });
  });

  it('refuses a kind it doesn’t know, and anything past its caps', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => `Field ${i}`);
    for (const bad of [
      { kind: 'board' },
      { kind: 'list', group: 'x'.repeat(VIEW_LIMITS.column + 1) },
      { kind: 'timeline', timeline: { columns: many(VIEW_LIMITS.timelineColumns + 1) } },
      { kind: 'timeline', timeline: { baseline: 'b'.repeat(VIEW_LIMITS.id + 1) } },
      { kind: 'table', table: { columns: many(VIEW_LIMITS.tableColumns + 1).map((field) => ({ field })) } },
      { kind: 'table', table: { columns: [{ field: 'Assignee', width: VIEW_LIMITS.maxWidth + 1 }] } },
      { kind: 'calendar', calendar: { span: 'year' } },
    ]) {
      expect(ViewSettingsSchema.safeParse(bad).success, JSON.stringify(bad).slice(0, 80)).toBe(false);
    }
  });

  it('reads as a list when what’s kept doesn’t read', () => {
    expect(viewSettingsOf({ kind: 'gantt' })).toEqual({ kind: 'list', group: null });
    expect(viewSettingsOf(null)).toEqual({ kind: 'list', group: null });
    expect(viewSettingsOf({ kind: 'calendar', calendar: { span: 'week' } })).toEqual({ kind: 'calendar', group: null, calendar: { span: 'week' } });
  });

  it('is part of a saved search, with its version', () => {
    const search = { id: 's', name: 'Plan', query: '', shared: true, owner: null, view: { kind: 'timeline', group: null }, version: 3 };
    expect(SavedSearchSchema.parse(search)).toEqual(search);
    expect(SavedSearchSchema.safeParse({ ...search, version: undefined }).success).toBe(false);
  });
});

describe('an event’s undo', () => {
  const event = {
    id: 1,
    type: 'issue.updated',
    occurredAt: '2026-11-02T10:00:00Z',
    actor: { id: 'u', login: 'anna', name: 'Anna', channel: 'web', token: null, isBot: false },
    project: 'BACK',
    issue: null,
    changes: [],
    data: {},
  };
  it('may name the change it is part of, and who may undo it; as today, it needn’t', () => {
    expect(EventSchema.parse({ ...event, undo: { state: 'possible', note: '', group: 'g1', by: 'author' } }).undo).toEqual({ state: 'possible', note: '', group: 'g1', by: 'author' });
    expect(EventSchema.parse({ ...event, undo: { state: 'possible', note: '' } }).undo).toEqual({ state: 'possible', note: '' });
    expect(EventSchema.safeParse({ ...event, undo: { state: 'possible', note: '', by: 'someone' } }).success).toBe(false);
  });
});

describe('a plan of a search', () => {
  it('adds only optional fields to a schedule, each task’s too', () => {
    const shape = PlanScheduleSchema.shape;
    for (const k of ['scope', 'projects', 'calendars', 'total', 'truncated'] as const) expect(shape[k].safeParse(undefined).success, k).toBe(true);
    const task = shape.tasks.element.shape;
    for (const k of ['project', 'calendar', 'editable', 'set'] as const) expect(task[k].safeParse(undefined).success, k).toBe(true);
  });
});
