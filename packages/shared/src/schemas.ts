/**
 * API contract shared by the server (validation + OpenAPI), the web UI (types)
 * and the MCP layer. Response schemas carry an OpenAPI component id via `.meta`.
 */
import { z } from 'zod';
import {
  CHANNELS,
  COMMENT_VISIBILITIES,
  EMAIL_LEVELS,
  EVENT_TYPES,
  FIELD_TYPES,
  HELP_LIMITS,
  LEVELING_MODES,
  NOTIFICATION_KINDS,
  PLAY_KINDS,
  PROJECT_ROLES,
  PROJECT_VISIBILITIES,
  PULL_REQUEST_STATES,
  ROLES,
  RULE_EVERY,
  RULE_KINDS,
  RULE_MATCH,
  RULE_OUTCOMES,
  RULE_RELATIONS,
  RULE_TARGETS,
  RULE_TELL,
  RULE_TRIGGERS,
  SCOPES,
  SLA_STATES,
  TRIAGE_MODES,
  UNDO_STATES,
  WATCH_REASONS,
  VCS_DELIVERY_OUTCOMES,
  VCS_PROVIDERS,
} from './constants';

/**
 * The body of a PATCH: every field of the create body, optional, and none filled in by a
 * default. `.partial()` keeps defaults, so a PATCH that left out `sprintsEnabled` or
 * `active` would quietly reset it; with this, what isn't sent isn't changed.
 */
export function patchBody<T extends z.ZodRawShape>(schema: z.ZodObject<T>): z.ZodObject<{ [K in keyof T]: z.ZodOptional<T[K]> }> {
  const shape: Record<string, z.ZodType> = {};
  for (const [key, field] of Object.entries(schema.shape)) {
    const inner = field instanceof z.ZodDefault ? (field.unwrap() as z.ZodType) : (field as z.ZodType);
    shape[key] = inner.optional();
  }
  return z.object(shape) as unknown as z.ZodObject<{ [K in keyof T]: z.ZodOptional<T[K]> }>;
}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a date as YYYY-MM-DD');

/**
 * How a value stands, in Ocean's grammar (good = tick, warn = clock, bad = cross,
 * idle = pause). Values without a tone are plain facts and carry no colour.
 */
export const TONES = ['good', 'warn', 'bad', 'idle'] as const;
export const ToneSchema = z.enum(TONES).nullable();
export type Tone = (typeof TONES)[number];
const timestamp = z.string().describe('ISO 8601 timestamp');

// ---------------------------------------------------------------------------
// Errors & pagination
// ---------------------------------------------------------------------------

export const ErrorSchema = z
  .object({
    error: z.object({
      code: z.string(),
      message: z.string(),
      hint: z.string().optional(),
      details: z.unknown().optional(),
    }),
  })
  .meta({ id: 'Error' });
export type ApiError = z.infer<typeof ErrorSchema>;

export const PaginationQuery = z.object({
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export function paginated<T extends z.ZodType>(item: T, id: string) {
  return z.object({ total: z.number().int(), items: z.array(item) }).meta({ id });
}

// ---------------------------------------------------------------------------
// Users, auth, tokens
// ---------------------------------------------------------------------------

export const UserRefSchema = z
  .object({
    id: z.string(),
    login: z.string(),
    name: z.string(),
    avatarColor: z.string(),
    isBot: z.boolean(),
  })
  .meta({ id: 'UserRef' });
export type UserRef = z.infer<typeof UserRefSchema>;

/** How someone signs in. Only administrators see it. */
export const SignInSchema = z
  .object({
    password: z.boolean().describe('They have a password'),
    emailConfirmed: z
      .boolean()
      .describe('Their email was set by an administrator or verified by the identity provider, so single sign-on may find them by it'),
    identities: z.array(
      z.object({
        provider: z.string().describe('The identity provider, by the name people see'),
        email: z.string().nullable(),
        linkedAt: timestamp,
        lastSignInAt: timestamp.nullable(),
      }),
    ),
  })
  .meta({ id: 'SignIn' });
export type SignIn = z.infer<typeof SignInSchema>;

export const UserSchema = UserRefSchema.extend({
  email: z.string().nullable(),
  role: z.enum(ROLES),
  banned: z.boolean(),
  hourlyRate: z.number().nullable().describe('Cost rate per hour, used for cost tracking'),
  capacityHoursPerDay: z.number().describe('Working hours per day available for planned work'),
  createdAt: timestamp,
  signIn: SignInSchema.optional().describe('How they sign in: only in what administrators get'),
}).meta({ id: 'User' });
export type User = z.infer<typeof UserSchema>;

export const MeSchema = UserSchema.extend({
  auth: z.object({
    method: z.enum(['session', 'token']),
    scopes: z.array(z.enum(SCOPES)),
    tokenName: z.string().nullable(),
    projects: z.array(z.string()).nullable().describe("The keys of the projects this token is limited to, or null when it isn't"),
  }),
}).meta({ id: 'Me' });
export type Me = z.infer<typeof MeSchema>;

export const LoginBody = z.object({ login: z.string().min(1), password: z.string().min(1) });
export const SetupBody = z.object({
  login: z.string().min(2).max(40).regex(/^[a-zA-Z0-9._-]+$/),
  name: z.string().min(1).max(100),
  email: z.string().email().optional(),
  password: z.string().min(8),
  seedDemo: z.boolean().default(true).describe('Create demo projects, issues and users'),
});
export const SetupStatusSchema = z
  .object({
    needsSetup: z.boolean(),
    instanceName: z.string(),
    signIn: z.object({
      password: z.boolean().describe('Whether people may sign in with a login and password'),
      sso: z
        .object({ name: z.string().describe('The identity provider, by the name people see'), url: z.string().describe('Where the browser goes to start signing in') })
        .nullable(),
      saml: z
        .object({ name: z.string().describe('The SAML identity provider, by the name people see'), url: z.string().describe('Where the browser goes to start signing in') })
        .nullable()
        .optional()
        .describe('Signing in with SAML 2.0, beside (or instead of) OpenID Connect'),
    }),
    mcpOAuth: z.boolean().describe('Whether MCP clients may sign in with OAuth, instead of carrying a token (D28)'),
  })
  .meta({ id: 'SetupStatus' });
export type SetupStatus = z.infer<typeof SetupStatusSchema>;

export const UpdateMeBody = z.object({
  name: z.string().min(1).max(100).optional(),
  email: z.string().email().nullable().optional(),
  password: z.string().min(8).optional(),
  currentPassword: z.string().optional(),
});

export const CreateUserBody = z.object({
  login: z.string().min(2).max(40).regex(/^[a-zA-Z0-9._-]+$/),
  name: z.string().min(1).max(100),
  email: z.string().email().nullable().optional(),
  password: z.string().min(8).optional().describe('Omit for bot users that only use API tokens'),
  role: z.enum(ROLES).default('member'),
  isBot: z.boolean().default(false),
  hourlyRate: z.number().min(0).nullable().optional(),
  capacityHoursPerDay: z.number().min(0).max(24).optional(),
});
export const UpdateUserBody = z.object({
  name: z.string().min(1).max(100).optional(),
  email: z.string().email().nullable().optional(),
  password: z.string().min(8).optional(),
  role: z.enum(ROLES).optional(),
  banned: z.boolean().optional(),
  hourlyRate: z.number().min(0).nullable().optional(),
  capacityHoursPerDay: z.number().min(0).max(24).optional(),
});

export const ApiTokenSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    prefix: z.string().describe('First characters of the token, for recognition'),
    scopes: z.array(z.enum(SCOPES)),
    projects: z
      .array(z.string())
      .nullable()
      .describe('Keys of the only projects it reaches, or null for every project its person can see. Empty when those projects are gone or out of sight'),
    createdAt: timestamp,
    lastUsedAt: timestamp.nullable(),
    expiresAt: timestamp.nullable(),
  })
  .meta({ id: 'ApiToken' });
export type ApiToken = z.infer<typeof ApiTokenSchema>;
export const ApiTokenCreatedSchema = ApiTokenSchema.extend({
  token: z.string().describe('The secret. Shown only once.'),
}).meta({ id: 'ApiTokenCreated' });
const TokenProjects = z
  .array(z.string().min(1).max(10))
  .min(1)
  .max(100)
  .nullable()
  .describe("Project keys: the token reaches these projects only, as far as you may. Null or left out: every project you can see. Can't go with the admin scope");
export const CreateTokenBody = z.object({
  name: z.string().min(1).max(80),
  scopes: z.array(z.enum(SCOPES)).min(1).default(['read', 'write']),
  expiresInDays: z.number().int().min(1).max(3650).nullable().optional(),
  projects: TokenProjects.optional(),
});
export const UpdateTokenBody = z.object({
  name: z.string().min(1).max(80).optional(),
  projects: TokenProjects.optional(),
});

// ---------------------------------------------------------------------------
// Projects & custom fields
// ---------------------------------------------------------------------------

export const PlanSettingsSchema = z
  .object({
    startDate: isoDate.nullable().describe('Project start; defaults to the earliest task or today'),
    workingDays: z.array(z.number().int().min(0).max(6)).describe('0 = Sunday … 6 = Saturday'),
    hoursPerDay: z.number().min(1).max(24),
    holidays: z.array(isoDate),
    budget: z.number().min(0).nullable(),
    currency: z.string().min(1).max(8),
  })
  .meta({ id: 'PlanSettings' });
export type PlanSettings = z.infer<typeof PlanSettingsSchema>;

export const HelpdeskSettingsSchema = z
  .object({
    enabled: z.boolean().describe('The public request form at /help/<KEY> takes requests; turning it off closes the form, and requests already filed keep their tracking pages'),
    firstResponseHours: z
      .number()
      .min(0.25)
      .max(24 * 60)
      .nullable()
      .describe('First-response target in hours, counted round the clock from when a request is filed; null for none'),
    intro: z.string().max(2000).describe('Words above the public form, such as what to ask here'),
    captcha: z
      .boolean()
      .describe("The form asks the sender's browser for a proof of work (a short computation, no puzzle and no third party) before it takes a request"),
  })
  .meta({ id: 'HelpdeskSettings' });
export type HelpdeskSettings = z.infer<typeof HelpdeskSettingsSchema>;

export const ProjectSettingsSchema = z
  .object({
    triageMode: z.enum(TRIAGE_MODES),
    plan: PlanSettingsSchema,
    helpdesk: HelpdeskSettingsSchema,
  })
  .meta({ id: 'ProjectSettings' });
export type ProjectSettings = z.infer<typeof ProjectSettingsSchema>;

export const ProjectRefSchema = z
  .object({ id: z.string(), key: z.string(), name: z.string() })
  .meta({ id: 'ProjectRef' });
export type ProjectRef = z.infer<typeof ProjectRefSchema>;

/** What the caller may do in a project. */
export const ProjectAccessSchema = z
  .object({
    role: z.enum(PROJECT_ROLES).describe('Their role in it, as it works out: a manager for administrators and the lead'),
    via: z
      .enum(['admin', 'lead', 'member', 'group', 'open'])
      .describe('Where the role comes from: being an administrator, leading it, being one of its people, being in a group it gives the role, or its being open'),
    group: z.string().nullable().optional().describe('With `via: group`, the group the role comes from (the first by name, when several give it)'),
    read: z.boolean(),
    comment: z.boolean(),
    write: z.boolean().describe('Change its issues'),
    manage: z.boolean().describe('Change its settings, people, boards and baselines'),
  })
  .meta({ id: 'ProjectAccess' });
