import { isOptionType } from '@a4a/shared';
import type { Field, FieldType, FieldValue, ProjectField, Tone } from '@a4a/shared';
import { and, eq, sql } from 'drizzle-orm';
import { requireScope, type Ctx } from '../context';
import type { Db } from '../db/client';
import { fields, fieldValues, issueFieldValues, projectFields } from '../db/schema';
import { badRequest, notFound } from '../lib/errors';
import { newId } from '../lib/ids';
import { assigneeFieldIdOf, requireProject, visibleSchema } from './access';
import { checkFieldCondition } from './conditions';
import { allowedValues, fieldByName, findUser, projectByKey, type FieldRow, type FieldValueRow, type SchemaSnapshot } from './schema-cache';
import { toneOf, userRefDto } from './values';

export function valueDto(v: FieldValueRow, s?: SchemaSnapshot): FieldValue {
  const owner = v.ownerId && s ? s.users.get(v.ownerId) : undefined;
  return {
    id: v.id,
    name: v.name,
    description: v.description,
    tone: toneOf(v.tone),
    ordinal: v.ordinal,
    isResolved: v.isResolved,
    archived: v.archived,
    projectId: v.projectId,
    owner: owner ? userRefDto(owner) : null,
  };
}

/** An owned field's value's owner, by login or name; null clears it. */
function ownerIdOf(s: SchemaSnapshot, field: FieldRow, owner: string | null | undefined): string | null | undefined {
  if (owner === undefined) return undefined;
  if (owner !== null && field.type !== 'owned') throw badRequest(`${field.name} is not an owned field, so its values have no owners`, 'Make it owned first (PATCH the field with {"type": "owned"}).').said('fields.notOwned', { name: field.name });
  if (owner === null || !owner.trim()) return null;
  const u = findUser(s, owner);
  if (!u) throw badRequest(`Unknown user "${owner}"`, 'Give a login or a name.').said('fields.unknownOwner', { owner });
  return u.id;
}

export function fieldDto(s: SchemaSnapshot, f: FieldRow): Field {
  return {
    id: f.id,
    name: f.name,
    type: f.type,
    multi: f.multi,
    description: f.description,
    values: (s.valuesByField.get(f.id) ?? []).map((v) => valueDto(v, s)),
  };
}

/** A group field's choices: every group, offered as its values (D41). */
function groupChoices(s: SchemaSnapshot): FieldValue[] {
  return [...s.groups.values()].map((g, i) => ({ id: g.id, name: g.name, description: '', tone: null, ordinal: i, isResolved: false, archived: false, projectId: null, owner: null }));
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
      values: f.type === 'group' ? groupChoices(s) : allowedValues(s, f.id, projectId).map((v) => valueDto(v, s)),
      condition: pf.condition ?? null,
      private: pf.private,
    });
  }
  return out;
}

/** Every field, with the values the caller may see: a project's own values only where they see the project. */
export async function listFields(ctx: Ctx): Promise<Field[]> {
  requireScope(ctx, 'read');
  const s = await visibleSchema(ctx);
  return [...s.fields.values()].map((f) => fieldDto(s, f));
}

export interface NewFieldValue {
  name: string;
  tone?: Tone | null;
  isResolved?: boolean;
  description?: string;
  projectId?: string | null;
  /** An owned field's value: who owns it (D41). */
  ownerId?: string | null;
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
      ownerId: v.ownerId ?? null,
    });
  }
  return id;
}

export async function createField(
  ctx: Ctx,
  input: { name: string; type: FieldType; multi: boolean; description: string; values: (NewFieldValue & { owner?: string })[] },
): Promise<Field> {
  requireScope(ctx, 'admin');
  const s = await ctx.app.schema.get();
  if (fieldByName(s, input.name)) throw badRequest(`A field named "${input.name}" already exists`).said('fields.nameTaken', { name: input.name });
  if (!isOptionType(input.type) && input.values.length) {
    throw badRequest(`${input.type} fields do not take a list of values`).said('fields.typeTakesNoValues', { type: input.type });
  }
  if (input.type !== 'state' && input.values.some((v) => v.isResolved)) {
    throw badRequest('Only state fields have resolved values').said('fields.onlyStateResolves');
  }
  const probe = { name: input.name, type: input.type } as FieldRow;
  const values = input.values.map(({ owner, ...v }) => ({ ...v, ownerId: ownerIdOf(s, probe, owner) ?? null }));
  const id = await createFieldRaw(ctx.db, { ...input, values });
  ctx.app.schema.invalidate();
  const fresh = await ctx.app.schema.get();
  return fieldDto(fresh, fresh.fields.get(id)!);
}

