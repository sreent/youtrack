/**
 * The access tokens integrations keep to read from their provider (Bitbucket's commits, D33; GitHub's
 * compare for builds, D46). a4a sends them, so it must read them back: since D46 they're kept
 * encrypted with SECRET_KEY (lib/secret-box.ts). One kept as it was given before then is still read.
 *
 * A GitHub integration may read as a GitHub App instead (D54): `readWith` is the one way to read from
 * a provider as an integration, with whichever it has, for whatever reads (builds today, more CI later).
 */
import type { AppServices } from '../context';
import { AppError, pageWords } from '../lib/errors';
import { open, seal } from '../lib/secret-box';
import { ReadError } from './commits';
import { forgetInstallationToken, GITHUB_API, installationToken, type AppCredentials } from './github-app';
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

/** The GitHub App a GitHub integration reads as, with its key opened; null when it reads otherwise. */
export function appCredentials(app: AppServices, integration: Reads & Pick<IntegrationRow, 'baseUrl'>): AppCredentials | null {
  if (integration.provider !== 'github' || !integration.githubAppId || !integration.githubInstallationId) return null;
  const privateKey = integration.githubAppKey ? open(keySource(app), integration.githubAppKey) : null;
  if (!privateKey) return null;
  return { api: (integration.baseUrl ?? GITHUB_API).replace(/\/+$/, ''), appId: integration.githubAppId, privateKey, installationId: integration.githubInstallationId };
}

/** The installation's token, or why not, in the words a delivery's log or a build's note says. */
async function appToken(integrationId: string, c: AppCredentials, fresh: boolean): Promise<string> {
  try {
    return await installationToken(integrationId, c, { fresh });
  } catch (e) {
    if (e instanceof AppError) throw new ReadError(`as the GitHub App: ${pageWords(e.message, e.hint)}`);
    throw e;
  }
}

/**
 * Read from the provider as the integration: as its GitHub App when it has one, else with its access
 * token. A request the provider refuses with 401 under an app's token is tried once more with a new
 * one, since GitHub can end a token early. Throws ReadError, whose words say what's wrong. D55 and
 * any other reader of a provider's API call this rather than reading a token themselves.
 */
export async function readWith<T>(app: AppServices, integration: IntegrationRow, request: (token: string) => Promise<T>, repository?: string): Promise<T> {
  const c = appCredentials(app, integration);
  if (!c) {
    if (integration.githubAppId && integration.provider === 'github') throw new ReadError('the GitHub App’s key can’t be opened: was SECRET_KEY changed? Give the integration its app again');
    const token = tokenOf(app, integration.accessToken);
    if (!token) throw new ReadError('the integration has no access token');
    return request(token);
  }
  const asApp = async (token: string) => {
    try {
      return await request(token);
    } catch (e) {
      if (e instanceof ReadError && e.status === 404 && repository) {
        throw new ReadError(`the GitHub App’s installation ${c.installationId} can’t see ${repository}, or a commit isn’t there (404): is the repository in the installation’s repository access?`, 404);
      }
      throw e;
    }
  };
  try {
    return await asApp(await appToken(integration.id, c, false));
  } catch (e) {
    if (!(e instanceof ReadError) || e.status !== 401) throw e;
    forgetInstallationToken(integration.id);
    return asApp(await appToken(integration.id, c, true));
  }
}