export type ProjectAccess = z.infer<typeof ProjectAccessSchema>;

export const ProjectSchema = ProjectRefSchema.extend({
  description: z.string(),
  lead: UserRefSchema.nullable(),
  archived: z.boolean(),
  visibility: z.enum(PROJECT_VISIBILITIES).describe('open: everyone sees it and works in it; members: only its people and administrators see it'),
  settings: ProjectSettingsSchema,
  issueCount: z.number().int(),
  openIssueCount: z.number().int(),
  createdAt: timestamp,
  access: ProjectAccessSchema,
}).meta({ id: 'Project' });
export type Project = z.infer<typeof ProjectSchema>;

export const CreateProjectBody = z.object({
  key: z
    .string()
    .min(2)
    .max(10)
    .regex(/^[A-Za-z][A-Za-z0-9]*$/, 'Letters and digits, starting with a letter'),
  name: z.string().min(1).max(100),
  description: z.string().max(5000).default(''),
  lead: z.string().optional().describe('Login of the project lead'),
  template: z
    .enum(['software', 'waterfall', 'blank'])
    .default('software')
    .describe('Which standard fields to attach'),
  visibility: z.enum(PROJECT_VISIBILITIES).default('open'),
});
export const UpdateProjectBody = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(5000).optional(),
  lead: z.string().nullable().optional(),
  archived: z.boolean().optional(),
  visibility: z.enum(PROJECT_VISIBILITIES).optional(),
  settings: z
    .object({
      triageMode: z.enum(TRIAGE_MODES).optional(),
      plan: PlanSettingsSchema.partial().optional(),
      helpdesk: HelpdeskSettingsSchema.partial().optional(),
    })
    .optional(),
});

/** Someone with a role in a project. */
export const ProjectMemberSchema = z
  .object({
    user: UserRefSchema,
    role: z.enum(PROJECT_ROLES),
    lead: z.boolean().describe('They lead the project, which makes them a manager of it whatever their role here'),
    addedAt: timestamp.nullable().describe('Null for a lead who was never added by hand'),
    addedBy: UserRefSchema.nullable(),
  })
  .meta({ id: 'ProjectMember' });
export type ProjectMember = z.infer<typeof ProjectMemberSchema>;
export const AddMemberBody = z.object({
  user: z.string().min(1).describe('Login of the person or bot'),
  role: z.enum(PROJECT_ROLES).default('member'),
});
export const UpdateMemberBody = z.object({ role: z.enum(PROJECT_ROLES) });

export const FieldValueSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    tone: ToneSchema,
    ordinal: z.number().int(),
    isResolved: z.boolean(),
    archived: z.boolean(),
    projectId: z.string().nullable().describe('null = shared by every project using the field'),
  })
  .meta({ id: 'FieldValue' });
export type FieldValue = z.infer<typeof FieldValueSchema>;

export const FieldSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    type: z.enum(FIELD_TYPES),
    multi: z.boolean(),
    description: z.string(),
    values: z.array(FieldValueSchema),
  })
  .meta({ id: 'Field' });
export type Field = z.infer<typeof FieldSchema>;

export const ProjectFieldSchema = z
  .object({
    fieldId: z.string(),
    name: z.string(),
    type: z.enum(FIELD_TYPES),
    multi: z.boolean(),
    required: z.boolean(),
    ordinal: z.number().int(),
    defaultValue: z.unknown().nullable(),
    values: z.array(FieldValueSchema).describe('Allowed values in this project (option fields)'),
  })
  .meta({ id: 'ProjectField' });
export type ProjectField = z.infer<typeof ProjectFieldSchema>;

export const CreateFieldBody = z.object({
  name: z.string().min(1).max(60),
  type: z.enum(FIELD_TYPES),
  multi: z.boolean().default(false),
  description: z.string().max(1000).default(''),
  values: z
    .array(
      z.object({
        name: z.string().min(1).max(80),
        tone: ToneSchema.optional(),
        isResolved: z.boolean().optional(),
        description: z.string().optional(),
      }),
    )
    .default([]),
});
export const UpdateFieldBody = z.object({
  name: z.string().min(1).max(60).optional(),
  description: z.string().max(1000).optional(),
});
export const FieldValueBody = z.object({
  name: z.string().min(1).max(80),
  tone: ToneSchema.optional(),
  isResolved: z.boolean().optional(),
  description: z.string().optional(),
  ordinal: z.number().int().optional(),
  archived: z.boolean().optional(),
  project: z.string().nullable().optional().describe('Project key to scope the value to one project'),
});
export const AttachFieldBody = z.object({
  required: z.boolean().default(false),
  ordinal: z.number().int().optional(),
  defaultValue: z.unknown().nullable().optional(),
});

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

export const OptionValueSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    tone: ToneSchema,
    isResolved: z.boolean(),
    ordinal: z.number().int(),
  })
  .meta({ id: 'OptionValue' });
export type OptionValue = z.infer<typeof OptionValueSchema>;

export const PeriodValueSchema = z
  .object({ minutes: z.number().int(), presentation: z.string() })
  .meta({ id: 'PeriodValue' });
export type PeriodValue = z.infer<typeof PeriodValueSchema>;

export const IssueFieldValueSchema = z.union([
  z.null(),
  OptionValueSchema,
  UserRefSchema,
  PeriodValueSchema,
  z.string(),
  z.number(),
  z.array(OptionValueSchema),
  z.array(UserRefSchema),
]);
export type IssueFieldValue = z.infer<typeof IssueFieldValueSchema>;

export const IssueFieldSchema = z
  .object({
    fieldId: z.string(),
    name: z.string(),
    type: z.enum(FIELD_TYPES),
    multi: z.boolean(),
    value: IssueFieldValueSchema,
  })
  .meta({ id: 'IssueField' });
export type IssueField = z.infer<typeof IssueFieldSchema>;

export const TagSchema = z.object({ id: z.string(), name: z.string() }).meta({ id: 'Tag' });
export type Tag = z.infer<typeof TagSchema>;

export const IssueRefSchema = z
  .object({
    id: z.string().describe('Readable id, e.g. BACK-12'),
    summary: z.string(),
    resolved: z.boolean(),
    state: z.string().nullable(),
  })
  .meta({ id: 'IssueRef' });
export type IssueRef = z.infer<typeof IssueRefSchema>;

export const IssueSchema = z
  .object({
    id: z.string().describe('Readable id, e.g. BACK-12'),
    uid: z.string().describe('Internal id'),
    number: z.number().int(),
    project: ProjectRefSchema,
    summary: z.string(),
    reporter: UserRefSchema.nullable(),
    createdAt: timestamp,
    updatedAt: timestamp,
    resolvedAt: timestamp.nullable(),
    version: z.number().int().describe('Incremented on every change; send as expectedVersion to avoid lost updates'),
    fields: z.array(IssueFieldSchema),
    tags: z.array(TagSchema),
    commentCount: z.number().int(),
  })
  .meta({ id: 'Issue' });
export type Issue = z.infer<typeof IssueSchema>;

export const IssueLinkSchema = z
  .object({
    id: z.string(),
    typeId: z.string(),
    typeName: z.string(),
    phrase: z.string().describe('How this issue relates to the other one, e.g. "depends on"'),
    direction: z.enum(['outward', 'inward', 'both']),
    issue: IssueRefSchema,
  })
  .meta({ id: 'IssueLink' });
export type IssueLink = z.infer<typeof IssueLinkSchema>;

export const IssueDetailSchema = IssueSchema.extend({
  description: z.string(),
  updatedBy: UserRefSchema.nullable(),
  links: z.array(IssueLinkSchema),
  parent: IssueRefSchema.nullable(),
  subtasks: z.array(IssueRefSchema),
  spentMinutes: z.number().int(),
  pendingSuggestions: z.number().int(),
}).meta({ id: 'IssueDetail' });
export type IssueDetail = z.infer<typeof IssueDetailSchema>;

/**
 * Field values by field name. Option and user fields take names/logins, dates
 * take YYYY-MM-DD, periods take "1d 4h" or minutes, null clears the field.
 */
export const FieldsInput = z
  .record(z.string(), z.union([z.string(), z.number(), z.null(), z.array(z.string())]))
  .describe('Field values by field name, e.g. {"Priority": "Critical", "Assignee": "anna", "Estimation": "2d"}');
export type FieldsInputT = z.infer<typeof FieldsInput>;

export const CreateIssueBody = z.object({
  project: z.string().describe('Project key'),
  summary: z.string().min(1).max(500),
  description: z.string().max(100_000).default(''),
  fields: FieldsInput.optional(),
  tags: z.array(z.string()).optional(),
  parent: z.string().optional().describe('Readable id of the parent issue (creates a subtask link)'),
  links: z
    .array(z.object({ relation: z.string().describe('e.g. "depends on", "relates to"'), issue: z.string() }))
    .optional(),
});
/** What callers send (defaults not yet applied). */
export type CreateIssueInput = z.input<typeof CreateIssueBody>;

export const UpdateIssueBody = z.object({
  summary: z.string().min(1).max(500).optional(),
  description: z.string().max(100_000).optional(),
  fields: FieldsInput.optional(),
  addTags: z.array(z.string()).optional(),
  removeTags: z.array(z.string()).optional(),
  expectedVersion: z.number().int().optional().describe('Fail with 409 if the issue changed since this version'),
});
export type UpdateIssueInput = z.infer<typeof UpdateIssueBody>;

export const IssueListQuery = z.object({
  query: z.string().default('').describe('Search query in a4a query language'),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const IssueListSchema = paginated(IssueSchema, 'IssueList');
export type IssueList = z.infer<typeof IssueListSchema>;

// Comments, links, work items, tags --------------------------------------

export const CommentSchema = z
  .object({
    id: z.string(),
    issueId: z.string(),
    author: UserRefSchema.nullable(),
    text: z.string(),
    channel: z.enum(CHANNELS),
    createdAt: timestamp,
    updatedAt: timestamp,
    visibility: z
      .enum(COMMENT_VISIBILITIES)
      .describe('internal: the team alone. public: also the requester of a help desk request, who is emailed it'),
    requester: z
      .object({ name: z.string() })
      .nullable()
      .describe('Set when the requester of a help desk request wrote it, on their tracking page'),
  })
  .meta({ id: 'Comment' });
export type Comment = z.infer<typeof CommentSchema>;
export const CommentBody = z.object({ text: z.string().min(1).max(50_000) });
export const NewCommentBody = CommentBody.extend({
  visibility: z
    .enum(COMMENT_VISIBILITIES)
    .default('internal')
    .describe('public sends it to the requester of a help desk request, by email and on their tracking page; only requests take it'),
});

export const LinkTypeSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    outward: z.string(),
    inward: z.string(),
    directed: z.boolean(),
    aggregation: z.boolean().describe('Parent/subtask style link'),
  })
  .meta({ id: 'LinkType' });
export type LinkType = z.infer<typeof LinkTypeSchema>;
export const LinkBody = z.object({
  relation: z.string().describe('Link phrase from this issue\'s point of view, e.g. "depends on", "subtask of", "duplicates"'),
  issue: z.string().describe('Readable id of the other issue'),
});

