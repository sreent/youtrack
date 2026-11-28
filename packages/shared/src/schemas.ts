/**
 * API contract shared by the server (validation + OpenAPI), the web UI (types)
 * and the MCP layer. Response schemas carry an OpenAPI component id via `.meta`.
 */
import { z } from 'zod';
import { LOCALES } from './i18n';
import {
  CHANNELS,
  CHAT_CHANGE_KINDS,
  CHAT_PLATFORMS,
  COMMENT_VISIBILITIES,
  DEFAULT_CHAT_KINDS,
  EMAIL_LEVELS,
  EVENT_TYPES,
  FIELD_TYPES,
  HELP_LIMITS,
  PASSKEYS_REQUIRED,
  PORTAL_SIGN_IN_METHODS,
  REQUEST_CC_VIA,
  REQUEST_CCS_CEILING,
  WHITEBOARD_KINDS,
  WHITEBOARD_LIMITS,
  WHITEBOARD_TONES,
  LEVELING_MODES,
  NOTIFICATION_KINDS,
  PLAY_KINDS,
  PROJECT_ROLES,
  PERMISSIONS,
  PROJECT_VISIBILITIES,
  PULL_REQUEST_STATES,
  REACTIONS,
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
  SLA_CLOCK_STATES,
  SLA_STATUSES,
  SLA_TARGETS,
  NOTIFY_KINDS,
  SUBSCRIPTION_EVENTS,
  TRIAGE_MODES,
  UNDO_BY,
  UNDO_STATES,
  WATCH_REASONS,
  VCS_DELIVERY_OUTCOMES,
  VCS_PROVIDERS,
} from './constants';
import { PlanScopeSchema, ViewKindSchema, ViewSettingsSchema } from './views';

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
      key: z.string().optional().describe('The problem in the catalogs, problem.<key>, for a page that says it in its person’s language (D49). The English in message and hint is the same problem.'),
      values: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('What the problem’s words take, by name: a word or a number, another problem ({ key, values }), or a list of them.'),
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
    twoFactor: z.boolean().optional().describe('Their password sign-in asks for a code from an authenticator app too (D38)'),
    passkeys: z.number().int().optional().describe('How many passkeys they sign in with (D62)'),
    passkeysOnly: z.boolean().optional().describe('They have no password: they sign in with passkeys alone (D68)'),
    passkeyExempt: z.boolean().optional().describe('Where passkeys are required, an administrator lets them sign in without one: their password and a code (D68)'),
    passkeySetupUntil: timestamp
      .nullable()
      .optional()
      .describe('Until when the link an administrator sent them to add a passkey works, while it’s unused (D68)'),
    lastSignInAt: timestamp.nullable().optional().describe('When they last signed in, whichever way'),
    provisioned: z.boolean().optional().describe('The identity provider manages this account through SCIM (D38)'),
  })
  .meta({ id: 'SignIn' });
export type SignIn = z.infer<typeof SignInSchema>;

/** Hours on each weekday, Sunday first (D43). */
const workWeek = z.array(z.number().min(0).max(24)).length(7);

export const UserSchema = UserRefSchema.extend({
  email: z.string().nullable(),
  role: z.enum(ROLES),
  banned: z.boolean(),
  hourlyRate: z.number().nullable().describe('Cost rate per hour, used for cost tracking'),
  capacityHoursPerDay: z.number().describe('Working hours per day available for planned work'),
  workWeek: z
    .array(z.number())
    .nullable()
    .describe("Their working week: hours on each weekday, Sunday first. Null: the plan's working days at their capacity"),
  createdAt: timestamp,
  signIn: SignInSchema.optional().describe('How they sign in: only in what administrators get'),
  hrCalendar: z.string().nullable().optional().describe("Their HR calendar's iCal feed (D36's revisit): only in what administrators get"),
}).meta({ id: 'User' });
export type User = z.infer<typeof UserSchema>;

export const MeSchema = UserSchema.extend({
  timeZone: z
    .string()
    .nullable()
    .describe('Your time zone (an IANA name): what "today" means in your searches, when your digest comes, and the times in your email. Null: the server\'s'),
  serverTimeZone: z.string().describe("The server's time zone, which yours falls back to"),
  locale: z.enum(LOCALES).nullable().describe("The language you read a4a in (D49). Null: your browser's on the web, and the server's default in email"),
  defaultLocale: z.enum(LOCALES).describe("The server's default language, for a browser that asks for none a4a speaks"),
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
      ldap: z
        .object({ name: z.string().describe('The directory, by the name people see') })
        .nullable()
        .optional()
        .describe('The login and password form checks passwords against this LDAP directory too (D38)'),
      passkey: z.boolean().optional().describe('People may sign in with a passkey, without a login or password (D62)'),
    }),
    mcpOAuth: z.boolean().describe('Whether MCP clients may sign in with OAuth, instead of carrying a token (D28)'),
  })
  .meta({ id: 'SetupStatus' });
export type SetupStatus = z.infer<typeof SetupStatusSchema>;

export const UpdateMeBody = z.object({
  name: z.string().min(1).max(100).optional(),
  email: z.string().email().nullable().optional(),
  timeZone: z.string().min(1).max(64).nullable().optional().describe("An IANA time zone, such as Europe/Berlin; null for the server's"),
  locale: z.enum(LOCALES).nullable().optional().describe("The language you read a4a in; null for your browser's"),
  workWeek: workWeek.nullable().optional().describe('Hours on each weekday, Sunday first; null for the plan\'s working days'),
  password: z.string().min(8).optional(),
  currentPassword: z.string().optional(),
});

export const CreateUserBody = z.object({
  login: z.string().min(2).max(40).regex(/^[a-zA-Z0-9._-]+$/),
  name: z.string().min(1).max(100),
  email: z.string().email().nullable().optional(),
  password: z.string().min(8).optional().describe('Omit for bot users that only use API tokens'),
  passkeysOnly: z
    .boolean()
    .optional()
    .describe('No password: they sign in with passkeys alone, the first added from a link you send (POST /users/{id}/passkey-setup, D68)'),
  role: z.enum(ROLES).default('member'),
  isBot: z.boolean().default(false),
  hourlyRate: z.number().min(0).nullable().optional(),
  capacityHoursPerDay: z.number().min(0).max(24).optional(),
  workWeek: workWeek.nullable().optional().describe('Hours on each weekday, Sunday first'),
});
export const UpdateUserBody = z.object({
  name: z.string().min(1).max(100).optional(),
  email: z.string().email().nullable().optional(),
  password: z.string().min(8).optional(),
  role: z.enum(ROLES).optional(),
  banned: z.boolean().optional(),
  passkeyExempt: z
    .boolean()
    .optional()
    .describe('Where passkeys are required: let them sign in without one, with their password and a code, for a device that can’t make one (D68)'),
  hourlyRate: z.number().min(0).nullable().optional(),
  capacityHoursPerDay: z.number().min(0).max(24).optional(),
  workWeek: workWeek.nullable().optional().describe('Hours on each weekday, Sunday first; null for the plan\'s working days'),
  hrCalendar: z
    .string()
    .url()
    .nullable()
    .optional()
    .describe("Their HR calendar (D36's revisit): an iCal feed whose days away are filed for them; administrators set it"),
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

const clockTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/, 'Expected a time as HH:MM, from 00:00 to 24:00');

/** A desk's working hours (D45): wall-clock times in its time zone, by day of the week, and holidays off. */
export const BusinessHoursSchema = z
  .object({
    timeZone: z.string().trim().min(1).max(64).describe('An IANA time zone, such as Europe/Berlin: the hours are its wall-clock times'),
    hours: z
      .array(
        z.object({
          day: z.number().int().min(0).max(6).describe('0 = Sunday … 6 = Saturday'),
          from: clockTime,
          to: clockTime.describe('24:00 for the end of the day'),
        }),
      )
      .min(1)
      .max(70),
    holidays: z.array(isoDate).max(400).describe('Days with no working hours, as YYYY-MM-DD in the time zone'),
  })
  .meta({ id: 'BusinessHours' });
export type BusinessHours = z.infer<typeof BusinessHoursSchema>;

/** How a desk's requesters sign in to the portal (D63): today's emailed link, a password, identity providers, or several. */
export const HelpdeskSignInSchema = z
  .object({
    link: z.boolean().describe('A link emailed to them each time, good once for 20 minutes (D45): the default'),
    password: z.boolean().describe('A password they set by a link sent to their email, and change on the portal'),
    providers: z
      .array(z.string().trim().min(1).max(40))
      .max(10)
      .describe('The ids of identity providers for requesters (administrators add them at /portal-providers) they may sign in through'),
    passkey: z
      .boolean()
      .optional()
      .describe('A passkey they add on the portal (D69), in place of the link or the password; never the only way. Left out, the desk keeps what it had'),
  })
  .meta({ id: 'HelpdeskSignIn' });
export type HelpdeskSignIn = z.infer<typeof HelpdeskSignInSchema>;

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
    businessHours: BusinessHoursSchema.nullable().describe("The hours SLA targets count in (D45); null counts every hour"),
    waitingStates: z
      .array(z.string().trim().min(1).max(100))
      .max(20)
      .describe("States in which a request waits on its requester: its SLA clocks pause until they answer (D45)"),
    resumeState: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .nullable()
      .describe("The state a requester's answer moves a waiting request to; null leaves its state as it is"),
    signIn: HelpdeskSignInSchema.describe("How its requesters sign in to the portal (D63), one way at least. A session opens a desk's requests only when it was opened in a way the desk takes"),
    ccsMax: z
      .number()
      .int()
      .min(1)
      .max(REQUEST_CCS_CEILING)
      .describe(`The most people copied on one of its requests at once (D67), 20 unless its managers say otherwise, at most ${REQUEST_CCS_CEILING}. Lowering it takes no one off: it stops new copies past it`),
    ccsConfirm: z
      .boolean()
      .describe("A new request by email whose sender a4a can't trust (no DMARC pass from a mail server the administrator names) has its Cc held until its requester confirms it, by a link in the acknowledgement or on the portal (D67). On by default. Turned off, every new request's Cc is copied at once, and those already held stay held"),
    ccsRelay: z
      .boolean()
      .describe("Everyone on a request (its requester, the people copied on it, and colleagues of its customer group who answered it) is emailed each other's public words, where a4a can trust who wrote them: on the portal, signed in, or by email that passed DMARC at a mail server the administrator names (D67). Off by default"),
  })
  .meta({ id: 'HelpdeskSettings' });
export type HelpdeskSettings = z.infer<typeof HelpdeskSettingsSchema>;

export const TimeSettingsSchema = z
  .object({
    workTypeRequired: z.boolean().describe('Whether work logged in the project must say its type (D43)'),
  timesheetEnabled: z.boolean().optional().describe("Whether the project's logged work shows in its people's weekly timesheets (D43's revisit): yes by default; no hides it from the sheet, and its cells refuse"),
  timesheetApproval: z
    .enum(['every', 'any'])
    .optional()
    .describe("Who approves a week of time that holds this project's work (D43's revisit): 'every', its managers among the managers of every project the week holds work in (the default); 'any', a manager of any project the week holds work in"),
  })
  .meta({ id: 'TimeSettings' });
export type TimeSettings = z.infer<typeof TimeSettingsSchema>;

export const ProjectSettingsSchema = z
  .object({
    triageMode: z.enum(TRIAGE_MODES),
    requirePasskeys: z.boolean().describe('Whether people who can access this project owe a passkey when a4a’s own password signs them in (D70)'),
    plan: PlanSettingsSchema,
    helpdesk: HelpdeskSettingsSchema,
    time: TimeSettingsSchema,
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
    role: z.string().describe("Their role in it, as it works out: a built-in role's id (viewer, member, manager) or a custom role's; a manager for administrators and the lead"),
    roleName: z.string().describe("The role's name, to show"),
    via: z
      .enum(['admin', 'lead', 'member', 'group', 'open', 'guest', 'app'])
      .describe('Where the role comes from: being an administrator, leading it, being one of its people, being in a group it gives the role, its being open, its being readable without signing in, or an app that runs there granting it (D48)'),
    group: z.string().nullable().optional().describe('With `via: group`, the group the role comes from (the first by name, when several give it)'),
    permissions: z.array(z.enum(PERMISSIONS)).describe('What they may do in it (D37), as far as their account or token allows'),
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
  settings: ProjectSettingsSchema.describe("Its settings; the plan's budget is null for a reader without the costs permission, a guest among them (D64)"),
  issueCount: z.number().int(),
  openIssueCount: z.number().int(),
  createdAt: timestamp,
  access: ProjectAccessSchema,
  guestAccess: z.boolean().describe("Anyone may read it without signing in (D37): its issues, comments, files and articles, never its people's emails"),
  formerKeys: z.array(z.string()).describe('Keys it had before it was renamed, oldest first (D52): each still finds it, and its issues by their numbers'),
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
  guestAccess: z.boolean().optional().describe('Let anyone read it without signing in (administrators only)'),
  settings: z
    .object({
      triageMode: z.enum(TRIAGE_MODES).optional(),
      requirePasskeys: z.boolean().optional().describe('Require a passkey of everyone who can access this project (D70)'),
      plan: PlanSettingsSchema.partial().optional(),
      helpdesk: HelpdeskSettingsSchema.partial()
        .extend({
          organizations: z
            .array(z.string().max(255))
            .max(50)
            .optional()
            .describe('Gone: email domains are customer groups now (D56), at /projects/{key}/customer-groups. Given any, the answer is 400 and says so'),
        })
        .optional(),
      time: TimeSettingsSchema.partial().optional(),
    })
    .optional(),
});

/** Someone with a role in a project. */
export const ProjectMemberSchema = z
  .object({
    user: UserRefSchema,
    role: z.string().describe("The role's id: viewer, member, manager, or a custom role's"),
    roleName: z.string(),
    lead: z.boolean().describe('They lead the project, which makes them a manager of it whatever their role here'),
    addedAt: timestamp.nullable().describe('Null for a lead who was never added by hand'),
    addedBy: UserRefSchema.nullable(),
  })
  .meta({ id: 'ProjectMember' });
export type ProjectMember = z.infer<typeof ProjectMemberSchema>;
export const AddMemberBody = z.object({
  user: z.string().min(1).describe('Login of the person or bot'),
  role: z.string().min(1).default('member').describe("A role's id or name: viewer, member, manager, or a custom role (D37)"),
});
export const UpdateMemberBody = z.object({ role: z.string().min(1).describe("A role's id or name") });

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
    owner: UserRefSchema.nullable().describe("An owned field's value: who owns it, and is assigned an issue given it while it has nobody (D41)"),
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
    condition: z
      .string()
      .nullable()
      .describe('A query: the field shows, and is required if it is, only while the issue matches it (D41). Null: always'),
    private: z
      .boolean()
      .describe("Seen only by people who may read the project's private fields, and changed only by those who may change them (D50)"),
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
        owner: z.string().optional().describe("An owned field's value: its owner's login"),
      }),
    )
    .default([]),
});
export const UpdateFieldBody = z.object({
  name: z.string().min(1).max(60).optional(),
  description: z.string().max(1000).optional(),
  type: z
    .enum(['enum', 'owned'])
    .optional()
    .describe('An enum field becomes an owned one, or back: its values and the issues keep theirs (D41)'),
});
export const FieldValueBody = z.object({
  name: z.string().min(1).max(80),
  tone: ToneSchema.optional(),
  isResolved: z.boolean().optional(),
  description: z.string().optional(),
  ordinal: z.number().int().optional(),
  archived: z.boolean().optional(),
  project: z.string().nullable().optional().describe('Project key to scope the value to one project'),
  owner: z.string().nullable().optional().describe("An owned field's value: its owner's login, or null for nobody"),
});
export const AttachFieldBody = z.object({
  required: z.boolean().default(false),
  ordinal: z.number().int().optional(),
  defaultValue: z.unknown().nullable().optional(),
  condition: z
    .string()
    .max(2000)
    .nullable()
    .optional()
    .describe('A query: the field shows, and is required if it is, only while the issue matches it, e.g. "State: Fixed". Null: always'),
  private: z
    .boolean()
    .optional()
    .describe("Seen only by people who may read the project's private fields (D50). Left as it is unless given"),
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
    owner: UserRefSchema.nullable().optional().describe("An owned field's value: who owns it"),
  })
  .meta({ id: 'OptionValue' });
export type OptionValue = z.infer<typeof OptionValueSchema>;

export const PeriodValueSchema = z
  .object({ minutes: z.number().int(), presentation: z.string() })
  .meta({ id: 'PeriodValue' });
export type PeriodValue = z.infer<typeof PeriodValueSchema>;

/** A group as a field's value (D41). */
export const GroupValueSchema = z.object({ id: z.string(), name: z.string() }).meta({ id: 'GroupValue' });
export type GroupValue = z.infer<typeof GroupValueSchema>;

export const IssueFieldValueSchema = z.union([
  z.null(),
  OptionValueSchema,
  UserRefSchema,
  GroupValueSchema,
  PeriodValueSchema,
  z.string().describe('Text; a date as YYYY-MM-DD; a date and time as an ISO 8601 instant'),
  z.number(),
  z.array(OptionValueSchema),
  z.array(UserRefSchema),
  z.array(GroupValueSchema),
]);
export type IssueFieldValue = z.infer<typeof IssueFieldValueSchema>;

export const IssueFieldSchema = z
  .object({
    fieldId: z.string(),
    name: z.string(),
    type: z.enum(FIELD_TYPES),
    multi: z.boolean(),
    value: IssueFieldValueSchema,
    applies: z
      .boolean()
      .optional()
      .describe("Whether a conditional field's condition holds for the issue now (D41); absent for a field with none"),
    private: z
      .boolean()
      .optional()
      .describe('Private in its project (D50): only people who may read its private fields get it at all. Absent for a field everyone sees'),
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

/** Who besides the usual few may see an issue or a comment that is limited (D37). */
export const VisibleToSchema = z
  .object({
    users: z.array(UserRefSchema),
    groups: z.array(z.object({ id: z.string(), name: z.string() })),
  })
  .meta({ id: 'VisibleTo' });
export type VisibleTo = z.infer<typeof VisibleToSchema>;
export const VisibleToInput = z
  .object({
    users: z.array(z.string().min(1)).max(100).default([]).describe('Logins'),
    groups: z.array(z.string().min(1)).max(100).default([]).describe("Groups' ids or names"),
  })
  .describe(
    "Limit it to these people and groups. Its reporter, its assignee, the project's managers and administrators still see it (a comment: its author, the project's managers and administrators)",
  );
export type VisibleToInput = z.input<typeof VisibleToInput>;

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
    votes: z.number().int().describe('How many people voted for it (D41)'),
    limited: z.boolean().describe('Limited to some people and groups (D37)'),
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

/** One reaction on a comment or a description, and who gave it (D41). */
export const ReactionSummarySchema = z
  .object({
    emoji: z.enum(REACTIONS),
    count: z.number().int(),
    mine: z.boolean().describe('Whether the caller gave it'),
    people: z.array(UserRefSchema).describe('Who gave it, the first ten'),
  })
  .meta({ id: 'ReactionSummary' });
export type ReactionSummary = z.infer<typeof ReactionSummarySchema>;

/** Where an issue made from a Teams or Slack message came from (D60): kept as data, so each reader's page words it. */
export const ChatIssueSourceSchema = z
  .object({
    platform: z.enum(CHAT_PLATFORMS),
    workspace: z.string().describe('The Slack workspace, or the Teams team, as it was named then'),
    channel: z.string().describe('The channel, as it was named then: "#eng", "General"'),
    url: z.string().nullable().describe("A link to the message in the chat (Slack's permalink, Teams' message link), for those who may read it there"),
    author: z.string().describe('Who sent the message, as the chat named them'),
    sentAt: timestamp.nullable().describe('When they sent it'),
    replies: z.number().int().describe('Replies from its thread brought into the description'),
    files: z.array(z.object({ name: z.string(), url: z.string().nullable() })).describe('Files in the message, linked where the chat keeps them (the first ten); never copied'),
    moreFiles: z.number().int().describe('Files beyond those ten'),
    cut: z.boolean().describe('The message, or its replies, were cut to fit'),
  })
  .meta({ id: 'ChatIssueSource' });
export type ChatIssueSource = z.infer<typeof ChatIssueSourceSchema>;

export const IssueDetailSchema = IssueSchema.extend({
  description: z.string(),
  source: ChatIssueSourceSchema.nullable().describe('Where it came from, when it was made from a chat message (D60); shown to whoever sees the issue'),
  visibleTo: VisibleToSchema.nullable().describe("Null: everyone who sees its project sees it. Otherwise only these, besides its reporter, its assignee, the project's managers and administrators"),
  updatedBy: UserRefSchema.nullable(),
  links: z.array(IssueLinkSchema),
  parent: IssueRefSchema.nullable(),
  subtasks: z.array(IssueRefSchema),
  spentMinutes: z.number().int(),
  pendingSuggestions: z.number().int(),
  voted: z.boolean().describe('Whether the caller voted for it'),
  reactions: z.array(ReactionSummarySchema).describe('Reactions to its description'),
  descriptionAiDrafted: z.boolean().describe('Its saved description came from an accepted suggestion (D59); said beside it, cleared by an edit that does not say so'),
  formerIds: z.array(z.string()).describe('Ids it had before it moved: each still finds it (D41)'),
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
  visibleTo: VisibleToInput.nullable().optional(),
  parent: z.string().optional().describe('Readable id of the parent issue (creates a subtask link)'),
  links: z
    .array(z.object({ relation: z.string().describe('e.g. "depends on", "relates to"'), issue: z.string() }))
    .optional(),
});
/** What callers send (defaults not yet applied). */
export type CreateIssueInput = z.input<typeof CreateIssueBody>;

/**
 * Where a person made a change (D72): the view, and the change it is part of when one gesture made
 * several, so they undo as one (D34's revisit). Only its author undoes it, for 30 days.
 */
export const ViewEditSchema = z
  .strictObject({
    name: ViewKindSchema,
    group: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,64}$/, 'Letters, digits, - and _, at most 64')
      .optional()
      .describe(
        'Ties this change to others of yours sent with the same group, so one undo puts them all back. Left out, a request that makes several changes (a command on several issues) makes them one group itself',
      ),
  })
  .describe("The view a person made the change in, so they can undo it (POST /events/{id}/undo, theirs alone, for 30 days); agents don't send it")
  .meta({ id: 'ViewEdit' });
