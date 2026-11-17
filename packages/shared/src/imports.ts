/**
 * Importing issues from a CSV export (Jira's or YouTrack's): upload, map the columns and values,
 * check it (nothing changes), run it as a job, read what it did, and take it back.
 */
import { z } from 'zod';
import { ProjectRefSchema, UserRefSchema } from './schemas';

const timestamp = z.string().describe('ISO 8601 timestamp');

export const IMPORT_SOURCES = ['jira', 'youtrack', 'csv', 'github', 'redmine', 'zendesk'] as const;
export type ImportSource = (typeof IMPORT_SOURCES)[number];

/** The targets a column can have, besides `field:<name>` (a project field) and `link:<phrase>` (a link, by external key). */
export const IMPORT_TARGETS = [
  'ignore',
  'key',
  'external-id',
  'summary',
  'description',
  'parent',
  'created',
  'updated',
  'resolved',
  'reporter',
  'tags',
  'comment',
  'spent',
  'sprint',
] as const;

export const ImportTarget = z
  .string()
  .max(120)
  .regex(/^(ignore|key|external-id|summary|description|parent|created|updated|resolved|reporter|tags|comment|spent|sprint|field:.+|link:.+)$/, 'Not a target a column can have')
  .describe('ignore, key, external-id, summary, description, parent, created, updated, resolved, reporter, tags, comment, spent, sprint, field:<Field name> or link:<phrase>');

export const ImportColumnSchema = z
  .object({
    index: z.number().int(),
    name: z.string(),
    target: z.string(),
    found: z.boolean().describe('Mapped from its header, without anyone choosing'),
    samples: z.array(z.string()).describe('A few of its values'),
    filled: z.number().int().describe('Rows with a value in it'),
  })
  .meta({ id: 'ImportColumn' });
export type ImportColumn = z.infer<typeof ImportColumnSchema>;

export const ImportValueMapSchema = z
  .object({
    target: z.string().describe('The column target these values are for, e.g. field:State, reporter or sprint'),
    label: z.string(),
    kind: z.enum(['option', 'user', 'sprint']),
    multi: z.boolean(),
    items: z.array(
      z.object({
        value: z.string(),
        count: z.number().int(),
        to: z.string().nullable().describe('The a4a value, login or sprint id; null leaves it empty (unassigned, no sprint)'),
        found: z.boolean().describe('Matched without anyone choosing'),
      }),
    ),
    more: z.number().int().describe('Values past the first 500, matched by name when they can be'),
    choices: z.array(z.object({ value: z.string(), label: z.string() })).describe('What each value may become here'),
    empty: z.string().describe('What leaving a value unmapped means, e.g. "Unassigned" or "The project\'s default, Open"'),
  })
  .meta({ id: 'ImportValueMap' });
export type ImportValueMap = z.infer<typeof ImportValueMapSchema>;

export const ImportOptionsSchema = z
  .object({
    onExisting: z.enum(['update', 'skip']).describe('An issue imported before: update what changed in the export since, or leave it'),
    timeZone: z.string().max(64).describe('For dates in the file without a zone'),
  })
  .meta({ id: 'ImportOptions' });
export type ImportOptions = z.infer<typeof ImportOptionsSchema>;

export const ImportProblemSchema = z
  .object({
    row: z.number().int().describe('Row in the file, counting the header as row 1'),
    key: z.string().nullable(),
    column: z.string().nullable(),
    severity: z.enum(['error', 'warning']).describe('error: the row is not imported; warning: imported, without this'),
    message: z.string(),
    hint: z.string().optional(),
  })
  .meta({ id: 'ImportProblem' });
export type ImportProblem = z.infer<typeof ImportProblemSchema>;

export const ImportCountsSchema = z
  .object({
    total: z.number().int(),
    created: z.number().int(),
    updated: z.number().int(),
    unchanged: z.number().int(),
    skipped: z.number().int(),
    failed: z.number().int(),
    comments: z.number().int(),
    work: z.number().int().optional().describe("Work items brought from the other tracker's API"),
    files: z.number().int().optional().describe("Files brought from the other tracker's API"),
    links: z.number().int().describe('Links and parents made, by external key'),
    linksMissing: z.number().int().describe('Links to keys neither in this file nor imported before'),
    problems: z.number().int(),
  })
  .meta({ id: 'ImportCounts' });
