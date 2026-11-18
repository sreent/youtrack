import type { PasskeysRequired, Settings, TriageMode } from '@a4a/shared';
import { APP_NAME } from '@a4a/shared';
import { eq } from 'drizzle-orm';
import { requireScope, type Ctx } from '../context';
import type { Db } from '../db/client';
import { settings } from '../db/schema';
import { applyPasskeySettings, requiredOfWhom } from './passkey-policy';
import { authenticatorList } from './passkeys';

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
    requireTwoFactor: (await getSetting(ctx.db, 'requireTwoFactor')) === true,
    passkeys: (await getSetting(ctx.db, 'passkeys')) !== false,
    requirePasskeys: await requiredOfWhom(ctx.db),
    passkeyAuthenticators: await authenticatorList(ctx.app),
  };
}

export async function updateSettings(
  ctx: Ctx,
  input: { instanceName?: string; defaultTriageMode?: TriageMode; requireTwoFactor?: boolean; passkeys?: boolean; requirePasskeys?: PasskeysRequired; passkeyAuthenticators?: string[] | null },
): Promise<Settings> {
  requireScope(ctx, 'admin');
  if (input.instanceName !== undefined) await setSetting(ctx.db, 'instanceName', input.instanceName);
  if (input.defaultTriageMode !== undefined) await setSetting(ctx.db, 'defaultTriageMode', input.defaultTriageMode);
  // From the next sign-in on, every password sign-in asks for a code; someone without an app sets one up then (D38).
  if (input.requireTwoFactor !== undefined) await setSetting(ctx.db, 'requireTwoFactor', input.requireTwoFactor);
  // The switch (D62), whose passkeys are required and which authenticators are taken (D68): refused where they'd lock administrators out.
  await applyPasskeySettings(ctx, { passkeys: input.passkeys, requirePasskeys: input.requirePasskeys, passkeyAuthenticators: input.passkeyAuthenticators });
  return getSettings(ctx);
}
