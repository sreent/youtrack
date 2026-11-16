/**
 * GitHub and GitLab integrations, as administrators manage them: added (with a webhook URL and a
 * secret shown once), changed, paused, given a new secret, tested, and their recent deliveries.
 *
 * GitHub signs each delivery with the secret (HMAC-SHA256), so a4a must keep the secret itself to
 * check the signature, as it keeps its own webhooks' secrets to sign with. GitLab sends the token
 * as it is, so a4a keeps only the token's SHA-256. Neither is ever returned after it is shown.
 */
import type { VcsDelivery, VcsIntegration, VcsIntegrationCreated, VcsProvider, VcsTestResult } from '@a4a/shared';
import { createHmac } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import { requireScope, type AppServices, type Ctx } from '../context';
import { vcsDeliveries, vcsIntegrations } from '../db/schema';
import { randomToken, sha256 } from '../lib/crypto';
import { badRequest, notFound } from '../lib/errors';
import { newId } from '../lib/ids';
import { projectByKey, type SchemaSnapshot } from '../services/schema-cache';
import type { IntegrationRow } from './links';
import { receive } from './receive';

export function webhookUrl(app: AppServices, id: string): string {
  return `${app.config.publicUrl}/api/v1/vcs/hooks/${id}`;
}

function dto(app: AppServices, s: SchemaSnapshot, row: IntegrationRow): VcsIntegration {
  return {
    id: row.id,
    provider: row.provider as VcsProvider,
    name: row.name,
    projects: row.projectIds.map((id) => s.projects.get(id)?.key).filter((k): k is string => Boolean(k)),
    active: row.active,
    webhookUrl: webhookUrl(app, row.id),
    secretPrefix: row.secretPrefix,
    createdAt: row.createdAt.toISOString(),
    lastDeliveryAt: row.lastDeliveryAt?.toISOString() ?? null,
  };
}

function projectIds(s: SchemaSnapshot, keys: string[]): string[] {
  const out: string[] = [];
  for (const key of keys) {
    const p = projectByKey(s, key);
    if (!p) throw notFound(`Project ${key}`, `Projects: ${[...s.projectsByKey.keys()].join(', ')}`);
    if (!out.includes(p.id)) out.push(p.id);
  }
  return out;
}

/** A new secret, and what a4a keeps of it: the key itself for GitHub, a hash for GitLab. */
function secretFor(provider: VcsProvider): { secret: string; kept: Pick<IntegrationRow, 'signingKey' | 'tokenHash' | 'secretPrefix'> } {
  const secret = randomToken('', 32);
  return {
    secret,
    kept: { signingKey: provider === 'github' ? secret : null, tokenHash: provider === 'gitlab' ? sha256(secret) : null, secretPrefix: secret.slice(0, 6) },
  };
}

async function load(ctx: Ctx, id: string): Promise<IntegrationRow> {
  const [row] = await ctx.db.select().from(vcsIntegrations).where(eq(vcsIntegrations.id, id));
  if (!row) throw notFound('Integration');
  return row;
}

export async function listIntegrations(ctx: Ctx): Promise<VcsIntegration[]> {
  requireScope(ctx, 'admin');
  const s = await ctx.app.schema.get();
  const rows = await ctx.db.select().from(vcsIntegrations).orderBy(desc(vcsIntegrations.createdAt));
  return rows.map((r) => dto(ctx.app, s, r));
}

export async function createIntegration(ctx: Ctx, input: { provider: VcsProvider; name: string; projects?: string[]; active?: boolean }): Promise<VcsIntegrationCreated> {
  requireScope(ctx, 'admin');
  const s = await ctx.app.schema.get();
  const name = input.name.trim();
  if (!name) throw badRequest('Give it a name, such as its repository', 'e.g. acme/backend');
  const { secret, kept } = secretFor(input.provider);
  const [row] = await ctx.db
    .insert(vcsIntegrations)
    .values({
      id: newId(),
      provider: input.provider,
      name,
      projectIds: projectIds(s, input.projects ?? []),
      ...kept,
      active: input.active ?? true,
      createdById: ctx.actor.user.id,
    })
    .returning();
  return { ...dto(ctx.app, s, row!), secret };
}