export type ImportCounts = z.infer<typeof ImportCountsSchema>;

// ---------------------------------------------------------------------------
// Imports from another tracker's API (YouTrack's, Jira's): the same rows as a file's, read over
// HTTPS with a token that is used for the fetch and the run, and never kept.
// ---------------------------------------------------------------------------

/** D29: YouTrack and Jira. D46: GitHub Issues, Redmine, and Zendesk into a help desk. */
export const API_IMPORT_SOURCES = ['youtrack', 'jira', 'github', 'redmine', 'zendesk'] as const;
export type ApiImportSource = (typeof API_IMPORT_SOURCES)[number];

export const ImportCredentialsSchema = z
  .object({
    token: z
      .string()
      .min(1)
      .max(4096)
      .describe(
        'YouTrack: a permanent token. Jira Cloud: an API token, with the email of its account. Jira Data Center: a personal access token. GitHub: a token that may read the repository\'s issues. Redmine: an API key (or a password, with the login as email). Zendesk: an API token, with the email of its agent (or an OAuth token alone)',
      ),
    email: z
      .string()
      .email()
      .max(320)
      .optional()
      .describe(
        "Jira Cloud: the email of the Atlassian account the API token belongs to. Zendesk: the agent's email the API token goes with. Redmine: a login, with its password as the token. Without it, the token goes as a bearer token (or Redmine's API key)",
      ),
  })
  .meta({ id: 'ImportCredentials' });
export type ImportCredentials = z.infer<typeof ImportCredentialsSchema>;

export const ImportBringSchema = z
  .object({
    comments: z.boolean().default(true),
    work: z.boolean().default(true).describe('Work items (YouTrack) and worklogs (Jira), each as it was logged; without them, the time spent comes as one total'),
    files: z.boolean().default(true).describe('Attachments, downloaded as the import runs, within the size limits'),
  })
  .meta({ id: 'ImportBring' });
export type ImportBring = z.infer<typeof ImportBringSchema>;

export const ImportFromApiBody = z.object({
  project: z.string().describe('Project key to import into'),
  source: z.enum(API_IMPORT_SOURCES),
  url: z
    .string()
    .min(1)
    .max(2000)
    .describe(
      "The tracker's base address, https: e.g. https://example.youtrack.cloud, https://example.atlassian.net, https://api.github.com (or GitHub Enterprise's https://github.acme.example/api/v3), https://redmine.acme.example, https://acme.zendesk.com",
    ),
  query: z
    .string()
    .trim()
    .min(1)
    .max(4000)
    .describe(
      'Which issues: a YouTrack query (project: BACK), a JQL (project = BACK), a GitHub repository (acme/backend, then state:open or label:bug if you like), a Redmine project identifier (backend), or for Zendesk "all" or "since 2026-01-01"',
    ),
  credentials: ImportCredentialsSchema,
  bring: ImportBringSchema.optional(),
});

export const ImportFetchBody = z.object({
  credentials: ImportCredentialsSchema,
});

export const ImportRunBody = z.object({
  credentials: ImportCredentialsSchema.optional().describe("For an import from an API that brings files: the token again, to download them. a4a doesn't keep it"),
});

export const ImportOriginSchema = z
  .object({
    kind: z.enum(API_IMPORT_SOURCES),
    deployment: z.enum(['cloud', 'datacenter']).nullable().describe('Jira: Cloud (an email and an API token) or Data Center (a personal access token); null for the others'),
    url: z.string().describe('The base address it reads from'),
    query: z.string(),
    account: z.string().nullable().describe('Whom the token signed in as, there'),
    bring: ImportBringSchema,
    fetch: z.object({
      complete: z.boolean().describe('Every issue has been read: false while fetching, or when it stopped before the end'),
      issues: z.number().int(),
      comments: z.number().int(),
      work: z.number().int(),
      files: z.number().int(),
      fileBytes: z.number().int(),
      total: z.number().int().nullable().describe('How many issues the query matched there, when it says'),
      left: z.object({
        issues: z.number().int().describe('Issues only some people may see there, left out'),
        comments: z.number().int().describe('Comments only some people may see there, left out'),
        keys: z.array(z.string()).describe('The first issues left out'),
      }),
    }),
  })
  .meta({ id: 'ImportOrigin' });
