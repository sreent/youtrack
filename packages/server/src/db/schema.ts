import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigserial,
  bigint,
  boolean,
  check,
  customType,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

const tsvector = customType<{ data: string }>({
  dataType() {
    return 'tsvector';
  },
});

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const created = () => ts('created_at').notNull().defaultNow();

// ---------------------------------------------------------------------------
// Users & auth
// ---------------------------------------------------------------------------

export const users = pgTable(
  'users',
  {
    id: text('id').primaryKey(),
    login: text('login').notNull(),
    name: text('name').notNull(),
    email: text('email'),
    /**
     * The email was set by an administrator or verified by the identity provider. Only then may
     * single sign-on find the account by it: an email people type for themselves proves nothing.
     */
    emailVerified: boolean('email_verified').notNull().default(false),
    passwordHash: text('password_hash'),
    role: text('role').notNull().default('member'),
    isBot: boolean('is_bot').notNull().default(false),
    avatarColor: text('avatar_color').notNull(),
    banned: boolean('banned').notNull().default(false),
    hourlyRate: doublePrecision('hourly_rate'),
    capacityHoursPerDay: doublePrecision('capacity_hours_per_day').notNull().default(8),
    /** Their time zone (IANA), for "today" in their searches, their digest's hour and their email's times. Null: the server's. */
    timeZone: text('time_zone'),
    createdAt: created(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('users_login_lower').on(sql`lower(${t.login})`)],
);

export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(), // sha256 of the session token
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: created(),
    expiresAt: ts('expires_at').notNull(),
    userAgent: text('user_agent'),
  },
  (t) => [index('sessions_user').on(t.userId)],
);

export const apiTokens = pgTable(
  'api_tokens',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    prefix: text('prefix').notNull(),
    scopes: text('scopes').array().notNull(),
    /** The only projects the token reaches (ids), or null for every project its person can see. */
    projectIds: text('project_ids').array(),
    createdAt: created(),
    lastUsedAt: ts('last_used_at'),
    expiresAt: ts('expires_at'),
    revokedAt: ts('revoked_at'),
  },
  (t) => [index('api_tokens_user').on(t.userId)],
);

/** A person's account at an identity provider (OpenID Connect), by the provider's issuer and its subject. */
export const userIdentities = pgTable(
  'user_identities',
  {
    id: text('id').primaryKey(),
    provider: text('provider').notNull(),
    subject: text('subject').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    email: text('email'),
    createdAt: created(),
    lastSignInAt: ts('last_sign_in_at'),
  },
  (t) => [uniqueIndex('user_identities_subject').on(t.provider, t.subject), index('user_identities_user').on(t.userId)],
);

/**
 * Single sign-ons in flight: what the callback must check, keyed by the state's hash. A row is
 * taken (deleted) by the one callback that uses it, so a state can't be replayed.
 */
export const authStates = pgTable('auth_states', {
  id: text('id').primaryKey(),
  codeVerifier: text('code_verifier').notNull(),
  nonce: text('nonce').notNull(),
  returnTo: text('return_to').notNull(),
  createdAt: created(),
  expiresAt: ts('expires_at').notNull(),
});

// ---------------------------------------------------------------------------
// Projects & custom fields
// ---------------------------------------------------------------------------

export const projects = pgTable(
  'projects',
  {
    id: text('id').primaryKey(),
    key: text('key').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    leadId: text('lead_id').references(() => users.id, { onDelete: 'set null' }),
    nextNumber: integer('next_number').notNull().default(1),
    archived: boolean('archived').notNull().default(false),
    /** 'open': everyone sees it and works in it. 'members': only its people and administrators see it. */
    visibility: text('visibility').notNull().default('open'),
    settings: jsonb('settings').notNull(),
    createdAt: created(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('projects_key_upper').on(sql`upper(${t.key})`)],
);

/** People's roles in projects (viewer, member, manager). services/access.ts reads it. */
export const projectMembers = pgTable(
  'project_members',
  {
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    addedById: text('added_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: created(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.userId] }), index('project_members_user').on(t.userId)],
);

export const fields = pgTable(
  'fields',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    type: text('type').notNull(),
    multi: boolean('multi').notNull().default(false),
    description: text('description').notNull().default(''),
    ordinal: integer('ordinal').notNull().default(0),
    createdAt: created(),
  },
  (t) => [uniqueIndex('fields_name_lower').on(sql`lower(${t.name})`)],
);

export const fieldValues = pgTable(
  'field_values',
  {
    id: text('id').primaryKey(),
    fieldId: text('field_id')
      .notNull()
      .references(() => fields.id, { onDelete: 'cascade' }),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    tone: text('tone'),
    ordinal: integer('ordinal').notNull().default(0),
    isResolved: boolean('is_resolved').notNull().default(false),
    archived: boolean('archived').notNull().default(false),
  },
  (t) => [index('field_values_field').on(t.fieldId)],
);

export const projectFields = pgTable(
  'project_fields',
  {
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    fieldId: text('field_id')
      .notNull()
      .references(() => fields.id, { onDelete: 'cascade' }),
    ordinal: integer('ordinal').notNull().default(0),
    required: boolean('required').notNull().default(false),
    defaultValue: jsonb('default_value'),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.fieldId] })],
);

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

export const issues = pgTable(
  'issues',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    number: integer('number').notNull(),
    summary: text('summary').notNull(),
    description: text('description').notNull().default(''),
    reporterId: text('reporter_id').references(() => users.id, { onDelete: 'set null' }),
    updatedById: text('updated_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: created(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    resolvedAt: ts('resolved_at'),
    version: integer('version').notNull().default(1),
    searchVector: tsvector('search_vector').generatedAlwaysAs(
      sql`setweight(to_tsvector('english', coalesce(summary, '')), 'A') || setweight(to_tsvector('english', coalesce(description, '')), 'B')`,
    ),
  },
  (t) => [
    uniqueIndex('issues_project_number').on(t.projectId, t.number),
    index('issues_updated').on(t.updatedAt),
    index('issues_created').on(t.createdAt),
    index('issues_search').using('gin', t.searchVector),
    index('issues_summary_trgm').using('gin', sql`${t.summary} gin_trgm_ops`),
  ],
);

export const issueFieldValues = pgTable(
  'issue_field_values',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    issueId: text('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    fieldId: text('field_id')
      .notNull()
      .references(() => fields.id, { onDelete: 'cascade' }),
    valueId: text('value_id').references(() => fieldValues.id, { onDelete: 'cascade' }),
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    textValue: text('text_value'),
    numberValue: doublePrecision('number_value'),
    dateValue: date('date_value', { mode: 'string' }),
  },
  (t) => [
    index('ifv_issue_field').on(t.issueId, t.fieldId),
    index('ifv_field_value').on(t.fieldId, t.valueId),
    index('ifv_field_user').on(t.fieldId, t.userId),
  ],
);