export type ViewEdit = z.infer<typeof ViewEditSchema>;

/** What undoes a change made in a view: an event to undo (POST /events/{event}/undo), and its group when it is one of several. */
export const ViewUndoSchema = z
  .object({
    event: z.number().int().describe('The change, by its event: POST /events/{event}/undo undoes it, with the rest of its group'),
    group: z.string().optional().describe('The change it is part of, when the request made several (or was sent with a group): undone all at once, or not at all'),
  })
  .meta({ id: 'ViewUndo' });
export type ViewUndo = z.infer<typeof ViewUndoSchema>;

export const UpdateIssueBody = z.object({
  summary: z.string().min(1).max(500).optional(),
  description: z.string().max(100_000).optional(),
  fields: FieldsInput.optional(),
  addTags: z.array(z.string()).optional(),
  removeTags: z.array(z.string()).optional(),
  expectedVersion: z.number().int().optional().describe('Fail with 409 if the issue changed since this version'),
  descriptionAiDrafted: z.boolean().optional().describe('True when the saved description came from an accepted suggestion (D59); an edit that does not say so clears the mark'),
  view: ViewEditSchema.optional(),
});
export type UpdateIssueInput = z.infer<typeof UpdateIssueBody>;

/** PATCH /issues/{id}'s answer: the issue, and, for a change made in a view, what undoes it. */
export const IssueUpdatedSchema = IssueDetailSchema.extend({
  undo: ViewUndoSchema.optional().describe('Sent with `view`, and something changed: what undoes it'),
}).meta({ id: 'IssueUpdated' });
export type IssueUpdated = z.infer<typeof IssueUpdatedSchema>;

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
    version: z.number().int().describe('Raised by every edit: send it back as expectedVersion to refuse an edit made meanwhile'),
    visibility: z
      .enum(COMMENT_VISIBILITIES)
      .describe('internal: the team alone. public: also the requester of a help desk request, who is emailed it'),
    requester: z
      .object({
        name: z.string(),
        as: z
          .enum(['requester', 'copied', 'colleague'])
          .describe('As whom they wrote: its requester, someone copied on the request (D57), or someone of its customer group (D56)'),
      })
      .nullable()
      .describe('Set when someone outside the team wrote it: the requester of a help desk request, someone copied on it, or someone of its customer group, on a page or by email'),
    visibleTo: VisibleToSchema.nullable().describe("Null: everyone who sees the issue sees it. Otherwise only these, besides its author, the project's managers and administrators"),
    reactions: z.array(ReactionSummarySchema),
    aiDrafted: z.boolean().describe('Its saved words came from an accepted suggestion (D59); said beside them, cleared by an edit that does not say so'),
  })
  .meta({ id: 'Comment' });
export type Comment = z.infer<typeof CommentSchema>;
export const CommentBody = z.object({
  text: z.string().min(1).max(50_000),
  aiDrafted: z.boolean().optional().describe('True when the saved words came from an accepted suggestion (D59); an edit that does not say so clears the mark'),
});
export const NewCommentBody = CommentBody.extend({
  visibility: z
    .enum(COMMENT_VISIBILITIES)
    .default('internal')
    .describe('public sends it to the requester of a help desk request, by email and on their tracking page; only requests take it'),
  visibleTo: VisibleToInput.nullable().optional(),
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
  view: ViewEditSchema.optional(),
});

/** POST /issues/{id}/links' answer: the issue's links, the one just made carrying what undoes it when it was made in a view. */
export const LinkMadeSchema = IssueLinkSchema.extend({
  undo: ViewUndoSchema.optional().describe('On the link just made, when it was made in a view: what undoes it'),
}).meta({ id: 'LinkMade' });

/** DELETE /links/{id} in a view: where it was taken away (query parameters, as a DELETE has no body). */
export const LinkRemovedQuery = z.object({
  view: ViewKindSchema.optional().describe('The view it was taken away in, so you can undo it (yourself alone, for 30 days); the answer is then 200, with what undoes it'),
  group: ViewEditSchema.shape.group,
});
export const LinkRemovedSchema = z.object({ undo: ViewUndoSchema.optional() }).meta({ id: 'LinkRemoved' });

export const WorkItemSchema = z
  .object({
    id: z.string(),
    issueId: z.string().nullable().describe('The readable id, or null on their own row (D43\'s revisit)'),
    activity: z.string().nullable().describe("Their own row's name (D43's revisit), or null on an issue's work"),
    author: UserRefSchema.nullable(),
    date: isoDate,
    minutes: z.number().int(),
    description: z.string(),
    hourlyRate: z.number().nullable().describe('Cost rate snapshot at the time the work was logged'),
    type: z.object({ id: z.string(), name: z.string() }).nullable().describe('What kind of work it was (D43)'),
    createdAt: timestamp,
  })
  .meta({ id: 'WorkItem' });
export type WorkItem = z.infer<typeof WorkItemSchema>;
export const WorkItemBody = z.object({
  duration: z.union([z.string(), z.number()]).describe('"1h 30m", "2d" or minutes'),
  date: isoDate.optional(),
  description: z.string().max(5000).default(''),
  author: z.string().optional().describe('Login; admins can log work for others'),
  type: z.string().nullable().optional().describe("The work type's name or id, from the project's list"),
});

export const TagBody = z.object({ name: z.string().min(1).max(60) });

// Activity & events ---------------------------------------------------------

export const ChangeSchema = z
  .object({
    field: z.string(),
    from: z.string().nullable(),
    to: z.string().nullable(),
    fromList: z
      .array(z.string())
      .optional()
      .describe('A multi-value field’s or the tags’ values before, each, where there were several: from joins them with ", ", and a page joins them as its language does (D49)'),
    toList: z.array(z.string()).optional().describe('Their values after, each, where there are several: to joins them with ", "'),
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
        noteWords: z
          .array(z.object({ key: z.string(), values: z.record(z.string(), z.unknown()).optional() }))
          .optional()
          .describe("The note as a page says it, in its person's language (D49): each reason's key under problem.* and its values"),
        group: z
          .string()
          .optional()
          .describe('The change it is part of, when that change was several (a move and the successors it took along, D72): undoing one undoes them all, or none'),
        by: z
          .enum(UNDO_BY)
          .optional()
          .describe("Who may undo it: anyone who may change the issue, for an agent's change on its own (D34); only its author, for a person's edit in a view (D72)"),
        others: z
          .array(z.string())
          .optional()
          .describe('With `group`: the other issues its undo puts back too, by readable id, those the reader sees now'),
      })
      .optional()
      .describe(
        "Only in an issue's history: on a change an agent made on its own, for anyone who may change the issue; on a person's edit in a view, for that person alone (D34). Whether it can still be undone (POST /events/{id}/undo)",
      ),
  })
  .meta({ id: 'Event' });
export type TrackerEvent = z.infer<typeof EventSchema>;

// Search & commands ---------------------------------------------------------

/**
 * A list among a problem's words (D49): its items, joined as the reader's language joins things one
 * after another (", ", 「、」), as the API's English joins them; or `{ and }` and `{ or }`, joined by
 * the language's list with its word ("Priority and Importance", "Priority e Importancia").
 */
export const ListSaidSchema = z.union([z.array(z.string()), z.object({ and: z.array(z.string()) }), z.object({ or: z.array(z.string()) })]).meta({ id: 'ListSaid' });

export const QueryProblemSchema = z
  .object({
    message: z.string(),
    start: z.number().int(),
    end: z.number().int(),
    hint: z.string().optional(),
    fix: z.string().optional().describe('Text that fixes it, to put in place of start..end'),
    key: z.string().optional().describe('The problem in the catalogs, problem.<key>, for a page that says it in its person’s language (D49). The English in message and hint is the same problem.'),
    values: z.record(z.string(), z.union([z.string(), z.number(), ListSaidSchema])).optional().describe('What the problem’s words take, by name: a word, a number or a list.'),
  })
  .meta({ id: 'QueryProblem' });
export type QueryProblem = z.infer<typeof QueryProblemSchema>;

export const QueryExplainedSchema = z
  .object({
    body: z.string().describe('What the query asks: "in project BACK, unresolved". Empty when it asks nothing.'),
    sort: z.string().describe('How it sorts, worded to follow body: " sorted by Priority". Empty when it doesn’t say.'),
    zone: z.string().nullable().describe('The time zone its dates are read in, when it reads any.'),
  })
  .describe('The explanation in pieces, in its language, for a page that says how many issues it found: "4 issues in project BACK" (D49).')
  .meta({ id: 'QueryExplained' });
export type QueryExplained = z.infer<typeof QueryExplainedSchema>;

export const ParseQueryResultSchema = z
  .object({
    ok: z.boolean(),
    problems: z.array(QueryProblemSchema),
    explanation: z.string().describe('Plain-English reading of the query'),
    explained: QueryExplainedSchema,
  })
  .meta({ id: 'ParseQueryResult' });
export type ParseQueryResult = z.infer<typeof ParseQueryResultSchema>;

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
  view: ViewEditSchema.optional().describe(
    'The view it was run in (on the issues list, `list`): then it changes every issue or none, in one transaction, as one group its author can undo (POST /events/{id}/undo)',
  ),
});
/**
 * A problem's words, for a page to say it in its person's language (D49): its key under problem.* in
 * the catalogs and the values it takes. Beside English a program reads, such as a list of errors.
 */
export const ProblemWordsSchema = z
  .object({
    key: z.string().describe('The problem in the catalogs, problem.<key>'),
    values: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('What its words take, by name: a word or a number, another problem ({ key, values }), or a list of them'),
  })
  .meta({ id: 'ProblemWords' });
export type ProblemWords = z.infer<typeof ProblemWordsSchema>;

/** A note's words in the catalogs, beside its English: a key and its values (D49). */
export const NoteSaidSchema = z
  .object({
    key: z.string().describe('The message: builds.note.<what>, vcs.why.<what>, rules.run.<what>, or problem.<key> for one a page says as a problem'),
    values: z.record(z.string(), z.unknown()).optional().describe('What its words take, by name; a problem among them is a { key, values } of its own'),
  })
  .describe('The note in the catalogs, for a page that says it in its person’s language (D49). Null where the note is null, and where it was recorded before a4a kept its words; note is the same in English.')
  .meta({ id: 'NoteSaid' });
export type NoteSaid = z.infer<typeof NoteSaidSchema>;

export const CommandIssueResultSchema = z
  .object({
    issue: z.string(),
    changes: z.array(ChangeSchema),
    errors: z.array(z.string()),
    errorWords: z
      .array(ProblemWordsSchema)
      .optional()
      .describe("Each of errors as a page says it, in its person's language, in the same order (D49). The English in errors is the same"),
  })
  .meta({ id: 'CommandIssueResult' });
export const CommandResultSchema = z
  .object({
    applied: z.boolean(),
    problems: z.array(QueryProblemSchema),
    results: z.array(CommandIssueResultSchema),
    undo: ViewUndoSchema.optional().describe('Run with `view`, and something changed: what undoes it, every issue at once'),
  })
  .meta({ id: 'CommandResult' });
export type CommandResult = z.infer<typeof CommandResultSchema>;

export const SavedSearchSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    query: z.string(),
    shared: z.boolean(),
    owner: UserRefSchema.nullable().describe('Who keeps it; null once they were deleted: a shared search outlives its owner, for an administrator to adopt (D72)'),
    view: ViewSettingsSchema.describe('How it is shown: the view it opens in, its grouping and each view’s settings (D72); a list until someone chooses otherwise'),
    version: z.number().int().describe('Counts changes to it: send it back as expectedVersion, so a change made since isn’t overwritten (D72)'),
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
    query: z.string().nullable().describe("Which issues it shows; left out (null) for someone who doesn't see every project on it when it names something they can't see (D64)"),
    backlogQuery: z.string().nullable().describe('What its backlog holds; null: #Unresolved, or left out, as its query is (D64)'),
    pointsField: z.string().nullable().describe('The field its story points are in'),
    sprintsEnabled: z.boolean(),
    laneOrder: z
      .boolean()
      .describe("Whether each swimlane keeps its own order (D65): cards are ranked among their lane's cards, and the backlog keeps the board's order. Off: one order for the board, its lanes included (D53)"),
    manageable: z.boolean().describe("Whether you may change the board's settings: you manage boards in every project on it"),
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
  backlogQuery: z.string().max(1000).nullable().optional().describe('What its backlog holds; #Unresolved by default'),
  pointsField: z.string().nullable().optional().describe('A number or period field to sum as story points'),
  sprintsEnabled: z.boolean().default(false),
  laneOrder: z
    .boolean()
    .optional()
    .describe("Whether each swimlane keeps its own order (D65), off by default. Turning it off keeps the lanes' places for when it's on again; choosing another swimlane field forgets them"),
});

export const BoardViewSchema = z
  .object({
    board: BoardSchema,
    sprint: SprintSchema.nullable(),
    sprints: z.array(SprintSchema),
    columns: z.array(
      BoardColumnSchema.extend({
        issues: z.array(IssueSchema),
        count: z.number().int(),
        points: z.number().nullable().describe('Story points of the issues shown; null without a points field'),
      }),
    ),
    points: z.number().nullable().describe('Story points of every issue shown; null without a points field'),
    swimlanes: z.array(z.string()).describe('Swimlane values in display order (empty when no swimlane field)'),
    order: z
      .array(z.string())
      .describe(
        "Every card's id in the order the board shows them (D43, D53): ranked first, then the rest in the query's order. Each column and lane shows its cards in it. Where lanes keep their own order (D65), each lane's cards are in the lane's order among themselves: placed in the lane first, then the rest in the board's order",
      ),
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

/** An authenticator's model, as FIDO's metadata names it: a UUID. */
const aaguid = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'an AAGUID, such as cb69481e-8ff7-4039-93ec-0a2729a154a8');

export const SettingsSchema = z
  .object({
    instanceName: z.string(),
    defaultTriageMode: z.enum(TRIAGE_MODES),
    publicUrl: z.string(),
    requireTwoFactor: z
      .boolean()
      .optional()
      .describe('Every sign-in with a password asks for a code from an authenticator app, and someone without one sets it up first (D38)'),
    passkeys: z.boolean().optional().describe('People may add passkeys and sign in with them (D62). Off, passkeys sign nobody in, and are kept'),
    requirePasskeys: z
      .enum(PASSKEYS_REQUIRED)
      .optional()
      .describe('Whose password sign-in owes a passkey (D68): nobody (off), everyone, or administrators. Someone without one adds one as they sign in'),
    passkeyAuthenticators: z
      .array(z.string())
      .nullable()
      .optional()
      .describe('The only authenticators new passkeys may come from, by AAGUID, checked against FIDO’s metadata (D68); null for any'),
  })
  .meta({ id: 'Settings' });
export type Settings = z.infer<typeof SettingsSchema>;
export const SettingsBody = z.object({
  instanceName: z.string().min(1).max(80).optional(),
  defaultTriageMode: z.enum(TRIAGE_MODES).optional(),
  requireTwoFactor: z.boolean().optional(),
  passkeys: z.boolean().optional(),
  requirePasskeys: z.enum(PASSKEYS_REQUIRED).optional(),
  passkeyAuthenticators: z.array(aaguid).max(100).nullable().optional(),
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
    plannedCost: z.number().nullable().describe('Null for a reader without the costs permission, a guest among them (D64)'),
    actualCost: z.number().nullable().describe('Null for a reader without the costs permission (D64)'),
    baseline: z
      .object({ start: isoDate, finish: isoDate, effortMinutes: z.number().int(), cost: z.number().nullable() })
      .nullable(),
    variance: z
      .object({ startDays: z.number(), finishDays: z.number(), effortMinutes: z.number().int(), cost: z.number().nullable() })
      .nullable(),
  })
  .meta({ id: 'ScheduleTask' });
export type ScheduleTask = z.infer<typeof ScheduleTaskSchema>;

export const ScheduleSchema = z
  .object({
    project: ProjectRefSchema,
    calendar: PlanSettingsSchema.describe("The plan's calendar; its budget is null for a reader without the costs permission, a guest among them (D64)"),
    start: isoDate,
    finish: isoDate,
    today: isoDate,
    criticalPath: z.array(z.string()),
    tasks: z.array(ScheduleTaskSchema),
    warnings: z.array(z.string()),
    baseline: z
      .object({ id: z.string(), name: z.string(), finish: isoDate, finishVarianceDays: z.number() })
      .nullable(),
    away: z
      .array(z.object({ assignee: z.string().describe('Login'), days: z.array(z.object({ date: isoDate, part: z.enum(['day', 'morning', 'afternoon']) })) }))
      .describe("Assignees' days away between the plan's start and finish, drawn on the Gantt (D36, D43); none for a guest, who reaches no people (D64)"),
  })
  .meta({ id: 'Schedule' });
export type Schedule = z.infer<typeof ScheduleSchema>;

/** The roles a field plays in a plan (D72): what people set, each in a field of the task's own project. */
export const PLAN_SET_ROLES = ['start', 'end', 'duration', 'estimate'] as const;
export type PlanSetRole = (typeof PLAN_SET_ROLES)[number];

/** A value someone set, and the field it's in (D72): what a timeline's or a table's cell writes back. */
export const PlanSetValueSchema = z
  .object({
    field: z.string().describe('The field, by name: the one its project plans this role from (Start date, Due date, Estimation …)'),
    value: z
      .union([z.string(), z.number()])
      .nullable()
      .describe('As the field holds it: a date as YYYY-MM-DD, a period in minutes, a number as it is; null when the issue has none'),
  })
  .meta({ id: 'PlanSetValue' });
export type PlanSetValue = z.infer<typeof PlanSetValueSchema>;

/** A task of a plan of a search (D72): today's task, and what it is in a plan across projects. */
export const PlanTaskSchema = ScheduleTaskSchema.extend({
  project: z.string().optional().describe("Its project, by key: one of the plan's projects"),
  calendar: z.string().optional().describe("The calendar its dates are planned on, by its id in the plan's calendars: its project's"),
  editable: z.boolean().optional().describe('Whether the reader may change it, as on its own page: the edit permission in its project, and its fields not kept from them'),
  set: z
    .object({
      start: PlanSetValueSchema.nullable(),
      end: PlanSetValueSchema.nullable(),
      duration: PlanSetValueSchema.nullable(),
      estimate: PlanSetValueSchema.nullable(),
    })
    .optional()
    .describe("The dates and the work people set, beside the dates the engine plans (D10): each role's field and value, null where its project plans that role from no field"),
}).meta({ id: 'PlanTask' });
export type PlanTask = z.infer<typeof PlanTaskSchema>;

/**
 * A plan of a search (D72): today's schedule, and what a plan across projects adds to it. Every field it
 * adds is optional, so a project's schedule, as it is today, is one too.
 */
export const PlanScheduleSchema = ScheduleSchema.extend({
  tasks: z.array(PlanTaskSchema),
  scope: PlanScopeSchema.optional().describe('What the plan was read from'),
  projects: z
    .array(z.object({ key: z.string(), name: z.string(), calendar: z.string().describe("Its calendar, by id in calendars") }))
    .optional()
    .describe('The projects its tasks are in, each with its own calendar'),
  calendars: z
    .record(z.string(), PlanSettingsSchema)
    .optional()
    .describe('Each calendar the plan is planned on, by id; budgets are null for a reader without the costs permission (D64)'),
  total: z.number().int().optional().describe('How many issues the scope holds, though the plan may hold fewer (truncated)'),
  truncated: z
    .boolean()
    .optional()
    .describe('The scope holds more issues than a plan does (2,000), so it holds the first, by project and number: narrow the search to plan the rest'),
}).meta({ id: 'PlanSchedule' });
export type PlanSchedule = z.infer<typeof PlanScheduleSchema>;

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
    explained: QueryExplainedSchema.describe('How a4a itself reads the query, in pieces, as /search/parse gives them'),
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
  .object({
    summary: z.string().describe('Markdown. Shown, never saved, unless someone posts it as a comment'),
    language: z.enum(LOCALES).describe("The language it's written in: the reader's (D49)"),
    partial: z.boolean().describe('The thread was too long to read whole: it is of the description and the latest comments'),
    post: z
      .string()
      .nullable()
      .describe(
        "Posts it as a comment, as the assistant's, within an hour (POST /issues/{id}/summary/comment). Null when it read a comment only some people see, which a comment for everyone mustn't carry",
      ),
    model: z.string(),
  })
  .meta({ id: 'SummarizeResult' });
export type SummarizeResult = z.infer<typeof SummarizeResultSchema>;

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
    whiteboard: z.string().nullable().describe('The whiteboard whose picture it is, if any (D58\'s revisit)'),
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
    childCount: z.number().int().describe('The articles under it that you see'),
    version: z.number().int().describe('Its content version; send as expectedVersion to avoid overwriting a newer one'),
    limited: z.boolean().describe('Limited to some people and groups (D51); what is under it is seen only by who sees it'),
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
  visibleTo: VisibleToSchema.nullable().describe(
    "Null: it isn't limited itself. Otherwise only these see it, besides its author, the project's managers and administrators (D51)",
  ),
  limitedAbove: z.array(ArticleRefSchema).describe('The limited articles it sits under, from the top: only who sees them sees it'),
  aiDrafted: z.boolean().describe('Its saved words came from an accepted suggestion (D59); said beside them, cleared by an edit that does not say so'),
}).meta({ id: 'ArticleDetail' });
export type ArticleDetail = z.infer<typeof ArticleDetailSchema>;