export async function updateIntegration(ctx: Ctx, id: string, input: { name?: string; projects?: string[]; active?: boolean }): Promise<VcsIntegration> {
  requireScope(ctx, 'admin');
  const s = await ctx.app.schema.get();
  const row = await load(ctx, id);
  if (input.name !== undefined && !input.name.trim()) throw badRequest('Give it a name, such as its repository');
  const [updated] = await ctx.db
    .update(vcsIntegrations)
    .set({
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.projects !== undefined ? { projectIds: projectIds(s, input.projects) } : {}),
      ...(input.active !== undefined ? { active: input.active } : {}),
    })
    .where(eq(vcsIntegrations.id, row.id))
    .returning();
  return dto(ctx.app, s, updated!);
}

export async function deleteIntegration(ctx: Ctx, id: string): Promise<void> {
  requireScope(ctx, 'admin');
  const row = await load(ctx, id);
  await ctx.db.delete(vcsIntegrations).where(eq(vcsIntegrations.id, row.id));
}

/** A new secret, shown once; the old one stops working at once. */
export async function rotateIntegrationSecret(ctx: Ctx, id: string): Promise<VcsIntegrationCreated> {
  requireScope(ctx, 'admin');
  const s = await ctx.app.schema.get();
  const row = await load(ctx, id);
  const { secret, kept } = secretFor(row.provider as VcsProvider);
  const [updated] = await ctx.db.update(vcsIntegrations).set(kept).where(eq(vcsIntegrations.id, row.id)).returning();
  return { ...dto(ctx.app, s, updated!), secret };
}

export async function listVcsDeliveries(ctx: Ctx, id: string, limit = 50): Promise<VcsDelivery[]> {
  requireScope(ctx, 'admin');
  const row = await load(ctx, id);
  const rows = await ctx.db
    .select()
    .from(vcsDeliveries)
    .where(eq(vcsDeliveries.integrationId, row.id))
    .orderBy(desc(vcsDeliveries.createdAt))
    .limit(Math.min(Math.max(limit, 1), 200));
  return rows.map((r) => ({
    id: r.id,
    deliveryId: r.deliveryId,
    event: r.event,
    outcome: r.outcome as VcsDelivery['outcome'],
    statusCode: r.statusCode,
    message: r.message,
    linked: r.linked,
    applied: r.applied,
    test: r.test,
    createdAt: r.createdAt.toISOString(),
  }));
}

/**
 * a4a sends itself a delivery as the provider would and handles it as any other: for GitHub a
 * ping, signed with the secret, so the signature is checked too; for GitLab a push with no
 * commits. a4a keeps only a hash of GitLab's token, so it can't send one, and that check is the
 * one part a GitLab test leaves out.
 */
export async function testIntegration(ctx: Ctx, id: string): Promise<VcsTestResult> {
  requireScope(ctx, 'admin');
  const row = await load(ctx, id);
  const github = row.provider === 'github';
  const body = new TextEncoder().encode(
    JSON.stringify(
      github
        ? { zen: 'Speak like a human.', hook_id: 0, hook: { type: 'Repository', events: ['push', 'pull_request'] } }
        : { object_kind: 'push', event_name: 'push', ref: 'refs/heads/main', after: 'a'.repeat(40), project: { path_with_namespace: row.name }, commits: [], total_commits_count: 0 },
    ),
  );
  const headers: Record<string, string> = github
    ? { 'content-type': 'application/json', 'x-github-event': 'ping', 'x-hub-signature-256': `sha256=${createHmac('sha256', row.signingKey ?? '').update(body).digest('hex')}` }
    : { 'content-type': 'application/json', 'x-gitlab-event': 'Push Hook' };
  const answer = await receive(ctx.app, row.id, { header: (n) => headers[n.toLowerCase()], body, ip: 'a4a' }, { test: true, trusted: !github });
  const outcome = (answer.body.outcome as VcsTestResult['outcome'] | undefined) ?? 'failed';
  const error = answer.body.error as { message?: string } | undefined;
  return { delivered: answer.status < 300, outcome, message: String(answer.body.message ?? error?.message ?? '') };
}
