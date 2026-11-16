/**
 * Importing issues from a CSV export (Jira's or YouTrack's): upload, map the columns and values,
 * check it (nothing changes), run it as a job, read what it did, and take it back.
 */
import { z } from 'zod';
import { ProjectRefSchema, UserRefSchema } from './schemas';

const timestamp = z.string().describe('ISO 8601 timestamp');

export const IMPORT_SOURCES = ['jira', 'youtrack', 'csv'] as const;
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
    links: z.number().int().describe('Links and parents made, by external key'),
    linksMissing: z.number().int().describe('Links to keys neither in this file nor imported before'),
    problems: z.number().int(),
  })
  .meta({ id: 'ImportCounts' });
export type ImportCounts = z.infer<typeof ImportCountsSchema>;

export const IMPORT_STATUSES = ['ready', 'running', 'stopped', 'done', 'failed', 'undone'] as const;

export const ImportSchema = z
  .object({
    id: z.string(),
    project: ProjectRefSchema,
    source: z.enum(IMPORT_SOURCES),
    fileName: z.string(),
    createdBy: UserRefSchema.nullable(),
    createdAt: timestamp,
    status: z.enum(IMPORT_STATUSES).describe('stopped: it was running and stopped answering, as when the server restarted; run it again to carry on'),
    rows: z.number().int(),
    columns: z.array(ImportColumnSchema),
    values: z.array(ImportValueMapSchema),
    options: ImportOptionsSchema,
    progress: z.object({ phase: z.enum(['issues', 'links']).nullable(), done: z.number().int(), total: z.number().int() }),
    startedAt: timestamp.nullable(),
    finishedAt: timestamp.nullable(),
    error: z.string().nullable(),
    result: ImportCountsSchema.nullable(),
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
