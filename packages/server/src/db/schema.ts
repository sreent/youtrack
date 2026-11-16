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
    /** 'notification', 'digest', 'request-received', 'request-reply' or 'request-state'. */
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
