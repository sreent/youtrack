/**
 * Version control integrations, as administrators manage them: added (with a webhook URL and a
 * secret shown once), changed, paused, given a new secret, tested, and their recent deliveries.
 *
 * GitHub, Bitbucket, Gitea and Forgejo sign each delivery with the secret (HMAC-SHA256), so a4a
 * must keep the secret itself to check the signature, as it keeps its own webhooks' secrets to
 * sign with. GitLab sends the token as it is, so a4a keeps only the token's SHA-256. Neither is
 * ever returned after it is shown. Nor is a Bitbucket access token, which a4a sends to read
 * commits (D33), nor a GitHub App's private key, with which a GitHub integration reads as the app
 * instead of with a person's token (D54): the app is checked with GitHub before it's kept.
 */
import { VCS_PROVIDER_NAMES, type VcsDelivery, type VcsGithubAppBody, type VcsIntegration, type VcsIntegrationCreated, type VcsProvider, type VcsTestResult } from '@a4a/shared';
import type { z } from 'zod';
import { createHmac } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import { requireScope, type AppServices, type Ctx } from '../context';
import { vcsDeliveries, vcsIntegrations } from '../db/schema';
import { randomToken, sha256 } from '../lib/crypto';
import { AppError, badRequest, notFound, pageWords } from '../lib/errors';
import { newId } from '../lib/ids';
import { projectByKey, type SchemaSnapshot } from '../services/schema-cache';
import { checkBaseUrl } from './commits';
import { findGithubApp, forgetInstallationToken, GITHUB_API, holdInstallationToken, installationToken } from './github-app';
import type { IntegrationRow } from './links';
import { receive } from './receive';
import { appCredentials, sealToken } from './tokens';

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
    baseUrl: row.baseUrl,
    hasAccessToken: Boolean(row.accessToken),
    githubApp:
      row.provider === 'github' && row.githubAppId && row.githubInstallationId
        ? { appId: row.githubAppId, slug: row.githubAppSlug, installationId: row.githubInstallationId, account: row.githubAccount }
        : null,
    createdAt: row.createdAt.toISOString(),
    lastDeliveryAt: row.lastDeliveryAt?.toISOString() ?? null,
  };
}

function projectIds(s: SchemaSnapshot, keys: string[]): string[] {
  const out: string[] = [];
  for (const key of keys) {
    const p = projectByKey(s, key);
    const known = [...s.projects.values()].map((x) => x.key).join(', ');
    if (!p) throw notFound(`Project ${key}`, `Projects: ${known}`).said('vcs.projectNotFound', { id: key, projects: known });
    if (!out.includes(p.id)) out.push(p.id);
  }
  return out;
}

/** A new secret, and what a4a keeps of it: the key itself where the provider signs with it, a hash for GitLab. */
function secretFor(provider: VcsProvider): { secret: string; kept: Pick<IntegrationRow, 'signingKey' | 'tokenHash' | 'secretPrefix'> } {
  const secret = randomToken('', 32);
  const gitlab = provider === 'gitlab';
  return { secret, kept: { signingKey: gitlab ? null : secret, tokenHash: gitlab ? sha256(secret) : null, secretPrefix: secret.slice(0, 6) } };
}

/**
 * The address and access token an integration keeps, for those that read from their provider:
 * Bitbucket (the commits a delivery leaves out, D33) and GitHub (which commits a build holds, D46).
 * Data Center must have an address; Bitbucket Cloud may name another for its API (a proxy), and
 * GitHub Enterprise Server its API's. The others take neither. A token is kept sealed.
 */
function providerFields(
  app: AppServices,
  provider: VcsProvider,
  input: { baseUrl?: string | null; accessToken?: string | null; githubApp?: unknown },
  now: Pick<IntegrationRow, 'baseUrl' | 'accessToken'> | null,
): Partial<Pick<IntegrationRow, 'baseUrl' | 'accessToken'>> {
  const reads = provider === 'bitbucket' || provider === 'bitbucket-dc' || provider === 'github';
  if (provider !== 'github' && input.githubApp) {
    throw badRequest(`${VCS_PROVIDER_NAMES[provider]} integrations don’t read as a GitHub App`, 'Only a GitHub integration does.').said('vcs.githubApp.onlyGithub', { provider: VCS_PROVIDER_NAMES[provider] });
  }
  if (!reads) {
    if (input.baseUrl || input.accessToken) {
      throw badRequest(`${VCS_PROVIDER_NAMES[provider]} integrations take no address or access token`, 'Its deliveries carry what a4a reads.').said('vcs.noAddressNeeded', { provider: VCS_PROVIDER_NAMES[provider] });
    }
    return {};
  }
  const at = provider === 'github' ? { name: 'GitHub Enterprise Server’s API', example: 'https://github.acme.example/api/v3' } : undefined;
  const out: Partial<Pick<IntegrationRow, 'baseUrl' | 'accessToken'>> = {};
  if (input.baseUrl !== undefined) out.baseUrl = input.baseUrl === null || !input.baseUrl.trim() ? null : checkBaseUrl(input.baseUrl, at, app.config.vcsAllowHttpLoopback);
  if (input.accessToken !== undefined) out.accessToken = input.accessToken?.trim() ? sealToken(app, input.accessToken.trim()) : null;
  const baseUrl = out.baseUrl !== undefined ? out.baseUrl : (now?.baseUrl ?? null);
  if (provider === 'bitbucket-dc' && !baseUrl) {
    throw badRequest('Give Bitbucket Data Center’s address', 'The address people open it at, e.g. https://bitbucket.acme.example: a4a reads the commits a push moved there.').said('vcs.bitbucketAddressNeeded');
  }
  return out;
}

