import {
  WELL_KNOWN_FIELDS,
  type PlanSettings,
  type Project,
  type ProjectSettings,
  type TriageMode,
} from '@tracklet/shared';
import { eq, sql } from 'drizzle-orm';
import { requireScope, type Ctx } from '../context';
import type { Db } from '../db/client';
import { issues, projectFields, projects } from '../db/schema';
import { badRequest, notFound } from '../lib/errors';
import { newId } from '../lib/ids';
import { canReadProject } from './access';
import { getSetting } from './settings';
import { fieldByName, findUser, projectByKey, type ProjectRow, type SchemaSnapshot } from './schema-cache';
import { userRefDto } from './values';

export const DEFAULT_PLAN: PlanSettings = {
  startDate: null,
  workingDays: [1, 2, 3, 4, 5],
  hoursPerDay: 8,
  holidays: [],
  budget: null,
  currency: 'USD',
};

export function projectSettings(row: ProjectRow): ProjectSettings {
  const raw = (row.settings ?? {}) as Partial<ProjectSettings>;
  return {
    triageMode: (raw.triageMode as TriageMode) ?? 'suggest',
    plan: { ...DEFAULT_PLAN, ...(raw.plan ?? {}) },
  };
}

type Template = 'software' | 'waterfall' | 'blank';

const TEMPLATE_FIELDS: Record<Template, { name: string; required?: boolean; defaultValue?: string }[]> = {
  software: [
    { name: WELL_KNOWN_FIELDS.state, required: true, defaultValue: 'Open' },
    { name: WELL_KNOWN_FIELDS.priority, required: true, defaultValue: 'Normal' },
    { name: WELL_KNOWN_FIELDS.type, required: true, defaultValue: 'Task' },
    { name: WELL_KNOWN_FIELDS.assignee },
    { name: WELL_KNOWN_FIELDS.subsystem },
    { name: WELL_KNOWN_FIELDS.fixVersions },
    { name: WELL_KNOWN_FIELDS.estimation },
    { name: WELL_KNOWN_FIELDS.dueDate },
  ],
  waterfall: [
    { name: WELL_KNOWN_FIELDS.state, required: true, defaultValue: 'Open' },
    { name: WELL_KNOWN_FIELDS.priority, required: true, defaultValue: 'Normal' },
    { name: WELL_KNOWN_FIELDS.type, required: true, defaultValue: 'Task' },
    { name: WELL_KNOWN_FIELDS.assignee },
    { name: WELL_KNOWN_FIELDS.estimation },
    { name: WELL_KNOWN_FIELDS.startDate },
    { name: WELL_KNOWN_FIELDS.dueDate },
    { name: WELL_KNOWN_FIELDS.fixedCost },
    { name: WELL_KNOWN_FIELDS.subsystem },
  ],
  blank: [{ name: WELL_KNOWN_FIELDS.state, required: true, defaultValue: 'Open' }, { name: WELL_KNOWN_FIELDS.assignee }],
};

async function counts(db: Db): Promise<Map<string, { total: number; open: number }>> {
  const rows = await db
    .select({
      projectId: issues.projectId,
      total: sql<number>`count(*)::int`,
      open: sql<number>`count(*) filter (where ${issues.resolvedAt} is null)::int`,
    })
    .from(issues)
    .groupBy(issues.projectId);
  return new Map(rows.map((r) => [r.projectId, { total: Number(r.total), open: Number(r.open) }]));
}