export async function updateField(ctx: Ctx, id: string, input: { name?: string; description?: string; type?: 'enum' | 'owned' }): Promise<Field> {
  requireScope(ctx, 'admin');
  const current = (await ctx.app.schema.get()).fields.get(id);
  if (!current) throw notFound('Field').said('notFound.fieldUnnamed');
  // An enum field and an owned one differ only in their values having owners: one turns into the other.
  if (input.type && input.type !== current.type) {
    if (current.type !== 'enum' && current.type !== 'owned') throw badRequest(`${current.name} is a ${current.type} field`, 'Only an enum field becomes owned, and back.').said('fields.onlyEnumBecomesOwned', { name: current.name, type: current.type });
    if (input.type === 'enum') await ctx.db.update(fieldValues).set({ ownerId: null }).where(eq(fieldValues.fieldId, id));
  }
  // History keeps a change under the name a field had then: a private field's are known by it still (D50).
  const renamed = input.name && input.name !== current.name ? [...new Set([...(current.formerNames ?? []), current.name])] : null;
  const [row] = await ctx.db
    .update(fields)
    .set({
      ...(input.name ? { name: input.name } : {}),
      ...(renamed ? { formerNames: renamed } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.type ? { type: input.type } : {}),
    })
    .where(eq(fields.id, id))
    .returning();
  if (!row) throw notFound('Field').said('notFound.fieldUnnamed');
  ctx.app.schema.invalidate();
  const s = await ctx.app.schema.get();
  return fieldDto(s, s.fields.get(id)!);
}

export async function deleteField(ctx: Ctx, id: string): Promise<void> {
  requireScope(ctx, 'admin');
  const res = await ctx.db.delete(fields).where(eq(fields.id, id)).returning({ id: fields.id });
  if (!res.length) throw notFound('Field').said('notFound.fieldUnnamed');
  ctx.app.schema.invalidate();
}

export async function addFieldValue(
  ctx: Ctx,
  fieldId: string,
  input: { name: string; tone?: Tone | null; isResolved?: boolean; description?: string; ordinal?: number; project?: string | null; owner?: string | null },
): Promise<FieldValue> {
  requireScope(ctx, 'admin');
  const s = await ctx.app.schema.get();
  const field = s.fields.get(fieldId);
  if (!field) throw notFound('Field').said('notFound.fieldUnnamed');
  if (!isOptionType(field.type)) throw badRequest(`${field.name} does not have a list of values`).said('fields.noListOfValues', { name: field.name });
  const project = input.project ? projectByKey(s, input.project) : undefined;
  if (input.project && !project) throw notFound(`Project ${input.project}`).said('notFound.project', { id: input.project });
  const dup = (s.valuesByField.get(fieldId) ?? []).find(
    (v) => v.name.toLowerCase() === input.name.toLowerCase() && (v.projectId === null || v.projectId === (project?.id ?? null)),
  );
  // A build field takes the same build twice without complaint: CI reports each build it makes, maybe more than once (D41).
  if (dup && field.type === 'build') return valueDto(dup, s);
  if (dup) throw badRequest(`${field.name} already has a value "${input.name}"`).said('fields.valueExists', { name: field.name, name2: input.name });
  const ownerId = ownerIdOf(s, field, input.owner);
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
      ownerId: ownerId ?? null,
    })
    .returning();
  ctx.app.schema.invalidate();
  return valueDto(row!, s);
}