type AppColumns = Pick<IntegrationRow, 'githubAppId' | 'githubAppKey' | 'githubInstallationId' | 'githubAppSlug' | 'githubAccount'>;
const NO_APP: AppColumns = { githubAppId: null, githubAppKey: null, githubInstallationId: null, githubAppSlug: null, githubAccount: null };

/**
 * A GitHub integration's app (D54): checked with GitHub, then kept with its key sealed, and the
 * token taken while checking held for the first read. A GitHub integration reads as an app or
 * with a person's token, not both: giving one ends the other, and giving both at once is refused.
 */
async function appFields(
  app: AppServices,
  id: string,
  provider: VcsProvider,
  input: { githubApp?: z.infer<typeof VcsGithubAppBody> | null; accessToken?: string | null },
  at: { name: string; baseUrl: string | null },
): Promise<Partial<AppColumns> & { accessToken?: null }> {
  if (provider !== 'github') return {};
  if (input.githubApp === undefined) return input.accessToken?.trim() ? NO_APP : {};
  if (input.githubApp === null) return NO_APP;
  if (input.accessToken?.trim()) {
    throw badRequest('Give an access token or a GitHub App, not both', 'An app reads as itself; a token reads as the person who made it.').said('vcs.githubApp.notBoth');
  }
  const api = (at.baseUrl ?? GITHUB_API).replace(/\/+$/, '');
  const found = await findGithubApp(api, input.githubApp, at.name);
  const privateKey = input.githubApp.privateKey.trim();
  holdInstallationToken(id, { api, appId: found.appId, privateKey, installationId: found.installationId }, found.token);
  return {
    githubAppId: found.appId,
    githubAppKey: sealToken(app, privateKey),
    githubInstallationId: found.installationId,
    githubAppSlug: found.slug,
    githubAccount: found.account,
    accessToken: null,
  };
}

async function load(ctx: Ctx, id: string): Promise<IntegrationRow> {
  const [row] = await ctx.db.select().from(vcsIntegrations).where(eq(vcsIntegrations.id, id));
  if (!row) throw notFound('Integration').said('vcs.integrationNotFound');
  return row;
}

export async function listIntegrations(ctx: Ctx): Promise<VcsIntegration[]> {
  requireScope(ctx, 'admin');
  const s = await ctx.app.schema.get();
  const rows = await ctx.db.select().from(vcsIntegrations).orderBy(desc(vcsIntegrations.createdAt));
  return rows.map((r) => dto(ctx.app, s, r));
}

export async function createIntegration(
  ctx: Ctx,
  input: {
    provider: VcsProvider;
    name: string;
    projects?: string[];
    active?: boolean;
    baseUrl?: string | null;
    accessToken?: string | null;
    githubApp?: z.infer<typeof VcsGithubAppBody> | null;
  },
): Promise<VcsIntegrationCreated> {
  requireScope(ctx, 'admin');
  const s = await ctx.app.schema.get();
  const name = input.name.trim();
  if (!name) throw badRequest('Give it a name, such as its repository', 'e.g. acme/backend').said('vcs.nameNeededExample');
  const bitbucket = providerFields(ctx.app, input.provider, input, null);
  const projects = projectIds(s, input.projects ?? []);
  const id = newId();
  const github = await appFields(ctx.app, id, input.provider, input, { name, baseUrl: bitbucket.baseUrl ?? null });
  const { secret, kept } = secretFor(input.provider);
  const [row] = await ctx.db
    .insert(vcsIntegrations)
    .values({
      id,
      provider: input.provider,
      name,
      projectIds: projects,
      ...kept,
      ...bitbucket,
      ...github,
      active: input.active ?? true,
      createdById: ctx.actor.user.id,
    })
    .returning();
  return { ...dto(ctx.app, s, row!), secret };
}

