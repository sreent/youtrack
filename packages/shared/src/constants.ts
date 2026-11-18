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
/**
 * What a role lets someone do in a project (D37). The last two are a project's private fields (D50):
 * seeing them, and changing them. A manager has both; the built-in viewer and member have neither.
 */
export const PERMISSIONS = ['read', 'comment', 'create', 'edit', 'delete', 'time', 'costs', 'boards', 'manage', 'readPrivate', 'editPrivate'] as const;
export type Permission = (typeof PERMISSIONS)[number];
/** Permissions that change something, which a read-only account or token never has whatever its role. */
export const WRITING_PERMISSIONS: readonly Permission[] = ['comment', 'create', 'edit', 'delete', 'time', 'boards', 'manage', 'editPrivate'];
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
export const CHANNELS = ['web', 'api', 'mcp', 'assistant', 'automation', 'system', 'helpdesk', 'vcs', 'chat', 'ci', 'email', 'app'] as const;
export type Channel = (typeof CHANNELS)[number];

/** The chats a4a talks in (D42): Microsoft Teams, through a bot, and Slack, through an app. */
export const CHAT_PLATFORMS = ['teams', 'slack'] as const;
export type ChatPlatform = (typeof CHAT_PLATFORMS)[number];
export const CHAT_PLATFORM_NAMES: Record<ChatPlatform, string> = { teams: 'Microsoft Teams', slack: 'Slack' };

/**
 * The kinds of change a channel can hear of (D42): a new issue, its state, who it's assigned to, a
 * comment, and its other fields. Time logged, files and links stay off chat.
 */
export const CHAT_CHANGE_KINDS = ['created', 'state', 'assigned', 'commented', 'fields'] as const;
export type ChatChangeKind = (typeof CHAT_CHANGE_KINDS)[number];
/** What a channel hears of when nobody says otherwise. */
export const DEFAULT_CHAT_KINDS: readonly ChatChangeKind[] = ['created', 'state', 'assigned', 'commented'];

/**
 * a4a's own agents, by login: they act for a4a itself (triage, workflow rules, the help desk, builds),
 * and take no tokens and no work. Any other bot account is an agent an administrator added, which
 * holds tokens of its own and can be assigned issues (docs/architecture.md, D34).
 */
export const OWN_AGENTS = ['triage', 'workflow', 'helpdesk', 'builds'] as const;

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
  'work.updated',
  'build.recorded',
  'sla.warning',
  'sla.breached',
  'project.key.changed',
  // An issue's place in a board's order changed (D53): its backlog's and its columns' one order.
  'board.issue_ranked',
  // Someone was copied on a help desk request, or stopped being (D57).
  'request.cc_added',
  'request.cc_removed',
  // A whiteboard's life, and what came of it (D58). Its elements' edits aren't events: they go to its own live stream.
  'whiteboard.created',
  'whiteboard.renamed',
  'whiteboard.deleted',
  'whiteboard.converted',
  // How a desk's requesters sign in to the portal changed (D63): who can reach its requests there.
  'project.portal_sign_in.changed',
  // A desk's own rules for CCs changed (D67): its cap, whether a new request's Cc waits for its requester, and whether everyone on a request hears each other.
  'project.request_ccs.changed',
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
export const WATCH_REASONS = ['explicit', 'reporter', 'assignee', 'commenter', 'mentioned', 'lead', 'message'] as const;
export type WatchReason = (typeof WATCH_REASONS)[number];

/** Who a comment is for: the team only, or also the requester of a help desk request, who is emailed it. */
export const COMMENT_VISIBILITIES = ['internal', 'public'] as const;
export type CommentVisibility = (typeof COMMENT_VISIBILITIES)[number];

/** Where a help desk request stands against its project's first-response target. */
export const SLA_STATES = ['none', 'due', 'overdue', 'met', 'missed'] as const;
export type SlaState = (typeof SLA_STATES)[number];

/** A desk's two SLA targets (D45): the team's first public reply, and the request resolved. */
export const SLA_TARGETS = ['first_response', 'resolution'] as const;
export type SlaTarget = (typeof SLA_TARGETS)[number];
/**
 * How one target's clock stands: counting within it, within its warning, paused while the request
 * waits on its requester, past it and still counting, or stopped within it or after it.
 */