export type ImportOrigin = z.infer<typeof ImportOriginSchema>;

export const IMPORT_STATUSES = ['fetching', 'ready', 'running', 'stopped', 'done', 'failed', 'undone'] as const;

export const ImportSchema = z
  .object({
    id: z.string(),
    project: ProjectRefSchema,
    source: z.enum(IMPORT_SOURCES),
    fileName: z.string(),
    createdBy: UserRefSchema.nullable(),
    createdAt: timestamp,
    status: z
      .enum(IMPORT_STATUSES)
      .describe(
        "fetching: reading the issues from the other tracker's API. stopped: it was fetching or running and stopped answering, as when the server restarted; fetch or run it again to carry on",
      ),
    rows: z.number().int(),
    columns: z.array(ImportColumnSchema),
    values: z.array(ImportValueMapSchema),
    options: ImportOptionsSchema,
    progress: z.object({
      phase: z.enum(['fetching', 'issues', 'links']).nullable().describe("fetching: issues read from the other tracker so far, of about total (0 when it can't say)"),
      done: z.number().int(),
      total: z.number().int(),
    }),
    startedAt: timestamp.nullable(),
    finishedAt: timestamp.nullable(),
    error: z.string().nullable(),
    result: ImportCountsSchema.nullable(),
    origin: ImportOriginSchema.nullable().describe("Where an import from another tracker's API reads from; null for a file"),
  })
  .meta({ id: 'Import' });
export type Import = z.infer<typeof ImportSchema>;

export const ImportUploadQuery = z.object({
  project: z.string().describe('Project key to import into'),
  source: z.enum(IMPORT_SOURCES).optional().describe('Whose export it is; found from the headers when left out'),
  fileName: z.string().max(200).optional(),
});

export const ImportMappingBody = z.object({
  columns: z.record(z.string().regex(/^\d+$/), ImportTarget).optional().describe('Targets by column index'),
  values: z
    .record(z.string(), z.record(z.string(), z.string().nullable()))
    .optional()
    .describe('By target, each value in the file to an a4a value, login or sprint id (null: leave it empty)'),
  options: ImportOptionsSchema.partial().optional(),
});

export const ImportCheckSchema = z
  .object({
    counts: ImportCountsSchema,
    problems: z.array(ImportProblemSchema).describe('The first 200'),
    warnings: z.array(z.string()).describe('What applies to many rows, said once'),
  })
  .meta({ id: 'ImportCheck' });
export type ImportCheck = z.infer<typeof ImportCheckSchema>;

export const ImportRowSchema = z
  .object({
    row: z.number().int(),
    key: z.string().nullable(),
    summary: z.string().nullable(),
    status: z.enum(['pending', 'created', 'updated', 'unchanged', 'skipped', 'failed']),
    issue: z.string().nullable().describe('The a4a issue it became, or was matched to'),
    problems: z.array(ImportProblemSchema),
  })
  .meta({ id: 'ImportRow' });
export type ImportRow = z.infer<typeof ImportRowSchema>;

export const ImportRowsQuery = z.object({
  status: z.enum(['pending', 'created', 'updated', 'unchanged', 'skipped', 'failed', 'problems']).optional(),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const ImportUndoBody = z.object({
  dryRun: z.boolean().default(true).describe('Say what undoing would do, without doing it'),
});
export const ImportUndoSchema = z
  .object({
    applied: z.boolean(),
    remove: z.array(z.string()).describe('Issues the import created that go (or went) with it'),
    keep: z.array(z.object({ issue: z.string(), why: z.string() })).describe('Issues it created that stay, because someone has worked on them since'),
    updatedStay: z.number().int().describe('Issues that existed before, which it updated: those changes stay'),
  })
  .meta({ id: 'ImportUndo' });
export type ImportUndo = z.infer<typeof ImportUndoSchema>;