export const WorkItemSchema = z
  .object({
    id: z.string(),
    issueId: z.string(),
    author: UserRefSchema.nullable(),
    date: isoDate,
    minutes: z.number().int(),
    description: z.string(),
    hourlyRate: z.number().nullable().describe('Cost rate snapshot at the time the work was logged'),
    createdAt: timestamp,
  })
  .meta({ id: 'WorkItem' });
export type WorkItem = z.infer<typeof WorkItemSchema>;
export const WorkItemBody = z.object({
  duration: z.union([z.string(), z.number()]).describe('"1h 30m", "2d" or minutes'),
  date: isoDate.optional(),
  description: z.string().max(5000).default(''),
  author: z.string().optional().describe('Login; admins can log work for others'),
});

export const TagBody = z.object({ name: z.string().min(1).max(60) });

// Activity & events ---------------------------------------------------------

export const ChangeSchema = z
  .object({
    field: z.string(),
    from: z.string().nullable(),
    to: z.string().nullable(),
  })
  .meta({ id: 'Change' });
export type Change = z.infer<typeof ChangeSchema>;

export const ActorSchema = z
  .object({
    id: z.string().nullable(),
    login: z.string().nullable(),
    name: z.string().nullable(),
    channel: z.enum(CHANNELS),
    token: z.string().nullable(),
    isBot: z
      .boolean()
      .describe("An agent's account, acting as itself (a4a's own, such as triage, or one an administrator added and gave a token), not a person"),
  })
  .meta({ id: 'Actor' });

export const EventSchema = z
  .object({
    id: z.number().int(),
    type: z.enum(EVENT_TYPES),
    occurredAt: timestamp,
    actor: ActorSchema,
    project: z.string().nullable(),
    issue: IssueRefSchema.nullable(),
    changes: z.array(ChangeSchema),
    data: z.record(z.string(), z.unknown()),
    undo: z
      .object({
        state: z.enum(UNDO_STATES),
        note: z.string().describe('What changed since, or who undid it and when; empty when it can be undone'),
      })
      .optional()
      .describe("Only in an issue's history, on a change an agent made on its own: whether a person can still undo it (POST /events/{id}/undo)"),
  })
  .meta({ id: 'Event' });
export type TrackerEvent = z.infer<typeof EventSchema>;

// Search & commands ---------------------------------------------------------

export const QueryProblemSchema = z
  .object({
    message: z.string(),
    start: z.number().int(),
    end: z.number().int(),
    hint: z.string().optional(),
    fix: z.string().optional().describe('Text that fixes it, to put in place of start..end'),
  })
  .meta({ id: 'QueryProblem' });
export type QueryProblem = z.infer<typeof QueryProblemSchema>;

export const ParseQueryResultSchema = z
  .object({
    ok: z.boolean(),
    problems: z.array(QueryProblemSchema),
    explanation: z.string().describe('Plain-English reading of the query'),
  })
  .meta({ id: 'ParseQueryResult' });

export const SuggestItemSchema = z
  .object({
    label: z.string(),
    insert: z.string(),
    kind: z.enum(['field', 'value', 'keyword', 'user', 'tag', 'project', 'issue', 'sort']),
    description: z.string().optional(),
    replaceStart: z.number().int(),
    replaceEnd: z.number().int(),
  })
  .meta({ id: 'SuggestItem' });
export type SuggestItem = z.infer<typeof SuggestItemSchema>;

export const CountBody = z.object({
  query: z.string().default(''),
  groupBy: z.string().optional().describe('Field name to group by, e.g. "State" or "Assignee"'),
});
export const CountResultSchema = z
  .object({
    total: z.number().int(),
    groups: z.array(z.object({ value: z.string().nullable(), count: z.number().int() })),
  })
  .meta({ id: 'CountResult' });
export type CountResult = z.infer<typeof CountResultSchema>;

export const CommandBody = z.object({
  issues: z.array(z.string()).min(1).max(50),
  command: z.string().default(''),
  comment: z.string().max(50_000).optional(),
  dryRun: z.boolean().default(false),
  readBy: z
    .literal('assistant')
    .optional()
    .describe("In the web app: the assistant read this command from the person's words (POST /ai/command), so each issue's history says it came via the assistant"),
});
export const CommandIssueResultSchema = z
  .object({
    issue: z.string(),
    changes: z.array(ChangeSchema),
    errors: z.array(z.string()),
  })
  .meta({ id: 'CommandIssueResult' });
export const CommandResultSchema = z
  .object({
    applied: z.boolean(),
    problems: z.array(QueryProblemSchema),
    results: z.array(CommandIssueResultSchema),
  })
  .meta({ id: 'CommandResult' });
export type CommandResult = z.infer<typeof CommandResultSchema>;

export const SavedSearchSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    query: z.string(),
    shared: z.boolean(),
    owner: UserRefSchema.nullable(),
  })
  .meta({ id: 'SavedSearch' });
export type SavedSearch = z.infer<typeof SavedSearchSchema>;
export const SavedSearchBody = z.object({
  name: z.string().min(1).max(80),
  query: z.string().max(2000),
  shared: z.boolean().default(false),
});

// Boards & sprints ----------------------------------------------------------

export const BoardColumnSchema = z
  .object({
    name: z.string(),
    values: z.array(z.string()),
    wipLimit: z.number().int().nullable(),
  })
  .meta({ id: 'BoardColumn' });
export type BoardColumn = z.infer<typeof BoardColumnSchema>;

export const SprintSchema = z
  .object({
    id: z.string(),
    boardId: z.string(),
    name: z.string(),
    goal: z.string(),
    startDate: isoDate.nullable(),
    endDate: isoDate.nullable(),
    archived: z.boolean(),
    issueCount: z.number().int(),
  })
  .meta({ id: 'Sprint' });
export type Sprint = z.infer<typeof SprintSchema>;

export const BoardSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    projects: z.array(ProjectRefSchema),
    columnField: z.string(),
    columns: z.array(BoardColumnSchema),
    swimlaneField: z.string().nullable(),
    query: z.string().nullable(),
    sprintsEnabled: z.boolean(),
  })
  .meta({ id: 'Board' });
export type Board = z.infer<typeof BoardSchema>;

export const BoardBody = z.object({
  name: z.string().min(1).max(80),
  projects: z.array(z.string()).min(1).describe('Project keys'),
  columnField: z.string().default('State'),
  columns: z
    .array(z.object({ name: z.string(), values: z.array(z.string()), wipLimit: z.number().int().nullable().optional() }))
    .optional()
    .describe('Defaults to one column per value of the column field'),
  swimlaneField: z.string().nullable().optional(),
  query: z.string().nullable().optional(),
  sprintsEnabled: z.boolean().default(false),
});

export const BoardViewSchema = z
  .object({
    board: BoardSchema,
    sprint: SprintSchema.nullable(),
    sprints: z.array(SprintSchema),
    columns: z.array(BoardColumnSchema.extend({ issues: z.array(IssueSchema), count: z.number().int() })),
    swimlanes: z.array(z.string()).describe('Swimlane values in display order (empty when no swimlane field)'),
  })
  .meta({ id: 'BoardView' });
export type BoardView = z.infer<typeof BoardViewSchema>;

export const SprintBody = z.object({
  name: z.string().min(1).max(80),
  goal: z.string().max(2000).default(''),
  startDate: isoDate.nullable().optional(),
  endDate: isoDate.nullable().optional(),
  archived: z.boolean().optional(),
});
export const SprintIssuesBody = z.object({
  issues: z.array(z.string()).min(1).max(200),
  remove: z.boolean().default(false),
});

// Webhooks ------------------------------------------------------------------

export const WebhookSchema = z
  .object({
    id: z.string(),
    url: z.string(),
    events: z.array(z.string()),
    project: z.string().nullable(),
    active: z.boolean(),
    createdAt: timestamp,
  })
  .meta({ id: 'Webhook' });
export type Webhook = z.infer<typeof WebhookSchema>;
export const WebhookCreatedSchema = WebhookSchema.extend({
  secret: z.string().describe('HMAC secret. Shown only once.'),
}).meta({ id: 'WebhookCreated' });
export const WebhookBody = z.object({
  url: z.string().url(),
  events: z.array(z.string()).min(1).default(['*']).describe('Event types, or "*" for all'),
  project: z.string().nullable().optional(),
  active: z.boolean().default(true),
});
export const WebhookDeliverySchema = z
  .object({
    id: z.string(),
    eventId: z.number().int().nullable(),
    eventType: z.string(),
    statusCode: z.number().int().nullable(),
    success: z.boolean(),
    attempt: z.number().int(),
    durationMs: z.number().int(),
    error: z.string().nullable(),
    createdAt: timestamp,
  })
  .meta({ id: 'WebhookDelivery' });

// Settings ------------------------------------------------------------------

export const SettingsSchema = z
  .object({
    instanceName: z.string(),
    defaultTriageMode: z.enum(TRIAGE_MODES),
    publicUrl: z.string(),
  })
  .meta({ id: 'Settings' });
export type Settings = z.infer<typeof SettingsSchema>;
export const SettingsBody = z.object({
  instanceName: z.string().min(1).max(80).optional(),
  defaultTriageMode: z.enum(TRIAGE_MODES).optional(),
});

// ---------------------------------------------------------------------------
// Planning: schedule, resources, costs, baselines
// ---------------------------------------------------------------------------

export const ScheduleTaskSchema = z
  .object({
    issue: IssueRefSchema,
    assignee: UserRefSchema.nullable(),
    priority: z.string().nullable(),
    parent: z.string().nullable().describe('Readable id of the parent (summary) task'),
    depth: z.number().int(),
    isSummary: z.boolean(),
    isMilestone: z.boolean().describe('A point in time (Type Milestone, or no duration), drawn as a diamond'),
    start: isoDate,
    finish: isoDate,
    durationDays: z.number().describe('Working days'),
    effortMinutes: z.number().int(),
    spentMinutes: z.number().int(),
    percentComplete: z.number(),
    earlyStart: isoDate,
    earlyFinish: isoDate,
    lateStart: isoDate,
    lateFinish: isoDate,
    slackDays: z.number(),
    critical: z.boolean(),
    deadline: isoDate.nullable(),
    late: z.boolean().describe('Finishes after its due date'),
    scheduledFrom: z.enum(['actual', 'fixed', 'start', 'dependencies', 'project_start']),
    predecessors: z.array(z.string()),
    plannedCost: z.number(),
    actualCost: z.number(),
    baseline: z
      .object({ start: isoDate, finish: isoDate, effortMinutes: z.number().int(), cost: z.number() })
      .nullable(),
    variance: z
      .object({ startDays: z.number(), finishDays: z.number(), effortMinutes: z.number().int(), cost: z.number() })
      .nullable(),
  })
  .meta({ id: 'ScheduleTask' });
export type ScheduleTask = z.infer<typeof ScheduleTaskSchema>;

export const ScheduleSchema = z
  .object({
    project: ProjectRefSchema,
    calendar: PlanSettingsSchema,
    start: isoDate,
    finish: isoDate,
    today: isoDate,
    criticalPath: z.array(z.string()),
    tasks: z.array(ScheduleTaskSchema),
    warnings: z.array(z.string()),
    baseline: z
      .object({ id: z.string(), name: z.string(), finish: isoDate, finishVarianceDays: z.number() })
      .nullable(),
  })
  .meta({ id: 'Schedule' });
