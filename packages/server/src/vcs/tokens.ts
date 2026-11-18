/**
 * The access tokens integrations keep to read from their provider (Bitbucket's commits, D33; GitHub's
 * compare for builds, D46). a4a sends them, so it must read them back: since D46 they're kept
 * encrypted with SECRET_KEY (lib/secret-box.ts). One kept as it was given before then is still read.
 *
 * A GitHub integration may read as a GitHub App instead (D54): `readWith` is the one way to read from
 * a provider as an integration, with whichever it has, for whatever reads (builds today, more CI later).
 * As an app, each repository is read through its own installation (D66), and `asApp` is the way to
 * reach GitHub for a repository as the app, for reading or for writing its check runs.
 */
import type { AppServices } from '../context';
import { AppError, pageWords } from '../lib/errors';
import { open, seal } from '../lib/secret-box';
import { ReadError } from './commits';
import {
  appProblems,
  forgetInstallationToken,
  forgetRepositoryInstallation,
  GITHUB_API,
  installationToken,
  repositoryInstallation,
  type AppCredentials,
  type TokenPurpose,
} from './github-app';
import { markInstallation, noteRepository } from './installations';
import type { IntegrationRow } from './links';

const keySource = (app: AppServices) => ({ secretKey: app.config.secretKey, dataDir: app.config.dataDir });

export function sealToken(app: AppServices, token: string): string {
  return seal(keySource(app), token);
}

/** The token as it was given, or null when there is none (or it was sealed with another key). */
export function tokenOf(app: AppServices, stored: string | null | undefined): string | null {
  if (!stored) return null;
  if (stored.startsWith('v1.')) {
    const plain = open(keySource(app), stored);
    if (plain !== null) return plain;
    if (stored.split('.').length === 4) return null;
  }
  return stored;
}

type Reads = Pick<IntegrationRow, 'provider' | 'accessToken' | 'githubAppId' | 'githubAppKey' | 'githubInstallationId'>;

/** Whether an integration can read from its provider: it has an access token, or is a GitHub App's. */
export function readsFromProvider(integration: Reads): boolean {
  return Boolean(integration.accessToken) || Boolean(integration.provider === 'github' && integration.githubAppId && integration.githubAppKey && integration.githubInstallationId);
}

/** The GitHub App a GitHub integration reads as, with its key opened and its own installation; null when it reads otherwise. */
export function appCredentials(app: AppServices, integration: Reads & Pick<IntegrationRow, 'baseUrl'>): AppCredentials | null {
  if (integration.provider !== 'github' || !integration.githubAppId || !integration.githubInstallationId) return null;
  const privateKey = integration.githubAppKey ? open(keySource(app), integration.githubAppKey) : null;
  if (!privateKey) return null;
  return { api: (integration.baseUrl ?? GITHUB_API).replace(/\/+$/, ''), appId: integration.githubAppId, privateKey, installationId: integration.githubInstallationId };
}

/** An AppError's words, as a ReadError a delivery's log or a build's note says. */
function asReadError(e: unknown): unknown {
  return e instanceof AppError ? new ReadError(`as the GitHub App: ${pageWords(e.message, e.hint)}`) : e;
}

/** Where a repository is read: found as the app, kept, and refused at once when GitHub says it's suspended. */
async function placeOf(app: AppServices, integration: IntegrationRow, c: AppCredentials, repository: string, fresh: boolean): Promise<string> {
  const { facts, found } = await repositoryInstallation(integration.id, c, repository, { fresh });
  if (found) await noteRepository(app.db, integration.id, facts, repository);
  if (facts.suspended) {
    forgetRepositoryInstallation(integration.id, repository);
    throw appProblems.suspended(facts.id);
  }
  return facts.id;
}

/**
 * A request to GitHub as the integration's app for a repository, through that repository's own
 * installation (D66), with a token for one purpose; a request that names no repository goes through
 * the integration's own. A request refused with 401 is tried once more with a new token, since
 * GitHub can end one early. An installation GitHub says is gone is looked up again, once: the app
 * may have been installed again since. Throws the AppErrors of github-app.ts, and the request's own.
 */
export async function asApp<T>(
  app: AppServices,
  integration: IntegrationRow,
  c: AppCredentials,
  repository: string | null,
  purpose: TokenPurpose,
  request: (token: string, installationId: string) => Promise<T>,
): Promise<T> {
  const attempt = async (installationId: string): Promise<T> => {
    const at = { ...c, installationId };
    try {
      return await request(await installationToken(integration.id, at, { purpose }), installationId);
    } catch (e) {
      if (!(e instanceof ReadError) || e.status !== 401) throw e;
      forgetInstallationToken(integration.id, installationId, purpose);
      return request(await installationToken(integration.id, at, { purpose, fresh: true }), installationId);
    }
  };
  const marked = async (installationId: string, e: unknown) => {
    const key = e instanceof AppError ? e.words?.key : undefined;
    if (key === 'vcs.githubApp.installationGone') await markInstallation(app.db, integration.id, installationId, 'gone');
    if (key === 'vcs.githubApp.suspended') await markInstallation(app.db, integration.id, installationId, 'suspended');
    return key;
  };
  const installationId = repository ? await placeOf(app, integration, c, repository, false) : c.installationId;
  try {
    return await attempt(installationId);
  } catch (e) {
    const key = await marked(installationId, e);
    if (!repository || (key !== 'vcs.githubApp.installationGone' && key !== 'vcs.githubApp.suspended')) throw e;
    // Installed again, or the repository moved: where it is now, once.
    forgetRepositoryInstallation(integration.id, repository);
    const again = await placeOf(app, integration, c, repository, true);
    if (again === installationId) throw e;
    try {
      return await attempt(again);
    } catch (e2) {
      await marked(again, e2);
      throw e2;
    }
  }
}

/**
 * Read from the provider as the integration: as its GitHub App when it has one, through the
 * repository's own installation (D66), else with its access token. Throws ReadError, whose words say
 * what's wrong, for the repository it was reading. D55 and any other reader of a provider's API call
 * this rather than reading a token themselves.
 */
export async function readWith<T>(app: AppServices, integration: IntegrationRow, request: (token: string) => Promise<T>, repository?: string): Promise<T> {
  const c = appCredentials(app, integration);
  if (!c) {
    if (integration.githubAppId && integration.provider === 'github') throw new ReadError('the GitHub App’s key can’t be opened: was SECRET_KEY changed? Give the integration its app again');
    const token = tokenOf(app, integration.accessToken);
    if (!token) throw new ReadError('the integration has no access token');
    return request(token);
  }
  try {
    return await asApp(app, integration, c, repository ?? null, 'read', async (token, installationId) => {
      try {
        return await request(token);
      } catch (e) {
        if (e instanceof ReadError && e.status === 404 && repository) {
          throw new ReadError(`the GitHub App’s installation ${installationId} can’t see ${repository}, or a commit isn’t there (404): is the repository in the installation’s repository access?`, 404);
        }
        throw e;
      }
    });
  } catch (e) {
    throw asReadError(e);
  }
}
