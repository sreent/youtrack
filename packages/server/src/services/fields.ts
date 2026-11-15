import type { Field, FieldType, FieldValue, ProjectField, Tone } from '@tracklet/shared';
import { and, eq, sql } from 'drizzle-orm';
import { requireScope, type Ctx } from '../context';
import type { Db } from '../db/client';
import { fields, fieldValues, issueFieldValues, projectFields } from '../db/schema';
import { badRequest, notFound } from '../lib/errors';
import { newId } from '../lib/ids';
import { allowedValues, fieldByName, projectByKey, type FieldRow, type FieldValueRow, type SchemaSnapshot } from './schema-cache';
import { toneOf } from './values';

export function valueDto(v: FieldValueRow): FieldValue {
  return {
    id: v.id,
    name: v.name,
    description: v.description,
    tone: toneOf(v.tone),
    ordinal: v.ordinal,
    isResolved: v.isResolved,
    archived: v.archived,
    projectId: v.projectId,
  };
}

export function fieldDto(s: SchemaSnapshot, f: FieldRow): Field {
  return {
    id: f.id,
    name: f.name,
    type: f.type,
    multi: f.multi,
    description: f.description,
    values: (s.valuesByField.get(f.id) ?? []).map(valueDto),
  };
}

export function projectFieldDtos(s: SchemaSnapshot, projectId: string): ProjectField[] {
  const out: ProjectField[] = [];
  for (const pf of s.projectFields.get(projectId) ?? []) {
    const f = s.fields.get(pf.fieldId);
    if (!f) continue;
    out.push({
      fieldId: f.id,
      name: f.name,
      type: f.type,
      multi: f.multi,
      required: pf.required,
      ordinal: pf.ordinal,
      defaultValue: pf.defaultValue ?? null,
      values: allowedValues(s, f.id, projectId).map(valueDto),
    });
  }
  return out;
}

export async function listFields(ctx: Ctx): Promise<Field[]> {
  requireScope(ctx, 'read');
  const s = await ctx.app.schema.get();
  return [...s.fields.values()].map((f) => fieldDto(s, f));
}

export interface NewFieldValue {
  name: string;
  tone?: Tone | null;
  isResolved?: boolean;
  description?: string;
  projectId?: string | null;
}

/** Create a field (idempotent by name when `ifMissing`). Used by admin API and defaults. */
export async function createFieldRaw(
  db: Db,
  input: { name: string; type: FieldType; multi?: boolean; description?: string; ordinal?: number; values?: NewFieldValue[] },
): Promise<string> {
  const id = newId();
  await db.insert(fields).values({
    id,
    name: input.name,
    type: input.type,
    multi: input.multi ?? false,
    description: input.description ?? '',
    ordinal: input.ordinal ?? 100,
  });
  let ordinal = 0;
  for (const v of input.values ?? []) {
    await db.insert(fieldValues).values({
      id: newId(),
      fieldId: id,
      projectId: v.projectId ?? null,
      name: v.name,
      tone: v.tone ?? null,
      isResolved: v.isResolved ?? false,
      description: v.description ?? '',
      ordinal: ordinal++,
    });
  }
  return id;
}

export async function createField(
  ctx: Ctx,
  input: { name: string; type: FieldType; multi: boolean; description: string; values: NewFieldValue[] },
): Promise<Field> {
  requireScope(ctx, 'admin');
  const s = await ctx.app.schema.get();
  if (fieldByName(s, input.name)) throw badRequest(`A field named "${input.name}" already exists`);
  if (['user', 'string', 'text', 'integer', 'float', 'date', 'period'].includes(input.type) && input.values.length) {
    throw badRequest(`${input.type} fields do not take a list of values`);
  }
  if (input.type !== 'state' && input.values.some((v) => v.isResolved)) {
    throw badRequest('Only state fields have resolved values');
  }
  const id = await createFieldRaw(ctx.db, input);
  ctx.app.schema.invalidate();
  const fresh = await ctx.app.schema.get();
  return fieldDto(fresh, fresh.fields.get(id)!);
}

export async function updateField(ctx: Ctx, id: string, input: { name?: string; description?: string }): Promise<Field> {
  requireScope(ctx, 'admin');
  const [row] = await ctx.db
    .update(fields)
    .set({ ...(input.name ? { name: input.name } : {}), ...(input.description !== undefined ? { description: input.description } : {}) })
    .where(eq(fields.id, id))
    .returning();
  if (!row) throw notFound('Field');
  ctx.app.schema.invalidate();
  const s = await ctx.app.schema.get();
  return fieldDto(s, s.fields.get(id)!);
}

export async function deleteField(ctx: Ctx, id: string): Promise<void> {
  requireScope(ctx, 'admin');
  const res = await ctx.db.delete(fields).where(eq(fields.id, id)).returning({ id: fields.id });
  if (!res.length) throw notFound('Field');
  ctx.app.schema.invalidate();
}