export const CreateArticleBody = z.object({
  project: z.string().describe('Project key'),
  title: z.string().min(1).max(250),
  body: z.string().max(200_000).default('').describe('Markdown. Mention issues (BACK-12) and articles (BACK-A-3) by id'),
  parent: z.string().nullable().optional().describe('Readable id of the article to put it under; omit for the top of the tree'),
  position: z.number().int().min(0).optional().describe('Its place among its siblings, from 0; omit to put it last'),
  visibleTo: VisibleToInput.nullable()
    .optional()
    .describe("Limit it to these people and groups from the start (D51): its author, the project's managers and administrators still see it"),
});
export type CreateArticleInput = z.input<typeof CreateArticleBody>;

export const UpdateArticleBody = z.object({
  title: z.string().min(1).max(250).optional(),
  body: z.string().max(200_000).optional(),
  parent: z.string().nullable().optional().describe('Move it under this article, or to the top with null'),
  position: z.number().int().min(0).optional().describe('Its place among its (new) siblings, from 0'),
  expectedVersion: z.number().int().optional().describe('Fail with 409 if its content changed since this version'),
  aiDrafted: z.boolean().optional().describe('True when the saved words came from an accepted suggestion (D59); an edit that does not say so clears the mark'),
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
    reason: z.enum(WATCH_REASONS).describe('Why they watch: they chose to, or they reported it, were assigned, commented, were mentioned, lead the project of a help desk request, or wrote the chat message it was made from (D60)'),
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
    kind: z
      .enum(NOTIFICATION_KINDS)
      .describe('The strongest reason among its events: assigned, mentioned, request (a new help desk request), watching, subscribed (a project or a saved search you subscribed to)'),
    title: z.string().describe('What happened, in words: "Anna Schmidt mentioned you"'),
    issue: IssueRefSchema.describe('The issue as it was at its latest event'),
    project: z.string().nullable(),
    issueDeleted: z.boolean(),
    events: z.array(EventSchema).describe('The changes and comments it folds together, oldest first (the last 20)'),
    eventCount: z.number().int(),
    firstAt: timestamp,
    lastAt: timestamp,
    readAt: timestamp.nullable(),
    subscription: z
      .object({
        id: z.string(),
        about: z.string().describe('What it tells you of: "new issues in Backend", "issues coming into “Critical bugs”"'),
        target: z.enum(['project', 'search']).describe('What it follows, for a page that says about in its own words (D49)'),
        events: z.enum(SUBSCRIPTION_EVENTS),
        name: z.string().describe('The project’s name, or the saved search’s'),
      })
      .nullable()
      .describe('When it came because you subscribed (kind "subscribed"): to what. Null otherwise, or once that subscription has ended'),
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
    push: z.enum(EMAIL_LEVELS).describe('The same levels, for push notifications to the devices you turned them on for (D47)'),
    digest: z.boolean().describe("A daily email of what's still unread and wasn't emailed"),
    address: z.string().nullable().describe('Where emails go: your email, from your profile'),
    mailConfigured: z.boolean().describe('Whether this server sends email at all (SMTP_URL)'),
    digestHour: z.number().int().describe('The hour the digest goes out, in your time zone (DIGEST_HOUR)'),
    timeZone: z.string().describe("The time zone the digest and the times in your email follow: yours, or the server's"),
  })
  .meta({ id: 'NotificationSettings' });
export type NotificationSettings = z.infer<typeof NotificationSettingsSchema>;
export const NotificationSettingsBody = z.object({
  email: z.enum(EMAIL_LEVELS).optional(),
  push: z.enum(EMAIL_LEVELS).optional(),
  digest: z.boolean().optional(),
});

export const UnsubscribeQuery = z.object({ token: z.string().min(10).max(400) });
export const UnsubscribeSchema = z
  .object({
    kind: z
      .enum(['watching', 'direct', 'digest', 'request', 'subscription', 'cc', 'relay', 'group'])
      .describe(
        "What the link is for: a person's kind of email, one subscription's emails, a help desk request's emails to its requester, or to someone copied on it (cc: stopping takes them off it, D57), or relayed to a colleague who answered it (relay: they stop hearing it, D67), or to one of its customer group's people (group: they stop being copied on the group's requests, this one, its other open ones and its later ones, D56)",
      ),
    what: z.string().describe('What the link stops, in words'),
    subscription: z
      .object({ target: z.enum(['project', 'search']), events: z.enum(SUBSCRIPTION_EVENTS), name: z.string().describe('The project’s name, or the saved search’s') })
      .nullable()
      .describe('For a subscription that lasts: what it tells of, for a page that says what in its own words (D49)'),
    group: z
      .object({ name: z.string(), desk: z.string().describe('Its desk’s project, by name') })
      .nullable()
      .describe('For a customer group’s copies: the group whose emails it stops, for a page that says so in its own words (D49)'),
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

/** One of a request's SLA targets, as its clock stands (D45). Minutes are business minutes. */
export const SlaClockSchema = z
  .object({
    target: z.enum(SLA_TARGETS),
    state: z.enum(SLA_CLOCK_STATES),
    targetMinutes: z.number().int(),
    usedMinutes: z.number().int().describe('Business minutes counted so far'),
    leftMinutes: z.number().int().describe('Business minutes left; negative once past the target'),
    dueAt: timestamp.nullable().describe('When it runs out, while it counts; null while paused or stopped'),
    warnAt: timestamp.nullable().describe('When it turns at risk, while it counts'),
    metAt: timestamp.nullable(),
    breachedAt: timestamp.nullable().describe('When it went past its target'),
  })
  .meta({ id: 'SlaClock' });
export type SlaClock = z.infer<typeof SlaClockSchema>;

export const RequestSlaSchema = z
  .object({
    policy: z.object({ id: z.string(), name: z.string() }).nullable().describe('The policy that covers it: the first whose query it matches'),
    status: z.enum(SLA_STATUSES).nullable().describe('The worst of its targets; null without one'),
    clocks: z.array(SlaClockSchema),
    waiting: z.boolean().describe('It waits on its requester: its clocks are paused until they answer'),
    businessHours: z.boolean().describe("Its targets count the desk's working hours, not every hour"),
  })
  .meta({ id: 'RequestSla' });
export type RequestSla = z.infer<typeof RequestSlaSchema>;

/** Someone copied on a help desk request (D57), as the team sees them. */
export const RequestCcSchema = z
  .object({
    email: z.string(),
    name: z.string().describe('As whoever copied them named them; empty for none'),
    via: z
      .enum(REQUEST_CC_VIA)
      .describe('team: someone on the team copied them; email: the Cc of the requester’s email; portal: the requester, on the portal; group: one of the customer group the request was filed under, copied as it came in (D56)'),
    addedBy: UserRefSchema.nullable().describe('Who on the team copied them; null when the requester did'),
    addedAt: timestamp,
    group: z.string().nullable().describe('For a group’s copy, the customer group that copied them, by name; null otherwise'),
    hears: z
      .boolean()
      .describe('Whether they are told of it now. A group’s copy hears only while the group shares this request with them: still filed under it, not kept private, the group sharing, the address still its member, and they haven’t stopped its emails (D56)'),
  })
  .meta({ id: 'RequestCc' });
export type RequestCc = z.infer<typeof RequestCcSchema>;

/** Someone a new request's Cc named, waiting for its requester to confirm them (D67): told nothing until then. */
export const HeldCcSchema = z
  .object({ email: z.string(), name: z.string().describe('As the email named them; empty for none'), heldAt: timestamp })
  .meta({ id: 'HeldCc' });
export type HeldCc = z.infer<typeof HeldCcSchema>;

/** Someone copied on a request, as its requester sees them on the portal. */
export const PortalCcSchema = z
  .object({
    email: z.string(),
    name: z.string(),
    byYou: z.boolean().describe('The requester copied them, by email or on the portal; otherwise the team did'),
    addedAt: timestamp,
  })
  .meta({ id: 'PortalCc' });
export type PortalCc = z.infer<typeof PortalCcSchema>;

export const HelpdeskRequestSchema = z
  .object({
    issue: z.string(),
    requester: z.object({
      name: z.string(),
      email: z.string(),
      passkeys: z.number().int().describe('How many passkeys they sign in to the portal with (D69); never which'),
      language: z
        .object({
          locale: z.enum(LOCALES),
          chosen: z.boolean().describe('They chose it on the portal; otherwise it is the language their browser last asked for there'),
        })
        .nullable()
        .describe("The language a4a writes to them in, when it knows one (D63's revisit): their choice on the portal, else their browser's. Null: neither yet, so the desk's, the server's default"),
    }),
    createdAt: timestamp,
    firstResponse: SlaSchema,
    sla: RequestSlaSchema,
    emailMuted: z.boolean().describe('The requester stopped emails about it; their tracking page still works'),
    via: z.enum(['form', 'email']).describe('How it came in: the public form, or an email to the desk (D30)'),
    ccs: z.array(RequestCcSchema).describe('Who is copied on it now (D57), first copied first'),
    ccsMax: z.number().int().describe('The most its desk copies on a request at once (D67)'),
    held: z.array(HeldCcSchema).describe('Named in the Cc of the email that opened it, and waiting for its requester to confirm them (D67): told nothing until then'),
    group: z
      .object({ id: z.string(), name: z.string(), sharing: z.enum(['none', 'read', 'comment']) })
      .nullable()
      .describe('The customer group it was filed under, or the team gave it (D56); null for none'),
    private: z.boolean().describe("Kept from its group's other members: on the portal, only its requester sees it"),
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
        from: z.enum(['you', 'team', 'cc', 'colleague']).describe('cc: someone copied on the request (D57); colleague: someone of its customer group, answering it (D56)'),
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
  script: z
    .string()
    .max(20_000)
    .nullable()
    .optional()
    .describe(
      'JavaScript run in a sandbox (D40) in place of the command (a change or scheduled rule) or of `requires` (a guard). Its globals: `issue`, `change`, `project`, and apply(command[, issueId]), comment(text), refuse(message), log(...). Administrators only',
    ),
  queued: z
    .boolean()
    .default(false)
    .describe("A scripted rule (D40's revisit): its worker runs it, so it may take its time. Administrators only"),
  enabled: z.boolean().default(true),
});
export type RuleInput = z.input<typeof RuleBody>;

export const RULE_PARTS = ['name', 'trigger', 'field', 'schedule', 'query', 'requires', 'command', 'related', 'target', 'notify', 'call', 'script'] as const;
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
    said: z
      .array(NoteSaidSchema)
      .nullable()
      .describe("The message in the catalogs, a sentence each, for a page in another language (D49). Null for a run recorded before a4a kept them, and where the message is the rule's own words"),
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
    script: z.string().nullable().describe('A scripted rule\'s JavaScript (D40), or null'),
    queued: z.boolean().describe("Runs from the queue (D40's revisit): a worker runs it, so it may take its time"),
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
          errorWords: z
            .array(ProblemWordsSchema)
            .optional()
            .describe("Each of errors as a page says it, in its person's language, in the same order (D49)"),
          via: IssueRefSchema.nullable().optional().describe('When the rule acts on related issues: the matching issue this one is related to'),
          told: z.array(UserRefSchema).optional().describe('Whom it would tell about this issue'),
        }),
      )
      .describe('A few of the issues it would act on, with what the command would change on each (a dry run)'),
    note: z.string().describe('What the preview shows, in words'),
    says: z
      .object({
        shows: z
          .enum(['issues', 'fixUnderlined', 'fixScript', 'adminOnly'])
          .describe('"issues": the issues it would act on; otherwise why it shows none: a part to fix, its script to fix, or a script only an administrator runs unsaved'),
        kind: z.enum(RULE_KINDS),
        scripted: z.boolean(),
        trigger: z.enum(RULE_TRIGGERS).nullable(),
        field: z.string().nullable().describe('The field whose change sets it off, if one'),
        schedule: RuleScheduleSchema.nullable(),
        target: RuleTargetSchema.nullable().describe('The issues it acts on, when not the issue itself'),
        query: z.string(),
        outside: z.number().int().describe('Issues it would act on in another project, which a rule of its project leaves alone'),
        project: z.string().nullable().describe("Its project's key; null for a rule for every project"),
        shown: z.number().int().describe('How many issues the sample shows'),
        tells: z.boolean().describe('Whether it tells anyone'),
      })
      .describe("What note says, as data, for a page to say it in its person's language (D49)"),
  })
  .meta({ id: 'RulePreview' });
export type RulePreview = z.infer<typeof RulePreviewSchema>;

export const RuleCheckBody = z.object({
  project: z.string().nullable(),
  kind: z.enum(RULE_KINDS),
  part: z.enum(['query', 'requires', 'command', 'related', 'script']),
  text: z.string().max(20_000),
  caret: z.number().int().min(0).optional(),
});
export const RuleCheckResultSchema = z
  .object({ problems: z.array(QueryProblemSchema), description: z.string(), suggestions: z.array(SuggestItemSchema) })
  .meta({ id: 'RuleCheckResult' });

// ---------------------------------------------------------------------------
// Version control
// ---------------------------------------------------------------------------

/** An installation of a GitHub integration's app, as a4a knows it (D66): each repository is read through its own. */
export const VcsInstallationSchema = z
  .object({
    id: z.string().describe("The installation's id, as in its address on GitHub (…/installations/12345678)"),
    account: z.string().nullable().describe('The user or organization it is installed on'),
    accountType: z.enum(['user', 'organization']).nullable(),
    allRepositories: z.boolean().describe("Whether it was given all of the account's repositories, rather than some"),
    repositories: z.array(z.string()).describe('Repositories a4a has read or reported to through it, the latest first, at most ten'),
    suspended: z.boolean().describe('GitHub said it is suspended: nothing is read or reported through it until it is unsuspended'),
    gone: z.boolean().describe('GitHub said it is gone: the app was uninstalled from that account'),
  })
  .meta({ id: 'VcsInstallation' });
export type VcsInstallation = z.infer<typeof VcsInstallationSchema>;

/** A GitHub App a GitHub integration reads as (D54): its private key is never shown. */
export const VcsGithubAppSchema = z
  .object({
    appId: z.string().describe("The app's id (or its client id), as GitHub shows it on the app's settings page"),
    slug: z.string().nullable().describe("The app's name in GitHub's addresses, e.g. a4a-acme"),
    installationId: z.string().describe("The integration's own installation: its repository's, the one given, or the app's first. Each repository is read through its own (D66)"),
    account: z.string().nullable().describe('The user or organization its own installation is on'),
    installations: z.array(VcsInstallationSchema).describe('The installations of the app a4a knows of, with their accounts (D66)'),
  })
  .meta({ id: 'VcsGithubApp' });
export type VcsGithubApp = z.infer<typeof VcsGithubAppSchema>;

/** Check runs or commit statuses on pull requests: GitHub's as its app (D66), GitLab's and Forgejo's with their token (D70). */
export const VcsChecksSchema = z
  .object({
    enabled: z.boolean().describe('Whether a4a reports to each pull request as a check run named "a4a" (GitHub) or a commit status (GitLab, Forgejo). Off by default; GitHub takes the app\'s Checks: Read and write, the others a token that may write statuses'),
    states: z.boolean().describe("Whether the check says each issue's state, beside its id and link"),
    requireResolved: z.boolean().describe("Whether the check fails while an issue it names isn't resolved, or an id names no issue a4a shows; otherwise it's neutral"),
    problem: z.string().nullable().describe('Why the last check run a4a wrote for it didn\'t go, in the words of its deliveries\' log; null when the last went'),
    problemAt: timestamp.nullable(),
  })
  .meta({ id: 'VcsChecks' });
export type VcsChecks = z.infer<typeof VcsChecksSchema>;

export const VcsIntegrationSchema = z
  .object({
    id: z.string(),
    provider: z.enum(VCS_PROVIDERS),
    name: z.string(),
    projects: z.array(z.string()).describe('Project keys whose issue ids it looks for; empty: every project'),
    active: z.boolean(),
    webhookUrl: z.string().describe('Where the provider sends its deliveries'),
    secretPrefix: z.string().describe("The secret's first characters, to recognise it by"),
    baseUrl: z.string().nullable().describe("Bitbucket Data Center's address, where a4a reads the commits a push moved; GitHub Enterprise Server's API address; null for the others"),
    hasAccessToken: z.boolean().describe('Whether a4a has an access token: to read the commits a delivery leaves out (Bitbucket), or those a build holds (GitHub). The token is never shown'),
    githubApp: VcsGithubAppSchema.nullable().describe('GitHub: the GitHub App a4a reads as instead of an access token (D54); null when it reads with a token, or not at all'),
    checks: VcsChecksSchema.nullable().describe(
      'GitHub: check runs on pull requests, written as its app (D66); GitLab and Forgejo: commit statuses, written with the integration’s access token (D70); null for the other providers',
    ),
    createdAt: timestamp,
    lastDeliveryAt: timestamp.nullable(),
  })
  .meta({ id: 'VcsIntegration' });
export type VcsIntegration = z.infer<typeof VcsIntegrationSchema>;
export const VcsIntegrationCreatedSchema = VcsIntegrationSchema.extend({
  secret: z.string().describe("The webhook's secret (its secret token, in GitLab). Shown only once"),
}).meta({ id: 'VcsIntegrationCreated' });
export type VcsIntegrationCreated = z.infer<typeof VcsIntegrationCreatedSchema>;
const VcsBaseUrl = z
  .string()
  .max(500)
  .describe(
    "Bitbucket Data Center: the instance's address (https), as people open it, e.g. https://bitbucket.acme.example. GitHub Enterprise Server: its API's address, e.g. https://github.acme.example/api/v3 (D46)",
  );
const VcsAccessToken = z
  .string()
  .min(1)
  .max(1000)
  .describe(
    "Bitbucket: an access token that may read the repository. Data Center sends no commits with a push, and Bitbucket Cloud the latest five a branch got: with it, a4a reads them. GitHub: a token that may read the repository's contents, with which a4a asks GitHub which commits a build holds when it hasn't seen them (D46). Kept encrypted, never shown again",
  );
/** A GitHub App to read as, given to a GitHub integration (D54). */
export const VcsGithubAppBody = z
  .object({
    appId: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .describe("The app's id, or its client id (Iv…), from the app's settings page"),
    privateKey: z
      .string()
      .trim()
      .min(1)
      .max(10_000)
      .describe('One of the app\'s private keys, the .pem file GitHub gave, whole: "-----BEGIN RSA PRIVATE KEY-----" and on. Kept encrypted, never shown again'),
    installationId: z
      .string()
      .trim()
      .regex(/^\d{1,20}$/, 'An installation id is a number')
      .nullish()
      .describe("Which of the app's installations to read through, as in its address (…/settings/installations/12345678). Leave it out and a4a finds it: the one on the repository the integration is named after, or the app's only one"),
  })
  .describe('Read as a GitHub App, not with a person\'s token. Giving one removes the access token; null stops reading as the app');
export const VcsIntegrationBody = z.object({
  provider: z.enum(VCS_PROVIDERS),
  name: z.string().min(1).max(120).describe('What it is, e.g. the repository "acme/backend"'),
  projects: z.array(z.string()).max(50).default([]).describe('Project keys whose issue ids to look for; empty for every project'),
  active: z.boolean().default(true),
  baseUrl: VcsBaseUrl.nullable().optional(),
  accessToken: VcsAccessToken.nullable().optional(),
  githubApp: VcsGithubAppBody.nullable().optional(),
});
export const UpdateVcsIntegrationBody = z.object({
  name: z.string().min(1).max(120).optional(),
  projects: z.array(z.string()).max(50).optional(),
  active: z.boolean().optional(),
  baseUrl: VcsBaseUrl.nullable().optional(),
  accessToken: VcsAccessToken.nullable().optional().describe('A new access token; null removes it. Giving one stops reading as a GitHub App'),
  githubApp: VcsGithubAppBody.nullable().optional(),
  checks: z
    .object({
      enabled: z.boolean().optional().describe('Report to each pull request as a check run named "a4a". Only a GitHub integration that reads as a GitHub App; turning it on checks the app may write checks'),
      states: z.boolean().optional().describe("Say each issue's state beside its id and link. A check run is seen by whoever sees the repository"),
      requireResolved: z.boolean().optional().describe("Fail while an issue it names isn't resolved, or an id names no issue a4a shows; otherwise it's neutral"),
    })
    .optional()
    .describe('Check runs on pull requests, as the app (D66)'),
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
  user: UserRefSchema.nullable().describe('The person in a4a: matched by a confirmed email, or by their login at the provider'),
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
    said: NoteSaidSchema.nullable().describe('The note in the catalogs, for a page in another language (D49); null where it is only field names and values, and before a4a kept it'),
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
        documentHost: z
          .string()
          .nullable()
          .optional()
          .describe('For an app known by its client ID metadata document (D38): the host that document is at, which vouches for the app'),
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
    requirePasskeys: z.boolean().describe('Whether its people owe a passkey when a4a’s own password signs them in (D70)'),
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
    .array(z.object({ project: ProjectRefSchema, role: z.string(), roleName: z.string() }))
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
  requirePasskeys: z.boolean().default(false).describe('Require its people to use a passkey with a4a’s own password sign-in (D70)'),
});
export const UpdateGroupBody = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().max(500).optional(),
  providerName: z.string().trim().min(1).max(200).nullable().optional(),
  requirePasskeys: z.boolean().optional(),
});
export const AddGroupMemberBody = z.object({ user: z.string().min(1).describe('Login of the person') });

