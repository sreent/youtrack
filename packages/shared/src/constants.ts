/** The product's name, in the family's numeronyms (a7c, a5s, a3t): a4a, for agenda. */
export const APP_NAME = 'a4a';
export const APP_FULL_NAME = 'agenda';

export const ROLES = ['admin', 'member', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

/** API token scopes. A token can never do more than its user's role allows. */
export const SCOPES = ['read', 'write', 'admin'] as const;
export type Scope = (typeof SCOPES)[number];

/** The channel a change came through. Recorded on every activity entry. */
export const CHANNELS = ['web', 'api', 'mcp', 'assistant', 'automation', 'system'] as const;
export type Channel = (typeof CHANNELS)[number];

export const FIELD_TYPES = [
  'enum',
  'state',
  'user',
  'version',
  'string',
  'text',
  'integer',
  'float',
  'date',
  'period',
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

/** Field types whose values come from a list of options (field_values). */
export const OPTION_FIELD_TYPES: readonly FieldType[] = ['enum', 'state', 'version'];

export const TRIAGE_MODES = ['off', 'suggest', 'auto'] as const;
export type TriageMode = (typeof TRIAGE_MODES)[number];

export const EVENT_TYPES = [
  'issue.created',
  'issue.updated',
  'issue.deleted',
  'comment.created',
  'comment.updated',
  'comment.deleted',
  'link.created',
  'link.deleted',
  'work.logged',
  'work.deleted',
  'ai.triage.completed',
  'baseline.created',
  'sprint.issue_added',
  'sprint.issue_removed',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const LEVELING_MODES = ['within_slack', 'allow_delay'] as const;
export type LevelingMode = (typeof LEVELING_MODES)[number];

/** Well-known custom field names used by boards, triage and the planning engine. */
export const WELL_KNOWN_FIELDS = {
  state: 'State',
  priority: 'Priority',
  type: 'Type',
  assignee: 'Assignee',
  subsystem: 'Subsystem',
  fixVersions: 'Fix versions',
  estimation: 'Estimation',
  startDate: 'Start date',
  dueDate: 'Due date',
  fixedCost: 'Fixed cost',
} as const;

/** Time tracking conventions (YouTrack style): 1d = 8h, 1w = 5d. */
export const MINUTES_PER_HOUR = 60;
export const DEFAULT_HOURS_PER_DAY = 8;
export const DEFAULT_DAYS_PER_WEEK = 5;

export const MAX_BULK_ISSUES = 50;
export const MAX_PAGE_SIZE = 200;