export type Schedule = z.infer<typeof ScheduleSchema>;

export const ScheduleQuery = z.object({
  query: z.string().optional().describe('Restrict the plan to issues matching this query (within the project)'),
  baseline: z.string().optional().describe('Baseline id to compare against'),
});

export const WhatIfBody = z.object({
  query: z.string().optional(),
  baseline: z.string().optional(),
  overrides: z
    .array(
      z.object({
        issue: z.string(),
        delayDays: z.number().optional().describe('Push the task start by N working days'),
        estimate: z.string().optional().describe('New estimate, e.g. "3d"'),
        assignee: z.string().nullable().optional(),
        start: isoDate.optional(),
      }),
    )
    .min(1),
});
export const WhatIfResultSchema = z
  .object({
    before: z.object({ finish: isoDate, criticalPath: z.array(z.string()) }),
    after: ScheduleSchema,
    finishDeltaDays: z.number(),
    impacted: z.array(
      z.object({ issue: z.string(), summary: z.string(), startDeltaDays: z.number(), finishDeltaDays: z.number() }),
    ),
  })
  .meta({ id: 'WhatIfResult' });
export type WhatIfResult = z.infer<typeof WhatIfResultSchema>;

export const ResourceDaySchema = z
  .object({
    date: isoDate,
    hours: z.number(),
    capacity: z.number().describe('Hours they can work that day: their capacity, half of it on a half day away, 0 on a day away'),
    away: z.enum(['day', 'morning', 'afternoon']).nullable().describe('Whether they are away that day, and which part of it; never why'),
    tasks: z.array(z.object({ issue: z.string(), hours: z.number() })),
  })
  .meta({ id: 'ResourceDay' });
export const ResourceLoadSchema = z
  .object({
    from: isoDate,
    to: isoDate,
    resources: z.array(
      z.object({
        user: UserRefSchema,
        capacityHoursPerDay: z.number(),
        totalHours: z.number(),
        overallocatedDays: z.number().int(),
        peakLoadPct: z.number(),
        days: z.array(ResourceDaySchema),
      }),
    ),
    unassignedHours: z.number(),
  })
  .meta({ id: 'ResourceLoad' });
export type ResourceLoad = z.infer<typeof ResourceLoadSchema>;
export const ResourceQuery = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  query: z.string().optional(),
});

export const LevelBody = z.object({
  query: z.string().optional(),
  mode: z.enum(LEVELING_MODES).default('within_slack').describe('within_slack never moves the finish date; allow_delay may'),
  dryRun: z.boolean().default(true),
  expect: z
    .record(z.string(), isoDate)
    .optional()
    .describe(
      "The `starts` of the proposal you were shown. When given, nothing is applied if levelling would now write anything else (the plan changed since): you get 409 and can review the new proposal.",
    ),
});
export const LevelingResultSchema = z
  .object({
    mode: z.enum(LEVELING_MODES),
    applied: z.boolean(),
    finishBefore: isoDate,
    finishAfter: isoDate,
    overallocatedDaysBefore: z.number().int(),
    overallocatedDaysAfter: z.number().int(),
    changes: z.array(
      z.object({
        issue: z.string(),
        summary: z.string(),
        assignee: z.string().nullable(),
        fromStart: isoDate,
        fromFinish: isoDate,
        toStart: isoDate,
        toFinish: isoDate,
        delayDays: z.number(),
        movedBy: z.enum(['resources', 'dependencies']).describe('resources: levelling moved it; dependencies: it follows a task that moved'),
      }),
    ),
    starts: z
      .record(z.string(), isoDate)
      .describe('What applying writes: the new Start date of each task moved for resources. The others follow from their dependencies.'),
    unresolved: z.array(z.string()).describe('Tasks that could not be levelled within the chosen mode'),
    keepsStart: isoDate
      .nullable()
      .describe(
        "When the plan has no start date of its own, it begins at its earliest task's; the levelled starts would become that and move everything else. Then this is where it began, which applying sets as its start date, so the plan stays as proposed",
      ),
  })
  .meta({ id: 'LevelingResult' });
export type LevelingResult = z.infer<typeof LevelingResultSchema>;

export const EvmSchema = z
  .object({
    asOf: isoDate,
    bac: z.number().describe('Budget at completion (baseline planned cost)'),
    pv: z.number().describe('Planned value'),
    ev: z.number().describe('Earned value'),
    ac: z.number().describe('Actual cost'),
    cv: z.number(),
    sv: z.number(),
    cpi: z.number().nullable(),
    spi: z.number().nullable(),
    eac: z.number().nullable().describe('Estimate at completion'),
    etc: z.number().nullable().describe('Estimate to complete'),
    vac: z.number().nullable().describe('Variance at completion'),
  })
  .meta({ id: 'Evm' });
export type Evm = z.infer<typeof EvmSchema>;

export const CostReportSchema = z
  .object({
    project: ProjectRefSchema,
    currency: z.string(),
    budget: z.number().nullable(),
    plannedCost: z.number(),
    actualCost: z.number(),
    forecastCost: z.number(),
    budgetVariance: z.number().nullable(),
    byTask: z.array(
      z.object({
        issue: z.string(),
        summary: z.string(),
        assignee: z.string().nullable(),
        plannedCost: z.number(),
        actualCost: z.number(),
        fixedCost: z.number(),
        effortMinutes: z.number().int(),
        spentMinutes: z.number().int(),
        resolved: z.boolean(),
      }),
    ),
    byPerson: z.array(
      z.object({
        user: UserRefSchema,
        hourlyRate: z.number().nullable(),
        plannedHours: z.number(),
        actualHours: z.number(),
        plannedCost: z.number(),
        actualCost: z.number(),
      }),
    ),
    evm: EvmSchema.nullable(),
    warnings: z.array(z.string()),
  })
  .meta({ id: 'CostReport' });
export type CostReport = z.infer<typeof CostReportSchema>;

export const BaselineSchema = z
  .object({
    id: z.string(),
    projectKey: z.string(),
    name: z.string(),
    note: z.string(),
    createdAt: timestamp,
    createdBy: UserRefSchema.nullable(),
    taskCount: z.number().int(),
    start: isoDate.nullable(),
    finish: isoDate.nullable(),
    plannedCost: z.number(),
  })
  .meta({ id: 'Baseline' });
export type Baseline = z.infer<typeof BaselineSchema>;
export const BaselineBody = z.object({
  name: z.string().min(1).max(80),
  note: z.string().max(2000).default(''),
  query: z.string().optional(),
});

// ---------------------------------------------------------------------------
// AI
// ---------------------------------------------------------------------------

export const AIStatusSchema = z
  .object({
    enabled: z.boolean(),
    provider: z.string().describe('Who serves the model, such as Anthropic or DeepSeek: issue text the AI reads goes to them'),
    model: z.string(),
    reason: z.string().nullable().describe('Why the AI is off, when it is'),
  })
  .meta({ id: 'AIStatus' });
export type AIStatus = z.infer<typeof AIStatusSchema>;

export const NLQueryBody = z.object({
  text: z.string().min(1).max(2000),
  project: z.string().optional().describe('Project key the user is looking at, if any'),
});
export const NLQueryResultSchema = z
  .object({
    query: z.string(),
    explanation: z.string(),
    valid: z.boolean(),
    problems: z.array(QueryProblemSchema),
  })
  .meta({ id: 'NLQueryResult' });
export type NLQueryResult = z.infer<typeof NLQueryResultSchema>;

export const NLCommandBody = z.object({
  text: z.string().min(1).max(2000),
  issues: z.array(z.string()).min(1).max(50),
});
export const NLCommandResultSchema = z
  .object({
    command: z.string(),
    comment: z.string().nullable(),
    explanation: z.string(),
    preview: CommandResultSchema,
  })
  .meta({ id: 'NLCommandResult' });
export type NLCommandResult = z.infer<typeof NLCommandResultSchema>;

export const SimilarBody = z.object({
  summary: z.string().min(1).max(500),
  description: z.string().max(20_000).optional(),
  project: z.string().optional(),
  excludeIssue: z.string().optional(),
  limit: z.number().int().min(1).max(20).default(5),
  judge: z.boolean().default(false).describe('Ask the AI to label each candidate (duplicate / related / different)'),
});
export const SimilarIssueSchema = z
  .object({
    issue: IssueRefSchema,
    project: z.string(),
    score: z.number(),
    verdict: z.enum(['duplicate', 'related', 'different']).nullable(),
    reason: z.string().nullable(),
  })
  .meta({ id: 'SimilarIssue' });
export type SimilarIssue = z.infer<typeof SimilarIssueSchema>;
export const SimilarResultSchema = z
  .object({ items: z.array(SimilarIssueSchema), judged: z.boolean() })
  .meta({ id: 'SimilarResult' });

export const TriagePayloadSchema = z
  .object({
    fields: z.array(
      z.object({
        name: z.string(),
        value: z.string(),
        current: z.string().nullable(),
        confidence: z.enum(['low', 'medium', 'high']),
        reason: z.string(),
      }),
    ),
    tags: z.array(z.object({ name: z.string(), confidence: z.enum(['low', 'medium', 'high']) })),
    duplicates: z.array(
      z.object({
        issue: z.string(),
        summary: z.string(),
        verdict: z.enum(['duplicate', 'related']),
        reason: z.string(),
      }),
    ),
    summary: z.string().describe('One or two sentences explaining the triage'),
  })
  .meta({ id: 'TriagePayload' });
export type TriagePayload = z.infer<typeof TriagePayloadSchema>;

export const SuggestionSchema = z
  .object({
    id: z.string(),
    issueId: z.string(),
    kind: z.enum(['triage']),
    status: z.enum(['pending', 'applied', 'dismissed', 'partially_applied']),
    payload: TriagePayloadSchema,
    model: z.string(),
    createdAt: timestamp,
    resolvedAt: timestamp.nullable(),
    resolvedBy: UserRefSchema.nullable(),
  })
  .meta({ id: 'Suggestion' });
export type Suggestion = z.infer<typeof SuggestionSchema>;
export const ApplySuggestionBody = z.object({
  fields: z.array(z.string()).optional().describe('Field names to apply; omit to apply all'),
  tags: z.array(z.string()).optional(),
});

export const SummarizeResultSchema = z
  .object({ summary: z.string(), model: z.string() })
  .meta({ id: 'SummarizeResult' });

export const ConversationSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    project: z.string().nullable(),
    status: z.enum(['idle', 'running', 'awaiting_approval']),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .meta({ id: 'Conversation' });
export type Conversation = z.infer<typeof ConversationSchema>;

export const ChatPartSchema = z
  .discriminatedUnion('type', [
    z.object({ type: z.literal('text'), text: z.string() }),
    z.object({ type: z.literal('progress'), text: z.string() }),
    z.object({
      type: z.literal('tool'),
      id: z.string(),
      name: z.string(),
      input: z.unknown(),
      status: z.enum(['pending_approval', 'running', 'done', 'error', 'rejected']),
      summary: z.string().nullable(),
      write: z.boolean(),
    }),
    z.object({ type: z.literal('notice'), text: z.string() }),
  ])
  .meta({ id: 'ChatPart' });
export type ChatPart = z.infer<typeof ChatPartSchema>;

