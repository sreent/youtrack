import { sql } from 'drizzle-orm';
import {
  bigserial,
  bigint,
  boolean,
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
    /** When an administrator vouched for the email (set it, or confirmed it); null while only its owner says so. */
    emailVerifiedAt: ts('email_verified_at'),
    passwordHash: text('password_hash'),
    role: text('role').notNull().default('member'),
    isBot: boolean('is_bot').notNull().default(false),
    avatarColor: text('avatar_color').notNull(),
    banned: boolean('banned').notNull().default(false),
    hourlyRate: doublePrecision('hourly_rate'),
    capacityHoursPerDay: doublePrecision('capacity_hours_per_day').notNull().default(8),
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
    createdAt: created(),
    lastUsedAt: ts('last_used_at'),
    expiresAt: ts('expires_at'),
    revokedAt: ts('revoked_at'),
  },
  (t) => [index('api_tokens_user').on(t.userId)],
);

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
    settings: jsonb('settings').notNull(),
    createdAt: created(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('projects_key_upper').on(sql`upper(${t.key})`)],
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
// Version control: GitHub and GitLab send pushes and pull requests here
// ---------------------------------------------------------------------------

export const vcsIntegrations = pgTable('vcs_integrations', {
  id: text('id').primaryKey(),
  /** 'github' or 'gitlab'. */
  provider: text('provider').notNull(),
  name: text('name').notNull(),
  /** The projects whose issue ids it looks for; empty: every project. */
  projectIds: text('project_ids').array().notNull(),
  /** GitHub signs each delivery with the secret (HMAC-SHA256), so a4a must keep it to check the signature. */
  signingKey: text('signing_key'),
  /** GitLab sends its token as it is, so a4a keeps only the token's SHA-256. */
  tokenHash: text('token_hash'),
  /** The secret's first characters, to recognise it by. */
  secretPrefix: text('secret_prefix').notNull(),
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
    /** The person in a4a the author was matched to, by their verified email. */
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