export async function updateFieldValue(
  ctx: Ctx,
  fieldId: string,
  valueId: string,
  input: { name?: string; tone?: Tone | null; isResolved?: boolean; description?: string; ordinal?: number; archived?: boolean; owner?: string | null },
): Promise<FieldValue> {
  requireScope(ctx, 'admin');
  const s = await ctx.app.schema.get();
  const field = s.fields.get(fieldId);
  if (!field) throw notFound('Field').said('notFound.fieldUnnamed');
  const ownerId = ownerIdOf(s, field, input.owner);
  const [row] = await ctx.db
    .update(fieldValues)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.tone !== undefined ? { tone: input.tone } : {}),
      ...(input.isResolved !== undefined ? { isResolved: input.isResolved } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.ordinal !== undefined ? { ordinal: input.ordinal } : {}),
      ...(input.archived !== undefined ? { archived: input.archived } : {}),
      ...(ownerId !== undefined ? { ownerId } : {}),
    })
    .where(and(eq(fieldValues.id, valueId), eq(fieldValues.fieldId, fieldId)))
    .returning();
  if (!row) throw notFound('Field value').said('notFound.fieldValueUnnamed');
  ctx.app.schema.invalidate();
  return valueDto(row, s);
}

export async function deleteFieldValue(ctx: Ctx, fieldId: string, valueId: string): Promise<void> {
  requireScope(ctx, 'admin');
  const [{ n } = { n: 0 }] = await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(issueFieldValues)
    .where(eq(issueFieldValues.valueId, valueId));
  if (Number(n) > 0) {
    throw badRequest(`This value is used by ${Number(n) === 1 ? '1 issue' : `${n} issues`}`, 'Archive it instead (PATCH with {"archived": true}), or change those issues first.').said('fields.valueInUseBy', { n: Number(n) });
  }
  const res = await ctx.db
    .delete(fieldValues)
    .where(and(eq(fieldValues.id, valueId), eq(fieldValues.fieldId, fieldId)))
    .returning({ id: fieldValues.id });
  if (!res.length) throw notFound('Field value').said('notFound.fieldValueUnnamed');
  ctx.app.schema.invalidate();
}

export async function attachField(
  ctx: Ctx,
  projectKey: string,
  fieldId: string,
  input: { required?: boolean; ordinal?: number; defaultValue?: unknown; condition?: string | null; private?: boolean },
): Promise<ProjectField[]> {
  // Which fields a project has is its managers' to say; the catalogue of fields is the administrators'.
  const project = await requireProject(ctx, projectKey, 'manage');
  const s = await ctx.app.schema.get();
  const field = s.fields.get(fieldId) ?? fieldByName(s, fieldId);
  if (!field) throw notFound('Field').said('notFound.fieldUnnamed');
  const existing = (s.projectFields.get(project.id) ?? []).length;
  // A condition is a search in the project's words; one that doesn't read is refused now (D41).
  const condition = input.condition === undefined ? undefined : checkFieldCondition(s, project.id, input.condition);
  // a4a reads whether an issue is resolved and who has it for everyone: whom to tell, who sees a limited
  // issue, boards' columns and #Resolved. Kept from some, they'd still say what they hold (D50).
  if (input.private && (field.type === 'state' || field.id === assigneeFieldIdOf(s))) {
    throw badRequest(`${field.name} can't be private`, 'a4a reads it for everyone: whether an issue is resolved, and who has it. Make another field private instead.').said('fields.cantBePrivate', { name: field.name });
  }
  await ctx.db
    .insert(projectFields)
    .values({
      projectId: project.id,
      fieldId: field.id,
      required: input.required ?? false,
      ordinal: input.ordinal ?? existing,
      defaultValue: (input.defaultValue ?? null) as never,
      condition: condition ?? null,
      private: input.private ?? false,
    })
    .onConflictDoUpdate({
      target: [projectFields.projectId, projectFields.fieldId],
      set: {
        required: input.required ?? false,
        ...(input.ordinal !== undefined ? { ordinal: input.ordinal } : {}),
        defaultValue: (input.defaultValue ?? null) as never,
        // Left as it is unless the call says.
        ...(condition !== undefined ? { condition } : {}),
        ...(input.private !== undefined ? { private: input.private } : {}),
      },
    });
  ctx.app.schema.invalidate();
  return projectFieldDtos(await ctx.app.schema.get(), project.id);
}

export async function detachField(ctx: Ctx, projectKey: string, fieldId: string): Promise<void> {
  const project = await requireProject(ctx, projectKey, 'manage');
  await ctx.db.delete(projectFields).where(and(eq(projectFields.projectId, project.id), eq(projectFields.fieldId, fieldId)));
  ctx.app.schema.invalidate();
}