/** A group with a role in a project. */
export const ProjectGroupSchema = z
  .object({
    group: GroupRefSchema,
    role: z.string().describe("The role's id: viewer, member, manager, or a custom role's"),
    roleName: z.string(),
    people: z.array(UserRefSchema).describe("Who is in it: as anyone who sees a project sees who is in it, so a members-only project's issues go only to them"),
    addedAt: timestamp,
    addedBy: UserRefSchema.nullable(),
  })
  .meta({ id: 'ProjectGroup' });
export type ProjectGroup = z.infer<typeof ProjectGroupSchema>;
export const AddProjectGroupBody = z.object({
  group: z.string().min(1).describe("The group's id or name"),
  role: z.string().min(1).default('member').describe("A role's id or name"),
});
export const UpdateProjectGroupBody = z.object({ role: z.string().min(1).describe("A role's id or name") });

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
    trustedServers: z
      .array(z.string())
      .describe("The mail servers whose DMARC results a4a trusts (HELPDESK_TRUSTED_AUTHSERV_IDS, their authserv-ids, D67): an email whose sender's domain passed DMARC at one of them is known to be from its sender"),
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
    via: z
      .enum(['webhook', 'imap', 'page', 'portal'])
      .describe('By the webhook or from the mailbox; or, for words a desk that relays didn’t pass on (D67), written on the tracking page or the portal'),
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
    group: z.string().optional().describe('The group it undid, when the change was one of several made as one (D34’s revisit)'),
    issues: z.array(IssueRefSchema).optional().describe('With `group`: every issue it put back'),
  })
  .meta({ id: 'UndoResult' });
export type UndoResult = z.infer<typeof UndoResultSchema>;

// Subscriptions (D31)
// ---------------------------------------------------------------------------

export const SubscriptionSchema = z
  .object({
    id: z.string(),
    target: z.enum(['project', 'search']).describe('What it is to: a project, or a saved search'),
    project: z.object({ key: z.string(), name: z.string() }).nullable().describe("A project subscription's project"),
    search: z.object({ id: z.string(), name: z.string(), query: z.string() }).nullable().describe("A saved-search subscription's search"),
    events: z
      .enum(SUBSCRIPTION_EVENTS)
      .describe('To a project: its new issues (new), or every change in it (all). To a saved search: an issue coming into it (new), or any change to one in it (all)'),
    email: z.boolean().describe('Whether it emails you too, as well as your inbox. Your email setting "Never" stops it'),
    about: z.string().describe('What it tells you of, in words: "New issues in Backend", "Issues coming into “Critical bugs”"'),
    createdAt: timestamp,
  })
  .meta({ id: 'Subscription' });
export type Subscription = z.infer<typeof SubscriptionSchema>;

export const SubscribeBody = z.object({
  project: z.string().optional().describe('A project, by its key: to its new issues, or every change in it'),
  savedSearch: z.string().optional().describe('A saved search, by its id: to issues coming into it, or any change to one in it'),
  events: z.enum(SUBSCRIPTION_EVENTS).default('new'),
  email: z.boolean().default(true).describe('Email too, as your email setting allows'),
});
export type SubscribeInput = z.input<typeof SubscribeBody>;

export const UpdateSubscriptionBody = z.object({
  events: z.enum(SUBSCRIPTION_EVENTS).optional(),
  email: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// Version control: more emails, and logins at providers (D33)
// ---------------------------------------------------------------------------

export const UserEmailSchema = z
  .object({
    id: z.string().nullable().describe('Null for the primary email'),
    email: z.string(),
    primary: z.boolean(),
    confirmed: z
      .boolean()
      .describe("Confirmed by a link a4a mailed to it, set by an administrator, or vouched for by single sign-on. Commits under a confirmed email are the person's"),
    confirmedBy: UserRefSchema.nullable().describe('Who confirmed it: the person, by the link, or the administrator who set it. Null for the primary'),
    linkSentAt: timestamp.nullable().describe('When a4a last sent a link to confirm it, while it waits'),
    createdAt: timestamp.nullable(),
  })
  .meta({ id: 'UserEmail' });
export type UserEmail = z.infer<typeof UserEmailSchema>;

export const PersonEmailsSchema = z
  .object({
    emails: z.array(UserEmailSchema).describe('The primary first, then the others as they were added'),
    canSendLinks: z.boolean().describe('Whether a4a can send email here: without it, an administrator confirms emails'),
  })
  .meta({ id: 'PersonEmails' });
export type PersonEmails = z.infer<typeof PersonEmailsSchema>;

export const AddEmailBody = z.object({ email: z.string().trim().email().max(254) });
export const SendEmailLinkBody = z.object({ email: z.string().trim().email().max(254).describe('One of your emails that waits to be confirmed') });
export const PrimaryEmailBody = z.object({ email: z.string().trim().email().max(254).describe('One of your confirmed emails') });
export const ConfirmEmailBody = z.object({ token: z.string().min(16).max(200) });
export const EmailLinkSchema = z
  .object({ email: z.string().describe('The email the link confirms'), confirmed: z.boolean().describe('Whether it is confirmed now') })
  .meta({ id: 'EmailLink' });
export type EmailLink = z.infer<typeof EmailLinkSchema>;

export const ProviderLoginSchema = z
  .object({
    id: z.string(),
    provider: z.enum(VCS_PROVIDERS),
    login: z.string().describe('As the administrator recorded it, or as the provider names the account they connected'),
    addedBy: UserRefSchema.nullable(),
    connected: z.boolean().describe('They connected it themselves, by signing in at the provider (D46): proof the account is theirs'),
    createdAt: timestamp,
  })
  .meta({ id: 'ProviderLogin' });
export type ProviderLogin = z.infer<typeof ProviderLoginSchema>;
export const ProviderLoginBody = z.object({
  provider: z.enum(VCS_PROVIDERS),
  login: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe("Their username at the provider. For Bitbucket Cloud, their account id or UUID: its nicknames aren't unique"),
});

// ---------------------------------------------------------------------------
// Issues and fields (package 5: docs/architecture.md, D41)
// ---------------------------------------------------------------------------

export const MoveIssueBody = z.object({
  project: z.string().min(1).describe('The key of the project it moves to'),
  fields: FieldsInput.optional().describe("Values for fields whose value doesn't carry over by name, or null to leave one empty"),
  dryRun: z.boolean().default(false).describe('Say what would happen, and change nothing'),
  expectedVersion: z.number().int().optional(),
});
export type MoveIssueInput = z.input<typeof MoveIssueBody>;

export const MoveProblemSchema = z
  .object({
    field: z.string().nullable().describe('The field it is about; null for the issue as a whole'),
    message: z.string(),
    hint: z.string().optional(),
    choices: z.array(z.string()).optional().describe('Values the field takes in the project it moves to'),
    key: z.string().optional().describe('The problem in the catalogs, problem.<key>, for a page that says it in its person’s language (D49). The English in message and hint is the same problem.'),
    values: z.record(z.string(), z.union([z.string(), z.number(), ListSaidSchema])).optional().describe('What the problem’s words take, by name: a word, a number or a list.'),
  })
  .meta({ id: 'MoveProblem' });
export type MoveProblem = z.infer<typeof MoveProblemSchema>;

export const MovePlanSchema = z
  .object({
    from: z.string().describe('Its id now'),
    to: z.string().describe('Its id once moved'),
    project: z.object({ key: z.string(), name: z.string() }),
    problems: z.array(MoveProblemSchema).describe("What doesn't carry over: each needs a value in `fields` (or null), and nothing moves until none is left"),
    carried: z.array(ChangeSchema).describe('What each field will hold there; a multi-value field’s values each in fromList and toList'),
    dropped: z.array(z.string()).describe("Fields the project it moves to doesn't have: their values are left behind"),
    leftSprints: z.array(z.string()).describe('Sprints it leaves, on boards that show none of that project'),
    moved: z.boolean().describe('Whether it moved (false for a dry run, or while problems remain)'),
  })
  .meta({ id: 'MovePlan' });
export type MovePlan = z.infer<typeof MovePlanSchema>;

export const CloneIssueBody = z.object({
  project: z.string().optional().describe('Where the copy goes; its own project if left out'),
  summary: z.string().min(1).max(500).optional().describe("The copy's summary; the original's if left out"),
});
export type CloneIssueInput = z.input<typeof CloneIssueBody>;

export const VoteSchema = z.object({ votes: z.number().int(), voted: z.boolean() }).meta({ id: 'Vote' });
export type Vote = z.infer<typeof VoteSchema>;

export const ReactBody = z.object({ emoji: z.enum(REACTIONS) });

// ---------------------------------------------------------------------------
// Scripted workflows: test runs, state machines and custom actions (D40)
// ---------------------------------------------------------------------------

export const SCRIPT_ERROR_KINDS = ['syntax', 'runtime', 'time', 'memory'] as const;

/** What a script did on one issue, as a dry run: nothing is saved or changed. */
export const ScriptRunSchema = z
  .object({
    ok: z.boolean().describe('It ran to its end'),
    error: z
      .object({
        kind: z.enum(SCRIPT_ERROR_KINDS),
        message: z.string(),
        line: z.number().int().nullable(),
        key: z.string().optional().describe('Past its time or memory: the problem in the catalogs, problem.<key> (D49). What the JavaScript engine says has none'),
        values: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
      })
      .nullable()
      .describe('Where it went wrong: its syntax, an error as it ran, or past its time or memory'),
    logs: z.array(z.string()).describe('What it wrote with log()'),
    refusal: z.string().nullable().describe('What it said with refuse(): a guard refuses the change with it'),
    comments: z.array(z.string()),
    applies: z
      .array(
        z.object({
          command: z.string(),
          issue: IssueRefSchema.nullable().describe('The issue the command is for'),
          changes: z.array(ChangeSchema).describe('What it would change there (a dry run)'),
          errors: z.array(z.string()),
          errorWords: z
            .array(ProblemWordsSchema)
            .optional()
            .describe("Each of errors as a page says it, in its person's language, in the same order (D49)"),
        }),
      )
      .describe('The commands it asked for, and what each would change'),
    ms: z.number().int(),
    note: z.string(),
    says: z
      .object({
        outcome: z
          .enum(['stopped', 'refuses', 'passes', 'doesNothing', 'asks'])
          .describe('"stopped": its script stopped; a guard "refuses" or "passes" the change; "doesNothing": it refused; "asks": the commands it asks for'),
        ignored: z.boolean().describe('A guard that applied or commented: a guard only refuses, so that is ignored'),
        commands: z.number().int(),
        changing: z.number().int().describe('Commands that would change something'),
        failing: z.number().int().describe('Commands that would fail'),
        comments: z.number().int(),
      })
      .describe("What note says, as data, for a page to say it in its person's language (D49)"),
  })
  .meta({ id: 'ScriptRun' });
export type ScriptRun = z.infer<typeof ScriptRunSchema>;

export const RuleTestBody = RuleBody.extend({ issue: z.string().describe('The issue to run it on, as it is now, e.g. BACK-12') });

export const WORKFLOW_PARTS = ['name', 'field', 'transitions', 'from', 'to', 'condition', 'command', 'script'] as const;
export const WorkflowProblemSchema = QueryProblemSchema.extend({
  part: z.enum(WORKFLOW_PARTS),
  transition: z.number().int().nullable().optional().describe("For a state machine: which transition, from 0"),
}).meta({ id: 'WorkflowProblem' });
export type WorkflowProblem = z.infer<typeof WorkflowProblemSchema>;

export const StateTransitionSchema = z
  .object({
    name: z.string().trim().min(1).max(60).describe('What the move is called, e.g. "Start work"; also a command'),
    from: z.array(z.string().max(100)).min(1).max(50).describe('The states it leaves; ["*"] for any'),
    to: z.string().max(100).describe('The state it reaches'),
    condition: z.string().max(2000).nullable().optional().describe('What the issue must match as the move finds it, e.g. "has: Assignee"'),
    command: z.string().max(2000).nullable().optional().describe('What the move also does, in the command language, as whoever makes it'),
  })
  .meta({ id: 'StateTransition' });
export type StateTransition = z.infer<typeof StateTransitionSchema>;

export const StateMachineBody = z.object({
  project: z.string().describe('Project key'),
  field: z.string().describe('A state field of the project, e.g. State'),
  transitions: z.array(StateTransitionSchema).min(1).max(100),
  enabled: z.boolean().default(true),
});
export type StateMachineInput = z.input<typeof StateMachineBody>;
export const UpdateStateMachineBody = z.object({
  transitions: z.array(StateTransitionSchema).min(1).max(100).optional(),
  enabled: z.boolean().optional(),
  expectedVersion: z.number().int().optional().describe('Fail with 409 if it changed since this version'),
});

export const StateMachineSchema = z
  .object({
    id: z.string(),
    project: z.string(),
    field: z.string(),
    states: z.array(z.string()).describe("The field's values in the project, in order"),
    transitions: z.array(StateTransitionSchema),
    enabled: z.boolean(),
    problems: z.array(WorkflowProblemSchema).describe('What no longer reads, e.g. a state renamed since. A machine with problems refuses nothing until they are fixed'),
    version: z.number().int(),
    updatedAt: timestamp,
  })
  .meta({ id: 'StateMachine' });
export type StateMachine = z.infer<typeof StateMachineSchema>;

export const WorkflowActionBody = z.object({
  project: z.string().describe('Project key'),
  name: z.string().trim().min(1).max(60).describe('What it is called; also a command'),
  command: z.string().max(2000).default('').describe('What it does, in the command language'),
  script: z.string().max(20_000).nullable().optional().describe('Or what it does, in JavaScript run in the sandbox (administrators only)'),
  condition: z.string().max(2000).default('').describe('When it is offered, in the query language; empty: always'),
  enabled: z.boolean().default(true),
});
export type WorkflowActionInput = z.input<typeof WorkflowActionBody>;
export const UpdateWorkflowActionBody = patchBody(WorkflowActionBody)
  .omit({ project: true })
  .extend({ expectedVersion: z.number().int().optional().describe('Fail with 409 if it changed since this version') });

export const WorkflowActionSchema = z
  .object({
    id: z.string(),
    project: z.string(),
    name: z.string(),
    command: z.string(),
    script: z.string().nullable(),
    condition: z.string(),
    enabled: z.boolean(),
    problems: z.array(WorkflowProblemSchema),
    version: z.number().int(),
    updatedAt: timestamp,
  })
  .meta({ id: 'WorkflowAction' });
export type WorkflowAction = z.infer<typeof WorkflowActionSchema>;

/** What someone can do to an issue now, by its project's workflows: its state machines' moves and its custom actions. */
export const IssueWorkflowSchema = z
  .object({
    transitions: z.array(
      z.object({
        field: z.string(),
        name: z.string(),
        to: z.string(),
        allowed: z.boolean(),
        why: z.string().nullable().describe("Why it can't be done now"),
      }),
    ),
    actions: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        scripted: z.boolean(),
        allowed: z.boolean(),
        why: z.string().nullable(),
      }),
    ),
  })
  .meta({ id: 'IssueWorkflow' });
export type IssueWorkflow = z.infer<typeof IssueWorkflowSchema>;

export const TransitionBody = z.object({
  field: z.string().optional().describe("The state field, when the project's issues have more than one machine"),
  transition: z.string().describe("The transition's name"),
  expectedVersion: z.number().int().optional(),
});
export const RunActionBody = z.object({ expectedVersion: z.number().int().optional() });

// ---------------------------------------------------------------------------
// Access in depth (D37): custom roles, who sees an issue or a comment, guests
// ---------------------------------------------------------------------------

export const RoleDefSchema = z
  .object({
    id: z.string().describe("viewer, member, manager, or a custom role's id"),
    name: z.string(),
    description: z.string(),
    permissions: z.array(z.enum(PERMISSIONS)),
    builtin: z.boolean().describe('The built-in roles can be given but not changed'),
    uses: z.number().int().describe('How many people and groups have it in some project'),
    version: z.number().int(),
  })
  .meta({ id: 'RoleDefinition' });
export type RoleDef = z.infer<typeof RoleDefSchema>;
export const CreateRoleBody = z.object({
  name: z.string().trim().min(1).max(60),
  description: z.string().max(500).default(''),
  permissions: z.array(z.enum(PERMISSIONS)).min(1).describe('read is needed for any other'),
});
export const UpdateRoleBody = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  description: z.string().max(500).optional(),
  permissions: z.array(z.enum(PERMISSIONS)).min(1).optional(),
  expectedVersion: z.number().int().optional(),
});
export const SetVisibilityBody = z.object({
  visibleTo: VisibleToInput.nullable().describe('Null: everyone who sees the project (or the issue, for a comment)'),
  expectedVersion: z.number().int().optional().describe("The issue's version, for an issue"),
});
export const GuestInfoSchema = z
  .object({
    projects: z.array(ProjectRefSchema).describe('The projects anyone may read without signing in'),
  })
  .meta({ id: 'GuestInfo' });
export type GuestInfo = z.infer<typeof GuestInfoSchema>;

// ---------------------------------------------------------------------------
// Identity in depth (D38): two-factor sign-in, SCIM provisioning
// ---------------------------------------------------------------------------

/** A sign-in whose password was right, still owing a step: a code, or setting two-factor up first. */
export const SignInStepSchema = z
  .object({
    step: z
      .enum(['two_factor', 'two_factor_setup', 'passkey_setup'])
      .describe(
        'two_factor: send a code (POST /auth/two-factor). two_factor_setup: two-factor is required here and not set up yet (POST /auth/two-factor/setup). passkey_setup: passkeys are required of you and you have none: add one (POST /auth/two-factor/passkey-setup, D68)',
      ),
    code: z.boolean().optional().describe('two_factor: a code from the authenticator app (or a recovery code) finishes it. passkey_setup: adding the passkey takes a code too'),
    passkey: z.boolean().optional().describe('two_factor: one of their passkeys finishes it instead (POST /auth/two-factor/passkey, D62)'),
  })
  .meta({ id: 'SignInStep' });
export type SignInStep = z.infer<typeof SignInStepSchema>;

export const TwoFactorStatusSchema = z
  .object({
    enabled: z.boolean(),
    enabledAt: timestamp.nullable(),
    recoveryCodesLeft: z.number().int().describe('Recovery codes not used yet'),
    required: z.boolean().describe('Whether an administrator requires it of every password account'),
  })
  .meta({ id: 'TwoFactorStatus' });
export type TwoFactorStatus = z.infer<typeof TwoFactorStatusSchema>;

export const TwoFactorEnrolmentSchema = z
  .object({
    secret: z.string().describe('The secret, for typing into an authenticator app by hand, in groups of four'),
    otpauthUri: z.string().describe('What the QR code holds'),
    qrUrl: z.string().describe('The QR code, as an SVG image'),
  })
  .meta({ id: 'TwoFactorEnrolment' });
export type TwoFactorEnrolment = z.infer<typeof TwoFactorEnrolmentSchema>;

export const RecoveryCodesSchema = z
  .object({ recoveryCodes: z.array(z.string()).describe('Shown once: each signs in once in place of a code, for when the authenticator is lost') })
  .meta({ id: 'RecoveryCodes' });
export type RecoveryCodes = z.infer<typeof RecoveryCodesSchema>;

export const TwoFactorCodeBody = z.object({
  code: z.string().trim().min(6).max(20).describe('Six digits from the authenticator app, or a recovery code'),
});

export const ScimTokenSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    prefix: z.string(),
    createdAt: timestamp,
    lastUsedAt: timestamp.nullable(),
  })
  .meta({ id: 'ScimToken' });
export type ScimToken = z.infer<typeof ScimTokenSchema>;
export const ScimTokenCreatedSchema = ScimTokenSchema.extend({
  token: z.string().describe('Shown once: the identity provider sends it as a Bearer token'),
  baseUrl: z.string().describe("The SCIM endpoint's address, for the provider's Tenant URL"),
}).meta({ id: 'ScimTokenCreated' });
export type ScimTokenCreated = z.infer<typeof ScimTokenCreatedSchema>;
export const CreateScimTokenBody = z.object({ name: z.string().trim().min(1).max(80).describe('Whose it is, e.g. "Microsoft Entra ID"') });

// ---------------------------------------------------------------------------
// The visual editor (docs/architecture.md, D39)
// ---------------------------------------------------------------------------

/** A comment's new words, against the version read: an edit made meanwhile refuses this one (409). */
export const UpdateCommentBody = CommentBody.extend({
  expectedVersion: z.number().int().optional().describe('The version you read; without it, the edit is written whatever happened meanwhile'),
  aiDrafted: z.boolean().optional().describe('True when the saved words came from an accepted suggestion (D59); an edit that does not say so clears the mark'),
});
export type UpdateCommentInput = z.input<typeof UpdateCommentBody>;

// ---------------------------------------------------------------------------
// Agile and time tracking: backlog, story points, velocity, timers, work types,
// timesheets and the working week (docs/architecture.md, D43)
// ---------------------------------------------------------------------------

export const BacklogSchema = z
  .object({
    query: z.string().describe('The query the backlog holds'),
    issues: z.array(IssueSchema).describe("In rank order: ranked issues first, then the rest in the query's order"),
    ranked: z.array(z.string()).describe('Which of them have a place of their own (readable ids)'),
    count: z.number().int().describe('How many issues the query matches outside the open sprints, shown or not'),
    points: z.number().nullable().describe('Story points of the issues shown; null without a points field'),
  })
  .meta({ id: 'Backlog' });