export const ChatMessageSchema = z
  .object({
    id: z.string(),
    role: z.enum(['user', 'assistant']),
    parts: z.array(ChatPartSchema),
    createdAt: timestamp,
  })
  .meta({ id: 'ChatMessage' });
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const ConversationDetailSchema = ConversationSchema.extend({
  messages: z.array(ChatMessageSchema),
  pendingApprovals: z.array(
    z.object({ toolUseId: z.string(), name: z.string(), input: z.unknown(), preview: z.string() }),
  ),
}).meta({ id: 'ConversationDetail' });
export type ConversationDetail = z.infer<typeof ConversationDetailSchema>;

export const CreateConversationBody = z.object({
  title: z.string().max(200).optional(),
  project: z.string().optional(),
});
export const ChatMessageBody = z.object({
  text: z.string().min(1).max(20_000),
  context: z
    .object({
      issue: z.string().optional().describe('Issue the user is looking at'),
      project: z.string().optional(),
      query: z.string().optional().describe('Search the user has open'),
    })
    .optional(),
  approvalMode: z.enum(['ask', 'auto']).default('ask').describe('ask = pause before every write'),
});
export const ChatApproveBody = z.object({
  decisions: z.array(z.object({ toolUseId: z.string(), approve: z.boolean() })).min(1),
});

/** Server-sent events emitted by the chat endpoints. */
export type ChatStreamEvent =
  | { type: 'message_start'; messageId: string }
  | { type: 'text_delta'; text: string }
  | { type: 'progress'; text: string }
  | { type: 'tool_start'; id: string; name: string; input: unknown; write: boolean }
  | { type: 'tool_result'; id: string; ok: boolean; summary: string }
  | { type: 'approval_required'; approvals: { toolUseId: string; name: string; input: unknown; preview: string }[] }
  | { type: 'notice'; text: string }
  | { type: 'error'; message: string }
  | { type: 'done'; status: 'idle' | 'awaiting_approval' };

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

export const AttachmentSchema = z
  .object({
    id: z.string(),
    name: z.string().describe('The file name, made safe: no folders, control characters or reserved characters'),
    contentType: z.string().describe("Read from the file's bytes, never taken from the uploader"),
    size: z.number().int().describe('Bytes'),
    sha256: z.string().describe('SHA-256 of the bytes, in hex'),
    inline: z.boolean().describe('A raster image (PNG, JPEG, GIF or WebP) that browsers show in place; every other file downloads'),
    text: z.boolean().describe('Text, which GET /attachments/{id}/text and the MCP tool read_attachment can read'),
    play: z
      .enum(PLAY_KINDS)
      .nullable()
      .describe("Sound or video the web app plays in place (MP3, AAC, M4A, Ogg, WAV, FLAC; MP4, WebM), from the bytes' type; null for every other file"),
    issue: z.string().nullable().describe('The issue it belongs to, also for a file on one of its comments'),
    comment: z.string().nullable().describe('The comment it was attached to, if any'),
    article: z.string().nullable().describe('The article it belongs to, if any'),
    uploadedBy: UserRefSchema.nullable(),
    channel: z.enum(CHANNELS),
    token: z.string().nullable().describe('The token it came with, for an agent or a script'),
    createdAt: timestamp,
    url: z.string().describe('Its bytes: GET it with the same credentials'),
  })
  .meta({ id: 'Attachment' });
export type Attachment = z.infer<typeof AttachmentSchema>;

export const AttachmentLimitsSchema = z
  .object({
    maxBytes: z.number().int().describe('The largest file one upload may carry'),
    perIssueMaxBytes: z.number().int().describe("All of an issue's files together, its comments' included; the same for an article"),
    inlineTypes: z.array(z.string()).describe('Types shown in place; everything else downloads'),
  })
  .meta({ id: 'AttachmentLimits' });
export type AttachmentLimits = z.infer<typeof AttachmentLimitsSchema>;

export const AttachmentTextQuery = z.object({
  offset: z.coerce.number().int().min(0).default(0).describe('Byte to start at'),
  maxBytes: z.coerce.number().int().min(1).max(131_072).default(32_768).describe('At most this many bytes (128 KB at most)'),
  tail: z.enum(['true', 'false']).optional().describe('true: read the last maxBytes instead, as for the end of a log'),
});
export const AttachmentTextSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    size: z.number().int(),
    from: z.number().int().describe('The first byte read'),
    to: z.number().int().describe('One past the last byte read'),
    truncated: z.boolean().describe('Some of the file is outside what was read'),
    text: z.string(),
  })
  .meta({ id: 'AttachmentText' });
export type AttachmentText = z.infer<typeof AttachmentTextSchema>;

// ---------------------------------------------------------------------------
// Knowledge base
// ---------------------------------------------------------------------------

export const ArticleRefSchema = z
  .object({
    id: z.string().describe('Readable id, e.g. BACK-A-3'),
    title: z.string(),
    project: z.string().describe('Project key'),
  })
  .meta({ id: 'ArticleRef' });
export type ArticleRef = z.infer<typeof ArticleRefSchema>;

