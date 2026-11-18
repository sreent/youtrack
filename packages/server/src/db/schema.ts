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
import type { ProblemSaid } from '@a4a/shared/i18n';

const tsvector = customType<{ data: string }>({
  dataType() {
    return 'tsvector';
  },
});

/** Raw bytes: an app's files (D48). PGlite reads them back as a Uint8Array, node-postgres as a Buffer. */
const bytea = customType<{ data: Buffer; driverData: Buffer | Uint8Array }>({
  dataType() {
    return 'bytea';
  },
  fromDriver(value) {
    return Buffer.isBuffer(value) ? value : Buffer.from(value);
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
    /**
     * a4a's own account that signs in with passkeys alone, no password (D68): made so by an
     * administrator, with a link to add its first passkey, or by its person removing their password.
     */
    passkeysOnly: boolean('passkeys_only').notNull().default(false),
    /** Where passkeys are required, an administrator let them sign in without one, for a device that can't make one (D68). */
    passkeyExemptAt: ts('passkey_exempt_at'),
    role: text('role').notNull().default('member'),
    isBot: boolean('is_bot').notNull().default(false),
    avatarColor: text('avatar_color').notNull(),
    banned: boolean('banned').notNull().default(false),
    hourlyRate: doublePrecision('hourly_rate'),
    capacityHoursPerDay: doublePrecision('capacity_hours_per_day').notNull().default(8),
    /**
     * Their working week (D43): hours on each weekday, Sunday first. Null: the plan's working
     * days at their capacity. The timesheet, the load grid, scheduling and levelling use it.
     */
    workWeek: jsonb('work_week').$type<number[]>(),
    /** Their time zone (IANA), for "today" in their searches, their digest's hour and their email's times. Null: the server's. */
    timeZone: text('time_zone'),
    /** The language they read a4a in (D49): one of LOCALES, or null for their browser's (and, by email, the server's default). */
    locale: text('locale'),
    /** When they last signed in, whichever way: a password, a passkey or single sign-on (D62). Null: not since this was kept. */
    lastSignInAt: ts('last_sign_in_at'),
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
    /**
     * How it was signed in (D62): `password`, `ldap`, `oidc` or `saml`, then `+totp`, `+recovery` or
     * `+passkey` for a second step; or `passkey`, both factors at once. Null for sessions from before,
     * never recent enough to add or remove a passkey until their person confirms it's them (`confirmed`).
     */
    signedInWith: text('signed_in_with'),
    /** The passkey that signed it in, first or second: removing that passkey ends the session. */
    passkeyId: text('passkey_id'),
    /** When its person last proved it's them in it: at the sign-in, or since, to add or remove a passkey. */
    verifiedAt: ts('verified_at').notNull().defaultNow(),
    /** How they proved it then: `passkey`, or `password` (D68). Removing a password takes a passkey's proof. */
    verifiedBy: text('verified_by'),
  },
  (t) => [index('sessions_user').on(t.userId), index('sessions_passkey').on(t.passkeyId)],
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
    /**
     * Microsoft Entra ID's object id and tenant for the person (the ID token's `oid` and `tid`), kept
     * from each sign-in: Teams names people by them, so Teams knows them without linking (D42).
     */
    objectId: text('object_id'),
    tenantId: text('tenant_id'),
  },
  (t) => [
    uniqueIndex('user_identities_subject').on(t.provider, t.subject),
    index('user_identities_user').on(t.userId),
    index('user_identities_object').on(t.tenantId, t.objectId),
  ],
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
    /** Anyone may read it without signing in (D37). */
    guestAccess: boolean('guest_access').notNull().default(false),
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
    /**
     * The names it had before it was renamed. History keeps a change under the name the field had
     * then, so a private field's changes are known by these too (D50).
     */
    formerNames: text('former_names').array().notNull().default(sql`'{}'::text[]`),
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
    /** An owned field's value: who owns it, and is assigned an issue given it while it has nobody (D41). */
    ownerId: text('owner_id').references(() => users.id, { onDelete: 'set null' }),
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
    /** A query: the field shows, and is required if it is, only while the issue matches it (D41). Null: always. */
    condition: text('condition'),
    /**
     * Private in this project (D50): its values, and changes to them, reach only people whose role
     * here may read private fields, and only those who may change them set it.
     */
    private: boolean('private').notNull().default(false),
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
    /** How many people voted for it (issue_votes), kept here so sorting by it reads nothing else (D41). */
    votes: integer('votes').notNull().default(0),
    searchVector: tsvector('search_vector').generatedAlwaysAs(
      sql`setweight(to_tsvector('english', coalesce(summary, '')), 'A') || setweight(to_tsvector('english', coalesce(description, '')), 'B')`,
    ),
    /**
     * Limited to some people and groups (D37): then only they see it, besides its reporter, its
     * assignee, the project's managers and administrators.
     */
    limited: boolean('limited').notNull().default(false),
    visibleUserIds: text('visible_user_ids').array().notNull().default(sql`'{}'::text[]`),
    visibleGroupIds: text('visible_group_ids').array().notNull().default(sql`'{}'::text[]`),
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
    /** A group field's value (D41). */
    groupId: text('group_id').references((): AnyPgColumn => groups.id, { onDelete: 'cascade' }),
    /** A date-and-time field's value, an instant (D41). */
    timeValue: ts('time_value'),
  },
  (t) => [
    index('ifv_issue_field').on(t.issueId, t.fieldId),
    index('ifv_field_value').on(t.fieldId, t.valueId),
    index('ifv_field_user').on(t.fieldId, t.userId),
    index('ifv_field_group').on(t.fieldId, t.groupId),
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
    /** Raised by every edit, so one made against an older version is refused (a ticked checklist item, say: D39). */
    version: integer('version').notNull().default(1),
    deletedAt: ts('deleted_at'),
    searchVector: tsvector('search_vector').generatedAlwaysAs(sql`to_tsvector('english', coalesce(text, ''))`),
    /** 'internal' (the team alone) or 'public' (also the requester of a help desk request, who is emailed it). */
    visibility: text('visibility').notNull().default('internal'),
    /** Set when the requester of a help desk request wrote it, on their tracking page. */
    requesterId: text('requester_id').references(() => requesters.id, { onDelete: 'set null' }),
    /** Limited to some people and groups (D37): then only they see it, besides its author, the project's managers and administrators. */
    limited: boolean('limited').notNull().default(false),
    visibleUserIds: text('visible_user_ids').array().notNull().default(sql`'{}'::text[]`),
    visibleGroupIds: text('visible_group_ids').array().notNull().default(sql`'{}'::text[]`),
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
    /** What kind of work it was, from the project's list (D43). */
    workTypeId: text('work_type_id').references((): AnyPgColumn => workTypes.id, { onDelete: 'set null' }),
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
    // Articles that were limited when they were deleted (D51): their history stays hidden, so every
    // feed asks of these few rows.
    index('activities_article_gone')
      .on(t.projectId)
      .where(sql`${t.type} = 'article.deleted' and ${t.payload}->'data'->>'limited' = 'true'`),
    // Issues' deletions (D37): what was limited on one stays hidden, so every feed and inbox asks of these rows.
    index('activities_issue_gone').on(t.projectId).where(sql`${t.type} = 'issue.deleted'`),
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
  /** The query its backlog is planned from (D43); null: unresolved issues of its projects. */
  backlogQuery: text('backlog_query'),
  /** The field its story points are in (D43), summed on columns and sprints. */
  pointsFieldId: text('points_field_id').references(() => fields.id, { onDelete: 'set null' }),
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
    /**
     * A scripted rule's JavaScript (D40), run in the sandbox in place of its command (a change or
     * scheduled rule) or of what it requires (a guard). Only administrators write scripts.
     */
    script: text('script'),
    /** The app that installed it (D48): it acts as that app's agent, where the app is enabled, and goes with it. */
    appId: text('app_id').references((): AnyPgColumn => apps.id, { onDelete: 'cascade' }),
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
    /** What it did, in English, for the API. */
    message: text('message').notNull().default(''),
    /** The message in the catalogs, a sentence each, for a page in another language (D49). Null before a4a kept them, and where the message is the rule's own words. */
    said: jsonb('said').$type<{ key: string; values?: Record<string, unknown> }[]>(),
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
  /**
   * GitHub: the GitHub App a4a reads as instead of a person's token (D54). Its id (or client id)
   * names it in the JSON web tokens a4a signs with its private key, kept sealed (lib/secret-box.ts)
   * and never shown again. The installation's tokens last an hour and are kept only in memory.
   */
  githubAppId: text('github_app_id'),
  githubAppKey: text('github_app_key'),
  /** The installation a4a reads through: chosen by the administrator, or found from the app's installations. */
  githubInstallationId: text('github_installation_id'),
  /** What GitHub calls the app (its slug) and the account it's installed on, to show. */
  githubAppSlug: text('github_app_slug'),
  githubAccount: text('github_account'),
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
    /** What it changed, or why not, in English, for the API. */
    commandNote: text('command_note'),
    /** The note in the catalogs, a key and its values, for a page in another language (D49). Null before a4a kept it, and where the note is only field names and values. */
    commandSaid: jsonb('command_said').$type<{ key: string; values?: Record<string, unknown> }>(),
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
    /**
     * Limited to some people and groups (D51): then only they see it, and what is under it, besides
     * its author, the project's managers and administrators. A limit above it narrows it too.
     */
    limited: boolean('limited').notNull().default(false),
    visibleUserIds: text('visible_user_ids').array().notNull().default(sql`'{}'::text[]`),
    visibleGroupIds: text('visible_group_ids').array().notNull().default(sql`'{}'::text[]`),
  },
  (t) => [
    uniqueIndex('articles_project_number').on(t.projectId, t.number),
    index('articles_tree').on(t.projectId, t.parentId, t.position),
    // Who doesn't see what starts from the few that are limited (D51).
    index('articles_limited').on(t.projectId).where(sql`${t.limited}`),
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
    /**
     * An import from another tracker's API: where it reads (base address, query), whom the token
     * signed in as, what it brings, and how far the fetch has come. Never the token itself.
     * Null for a file.
     */
    origin: jsonb('origin'),
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
    /**
     * An issue read from an API brings what a file's cells can't hold: its comments, work items
     * and files, each with its id there, so running again adds only what's new. Null for a file.
     */
    extra: jsonb('extra'),
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
    /** WATCH_REASONS: 'explicit', 'reporter', 'assignee', 'commenter', 'mentioned', 'lead', 'message' (wrote the chat message it was made from, D60). */
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
  /** The same levels, for push notifications to the person's devices (D47). */
  push: text('push').notNull().default('direct'),
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

/** Someone outside the team who asked for help. Not a user: they sign in to the portal alone (D45, D63), and aren't assignable. */
export const requesters = pgTable(
  'requesters',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    name: text('name').notNull(),
    /** Their portal password (D63), as scrypt hashes members' (lib/crypto.ts); null for none. It opens the portal alone. */
    passwordHash: text('password_hash'),
    passwordSetAt: ts('password_set_at'),
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
    /** Since when it has been in one of the desk's waiting states (D45): a requester's answer after it ends the wait. */
    waitingSince: ts('waiting_since'),
    /**
     * The customer group it was filed under (D56): its requester's at the desk then, or the one the
     * team gave it since. Kept, as its project is: joining or leaving a group moves no request.
     */
    groupId: text('group_id').references((): AnyPgColumn => customerGroups.id, { onDelete: 'set null' }),
    /** Kept from its group's other members (D56), by its requester or the team: to them it's missing. */
    private: boolean('private').notNull().default(false),
  },
  (t) => [index('helpdesk_requests_requester').on(t.requesterId), index('helpdesk_requests_project').on(t.projectId), index('helpdesk_requests_group').on(t.groupId)],
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
    /**
     * An app known by its client ID metadata document (D38): its id is that document's https
     * address, and these say when a4a last read it and until when that reading holds. Null for an
     * app that registered itself.
     */
    documentFetchedAt: ts('document_fetched_at'),
    documentExpiresAt: ts('document_expires_at'),
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
    /** The desk's own IMAP mailbox (D45), its URL with its password sealed (lib/secret-box.ts); null when it has none. */
    imapUrlSealed: text('imap_url_sealed'),
    /** The name mail to the desk's requesters comes from, beside its address (D45). */
    fromName: text('from_name'),
    /** When its own mailbox was last read, and what went wrong, if anything did. */
    imapReadAt: ts('imap_read_at'),
    imapError: text('imap_error'),
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
    /**
     * Whom the email was to, when it wasn't the requester: someone copied on the request (D57). A
     * reply address answers for that address alone, and only while it is copied. Null: the requester.
     */
    email: text('email'),
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
    /** The kinds of change it tells of, and how (D45); null follows the person's defaults. */
    kinds: jsonb('kinds').$type<Record<string, { inbox: boolean; email: boolean }> | null>(),
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
    /**
     * The provider's own id for the account, when the person connected it themselves by signing in
     * there (D46): proof the account is theirs, which an administrator's record isn't. Null otherwise.
     */
    providerUserId: text('provider_user_id'),
    createdAt: created(),
  },
  (t) => [uniqueIndex('provider_logins_once').on(t.provider, t.matchKey), index('provider_logins_user').on(t.userId)],
);