export type Backlog = z.infer<typeof BacklogSchema>;

export const RankBody = z.object({
  issue: z.string().max(100).describe('The issue to move (readable id)'),
  after: z.string().max(100).nullable().optional().describe("Put it just after this issue: in the board's order, or, on the board where lanes keep their own order (D65), in its lane's"),
  before: z.string().max(100).nullable().optional().describe('Put it just before this issue; with neither, at the top (on the board, see column)'),
  // Ranking a card on the board itself (D53): its place and its column, and its lane, in one change.
  column: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe(
      "On the board: the column its card is in, or goes into, by name. Into another column, the board's column field becomes that column's first value its project has, in the same change as its place. With neither after nor before, it keeps its place in the board's order",
    ),
  lane: z.string().max(200).nullable().optional().describe("On the board: the swimlane its card goes into, by the lane's value (a login, or a value's name); null for the lane of no value"),
  sprint: z.string().max(100).optional().describe("On the board: the sprint whose cards were shown; the one the board shows first when not said"),
  expectedVersion: z.number().int().optional().describe("The issue's version as read: a column or lane change is refused (409) if it has changed since. Its place alone needs none"),
});
export type RankInput = z.infer<typeof RankBody>;

export const VELOCITY_MEASURES = ['points', 'estimate', 'count'] as const;
export const VelocitySchema = z
  .object({
    by: z.enum(VELOCITY_MEASURES),
    unit: z.string().describe('"points", "hours" or "issues"'),
    sprints: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        startDate: isoDate,
        endDate: isoDate,
        committed: z.number().describe('What the sprint held when it started'),
        done: z.number().describe('What was resolved in it by its end'),
        finished: z.boolean().describe('Whether its end has passed'),
      }),
    ),
    average: z.number().nullable().describe('Done per sprint over the last three finished sprints'),
  })
  .meta({ id: 'Velocity' });
export type Velocity = z.infer<typeof VelocitySchema>;

export const SprintPlanSchema = z
  .object({
    sprint: SprintSchema,
    from: isoDate.nullable().describe('The first day counted: its start, or today once it has started'),
    to: isoDate.nullable(),
    people: z.array(
      z.object({
        user: UserRefSchema.nullable().describe('Null for the unassigned issues'),
        issues: z.number().int(),
        points: z.number().nullable(),
        loadHours: z.number().describe('Remaining estimates of their unresolved issues in the sprint'),
        capacityHours: z.number().nullable().describe('Hours they can work in it, by their working week and days away; null without dates'),
      }),
    ),
    totals: z.object({ issues: z.number().int(), points: z.number().nullable(), loadHours: z.number(), capacityHours: z.number().nullable() }),
  })
  .meta({ id: 'SprintPlan' });
export type SprintPlan = z.infer<typeof SprintPlanSchema>;

export const WorkTypeSchema = z
  .object({ id: z.string(), name: z.string(), ordinal: z.number().int(), archived: z.boolean() })
  .meta({ id: 'WorkType' });
export type WorkType = z.infer<typeof WorkTypeSchema>;
export const WorkTypeBody = z.object({ name: z.string().trim().min(1).max(60) });
export const UpdateWorkTypeBody = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  archived: z.boolean().optional().describe('Archived types stay on the work logged with them, but are no longer offered'),
  ordinal: z.number().int().min(0).optional(),
});

export const TimerSchema = z
  .object({
    issue: IssueRefSchema,
    running: z.boolean(),
    runningSince: timestamp.nullable(),
    elapsedSeconds: z.number().int().describe('Counted so far, now included'),
  })
  .meta({ id: 'Timer' });
export type Timer = z.infer<typeof TimerSchema>;
export const StopTimerBody = z.object({
  duration: z.union([z.string(), z.number()]).optional().describe('What to log instead of the time counted ("1h 30m", or minutes)'),
  date: isoDate.optional().describe('Today where you are, by default'),
  description: z.string().max(5000).default(''),
  type: z.string().nullable().optional().describe("The work type's name or id"),
});
export type StopTimerInput = z.input<typeof StopTimerBody>;
export const StopTimerResultSchema = z
  .object({ workItem: WorkItemSchema.nullable().describe('Null when nothing was counted') })
  .meta({ id: 'StopTimerResult' });

export const TimesheetSchema = z
  .object({
    user: UserRefSchema,
    week: isoDate.describe('Its Monday'),
    status: z.enum(['open', 'submitted', 'approved']).describe("The week's state (D43's revisit): open to change, submitted to a manager, or approved"),
    submittedAt: timestamp.nullable(),
    approvedBy: UserRefSchema.nullable().describe('Who approved it, when it is'),
    days: z.array(isoDate).length(7),
    hours: z.array(z.number()).length(7).describe('Their working hours each day: their working week, less days away'),
    totals: z.array(z.number().int()).length(7).describe('Minutes logged each day'),
    personal: z
      .array(
        z.object({
          activity: z.string().describe("Their own row's name (D43's revisit): BAU, or anything they keep"),
          minutes: z.array(z.number().int()).length(7),
          entries: z.array(z.number().int()).length(7),
        }),
      )
      .describe("Their own rows, each a name of their choosing, beside their issues'"),
    rows: z.array(
      z.object({
        issue: IssueRefSchema,
        type: z.object({ id: z.string(), name: z.string() }).nullable(),
        minutes: z.array(z.number().int()).length(7),
        entries: z.array(z.number().int()).length(7).describe('How many work items make up each day: one cell edits one'),
      }),
    ),
  })
  .meta({ id: 'Timesheet' });
export type Timesheet = z.infer<typeof TimesheetSchema>;
export const TimesheetQuery = z.object({
  week: isoDate.optional().describe('Any day of the week; this week by default'),
  user: z.string().optional().describe('Whose (a login); yours by default. Administrators only for others'),
});
export const TimesheetWeekBody = z.object({
  week: isoDate.optional().describe('Any day of the week; this week by default'),
  user: z.string().optional().describe('Whose (a login); yours by default'),
});
export type TimesheetPersonalInput = z.infer<typeof TimesheetPersonalBody>;
export const TimesheetPersonalBody = z.object({
  date: isoDate,
  minutes: z.number().int().min(0).max(24 * 60),
  activity: z.string().min(1).max(100).describe('Their own row\'s name: BAU, or anything they keep'),
  user: z.string().optional().describe('Whose (a login); yours by default. Administrators only for others'),
});
export const TimesheetCellBody = z.object({
  issue: z.string(),
  date: isoDate,
  minutes: z.number().int().min(0).max(24 * 60).describe('0 deletes the entry'),
  type: z.string().nullable().optional().describe("The row's work type (name or id); null for none"),
  user: z.string().optional().describe('Whose (a login); yours by default'),
});
export type TimesheetCellInput = z.infer<typeof TimesheetCellBody>;

// ---------------------------------------------------------------------------
// Chat: Microsoft Teams and Slack (docs/architecture.md, D42)
// ---------------------------------------------------------------------------

export const ChatChannelSchema = z
  .object({
    id: z.string(),
    platform: z.enum(CHAT_PLATFORMS),
    workspace: z.string().describe("The Teams team's name, or the Slack workspace's"),
    name: z.string().describe('The channel\'s name, e.g. "General"'),
    gone: z.string().nullable().describe('Why a4a can no longer post there; null while it can'),
  })
  .meta({ id: 'ChatChannel' });
export type ChatChannel = z.infer<typeof ChatChannelSchema>;

export const ChatSubscriptionSchema = z
  .object({
    id: z.string(),
    channel: ChatChannelSchema,
    target: z.enum(['project', 'search']),
    project: z.object({ key: z.string(), name: z.string() }).nullable(),
    search: z.object({ id: z.string(), name: z.string() }).nullable(),
    kinds: z.array(z.enum(CHAT_CHANGE_KINDS)),
    about: z.string().describe('What the channel hears of, in words: "New issues and state changes in Backend"'),
    createdBy: UserRefSchema.nullable().describe('Who subscribed the channel, and vouches for its people'),
    createdAt: timestamp,
    ended: z
      .object({
        at: timestamp,
        reason: z.string(),
        said: z
          .object({ key: z.string(), values: z.record(z.string(), z.unknown()).optional() })
          .nullable()
          .describe('The reason as a problem’s words, problem.<key> in the catalogs, for a page in another language (D49). Null for a reason a chat service gave in its own code'),
      })
      .nullable()
      .describe('Set when it no longer posts: its channel went, the app was removed, or its subscriber lost the project'),
  })
  .meta({ id: 'ChatSubscription' });
export type ChatSubscription = z.infer<typeof ChatSubscriptionSchema>;

export const CreateChatSubscriptionBody = z.object({
  channel: z.string().min(1).describe("The channel's id, from GET /chat/channels"),
  project: z.string().optional().describe('A project key: its issues'),
  savedSearch: z.string().optional().describe("A saved search's id or name, yours or a shared one: the issues it finds for you"),
  kinds: z
    .array(z.enum(CHAT_CHANGE_KINDS))
    .min(1)
    .default([...DEFAULT_CHAT_KINDS])
    .describe('What the channel hears of: created, state, assigned, commented, fields'),
});
export type CreateChatSubscriptionInput = z.input<typeof CreateChatSubscriptionBody>;
export const UpdateChatSubscriptionBody = z.object({ kinds: z.array(z.enum(CHAT_CHANGE_KINDS)).min(1) });

export const ChatAccountSchema = z
  .object({
    id: z.string(),
    platform: z.enum(CHAT_PLATFORMS),
    workspace: z.string().describe('The Teams tenant or Slack workspace it belongs to'),
    name: z.string().describe('Their name there'),
    linkedAt: timestamp,
    via: z.enum(['link', 'entra']).describe('link: they linked it with a sign-in link. entra: Teams knows them by their Microsoft Entra ID sign-in'),
  })
  .meta({ id: 'ChatAccount' });
export type ChatAccount = z.infer<typeof ChatAccountSchema>;

export const ChatLinkSchema = z
  .object({
    platform: z.enum(CHAT_PLATFORMS),
    workspace: z.string(),
    name: z.string().describe('The chat account to link: its name there'),
    expiresAt: timestamp,
    linkedTo: UserRefSchema.nullable().describe('Who it is linked to already, if anyone'),
  })
  .meta({ id: 'ChatLink' });
export type ChatLink = z.infer<typeof ChatLinkSchema>;

export const ChatStatusSchema = z
  .object({
    teams: z.object({
      configured: z.boolean().describe('TEAMS_APP_ID, TEAMS_APP_PASSWORD and TEAMS_TENANT_ID are set'),
      botId: z.string().nullable(),
      tenantId: z.string().nullable(),
      messagingEndpoint: z.string().describe("The bot's messaging endpoint, for Azure Bot Service"),
      teams: z.array(z.object({ id: z.string(), name: z.string(), installedAt: timestamp, removed: z.string().nullable(), removedSaid: z.object({ key: z.string(), values: z.record(z.string(), z.unknown()).optional() }).nullable().describe('Why it stopped as a problem’s words, problem.<key> in the catalogs, for a page in another language (D49). Null while it runs, for a reason a chat service gave in its own code, and for one kept before a4a kept its words') })),
    }),
    slack: z.object({
      connected: z.boolean(),
      workspace: z.string().nullable(),
      connectedBy: UserRefSchema.nullable(),
      connectedAt: timestamp.nullable(),
      removed: z.string().nullable().describe('Why it stopped: the app was removed, or its token revoked'),
      removedSaid: z.object({ key: z.string(), values: z.record(z.string(), z.unknown()).optional() }).nullable().describe('Why it stopped as a problem’s words, problem.<key> in the catalogs, for a page in another language (D49). Null while it runs, for a reason a chat service gave in its own code, and for one kept before a4a kept its words'),
      requestUrls: z
        .object({ commands: z.string(), interactivity: z.string(), events: z.string() })
        .describe("Where Slack sends what people do, for the app's settings"),
    }),
    matrix: z.object({
      connected: z.boolean(),
      homeserver: z.string().nullable(),
      userId: z.string().nullable().describe("The bot account's Matrix id, e.g. @a4a:matrix.org"),
      connectedBy: UserRefSchema.nullable(),
      connectedAt: timestamp.nullable(),
      removed: z.string().nullable().describe("Why it stopped: an administrator disconnected it, or its token was refused"),
      removedSaid: z.object({ key: z.string(), values: z.record(z.string(), z.unknown()).optional() }).nullable().describe("Why it stopped as a problem's words, problem.<key> in the catalogs, for a page in another language (D49)"),
    }),
    channels: z.array(ChatChannelSchema),
  })
  .meta({ id: 'ChatStatus' });
export type ChatStatus = z.infer<typeof ChatStatusSchema>;

export const ConnectMatrixBody = z.object({
  homeserver: z.string().trim().min(1).max(200).describe("The homeserver's address, e.g. https://matrix.org"),
  accessToken: z.string().trim().min(1).max(500).describe("The bot account's access token, from its settings, kept sealed"),
});
export const ConnectSlackBody = z.object({
  botToken: z.string().trim().regex(/^xoxb-/, "A bot token starts with xoxb-: it's under OAuth & Permissions in the app's settings"),
  signingSecret: z.string().trim().min(16).describe("Under Basic Information in the app's settings"),
});

// ---------------------------------------------------------------------------
// Integrations (docs/architecture.md, D46): CI builds, and code-host accounts people connect
// ---------------------------------------------------------------------------

/** `gitea`: a Gitea or Forgejo integration's Actions runs (D55), as `github` takes a GitHub integration's. */
export const BUILD_SOURCE_KINDS = ['github', 'generic', 'gitea'] as const;
export type BuildSourceKind = (typeof BUILD_SOURCE_KINDS)[number];
export const BUILD_STATUSES = ['success', 'failure', 'cancelled'] as const;
export type BuildStatus = (typeof BUILD_STATUSES)[number];
export const BUILD_ISSUE_OUTCOMES = ['marked', 'already', 'open', 'refused'] as const;
export type BuildIssueOutcome = (typeof BUILD_ISSUE_OUTCOMES)[number];

export const BuildSourceSchema = z
  .object({
    id: z.string(),
    kind: z
      .enum(BUILD_SOURCE_KINDS)
      .describe("github: a GitHub integration's workflow runs. gitea: a Gitea or Forgejo integration's Actions runs. generic: any CI, posting each build with a token"),
    name: z.string(),
    project: z.string().describe('The project whose builds they are, by key'),
    field: z.string().nullable().describe('The build field its builds go in, by name; null when the project has none yet'),
    integration: z.object({ id: z.string(), name: z.string() }).nullable().describe('github, gitea: the integration whose workflow runs it takes'),
    branch: z.string().nullable().describe('github, gitea: the branch whose runs are builds; null: any'),
    workflow: z.string().nullable().describe('github, gitea: the workflow, by name or file (gitea: its file, such as ci.yml); null: any'),
    hookUrl: z.string().nullable().describe('generic: where a CI posts its builds'),
    tokenPrefix: z.string().nullable().describe("generic: the token's first characters, to recognise it by"),
    active: z.boolean(),
    reportCheck: z.boolean().describe('github: report each finished run as a check run on its head commit, as the integration’s GitHub App (D70)'),
    createdAt: timestamp,
    lastBuildAt: timestamp.nullable(),
  })
  .meta({ id: 'BuildSource' });
export type BuildSource = z.infer<typeof BuildSourceSchema>;
export const BuildSourceCreatedSchema = BuildSourceSchema.extend({
  token: z.string().nullable().describe('generic: the token a CI sends as a Bearer token. Shown only once'),
}).meta({ id: 'BuildSourceCreated' });
export type BuildSourceCreated = z.infer<typeof BuildSourceCreatedSchema>;
export const BuildSourceBody = z.object({
  kind: z.enum(BUILD_SOURCE_KINDS),
  name: z.string().trim().min(1).max(120).describe('What it is, e.g. "Jenkins: backend" or "GitHub Actions: CI"'),
  project: z.string().describe('The project whose builds they are'),
  field: z
    .string()
    .nullable()
    .optional()
    .describe('The build field to fill, by name or id. Left out: the project\'s "Fixed in build", or its one build field; with none, a4a makes "Fixed in build" and gives it the project'),
  integration: z
    .string()
    .optional()
    .describe("github: the GitHub integration (its id) whose workflow_run deliveries it takes. gitea: the Gitea or Forgejo integration whose Actions runs it takes"),
  branch: z.string().trim().max(200).nullable().optional().describe('github, gitea: only runs on this branch are builds; null: any'),
  workflow: z
    .string()
    .trim()
    .max(200)
    .nullable()
    .optional()
    .describe('github: only this workflow, by name or file. gitea: by its file, such as ci.yml (Forgejo names no workflow by name). null: any'),
  active: z.boolean().default(true),
  reportCheck: z.boolean().default(false).describe('github: report each run’s own result as a GitHub check run on its head commit'),
});
export const UpdateBuildSourceBody = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  field: z.string().nullable().optional(),
  branch: z.string().trim().max(200).nullable().optional(),
  workflow: z.string().trim().max(200).nullable().optional(),
  active: z.boolean().optional(),
  reportCheck: z.boolean().optional(),
});

export const BuildIssueSchema = z
  .object({
    issue: IssueRefSchema,
    outcome: z
      .enum(BUILD_ISSUE_OUTCOMES)
      .describe('marked: the build field set to this build. already: it named a build already. open: not resolved, so left. refused: a guard or a permission said no'),
    note: z.string().nullable(),
    said: NoteSaidSchema.nullable(),
    commit: z.string().nullable().describe('The commit that tied it to the build'),
  })
  .meta({ id: 'BuildIssue' });
export type BuildIssue = z.infer<typeof BuildIssueSchema>;

export const BuildSchema = z
  .object({
    id: z.string(),
    project: z.string(),
    name: z.string().describe("Its number or name: the build field's value"),
    status: z.enum(BUILD_STATUSES),
    url: z.string().nullable(),
    repository: z.string().nullable(),
    branch: z.string().nullable(),
    headSha: z.string().nullable(),
    commits: z.number().int().describe('How many commits it holds, as far as a4a knows them'),
    marked: z.number().int().describe('Issues it marked as fixed in it'),
    source: z.object({ id: z.string(), name: z.string(), kind: z.enum(BUILD_SOURCE_KINDS) }).nullable(),
    finishedAt: timestamp.nullable(),
    createdAt: timestamp,
    issues: z.array(BuildIssueSchema).describe('What it did to each issue its commits name, that the caller can see'),
  })
  .meta({ id: 'Build' });
export type Build = z.infer<typeof BuildSchema>;

/** What a CI posts: a build, and the commits it holds (their shas, their messages, or a range a4a asks GitHub about). */
export const ReportBuildBody = z.object({
  build: z.string().trim().min(1).max(200).describe('Its number or name, e.g. 1.4.207: the value the build field gets'),
  status: z.enum(BUILD_STATUSES).default('success').describe('Only a successful build goes in the build field and marks issues'),
  url: z.string().max(2000).optional().describe('Where the build is, on the CI'),
  finishedAt: z.string().datetime({ offset: true }).optional(),
  repository: z.string().trim().max(300).optional().describe('owner/name: only commits linked from this repository count'),
  branch: z.string().trim().max(200).optional(),
  commits: z
    .array(z.union([z.string().trim().min(4).max(64), z.object({ sha: z.string().trim().min(4).max(64).optional(), message: z.string().max(20_000).optional() })]))
    .max(2000)
    .optional()
    .describe("The commits it holds since the last build: shas, or { sha, message }, whose messages are read for issue ids too"),
  range: z
    .object({ from: z.string().trim().min(4).max(64), to: z.string().trim().min(4).max(64) })
    .optional()
    .describe('A range of commits (from excluded, to included) for a4a to ask GitHub about, with the access token of a GitHub integration of the repository'),
});

export const BuildReportedSchema = z
  .object({
    build: z.string(),
    status: z.enum(BUILD_STATUSES),
    outcome: z.enum(['recorded', 'again']).describe('again: the build was reported before; what it holds now was added'),
    commits: z.number().int(),
    marked: z.number().int(),
    message: z.string(),
  })
  .meta({ id: 'BuildReported' });
export type BuildReported = z.infer<typeof BuildReportedSchema>;

export const IssueBuildSchema = z
  .object({
    build: z.string(),
    status: z.enum(BUILD_STATUSES),
    url: z.string().nullable(),
    outcome: z.enum(BUILD_ISSUE_OUTCOMES),
    note: z.string().nullable(),
    said: NoteSaidSchema.nullable(),
    commit: z.string().nullable(),
    finishedAt: timestamp.nullable(),
  })
  .meta({ id: 'IssueBuild' });
export type IssueBuild = z.infer<typeof IssueBuildSchema>;

/** Where people connect their own accounts (D46); `gitea` is Gitea or Forgejo, at the address an administrator gives (D54). */
export const CODE_HOSTS = ['github', 'gitlab', 'bitbucket', 'gitea'] as const;
export type CodeHost = (typeof CODE_HOSTS)[number];

export const CodeHostSchema = z
  .object({
    provider: z.enum(CODE_HOSTS),
    name: z.string(),
    available: z.boolean().describe('Whether an administrator has set up signing in there, to connect accounts'),
    revokes: z
      .boolean()
      .nullable()
      .describe(
        "Forgejo and Gitea (D66): whether a4a can take back the token it's given as soon as it has asked who you are, because the instance offers revocation; when false, the token stays good until it expires there, and the page says so before you go on. Null for the hosts whose tokens only read who you are",
      ),
  })
  .meta({ id: 'CodeHost' });