export const tags = pgTable(
  'tags',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    createdById: text('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: created(),
  },
  (t) => [uniqueIndex('tags_name_lower').on(sql`lower(${t.name})`)],
);

export const issueTags = pgTable(
  'issue_tags',
  {
    issueId: text('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    tagId: text('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.issueId, t.tagId] }), index('issue_tags_tag').on(t.tagId)],
);

export const linkTypes = pgTable('link_types', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  outward: text('outward').notNull(),
  inward: text('inward').notNull(),
  directed: boolean('directed').notNull().default(true),
  aggregation: boolean('aggregation').notNull().default(false),
  ordinal: integer('ordinal').notNull().default(0),
});

export const issueLinks = pgTable(
  'issue_links',
  {
    id: text('id').primaryKey(),
    typeId: text('type_id')
      .notNull()
      .references(() => linkTypes.id, { onDelete: 'cascade' }),
    sourceId: text('source_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    targetId: text('target_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    createdById: text('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: created(),
  },
  (t) => [
    uniqueIndex('issue_links_unique').on(t.typeId, t.sourceId, t.targetId),
    index('issue_links_target').on(t.targetId),
  ],
);

export const comments = pgTable(
  'comments',
  {
    id: text('id').primaryKey(),
    issueId: text('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    authorId: text('author_id').references(() => users.id, { onDelete: 'set null' }),
    text: text('text').notNull(),
    channel: text('channel').notNull().default('web'),
    createdAt: created(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    deletedAt: ts('deleted_at'),
    searchVector: tsvector('search_vector').generatedAlwaysAs(sql`to_tsvector('english', coalesce(text, ''))`),
    /** 'internal' (the team alone) or 'public' (also the requester of a help desk request, who is emailed it). */
    visibility: text('visibility').notNull().default('internal'),
    /** Set when the requester of a help desk request wrote it, on their tracking page. */
    requesterId: text('requester_id').references(() => requesters.id, { onDelete: 'set null' }),
  },
  (t) => [index('comments_issue').on(t.issueId, t.createdAt), index('comments_search').using('gin', t.searchVector)],
);

export const workItems = pgTable(
  'work_items',
  {
    id: text('id').primaryKey(),
    issueId: text('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    authorId: text('author_id').references(() => users.id, { onDelete: 'set null' }),
    date: date('date', { mode: 'string' }).notNull(),
    minutes: integer('minutes').notNull(),
    description: text('description').notNull().default(''),
    hourlyRate: doublePrecision('hourly_rate'),
    createdAt: created(),
  },
  (t) => [index('work_items_issue').on(t.issueId), index('work_items_author_date').on(t.authorId, t.date)],
);

// ---------------------------------------------------------------------------
// Activity / event log (powers issue history, the events API, SSE and webhooks)
// ---------------------------------------------------------------------------

export const activities = pgTable(
  'activities',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    type: text('type').notNull(),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'set null' }),
    issueId: text('issue_id').references(() => issues.id, { onDelete: 'set null' }),
    actorId: text('actor_id').references(() => users.id, { onDelete: 'set null' }),
    channel: text('channel').notNull(),
    tokenName: text('token_name'),
    payload: jsonb('payload').notNull(),
    createdAt: created(),
  },
  (t) => [
    index('activities_issue').on(t.issueId, t.id),
    index('activities_project').on(t.projectId, t.id),
    index('activities_created').on(t.createdAt),
    // A sprint's burndown reads who joined and left it by sprint id. Only those rows are in it, so
    // it stays small, and the burndown never scans the projects' whole history to find them.
    index('activities_sprint')
      .on(sql`(${t.payload}->'data'->>'sprintId')`, t.id)
      .where(sql`${t.type} in ('sprint.issue_added', 'sprint.issue_removed')`),
  ],
);

// ---------------------------------------------------------------------------
// Saved searches, boards, sprints
// ---------------------------------------------------------------------------

export const savedSearches = pgTable('saved_searches', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  query: text('query').notNull(),
  shared: boolean('shared').notNull().default(false),
  ordinal: integer('ordinal').notNull().default(0),
  createdAt: created(),
});

export const boards = pgTable('boards', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  projectIds: text('project_ids').array().notNull(),
  columnFieldId: text('column_field_id').references(() => fields.id, { onDelete: 'set null' }),
  columns: jsonb('columns').notNull(),
  swimlaneFieldId: text('swimlane_field_id').references(() => fields.id, { onDelete: 'set null' }),
  query: text('query'),
  sprintsEnabled: boolean('sprints_enabled').notNull().default(false),
  ownerId: text('owner_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: created(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const sprints = pgTable(
  'sprints',
  {
    id: text('id').primaryKey(),
    boardId: text('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    goal: text('goal').notNull().default(''),
    startDate: date('start_date', { mode: 'string' }),
    endDate: date('end_date', { mode: 'string' }),
    archived: boolean('archived').notNull().default(false),
    createdAt: created(),
  },
  (t) => [index('sprints_board').on(t.boardId)],
);

export const sprintIssues = pgTable(
  'sprint_issues',
  {
    sprintId: text('sprint_id')
      .notNull()
      .references(() => sprints.id, { onDelete: 'cascade' }),
    issueId: text('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.sprintId, t.issueId] }), index('sprint_issues_issue').on(t.issueId)],
);

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

export const webhooks = pgTable('webhooks', {
  id: text('id').primaryKey(),
  url: text('url').notNull(),
  secret: text('secret').notNull(),
  events: text('events').array().notNull(),
  projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  active: boolean('active').notNull().default(true),
  createdById: text('created_by_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: created(),
});

export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: text('id').primaryKey(),
    webhookId: text('webhook_id')
      .notNull()
      .references(() => webhooks.id, { onDelete: 'cascade' }),
    eventId: bigint('event_id', { mode: 'number' }),
    eventType: text('event_type').notNull(),
    statusCode: integer('status_code'),
    success: boolean('success').notNull(),
    attempt: integer('attempt').notNull(),
    durationMs: integer('duration_ms').notNull(),
    error: text('error'),
    createdAt: created(),
  },
  (t) => [index('webhook_deliveries_hook').on(t.webhookId, t.createdAt)],
);

// ---------------------------------------------------------------------------
// Planning: baselines
// ---------------------------------------------------------------------------

export const baselines = pgTable(
  'baselines',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    note: text('note').notNull().default(''),
    createdById: text('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: created(),
    start: date('start', { mode: 'string' }),
    finish: date('finish', { mode: 'string' }),
    plannedCost: doublePrecision('planned_cost').notNull().default(0),
  },
  (t) => [index('baselines_project').on(t.projectId)],
);

export const baselineTasks = pgTable(
  'baseline_tasks',
  {
    baselineId: text('baseline_id')
      .notNull()
      .references(() => baselines.id, { onDelete: 'cascade' }),
    issueId: text('issue_id').notNull(),
    readableId: text('readable_id').notNull(),
    summary: text('summary').notNull(),
    start: date('start', { mode: 'string' }).notNull(),
    finish: date('finish', { mode: 'string' }).notNull(),
    effortMinutes: integer('effort_minutes').notNull(),
    cost: doublePrecision('cost').notNull(),
    assigneeId: text('assignee_id'),
  },
  (t) => [primaryKey({ columns: [t.baselineId, t.issueId] })],
);

// ---------------------------------------------------------------------------
// AI
// ---------------------------------------------------------------------------

export const aiSuggestions = pgTable(
  'ai_suggestions',
  {
    id: text('id').primaryKey(),
    issueId: text('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    status: text('status').notNull(),
    payload: jsonb('payload').notNull(),
    model: text('model').notNull(),
    createdAt: created(),
    resolvedAt: ts('resolved_at'),
    resolvedById: text('resolved_by_id').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [index('ai_suggestions_issue').on(t.issueId)],
);

export const aiConversations = pgTable(
  'ai_conversations',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'set null' }),
    status: text('status').notNull().default('idle'),
    context: jsonb('context').notNull(),
    agentVersion: text('agent_version').notNull(),
    pending: jsonb('pending'),
    createdAt: created(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [index('ai_conversations_user').on(t.userId, t.updatedAt)],
);

export const aiMessages = pgTable(
  'ai_messages',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => aiConversations.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    /** Content blocks exactly as sent to / received from the API (append-only). */
    content: jsonb('content').notNull(),
    usage: jsonb('usage'),
    /** For people, not the model: one-line summaries of tool results, page context shown, etc. */
    meta: jsonb('meta'),
    createdAt: created(),
  },
  (t) => [index('ai_messages_conversation').on(t.conversationId, t.id)],
);

// ---------------------------------------------------------------------------
// Workflow rules: change issues when something happens or on a schedule, or
// refuse a change that breaks a rule
// ---------------------------------------------------------------------------

export const rules = pgTable(
  'rules',
  {
    id: text('id').primaryKey(),
    /** null: a global rule, for every project (administrators only). */
    projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** 'change' (when something happens), 'schedule' (every hour or day) or 'guard' (a validation). */
    kind: text('kind').notNull(),
    /** For a change rule: 'created', 'updated' or 'commented'. */
    trigger: text('trigger'),
    /** For a change rule on 'updated': only when this field changes. */
    triggerField: text('trigger_field'),
    /** For a scheduled rule: { every: 'hour' } or { every: 'day' | 'weekday', at: 'HH:MM' }, in the server's time zone. */
    schedule: jsonb('schedule'),
    /** Which issues (change, schedule), or what a guarded change would make an issue match (guard). */
    query: text('query').notNull().default(''),
    /** What to change, in the command language (change, schedule). */
    command: text('command').notNull().default(''),
    comment: text('comment'),
    /** A guard: what the issue must also match. */
    requires: text('requires'),
    /** A guard: what a refused change is told. */
    message: text('message'),
    /** A further condition, on issues related to the one that set it off (RuleRelated). */
    related: jsonb('related'),
    /** The issues it acts on (RuleTarget); null: the issue itself. */
    target: jsonb('target'),
    /** Whom it tells about each issue it acts on, and what (RuleNotify). */
    notify: jsonb('notify'),
    /** A webhook it calls about each issue it acts on. A webhook a rule calls can't be deleted until the rule lets it go. */
    callWebhookId: text('call_webhook_id').references(() => webhooks.id, { onDelete: 'restrict' }),
    enabled: boolean('enabled').notNull().default(true),
    nextRunAt: ts('next_run_at'),
    lastRunAt: ts('last_run_at'),
    version: integer('version').notNull().default(1),
    createdById: text('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    updatedById: text('updated_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: created(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [index('rules_project').on(t.projectId), index('rules_due').on(t.kind, t.nextRunAt)],
);

/** What each rule did, issue by issue: applied, changed nothing, failed, skipped, or refused a change. */
export const ruleRuns = pgTable(
  'rule_runs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    ruleId: text('rule_id')
      .notNull()
      .references(() => rules.id, { onDelete: 'cascade' }),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    issueId: text('issue_id').references(() => issues.id, { onDelete: 'set null' }),
    /** The issue's readable id when it ran, kept if the issue goes. */
    issueKey: text('issue_key'),
    /** The event that set it off (a rule on a change). */
    eventId: bigint('event_id', { mode: 'number' }),
    /**
     * The change that started the chain (an event id), for rules on a change: a rule acts on an
     * issue at most once for it, which makes replays and loops stop.
     */
    originId: text('origin_id'),
    /** Whose change set it off, or whose change it refused. */
    actorId: text('actor_id').references(() => users.id, { onDelete: 'set null' }),
    outcome: text('outcome').notNull(),
    message: text('message').notNull().default(''),
    changes: jsonb('changes'),
    createdAt: created(),
  },
  (t) => [
    index('rule_runs_rule').on(t.ruleId, t.id),
    index('rule_runs_project').on(t.projectId, t.id),
    index('rule_runs_created').on(t.createdAt),
    uniqueIndex('rule_runs_once').on(t.ruleId, t.issueId, t.originId).where(sql`${t.originId} IS NOT NULL`),
  ],
);

// ---------------------------------------------------------------------------
// Version control: GitHub, GitLab, Bitbucket, Gitea and Forgejo send pushes and pull requests here
// ---------------------------------------------------------------------------

export const vcsIntegrations = pgTable('vcs_integrations', {
  id: text('id').primaryKey(),
  /** 'github', 'gitlab', 'bitbucket' (Cloud), 'bitbucket-dc' (Data Center) or 'gitea' (and Forgejo). */
  provider: text('provider').notNull(),
  name: text('name').notNull(),
  /** The projects whose issue ids it looks for; empty: every project. */
  projectIds: text('project_ids').array().notNull(),
  /** All but GitLab sign each delivery with the secret (HMAC-SHA256), so a4a must keep it to check the signature. */
  signingKey: text('signing_key'),
  /** GitLab sends its token as it is, so a4a keeps only the token's SHA-256. */
  tokenHash: text('token_hash'),
  /** The secret's first characters, to recognise it by. */
  secretPrefix: text('secret_prefix').notNull(),
  /** Bitbucket Data Center's address, where a4a reads the commits a push moved (D33). */
  baseUrl: text('base_url'),
  /**
   * Bitbucket: an access token a4a sends to read the commits a delivery leaves out, so a4a keeps
   * it as it is, as it keeps a signing key. It is never shown again (D33).
   */
  accessToken: text('access_token'),
  active: boolean('active').notNull().default(true),
  createdById: text('created_by_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: created(),
  lastDeliveryAt: ts('last_delivery_at'),
});

export const vcsDeliveries = pgTable(
  'vcs_deliveries',
  {
    id: text('id').primaryKey(),
    integrationId: text('integration_id')
      .notNull()
      .references(() => vcsIntegrations.id, { onDelete: 'cascade' }),
    /** The provider's id for the delivery (X-GitHub-Delivery; GitLab's Idempotency-Key): each is handled once. */
    deliveryId: text('delivery_id'),
    event: text('event').notNull(),
    /** received, processed, ignored, refused, duplicate or failed. */
    outcome: text('outcome').notNull(),
    statusCode: integer('status_code').notNull(),
    message: text('message').notNull().default(''),
    linked: integer('linked').notNull().default(0),
    applied: integer('applied').notNull().default(0),
    test: boolean('test').notNull().default(false),
    createdAt: created(),
    finishedAt: ts('finished_at'),
  },
  (t) => [
    uniqueIndex('vcs_deliveries_once').on(t.integrationId, t.deliveryId).where(sql`${t.deliveryId} IS NOT NULL`),
    index('vcs_deliveries_recent').on(t.integrationId, t.createdAt),
  ],
);

/** A commit or a pull request that mentions an issue: one row per issue it mentions. */
export const vcsLinks = pgTable(
  'vcs_links',
  {
    id: text('id').primaryKey(),
    integrationId: text('integration_id').references(() => vcsIntegrations.id, { onDelete: 'set null' }),
    issueId: text('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    /** 'commit' or 'pull_request'. */
    kind: text('kind').notNull(),
    repository: text('repository').notNull(),
    /** A commit's sha, or a pull request's number. */
    ref: text('ref').notNull(),
    title: text('title').notNull(),
    /** The rest of a commit's message, or a pull request's description, cut short. */
    body: text('body').notNull().default(''),
    url: text('url'),
    branch: text('branch'),
    targetBranch: text('target_branch'),
    /** A pull request's state: open, merged or closed. */
    state: text('state'),
    authorName: text('author_name'),
    authorLogin: text('author_login'),
    authorEmail: text('author_email'),
    /** The person in a4a the author was matched to: by a confirmed email, or a login the provider vouches for (D33). */
    authorId: text('author_id').references(() => users.id, { onDelete: 'set null' }),
    /** The command a commit gave this issue ("BACK-12 #Fixed"), whether it was applied, and why not. */
    command: text('command'),
    commandApplied: boolean('command_applied'),
    commandNote: text('command_note'),
    happenedAt: ts('happened_at'),
    createdAt: created(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('vcs_links_once').on(t.issueId, t.kind, t.repository, t.ref), index('vcs_links_ref').on(t.kind, t.repository, t.ref)],
);

// ---------------------------------------------------------------------------
// Infrastructure
// ---------------------------------------------------------------------------

export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    userId: text('user_id').notNull(),
    key: text('key').notNull(),
    method: text('method').notNull(),
    path: text('path').notNull(),
    statusCode: integer('status_code').notNull(),
    responseBody: jsonb('response_body'),
    createdAt: created(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.key] })],
);

export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
});

/**
 * Leader election for background work (webhooks, AI triage) across instances.
 * A lease row is held by one instance and renewed while it lives; it never needs
 * a long transaction or a pinned connection, so it works on PGlite and pooled Postgres.
 */
export const workerLeases = pgTable('worker_leases', {
  name: text('name').primaryKey(),
  holder: text('holder').notNull(),
  expiresAt: ts('expires_at').notNull(),
});

/** Per-consumer position in the activity log (the outbox). */
export const outboxCursors = pgTable('outbox_cursors', {
  consumer: text('consumer').primaryKey(),
  lastId: bigint('last_id', { mode: 'number' }).notNull(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

/**
 * Failed sign-ins per IP and per login, in a fixed window, shared by every instance
 * and kept across restarts. One row per key ("ip:203.0.113.9", "login:anna"), written
 * with an upsert per attempt; housekeeping deletes rows whose window has passed.
 */
export const loginThrottle = pgTable(
  'login_throttle',
  {
    key: text('key').primaryKey(),
    windowStart: ts('window_start').notNull(),
    failures: integer('failures').notNull(),
  },
  (t) => [index('login_throttle_window').on(t.windowStart)],
);

// ---------------------------------------------------------------------------
// Knowledge base: articles in a tree per project, every saved version, and
// mentions between issues and articles
// ---------------------------------------------------------------------------

/**
 * Per project, the next article number (BACK-A-<n>): gap-free, never reused. Its row is
 * also the lock that serialises changes to the project's tree, so two moves can't make a cycle.
 */
export const articleCounters = pgTable('article_counters', {
  projectId: text('project_id')
    .primaryKey()
    .references(() => projects.id, { onDelete: 'cascade' }),
  nextNumber: integer('next_number').notNull().default(1),
});

export const articles = pgTable(
  'articles',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    number: integer('number').notNull(),
    // No action on delete: an article with children can't go, but a project's articles go together.
    parentId: text('parent_id').references((): AnyPgColumn => articles.id),
    position: integer('position').notNull().default(0),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    version: integer('version').notNull().default(1),
    createdById: text('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    updatedById: text('updated_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: created(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    searchVector: tsvector('search_vector').generatedAlwaysAs(
      sql`setweight(to_tsvector('english', coalesce(title, '')), 'A') || setweight(to_tsvector('english', coalesce(body, '')), 'B')`,
    ),
  },
  (t) => [
    uniqueIndex('articles_project_number').on(t.projectId, t.number),
    index('articles_tree').on(t.projectId, t.parentId, t.position),
    index('articles_updated').on(t.updatedAt),
    index('articles_search').using('gin', t.searchVector),
    index('articles_title_trgm').using('gin', sql`${t.title} gin_trgm_ops`),
  ],
);

/** Every save of an article's content: who, when, through what, and the whole text. */
export const articleVersions = pgTable(
  'article_versions',
  {
    articleId: text('article_id')
      .notNull()
      .references(() => articles.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    authorId: text('author_id').references(() => users.id, { onDelete: 'set null' }),
    channel: text('channel').notNull(),
    tokenName: text('token_name'),
    createdAt: created(),
  },
  (t) => [primaryKey({ columns: [t.articleId, t.version] })],
);

/**
 * Issue and article ids written in text: an issue's description or a comment, or an
 * article. The target is kept as written (BACK-12, BACK-A-3), since readable ids are
 * permanent, so a mention of an article that comes later still counts once it exists.
 */
export const mentions = pgTable(
  'mentions',
  {
    sourceType: text('source_type').notNull(), // issue (its description) | comment | article
    sourceId: text('source_id').notNull(),
    issueId: text('issue_id').references(() => issues.id, { onDelete: 'cascade' }),
    articleId: text('article_id').references(() => articles.id, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    targetKind: text('target_kind').notNull(), // issue | article
    target: text('target').notNull(),
  },
  (t) => [primaryKey({ columns: [t.sourceType, t.sourceId, t.target] }), index('mentions_target').on(t.target)],
);

// ---------------------------------------------------------------------------
// Attachments: files on issues, comments and articles
// ---------------------------------------------------------------------------

/**
 * Every object written to attachment storage, recorded before its first byte is. An
 * upload that never finished stays "uploading"; one whose attachment row is gone
 * (deleted, or with its issue, comment, article or project) is "stored" with nothing
 * pointing at it. The sweeper removes both kinds from storage, then here.
 */
export const attachmentBlobs = pgTable('attachment_blobs', {
  key: text('key').primaryKey(),
  state: text('state').notNull().default('uploading'), // uploading | stored
  createdAt: created(),
});

export const attachments = pgTable(
  'attachments',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    // An issue's file, or a comment's (which also names the comment's issue), or an article's.
    issueId: text('issue_id').references(() => issues.id, { onDelete: 'cascade' }),
    commentId: text('comment_id').references(() => comments.id, { onDelete: 'cascade' }),
    articleId: text('article_id').references(() => articles.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    contentType: text('content_type').notNull(),
    size: bigint('size', { mode: 'number' }).notNull(),
    sha256: text('sha256').notNull(),
    blobKey: text('blob_key')
      .notNull()
      .references(() => attachmentBlobs.key),
    uploadedById: text('uploaded_by_id').references(() => users.id, { onDelete: 'set null' }),
    channel: text('channel').notNull(),
    tokenName: text('token_name'),
    createdAt: created(),
  },
  (t) => [
    index('attachments_issue').on(t.issueId, t.createdAt),
    index('attachments_article').on(t.articleId, t.createdAt),
    index('attachments_comment').on(t.commentId),
    uniqueIndex('attachments_blob').on(t.blobKey),
    check('attachments_one_owner', sql`(${t.issueId} IS NULL) <> (${t.articleId} IS NULL) AND (${t.commentId} IS NULL OR ${t.issueId} IS NOT NULL)`),
  ],
);

// ---------------------------------------------------------------------------
// Dashboards
// ---------------------------------------------------------------------------

/** A person's page of widgets: reports with their parameters, saved searches, notes. */
export const dashboards = pgTable(
  'dashboards',
  {
    id: text('id').primaryKey(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    shared: boolean('shared').notNull().default(false),
    widgets: jsonb('widgets').notNull(),
    version: integer('version').notNull().default(1),
    createdAt: created(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [index('dashboards_owner').on(t.ownerId)],
);

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

/** One upload of a CSV export, its mapping, and how its run went. */
export const imports = pgTable(
  'imports',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    source: text('source').notNull(),
    fileName: text('file_name').notNull(),
    createdById: text('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: created(),
    status: text('status').notNull().default('ready'),
    /** The header's names, by column. */
    header: jsonb('header').notNull(),
    rowCount: integer('row_count').notNull().default(0),
    /** Targets by column, which of them were found from the header, value maps, options. */
    mapping: jsonb('mapping').notNull(),
    progressPhase: text('progress_phase'),
    progressDone: integer('progress_done').notNull().default(0),
    progressTotal: integer('progress_total').notNull().default(0),
    /** Renewed while a run works; a run whose heartbeat is old has stopped. */
    heartbeatAt: ts('heartbeat_at'),
    startedAt: ts('started_at'),
    finishedAt: ts('finished_at'),
    error: text('error'),
    result: jsonb('result'),
  },
  (t) => [index('imports_project').on(t.projectId, t.createdAt)],
);

/** The rows of an upload, as parsed, and what became of each. */
export const importRows = pgTable(
  'import_rows',
  {
    importId: text('import_id')
      .notNull()
      .references(() => imports.id, { onDelete: 'cascade' }),
    /** Its row in the file, the header being row 1. */
    n: integer('n').notNull(),
    cells: jsonb('cells').notNull(),
    status: text('status').notNull().default('pending'),
    /** Not a reference: what it became is kept here after the issue is deleted (or undone). */
    issueId: text('issue_id'),
    readableId: text('readable_id'),
    problems: jsonb('problems'),
  },
  (t) => [primaryKey({ columns: [t.importId, t.n] })],
);

/**
 * Which a4a issue an issue of another tracker became, by its key there: what makes running an
 * import again update or skip, never duplicate. Kept apart from the uploads, so a new export of
 * the same project finds the issues an earlier one made.
 */
export const externalIssues = pgTable(
  'external_issues',
  {
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    source: text('source').notNull(),
    externalKey: text('external_key').notNull(),
    /** Jira's numeric issue id, which its exports give parents by. */
    externalId: text('external_id'),
    /** null once the issue is deleted in a4a: a later run then skips it rather than make it again. */
    issueId: text('issue_id').references(() => issues.id, { onDelete: 'set null' }),
    readableId: text('readable_id').notNull(),
    /** The import that created the issue; undoing it may take the issue away. */
    createdByImportId: text('created_by_import_id'),
    lastImportId: text('last_import_id'),
    /** What the import last wrote, so a later run changes only what changed in the export. */
    values: jsonb('values').notNull(),
    createdAt: created(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.source, t.externalKey] }),
    index('external_issues_issue').on(t.issueId),
    index('external_issues_import').on(t.createdByImportId),
    index('external_issues_external_id').on(t.projectId, t.source, t.externalId),
  ],
);

// ---------------------------------------------------------------------------
// Watchers, notifications and mail
// ---------------------------------------------------------------------------

/** Who watches an issue, and why. Unwatching deletes the row; doing something on the issue again watches it again. */
export const issueWatchers = pgTable(
  'issue_watchers',
  {
    issueId: text('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** WATCH_REASONS: 'explicit', 'reporter', 'assignee', 'commenter', 'mentioned', 'lead'. */
    reason: text('reason').notNull(),
    createdAt: created(),
  },
  (t) => [primaryKey({ columns: [t.issueId, t.userId] }), index('issue_watchers_user').on(t.userId)],
);

/**
 * One person's notification about one issue: one or more events folded together while they
 * came within a short window, until it was read or its email went out (sealed).
 */
export const notifications = pgTable(
  'notifications',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    issueId: text('issue_id').references(() => issues.id, { onDelete: 'set null' }),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    /** NOTIFICATION_KINDS: the strongest reason among its events. */
    kind: text('kind').notNull(),
    /** The issue as it was at the latest event (an IssueRef), kept when the issue is deleted. */
    issue: jsonb('issue').notNull(),
    eventCount: integer('event_count').notNull().default(1),
    firstEventAt: ts('first_event_at').notNull(),
    lastEventAt: ts('last_event_at').notNull(),
    createdAt: created(),
    readAt: ts('read_at'),
    /** Set when its email is rendered: it takes no more events, and a new one starts. */
    sealedAt: ts('sealed_at'),
    /** When its email went out, so the digest leaves it out. */
    emailedAt: ts('emailed_at'),
    /** The subscription that brought it, when one did (kind "subscribed"): what the inbox says it came for. */
    subscriptionId: text('subscription_id').references((): AnyPgColumn => subscriptions.id, { onDelete: 'set null' }),
  },
  (t) => [index('notifications_user_last').on(t.userId, t.lastEventAt), index('notifications_user_issue').on(t.userId, t.issueId)],
);

/**
 * Which events reached whom, through which notification. The key makes delivery idempotent:
 * an event the outbox hands over twice reaches a person once.
 */
export const notificationEvents = pgTable(
  'notification_events',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    eventId: bigint('event_id', { mode: 'number' })
      .notNull()
      .references(() => activities.id, { onDelete: 'cascade' }),
    notificationId: text('notification_id')
      .notNull()
      .references(() => notifications.id, { onDelete: 'cascade' }),
    /** Why this event reached them: a NOTIFICATION_KIND. */
    reason: text('reason').notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.eventId] }), index('notification_events_notification').on(t.notificationId)],
);

/** What a person wants by email. No row: the defaults (mentions and assignments, no digest). */
export const notificationSettings = pgTable('notification_settings', {
  userId: text('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  /** EMAIL_LEVELS: 'all', 'direct' or 'none'. */
  email: text('email').notNull().default('direct'),
  digest: boolean('digest').notNull().default(false),
  lastDigestAt: ts('last_digest_at'),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

/**
 * Mail to send, at least once, retried with backoff. `dedupe_key` makes enqueueing idempotent
 * (one mail per notification, per digest day, per help desk event); the body is rendered when
 * it is sent, from `payload`, so it says what is true then and holds no secret while it waits.
 */
export const mailOutbox = pgTable(
  'mail_outbox',
  {
    id: text('id').primaryKey(),
    dedupeKey: text('dedupe_key').notNull().unique(),
    /** 'notification', 'digest', 'request-received', 'request-reply', 'request-state' or 'email-confirm'. */
    kind: text('kind').notNull(),
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    payload: jsonb('payload').notNull(),
    /** 'pending', 'sent', 'failed' (gave up) or 'skipped' (nothing to send any more). */
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    sendAfter: ts('send_after').notNull().defaultNow(),
    /** A sender's claim on it; after this, another may try. */
    lockedUntil: ts('locked_until'),
    /** Stable across retries, so a mail sent twice reads as one. */
    messageId: text('message_id').notNull(),
    toAddress: text('to_address'),
    lastError: text('last_error'),
    createdAt: created(),
    sentAt: ts('sent_at'),
  },
  (t) => [index('mail_outbox_due').on(t.status, t.sendAfter)],
);

// ---------------------------------------------------------------------------
// Help desk
// ---------------------------------------------------------------------------

/** Someone outside the team who asked for help. Not a user: they can't sign in, and aren't assignable. */
export const requesters = pgTable(
  'requesters',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    name: text('name').notNull(),
    createdAt: created(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('requesters_email_lower').on(sql`lower(${t.email})`)],
);

/** An issue that came in through a project's help desk: who asked, and the first-response target then in force. */
export const helpdeskRequests = pgTable(
  'helpdesk_requests',
  {
    issueId: text('issue_id')
      .primaryKey()
      .references(() => issues.id, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    requesterId: text('requester_id')
      .notNull()
      .references(() => requesters.id, { onDelete: 'cascade' }),
    createdAt: created(),
    firstResponseDueAt: ts('first_response_due_at'),
    /** The requester stopped emails about it (one click, from any of them); the tracking page still works. */
    emailMutedAt: ts('email_muted_at'),
    /** How it came in: 'form' (the public page) or 'email' (to the desk's address, D30). */
    via: text('via').notNull().default('form'),
    /**
     * The Message-ID the conversation threads under: the requester's own message when they wrote
     * in, else the first email a4a sent them. Null for requests from before threading.
     */
    threadId: text('thread_id'),
  },
  (t) => [index('helpdesk_requests_requester').on(t.requesterId), index('helpdesk_requests_project').on(t.projectId)],
);

/**
 * Tracking tokens, stored as SHA-256 hashes. Each email to a requester carries a fresh one, minted
 * as it is sent, so no token waits anywhere in plain text; every one stays valid for the request.
 */
export const helpdeskTokens = pgTable(
  'helpdesk_tokens',
  {
    tokenHash: text('token_hash').primaryKey(),
    issueId: text('issue_id')
      .notNull()
      .references(() => helpdeskRequests.issueId, { onDelete: 'cascade' }),
    createdAt: created(),
  },
  (t) => [index('helpdesk_tokens_issue').on(t.issueId)],
);

/**
 * The help desk's limits on what anyone may do without signing in (per address, per email, per
 * desk), in fixed windows, shared by every instance as the sign-in throttle is.
 */
export const helpThrottle = pgTable(
  'help_throttle',
  {
    key: text('key').primaryKey(),
    windowEnds: ts('window_ends').notNull(),
    hits: integer('hits').notNull(),
  },
  (t) => [index('help_throttle_ends').on(t.windowEnds)],
);

// ---------------------------------------------------------------------------
// OAuth for remote MCP (docs/architecture.md, D28)
// ---------------------------------------------------------------------------

/**
 * An app that registered itself (RFC 7591) to ask people for access to /mcp. Public clients only:
 * it gets an id, never a secret. Its name is its own word for itself, and proves nothing.
 */
export const oauthClients = pgTable(
  'oauth_clients',
  {
    id: text('id').primaryKey(),
    name: text('name'),
    redirectUris: text('redirect_uris').array().notNull(),
    /** authorization_code, and refresh_token if it renews its tokens. */
    grantTypes: text('grant_types').array().notNull(),
    /** What it said it would ask for; what it gets is decided at consent. */
    scope: text('scope'),
    softwareId: text('software_id'),
    softwareVersion: text('software_version'),
    createdAt: created(),
    lastUsedAt: ts('last_used_at'),
  },
  (t) => [index('oauth_clients_created').on(t.createdAt)],
);

/**
 * What a person allowed one app: its scopes and projects, as a token's (D15). One live grant per
 * person and app, which is how consent is remembered; a revoked one is kept a while, then pruned.
 */
export const oauthGrants = pgTable(
  'oauth_grants',
  {
    id: text('id').primaryKey(),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClients.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    scopes: text('scopes').array().notNull(),
    /** What the app asked for when the person decided: while it asks no more, it isn't asked again. */
    asked: text('asked').array().notNull(),
    /** The only projects it reaches (ids), or null for every project its person can see. */
    projectIds: text('project_ids').array(),
    createdAt: created(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    lastUsedAt: ts('last_used_at'),
    revokedAt: ts('revoked_at'),
  },
  (t) => [
    index('oauth_grants_user').on(t.userId),
    uniqueIndex('oauth_grants_live').on(t.clientId, t.userId).where(sql`${t.revokedAt} IS NULL`),
  ],
);

/**
 * An authorization code, by its SHA-256: short-lived and single-use, bound to the redirect it was
 * sent to, the PKCE challenge and the resource. Once used it keeps the family of the tokens it
 * gave, so a code that comes back revokes them.
 */
export const oauthCodes = pgTable(
  'oauth_codes',
  {
    id: text('id').primaryKey(),
    grantId: text('grant_id')
      .notNull()
      .references(() => oauthGrants.id, { onDelete: 'cascade' }),
    redirectUri: text('redirect_uri').notNull(),
    codeChallenge: text('code_challenge').notNull(),
    resource: text('resource').notNull(),
    scopes: text('scopes').array().notNull(),
    createdAt: created(),
    expiresAt: ts('expires_at').notNull(),
    usedAt: ts('used_at'),
    familyId: text('family_id'),
  },
  (t) => [index('oauth_codes_grant').on(t.grantId)],
);

/**
 * Access and refresh tokens, by their SHA-256. A family is every token since one code, through each
 * refresh; a refresh token used twice revokes its family. An access token works only for its
 * resource, this server's /mcp.
 */
export const oauthTokens = pgTable(
  'oauth_tokens',
  {
    id: text('id').primaryKey(),
    kind: text('kind').notNull(),
    grantId: text('grant_id')
      .notNull()
      .references(() => oauthGrants.id, { onDelete: 'cascade' }),
    familyId: text('family_id').notNull(),
    resource: text('resource').notNull(),
    scopes: text('scopes').array().notNull(),
    createdAt: created(),
    expiresAt: ts('expires_at').notNull(),
    /** A refresh token, once exchanged for the next one. */
    usedAt: ts('used_at'),
    revokedAt: ts('revoked_at'),
  },
  (t) => [index('oauth_tokens_family').on(t.familyId), index('oauth_tokens_grant').on(t.grantId), index('oauth_tokens_expires').on(t.expiresAt)],
);

// Days away, and the load grid's window: package 10 (docs/architecture.md, D36)
// ---------------------------------------------------------------------------

/**
 * A person's days away: whole days from `startDate` to `endDate`, or, with `half`, the morning or
 * the afternoon of the one day they name. Plans skip them for that person's work. Who entered one
 * is kept on it: days away aren't events, since the feed would tell everyone who can read it.
 */
export const absences = pgTable(
  'absences',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    startDate: date('start_date', { mode: 'string' }).notNull(),
    endDate: date('end_date', { mode: 'string' }).notNull(),
    /** 'morning' | 'afternoon', on a one-day absence; null for whole days. */
    half: text('half'),
    /** 'holiday' | 'sick' | 'training' | 'other': seen only by the person, administrators and whoever entered it. */
    kind: text('kind').notNull(),
    note: text('note').notNull().default(''),
    version: integer('version').notNull().default(1),
    createdById: text('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    updatedById: text('updated_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: created(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [index('absences_user_dates').on(t.userId, t.startDate, t.endDate)],
);

/** What each person chose to see, kept for them across devices: the load grid's window, for now. */
export const userPreferences = pgTable('user_preferences', {
  userId: text('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  preferences: jsonb('preferences').notNull().default({}),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

// Groups, and SAML sign-in (package 1: docs/architecture.md, D27)
// ---------------------------------------------------------------------------

/**
 * A group of people, which a project can give a role as it gives one to a person. One with a
 * `provider_name` comes from the identity provider: who is in it is set at each sign-in, from the
 * groups the provider says the person is in, and never by hand. One without is kept by hand.
 */
export const groups = pgTable(
  'groups',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    /** Its name at the identity provider (an OIDC claim's or a SAML attribute's value), when it comes from there. */
    providerName: text('provider_name'),
    createdById: text('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: created(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('groups_name_lower').on(sql`lower(${t.name})`), uniqueIndex('groups_provider_name_lower').on(sql`lower(${t.providerName})`)],
);

/** Who is in a group. `added_by_id` is null for someone the identity provider put there. */
export const groupMembers = pgTable(
  'group_members',
  {
    groupId: text('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    addedById: text('added_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: created(),
  },
  (t) => [primaryKey({ columns: [t.groupId, t.userId] }), index('group_members_user').on(t.userId)],
);

/** A group's role in a project (viewer, member, manager): everyone in it has at least that role there. services/access.ts reads it. */
export const projectGroupRoles = pgTable(
  'project_group_roles',
  {
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    groupId: text('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    addedById: text('added_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: created(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.groupId] }), index('project_group_roles_group').on(t.groupId)],
);

/**
 * What SAML sign-in must remember between requests, shared by every instance: each AuthnRequest's
 * id until its response comes back (taken once), and each assertion's id until it would expire, so
 * no response is accepted twice. Keys are hashed.
 */
export const samlCache = pgTable(
  'saml_cache',
  {
    key: text('key').primaryKey(),
    value: text('value').notNull(),
    createdAt: created(),
    expiresAt: ts('expires_at').notNull(),
  },
  (t) => [index('saml_cache_expires').on(t.expiresAt)],
);

// The help desk by email (D30): a desk's address, the tokens in its reply addresses, what came in,
// and how far the shared mailbox has been read
// ---------------------------------------------------------------------------

/**
 * A help desk's address, and the secret its mail provider sends with what it posts there. The
 * address is public (people write to it) and belongs to one desk; the secret is kept as a SHA-256
 * hash, shown once, like an API token.
 */
export const helpdeskMailboxes = pgTable(
  'helpdesk_mailboxes',
  {
    projectId: text('project_id')
      .primaryKey()
      .references(() => projects.id, { onDelete: 'cascade' }),
    address: text('address').notNull(),
    secretHash: text('secret_hash'),
    /** The secret's first characters, so people can tell which one a provider has. */
    secretPrefix: text('secret_prefix'),
    createdAt: created(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('helpdesk_mailboxes_address').on(sql`lower(${t.address})`)],
);

/**
 * The tokens in reply addresses (support+token@…), as SHA-256 hashes. Each email to a requester
 * mints one, as tracking tokens are minted, and every one stays good for its request.
 */
export const helpdeskReplyTokens = pgTable(
  'helpdesk_reply_tokens',
  {
    tokenHash: text('token_hash').primaryKey(),
    issueId: text('issue_id')
      .notNull()
      .references(() => helpdeskRequests.issueId, { onDelete: 'cascade' }),
    createdAt: created(),
  },
  (t) => [index('helpdesk_reply_tokens_issue').on(t.issueId)],
);

/**
 * Each message that came in for a desk, once (by its Message-ID): what became of it, and why. The
 * row is claimed before the work, so a message sent again, or read twice, changes nothing twice.
 * Kept 30 days, for the desk's managers.
 */
export const helpdeskInbound = pgTable(
  'helpdesk_inbound',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    messageId: text('message_id').notNull(),
    /** 'webhook' or 'imap'. */
    via: text('via').notNull(),
    sender: text('sender').notNull(),
    subject: text('subject').notNull(),
    /** 'received' while it's worked on, then 'request', 'reply', 'ignored', 'refused' or 'failed'. */
    outcome: text('outcome').notNull(),
    reason: text('reason').notNull().default(''),
    issueId: text('issue_id').references(() => issues.id, { onDelete: 'set null' }),
    commentId: text('comment_id'),
    createdAt: created(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('helpdesk_inbound_message').on(t.projectId, t.messageId),
    index('helpdesk_inbound_project_created').on(t.projectId, t.createdAt),
    index('helpdesk_inbound_created').on(t.createdAt),
  ],
);

/** How far the shared help desk mailbox (HELPDESK_IMAP_URL) has been read: by UID, within its UIDVALIDITY. */
export const helpdeskImapState = pgTable('helpdesk_imap_state', {
  /** A hash of the server, user and folder, so a new mailbox starts afresh. */
  mailbox: text('mailbox').primaryKey(),
  uidValidity: bigint('uid_validity', { mode: 'number' }).notNull(),
  lastUid: bigint('last_uid', { mode: 'number' }).notNull(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

// Agents acting as themselves (docs/architecture.md, D34)
// ---------------------------------------------------------------------------

/**
 * A change an agent made on its own, kept with what undoing it puts back. Written in the change's
 * own transaction. `activityId` is the change's event on its issue; a link's change has a second
 * event, on the other issue (`pairActivityId`), so undoing it from either history finds it. Undoing
 * claims the row (`undoneActivityId`), conditionally, so a change is undone once.
 */
export const agentChanges = pgTable(
  'agent_changes',
  {
    id: text('id').primaryKey(),
    issueId: text('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    activityId: bigint('activity_id', { mode: 'number' }).notNull(),
    pairActivityId: bigint('pair_activity_id', { mode: 'number' }),
    /** What undoing it puts back, and what it left, to tell whether that changed since (AgentUndo in services/agents.ts). */
    undo: jsonb('undo').notNull(),
    actorId: text('actor_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: created(),
    undoneActivityId: bigint('undone_activity_id', { mode: 'number' }),
    undoneById: text('undone_by_id').references(() => users.id, { onDelete: 'set null' }),
    undoneAt: ts('undone_at'),
  },
  (t) => [
    uniqueIndex('agent_changes_activity').on(t.activityId),
    uniqueIndex('agent_changes_pair').on(t.pairActivityId),
    index('agent_changes_issue').on(t.issueId),
  ],
);

// ---------------------------------------------------------------------------
// Subscriptions (D31): a person's subscriptions to a project or to a saved search
// ---------------------------------------------------------------------------

/**
 * A person's subscription to a project (its new issues, or every change in it), or to a saved search
 * (an issue coming into it, or any change to one in it). Exactly one of the two is set.
 */
export const subscriptions = pgTable(
  'subscriptions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    savedSearchId: text('saved_search_id').references(() => savedSearches.id, { onDelete: 'cascade' }),
    /** SUBSCRIPTION_EVENTS: 'new' or 'all'. */
    events: text('events').notNull(),
    /** Whether it emails too, as the person's email level allows. */
    email: boolean('email').notNull().default(true),
    createdAt: created(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('subscriptions_user_project').on(t.userId, t.projectId),
    uniqueIndex('subscriptions_user_search').on(t.userId, t.savedSearchId),
    index('subscriptions_project').on(t.projectId),
    index('subscriptions_search').on(t.savedSearchId),
    check('subscriptions_one_target', sql`(${t.projectId} IS NULL) <> (${t.savedSearchId} IS NULL)`),
  ],
);

/**
 * The issues a saved-search subscription knows to be in its search, as its person sees it, so that
 * an issue coming into the search can be told from one already in it. Kept by the notifier, an
 * issue's own events at a time.
 */
export const subscriptionIssues = pgTable(
  'subscription_issues',
  {
    subscriptionId: text('subscription_id')
      .notNull()
      .references(() => subscriptions.id, { onDelete: 'cascade' }),
    issueId: text('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.subscriptionId, t.issueId] }), index('subscription_issues_issue').on(t.issueId)],
);

// ---------------------------------------------------------------------------
// Version control: Bitbucket, more emails, provider logins (D33)
// ---------------------------------------------------------------------------

/**
 * A person's emails beside their primary one (users.email). Each counts once it's confirmed: by a
 * link a4a mailed to it, opened by the person signed in, or by an administrator who set it. Then
 * commits under it are theirs, as under a verified primary email.
 */
export const userEmails = pgTable(
  'user_emails',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    confirmedAt: ts('confirmed_at'),
    /** The person, by the link, or the administrator who set it. */
    confirmedById: text('confirmed_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: created(),
  },
  (t) => [uniqueIndex('user_emails_once').on(t.userId, sql`lower(${t.email})`), index('user_emails_address').on(sql`lower(${t.email})`)],
);

/**
 * Links a4a mailed to confirm an email, kept as SHA-256 hashes. Each is minted as its mail is
 * sent, works once, and expires; the person it was minted for must be signed in to use it.
 */
export const emailConfirmations = pgTable(
  'email_confirmations',
  {
    tokenHash: text('token_hash').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The email it confirms: the person's primary one, or one of user_emails. */
    email: text('email').notNull(),
    expiresAt: ts('expires_at').notNull(),
    createdAt: created(),
  },
  (t) => [index('email_confirmations_user').on(t.userId), index('email_confirmations_expires').on(t.expiresAt)],
);

/**
 * A person's login at a kind of version control provider, recorded by an administrator: a
 * commit or pull request the provider says that account wrote is the person's. Kept as written,
 * matched without regard to case.
 */
export const providerLogins = pgTable(
  'provider_logins',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** One of VCS_PROVIDERS. */
    provider: text('provider').notNull(),
    login: text('login').notNull(),
    /** The login as matched: lower case, and for Bitbucket Cloud a UUID without its braces. */
    matchKey: text('match_key').notNull(),
    addedById: text('added_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: created(),
  },
  (t) => [uniqueIndex('provider_logins_once').on(t.provider, t.matchKey), index('provider_logins_user').on(t.userId)],
);
