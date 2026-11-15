import type { Settings, TriageMode } from '@tracklet/shared';
import { APP_NAME } from '@tracklet/shared';
import { eq } from 'drizzle-orm';
import { requireScope, type Ctx } from '../context';
import type { Db } from '../db/client';
import { settings } from '../db/schema';

export async function getSetting(db: Db, key: string): Promise<unknown> {
  const [row] = await db.select().from(settings).where(eq(settings.key, key));
  return row?.value;
}

export async function setSetting(db: Db, key: string, value: unknown): Promise<void> {
  await db
    .insert(settings)
    .values({ key, value: value as never })
    .onConflictDoUpdate({ target: settings.key, set: { value: value as never } });
}

export async function getSettings(ctx: Ctx): Promise<Settings> {
  requireScope(ctx, 'read');
  return {
    instanceName: ((await getSetting(ctx.db, 'instanceName')) as string | undefined) ?? APP_NAME,
    defaultTriageMode: ((await getSetting(ctx.db, 'defaultTriageMode')) as TriageMode | undefined) ?? 'suggest',
    publicUrl: ctx.app.config.publicUrl,
  };
}

export async function updateSettings(
  ctx: Ctx,
  input: { instanceName?: string; defaultTriageMode?: TriageMode },
): Promise<Settings> {
  requireScope(ctx, 'admin');
  if (input.instanceName !== undefined) await setSetting(ctx.db, 'instanceName', input.instanceName);
  if (input.defaultTriageMode !== undefined) await setSetting(ctx.db, 'defaultTriageMode', input.defaultTriageMode);
  return getSettings(ctx);
}