export type CodeHostInfo = z.infer<typeof CodeHostSchema>;
export const ConnectStartSchema = z.object({ url: z.string().describe("The provider's page to sign in and let a4a read who you are") }).meta({ id: 'ConnectStart' });

// ---------------------------------------------------------------------------
// Mobile: push notifications to people's devices (docs/architecture.md, D47)
// ---------------------------------------------------------------------------

export const PushKeySchema = z
  .object({
    enabled: z.boolean().describe('Whether this server sends push notifications (PUSH)'),
    publicKey: z.string().nullable().describe("The server's VAPID public key, base64url: the applicationServerKey a browser subscribes with"),
  })
  .meta({ id: 'PushKey' });
export type PushKey = z.infer<typeof PushKeySchema>;

export const PushDeviceSchema = z
  .object({
    id: z.string(),
    label: z.string().describe('What the device is, from its browser: "Chrome on Android"'),
    service: z.string().describe("The push service's host, e.g. fcm.googleapis.com"),
    createdAt: timestamp,
    lastSentAt: timestamp.nullable(),
    lastError: z.string().nullable().describe('What the push service last refused, while it hasn’t sent since'),
    current: z.boolean().describe('Whether it is the device that asked (the endpoint given in ?endpoint=)'),
  })
  .meta({ id: 'PushDevice' });
export type PushDevice = z.infer<typeof PushDeviceSchema>;

/** A browser's PushSubscription, as its toJSON() gives it. */
export const PushSubscriptionBody = z.object({
  endpoint: z.string().url().max(2000).describe("The push service's address for this device"),
  expirationTime: z.number().nullable().optional(),
  keys: z.object({
    p256dh: z.string().min(80).max(100).describe("The device's P-256 public key, base64url"),
    auth: z.string().min(16).max(32).describe("The device's authentication secret, base64url"),
  }),
  /** The address it had before, when the browser renewed it (pushsubscriptionchange). */
  oldEndpoint: z.string().url().max(2000).optional(),
});
export type PushSubscriptionInput = z.infer<typeof PushSubscriptionBody>;

export const PushTestResultSchema = z
  .object({
    sent: z.number().int().describe('Devices the push services took it for'),
    failed: z.array(z.object({ device: z.string(), error: z.string() })),
    ended: z.number().int().describe('Devices the push service said are gone, now forgotten'),
  })
  .meta({ id: 'PushTestResult' });
export type PushTestResult = z.infer<typeof PushTestResultSchema>;

// ---------------------------------------------------------------------------
// Help desk in depth: SLAs, a mailbox per desk, requester accounts, team replies by email,
// subscriptions by kind (docs/architecture.md, D45)
// ---------------------------------------------------------------------------

export const SlaPolicySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    query: z.string().describe('The requests it covers, in the search language; empty for every request'),
    firstResponseMinutes: z.number().int().nullable().describe("Business minutes to the team's first public reply; null for no such target"),
    resolutionMinutes: z.number().int().nullable().describe('Business minutes to resolved; null for no such target'),
    warnMinutes: z.number().int().describe('Business minutes before a target that it turns at risk'),
    position: z.number().int().describe('Policies are tried in this order; the first a request matches covers it'),
  })
  .meta({ id: 'SlaPolicy' });
export type SlaPolicy = z.infer<typeof SlaPolicySchema>;

const slaTargetMinutes = z.number().int().min(1).max(366 * 24 * 60);
export const SlaPolicyBody = z.object({
  name: z.string().trim().min(1).max(100),
  query: z.string().trim().max(2000).default(''),
  firstResponseMinutes: slaTargetMinutes.nullable().default(null),
  resolutionMinutes: slaTargetMinutes.nullable().default(null),
  warnMinutes: z.number().int().min(0).max(30 * 24 * 60).default(60),
});
export type SlaPolicyInput = z.input<typeof SlaPolicyBody>;
export const SlaPolicyOrderBody = z.object({ ids: z.array(z.string()).min(1).max(100).describe('Every policy of the desk, in the order to try them') });

/** Met and breached, by policy, per week (D45): each target counted in the week it stopped or went past. */
export const SlaReportSchema = z
  .object({
    timeZone: z.string(),
    weeks: z.array(
      z.object({
        week: isoDate.describe('The Monday it starts on'),
        policies: z.array(
          z.object({
            policy: z.string().describe("The policy's name, or (none)"),
            firstResponse: z.object({ met: z.number().int(), breached: z.number().int() }),
            resolution: z.object({ met: z.number().int(), breached: z.number().int() }),
          }),
        ),
      }),
    ),
    groups: z
      .array(
        z.object({
          group: z.string().nullable().describe("The customer group's name (D56); null for requests in none"),
          firstResponse: z.object({ met: z.number().int(), breached: z.number().int() }),
          resolution: z.object({ met: z.number().int(), breached: z.number().int() }),
        }),
      )
      .describe('Met and breached over the whole period, by customer group (D56), each target counted as the weeks count it'),
  })
  .meta({ id: 'SlaReport' });
export type SlaReport = z.infer<typeof SlaReportSchema>;

/** A desk's own mailbox (D45), read beside the shared one: its password is never shown again. */
export const DeskMailboxSchema = z
  .object({
    imap: z
      .object({ host: z.string(), port: z.number().int(), user: z.string(), folder: z.string(), secure: z.boolean() })
      .nullable()
      .describe('Its own IMAP mailbox, read by the server; null when it has none'),
    fromName: z.string().nullable().describe("The name mail to its requesters comes from, beside the desk's address"),
    lastReadAt: timestamp.nullable(),
    lastError: z.string().nullable(),
  })
  .meta({ id: 'DeskMailbox' });
export type DeskMailbox = z.infer<typeof DeskMailboxSchema>;
export const DeskMailboxBody = z.object({
  imapUrl: z
    .string()
    .trim()
    .max(2000)
    .nullable()
    .optional()
    .describe('imaps://user:password@host[:port][/folder]; null removes it, left out keeps it. imap:// must upgrade with STARTTLS'),
  fromName: z.string().trim().max(100).nullable().optional(),
});

/** How one desk signs its requesters in (D63), as its sign-in page and the portal say it. */
export const PortalDeskSignInSchema = z
  .object({
    desk: z.object({ key: z.string(), name: z.string() }),
    link: z.boolean(),
    password: z.boolean(),
    providers: z.array(z.object({ id: z.string(), name: z.string() })),
    passkey: z.boolean().describe('A passkey of theirs signs them in there (D69)'),
  })
  .meta({ id: 'PortalDeskSignIn' });
export type PortalDeskSignIn = z.infer<typeof PortalDeskSignInSchema>;

/**
 * The language a requester chose on the portal before signing in (D63's revisit), sent with the sign-in:
 * theirs from then on, if they had chosen none. Asking for a link carries none, so nothing unauthenticated
 * changes a requester.
 */
const portalChosenLocale = z
  .enum(LOCALES)
  .optional()
  .describe("The language they chose on the portal's page before signing in: theirs from now on, if they have chosen none (D63's revisit)");

/** A requester signed in to the portal (D45). */
export const PortalMeSchema = z
  .object({
    name: z.string(),
    email: z.string(),
    locale: z
      .enum(LOCALES)
      .nullable()
      .describe("The language they chose for the portal and every email to them (D63's revisit). Null: their browser's, else the server's default"),
    defaultLocale: z.enum(LOCALES).describe("The server's default language, for a browser that asks for none a4a speaks"),
    groups: z
      .array(
        z.object({
          id: z.string(),
          desk: z.object({ key: z.string(), name: z.string() }),
          name: z.string(),
          sharing: z.enum(['read', 'comment']),
          copies: z.boolean().describe('Whether its new requests copy them by email (D56): false once they stopped its emails, from an email or here'),
        }),
      )
      .describe("The customer groups they're in that share requests with them (D56)"),
    signedInWith: z
      .object({ method: z.enum(PORTAL_SIGN_IN_METHODS), provider: z.object({ id: z.string(), name: z.string() }).nullable() })
      .describe('How this session was opened (D63): it opens the requests of desks that take that way'),
    password: z.boolean().describe('They have a password'),
    passwords: z.boolean().describe('A desk here takes passwords, so setting one is of use'),
    elsewhere: z.array(PortalDeskSignInSchema).describe('Desks with requests of theirs that this session does not open, and how each signs them in'),
  })
  .meta({ id: 'PortalMe' });
export type PortalMe = z.infer<typeof PortalMeSchema>;

export const PortalRequestSchema = z
  .object({
    id: z.string().describe("The request's issue id"),
    desk: z.object({ key: z.string(), name: z.string() }),
    summary: z.string(),
    state: z.object({ name: z.string().nullable(), resolved: z.boolean() }),
    createdAt: timestamp,
    updatedAt: timestamp,
    requester: z.object({ name: z.string(), mine: z.boolean().describe("Theirs; otherwise a colleague's, shared with their customer group, or one they're copied on") }),
    copied: z.boolean().describe('They are copied on it (D57): told of it by email, and they may reply'),
    group: z.string().nullable().describe('The customer group it was filed under, when it shares with its members (D56)'),
    private: z.boolean().describe('Theirs, and kept from their group: only they and the team see it'),
    canReply: z.boolean().describe('Theirs, one they are copied on, or shared with their group to comment on'),
  })
  .meta({ id: 'PortalRequest' });
export type PortalRequest = z.infer<typeof PortalRequestSchema>;

export const PortalRequestDetailSchema = PortalRequestSchema.extend({
  description: z.string(),
  messages: z.array(
    z.object({
      id: z.string(),
      from: z.enum(['you', 'team', 'colleague', 'cc']).describe('colleague: its requester, or someone of their organization; cc: someone copied on it (D57)'),
      name: z.string(),
      text: z.string(),
      at: timestamp,
      aiDrafted: z.boolean().describe('Its saved words came from an accepted suggestion (D59): said beside them to the requester too, who asked for them'),
    }),
  ),
  ccs: z
    .array(PortalCcSchema)
    .nullable()
    .describe('Who is copied on it (D57): shown to its requester, who may copy more people and take anyone off (D67); null to anyone else'),
  held: z
    .array(HeldCcSchema)
    .nullable()
    .describe('Whom the Cc of the email that opened it named, waiting for its requester to confirm or drop them (D67); null to anyone else'),
  ccsMax: z.number().int().describe('The most its desk copies on a request at once (D67)'),
}).meta({ id: 'PortalRequestDetail' });
export type PortalRequestDetail = z.infer<typeof PortalRequestDetailSchema>;

export const PortalDeskSchema = z.object({ key: z.string(), name: z.string() }).meta({ id: 'PortalDesk' });
export type PortalDesk = z.infer<typeof PortalDeskSchema>;

export const PortalSignInBody = z.object({
  email: z.string().trim().email().max(320),
  desk: z.string().trim().max(20).optional().describe('The desk whose page they signed in from'),
});
export const PortalRedeemBody = z.object({ token: z.string().min(10).max(200), locale: portalChosenLocale });
/** What a requester changes of their own on the portal: the name the team sees, and their language (D63's revisit). Left out, each stays. */
export const PortalMeUpdateBody = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  locale: z.enum(LOCALES).nullable().optional().describe("The language for the portal and every email to them; null for their browser's again (D63's revisit)"),
});
export const PortalNewRequestBody = z.object({
  desk: z.string().trim().min(1).max(20),
  group: z.string().trim().max(100).optional().describe("Which of their several groups at the desk this one is for (D56's revisit): its name, when there are several"),
  summary: z.string().trim().min(1).max(500),
  description: z.string().max(50_000).default(''),
  private: z.boolean().default(false).describe("Keep it from their customer group's other members (D56)"),
});
export const PortalRequestUpdateBody = z.object({ private: z.boolean().describe("Keep it from their customer group's other members, or share it again (D56)") });
export const PortalReplyBody = z.object({
  text: z.string().trim().min(1).max(50_000),
  aiDrafted: z.boolean().optional().describe('True when the saved words came from an accepted suggestion (D59); an edit that does not say so clears the mark'),
});

const kindChoice = z.object({ inbox: z.boolean(), email: z.boolean() });
/** For each kind of change, whether it reaches the inbox and email (D45). Kinds left out keep their default. */
export const NotifyKindsSchema = z
  .partialRecord(z.enum(NOTIFY_KINDS), kindChoice)
  .describe('created, commented, state, assigned, fields, linked, attachments, sla: each { inbox, email }')
  .meta({ id: 'NotifyKinds' });
export type NotifyKinds = z.infer<typeof NotifyKindsSchema>;
export const NotifyKindsBody = z.object({
  watching: NotifyKindsSchema.optional().describe('For issues they watch'),
  defaults: NotifyKindsSchema.optional().describe('For subscriptions that say nothing of their own'),
});
export const NotifyKindsSettingsSchema = z
  .object({
    watching: z.record(z.enum(NOTIFY_KINDS), kindChoice),
    defaults: z.record(z.enum(NOTIFY_KINDS), kindChoice),
    always: z.array(z.string()).describe('What always tells them, whatever they choose: being mentioned, being assigned'),
    subscriptions: z.array(z.object({ id: z.string(), kinds: NotifyKindsSchema.nullable().describe("Its own choice; null follows the defaults") })),
  })
  .meta({ id: 'NotifyKindsSettings' });
export const SubscriptionKindsBody = z.object({ kinds: NotifyKindsSchema.nullable() });
export type NotifyKindsSettings = z.infer<typeof NotifyKindsSettingsSchema>;

// ---------------------------------------------------------------------------
// Apps (docs/architecture.md, D48)
// ---------------------------------------------------------------------------

/** What an app may read or write: each a part of a4a. */
export const APP_RESOURCES = ['issues', 'comments', 'articles', 'fields', 'time'] as const;
export type AppResource = (typeof APP_RESOURCES)[number];

/** Where a widget can be drawn. */
export const APP_EXTENSION_POINTS = ['issue-panel', 'issue-below-summary', 'project-settings', 'main-menu', 'dashboard', 'article-panel'] as const;
export type AppExtensionPoint = (typeof APP_EXTENSION_POINTS)[number];

export const APP_SETTING_TYPES = ['text', 'number', 'boolean', 'choice', 'secret'] as const;
export type AppSettingType = (typeof APP_SETTING_TYPES)[number];

/** What a permission lets an app do, in the words its consent shows. */
export const APP_PERMISSION_WORDS: Record<'read' | 'write', Record<AppResource, string>> = {
  read: {
    issues: 'Read issues: their summaries, descriptions, fields, tags and links',
    comments: 'Read comments',
    articles: 'Read articles',
    fields: "Read projects' fields and their values",
    time: 'Read logged time',
  },
  write: {
    issues: 'Create and change issues',
    comments: 'Write comments',
    articles: 'Write and change articles',
    fields: "Add values to projects' fields",
    time: 'Log time',
  },
};

export const AppPermissionsSchema = z
  .object({
    read: z.array(z.enum(APP_RESOURCES)).default([]).describe('What it reads'),
    write: z.array(z.enum(APP_RESOURCES)).default([]).describe('What it writes'),
  })
  .meta({ id: 'AppPermissions' });
export type AppPermissions = z.infer<typeof AppPermissionsSchema>;

export const AppSettingDefSchema = z
  .object({
    name: z.string(),
    title: z.string(),
    type: z.enum(APP_SETTING_TYPES),
    scope: z.enum(['app', 'project']).describe('app: one value for the whole a4a; project: a value per project'),
    description: z.string().nullable(),
    required: z.boolean(),
    default: z.union([z.string(), z.number(), z.boolean()]).nullable(),
    choices: z.array(z.string()).nullable(),
  })
  .meta({ id: 'AppSettingDef' });
export type AppSettingDef = z.infer<typeof AppSettingDefSchema>;

export const AppPartSchema = z.object({ name: z.string(), title: z.string(), uses: AppPermissionsSchema });
export type AppPart = z.infer<typeof AppPartSchema>;

export const AppWidgetSchema = AppPartSchema.extend({
  at: z.enum(APP_EXTENSION_POINTS),
  height: z.number().int().describe('Its starting height in pixels; the widget may ask for another, which a4a keeps between 80 and 800'),
}).meta({ id: 'AppWidget' });
export type AppWidget = z.infer<typeof AppWidgetSchema>;

export const AppRuleRefSchema = z.object({ id: z.string(), name: z.string(), enabled: z.boolean(), lastRunAt: timestamp.nullable() });

/** An installed app, as an administrator sees it. */
export const AppSchema = z
  .object({
    name: z.string().describe('Its name, from its manifest: how the API and its widgets know it'),
    title: z.string(),
    version: z.string(),
    vendor: z.string().nullable(),
    description: z.string(),
    iconUrl: z.string().nullable(),
    enabled: z.boolean().describe('Off: none of it runs or shows, anywhere'),
    allProjects: z.boolean().describe('Enabled for every project; otherwise for the projects listed'),
    projects: z
      .array(
        z.object({
          key: z.string(),
          name: z.string(),
          enabled: z.boolean().describe('Whether it runs and shows there now'),
          off: z.boolean().describe('Its managers turned it off there'),
        }),
      )
      .describe('The projects it was chosen for, and those whose managers turned it off'),
    granted: AppPermissionsSchema.describe('What it may do, as the administrator who installed or last updated it accepted'),
    words: z.array(z.string()).describe('What it may do, in words'),
    widgets: z.array(AppWidgetSchema),
    handlers: z.array(AppPartSchema),
    rules: z.array(AppRuleRefSchema),
    settings: z.array(AppSettingDefSchema),
    source: z.object({ kind: z.enum(['upload', 'catalog']), catalog: z.string().nullable() }),
    sha256: z.string(),
    agent: UserRefSchema.describe('Its agent: who its rules act as'),
    installedBy: UserRefSchema.nullable(),
    installedAt: timestamp,
    updatedAt: timestamp,
  })
  .meta({ id: 'App' });
export type App = z.infer<typeof AppSchema>;

/** What a package is and asks for, read before anything is installed. */
export const AppPackagePreviewSchema = z
  .object({
    name: z.string(),
    title: z.string(),
    version: z.string(),
    vendor: z.string().nullable(),
    description: z.string(),
    sha256: z.string(),
    bytes: z.number().int(),
    files: z.number().int(),
    asks: AppPermissionsSchema,
    words: z.array(z.string()).describe('What it asks for, in words: what the administrator accepts'),
    widgets: z.array(AppWidgetSchema),
    handlers: z.array(AppPartSchema),
    rules: z.array(AppPartSchema.extend({ kind: z.string() })),
    settings: z.array(AppSettingDefSchema),
    signedBy: z.string().nullable().describe("The trusted key that signed it, by its fingerprint; null when it isn't signed"),
    installed: z.object({ version: z.string(), granted: AppPermissionsSchema }).nullable().describe('The version installed now, and what it was granted'),
    more: AppPermissionsSchema.nullable().describe('What it asks beyond what the installed version was granted: an update asks again only for these'),
  })
  .meta({ id: 'AppPackagePreview' });
export type AppPackagePreview = z.infer<typeof AppPackagePreviewSchema>;

const appProjectChoice = {
  allProjects: z.boolean().optional().describe('Enable it for every project'),
  projects: z.array(z.string()).optional().describe('Or for these projects, by key'),
};

export const AppPackageBody = z.object({
  package: z.string().min(1).max(12_000_000).describe('The package, a zip, in base64'),
});
export const InstallAppBody = AppPackageBody.extend({
  accept: AppPermissionsSchema.describe('What the administrator accepts: exactly what it asks for'),
  ...appProjectChoice,
});
export type InstallAppInput = z.input<typeof InstallAppBody>;
export const UpdateAppPackageBody = AppPackageBody.extend({
  accept: AppPermissionsSchema.optional().describe('Needed only when it asks for more than it was granted: all that it asks for then'),
});

export const CatalogAppSchema = z
  .object({
    catalog: z.string().describe('The catalog it is listed in, by its address'),
    catalogName: z.string(),
    name: z.string(),
    title: z.string(),
    version: z.string(),
    vendor: z.string().nullable(),
    description: z.string(),
    sha256: z.string(),
    signed: z.boolean(),
    installed: z.string().nullable().describe('The version installed here, if any'),
    update: z.boolean().describe('A newer version than the one installed'),
  })
  .meta({ id: 'CatalogApp' });
export type CatalogApp = z.infer<typeof CatalogAppSchema>;
export const CatalogListSchema = z.object({
  apps: z.array(CatalogAppSchema),
  problems: z.array(z.object({ catalog: z.string(), message: z.string() })).describe("Catalogs that couldn't be read, and why"),
});
export type CatalogList = z.infer<typeof CatalogListSchema>;
export const CatalogPickBody = z.object({
  catalog: z.string().describe('The catalog, by its address'),
  name: z.string(),
  version: z.string().optional().describe('Its newest, when left out'),
});
export const CatalogInstallBody = CatalogPickBody.extend({ accept: AppPermissionsSchema.optional(), ...appProjectChoice });
export const UpdateAppBody = z.object({ enabled: z.boolean().optional(), ...appProjectChoice });

export const ProjectAppSchema = z
  .object({
    name: z.string(),
    title: z.string(),
    version: z.string(),
    description: z.string(),
    enabled: z.boolean().describe('It runs and shows in this project'),
    off: z.boolean().describe("The project's managers turned it off here"),
    granted: AppPermissionsSchema.describe('What it may do, as the administrator who installed or last updated it accepted'),
    words: z.array(z.string()).describe('What it may do, in words'),
    settings: z.array(AppSettingDefSchema).describe('Its settings that take a value per project'),
  })
  .meta({ id: 'ProjectApp' });
