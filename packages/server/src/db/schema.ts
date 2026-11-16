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
