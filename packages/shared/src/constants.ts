/** The product's name, in the family's numeronyms (a7c, a5s, a3t): a4a, for agenda. */
export const APP_NAME = 'a4a';
export const APP_FULL_NAME = 'agenda';

export const ROLES = ['admin', 'member', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

/**
 * What someone may do in one project, least first: a viewer reads and comments, a member
 * also changes issues, a manager also changes the project's settings, people, boards and baselines.
 */
export const PROJECT_ROLES = ['viewer', 'member', 'manager'] as const;
export type ProjectRole = (typeof PROJECT_ROLES)[number];

/**
 * What a role in a project lets someone do (D37). A role is a set of these; the built-in viewer,
 * member and manager are three such sets, and an administrator can define more.
 * read: see the project and its issues. comment: comment. create: report issues. edit: change
 * issues (fields, words, tags, links, and who sees them). delete: delete issues. time: log time.
 * costs: see time logged and costs. boards: make and change boards and sprints. manage: the
 * project's settings, people, rules, plan and baselines, imports and help desk, and seeing every
 * issue in it, whoever it's limited to.
 */
export const PERMISSIONS = ['read', 'comment', 'create', 'edit', 'delete', 'time', 'costs', 'boards', 'manage'] as const;
export type Permission = (typeof PERMISSIONS)[number];
/** Permissions that change something, which a read-only account or token never has whatever its role. */
export const WRITING_PERMISSIONS: readonly Permission[] = ['comment', 'create', 'edit', 'delete', 'time', 'boards', 'manage'];
export const BUILTIN_ROLE_PERMISSIONS: Record<ProjectRole, readonly Permission[]> = {
  viewer: ['read', 'comment', 'costs'],
  member: ['read', 'comment', 'create', 'edit', 'delete', 'time', 'costs'],
  manager: PERMISSIONS,
};
export const BUILTIN_ROLE_NAMES: Record<ProjectRole, string> = { viewer: 'Viewer', member: 'Member', manager: 'Manager' };

/** Who sees a project: everyone (open), or only its people and administrators (members). */
export const PROJECT_VISIBILITIES = ['open', 'members'] as const;
export type ProjectVisibility = (typeof PROJECT_VISIBILITIES)[number];

/** API token scopes. A token can never do more than its user's role allows. */
export const SCOPES = ['read', 'write', 'admin'] as const;
export type Scope = (typeof SCOPES)[number];

/** The channel a change came through. Recorded on every activity entry. */
export const CHANNELS = ['web', 'api', 'mcp', 'assistant', 'automation', 'system', 'helpdesk', 'vcs'] as const;
export type Channel = (typeof CHANNELS)[number];

/**
 * a4a's own agents, by login: they act for a4a itself (triage, workflow rules, the help desk),
 * and take no tokens and no work. Any other bot account is an agent an administrator added, which
 * holds tokens of its own and can be assigned issues (docs/architecture.md, D34).
 */
export const OWN_AGENTS = ['triage', 'workflow', 'helpdesk'] as const;

export function isOwnAgent(user: { isBot: boolean; login: string }): boolean {
  return user.isBot && (OWN_AGENTS as readonly string[]).includes(user.login.toLowerCase());
}

/**
 * Where a change an agent made on its own stands, for the person reading the issue: it can be
 * undone; what it changed has changed since, so undoing it would overwrite someone; or it was undone.
 */
export const UNDO_STATES = ['possible', 'changed_since', 'undone'] as const;
export type UndoState = (typeof UNDO_STATES)[number];

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
  // Issues and fields (D41): a group as the value; builds, which CI adds; values with owners; a moment.
  'group',
  'build',
  'owned',
  'datetime',
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

/** Field types whose values come from a list of options (field_values). */
export const OPTION_FIELD_TYPES: readonly FieldType[] = ['enum', 'state', 'version', 'build', 'owned'];
/** Whether a field's values come from its list of options (field_values). */
export function isOptionType(type: FieldType): boolean {
  return OPTION_FIELD_TYPES.includes(type);
}

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
  'project.member.added',
  'project.member.changed',
  'project.member.removed',
  'project.visibility.changed',
  'attachment.added',
  'attachment.removed',
  'article.created',
  'article.updated',
  'article.deleted',
  'sprint.issue_added',
  'sprint.issue_removed',
  'commit.linked',
  'pull_request.linked',
  'pull_request.updated',
  'rule.notified',
  'rule.called',
  'project.group.added',
  'project.group.changed',
  'project.group.removed',
  'issue.moved',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** The reactions a comment or a description takes (D41): a small, fixed set, so they read alike everywhere. */
export const REACTIONS = ['👍', '👎', '😄', '🎉', '😕', '❤️', '🚀', '👀'] as const;
export type Reaction = (typeof REACTIONS)[number];

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

/**
 * Why a notification reached someone, weakest first: something they subscribed to (a project, or a
 * saved search), a change on an issue they watch, a new help desk request in a project they lead, a
 * mention, an assignment. A notification that folds several events together takes the strongest of
 * their reasons.
 */
/** Why a notification reached someone, weakest first: when several reasons fold into one, the strongest names it. */
export const NOTIFICATION_KINDS = ['subscribed', 'watching', 'rule', 'request', 'mentioned', 'assigned'] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** What a4a emails someone: everything, mentions and assignments only (`direct`), or nothing. In-app is always on. */
export const EMAIL_LEVELS = ['all', 'direct', 'none'] as const;
export type EmailLevel = (typeof EMAIL_LEVELS)[number];

/**
 * What a subscription tells its person of. To a project: `new` issues, or `all` (new issues, changes,
 * comments, links and files). To a saved search: an issue coming into it (`new`), or `all` changes to
 * the issues in it, the one that takes an issue out included.
 */
export const SUBSCRIPTION_EVENTS = ['new', 'all'] as const;
export type SubscriptionEvents = (typeof SUBSCRIPTION_EVENTS)[number];

/** Why someone watches an issue: they chose to, or what they did or were given. */
export const WATCH_REASONS = ['explicit', 'reporter', 'assignee', 'commenter', 'mentioned', 'lead'] as const;
export type WatchReason = (typeof WATCH_REASONS)[number];

/** Who a comment is for: the team only, or also the requester of a help desk request, who is emailed it. */
export const COMMENT_VISIBILITIES = ['internal', 'public'] as const;
export type CommentVisibility = (typeof COMMENT_VISIBILITIES)[number];

/** Where a help desk request stands against its project's first-response target. */
export const SLA_STATES = ['none', 'due', 'overdue', 'met', 'missed'] as const;
export type SlaState = (typeof SLA_STATES)[number];

/** What a help desk's public form and tracking page take, at most (the server's limits, and the form's maxlength). */
export const HELP_LIMITS = { name: 100, email: 254, summary: 200, description: 10_000, reply: 10_000 } as const;

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
/**
 * The issues a rule's further condition reads, from the issue that set it off: its parent, its
 * subtasks, its parent's subtasks (itself among them), or the issues linked to it by a phrase.
 */
export const RULE_RELATIONS = ['parent', 'subtasks', 'siblings', 'linked'] as const;
export type RuleRelation = (typeof RULE_RELATIONS)[number];
/** How many of them must match: all of them (and there is at least one), or any one. */
export const RULE_MATCH = ['all', 'any'] as const;
export type RuleMatch = (typeof RULE_MATCH)[number];
/** The issues a rule acts on: the issue itself, its parent, its subtasks, or the issues linked to it by a phrase. */
export const RULE_TARGETS = ['issue', 'parent', 'subtasks', 'linked'] as const;
export type RuleTargetKind = (typeof RULE_TARGETS)[number];
/** Whom a rule tells, of each issue it acts on, besides the people it names. */
export const RULE_TELL = ['assignee', 'reporter', 'watchers', 'managers'] as const;
export type RuleTell = (typeof RULE_TELL)[number];

/**
 * Version control a4a takes pushes and pull requests from. `bitbucket` is Bitbucket Cloud;
 * `bitbucket-dc`, Bitbucket Data Center (and Server); `gitea`, Gitea and Forgejo, which send the
 * same deliveries.
 */
export const VCS_PROVIDERS = ['github', 'gitlab', 'bitbucket', 'bitbucket-dc', 'gitea'] as const;
export type VcsProvider = (typeof VCS_PROVIDERS)[number];
/** Each provider by name, as people know it. */
export const VCS_PROVIDER_NAMES: Record<VcsProvider, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  bitbucket: 'Bitbucket Cloud',
  'bitbucket-dc': 'Bitbucket Data Center',
  gitea: 'Gitea or Forgejo',
};
export const PULL_REQUEST_STATES = ['open', 'merged', 'closed'] as const;
export type PullRequestState = (typeof PULL_REQUEST_STATES)[number];
/** How a delivery from version control went. */
export const VCS_DELIVERY_OUTCOMES = ['received', 'processed', 'ignored', 'refused', 'duplicate', 'failed'] as const;
export type VcsDeliveryOutcome = (typeof VCS_DELIVERY_OUTCOMES)[number];
export const MAX_PAGE_SIZE = 200;

/**
 * Raster images a browser may show in place. Every other file, SVG and HTML included,
 * is served as a download, whatever its name says.
 */
export const INLINE_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;

/**
 * Sound and video the page plays in its own player, from their bytes' type (D35): formats every
 * current browser decodes. QuickTime, AVI and Matroska aren't among them, so they download.
 */
export const PLAYABLE_AUDIO_TYPES = ['audio/mpeg', 'audio/aac', 'audio/mp4', 'audio/ogg', 'audio/wav', 'audio/flac'] as const;
export const PLAYABLE_VIDEO_TYPES = ['video/mp4', 'video/webm'] as const;
export const PLAY_KINDS = ['audio', 'video'] as const;
export type PlayKind = (typeof PLAY_KINDS)[number];
