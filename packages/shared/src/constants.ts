/** The product's name, in the family's numeronyms (a7c, a5s, a3t): a4a, for agenda. */
export const APP_NAME = 'a4a';
export const APP_FULL_NAME = 'agenda';

export const ROLES = ['admin', 'member', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

/** API token scopes. A token can never do more than its user's role allows. */
export const SCOPES = ['read', 'write', 'admin'] as const;
export type Scope = (typeof SCOPES)[number];

/** The channel a change came through. Recorded on every activity entry. */
export const CHANNELS = ['web', 'api', 'mcp', 'assistant', 'automation', 'system', 'vcs'] as const;
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
  'commit.linked',
  'pull_request.linked',
  'pull_request.updated',
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

/**
 * Workflow rules: one that acts when something happens to an issue, one that acts on a schedule,
 * and a guard, which refuses a change that breaks it.
 */
export const RULE_KINDS = ['change', 'schedule', 'guard'] as const;
export type RuleKind = (typeof RULE_KINDS)[number];
/** What sets off a rule on a change. */
export const RULE_TRIGGERS = ['created', 'updated', 'commented'] as const;
export type RuleTrigger = (typeof RULE_TRIGGERS)[number];
/** How often a scheduled rule runs: every hour, every day, or Monday to Friday, at a time of day. */
export const RULE_EVERY = ['hour', 'day', 'weekday'] as const;
export type RuleEvery = (typeof RULE_EVERY)[number];
/** How a rule's run went on an issue. */
export const RULE_OUTCOMES = ['applied', 'unchanged', 'failed', 'skipped', 'refused'] as const;
export type RuleOutcome = (typeof RULE_OUTCOMES)[number];

/** Version control a4a takes pushes and pull requests from. */
export const VCS_PROVIDERS = ['github', 'gitlab'] as const;
export type VcsProvider = (typeof VCS_PROVIDERS)[number];
export const PULL_REQUEST_STATES = ['open', 'merged', 'closed'] as const;
export type PullRequestState = (typeof PULL_REQUEST_STATES)[number];
/** How a delivery from GitHub or GitLab went. */
export const VCS_DELIVERY_OUTCOMES = ['received', 'processed', 'ignored', 'refused', 'duplicate', 'failed'] as const;
export type VcsDeliveryOutcome = (typeof VCS_DELIVERY_OUTCOMES)[number];
export const MAX_PAGE_SIZE = 200;