export async function updateIntegration(
  ctx: Ctx,
  id: string,
  input: {
    name?: string;
    projects?: string[];
    active?: boolean;
    baseUrl?: string | null;
    accessToken?: string | null;
    githubApp?: z.infer<typeof VcsGithubAppBody> | null;
  },
): Promise<VcsIntegration> {
  requireScope(ctx, 'admin');
  const s = await ctx.app.schema.get();
  const row = await load(ctx, id);
  if (input.name !== undefined && !input.name.trim()) throw badRequest('Give it a name, such as its repository').said('vcs.nameNeeded');
  const bitbucket = providerFields(ctx.app, row.provider as VcsProvider, input, row);
  const projects = input.projects !== undefined ? projectIds(s, input.projects) : undefined;
  const name = input.name !== undefined ? input.name.trim() : row.name;
  const github = await appFields(ctx.app, row.id, row.provider as VcsProvider, input, { name, baseUrl: bitbucket.baseUrl !== undefined ? bitbucket.baseUrl : row.baseUrl });
  if (github.githubAppId === null) forgetInstallationToken(row.id);
  const [updated] = await ctx.db
    .update(vcsIntegrations)
    .set({
      ...(input.name !== undefined ? { name } : {}),
      ...(projects !== undefined ? { projectIds: projects } : {}),
      ...(input.active !== undefined ? { active: input.active } : {}),
      ...bitbucket,
      ...github,
    })
    .where(eq(vcsIntegrations.id, row.id))
    .returning();
  return dto(ctx.app, s, updated!);
}

export async function deleteIntegration(ctx: Ctx, id: string): Promise<void> {
  requireScope(ctx, 'admin');
  const row = await load(ctx, id);
  await ctx.db.delete(vcsIntegrations).where(eq(vcsIntegrations.id, row.id));
  forgetInstallationToken(row.id);
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

/** What a4a sends itself to test an integration, as each provider would send it. */
function testDelivery(row: IntegrationRow): { body: unknown; headers: Record<string, string> } {
  switch (row.provider as VcsProvider) {
    case 'github':
      return { body: { zen: 'Speak like a human.', hook_id: 0, hook: { type: 'Repository', events: ['push', 'pull_request'] } }, headers: { 'x-github-event': 'ping' } };
    case 'gitlab':
      return {
        body: { object_kind: 'push', event_name: 'push', ref: 'refs/heads/main', after: 'a'.repeat(40), project: { path_with_namespace: row.name }, commits: [], total_commits_count: 0 },
        headers: { 'x-gitlab-event': 'Push Hook' },
      };
    case 'bitbucket':
      return { body: { repository: { full_name: row.name }, push: { changes: [] } }, headers: { 'x-event-key': 'repo:push' } };
    case 'bitbucket-dc':
      return { body: { test: true }, headers: { 'x-event-key': 'diagnostics:ping' } };
    case 'gitea':
      return { body: { ref: 'refs/heads/main', after: 'a'.repeat(40), repository: { full_name: row.name }, commits: [] }, headers: { 'x-gitea-event': 'push' } };
  }
}

/**
 * a4a sends itself a delivery as the provider would and handles it as any other, signed with the
 * secret where the provider signs, so the signature is checked too. a4a keeps only a hash of
 * GitLab's token, so it can't send one, and that check is the one part a GitLab test leaves out.
 */
export async function testIntegration(ctx: Ctx, id: string): Promise<VcsTestResult> {
  requireScope(ctx, 'admin');
  const row = await load(ctx, id);
  const signs = row.provider !== 'gitlab';
  const made = testDelivery(row);
  const body = new TextEncoder().encode(JSON.stringify(made.body));
  const hmac = createHmac('sha256', row.signingKey ?? '').update(body).digest('hex');
  const signature: Record<string, string> = !signs
    ? {}
    : row.provider === 'github'
      ? { 'x-hub-signature-256': `sha256=${hmac}` }
      : row.provider === 'gitea'
        ? { 'x-gitea-signature': hmac }
        : { 'x-hub-signature': `sha256=${hmac}` };
  const headers: Record<string, string> = { 'content-type': 'application/json', ...made.headers, ...signature };
  const answer = await receive(ctx.app, row.id, { header: (n) => headers[n.toLowerCase()], body, ip: 'a4a' }, { test: true, trusted: !signs });
  const outcome = (answer.body.outcome as VcsTestResult['outcome'] | undefined) ?? 'failed';
  const error = answer.body.error as { message?: string } | undefined;
  const result = { delivered: answer.status < 300, outcome, message: answer.said ?? String(answer.body.message ?? error?.message ?? '') };
  return row.provider === 'github' && row.githubAppId ? { ...result, ...(await testApp(ctx.app, row, result.message)) } : result;
}

/** A GitHub integration's app, tested as well: a4a takes a new token as it, so a removed installation shows now (D54). */
async function testApp(app: AppServices, row: IntegrationRow, said: string): Promise<Partial<VcsTestResult>> {
  const c = appCredentials(app, row);
  if (!c) return { delivered: false, message: `${said} But the GitHub App’s key can’t be opened: was SECRET_KEY changed? Give the integration its app again.` };
  try {
    await installationToken(row.id, c, { fresh: true });
    return { message: `${said} a4a took a token as the GitHub App${row.githubAppSlug ? ` ${row.githubAppSlug}` : ''}, so it reads as the app.` };
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
    return { delivered: false, message: `${said} But a4a couldn’t take a token as the GitHub App: ${pageWords(e.message, e.hint)}` };
  }
}