export type ProjectApp = z.infer<typeof ProjectAppSchema>;

export const AppSettingsSchema = z
  .object({
    project: z.string().nullable(),
    values: z.record(z.string(), z.unknown()).describe("A secret's value is never sent back: it reads as { set: true } or { set: false }"),
  })
  .meta({ id: 'AppSettings' });
export type AppSettings = z.infer<typeof AppSettingsSchema>;
export const SetAppSettingsBody = z.object({
  project: z.string().nullable().optional().describe("A project's values, by key; left out, the app's own"),
  values: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).describe('null clears one'),
});

export const AppExtensionSchema = z
  .object({
    app: z.string(),
    appTitle: z.string(),
    name: z.string(),
    title: z.string(),
    at: z.enum(APP_EXTENSION_POINTS),
    url: z.string().describe("Where its frame loads from: an address a4a signed for a while, under the app's files"),
    height: z.number().int(),
    uses: AppPermissionsSchema.describe('What this widget may ask a4a for, within what the app was granted'),
  })
  .meta({ id: 'AppExtension' });
export type AppExtension = z.infer<typeof AppExtensionSchema>;

export const AppRunSchema = z
  .object({
    id: z.string(),
    kind: z.enum(['handler', 'rule']),
    name: z.string(),
    outcome: z.string(),
    message: z.string(),
    ms: z.number().int().nullable(),
    issue: z.string().nullable(),
    by: UserRefSchema.nullable(),
    at: timestamp,
  })
  .meta({ id: 'AppRun' });
export type AppRun = z.infer<typeof AppRunSchema>;

export const AppRemovalSchema = z
  .object({
    name: z.string(),
    title: z.string(),
    rules: z.number().int(),
    widgets: z.number().int(),
    handlers: z.number().int(),
    settings: z.number().int().describe('Values set, app-wide and per project'),
    stored: z.number().int().describe('Keys it stored'),
    runs: z.number().int().describe('Runs in its log'),
    agent: z.string().describe("Its agent's login: its account goes too, or is banned if history names it"),
  })
  .meta({ id: 'AppRemoval' });
export type AppRemoval = z.infer<typeof AppRemovalSchema>;

export const AppHandlerBody = z.object({
  issue: z.string().optional().describe('The issue it is about, by id'),
  project: z.string().optional().describe('The project it is about, by key, when no issue is'),
  body: z.unknown().optional().describe('Whatever the handler takes, as JSON'),
});
export const AppHandlerResultSchema = z
  .object({
    response: z.unknown().describe('What the handler answered, with respond()'),
    applied: z.number().int(),
    commented: z.number().int(),
  })
  .meta({ id: 'AppHandlerResult' });
export type AppHandlerResult = z.infer<typeof AppHandlerResultSchema>;

export const AppStorageSchema = z
  .object({
    project: z.string().nullable(),
    values: z.record(z.string(), z.unknown()),
    bytes: z.number().int(),
    limitBytes: z.number().int(),
  })
  .meta({ id: 'AppStorage' });
export type AppStorage = z.infer<typeof AppStorageSchema>;
export const AppStorageBody = z.object({ value: z.unknown().describe('Any JSON; null removes the key') });

// ---------------------------------------------------------------------------
// Renaming a project's key (D52)
// ---------------------------------------------------------------------------

export const RenameProjectKeyBody = z.object({
  key: CreateProjectBody.shape.key.describe("The new key, checked as a new project's is. Its issues keep their numbers: BACK-12 becomes CORE-12"),
  expectedKey: z
    .string()
    .max(10)
    .optional()
    .describe('The key as you last saw it. If someone renamed the project meanwhile, nothing changes and the answer is 409, with the key it has now'),
});
export type RenameProjectKeyInput = z.infer<typeof RenameProjectKeyBody>;

// ---------------------------------------------------------------------------
// Customer groups in the help desk (wave 4: docs/architecture.md, D56)
// ---------------------------------------------------------------------------

/** What a customer group's members do with each other's requests on the portal. */
export const CUSTOMER_SHARING = ['none', 'read', 'comment'] as const;
export type CustomerSharing = (typeof CUSTOMER_SHARING)[number];

const emailDomain = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, 'Expected an email domain, such as acme.com');

export const CustomerGroupSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    domains: z.array(z.string()).describe('Email domains that put a requester in it by themselves, matched whole'),
    sharing: z.enum(CUSTOMER_SHARING).describe("none; read: its members see each other's requests on the portal; comment: and answer them"),
    businessHours: BusinessHoursSchema.nullable().describe("Its own working hours and holidays, which its requests' SLAs count in; null keeps the desk's"),
    agents: z
      .array(
        z.object({
          user: UserRefSchema,
          assignable: z.boolean().describe('Whether the help desk can give them a request now: someone of the project who may change its issues'),
        }),
      )
      .describe("Its dedicated agents, in order: its members' new requests go to whoever has the fewest open"),
    members: z.number().int().describe('Requesters added by hand'),
    people: z.number().int().describe('Everyone in it now, by hand and by its domains, who would be copied on a new request of its (D56): not the team, nor anyone who stopped its emails'),
    stops: z.number().int().describe('Its people who stopped its emails (D56): its requests copy them no more'),
    openRequests: z.number().int().describe('Its requests not yet resolved'),
    provider: z
      .object({ id: z.string(), name: z.string() })
      .nullable()
      .describe('The identity provider its people sign in to the portal through at this desk (D63), and no other way; null: as the desk takes'),
  })
  .meta({ id: 'CustomerGroup' });
export type CustomerGroup = z.infer<typeof CustomerGroupSchema>;

export const CustomerGroupBody = z.object({
  name: z.string().trim().min(1).max(100),
  domains: z.array(emailDomain).max(50).default([]),
  sharing: z.enum(CUSTOMER_SHARING).default('none'),
  businessHours: BusinessHoursSchema.nullable().default(null),
  agents: z.array(z.string().trim().min(1).max(100)).max(20).default([]).describe('Logins, in the order to prefer them'),
  provider: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .nullable()
    .optional()
    .describe("The id of one of the desk's identity providers its people sign in through, and no other way (D63); null for none. Left out keeps it"),
});
export type CustomerGroupInput = z.input<typeof CustomerGroupBody>;

export const CustomerGroupMemberSchema = z
  .object({
    requester: z.object({ id: z.string(), name: z.string(), email: z.string() }),
    addedAt: timestamp,
    addedBy: z.string().nullable().describe('Who added them, by login'),
  })
  .meta({ id: 'CustomerGroupMember' });
export type CustomerGroupMember = z.infer<typeof CustomerGroupMemberSchema>;

/** Someone of a customer group who stopped its emails (D56): from a group copy's email, or on the portal. Their own choice, which only they undo. */
export const GroupCopyStopSchema = z
  .object({
    requester: z.object({ id: z.string(), name: z.string(), email: z.string() }),
    stoppedAt: timestamp,
  })
  .meta({ id: 'GroupCopyStop' });
export type GroupCopyStop = z.infer<typeof GroupCopyStopSchema>;

/** A requester's switch, on the portal, for a group of theirs: whether its new requests copy them by email (D56). */
export const PortalGroupCopiesBody = z.object({ copies: z.boolean().describe('true: copy me on its new requests from now on; false: stop, and take me off its open ones') });

export const CustomerGroupMemberBody = z.object({
  email: z.string().trim().email().max(320),
  name: z.string().trim().max(200).optional().describe('Their name, when they have never asked for help: else the part of the address before the @'),
});

export const RequestUpdateBody = z.object({
  group: z.string().trim().min(1).max(100).nullable().optional().describe("The desk's customer group, by id or name; null for none. Left out keeps it"),
  private: z.boolean().optional().describe("Keep it from its group's other members on the portal, or share it again"),
  expectedVersion: z.number().int().optional().describe("The issue's version as you last saw it: 409 if someone changed it since"),
});

// ---------------------------------------------------------------------------
// CCs on help desk requests (D57)
// ---------------------------------------------------------------------------

export const RequestCcBody = z.object({
  email: z.string().trim().max(HELP_LIMITS.email).email().describe('Their email address'),
  name: z.string().trim().max(HELP_LIMITS.name).optional().describe('Their name, if known'),
});
export const RequestCcQuery = z.object({ email: z.string().trim().min(3).max(HELP_LIMITS.email).describe('The address to stop copying') });

// ---------------------------------------------------------------------------
// AI help with writing and reading (D59)
// ---------------------------------------------------------------------------

/** What the assistant does to a text: fixes it, rewrites it one way, carries it on, or drafts it from a line. */
export const WRITING_ACTIONS = ['fix', 'shorter', 'clearer', 'formal', 'friendlier', 'continue', 'draft'] as const;
export type WritingAction = (typeof WRITING_ACTIONS)[number];
/** The fields a4a gives for writing: an issue's description, a comment, an article, a reply to a help desk request's requester. */
export const WRITING_FIELDS = ['description', 'comment', 'article', 'reply'] as const;
export type WritingField = (typeof WRITING_FIELDS)[number];
/** The most a text sent for writing help may be, in characters: each action takes less (D59). */
export const WRITING_TEXT_MAX = 100_000;

export const WritingForSchema = z
  .object({
    kind: z.enum(WRITING_FIELDS).describe("The field it's written in. A reply goes to a help desk request's requester, and is drafted from what they can read"),
    issue: z.string().max(60).optional().describe('The issue it belongs to, by readable id; a reply needs it'),
    article: z.string().max(60).optional().describe('The article it belongs to, by readable id'),
    project: z.string().max(40).optional().describe('The project key, for an issue or an article not made yet'),
    title: z.string().max(500).optional().describe("A new issue's summary or a new article's title, as typed so far"),
  })
  .meta({ id: 'WritingFor' });
export type WritingFor = z.infer<typeof WritingForSchema>;

export const WriteBody = z.object({
  action: z
    .enum(WRITING_ACTIONS)
    .describe(
      "fix: its spelling and grammar. shorter, clearer, formal, friendlier: it rewritten so. continue: what comes next. draft: a text written from the line sent; for a reply, from the request's public conversation, the line saying what to answer, if anything",
    ),
  text: z.string().max(WRITING_TEXT_MAX).describe('Markdown: the selection, or the whole field; for draft, the line to write from'),
  for: WritingForSchema.optional().describe('Where the text goes. continue and draft read it for what they write'),
});
export type WriteInput = z.infer<typeof WriteBody>;

export const WriteResultSchema = z
  .object({
    action: z.enum(WRITING_ACTIONS),
    text: z.string().describe('The suggestion, in Markdown. It replaces the text sent; for continue, it follows it. Nothing is saved'),
    model: z.string(),
  })
  .meta({ id: 'WriteResult' });
export type WriteResult = z.infer<typeof WriteResultSchema>;

export const SummaryLanguageQuery = z.object({
  language: z.enum(LOCALES).optional().describe("The summary's language; left out, the reader's (D49)"),
});

export const SummarizeTextBody = z.object({
  text: z.string().min(1).max(WRITING_TEXT_MAX).describe('Markdown to summarise, such as what someone selected'),
  language: z.enum(LOCALES).optional().describe("The summary's language; left out, the reader's (D49)"),
});

export const TextSummarySchema = z
  .object({
    summary: z.string().describe('Markdown. Shown, never saved'),
    language: z.enum(LOCALES),
    partial: z.boolean().describe('The text was too long to read whole: it is of its start'),
    model: z.string(),
  })
  .meta({ id: 'TextSummary' });
export type TextSummary = z.infer<typeof TextSummarySchema>;

export const SummaryCommentBody = z.object({
  text: z.string().min(1).max(50_000).describe('The summary, exactly as it came'),
  token: z.string().min(1).max(400).describe("The summary's `post` token"),
});

export const SuggestedSummarySchema = z
  .object({
    current: z.string().describe("The issue's summary now"),
    summary: z.string().describe('A clearer one, in the same language. Nothing changes until someone saves it'),
    version: z.number().int().describe("The issue's version it was read at: send it as expectedVersion with the change"),
    model: z.string(),
  })
  .meta({ id: 'SuggestedSummary' });
export type SuggestedSummary = z.infer<typeof SuggestedSummarySchema>;

// ---------------------------------------------------------------------------
// Whiteboards (D58)
// ---------------------------------------------------------------------------

const wbCoord = z.number().finite().min(-WHITEBOARD_LIMITS.coordinate).max(WHITEBOARD_LIMITS.coordinate);
const wbSize = z.number().finite().min(WHITEBOARD_LIMITS.minSize).max(WHITEBOARD_LIMITS.maxSize);
const wbZ = z.number().finite().min(-1e9).max(1e9);
const wbText = z.string().max(WHITEBOARD_LIMITS.text);
const wbLabel = z.string().max(WHITEBOARD_LIMITS.label);

export const WhiteboardElementId = z
  .string()
  .regex(/^[A-Za-z0-9_-]{6,64}$/, 'An element’s id is 6 to 64 letters, digits, hyphens or underscores')
  .describe('Chosen by whoever adds it (a random UUID will do), so an arrow can name an element added in the same batch, and undoing a removal adds it back as it was');

export const WhiteboardElementSchema = z
  .object({
    id: z.string(),
    kind: z.enum(WHITEBOARD_KINDS).describe('note, text (a label or heading), issue or article (a card), arrow, section (a frame that groups what lies inside it), ink (a freehand drawing) or image (a picture)'),
    x: z.number(),
    y: z.number(),
    w: z.number(),
    h: z.number(),
    z: z.number().describe('Stacking order: higher is drawn over lower'),
    text: z.string().nullable().describe("A note's or a text block's words; a section's title"),
    tone: z.enum(WHITEBOARD_TONES).nullable().describe("A note's tone: what it is, as a meaning (an idea, agreed, a question, a problem, parked)"),
    label: z.string().nullable().describe("An arrow's label"),
    from: z.string().nullable().describe("An arrow's start: an element's id"),
    to: z.string().nullable().describe("An arrow's end: an element's id"),
    linked: z.string().nullable().describe('An arrow made into a link between its two issues: the link, as said from its start, e.g. "depends on"'),
    points: z.string().nullable().describe("A freehand drawing's stroke (D58's revisit): points in its own box, as `x,y x,y`..."),
    attachment: z.string().nullable().describe("A picture on the whiteboard: its attachment's id, uploaded through the whiteboard's own route"),
    seq: z.number().int().describe('The whiteboard’s change that last changed it'),
    version: z.number().int().describe('Raised by each change to it'),
    updatedAt: timestamp,
    updatedBy: UserRefSchema.nullable(),
  })
  .meta({ id: 'WhiteboardElement' });
export type WhiteboardElement = z.infer<typeof WhiteboardElementSchema>;

/**
 * What an issue or article card holds, as the caller may see it now. One they may not see (limited,
 * a project they're not in, deleted) is `shown: false` and nothing else, the same for every reason.
 */
export const WhiteboardCardSchema = z
  .object({
    element: z.string(),
    shown: z.boolean(),
    id: z.string().optional().describe('BACK-12, or BACK-A-3 for an article'),
    summary: z.string().optional().describe("The issue's summary, or the article's title"),
    state: OptionValueSchema.nullable().optional(),
    assignee: UserRefSchema.nullable().optional(),
    resolved: z.boolean().optional(),
  })
  .meta({ id: 'WhiteboardCard' });
export type WhiteboardCard = z.infer<typeof WhiteboardCardSchema>;

export const WhiteboardViewerSchema = z
  .object({ user: UserRefSchema, since: timestamp.describe('Looking since') })
  .meta({ id: 'WhiteboardViewer' });
export type WhiteboardViewer = z.infer<typeof WhiteboardViewerSchema>;

export const WhiteboardSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    /** Null for a person's own whiteboard, shared with people and groups or limited to some (D58's revisit). */
    project: ProjectRefSchema.nullable(),
    /** Its project's whiteboards have no owner; a person's does, whoever made it. */
    owner: UserRefSchema.nullable().describe('Who it belongs to, for a person’s own whiteboard'),
    createdBy: UserRefSchema.nullable(),
    createdAt: timestamp,
    updatedAt: timestamp,
    seq: z.number().int().describe('Its latest change; its live stream resumes after it'),
    elements: z.number().int(),
    /** A personal whiteboard's readers: everyone signed in, or the people and groups named. */
    share: z.enum(['everyone', 'limited']),
    sharedWith: VisibleToSchema,
    access: z.object({
      edit: z.boolean().describe('May change it: whoever may change its project’s issues, or a personal whiteboard’s owner and its named people'),
      delete: z.boolean().describe('May delete it: whoever made it, and its project’s managers; a personal whiteboard’s owner'),
      share: z.boolean().describe('A personal whiteboard’s owner may say who else reads it'),
    }),
  })
  .meta({ id: 'Whiteboard' });
export type Whiteboard = z.infer<typeof WhiteboardSchema>;

export const WhiteboardDetailSchema = z
  .object({
    whiteboard: WhiteboardSchema,
    elements: z.array(WhiteboardElementSchema),
    cards: z.array(WhiteboardCardSchema),
    viewers: z.array(WhiteboardViewerSchema).describe('Who is looking at it now'),
  })
  .meta({ id: 'WhiteboardDetail' });
export type WhiteboardDetail = z.infer<typeof WhiteboardDetailSchema>;

export const WhiteboardCreateBody = z.object({
  project: z.string().trim().min(1).max(40).optional().describe('Its project, by key: who reads the project reads it, and who may change its issues changes it. Without one, a whiteboard of your own'),
  name: z.string().trim().min(1).max(WHITEBOARD_LIMITS.name),
  share: z.enum(['everyone', 'limited']).default('everyone').describe('A personal whiteboard’s readers: everyone signed in, or the people and groups named'),
  sharedWith: VisibleToInput.optional().describe('The people (logins) and groups (ids or names) it is shared with, when it is limited to some'),
});
export const WhiteboardRenameBody = z.object({ name: z.string().trim().min(1).max(WHITEBOARD_LIMITS.name) });
export const WhiteboardShareBody = z.object({
  share: z.enum(['everyone', 'limited']).describe('A personal whiteboard’s readers: everyone signed in, or the people and groups named'),
  sharedWith: VisibleToInput.optional().describe('The people (logins) and groups (ids or names) it is shared with, when it is limited to some'),
});

const wbSet = z.object({ x: wbCoord, y: wbCoord, w: wbSize, h: wbSize, z: wbZ, text: wbText, tone: z.enum(WHITEBOARD_TONES), label: wbLabel }).partial();

export const WhiteboardOpSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('add'),
    id: WhiteboardElementId,
    kind: z.enum(WHITEBOARD_KINDS),
    x: wbCoord,
    y: wbCoord,
    w: wbSize.optional(),
    h: wbSize.optional(),
    z: wbZ.optional(),
    text: wbText.optional(),
    tone: z.enum(WHITEBOARD_TONES).optional(),
    label: wbLabel.optional(),
    issue: z.string().trim().min(1).max(40).optional().describe('An issue card: the issue, e.g. BACK-12'),
    article: z.string().trim().min(1).max(40).optional().describe('An article card: the article, e.g. BACK-A-3'),
    points: z.string().max(WHITEBOARD_LIMITS.points).optional().describe("A freehand drawing's stroke, in its own box: `x,y x,y`..."),
    attachment: z.string().trim().min(1).max(64).optional().describe("A picture: its attachment's id, from the whiteboard's own upload"),
    from: WhiteboardElementId.optional().describe("An arrow's start"),
    to: WhiteboardElementId.optional().describe("An arrow's end"),
  }),
  z.object({
    op: z.literal('update'),
    id: WhiteboardElementId,
    set: wbSet.refine((v) => Object.keys(v).length > 0, 'Say what changes'),
    expect: wbSet.optional().describe('Values it must still have, or this change is refused for it alone; the rest of the batch goes on'),
  }),
  z.object({ op: z.literal('remove'), id: WhiteboardElementId, expect: wbSet.optional() }),
]);
export type WhiteboardOp = z.infer<typeof WhiteboardOpSchema>;

export const WhiteboardBatchBody = z.object({
  ops: z.array(WhiteboardOpSchema).min(1).max(WHITEBOARD_LIMITS.ops),
  client: z.string().trim().max(64).optional().describe('Which of a person’s tabs sent it: the live stream says it back, so a page knows its own changes'),
});
export type WhiteboardBatchInput = z.input<typeof WhiteboardBatchBody>;

export const WhiteboardBatchResultSchema = z
  .object({
    seq: z.number().int(),
    applied: z.array(z.string()).describe('The elements this batch added, changed or removed'),
    elements: z.array(WhiteboardElementSchema).describe('Each element it added or changed, as it is now'),
    removed: z.array(z.string()).describe('What it removed, arrows to removed elements included'),
    refused: z
      .array(
        z.object({
          id: z.string(),
          op: z.enum(['add', 'update', 'remove']),
          reason: z.enum(['gone', 'changed', 'exists']).describe('gone: no such element (removed meanwhile); changed: it no longer has what `expect` said; exists: an element has that id'),
          element: WhiteboardElementSchema.nullable().describe('The element as it is now, if there is one'),
        }),
      )
      .describe('Changes not made, each for its element alone'),
  })
  .meta({ id: 'WhiteboardBatchResult' });
export type WhiteboardBatchResult = z.infer<typeof WhiteboardBatchResultSchema>;

/** What a page shows of a problem with one item among several, beside the API's English (D49). */
export const ItemProblemSchema = z
  .object({
    message: z.string(),
    hint: z.string().optional(),
    said: z.object({ key: z.string(), values: z.record(z.string(), z.unknown()).optional() }).describe('The same problem, for a page to say in its language'),
  })
  .meta({ id: 'ItemProblem' });