// ---------------------------------------------------------------------------
// Issues and fields (package 5: docs/architecture.md, D41)
// ---------------------------------------------------------------------------

/**
 * The ids an issue had before it moved: (its old project, its old number) still finds it, in
 * addresses, the API, MCP, Markdown and commit messages. A project's numbers are never given out
 * twice, so an alias never meets a live issue.
 */
export const issueAliases = pgTable(
  'issue_aliases',
  {
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    number: integer('number').notNull(),
    issueId: text('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    movedById: text('moved_by_id').references(() => users.id, { onDelete: 'set null' }),
    movedAt: created(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.number] }), index('issue_aliases_issue').on(t.issueId)],
);

/** Who voted for an issue; issues.votes counts them. */
export const issueVotes = pgTable(
  'issue_votes',
  {
    issueId: text('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: created(),
  },
  (t) => [primaryKey({ columns: [t.issueId, t.userId] }), index('issue_votes_user').on(t.userId)],
);

/**
 * A reaction to an issue's description (`target_id` is the issue's id) or to a comment (the
 * comment's), from a fixed set (REACTIONS). `issue_id` is the issue either way, for access.
 */
export const reactions = pgTable(
  'reactions',
  {
    targetKind: text('target_kind').notNull(),
    targetId: text('target_id').notNull(),
    issueId: text('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    emoji: text('emoji').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: created(),
  },
  (t) => [primaryKey({ columns: [t.targetKind, t.targetId, t.emoji, t.userId] }), index('reactions_issue').on(t.issueId)],
);

// ---------------------------------------------------------------------------
// Scripted workflows: state machines and custom actions (docs/architecture.md, D40)
// ---------------------------------------------------------------------------

/**
 * A project's state machine for one of its state fields: the moves allowed between its values.
 * A change that moves the field another way is refused in the write path. Reference data: it loads
 * with the schema snapshot, so a project without one pays no query.
 */
export const stateMachines = pgTable(
  'state_machines',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    fieldId: text('field_id')
      .notNull()
      .references(() => fields.id, { onDelete: 'cascade' }),
    /** StateTransition[]: each a name, the states it leaves ("*": any), the one it reaches, a condition and an action. */
    transitions: jsonb('transitions').notNull().default([]),
    enabled: boolean('enabled').notNull().default(true),
    version: integer('version').notNull().default(1),
    createdById: text('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    updatedById: text('updated_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: created(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('state_machines_project_field').on(t.projectId, t.fieldId)],
);

/**
 * A project's custom action: a named thing people do to an issue, as a command or a script, offered
 * on the issue's page and understood by the command language. It runs as whoever does it.
 */
export const workflowActions = pgTable(
  'workflow_actions',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** What it does, in the command language; empty for a scripted action. */
    command: text('command').notNull().default(''),
    /** A scripted action's JavaScript (administrators only). */
    script: text('script'),
    /** When it's offered, in the query language; empty: always. */
    condition: text('condition').notNull().default(''),
    enabled: boolean('enabled').notNull().default(true),
    position: integer('position').notNull().default(0),
    version: integer('version').notNull().default(1),
    createdById: text('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    updatedById: text('updated_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: created(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('workflow_actions_name').on(t.projectId, sql`lower(${t.name})`)],
);

// ---------------------------------------------------------------------------
// Access in depth (D37): roles an administrator defines
// ---------------------------------------------------------------------------

/**
 * A custom role: a set of permissions (PERMISSIONS in @a4a/shared). People and groups are given it
 * in projects as they're given the built-in viewer, member and manager, which aren't rows: their
 * ids are the role column's values there, and a custom role's id goes beside them.
 */
export const roles = pgTable(
  'roles',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    permissions: text('permissions').array().notNull(),
    version: integer('version').notNull().default(1),
    createdAt: created(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('roles_name').on(sql`lower(${t.name})`)],
);

// ---------------------------------------------------------------------------
// Identity in depth (D38): two-factor sign-in, sign-ins halfway, SCIM provisioning
// ---------------------------------------------------------------------------

/**
 * A person's second factor: a TOTP secret (RFC 6238), kept encrypted (lib/secret-box.ts). It counts
 * once confirmed by a code; until then it is an enrolment under way. `lastStep` is the 30-second
 * step of the last code taken, so no code works twice.
 */
export const userTotp = pgTable('user_totp', {
  userId: text('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  secret: text('secret').notNull(),
  confirmedAt: ts('confirmed_at'),
  lastStep: integer('last_step'),
  createdAt: created(),
});

/** Codes for when the authenticator is lost: each a hash, each good once. */
export const recoveryCodes = pgTable(
  'recovery_codes',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(),
    usedAt: ts('used_at'),
    createdAt: created(),
  },
  (t) => [index('recovery_codes_user').on(t.userId)],
);

/**
 * A sign-in halfway: the password was right, and a second step is owed, to check a code
 * (`verify`) or to set two-factor up first (`enroll`). Its token is a cookie's, kept as a hash.
 */
export const signInTickets = pgTable(
  'sign_in_tickets',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    purpose: text('purpose').notNull(),
    attempts: integer('attempts').notNull().default(0),
    expiresAt: ts('expires_at').notNull(),
    createdAt: created(),
  },
  (t) => [index('sign_in_tickets_expires').on(t.expiresAt)],
);

/** What an identity provider provisions with (SCIM 2.0): a token an administrator issues, kept as a hash. */
export const scimTokens = pgTable('scim_tokens', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  prefix: text('prefix').notNull(),
  createdById: text('created_by_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: created(),
  lastUsedAt: ts('last_used_at'),
  revokedAt: ts('revoked_at'),
});

/** A person the provider provisioned: their userName and id there. */
export const scimUsers = pgTable(
  'scim_users',
  {
    userId: text('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    userName: text('user_name').notNull(),
    externalId: text('external_id'),
    /** The parts of their name as the provider sent them, so they read back as sent. */
    nameParts: jsonb('name_parts').$type<{ givenName?: string; familyName?: string; formatted?: string; displayName?: string }>().notNull().default({}),
    createdAt: created(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('scim_users_user_name_lower').on(sql`lower(${t.userName})`)],
);

/** A group the provider provisioned: its id there. The group follows the provider (D27). */
export const scimGroups = pgTable('scim_groups', {
  groupId: text('group_id')
    .primaryKey()
    .references(() => groups.id, { onDelete: 'cascade' }),
  externalId: text('external_id'),
  createdAt: created(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Agile and time tracking (docs/architecture.md, D43)
// ---------------------------------------------------------------------------

/**
 * An issue's place on a board, shared by its backlog and its columns: lower comes first. Ranks
 * are numbers with gaps; an issue without one comes after those with one, in the query's order.
 */
export const boardRanks = pgTable(
  'board_ranks',
  {
    boardId: text('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    issueId: text('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    rank: doublePrecision('rank').notNull(),
  },
  (t) => [primaryKey({ columns: [t.boardId, t.issueId] }), index('board_ranks_rank').on(t.boardId, t.rank)],
);

/** A project's kinds of work (development, testing, …), chosen when work is logged. */
export const workTypes = pgTable(
  'work_types',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    ordinal: integer('ordinal').notNull().default(0),
    /** Kept on the work logged with it, but no longer offered. */
    archived: boolean('archived').notNull().default(false),
    createdAt: created(),
  },
  (t) => [uniqueIndex('work_types_project_name').on(t.projectId, sql`lower(${t.name})`)],
);

/**
 * A person's timer on an issue: running since `running_since`, or paused (null) with
 * `elapsed_seconds` counted so far. At most one runs per person; stopping it logs the work.
 */
export const timers = pgTable(
  'timers',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    issueId: text('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    runningSince: ts('running_since'),
    elapsedSeconds: integer('elapsed_seconds').notNull().default(0),
    createdAt: created(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.issueId] }),
    uniqueIndex('timers_one_running')
      .on(t.userId)
      .where(sql`${t.runningSince} IS NOT NULL`),
  ],
);

// ---------------------------------------------------------------------------
// Chat: Microsoft Teams and Slack (D42)
// ---------------------------------------------------------------------------

/**
 * Where a4a's bot is: a Teams team it was added to, or the Slack workspace an administrator
 * connected. Slack's bot token and signing secret are sealed (lib/secret-box.ts).
 */
export const chatWorkspaces = pgTable(
  'chat_workspaces',
  {
    id: text('id').primaryKey(),
    /** One of CHAT_PLATFORMS. */
    platform: text('platform').notNull(),
    /** The team's id in Teams, or the workspace's in Slack (T…). */
    externalId: text('external_id').notNull(),
    /** Teams: the Entra tenant the team is in. */
    tenantId: text('tenant_id'),
    name: text('name').notNull(),
    /** Teams: where its activities go, a Bot Framework service URL (checked against the allowed hosts). */
    serviceUrl: text('service_url'),
    botToken: text('bot_token'),
    signingSecret: text('signing_secret'),
    /** Slack: the bot's own user id, so its own joining a channel is known. */
    botUserId: text('bot_user_id'),
    connectedById: text('connected_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: created(),
    removedAt: ts('removed_at'),
    removedReason: text('removed_reason'),
    /** The reason as a problem's words, for a page in another language (D49). Null before a4a kept them. */
    removedSaid: jsonb('removed_said').$type<ProblemSaid>(),
  },
  (t) => [uniqueIndex('chat_workspaces_external').on(t.platform, t.externalId)],
);

/** A channel a4a can post to: a Teams channel's conversation, or a Slack channel. */
export const chatChannels = pgTable(
  'chat_channels',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => chatWorkspaces.id, { onDelete: 'cascade' }),
    /** Teams: the channel's conversation id (19:…@thread.tacv2). Slack: the channel's id (C…). */
    externalId: text('external_id').notNull(),
    name: text('name').notNull(),
    createdAt: created(),
    /** When a4a found it can't post there any more (deleted, archived, the bot taken out), and why. */
    goneAt: ts('gone_at'),
    goneReason: text('gone_reason'),
    /** The reason as a problem's words, for a page in another language (D49). Null before a4a kept them. */
    goneSaid: jsonb('gone_said').$type<ProblemSaid>(),
  },
  (t) => [uniqueIndex('chat_channels_external').on(t.workspaceId, t.externalId)],
);

/**
 * A channel told of a project's issues, or a saved search's, by the person who subscribed it, who
 * vouches for the channel's people. Ended, not deleted, when the channel goes or the app is removed,
 * so the page can say so.
 */
export const chatSubscriptions = pgTable(
  'chat_subscriptions',
  {
    id: text('id').primaryKey(),
    channelId: text('channel_id')
      .notNull()
      .references(() => chatChannels.id, { onDelete: 'cascade' }),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    savedSearchId: text('saved_search_id').references(() => savedSearches.id, { onDelete: 'cascade' }),
    /** CHAT_CHANGE_KINDS it hears of. */
    kinds: text('kinds').array().notNull(),
    createdById: text('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: created(),
    endedAt: ts('ended_at'),
    endedReason: text('ended_reason'),
    /** The reason as a problem's words, for a page in another language (D49). Null before a4a kept them. */
    endedSaid: jsonb('ended_said').$type<ProblemSaid>(),
  },
  (t) => [index('chat_subscriptions_channel').on(t.channelId), index('chat_subscriptions_project').on(t.projectId)],
);

/** A chat account linked to an a4a account, which it acts as. Teams' Entra people need none (user_identities.object_id). */
export const chatAccounts = pgTable(
  'chat_accounts',
  {
    id: text('id').primaryKey(),
    platform: text('platform').notNull(),
    /** Teams: the tenant. Slack: the workspace (T…). */
    workspaceExternalId: text('workspace_external_id').notNull(),
    workspaceName: text('workspace_name').notNull(),
    /** Teams: the person's object id (aadObjectId). Slack: their user id (U…). */
    externalUserId: text('external_user_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    linkedAt: ts('linked_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('chat_accounts_external').on(t.platform, t.workspaceExternalId, t.externalUserId), index('chat_accounts_user').on(t.userId)],
);

/** A sign-in link the bot sent someone in a personal chat: kept as a hash, used once, soon gone. */
export const chatLinkTokens = pgTable(
  'chat_link_tokens',
  {
    tokenHash: text('token_hash').primaryKey(),
    platform: text('platform').notNull(),
    workspaceExternalId: text('workspace_external_id').notNull(),
    workspaceName: text('workspace_name').notNull(),
    externalUserId: text('external_user_id').notNull(),
    name: text('name').notNull(),
    /** Where to say it's done: Teams' personal conversation; Slack needs only the person's id. */
    reply: jsonb('reply').$type<{ serviceUrl?: string; conversationId?: string }>(),
    createdAt: created(),
    expiresAt: ts('expires_at').notNull(),
    usedAt: ts('used_at'),
  },
  (t) => [index('chat_link_tokens_expires').on(t.expiresAt)],
);

/**
 * What a4a posts to channels: a row first, written by the outbox's consumer, sent after, at least once,
 * as mail is (mail_outbox). One per channel per event, whichever subscriptions matched it.
 */
export const chatOutbox = pgTable(
  'chat_outbox',
  {
    id: text('id').primaryKey(),
    dedupeKey: text('dedupe_key').notNull().unique(),
    channelId: text('channel_id')
      .notNull()
      .references(() => chatChannels.id, { onDelete: 'cascade' }),
    subscriptionId: text('subscription_id').references(() => chatSubscriptions.id, { onDelete: 'set null' }),
    eventId: bigint('event_id', { mode: 'number' }),
    /** The event, as the outbox handed it over: rendered when it's sent, from the issue as it is then. */
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    /** pending, sent, skipped (not for the channel any more), failed. */
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    sendAfter: ts('send_after').notNull().defaultNow(),
    lockedUntil: ts('locked_until'),
    lastError: text('last_error'),
    sentAt: ts('sent_at'),
    /** The post's id there: Teams' activity id, Slack's message ts. */
    messageRef: text('message_ref'),
    createdAt: created(),
  },
  (t) => [index('chat_outbox_due').on(t.status, t.sendAfter)],
);

// ---------------------------------------------------------------------------
// Integrations (package: docs/architecture.md, D46): CI builds, and code-host accounts people connect
// ---------------------------------------------------------------------------

/**
 * Where a project's builds come from: a GitHub integration's workflow runs (`github`), a Gitea or
 * Forgejo integration's Actions runs (`gitea`, D55), or any CI that posts them with a token of its
 * own (`generic`), kept as a hash and shown once.
 */
export const buildSources = pgTable('build_sources', {
  id: text('id').primaryKey(),
  /** 'github', 'gitea' or 'generic'. */
  kind: text('kind').notNull(),
  name: text('name').notNull(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  /** The build field its builds go in; null: the project's "Fixed in build", or its one build field. */
  fieldId: text('field_id').references(() => fields.id, { onDelete: 'set null' }),
  /** github, gitea: the integration whose run deliveries it takes. */
  vcsIntegrationId: text('vcs_integration_id').references(() => vcsIntegrations.id, { onDelete: 'cascade' }),
  /** github, gitea: the branch whose runs are builds; null: any. */
  branch: text('branch'),
  /** github, gitea: the workflow, by its name or its file (.github/workflows/ci.yml; Forgejo's, ci.yml); null: any. */
  workflow: text('workflow'),
  /** generic: the token's SHA-256. */
  tokenHash: text('token_hash'),
  tokenPrefix: text('token_prefix'),
  active: boolean('active').notNull().default(true),
  createdById: text('created_by_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: created(),
  lastBuildAt: ts('last_build_at'),
});

/** A build a CI reported: one per name in a project, reported again as often as the CI likes. */
export const builds = pgTable(
  'builds',
  {
    id: text('id').primaryKey(),
    sourceId: text('source_id').references(() => buildSources.id, { onDelete: 'set null' }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    fieldId: text('field_id').references(() => fields.id, { onDelete: 'set null' }),
    /** The build field's value it became, once it succeeded. */
    valueId: text('value_id').references(() => fieldValues.id, { onDelete: 'set null' }),
    /** Its number or name, as the build field's value reads. */
    name: text('name').notNull(),
    /** 'success', 'failure' or 'cancelled'. */
    status: text('status').notNull(),
    url: text('url'),
    repository: text('repository'),
    branch: text('branch'),
    /** The commit it built, and when that was made: where the next build's commits start. */
    headSha: text('head_sha'),
    headAt: ts('head_at'),
    /** The commits it holds, as far as a4a knows them. */
    commits: text('commits').array().notNull().default(sql`'{}'::text[]`),
    /** The issues it marked as fixed in it. */
    marked: integer('marked').notNull().default(0),
    finishedAt: ts('finished_at'),
    createdAt: created(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('builds_once').on(t.projectId, t.name), index('builds_recent').on(t.projectId, t.createdAt), index('builds_source').on(t.sourceId, t.branch, t.createdAt)],
);

/** What a build did to each issue its commits name: marked it, found it marked already, or left it and why. */
export const buildIssues = pgTable(
  'build_issues',
  {
    buildId: text('build_id')
      .notNull()
      .references(() => builds.id, { onDelete: 'cascade' }),
    issueId: text('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    /** 'marked', 'already' (it named a build already), 'open' (not resolved, so left) or 'refused' (note says why). */
    outcome: text('outcome').notNull(),
    /** Why, in English, for the API. */
    note: text('note'),
    /** The note in the catalogs, a key and its values, for a page in another language (D49). Null before a4a kept it. */
    said: jsonb('said').$type<{ key: string; values?: Record<string, unknown> }>(),
    /** The commit that tied the issue to the build. */
    commit: text('commit'),
    createdAt: created(),
  },
  (t) => [primaryKey({ columns: [t.buildId, t.issueId] }), index('build_issues_issue').on(t.issueId)],
);

/**
 * A person connecting their account at a code host (D46): the sign-in there they've started, known
 * by the state it carries (kept as a hash), with its PKCE verifier, for ten minutes.
 */
export const providerLinkStates = pgTable('provider_link_states', {
  stateHash: text('state_hash').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull(),
  verifier: text('verifier').notNull(),
  createdAt: created(),
  expiresAt: ts('expires_at').notNull(),
});

// ---------------------------------------------------------------------------
// Mobile: push notifications to people's devices (docs/architecture.md, D47)
// ---------------------------------------------------------------------------

/**
 * A device a person turned push on for: its browser's push subscription, kept while the sign-in
 * that made it lasts. Signing out there ends it, as does the push service saying it's gone.
 */
export const pushSubscriptions = pgTable(
  'push_subscriptions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The sign-in on that device: when it ends (signing out, a new password, an administrator), so does this. */
    sessionId: text('session_id').references(() => sessions.id, { onDelete: 'cascade' }),
    /** The push service's address for the device: someone else's, so only the known services' hosts. */
    endpoint: text('endpoint').notNull().unique(),
    /** The device's public key and authentication secret, which each message is encrypted to (RFC 8291). */
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    /** What the device is, for the person's list: "Chrome on Android". */
    label: text('label').notNull(),
    createdAt: created(),
    lastSentAt: ts('last_sent_at'),
    /** Refusals in a row that weren't the service saying it's gone; at five, it's ended. */
    failures: integer('failures').notNull().default(0),
    lastError: text('last_error'),
  },
  (t) => [index('push_subscriptions_user').on(t.userId)],
);

/**
 * A push to send to one device, at least once, as mail is: written in the notifier's transaction,
 * sent after, retried with backoff. What it says is worked out when it's sent, from what's true then.
 */
export const pushOutbox = pgTable(
  'push_outbox',
  {
    id: text('id').primaryKey(),
    /** One push per notification, device and the reason it reached (a mention folding into a change pushes again). */
    dedupeKey: text('dedupe_key').notNull().unique(),
    subscriptionId: text('subscription_id')
      .notNull()
      .references(() => pushSubscriptions.id, { onDelete: 'cascade' }),
    notificationId: text('notification_id')
      .notNull()
      .references(() => notifications.id, { onDelete: 'cascade' }),
    status: text('status').notNull().default('pending'), // pending | sent | skipped | failed
    attempts: integer('attempts').notNull().default(0),
    sendAfter: ts('send_after').notNull().defaultNow(),
    lockedUntil: ts('locked_until'),
    lastError: text('last_error'),
    createdAt: created(),
    sentAt: ts('sent_at'),
  },
  (t) => [index('push_outbox_due').on(t.status, t.sendAfter)],
);

// ---------------------------------------------------------------------------
// Help desk in depth: SLAs, requester accounts, team replies by email, kinds (docs/architecture.md, D45)
// ---------------------------------------------------------------------------

/**
 * A desk's SLA policies, tried in order: the first whose query a request matches covers it, with
 * its targets counted in the desk's working hours.
 */
export const slaPolicies = pgTable(
  'sla_policies',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** A query in the search language; '' covers every request. */
    query: text('query').notNull().default(''),
    firstResponseMinutes: integer('first_response_minutes'),
    resolutionMinutes: integer('resolution_minutes'),
    warnMinutes: integer('warn_minutes').notNull().default(60),
    position: integer('position').notNull().default(0),
    createdAt: created(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [index('sla_policies_project').on(t.projectId, t.position)],
);

/**
 * One SLA target of one request, as its clock stands: business time used before the stretch now
 * counting, and while it counts, when it runs out and when it turns at risk. Those are instants on
 * the wall clock, so a search compares them with now and nothing has to tick.
 */
export const slaClocks = pgTable(
  'sla_clocks',
  {
    issueId: text('issue_id')
      .notNull()
      .references(() => helpdeskRequests.issueId, { onDelete: 'cascade' }),
    /** SLA_TARGETS: 'first_response' or 'resolution'. */
    target: text('target').notNull(),
    policyId: text('policy_id').references(() => slaPolicies.id, { onDelete: 'set null' }),
    targetMinutes: integer('target_minutes').notNull(),
    usedMs: bigint('used_ms', { mode: 'number' }).notNull().default(0),
    /** When the stretch now counting began; null while paused or stopped. */
    runningSince: ts('running_since'),
    dueAt: ts('due_at'),
    warnAt: ts('warn_at'),
    metAt: ts('met_at'),
    breachedAt: ts('breached_at'),
    /** The worker said it's at risk, for this stretch; and that it went past (once). */
    warnedAt: ts('warned_at'),
    breachToldAt: ts('breach_told_at'),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.issueId, t.target] }), index('sla_clocks_due').on(t.dueAt), index('sla_clocks_warn').on(t.warnAt)],
);

/** A requester signed in to the portal: the session's token as a SHA-256 hash, as a person's are. */
export const requesterSessions = pgTable(
  'requester_sessions',
  {
    tokenHash: text('token_hash').primaryKey(),
    requesterId: text('requester_id')
      .notNull()
      .references(() => requesters.id, { onDelete: 'cascade' }),
    /** How it was opened (D63): 'link', 'password' or 'sso'. It opens the requests of desks that take that way. */
    method: text('method').notNull().default('link'),
    /** With 'sso', the identity provider it came through. */
    providerId: text('provider_id').references(() => portalProviders.id, { onDelete: 'cascade' }),
    createdAt: created(),
    lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
    expiresAt: ts('expires_at').notNull(),
  },
  (t) => [index('requester_sessions_requester').on(t.requesterId)],
);

/** A sign-in link sent to a requester, or a link to set their password (D63): its token as a hash, good once, for a short while. */
export const requesterSignIns = pgTable(
  'requester_sign_ins',
  {
    tokenHash: text('token_hash').primaryKey(),
    requesterId: text('requester_id')
      .notNull()
      .references(() => requesters.id, { onDelete: 'cascade' }),
    /** 'sign-in' (D45), or 'password': a link that sets their password. */
    purpose: text('purpose').notNull().default('sign-in'),
    createdAt: created(),
    expiresAt: ts('expires_at').notNull(),
    usedAt: ts('used_at'),
  },
  (t) => [index('requester_sign_ins_requester').on(t.requesterId)],
);

/**
 * The tokens in the reply address of a notification email to someone on the team (D45), as hashes:
 * minted per email and person, so a reply speaks for them, about that issue, and only from them.
 */
export const teamReplyTokens = pgTable(
  'team_reply_tokens',
  {
    tokenHash: text('token_hash').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    issueId: text('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    /** What they replied to went to the requester of a help desk request, so their reply does too. */
    publicReply: boolean('public_reply').notNull().default(false),
    createdAt: created(),
  },
  (t) => [index('team_reply_tokens_issue').on(t.issueId), index('team_reply_tokens_created').on(t.createdAt)],
);

/** A person's choice of the kinds of change they're told of (D45): for what they watch, and their subscriptions' default. */
export const notifyKinds = pgTable('notify_kinds', {
  userId: text('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  watching: jsonb('watching').$type<Record<string, { inbox: boolean; email: boolean }>>().notNull().default({}),
  defaults: jsonb('defaults').$type<Record<string, { inbox: boolean; email: boolean }>>().notNull().default({}),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Apps (docs/architecture.md, D48)
// ---------------------------------------------------------------------------

/** An app an administrator installed: its manifest, what it was granted, and its agent. */
export const apps = pgTable(
  'apps',
  {
    id: text('id').primaryKey(),
    /** The manifest's name: how the API, its widgets and its files know it. */
    name: text('name').notNull(),
    title: text('title').notNull(),
    version: text('version').notNull(),
    vendor: text('vendor'),
    description: text('description').notNull().default(''),
    manifest: jsonb('manifest').notNull(),
    /** What the administrator accepted at install or update ({ read, write }): it may do this and no more. */
    granted: jsonb('granted').notNull(),
    sha256: text('sha256').notNull(),
    /** { kind: 'upload' } or { kind: 'catalog', catalog, url }. */
    source: jsonb('source').notNull(),
    /** Its agent (D34): who its rules act as. */
    agentId: text('agent_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    enabled: boolean('enabled').notNull().default(true),
    allProjects: boolean('all_projects').notNull().default(false),
    installedById: text('installed_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: created(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('apps_name').on(t.name)],
);

/** An app's files, as its package held them. */
export const appFiles = pgTable(
  'app_files',
  {
    appId: text('app_id')
      .notNull()
      .references(() => apps.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    contentType: text('content_type').notNull(),
    content: bytea('content').notNull(),
  },
  (t) => [primaryKey({ columns: [t.appId, t.path] })],
);

/** Where an app was chosen to run, and where a project's managers turned it off. */
export const appProjects = pgTable(
  'app_projects',
  {
    appId: text('app_id')
      .notNull()
      .references(() => apps.id, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** An administrator chose it for this project (an app not enabled for every project). */
    chosen: boolean('chosen').notNull().default(false),
    /** The project's managers turned it off here. */
    off: boolean('off').notNull().default(false),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.appId, t.projectId] })],
);

/** An app's settings: its own (no project), or a project's. A secret's value is sealed. */
export const appSettings = pgTable(
  'app_settings',
  {
    id: text('id').primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => apps.id, { onDelete: 'cascade' }),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    values: jsonb('values').notNull().default({}),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('app_settings_app').on(t.appId).where(sql`${t.projectId} IS NULL`),
    uniqueIndex('app_settings_project').on(t.appId, t.projectId).where(sql`${t.projectId} IS NOT NULL`),
  ],
);

/** What an app keeps: a small store of JSON by key, its own or a project's. */
export const appStorage = pgTable(
  'app_storage',
  {
    id: text('id').primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => apps.id, { onDelete: 'cascade' }),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    value: jsonb('value').notNull(),
    bytes: integer('bytes').notNull(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('app_storage_app_key').on(t.appId, t.key).where(sql`${t.projectId} IS NULL`),
    uniqueIndex('app_storage_project_key').on(t.appId, t.projectId, t.key).where(sql`${t.projectId} IS NOT NULL`),
  ],
);

/** What an app's handlers did: each call, how it ended and how long it took. */
export const appRuns = pgTable(
  'app_runs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => apps.id, { onDelete: 'cascade' }),
    handler: text('handler').notNull(),
    actorId: text('actor_id').references(() => users.id, { onDelete: 'set null' }),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'set null' }),
    issueKey: text('issue_key'),
    /** 'ok', 'failed' or 'refused'. */
    outcome: text('outcome').notNull(),
    message: text('message').notNull().default(''),
    ms: integer('ms'),
    createdAt: created(),
  },
  (t) => [index('app_runs_app').on(t.appId, t.id), index('app_runs_created').on(t.createdAt)],
);

// ---------------------------------------------------------------------------
// Renaming a project's key (wave 4: docs/architecture.md, D52)
// ---------------------------------------------------------------------------

/**
 * The keys a project had before it was renamed. Each stays the project's for good: OLD-12 finds
 * NEW-12, `project: OLD` finds the project, and no other project can take OLD. Kept in upper case,
 * as projects keep theirs. Renaming a project back to one of them takes it off this list.
 */
export const projectKeyAliases = pgTable(
  'project_key_aliases',
  {
    key: text('key').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    renamedById: text('renamed_by_id').references(() => users.id, { onDelete: 'set null' }),
    /** When the project stopped going by it. */
    renamedAt: created(),
  },
  (t) => [index('project_key_aliases_project').on(t.projectId)],
);

// ---------------------------------------------------------------------------
// Customer groups in the help desk (wave 4: docs/architecture.md, D56)
// ---------------------------------------------------------------------------

/**
 * A desk's customer groups: the companies, teams or organizations its requesters belong to. A
 * group is its desk's own, as its SLA policies are; its name is unique there, in any case.
 */
export const customerGroups = pgTable(
  'customer_groups',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** What its members do with each other's requests on the portal: 'none', 'read' or 'comment'. */
    sharing: text('sharing').notNull().default('none'),
    /** Its own working hours and holidays (BusinessHours), which its requests' SLAs count in; null keeps the desk's. */
    businessHours: jsonb('business_hours'),
    /** The identity provider its people sign in to the portal through at this desk, and no other way (D63). */
    providerId: text('provider_id').references(() => portalProviders.id, { onDelete: 'restrict' }),
    createdAt: created(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('customer_groups_project_name').on(t.projectId, sql`lower(${t.name})`)],
);

/** The email domains that put a requester in a group by themselves. A domain names one group at a desk. */
export const customerGroupDomains = pgTable(
  'customer_group_domains',
  {
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** In lower case, such as acme.com: an address's part after the @, matched whole. */
    domain: text('domain').notNull(),
    groupId: text('group_id')
      .notNull()
      .references(() => customerGroups.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.domain] }), index('customer_group_domains_group').on(t.groupId)],
);

/** Requesters added to a group by hand: one group at a desk each, whatever their address's domain says. */
export const customerGroupMembers = pgTable(
  'customer_group_members',
  {
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    requesterId: text('requester_id')
      .notNull()
      .references(() => requesters.id, { onDelete: 'cascade' }),
    groupId: text('group_id')
      .notNull()
      .references(() => customerGroups.id, { onDelete: 'cascade' }),
    addedById: text('added_by_id').references(() => users.id, { onDelete: 'set null' }),
    addedAt: created(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.requesterId] }), index('customer_group_members_group').on(t.groupId)],
);

/** A group's dedicated agents, in order: its members' new requests go to one of them. */
export const customerGroupAgents = pgTable(
  'customer_group_agents',
  {
    groupId: text('group_id')
      .notNull()
      .references(() => customerGroups.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    position: integer('position').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.groupId, t.userId] }), index('customer_group_agents_user').on(t.userId)],
);

// ---------------------------------------------------------------------------
// CCs on help desk requests (wave 4: docs/architecture.md, D57)
// ---------------------------------------------------------------------------

/**
 * Who is copied on a help desk request: people outside the team told of what its requester is told
 * of, who may answer by email. One row per address and request, kept when they're removed, so an
 * address taken off a request isn't put back by the next email that names it in its Cc.
 */
export const requestCcs = pgTable(
  'request_ccs',
  {
    id: text('id').primaryKey(),
    issueId: text('issue_id')
      .notNull()
      .references(() => helpdeskRequests.issueId, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    /** As whoever copied them named them (an email's Cc, the team, the requester); empty for none. */
    name: text('name').notNull().default(''),
    /** 'team', 'email' (the Cc of the requester's email) or 'portal' (the requester, signed in). */
    via: text('via').notNull(),
    /** Whoever on the team copied them; null when the requester did. */
    addedById: text('added_by_id').references(() => users.id, { onDelete: 'set null' }),
    addedAt: ts('added_at').notNull().defaultNow(),
    /** No longer copied. They're told nothing, can't answer, and an email's Cc doesn't add them back. */
    removedAt: ts('removed_at'),
    /** 'team', or 'unsubscribe': they stopped it themselves, from an email. */
    removedVia: text('removed_via'),
    removedById: text('removed_by_id').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [uniqueIndex('request_ccs_address').on(t.issueId, sql`lower(${t.email})`), index('request_ccs_email').on(sql`lower(${t.email})`)],
);

// ---------------------------------------------------------------------------
// Issues from chat messages (wave 4: docs/architecture.md, D60)
// ---------------------------------------------------------------------------

/** A file in a message an issue was made from: linked where the chat keeps it, never copied (D60). */
export interface ChatSourceFile {
  name: string;
  /** Where the chat shows it (Slack's permalink, SharePoint's address), https on the chat's own hosts; null for none. */
  url: string | null;
}

/**
 * Where an issue made from a Teams or Slack message came from: written when the person opens the form
 * (a draft, with no issue), and given its issue in the transaction that makes it, once. Kept as data,
 * so each reader's page says it in their language (D49).
 */
export const chatIssueSources = pgTable(
  'chat_issue_sources',
  {
    id: text('id').primaryKey(),
    /** Null while it's a form someone has open; set once, as the issue is made. */
    issueId: text('issue_id')
      .unique()
      .references(() => issues.id, { onDelete: 'cascade' }),
    platform: text('platform').notNull(),
    workspaceId: text('workspace_id').references(() => chatWorkspaces.id, { onDelete: 'set null' }),
    /** The Slack workspace's or the Teams team's name, then. */
    workspaceName: text('workspace_name').notNull(),
    channelId: text('channel_id').references(() => chatChannels.id, { onDelete: 'set null' }),
    /** The channel as it was named then: "#eng", "General". */
    channelName: text('channel_name').notNull(),
    /** Slack: the message's ts. Teams: the message's id. */
    messageRef: text('message_ref').notNull(),
    /** The thread it's in: Slack's thread_ts, Teams' parent message; its own ref when it starts one. */
    threadRef: text('thread_ref').notNull(),
    /** A link to the message in the chat (Slack's permalink, Teams' message link): https on the chat's hosts, else null. */
    url: text('url'),
    /** Who sent the message, as the chat names them; their id there; and the a4a account it's linked to, if any. */
    authorName: text('author_name').notNull(),
    authorExternalId: text('author_external_id'),
    authorUserId: text('author_user_id').references(() => users.id, { onDelete: 'set null' }),
    sentAt: ts('sent_at'),
    /** The first ten files in the message, linked; and how many more there were. */
    files: jsonb('files').$type<ChatSourceFile[]>().notNull().default([]),
    moreFiles: integer('more_files').notNull().default(0),
    /** Replies from the thread brought into the description. */
    replies: integer('replies').notNull().default(0),
    /** Whether the message, or its replies, were cut to fit. */
    cut: boolean('cut').notNull().default(false),
    /** Who opened the form, as a4a and as the chat knows them: only they may send it. The issue keeps its source if they go. */
    createdById: text('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdByExternalId: text('created_by_external_id').notNull(),
    createdAt: created(),
    /** A form not sent by then is gone. */
    expiresAt: ts('expires_at').notNull(),
    /** When its issue was made: how fast someone makes issues from chat is counted by it. */
    madeAt: ts('made_at'),
  },
  (t) => [index('chat_issue_sources_made').on(t.createdById, t.madeAt), index('chat_issue_sources_expires').on(t.expiresAt)],
);

/** Requests from Teams and Slack a4a has taken, by a key of each (Slack's signature, Teams' activity id), so none is taken twice. */
export const chatRequestsSeen = pgTable(
  'chat_requests_seen',
  {
    key: text('key').primaryKey(),
    expiresAt: ts('expires_at').notNull(),
  },
  (t) => [index('chat_requests_seen_expires').on(t.expiresAt)],
);

// ---------------------------------------------------------------------------
// Whiteboards (wave 4: docs/architecture.md, D58)
// ---------------------------------------------------------------------------

/** A project's canvas: read by whoever reads the project, changed by whoever may change its issues. */
export const whiteboards = pgTable(
  'whiteboards',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Its latest change. Each change takes the next under the whiteboard's row lock, so they never cross. */
    seq: bigint('seq', { mode: 'number' }).notNull().default(0),
    createdById: text('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: created(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [index('whiteboards_project').on(t.projectId)],
);

/**
 * What's on a whiteboard. Its id is chosen by whoever adds it, unique within the whiteboard, so an
 * arrow can name what the same batch adds and an undone removal comes back as it was. A card points
 * at its issue or article, which go on without it; deleting either leaves the card holding nothing.
 */
export const whiteboardElements = pgTable(
  'whiteboard_elements',
  {
    whiteboardId: text('whiteboard_id')
      .notNull()
      .references(() => whiteboards.id, { onDelete: 'cascade' }),
    id: text('id').notNull(),
    /** note, text, issue, article, arrow or section. */
    kind: text('kind').notNull(),
    x: doublePrecision('x').notNull(),
    y: doublePrecision('y').notNull(),
    w: doublePrecision('w').notNull(),
    h: doublePrecision('h').notNull(),
    z: doublePrecision('z').notNull().default(0),
    text: text('text'),
    tone: text('tone'),
    label: text('label'),
    fromId: text('from_id'),
    toId: text('to_id'),
    issueId: text('issue_id').references(() => issues.id, { onDelete: 'set null' }),
    articleId: text('article_id').references(() => articles.id, { onDelete: 'set null' }),
    /** An arrow made into a link between its issues: the link as it reads from the arrow's start. */
    linked: text('linked'),
    /** The whiteboard's change that last changed it. */
    seq: bigint('seq', { mode: 'number' }).notNull(),
    version: integer('version').notNull().default(1),
    updatedById: text('updated_by_id').references(() => users.id, { onDelete: 'set null' }),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.whiteboardId, t.id] }),
    index('whiteboard_elements_issue').on(t.issueId),
    index('whiteboard_elements_article').on(t.articleId),
  ],
);

/**
 * A whiteboard's latest changes, what its live streams send and resume from: the elements each left,
 * and what it removed. The last 500 are kept; a stream further behind reads the whiteboard again.
 */
export const whiteboardChanges = pgTable(
  'whiteboard_changes',
  {
    whiteboardId: text('whiteboard_id')
      .notNull()
      .references(() => whiteboards.id, { onDelete: 'cascade' }),
    seq: bigint('seq', { mode: 'number' }).notNull(),
    actorId: text('actor_id').references(() => users.id, { onDelete: 'set null' }),
    /** Which of a person's tabs sent it, as it said. */
    client: text('client'),
    /** The rows of the elements it added or changed, as it left them. */
    elements: jsonb('elements').notNull(),
    removed: text('removed').array().notNull().default(sql`'{}'::text[]`),
    at: ts('at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.whiteboardId, t.seq] })],
);

/** Who is looking at a whiteboard: a row per open stream, kept fresh while it's open, and gone soon after. */
export const whiteboardViewers = pgTable(
  'whiteboard_viewers',
  {
    whiteboardId: text('whiteboard_id')
      .notNull()
      .references(() => whiteboards.id, { onDelete: 'cascade' }),
    /** One per stream or client, so one of a person's two tabs closing leaves the other. */
    session: text('session').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    since: ts('since').notNull().defaultNow(),
    seenAt: ts('seen_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.whiteboardId, t.session] }), index('whiteboard_viewers_seen').on(t.seenAt)],
);

// ---------------------------------------------------------------------------
// The portal's own sign-in (D63): identity providers for requesters, apart from the team's
// ---------------------------------------------------------------------------

/**
 * An OpenID Connect provider requesters sign in to the portal through: the server's, made by an
 * administrator, offered by the desks that choose it. Never the team's (D16): its sessions open the
 * portal alone.
 */
export const portalProviders = pgTable('portal_providers', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  issuer: text('issuer').notNull(),
  clientId: text('client_id').notNull(),
  /** Sealed with the server's key (lib/secret-box.ts); null for a public client. */
  clientSecretSealed: text('client_secret_sealed'),
  scopes: text('scopes').notNull().default('openid email profile'),
  /** The email domains it may vouch for, in lower case; empty: any. */
  domains: text('domains').array().notNull().default(sql`'{}'::text[]`),
  createdAt: created(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

/** A sign-in through a requesters' provider under way: the state's hash, bound to the browser by a cookie, with its PKCE verifier and nonce. */
export const portalSsoStates = pgTable('portal_sso_states', {
  id: text('id').primaryKey(),
  providerId: text('provider_id')
    .notNull()
    .references(() => portalProviders.id, { onDelete: 'cascade' }),
  /** The desk whose page it started from, to come back to. */
  desk: text('desk'),
  codeVerifier: text('code_verifier').notNull(),
  nonce: text('nonce').notNull(),
  createdAt: created(),
  expiresAt: ts('expires_at').notNull(),
});

/** That a provider has signed a requester in (D63): they're known by its verified email; this says when it first did, to tell them. */
export const requesterIdentities = pgTable(
  'requester_identities',
  {
    requesterId: text('requester_id')
      .notNull()
      .references(() => requesters.id, { onDelete: 'cascade' }),
    providerId: text('provider_id')
      .notNull()
      .references(() => portalProviders.id, { onDelete: 'cascade' }),
    subject: text('subject').notNull(),
    createdAt: created(),
    lastAt: ts('last_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.requesterId, t.providerId] })],
);

// ---------------------------------------------------------------------------
// Passkeys (D62)
// ---------------------------------------------------------------------------

/**
 * A person's passkey: a WebAuthn credential, bound to the relying party id it was made for (the host
 * of PUBLIC_URL then). a4a keeps its public key and sign count; the private key never leaves the
 * authenticator. A count that goes back means two authenticators hold it: it's `copiedAt`, and signs
 * nobody in again.
 */
export const passkeys = pgTable(
  'passkeys',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The credential's id, base64url, as the authenticator made it: one credential is one person's. */
    credentialId: text('credential_id').notNull(),
    /** Its public key, COSE-encoded, as it was registered. */
    publicKey: bytea('public_key').notNull(),
    signCount: bigint('sign_count', { mode: 'number' }).notNull().default(0),
    transports: text('transports').array().notNull().default(sql`'{}'::text[]`),
    /** It may be synced to the person's other devices (backup eligible), and whether it is (backed up). */
    multiDevice: boolean('multi_device').notNull().default(false),
    backedUp: boolean('backed_up').notNull().default(false),
    /** What kind of authenticator made it (its AAGUID), when it said. */
    aaguid: text('aaguid'),
    name: text('name').notNull(),
    rpId: text('rp_id').notNull(),
    /** Its maker vouched for it (attestation), checked against FIDO's metadata, while only some authenticators were taken (D68). */
    attested: boolean('attested').notNull().default(false),
    createdAt: created(),
    lastUsedAt: ts('last_used_at'),
    copiedAt: ts('copied_at'),
  },
  (t) => [uniqueIndex('passkeys_credential').on(t.credentialId), index('passkeys_user').on(t.userId)],
);

/**
 * A ceremony under way: the challenge a4a gave the browser, kept as a hash, for five minutes, taken
 * once. `purpose` is the ceremony (`register`, `sign-in`, `second-step`, `confirm`); `boundTo` the
 * browser that asked: its session's id, or the hash of the sign-in ticket its cookie holds.
 */
export const passkeyChallenges = pgTable(
  'passkey_challenges',
  {
    id: text('id').primaryKey(),
    purpose: text('purpose').notNull(),
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    boundTo: text('bound_to').notNull(),
    expiresAt: ts('expires_at').notNull(),
    createdAt: created(),
  },
  (t) => [index('passkey_challenges_expires').on(t.expiresAt)],
);

/**
 * The "this wasn't me" link in a mail that told someone their passkeys changed: its token, kept as a
 * hash, minted as the mail is sent. Following it signs them out everywhere and stops the passkey it
 * names; it only ever takes access away, so whoever holds the mail may use it, once.
 */
export const passkeyAlerts = pgTable(
  'passkey_alerts',
  {
    tokenHash: text('token_hash').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** `added`, `removed` or `copied`. */
    change: text('change').notNull(),
    passkeyId: text('passkey_id'),
    name: text('name').notNull(),
    changedAt: ts('changed_at').notNull(),
    expiresAt: ts('expires_at').notNull(),
    usedAt: ts('used_at'),
    createdAt: created(),
  },
  (t) => [index('passkey_alerts_user').on(t.userId)],
);

// ---------------------------------------------------------------------------
// Passkeys in depth (D68)
// ---------------------------------------------------------------------------

/**
 * FIDO's Metadata Service as a4a last read it: one row (`mds`), shared by every instance. The BLOB
 * in use is the last one whose signature chained to FIDO's root and whose number passed the one
 * before; a fetch that fails keeps it, and says when and why beside it.
 */
export const passkeyMetadata = pgTable('passkey_metadata', {
  id: text('id').primaryKey(),
  /** The BLOB's serial number: a later one must be greater. Null: none read yet. */
  no: integer('no'),
  /** When FIDO says the next BLOB comes, at the latest (YYYY-MM-DD). Past it, the BLOB is stale. */
  nextUpdate: text('next_update'),
  /** When the BLOB in use was fetched or read. */
  gotAt: ts('got_at'),
  /** Its FIDO2 authenticators: each AAGUID's metadata statement (without its icon) and status reports. */
  entries: jsonb('entries').$type<unknown[]>(),
  /** The last try, and, when it failed, what kind of failure and the detail (English, for administrators). */
  triedAt: ts('tried_at'),
  failedAt: ts('failed_at'),
  failure: text('failure'),
  failureDetail: text('failure_detail'),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

/**
 * A one-time link that adds an account's first passkey (D68): for an account an administrator made
 * without a password, or one that lost every passkey. Kept as a hash, minted as its mail is sent, or
 * shown once to the administrator; good once, for three days; a newer link voids it.
 */
export const passkeySetupLinks = pgTable(
  'passkey_setup_links',
  {
    tokenHash: text('token_hash').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The administrator who sent it. */
    madeBy: text('made_by').references(() => users.id, { onDelete: 'set null' }),
    expiresAt: ts('expires_at').notNull(),
    usedAt: ts('used_at'),
    createdAt: created(),
  },
  (t) => [index('passkey_setup_links_user').on(t.userId)],
);