export const SLA_CLOCK_STATES = ['running', 'at_risk', 'paused', 'breached', 'met', 'missed'] as const;
export type SlaClockState = (typeof SLA_CLOCK_STATES)[number];
/** A request's SLA as one word, the values of its SLA field: the worst of its targets. */
export const SLA_STATUSES = ['On track', 'At risk', 'Paused', 'Breached', 'Met'] as const;
export type SlaStatus = (typeof SLA_STATUSES)[number];
/** The kinds of change a person can choose to be told of (D45), each by the inbox and by email. */
export const NOTIFY_KINDS = ['created', 'commented', 'state', 'assigned', 'fields', 'linked', 'attachments', 'sla'] as const;
export type NotifyKind = (typeof NOTIFY_KINDS)[number];

/** What a help desk's public form and tracking page take, at most (the server's limits, and the form's maxlength). */
export const HELP_LIMITS = { name: 100, email: 254, summary: 200, description: 10_000, reply: 10_000 } as const;
/**
 * The most people copied on one help desk request at once (D57). Each public reply goes to each of
 * them, an email apiece with a reply address of its own, so it bounds what one reply sends and what
 * one forged email's Cc can reach; a conversation rarely needs more than a few, and a team's list
 * address counts as one.
 */
export const REQUEST_CCS_MAX = 20;
/**
 * The most a desk may set its own cap to (D67): Zendesk's 48, rounded. One public reply then sends at
 * most 51 emails (the requester's, and one per CC), each with a reply token of its own; past that a
 * desk wants a list address, which counts as one, rather than a4a acting as a list server.
 */
export const REQUEST_CCS_CEILING = 50;
/**
 * Words relayed among everyone on a request (D67), each hour, in the help desk's shared throttle: at
 * most this many messages on one request, and from one sender (by their address) across every
 * request. A relay is one email per person on the request, so these bound what one person, or one
 * lively conversation, makes a4a send.
 */
export const CC_RELAY_LIMITS = { perRequest: 20, perSender: 10 } as const;
/** How long the link in a new request's acknowledgement confirms whom its Cc named (D67): once, within this. */
export const CC_CONFIRM_DAYS = 3;
/** How long a new request's Cc waits for its requester (D67), on the portal, before it's forgotten. */
export const CC_HOLD_DAYS = 30;
/** How someone came to be copied on a request (D57): by the team, the Cc of the requester's email, or the requester on the portal. */
export const REQUEST_CC_VIA = ['team', 'email', 'portal'] as const;
export type RequestCcVia = (typeof REQUEST_CC_VIA)[number];
/** How a requester's portal session was opened (D63): an emailed link (D45), their password, or an identity provider. */
export const PORTAL_SIGN_IN_METHODS = ['link', 'password', 'sso', 'passkey'] as const;
export type PortalSignInMethod = (typeof PORTAL_SIGN_IN_METHODS)[number];

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
  gitea: 'Forgejo/Gitea',
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

/**
 * Whiteboards (D58): what one holds at most, and what a note can say of itself. A whiteboard is drawn
 * whole as SVG and read whole by a screen reader's outline, so it stays a team's canvas, not a wall.
 */
export const WHITEBOARD_LIMITS = {
  /** Elements on one whiteboard: notes, text, cards, arrows and sections together. */
  elements: 500,
  /** Characters in a note's or a text block's words. */
  text: 2000,
  /** Characters in an arrow's label or a section's title. */
  label: 200,
  name: 120,
  /** Changes in one batch: enough to move every element at once. */
  ops: 500,
  /** Notes converted, or arrows linked, in one request: a command's cap (D8). */
  convert: 50,
  /** How far from the origin anything may be, and how small and large a box. */
  coordinate: 100_000,
  minSize: 8,
  maxSize: 4_000,
} as const;

/** What a note's tone says, from a short fixed set; Ocean draws each as a meaning, never a colour of its own. */
export const WHITEBOARD_TONES = ['plain', 'idea', 'agreed', 'question', 'problem', 'parked'] as const;
export type WhiteboardTone = (typeof WHITEBOARD_TONES)[number];

export const WHITEBOARD_KINDS = ['note', 'text', 'issue', 'article', 'arrow', 'section'] as const;
export type WhiteboardKind = (typeof WHITEBOARD_KINDS)[number];

/** Whose password sign-in owes a passkey (D68): nobody, everyone, or administrators. */
export const PASSKEYS_REQUIRED = ['off', 'everyone', 'admins'] as const;
export type PasskeysRequired = (typeof PASSKEYS_REQUIRED)[number];
