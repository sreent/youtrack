import type { Change, EventType, IssueRef, TrackerEvent } from '@a4a/shared';
import type { AppServices, Ctx } from '../context';
import type { Db } from '../db/client';
import { activities } from '../db/schema';
import type { SchemaSnapshot } from '../services/schema-cache';

export type ActivityRow = typeof activities.$inferSelect;

export interface ActivityPayload {
  issue?: IssueRef;
  changes?: Change[];
  data?: Record<string, unknown>;
}

export interface ActivityInput {
  type: EventType;
  projectId: string | null;
  issueId: string | null;
  payload: ActivityPayload;
}

/** Insert an activity row inside the caller's transaction. Publish it after commit. */
export async function recordActivity(tx: Db, ctx: Ctx, input: ActivityInput): Promise<ActivityRow> {
  const [row] = await tx
    .insert(activities)
    .values({
      type: input.type,
      projectId: input.projectId,
      issueId: input.issueId,
      actorId: ctx.actor.authMethod === 'system' && ctx.actor.user.id === 'system' ? null : ctx.actor.user.id,
      channel: ctx.actor.channel,
      tokenName: ctx.actor.tokenName,
      payload: input.payload,
    })
    .returning();
  return row!;
}

export function toEventDto(s: SchemaSnapshot, row: ActivityRow): TrackerEvent {
  const payload = (row.payload ?? {}) as ActivityPayload;
  const actor = row.actorId ? s.users.get(row.actorId) : undefined;
  const project = row.projectId ? s.projects.get(row.projectId) : undefined;
  return {
    id: row.id,
    type: row.type as EventType,
    occurredAt: row.createdAt.toISOString(),
    actor: {
      id: actor?.id ?? null,
      login: actor?.login ?? null,
      name: actor?.name ?? null,
      channel: row.channel as TrackerEvent['actor']['channel'],
      token: row.tokenName,
    },
    project: project?.key ?? null,
    issue: payload.issue ?? null,
    changes: payload.changes ?? [],
    data: payload.data ?? {},
  };
}

/**
 * After commit: wake this instance's live feed and worker (the bus), and tell the
 * other instances which ids committed (NOTIFY). A lost notification only delays
 * delivery until the next one, a LISTEN reconnect or the backstop poll, since every
 * reader works from the log itself; so a failure here is logged, never thrown at a
 * caller whose change is already committed.
 */
export async function publishActivities(app: AppServices, rows: ActivityRow[]): Promise<void> {
  if (!rows.length) return;
  const s = await app.schema.get();
  for (const row of rows) app.bus.publish(toEventDto(s, row));
  await app.signals.announceEvents(rows.map((r) => r.id)).catch((e) => console.warn(`live events: NOTIFY failed (${e instanceof Error ? e.message : e})`));
}