export type ItemProblem = z.infer<typeof ItemProblemSchema>;

export const WhiteboardConvertBody = z
  .object({
    project: z.string().trim().min(1).max(40).optional().describe('Where the notes’ issues go, by key: a project you may report issues in. Needed with notes'),
    notes: z.array(WhiteboardElementId).max(WHITEBOARD_LIMITS.convert).default([]).describe('Notes to make issues of: each note’s first line is the summary, the rest the description'),
    links: z
      .array(
        z.object({
          arrow: WhiteboardElementId,
          relation: z.string().trim().min(1).max(100).describe('How the issue at its start relates to the one at its end, e.g. "depends on", "relates to"'),
        }),
      )
      .max(WHITEBOARD_LIMITS.convert)
      .default([])
      .describe('Arrows between cards that are issues, or become issues here, to make links of'),
    dryRun: z.boolean().default(false).describe('Say what would happen, and change nothing'),
  })
  .refine((v) => v.notes.length + v.links.length > 0, 'Name a note or an arrow');
export type WhiteboardConvertInput = z.input<typeof WhiteboardConvertBody>;

export const WhiteboardConvertResultSchema = z
  .object({
    dryRun: z.boolean(),
    seq: z.number().int(),
    notes: z.array(
      z.object({
        element: z.string(),
        ok: z.boolean(),
        issue: z.string().optional().describe('The issue it became; absent in a dry run'),
        summary: z.string().optional(),
        already: z.boolean().optional().describe('It was an issue already: nothing was made'),
        problem: ItemProblemSchema.optional(),
      }),
    ),
    links: z.array(
      z.object({
        element: z.string(),
        ok: z.boolean(),
        link: z.string().optional().describe('e.g. "BACK-12 depends on BACK-13"; absent in a dry run whose ends are notes, as the issues they would become have no ids yet'),
        relation: z.string().optional().describe('How the issue at its start relates to the one at its end, as the link type says it: "depends on"'),
        made: z.boolean().optional().describe('False when the link was there already: it is never made twice'),
        problem: ItemProblemSchema.optional(),
      }),
    ),
  })
  .meta({ id: 'WhiteboardConvertResult' });
export type WhiteboardConvertResult = z.infer<typeof WhiteboardConvertResultSchema>;

/** A change on a whiteboard's live stream: what one batch or conversion left, for everyone looking. */
export interface WhiteboardChangeFrame {
  seq: number;
  by: UserRef | null;
  client: string | null;
  elements: WhiteboardElement[];
  removed: string[];
}

// ---------------------------------------------------------------------------
// The portal's own sign-in (D63): passwords, and identity providers for requesters
// ---------------------------------------------------------------------------

const providerDomain = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, 'Expected an email domain, such as acme.com');

/** An identity provider for requesters (D63): the server's, made by an administrator, offered by any desk that chooses it. */
export const PortalProviderSchema = z
  .object({
    id: z.string(),
    name: z.string().describe('What the sign-in page calls it: "Sign in through <name>"'),
    kind: z.enum(['oidc', 'saml']).describe('OpenID Connect, or SAML 2.0 (D63\'s revisit)'),
    issuer: z.string().describe('Its issuer, as its discovery document gives it (OIDC), or its entity id (SAML)'),
    clientId: z.string().nullable().describe('OIDC only: its client id; null for a SAML provider'),
    hasSecret: z.boolean().describe('A client secret is kept, sealed; it is never shown again'),
    scopes: z.string(),
    domains: z.array(z.string()).describe('The email domains it may vouch for; empty: any. An address outside them is refused'),
    samlEntryPoint: z.string().nullable().describe('SAML only: its SSO URL'),
    hasCert: z.boolean().describe('SAML only: its signing certificate is kept; it is never shown again'),
    project: z.string().nullable().describe("A desk's own (D63's revisit): its key; null for the server's, offered to any desk"),
    redirectUri: z.string().describe('Register this with the provider, exactly'),
    desks: z.array(z.string()).describe('The keys of the desks that offer it, among those the reader sees'),
    createdAt: timestamp,
  })
  .meta({ id: 'PortalProvider' });
export type PortalProvider = z.infer<typeof PortalProviderSchema>;

export const PortalProviderBody = z.object({
  project: z.string().trim().max(20).optional().describe("A desk's own provider: its key; a desk's managers make it there. Left out: the server's, an administrator's"),
  name: z.string().trim().min(1).max(100),
  kind: z.enum(['oidc', 'saml']).default('oidc').describe('SAML providers name their own SSO URL and certificate instead (D63\'s revisit)'),
  issuer: z.string().trim().url().max(500).describe('https; plain http only on this machine. SAML: the entity id'),
  clientId: z.string().trim().min(1).max(500).optional().describe('OIDC only'),
  clientSecret: z.string().min(1).max(2000).nullable().optional().describe('Empty for a public client (PKCE alone)'),
  scopes: z.string().trim().max(500).optional().describe('Default: openid email profile'),
  domains: z.array(providerDomain).max(50).default([]),
  samlEntryPoint: z.string().trim().url().max(500).optional().describe('SAML only: its SSO URL'),
  samlCert: z.string().min(1).max(20_000).optional().describe('SAML only: its signing certificate, PEM'),
});
export const PortalProviderUpdateBody = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  issuer: z.string().trim().url().max(500).optional(),
  clientId: z.string().trim().min(1).max(500).optional(),
  clientSecret: z.string().min(1).max(2000).nullable().optional().describe('A new secret; null removes it; left out keeps it'),
  scopes: z.string().trim().max(500).optional(),
  domains: z.array(providerDomain).max(50).optional(),
});

/** How the portal's sign-in page signs someone in, for a desk or for the portal as a whole (D63). */
export const CustomerDirectorySchema = z.object({
  name: z.string(),
  domains: z.array(z.string()),
});
export type CustomerDirectoryEntry = z.infer<typeof CustomerDirectorySchema>;

export const PortalSignInMethodsSchema = z
  .object({
    desk: z.object({ key: z.string(), name: z.string() }).nullable().describe('The desk asked about, when one takes requests by that key; null otherwise'),
    link: z.boolean(),
    password: z.boolean(),
    providers: z.array(z.object({ id: z.string(), name: z.string(), start: z.string().describe('Where the browser goes to sign in through it') })),
    captcha: CaptchaChallengeSchema.nullable().describe('A proof of work a password sign-in sends back solved, when a desk that takes passwords asks its form for one (D30)'),
    mail: z.boolean().describe('Whether this server sends email: links and passwords need it'),
    passkey: z.boolean().describe('A passkey signs them in here (D69): the desk takes passkeys (or, with no desk named, some desk does), and this address can have them'),
  })
  .meta({ id: 'PortalSignInMethods' });
export type PortalSignInMethods = z.infer<typeof PortalSignInMethodsSchema>;

const portalPassword = z.string().min(8).max(200);
export const PortalPasswordSignInBody = z.object({
  email: z.string().trim().email().max(320),
  password: z.string().min(1).max(200),
  desk: z.string().trim().max(20).optional().describe('The desk whose page they sign in from'),
  captcha: CaptchaSolutionSchema.optional(),
  locale: portalChosenLocale,
});
export const PortalPasswordLinkBody = z.object({
  email: z.string().trim().email().max(320),
  desk: z.string().trim().max(20).optional(),
});
export const PortalPasswordSetBody = z.object({ token: z.string().min(10).max(200), password: portalPassword, locale: portalChosenLocale });
export const PortalPasswordChangeBody = z.object({ current: z.string().min(1).max(200), password: portalPassword });
// Passkeys (D62)
// ---------------------------------------------------------------------------

/** A base64url string from a WebAuthn ceremony, capped: no real credential comes near it. */
const b64url = (max: number) => z.string().max(max).regex(/^[A-Za-z0-9_-]*$/, 'base64url');

export const PasskeySchema = z
  .object({
    id: z.string(),
    name: z.string().describe('What its person calls it: at first, what the authenticator says it is'),
    createdAt: timestamp,
    lastUsedAt: timestamp.nullable(),
    synced: z.boolean().describe('Its passkey provider may copy it to its person’s other devices (backup eligible)'),
    copied: z.boolean().describe('Its sign count went back: two authenticators hold it, so it signs nobody in again'),
    elsewhere: z.string().nullable().describe('The address it was made for, when that isn’t this one: it can’t sign in here'),
    attested: z.boolean().optional().describe('Its maker vouched for it, checked against FIDO’s metadata, as only some authenticators were taken (D68)'),
    listed: z
      .boolean()
      .nullable()
      .optional()
      .describe('Where only some authenticators are taken: whether it’s one of them (false for one added before, whose maker a4a never asked). It signs in either way. Null: any is taken'),
  })
  .meta({ id: 'Passkey' });
export type Passkey = z.infer<typeof PasskeySchema>;

export const PASSKEYS_OFF = ['instance', 'address', 'passwords', 'account'] as const;
export type PasskeysOff = (typeof PASSKEYS_OFF)[number];

export const MyPasskeysSchema = z
  .object({
    passkeys: z.array(PasskeySchema),
    on: z.boolean().describe('Whether you may add passkeys and sign in with them here'),
    off: z
      .enum(PASSKEYS_OFF)
      .nullable()
      .describe('Why not: instance, an administrator turned them off; address, PUBLIC_URL isn’t https; passwords, a4a’s own sign-in is off; account, you sign in with single sign-on'),
    confirmedUntil: timestamp.nullable().describe('Until when this session may add and remove passkeys without confirming it’s you again'),
    confirmWith: z.object({
      password: z.boolean().describe('Your password confirms it'),
      code: z.boolean().describe('With a code from your authenticator app'),
      passkey: z.boolean().describe('Or one of your passkeys does'),
    }),
    required: z.boolean().optional().describe('Passkeys are required of you here: a password sign-in owes one (D68)'),
    authenticators: z
      .array(z.string())
      .nullable()
      .optional()
      .describe('Where only some authenticators are taken, their names, as FIDO’s metadata gives them; null for any (D68)'),
    password: z
      .object({
        set: z.boolean().describe('You have a password'),
        removable: z.boolean().describe('You may remove it now (DELETE /me/password)'),
        needs: z
          .enum(['spare', 'passkey'])
          .nullable()
          .describe('What removing it still needs: spare, a second passkey or a synced one; passkey, proving it’s you with a passkey in the last ten minutes'),
      })
      .optional()
      .describe('Signing in with passkeys alone (D68)'),
  })
  .meta({ id: 'MyPasskeys' });
export type MyPasskeys = z.infer<typeof MyPasskeysSchema>;

/** What `navigator.credentials.create()` or `.get()` takes, as JSON (WebAuthn's `PublicKeyCredential*OptionsJSON`). */
export const PasskeyOptionsSchema = z
  .looseObject({
    challenge: z.string(),
    timeout: z.number().optional(),
    rpId: z.string().optional(),
    /** Earlier relying party ids whose passkeys still sign in, the current id first (D70). */
    legacyRpIds: z.string().array().optional(),
  })
  .describe('Hand it to @simplewebauthn/browser’s startRegistration or startAuthentication as optionsJSON, or decode it for navigator.credentials')
  .meta({ id: 'PasskeyOptions' });
export type PasskeyOptions = z.infer<typeof PasskeyOptionsSchema>;

const credentialCommon = {
  id: b64url(1400),
  rawId: b64url(1400),
  type: z.literal('public-key'),
  authenticatorAttachment: z.enum(['platform', 'cross-platform']).optional(),
  clientExtensionResults: z.record(z.string(), z.unknown()).default({}),
};

/** What the browser answers `navigator.credentials.create()` with, as JSON (WebAuthn's `RegistrationResponseJSON`). */
export const PasskeyRegistrationSchema = z
  .object({
    ...credentialCommon,
    response: z.looseObject({
      clientDataJSON: b64url(4096),
      attestationObject: b64url(32_768),
      transports: z.array(z.string().max(32)).max(10).optional(),
      authenticatorData: b64url(16_384).optional(),
      publicKey: b64url(4096).optional(),
      publicKeyAlgorithm: z.number().optional(),
    }),
  })
  .meta({ id: 'PasskeyRegistration' });

/** What the browser answers `navigator.credentials.get()` with, as JSON (WebAuthn's `AuthenticationResponseJSON`). */
export const PasskeyAssertionSchema = z
  .object({
    ...credentialCommon,
    response: z.looseObject({
      clientDataJSON: b64url(4096),
      authenticatorData: b64url(16_384),
      signature: b64url(4096),
      userHandle: b64url(256).optional(),
    }),
  })
  .meta({ id: 'PasskeyAssertion' });

export const AddPasskeyBody = z.object({
  response: PasskeyRegistrationSchema,
  name: z.string().trim().min(1).max(60).optional().describe('What to call it; else what the authenticator says it is'),
});
export const RenamePasskeyBody = z.object({ name: z.string().trim().min(1).max(60) });
export const PasskeySignInBody = z.object({ response: PasskeyAssertionSchema });
export const ConfirmItsYouBody = z.object({
  password: z.string().min(1).max(200),
  code: z.string().trim().min(6).max(20).optional().describe('With two-factor sign-in on: a code from the app, or a recovery code'),
});
export const ConfirmedSchema = z
  .object({ confirmedUntil: timestamp.describe('Until when this session may add and remove passkeys') })
  .meta({ id: 'Confirmed' });
export type Confirmed = z.infer<typeof ConfirmedSchema>;

/** A "this wasn't me" link from a mail about someone's passkeys, as its page shows it. */
export const PasskeyAlertSchema = z
  .object({
    change: z.enum(['added', 'removed', 'copied', 'password-removed']),
    name: z.string().describe('The passkey’s name'),
    login: z.string(),
    changedAt: timestamp,
    done: z.boolean().describe('The link was followed: its person was signed out everywhere, and the passkey stopped'),
  })
  .meta({ id: 'PasskeyAlert' });
export type PasskeyAlert = z.infer<typeof PasskeyAlertSchema>;

// ---------------------------------------------------------------------------
// CCs in depth (D67): the requester takes people off, a desk's own cap, held CCs
// ---------------------------------------------------------------------------

export const PortalCcQuery = z.object({ email: z.string().trim().min(3).max(HELP_LIMITS.email).describe('The address to stop copying') });

/** The requester's choice about someone a new request's Cc named (D67): copy them, or drop them. */
export const PortalHeldCcBody = z.object({
  email: z.string().trim().min(3).max(HELP_LIMITS.email).describe('Whom the Cc named'),
  copy: z.boolean().describe('true copies them on the request; false drops them, and they are told nothing'),
});

/** What the link in a new request's acknowledgement confirms (D67), as its page shows it. */
export const CcConfirmationSchema = z
  .object({
    request: z.object({ id: z.string(), summary: z.string(), desk: z.string() }),
    held: z.array(HeldCcSchema).describe('Whom the Cc of the email named, still waiting'),
    expiresAt: timestamp.describe('Until when the link works, once'),
  })
  .meta({ id: 'CcConfirmation' });
export type CcConfirmation = z.infer<typeof CcConfirmationSchema>;

export const CcConfirmationBody = z.object({
  copy: z
    .array(z.string().trim().min(3).max(HELP_LIMITS.email))
    .max(REQUEST_CCS_CEILING)
    .describe('Whom to copy, of those held; the others are dropped. The link is then used'),
});

export const CcConfirmedSchema = z
  .object({
    copied: z.array(z.string()).describe('Copied on the request now'),
    dropped: z.array(z.string()).describe('Dropped: told nothing'),
    refused: z
      .array(z.object({ email: z.string(), key: z.string().describe('The problem’s key, under problem.*'), values: z.record(z.string(), z.unknown()), message: z.string() }))
      .describe('Not copied, and why'),
  })
  .meta({ id: 'CcConfirmed' });
export type CcConfirmed = z.infer<typeof CcConfirmedSchema>;

// ---------------------------------------------------------------------------
// Requesters' passkeys (D69)
// ---------------------------------------------------------------------------

/** Why a requester can't add or use passkeys here: the address isn't one browsers make them for, an administrator turned them off, or no desk takes them. */
export const PORTAL_PASSKEYS_OFF = ['address', 'instance', 'desks'] as const;
export type PortalPasskeysOff = (typeof PORTAL_PASSKEYS_OFF)[number];

/** A requester's passkeys, as the portal's account page shows them. */
export const PortalPasskeysSchema = z
  .object({
    passkeys: z.array(PasskeySchema),
    on: z.boolean().describe('Whether they may add passkeys here, and sign in with them'),
    off: z
      .enum(PORTAL_PASSKEYS_OFF)
      .nullable()
      .describe('Why not: address, PUBLIC_URL isn’t https; instance, an administrator turned passkeys off; desks, no help desk here takes them'),
    confirmedUntil: timestamp
      .nullable()
      .describe('Until when this session may add and remove passkeys: ten minutes from a sign-in by an emailed link or a passkey, or from confirming with a passkey'),
    confirmWith: z.object({
      passkey: z.boolean().describe('One of their passkeys confirms it'),
      link: z.boolean().describe('A new sign-in by a link emailed to them does: this server sends email'),
    }),
  })
  .meta({ id: 'PortalPasskeys' });
export type PortalPasskeys = z.infer<typeof PortalPasskeysSchema>;

/** A "this wasn't me" link from a mail about a requester's passkeys, as the portal shows it. */
export const PortalPasskeyAlertSchema = z
  .object({
    change: z.enum(['added', 'removed', 'copied']),
    name: z.string().describe('The passkey’s name'),
    email: z.string().describe('The requester’s address'),
    changedAt: timestamp,
    done: z.boolean().describe('The link was followed: every portal session of theirs ended, and the passkey stopped'),
  })
  .meta({ id: 'PortalPasskeyAlert' });
export type PortalPasskeyAlert = z.infer<typeof PortalPasskeyAlertSchema>;
const portalDesk = z.string().trim().max(20).optional().describe('The desk whose page they sign in from: it must take passkeys');
export const PortalPasskeyOptionsBody = z.object({ desk: portalDesk, rpId: z.string().trim().max(255).optional() });
export const PortalPasskeySignInBody = PasskeySignInBody.extend({ desk: portalDesk, locale: portalChosenLocale });

/** How many passkeys the team took from a requester (D69). */
export const RemovedPasskeysSchema = z.object({ removed: z.number().int() }).meta({ id: 'RemovedPasskeys' });
export type RemovedPasskeys = z.infer<typeof RemovedPasskeysSchema>;

// ---------------------------------------------------------------------------
// Passkeys in depth (D68): FIDO's metadata, setup links, a passkey owed at sign-in
// ---------------------------------------------------------------------------

export const PASSKEY_METADATA_FAILURES = ['unreachable', 'unreadable', 'unverified', 'older', 'tooLarge'] as const;
export type PasskeyMetadataFailure = (typeof PASSKEY_METADATA_FAILURES)[number];

export const PasskeyMetadataSchema = z
  .object({
    source: z.enum(['url', 'file']).describe('Where a4a reads FIDO’s BLOB: PASSKEY_MDS_URL, or PASSKEY_MDS_FILE'),
    from: z.string().describe('The address or file'),
    no: z.number().int().nullable().describe('The serial number of the BLOB in use; null when none was read yet'),
    nextUpdate: z.string().nullable().describe('When FIDO says the next BLOB comes, at the latest (a date)'),
    gotAt: timestamp.nullable().describe('When the BLOB in use was fetched or read'),
    stale: z.boolean().describe('Its next update is past, and no later BLOB came: a4a keeps using it'),
    triedAt: timestamp.nullable(),
    failedAt: timestamp.nullable().describe('When the last try failed, if it did'),
    failure: z.enum(PASSKEY_METADATA_FAILURES).nullable().describe('What kind of failure'),
    failureDetail: z.string().nullable().describe('What went wrong, in English, for administrators'),
    authenticators: z
      .array(z.object({ aaguid: z.string(), name: z.string(), revoked: z.boolean().describe('FIDO says it can’t be trusted: never taken') }))
      .describe('The FIDO2 authenticators the BLOB describes, to choose from'),
  })
  .meta({ id: 'PasskeyMetadata' });
export type PasskeyMetadata = z.infer<typeof PasskeyMetadataSchema>;

export const PasskeySetupLinkBody = z.object({
  deliver: z
    .enum(['email', 'show'])
    .optional()
    .describe('email: mail it to their address (the default where they have one and mail is set up); show: answer with the link, once, to hand over yourself'),
});
export const PasskeySetupLinkSchema = z
  .object({
    mailed: z.boolean(),
    url: z.string().nullable().describe('The link, when shown: it is not kept, and works once'),
    expiresAt: timestamp,
  })
  .meta({ id: 'PasskeySetupLink' });
export type PasskeySetupLink = z.infer<typeof PasskeySetupLinkSchema>;

export const PasskeySetupInfoSchema = z
  .object({
    login: z.string(),
    name: z.string(),
    expiresAt: timestamp,
    signedInAs: z.string().nullable().describe('The login this browser is signed in as, when it isn’t the link’s'),
  })
  .meta({ id: 'PasskeySetupInfo' });
export type PasskeySetupInfo = z.infer<typeof PasskeySetupInfoSchema>;

const setupToken = z.string().min(10).max(100);
export const PasskeySetupTokenBody = z.object({ token: setupToken });
export const PasskeySetupBody = z.object({
  token: setupToken,
  response: PasskeyRegistrationSchema,
  name: z.string().trim().min(1).max(60).optional(),
});
export const OwedPasskeyBody = z.object({
  response: PasskeyRegistrationSchema,
  code: z.string().trim().min(6).max(20).optional().describe('Where two-factor sign-in is on for you: a code from the app, or a recovery code'),
  name: z.string().trim().min(1).max(60).optional(),
});