export function projectDto(s: SchemaSnapshot, row: ProjectRow, c?: { total: number; open: number }): Project {
  const lead = row.leadId ? s.users.get(row.leadId) : undefined;
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    lead: lead ? userRefDto(lead) : null,
    archived: row.archived,
    settings: projectSettings(row),
    issueCount: c?.total ?? 0,
    openIssueCount: c?.open ?? 0,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listProjects(ctx: Ctx): Promise<Project[]> {
  requireScope(ctx, 'read');
  const s = await ctx.app.schema.get();
  const c = await counts(ctx.db);
  const out: Project[] = [];
  for (const p of s.projects.values()) if (await canReadProject(ctx, p.id)) out.push(projectDto(s, p, c.get(p.id)));
  return out;
}

export async function getProject(ctx: Ctx, key: string): Promise<Project> {
  requireScope(ctx, 'read');
  const s = await ctx.app.schema.get();
  const p = projectByKey(s, key);
  if (!p || !(await canReadProject(ctx, p.id))) throw notFound(`Project ${key}`);
  const c = await counts(ctx.db);
  return projectDto(s, p, c.get(p.id));
}

export async function createProject(
  ctx: Ctx,
  input: { key: string; name: string; description?: string; lead?: string; template?: Template; plan?: Partial<PlanSettings> },
): Promise<Project> {
  requireScope(ctx, 'admin');
  const s = await ctx.app.schema.get();
  const key = input.key.toUpperCase();
  if (projectByKey(s, key)) throw badRequest(`Project key ${key} is already used`);
  const lead = input.lead ? findUser(s, input.lead, ctx.actor.user.id) : ctx.actor.user;
  if (input.lead && !lead) throw notFound(`User ${input.lead}`);
  const defaultTriage = ((await getSetting(ctx.db, 'defaultTriageMode')) as TriageMode | undefined) ?? 'suggest';
  const id = newId();
  const settings: ProjectSettings = { triageMode: defaultTriage, plan: { ...DEFAULT_PLAN, ...(input.plan ?? {}) } };
  await ctx.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    await tx.insert(projects).values({
      id,
      key,
      name: input.name,
      description: input.description ?? '',
      leadId: lead?.id ?? null,
      settings,
    });
    let ordinal = 0;
    for (const tf of TEMPLATE_FIELDS[input.template ?? 'software']) {
      const field = fieldByName(s, tf.name);
      if (!field) continue;
      await tx.insert(projectFields).values({
        projectId: id,
        fieldId: field.id,
        ordinal: ordinal++,
        required: tf.required ?? false,
        defaultValue: (tf.defaultValue ?? null) as never,
      });
    }
  });
  ctx.app.schema.invalidate();
  return getProject(ctx, key);
}

export async function updateProject(
  ctx: Ctx,
  key: string,
  input: {
    name?: string;
    description?: string;
    lead?: string | null;
    archived?: boolean;
    settings?: { triageMode?: TriageMode; plan?: Partial<PlanSettings> };
  },
): Promise<Project> {
  requireScope(ctx, 'admin');
  const s = await ctx.app.schema.get();
  const p = projectByKey(s, key);
  if (!p) throw notFound(`Project ${key}`);
  let leadId: string | null | undefined;
  if (input.lead === null) leadId = null;
  else if (input.lead) {
    const u = findUser(s, input.lead, ctx.actor.user.id);
    if (!u) throw notFound(`User ${input.lead}`);
    leadId = u.id;
  }
  const current = projectSettings(p);
  const settings: ProjectSettings = {
    triageMode: input.settings?.triageMode ?? current.triageMode,
    plan: { ...current.plan, ...(input.settings?.plan ?? {}) },
  };
  if (settings.plan.workingDays.length === 0) throw badRequest('At least one working day is required');
  await ctx.db
    .update(projects)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(leadId !== undefined ? { leadId } : {}),
      ...(input.archived !== undefined ? { archived: input.archived } : {}),
      settings,
      updatedAt: new Date(),
    })
    .where(eq(projects.id, p.id));
  ctx.app.schema.invalidate();
  return getProject(ctx, key);
}

export async function deleteProject(ctx: Ctx, key: string): Promise<void> {
  requireScope(ctx, 'admin');
  const s = await ctx.app.schema.get();
  const p = projectByKey(s, key);
  if (!p) throw notFound(`Project ${key}`);
  await ctx.db.delete(projects).where(eq(projects.id, p.id));
  ctx.app.schema.invalidate();
}