export const ArticleSchema = z
  .object({
    id: z.string().describe('Readable id, e.g. BACK-A-3'),
    uid: z.string().describe('Internal id'),
    number: z.number().int(),
    project: ProjectRefSchema,
    title: z.string(),
    parent: z.string().nullable().describe('Readable id of the article it sits under; null at the top of the tree'),
    position: z.number().int().describe('Its place among the articles under the same parent, from 0'),
    childCount: z.number().int(),
    version: z.number().int().describe('Its content version; send as expectedVersion to avoid overwriting a newer one'),
    createdBy: UserRefSchema.nullable(),
    updatedBy: UserRefSchema.nullable(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .meta({ id: 'Article' });
export type Article = z.infer<typeof ArticleSchema>;

export const ArticleDetailSchema = ArticleSchema.extend({
  body: z.string().describe('Markdown'),
  path: z.array(ArticleRefSchema).describe('The articles it sits under, from the top'),
  children: z.array(ArticleRefSchema),
  mentionedIn: z.object({
    issues: z.array(IssueRefSchema).describe('Issues whose description or comments mention it'),
    articles: z.array(ArticleRefSchema).describe('Other articles that mention it'),
  }),
  attachmentCount: z.number().int(),
}).meta({ id: 'ArticleDetail' });
export type ArticleDetail = z.infer<typeof ArticleDetailSchema>;

export const CreateArticleBody = z.object({
  project: z.string().describe('Project key'),
  title: z.string().min(1).max(250),
  body: z.string().max(200_000).default('').describe('Markdown. Mention issues (BACK-12) and articles (BACK-A-3) by id'),
  parent: z.string().nullable().optional().describe('Readable id of the article to put it under; omit for the top of the tree'),
  position: z.number().int().min(0).optional().describe('Its place among its siblings, from 0; omit to put it last'),
});
export type CreateArticleInput = z.input<typeof CreateArticleBody>;

export const UpdateArticleBody = z.object({
  title: z.string().min(1).max(250).optional(),
  body: z.string().max(200_000).optional(),
  parent: z.string().nullable().optional().describe('Move it under this article, or to the top with null'),
  position: z.number().int().min(0).optional().describe('Its place among its (new) siblings, from 0'),
  expectedVersion: z.number().int().optional().describe('Fail with 409 if its content changed since this version'),
});
export type UpdateArticleInput = z.infer<typeof UpdateArticleBody>;

export const ArticleListQuery = z.object({
  project: z.string().optional().describe('Project key'),
  query: z.string().max(500).default('').describe('Words to find in titles and bodies; empty lists the latest changed'),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const ArticleSearchItemSchema = ArticleRefSchema.extend({
  path: z.array(z.string()).describe('The titles of the articles it sits under'),
  updatedAt: timestamp,
  snippet: z
    .array(z.object({ text: z.string(), match: z.boolean() }))
    .describe('Where the words were found, in parts; the parts that match say so'),
}).meta({ id: 'ArticleSearchItem' });
export type ArticleSearchItem = z.infer<typeof ArticleSearchItemSchema>;
export const ArticleSearchResultSchema = paginated(ArticleSearchItemSchema, 'ArticleSearchResult');
export type ArticleSearchResult = z.infer<typeof ArticleSearchResultSchema>;

export const ArticleVersionSchema = z
  .object({
    version: z.number().int(),
    title: z.string(),
    author: UserRefSchema.nullable(),
    channel: z.enum(CHANNELS),
    token: z.string().nullable().describe('The token it was saved with, for an agent or a script'),
    createdAt: timestamp,
    chars: z.number().int().describe('The length of its body'),
  })
  .meta({ id: 'ArticleVersion' });
export type ArticleVersion = z.infer<typeof ArticleVersionSchema>;

export const DiffLineSchema = z
  .object({ op: z.enum(['same', 'add', 'del']), text: z.string() })
  .meta({ id: 'DiffLine' });
export type DiffLine = z.infer<typeof DiffLineSchema>;

export const ArticleVersionDetailSchema = ArticleVersionSchema.extend({
  body: z.string(),
  against: z.number().int().nullable().describe('The version the diff is from; null for the first'),
  titleBefore: z.string().nullable(),
  diff: z.array(DiffLineSchema).describe("The body's lines against the version before it"),
}).meta({ id: 'ArticleVersionDetail' });
export type ArticleVersionDetail = z.infer<typeof ArticleVersionDetailSchema>;

// ---------------------------------------------------------------------------
// Watchers and notifications
// ---------------------------------------------------------------------------

export const WatcherSchema = z
  .object({
    user: UserRefSchema,
    reason: z.enum(WATCH_REASONS).describe('Why they watch: they chose to, or they reported it, were assigned, commented, were mentioned, or lead the project of a help desk request'),
    since: timestamp,
  })
  .meta({ id: 'Watcher' });
export type Watcher = z.infer<typeof WatcherSchema>;

export const WatchersSchema = z
  .object({
    watching: z.boolean().describe('Whether you watch it'),
    watchers: z.array(WatcherSchema),
  })
  .meta({ id: 'Watchers' });
export type Watchers = z.infer<typeof WatchersSchema>;

export const NotificationSchema = z
  .object({
    id: z.string(),
    kind: z.enum(NOTIFICATION_KINDS).describe('The strongest reason among its events: assigned, mentioned, request (a new help desk request), watching'),
    title: z.string().describe('What happened, in words: "Anna Schmidt mentioned you"'),
    issue: IssueRefSchema.describe('The issue as it was at its latest event'),
    project: z.string().nullable(),
    issueDeleted: z.boolean(),
    events: z.array(EventSchema).describe('The changes and comments it folds together, oldest first (the last 20)'),
    eventCount: z.number().int(),
    firstAt: timestamp,
    lastAt: timestamp,
    readAt: timestamp.nullable(),
  })
  .meta({ id: 'Notification' });
export type Notification = z.infer<typeof NotificationSchema>;

export const NotificationListSchema = z
  .object({
    unread: z.number().int().describe('Your unread notifications, all of them'),
    total: z.number().int().describe('How many match, before offset and limit'),
    items: z.array(NotificationSchema).describe('Latest first'),
  })
  .meta({ id: 'NotificationList' });
export type NotificationList = z.infer<typeof NotificationListSchema>;

export const NotificationListQuery = z.object({
  unread: z
    .enum(['true', 'false'])
    .optional()
    .describe('true: unread ones only'),
  issue: z.string().optional().describe("One issue's, by its readable id"),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const MarkReadBody = z.object({
  ids: z.array(z.string()).min(1).max(500).optional().describe('These notifications'),
  issue: z.string().optional().describe("An issue's, by its readable id"),
  all: z.boolean().optional().describe('All of yours'),
  until: z
    .string()
    .datetime({ offset: true })
    .optional()
    .describe('Only those whose latest event is no later than this, so what arrived after you looked stays unread'),
  read: z.boolean().default(true).describe('false marks them unread again'),
});

export const MarkReadResultSchema = z
  .object({ changed: z.number().int(), unread: z.number().int() })
  .meta({ id: 'MarkReadResult' });

export const NotificationSettingsSchema = z
  .object({
    email: z.enum(EMAIL_LEVELS).describe('all: every notification; direct: mentions, assignments and new help desk requests; none. In-app is always on'),
    digest: z.boolean().describe("A daily email of what's still unread and wasn't emailed"),
    address: z.string().nullable().describe('Where emails go: your email, from your profile'),
    mailConfigured: z.boolean().describe('Whether this server sends email at all (SMTP_URL)'),
    digestHour: z.number().int().describe("The hour the digest goes out, in the server's time zone (DIGEST_HOUR)"),
  })
  .meta({ id: 'NotificationSettings' });
export type NotificationSettings = z.infer<typeof NotificationSettingsSchema>;
export const NotificationSettingsBody = z.object({
  email: z.enum(EMAIL_LEVELS).optional(),
  digest: z.boolean().optional(),
});

export const UnsubscribeQuery = z.object({ token: z.string().min(10).max(400) });
export const UnsubscribeSchema = z
  .object({
    kind: z.enum(['watching', 'direct', 'digest', 'request']).describe("What the link is for: a person's kind of email, or a help desk request's emails to its requester"),
    what: z.string().describe('What the link stops, in words'),
    done: z.boolean().describe('Whether it is stopped now'),
  })
  .meta({ id: 'Unsubscribe' });
export type Unsubscribe = z.infer<typeof UnsubscribeSchema>;

// ---------------------------------------------------------------------------
// Help desk
// ---------------------------------------------------------------------------

export const SlaSchema = z
  .object({
    state: z.enum(SLA_STATES).describe('none: no target; due: waiting, within it; overdue: waiting, past it; met or missed: answered'),
    dueAt: timestamp.nullable(),
    respondedAt: timestamp.nullable().describe('The first public reply from the team'),
  })
  .meta({ id: 'Sla' });
export type Sla = z.infer<typeof SlaSchema>;

export const HelpdeskRequestSchema = z
  .object({
    issue: z.string(),
    requester: z.object({ name: z.string(), email: z.string() }),
    createdAt: timestamp,
    firstResponse: SlaSchema,
    emailMuted: z.boolean().describe('The requester stopped emails about it; their tracking page still works'),
    via: z.enum(['form', 'email']).describe('How it came in: the public form, or an email to the desk (D30)'),
  })
  .meta({ id: 'HelpdeskRequest' });
export type HelpdeskRequest = z.infer<typeof HelpdeskRequestSchema>;

/**
 * A help desk's proof of work (D30): find `number` from 0 to `maxnumber` whose SHA-256 of
 * `salt + number`, as hex, is `challenge`. The server signed the challenge, so it keeps nothing
 * until the answer comes back, and takes each answer once.
 */
export const CaptchaChallengeSchema = z
  .object({
    algorithm: z.literal('SHA-256'),
    salt: z.string().describe('Says when it expires; part of what is hashed'),
    challenge: z.string().describe('The SHA-256, in hex, to find'),
    maxnumber: z.number().int().describe('The largest number it can be'),
    signature: z.string().describe("The server's signature of the challenge; send it back as it came"),
  })
  .meta({ id: 'CaptchaChallenge' });
export type CaptchaChallenge = z.infer<typeof CaptchaChallengeSchema>;

export const CaptchaSolutionSchema = z.object({
  salt: z.string().max(200),
  challenge: z.string().max(128),
  signature: z.string().max(200),
  number: z.number().int().min(0),
});
export type CaptchaSolution = z.infer<typeof CaptchaSolutionSchema>;

/** What the public form needs: whose help desk it is, its words, and a token against forged posts. */
export const HelpFormSchema = z
  .object({
    project: z.object({ key: z.string(), name: z.string() }),
    intro: z.string(),
    csrf: z.string().describe('Send it back with the request'),
    mail: z.boolean().describe('Whether a confirmation email goes out; without it, the tracking link is shown once'),
    captcha: CaptchaChallengeSchema.nullable().describe("When the desk asks for a proof of work: solve it and send it with the request as `captcha`"),
    email: z.string().nullable().describe('The desk\'s address, when people may also write to it'),
  })
  .meta({ id: 'HelpForm' });
export type HelpForm = z.infer<typeof HelpFormSchema>;

export const HelpRequestBody = z.object({
  name: z.string().trim().min(1).max(HELP_LIMITS.name),
  email: z.string().trim().max(HELP_LIMITS.email).email(),
  summary: z.string().trim().min(3).max(HELP_LIMITS.summary),
  description: z.string().max(HELP_LIMITS.description).default(''),
  website: z.string().max(500).optional().describe('Leave it empty: it is a trap for bots, hidden from people'),
  csrf: z.string().min(1).max(500),
  captcha: CaptchaSolutionSchema.optional().describe("The form's proof of work, solved, when the desk asks for one"),
});

export const HelpRequestReceivedSchema = z
  .object({
    received: z.literal(true),
    email: z.string(),
    tracking: z.string().nullable().describe('The tracking link, only when this server sends no email; shown once'),
  })
  .meta({ id: 'HelpRequestReceived' });
export type HelpRequestReceived = z.infer<typeof HelpRequestReceivedSchema>;

export const TrackedRequestSchema = z
  .object({
    project: z.object({ name: z.string() }),
    summary: z.string(),
    description: z.string(),
    createdAt: timestamp,
    state: z.object({ name: z.string().nullable(), resolved: z.boolean() }),
    requester: z.object({ name: z.string(), email: z.string() }),
    messages: z.array(
      z.object({
        id: z.string(),
        from: z.enum(['you', 'team']),
        name: z.string(),
        text: z.string(),
        at: timestamp,
      }),
    ),
    emailMuted: z.boolean(),
  })
  .meta({ id: 'TrackedRequest' });
export type TrackedRequest = z.infer<typeof TrackedRequestSchema>;

export const HelpReplyBody = z.object({ text: z.string().trim().min(1).max(HELP_LIMITS.reply) });

// ---------------------------------------------------------------------------
// Workflow rules
// ---------------------------------------------------------------------------

const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected a time of day as HH:MM');

export const RuleScheduleSchema = z
  .object({
    every: z.enum(RULE_EVERY).describe('"hour": at the start of every hour; "day": every day; "weekday": Monday to Friday'),
    at: timeOfDay.optional().describe('For "day" and "weekday": the time of day, in the server\'s time zone. Defaults to 09:00'),
  })
  .meta({ id: 'RuleSchedule' });
export type RuleSchedule = z.infer<typeof RuleScheduleSchema>;

/** A further condition, on issues related to the one that set the rule off. */
export const RuleRelatedSchema = z
  .object({
    of: z
      .enum(RULE_RELATIONS)
      .describe('"parent": its parent; "subtasks": its subtasks; "siblings": its parent\'s subtasks, itself among them; "linked": the issues linked to it as `phrase` says'),
    phrase: z.string().max(60).nullable().optional().describe('For "linked": the link as it reads from this issue, e.g. "depends on", "is required for", "relates to"'),
    match: z
      .enum(RULE_MATCH)
      .default('all')
      .describe('"all": there is at least one, and every one matches; "any": at least one matches. A parent matches as "any"'),
    query: z.string().max(2000).describe('What they must match, in the query language'),
  })
  .meta({ id: 'RuleRelated' });
export type RuleRelated = z.infer<typeof RuleRelatedSchema>;

/** The issues a rule acts on. */
export const RuleTargetSchema = z
  .object({
    to: z.enum(RULE_TARGETS).default('issue').describe('"issue": the one that set it off (or matched, on a schedule); "parent", "subtasks", or "linked" as `phrase` says'),
    phrase: z.string().max(60).nullable().optional().describe('For "linked": the link as it reads from the issue, e.g. "depends on"'),
  })
  .meta({ id: 'RuleTarget' });
export type RuleTarget = z.infer<typeof RuleTargetSchema>;

/** Whom a rule tells, and what. */
export const RuleNotifySchema = z
  .object({
    to: z.array(z.enum(RULE_TELL)).max(RULE_TELL.length).default([]).describe("Of each issue it acts on: its assignee, its reporter, its watchers, its project's managers"),
    people: z.array(z.string().max(40)).max(20).default([]).describe('People it tells besides, by login'),
    message: z.string().trim().max(2000).describe("What they're told, in the rule's own words (a rule with none needs fixing)"),
  })
  .meta({ id: 'RuleNotify' });
export type RuleNotify = z.infer<typeof RuleNotifySchema>;

export const RuleBody = z.object({
  project: z.string().nullable().describe('Project key; null for a global rule, for every project (administrators only)'),
  name: z.string().min(1).max(80),
  kind: z.enum(RULE_KINDS).describe('"change": when something happens; "schedule": every hour or day; "guard": refuses a change that breaks it'),
  trigger: z.enum(RULE_TRIGGERS).nullable().optional().describe('A rule on a change: an issue is created, changes, or gets a comment'),
  field: z.string().max(60).nullable().optional().describe('A rule on "updated": only when this field changes, e.g. "State"'),
  schedule: RuleScheduleSchema.nullable().optional().describe('A scheduled rule: how often it runs'),
  query: z
    .string()
    .max(2000)
    .default('')
    .describe('Which issues, in the query language. A rule on a change acts when the issue, as it is after the change, matches it; a guard checks a change that would make an issue match it'),
  command: z.string().max(2000).default('').describe('What to change, in the command language, e.g. "Assignee anna tag urgent"'),
  comment: z.string().max(5000).nullable().optional().describe('A comment the command posts with its change'),
  requires: z.string().max(2000).nullable().optional().describe('A guard: what the issue must also match, e.g. "has: comments"'),
  message: z.string().max(500).nullable().optional().describe('A guard: what a refused change is told, e.g. "Say why in a comment"'),
  related: RuleRelatedSchema.nullable()
    .optional()
    .describe("A change or scheduled rule: a further condition, on its parent, its subtasks, its parent's subtasks or the issues linked to it"),
  target: RuleTargetSchema.nullable().optional().describe('A change or scheduled rule: the issues it acts on. Without it, the issue itself'),
  notify: RuleNotifySchema.nullable().optional().describe('A change or scheduled rule: whom it tells, and what, in their inbox and by email at their level'),
  call: z
    .object({ webhook: z.string().describe("A webhook's id") })
    .nullable()
    .optional()
    .describe("A change or scheduled rule: a webhook it calls about each issue it acts on, signed with the webhook's secret. Administrators only, and only an https webhook"),
  enabled: z.boolean().default(true),
});
export type RuleInput = z.input<typeof RuleBody>;

export const RULE_PARTS = ['name', 'trigger', 'field', 'schedule', 'query', 'requires', 'command', 'related', 'target', 'notify', 'call'] as const;
export const RuleProblemSchema = QueryProblemSchema.extend({
  part: z.enum(RULE_PARTS).describe('Which part of the rule it is in'),
}).meta({ id: 'RuleProblem' });
export type RuleProblem = z.infer<typeof RuleProblemSchema>;

export const RuleRunSchema = z
  .object({
    id: z.number().int(),
    rule: z.object({ id: z.string(), name: z.string() }),
    issue: z.string().nullable().describe('Readable id of the issue it acted on, or null for a scheduled run as a whole'),
    outcome: z.enum(RULE_OUTCOMES),
    message: z.string(),
    changes: z.array(ChangeSchema),
    by: UserRefSchema.nullable().describe('Whose change set it off, or whose change it refused'),
    at: timestamp,
  })
  .meta({ id: 'RuleRun' });
export type RuleRun = z.infer<typeof RuleRunSchema>;

export const RuleSchema = z
  .object({
    id: z.string(),
    project: z.string().nullable().describe('Project key; null for a global rule'),
    name: z.string(),
    kind: z.enum(RULE_KINDS),
    trigger: z.enum(RULE_TRIGGERS).nullable(),
    field: z.string().nullable(),
    schedule: RuleScheduleSchema.nullable(),
    query: z.string(),
    command: z.string(),
    comment: z.string().nullable(),
    requires: z.string().nullable(),
    message: z.string().nullable(),
    related: RuleRelatedSchema.nullable(),
    target: RuleTargetSchema.describe('The issues it acts on; "issue" for the issue itself'),
    notify: RuleNotifySchema.nullable(),
    call: z
      .object({ webhook: z.string(), origin: z.string().nullable().describe('Where the webhook is, without its path: https://host') })
      .nullable()
      .describe('The webhook it calls, if any'),
    enabled: z.boolean(),
    sentence: z.string().describe('The rule in words: "When an issue is created, if it matches …, then apply …"'),
    problems: z
      .array(RuleProblemSchema)
      .describe('What no longer reads in it, e.g. after a value was renamed. A rule with problems does nothing until they are fixed'),
    nextRunAt: timestamp.nullable(),
    lastRunAt: timestamp.nullable(),
    lastRun: RuleRunSchema.nullable(),
    version: z.number().int().describe('Send as expectedVersion when changing it'),
    createdBy: UserRefSchema.nullable(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .meta({ id: 'Rule' });
export type Rule = z.infer<typeof RuleSchema>;

export const UpdateRuleBody = patchBody(RuleBody)
  .omit({ project: true, kind: true })
  .extend({ expectedVersion: z.number().int().optional().describe('Fail with 409 if the rule changed since this version') });

export const RulePreviewSchema = z
  .object({
    ok: z.boolean().describe('Nothing in it needs fixing'),
    problems: z.array(RuleProblemSchema),
    sentence: z.string(),
    matching: z.number().int().describe('Issues that match its query now'),
    breaking: z
      .number()
      .int()
      .nullable()
      .describe('A guard: issues that match its query now but not what it requires (they were changed before it existed)'),
    sample: z
      .array(
        z.object({
          issue: IssueRefSchema,
          changes: z.array(ChangeSchema),
          errors: z.array(z.string()),
          via: IssueRefSchema.nullable().optional().describe('When the rule acts on related issues: the matching issue this one is related to'),
          told: z.array(UserRefSchema).optional().describe('Whom it would tell about this issue'),
        }),
      )
      .describe('A few of the issues it would act on, with what the command would change on each (a dry run)'),
    note: z.string().describe('What the preview shows, in words'),
  })
  .meta({ id: 'RulePreview' });
export type RulePreview = z.infer<typeof RulePreviewSchema>;

export const RuleCheckBody = z.object({
  project: z.string().nullable(),
  kind: z.enum(RULE_KINDS),
  part: z.enum(['query', 'requires', 'command', 'related']),
  text: z.string().max(2000),
  caret: z.number().int().min(0).optional(),
});
export const RuleCheckResultSchema = z
  .object({ problems: z.array(QueryProblemSchema), description: z.string(), suggestions: z.array(SuggestItemSchema) })
  .meta({ id: 'RuleCheckResult' });

// ---------------------------------------------------------------------------
// Version control
// ---------------------------------------------------------------------------

export const VcsIntegrationSchema = z
  .object({
    id: z.string(),
    provider: z.enum(VCS_PROVIDERS),
    name: z.string(),
    projects: z.array(z.string()).describe('Project keys whose issue ids it looks for; empty: every project'),
    active: z.boolean(),
    webhookUrl: z.string().describe('Where the provider sends its deliveries'),
    secretPrefix: z.string().describe("The secret's first characters, to recognise it by"),
    createdAt: timestamp,
    lastDeliveryAt: timestamp.nullable(),
  })
  .meta({ id: 'VcsIntegration' });
export type VcsIntegration = z.infer<typeof VcsIntegrationSchema>;
export const VcsIntegrationCreatedSchema = VcsIntegrationSchema.extend({
  secret: z.string().describe('The webhook secret (GitHub) or secret token (GitLab). Shown only once'),
}).meta({ id: 'VcsIntegrationCreated' });
export type VcsIntegrationCreated = z.infer<typeof VcsIntegrationCreatedSchema>;
export const VcsIntegrationBody = z.object({
  provider: z.enum(VCS_PROVIDERS),
  name: z.string().min(1).max(120).describe('What it is, e.g. the repository "acme/backend"'),
  projects: z.array(z.string()).max(50).default([]).describe('Project keys whose issue ids to look for; empty for every project'),
  active: z.boolean().default(true),
});
export const UpdateVcsIntegrationBody = z.object({
  name: z.string().min(1).max(120).optional(),
  projects: z.array(z.string()).max(50).optional(),
  active: z.boolean().optional(),
});

export const VcsDeliverySchema = z
  .object({
    id: z.string(),
    deliveryId: z.string().nullable(),
    event: z.string(),
    outcome: z.enum(VCS_DELIVERY_OUTCOMES),
    statusCode: z.number().int(),
    message: z.string(),
    linked: z.number().int().describe('Commits and pull requests linked to issues'),
    applied: z.number().int().describe('Commands from commits that were applied'),
    test: z.boolean(),
    createdAt: timestamp,
  })
  .meta({ id: 'VcsDelivery' });
export type VcsDelivery = z.infer<typeof VcsDeliverySchema>;
export const VcsTestResultSchema = z
  .object({ delivered: z.boolean(), outcome: z.enum(VCS_DELIVERY_OUTCOMES), message: z.string() })
  .meta({ id: 'VcsTestResult' });
export type VcsTestResult = z.infer<typeof VcsTestResultSchema>;

const VcsAuthorSchema = z.object({
  name: z.string().nullable(),
  login: z.string().nullable().describe('Their login with the provider'),
  user: UserRefSchema.nullable().describe('The person in a4a, matched by their verified email'),
});
const VcsSourceSchema = z.object({ id: z.string(), name: z.string(), provider: z.enum(VCS_PROVIDERS) }).nullable();

export const VcsCommitSchema = z
  .object({
    id: z.string(),
    repository: z.string(),
    sha: z.string(),
    title: z.string().describe("The message's first line"),
    body: z.string(),
    url: z.string().nullable(),
    branch: z.string().nullable(),
    author: VcsAuthorSchema,
    at: timestamp.nullable(),
    command: z.string().nullable().describe('The command it gave this issue ("BACK-12 #Fixed" gives "Fixed")'),
    applied: z.boolean().nullable().describe('Whether the command was applied; null when it gave none'),
    note: z.string().nullable().describe('What the command changed, or why it was not applied'),
    integration: VcsSourceSchema,
  })
  .meta({ id: 'VcsCommit' });
export type VcsCommit = z.infer<typeof VcsCommitSchema>;

export const VcsPullRequestSchema = z
  .object({
    id: z.string(),
    repository: z.string(),
    number: z.number().int(),
    title: z.string(),
    url: z.string().nullable(),
    state: z.enum(PULL_REQUEST_STATES),
    branch: z.string().nullable(),
    target: z.string().nullable(),
    author: VcsAuthorSchema,
    at: timestamp.nullable(),
    integration: VcsSourceSchema,
  })
  .meta({ id: 'VcsPullRequest' });
export type VcsPullRequest = z.infer<typeof VcsPullRequestSchema>;

export const IssueVcsSchema = z
  .object({ commits: z.array(VcsCommitSchema), pullRequests: z.array(VcsPullRequestSchema) })
  .meta({ id: 'IssueVcs' });
export type IssueVcs = z.infer<typeof IssueVcsSchema>;

// ---------------------------------------------------------------------------
// OAuth for remote MCP (docs/architecture.md, D28)
// ---------------------------------------------------------------------------

/** What an app may be allowed over OAuth. Never admin: administration reaches every project. */
export const OAUTH_SCOPES = ['read', 'write'] as const;
export type OAuthScope = (typeof OAUTH_SCOPES)[number];

/**
 * An authorization request, as the app put it in the address of a4a's consent page. Every part is
 * optional here: what's missing or wrong is answered in OAuth's words, not as a bad request.
 */
export const OAuthRequestSchema = z
  .object({
    response_type: z.string().max(40).optional(),
    client_id: z.string().max(200).optional(),
    redirect_uri: z.string().max(2000).optional(),
    code_challenge: z.string().max(200).optional(),
    code_challenge_method: z.string().max(20).optional(),
    state: z.string().max(1000).optional(),
    scope: z.string().max(500).optional(),
    resource: z.string().max(2000).optional(),
  })
  .meta({ id: 'OAuthRequest' });
export type OAuthRequest = z.infer<typeof OAuthRequestSchema>;

const OAuthChoiceSchema = z.object({
  scopes: z.array(z.enum(OAUTH_SCOPES)),
  projects: z.array(z.string()).nullable().describe('Keys of the only projects it reaches, or null for every project its person can see'),
});

export const OAuthAuthorizationSchema = z
  .discriminatedUnion('ok', [
    z.object({
      ok: z.literal(true),
      client: z.object({
        id: z.string(),
        name: z.string().nullable().describe('What the app calls itself. It said so when it registered, and a4a can’t check it'),
        redirectUri: z.string().describe('Where the browser goes back with the answer'),
        redirectHost: z.string(),
        local: z.boolean().describe('Whether that is a program on this computer (a loopback address)'),
        registeredAt: timestamp,
      }),
      asked: z.array(z.enum(OAUTH_SCOPES)).describe('What the app asks for; reading always comes with it'),
      canWrite: z.boolean().describe('Whether your role lets you allow changes'),
      remembered: OAuthChoiceSchema.nullable().describe('What you allowed this app before, if you did'),
      ready: z.boolean().describe('It asks for no more than you allowed it before, so it may carry on without asking again'),
    }),
    z.object({
      ok: z.literal(false),
      error: z.string().describe('The OAuth error code, e.g. invalid_request'),
      message: z.string(),
      hint: z.string().optional(),
      redirect: z.string().nullable().describe('Where to send the browser with the error; null when the app can’t be trusted with it'),
    }),
  ])
  .meta({ id: 'OAuthAuthorization' });
export type OAuthAuthorization = z.infer<typeof OAuthAuthorizationSchema>;

export const OAuthDecisionBody = z
  .object({
    request: OAuthRequestSchema,
    allow: z.boolean(),
    scopes: z.array(z.enum(OAUTH_SCOPES)).default(['read']).describe('What you allow, of what it asked for; reading always'),
    projects: z.array(z.string()).nullable().default(null).describe('Keys of the only projects it may reach, or null for every project you can see'),
  })
  .meta({ id: 'OAuthDecision' });
export type OAuthDecision = z.input<typeof OAuthDecisionBody>;

export const OAuthRedirectSchema = z.object({ redirect: z.string().describe('Where the browser goes next: back to the app') }).meta({ id: 'OAuthRedirect' });
export type OAuthRedirect = z.infer<typeof OAuthRedirectSchema>;

/** An app a person allowed, as they see it under Agents and tokens. */
export const OAuthGrantSchema = z
  .object({
    id: z.string(),
    client: z.object({
      id: z.string(),
      name: z.string().nullable().describe('What the app calls itself'),
      redirectHosts: z.array(z.string()).describe('Where it sends people back, by host'),
    }),
    ...OAuthChoiceSchema.shape,
    createdAt: timestamp,
    updatedAt: timestamp,
    lastUsedAt: timestamp.nullable(),
  })
  .meta({ id: 'OAuthGrant' });
export type OAuthGrant = z.infer<typeof OAuthGrantSchema>;

// Days away, and the load grid's window: package 10 (docs/architecture.md, D36)
// ---------------------------------------------------------------------------

/** Why someone is away. Only they, administrators and whoever entered it see which. */
export const ABSENCE_KINDS = ['holiday', 'sick', 'training', 'other'] as const;
export type AbsenceKind = (typeof ABSENCE_KINDS)[number];
export const ABSENCE_HALVES = ['morning', 'afternoon'] as const;
export type AbsenceHalf = (typeof ABSENCE_HALVES)[number];
/** The longest one absence runs, in days: a longer one is entered a year at a time. */
export const MAX_ABSENCE_DAYS = 366;

export const AbsenceSchema = z
  .object({
    id: z.string(),
    user: UserRefSchema,
    from: isoDate,
    to: isoDate.describe('The last day away; the same as from for one day'),
    half: z.enum(ABSENCE_HALVES).nullable().describe('morning or afternoon on a one-day absence; null for whole days'),
    kind: z.enum(ABSENCE_KINDS).nullable().describe('Why: null unless you are the person, an administrator, or entered it'),
    note: z.string().nullable().describe('Shown to the same people as kind'),
    version: z.number().int(),
    createdBy: UserRefSchema.nullable(),
    createdAt: timestamp,
    updatedAt: timestamp,
    canChange: z.boolean().describe('Whether you may change or remove it'),
  })
  .meta({ id: 'Absence' });
export type Absence = z.infer<typeof AbsenceSchema>;

export const AbsenceQuery = z.object({
  user: z.string().optional().describe('Whose days away (a login); yours by default'),
  from: isoDate.optional().describe('Those that end on or after this date; by default a month ago'),
  to: isoDate.optional().describe('Those that start on or before this date'),
});

export const CreateAbsenceBody = z.object({
  user: z.string().optional().describe('Whose (a login); you, by default. For someone else: a manager of a project they work in, or an administrator'),
  from: isoDate,
  to: isoDate.optional().describe('The last day away; from, by default'),
  half: z.enum(ABSENCE_HALVES).nullable().optional().describe('morning or afternoon, for half of one day'),
  kind: z.enum(ABSENCE_KINDS).default('holiday'),
  note: z.string().max(500).optional(),
});
export type CreateAbsenceInput = z.input<typeof CreateAbsenceBody>;

export const UpdateAbsenceBody = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  half: z.enum(ABSENCE_HALVES).nullable().optional(),
  kind: z.enum(ABSENCE_KINDS).optional(),
  note: z.string().max(500).optional(),
  expectedVersion: z.number().int().optional().describe('Refuse (409) if it changed since this version'),
});
export type UpdateAbsenceInput = z.input<typeof UpdateAbsenceBody>;

/** The load grid's window: from today, for two weeks, a month or a quarter, or to the plan's end; or two dates. */
export const LOAD_WINDOW_PRESETS = ['2w', '1m', '3m', 'plan'] as const;
export type LoadWindowPreset = (typeof LOAD_WINDOW_PRESETS)[number];
export const LoadWindowSchema = z
  .union([z.object({ preset: z.enum(LOAD_WINDOW_PRESETS) }), z.object({ from: isoDate, to: isoDate })])
  .meta({ id: 'LoadWindow' });
export type LoadWindow = z.infer<typeof LoadWindowSchema>;

export const PreferencesSchema = z
  .object({ loadWindow: LoadWindowSchema.nullable().describe("The load grid's window, the same on every plan; null for the plan's") })
  .meta({ id: 'Preferences' });
export type Preferences = z.infer<typeof PreferencesSchema>;
export const UpdatePreferencesBody = z.object({ loadWindow: LoadWindowSchema.nullable().optional() });

// Groups (package 1: docs/architecture.md, D27)
// ---------------------------------------------------------------------------

export const GroupRefSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    providerName: z
      .string()
      .nullable()
      .describe('Its name at the identity provider, when it comes from there: who is in it is then set at each sign-in, never by hand'),
    size: z.number().int().describe('How many people are in it'),
  })
  .meta({ id: 'GroupRef' });
export type GroupRef = z.infer<typeof GroupRefSchema>;

export const GroupSchema = GroupRefSchema.extend({
  description: z.string(),
  createdAt: timestamp,
  projects: z.number().int().describe('How many projects give it a role (of those the caller can see)'),
}).meta({ id: 'Group' });
export type Group = z.infer<typeof GroupSchema>;

export const GroupMemberSchema = z
  .object({
    user: UserRefSchema,
    addedAt: timestamp,
    addedBy: UserRefSchema.nullable().describe('Null when the identity provider put them there'),
  })
  .meta({ id: 'GroupMember' });
export type GroupMember = z.infer<typeof GroupMemberSchema>;

export const GroupDetailSchema = GroupSchema.extend({
  members: z.array(GroupMemberSchema),
  roles: z
    .array(z.object({ project: ProjectRefSchema, role: z.enum(PROJECT_ROLES) }))
    .describe('Its role in each project, of those the caller can see'),
}).meta({ id: 'GroupDetail' });
export type GroupDetail = z.infer<typeof GroupDetailSchema>;

export const CreateGroupBody = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).default(''),
  providerName: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .nullable()
    .optional()
    .describe("Its name at the identity provider (the groups claim's or attribute's value), to take who is in it from there"),
});
export const UpdateGroupBody = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().max(500).optional(),
  providerName: z.string().trim().min(1).max(200).nullable().optional(),
});
export const AddGroupMemberBody = z.object({ user: z.string().min(1).describe('Login of the person') });

/** A group with a role in a project. */
export const ProjectGroupSchema = z
  .object({
    group: GroupRefSchema,
    role: z.enum(PROJECT_ROLES),
    people: z.array(UserRefSchema).describe("Who is in it: as anyone who sees a project sees who is in it, so a members-only project's issues go only to them"),
    addedAt: timestamp,
    addedBy: UserRefSchema.nullable(),
  })
  .meta({ id: 'ProjectGroup' });
export type ProjectGroup = z.infer<typeof ProjectGroupSchema>;
export const AddProjectGroupBody = z.object({
  group: z.string().min(1).describe("The group's id or name"),
  role: z.enum(PROJECT_ROLES).default('member'),
});
export const UpdateProjectGroupBody = z.object({ role: z.enum(PROJECT_ROLES) });

// The help desk by email (D30)
// ---------------------------------------------------------------------------

export const HELPDESK_INBOUND_OUTCOMES = ['received', 'request', 'reply', 'ignored', 'refused', 'failed'] as const;
export type HelpdeskInboundOutcome = (typeof HELPDESK_INBOUND_OUTCOMES)[number];

/** A desk's mail, as its managers set it up: its address, where a mail provider posts, and the shared mailbox. */
export const HelpdeskMailSchema = z
  .object({
    address: z.string().nullable().describe("The desk's address, where people write; null until one is set"),
    replyAddress: z
      .string()
      .nullable()
      .describe('What a reply address looks like (the token differs in each email): the mail server must deliver it to the same mailbox'),
    inbound: z
      .object({
        url: z.string().describe('Where a mail provider posts each message, raw, with the secret as the password of HTTP Basic authentication'),
        secretPrefix: z.string().nullable().describe("The secret's first characters; null until one is made"),
      })
      .describe('Mail by webhook'),
    imap: z
      .object({
        configured: z.boolean(),
        server: z.string().nullable().describe("The shared mailbox's server and folder, when HELPDESK_IMAP_URL is set"),
      })
      .describe('Mail read from the shared mailbox'),
    maxBytes: z.number().int().describe('The largest message the desk takes, attachments included'),
  })
  .meta({ id: 'HelpdeskMail' });
export type HelpdeskMail = z.infer<typeof HelpdeskMailSchema>;

export const HelpdeskMailBody = z.object({
  address: z
    .string()
    .trim()
    .max(254)
    .email()
    .nullable()
    .describe("The desk's address, e.g. support@acme.example; null to stop taking mail"),
});

/** A new secret for a desk's mail webhook: shown once. */
export const HelpdeskMailSecretSchema = z
  .object({
    secret: z.string(),
    url: z.string().describe('The webhook address with the secret in it, as most providers take it'),
  })
  .meta({ id: 'HelpdeskMailSecret' });
export type HelpdeskMailSecret = z.infer<typeof HelpdeskMailSecretSchema>;

/** One message that came in for a desk, and what became of it. */
export const HelpdeskInboundSchema = z
  .object({
    id: z.number().int(),
    at: timestamp,
    via: z.enum(['webhook', 'imap']),
    sender: z.string(),
    subject: z.string(),
    outcome: z.enum(HELPDESK_INBOUND_OUTCOMES),
    reason: z.string().describe('Why, in words: "an automatic reply", "sent from an address that isn\'t the requester\'s"'),
    issue: z.string().nullable().describe('The request it filed or answered'),
  })
  .meta({ id: 'HelpdeskInbound' });
export type HelpdeskInbound = z.infer<typeof HelpdeskInboundSchema>;

/** What the inbound webhook answers a mail provider: nothing about any request or person. */
export const HelpdeskInboundAnswerSchema = z
  .object({ outcome: z.enum(HELPDESK_INBOUND_OUTCOMES).or(z.literal('duplicate')), reason: z.string() })
  .meta({ id: 'HelpdeskInboundAnswer' });
export type HelpdeskInboundAnswer = z.infer<typeof HelpdeskInboundAnswerSchema>;

// Agents acting as themselves (D34): accounts of their own with tokens issued to them, assignable,
// and what they changed on their own undone by a person.
// ---------------------------------------------------------------------------

export const AgentAccountSchema = z
  .object({
    agent: UserSchema,
    tokens: z.array(ApiTokenSchema).describe('Its tokens that still work: each lets an agent act as it, never beyond its role'),
  })
  .meta({ id: 'AgentAccount' });
export type AgentAccount = z.infer<typeof AgentAccountSchema>;

export const UndoResultSchema = z
  .object({
    undoes: z.number().int().describe('The event that was undone'),
    issue: IssueRefSchema,
    changes: z.array(ChangeSchema).describe('What the undo put back'),
    events: z.array(EventSchema).describe("The undo's own events, each saying which it undoes (data.undoes)"),
  })
  .meta({ id: 'UndoResult' });
export type UndoResult = z.infer<typeof UndoResultSchema>;