export async function addFieldValue(
  ctx: Ctx,
  fieldId: string,
  input: { name: string; tone?: Tone | null; isResolved?: boolean; description?: string; ordinal?: number; project?: string | null },
): Promise<FieldValue> {
  requireScope(ctx, 'admin');
  const s = await ctx.app.schema.get();
  const field = s.fields.get(fieldId);
  if (!field) throw notFound('Field');
  if (!['enum', 'state', 'version'].includes(field.type)) throw badRequest(`${field.name} does not have a list of values`);
  const project = input.project ? projectByKey(s, input.project) : undefined;
  if (input.project && !project) throw notFound(`Project ${input.project}`);
  const dup = (s.valuesByField.get(fieldId) ?? []).find(
    (v) => v.name.toLowerCase() === input.name.toLowerCase() && (v.projectId === null || v.projectId === (project?.id ?? null)),
  );
  if (dup) throw badRequest(`${field.name} already has a value "${input.name}"`);
  const maxOrd = Math.max(-1, ...(s.valuesByField.get(fieldId) ?? []).map((v) => v.ordinal));
  const [row] = await ctx.db
    .insert(fieldValues)
    .values({
      id: newId(),
      fieldId,
      projectId: project?.id ?? null,
      name: input.name,
      tone: input.tone ?? null,
      isResolved: field.type === 'state' ? (input.isResolved ?? false) : false,
      description: input.description ?? '',
      ordinal: input.ordinal ?? maxOrd + 1,
    })
    .returning();
  ctx.app.schema.invalidate();
  return valueDto(row!);
}

export async function updateFieldValue(
  ctx: Ctx,
  fieldId: string,
  valueId: string,
  input: { name?: string; tone?: Tone | null; isResolved?: boolean; description?: string; ordinal?: number; archived?: boolean },
): Promise<FieldValue> {
  requireScope(ctx, 'admin');
  const [row] = await ctx.db
    .update(fieldValues)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.tone !== undefined ? { tone: input.tone } : {}),
      ...(input.isResolved !== undefined ? { isResolved: input.isResolved } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.ordinal !== undefined ? { ordinal: input.ordinal } : {}),
      ...(input.archived !== undefined ? { archived: input.archived } : {}),
    })
    .where(and(eq(fieldValues.id, valueId), eq(fieldValues.fieldId, fieldId)))
    .returning();
  if (!row) throw notFound('Field value');
  ctx.app.schema.invalidate();
  return valueDto(row);
}

export async function deleteFieldValue(ctx: Ctx, fieldId: string, valueId: string): Promise<void> {
  requireScope(ctx, 'admin');
  const [{ n } = { n: 0 }] = await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(issueFieldValues)
    .where(eq(issueFieldValues.valueId, valueId));
  if (Number(n) > 0) {
    throw badRequest(`This value is used by ${n} issue(s)`, 'Archive it instead (PATCH with {"archived": true}), or change those issues first.');
  }
  const res = await ctx.db
    .delete(fieldValues)
    .where(and(eq(fieldValues.id, valueId), eq(fieldValues.fieldId, fieldId)))
    .returning({ id: fieldValues.id });
  if (!res.length) throw notFound('Field value');
  ctx.app.schema.invalidate();
}

export async function attachField(
  ctx: Ctx,
  projectKey: string,
  fieldId: string,
  input: { required?: boolean; ordinal?: number; defaultValue?: unknown },
): Promise<ProjectField[]> {
  requireScope(ctx, 'admin');
  const s = await ctx.app.schema.get();
  const project = projectByKey(s, projectKey);
  if (!project) throw notFound(`Project ${projectKey}`);
  const field = s.fields.get(fieldId) ?? fieldByName(s, fieldId);
  if (!field) throw notFound('Field');
  const existing = (s.projectFields.get(project.id) ?? []).length;
  await ctx.db
    .insert(projectFields)
    .values({
      projectId: project.id,
      fieldId: field.id,
      required: input.required ?? false,
      ordinal: input.ordinal ?? existing,
      defaultValue: (input.defaultValue ?? null) as never,
    })
    .onConflictDoUpdate({
      target: [projectFields.projectId, projectFields.fieldId],
      set: {
        required: input.required ?? false,
        ...(input.ordinal !== undefined ? { ordinal: input.ordinal } : {}),
        defaultValue: (input.defaultValue ?? null) as never,
      },
    });
  ctx.app.schema.invalidate();
  return projectFieldDtos(await ctx.app.schema.get(), project.id);
}

export async function detachField(ctx: Ctx, projectKey: string, fieldId: string): Promise<void> {
  requireScope(ctx, 'admin');
  const s = await ctx.app.schema.get();
  const project = projectByKey(s, projectKey);
  if (!project) throw notFound(`Project ${projectKey}`);
  await ctx.db.delete(projectFields).where(and(eq(projectFields.projectId, project.id), eq(projectFields.fieldId, fieldId)));
  ctx.app.schema.invalidate();
}
