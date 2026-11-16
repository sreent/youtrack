import type { Tag } from '@a4a/shared';
import { eq, sql } from 'drizzle-orm';
import { requireScope, type Ctx } from '../context';
import type { Db } from '../db/client';
import { tags } from '../db/schema';
import { badRequest, notFound } from '../lib/errors';
import { newId } from '../lib/ids';
import type { TagRow } from './schema-cache';

export function tagDto(t: TagRow): Tag {
  return { id: t.id, name: t.name };
}

/** Find tags by name (case-insensitive), creating missing ones. */
export async function ensureTags(tx: Db, ctx: Ctx, names: string[]): Promise<TagRow[]> {
  const out: TagRow[] = [];
  const s = await ctx.app.schema.get(tx);
  let created = false;
  for (const raw of names) {
    const name = raw.trim().replace(/^#/, '');
    if (!name) continue;
    if (name.length > 60) throw badRequest(`Tag "${name.slice(0, 20)}…" is too long`);
    const existing =
      s.tagsByName.get(name.toLowerCase()) ??
      (await tx.select().from(tags).where(sql`lower(${tags.name}) = ${name.toLowerCase()}`))[0];
    if (existing) {
      out.push(existing);
      continue;
    }
    const [row] = await tx
      .insert(tags)
      .values({ id: newId(), name, createdById: ctx.actor.user.id })
      .onConflictDoNothing()
      .returning();
    if (row) {
      out.push(row);
      created = true;
    } else {
      const [again] = await tx.select().from(tags).where(sql`lower(${tags.name}) = ${name.toLowerCase()}`);
      if (again) out.push(again);
    }
  }
  // Inside the caller's transaction: other instances must reload once it commits, not before.
  if (created) await ctx.app.schema.invalidateOnCommit(tx);
  return out;
}

export async function listTags(ctx: Ctx): Promise<Tag[]> {
  const s = await ctx.app.schema.get();
  return [...s.tags.values()].map(tagDto);
}

export async function createTag(ctx: Ctx, input: { name: string }): Promise<Tag> {
  requireScope(ctx, 'write');
  const s = await ctx.app.schema.get();
  if (s.tagsByName.has(input.name.trim().toLowerCase())) throw badRequest(`Tag "${input.name}" already exists`);
  const [row] = await ctx.db
    .insert(tags)
    .values({ id: newId(), name: input.name.trim(), createdById: ctx.actor.user.id })
    .returning();
  ctx.app.schema.invalidate();
  return tagDto(row!);
}

export async function updateTag(ctx: Ctx, id: string, input: { name?: string }): Promise<Tag> {
  requireScope(ctx, 'write');
  const [row] = await ctx.db
    .update(tags)
    .set({ ...(input.name ? { name: input.name.trim() } : {}) })
    .where(eq(tags.id, id))
    .returning();
  if (!row) throw notFound('Tag');
  ctx.app.schema.invalidate();
  return tagDto(row);
}

export async function deleteTag(ctx: Ctx, id: string): Promise<void> {
  requireScope(ctx, 'write');
  const res = await ctx.db.delete(tags).where(eq(tags.id, id)).returning({ id: tags.id });
  if (!res.length) throw notFound('Tag');
  ctx.app.schema.invalidate();
}
