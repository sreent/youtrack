/**
 * GitHub as an App (docs/architecture.md, D54).
 *
 * A GitHub integration can read as a GitHub App instead of with a person's token: GitHub's way for a
 * service to act as itself, so reading doesn't stop when the person who made a token leaves, and what
 * it may read is what the app was given, installation by installation.
 *
 * a4a signs a JSON web token with the app's private key (RS256, issued a minute back for clocks that
 * drift, ten minutes long at most, as GitHub asks) and trades it for an installation's token, which
 * GitHub lets live an hour and limits to reading contents here. That token is kept in memory per
 * integration until five minutes before it expires, and never written anywhere: each instance takes
 * its own. Two reads at once share one exchange. A token GitHub refuses before its time (the
 * installation removed, its permissions changed) is dropped and taken again, once (tokens.ts).
 *
 * What goes wrong is said plainly, as a problem an administrator can act on: a key GitHub doesn't
 * take, an app not installed on the repository, an installation removed or suspended, an app that
 * may not read contents, or a repository its installation wasn't given.
 */
import { createHash, createPrivateKey, sign, type KeyObject } from 'node:crypto';
import { z } from 'zod';
import { badRequest } from '../lib/errors';

export const GITHUB_API = 'https://api.github.com';
const TIMEOUT_MS = 10_000;
/** A token is used until this long before GitHub says it expires; then a new one is taken. */
const RENEW_BEFORE_MS = 5 * 60_000;
/** All a4a reads with an installation's token: a repository's contents (its commits, compared). */
const READS = { contents: 'read' } as const;
/** An app's id (a number), or its client id (Iv1.…, Iv23…). */
const APP_ID = /^(\d{1,15}|Iv[0-9A-Za-z._-]{2,60})$/;
const REPOSITORY = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

const INSTALL_HINT = 'Check the API’s address: GitHub Enterprise Server’s ends in /api/v3.';

/** What goes wrong, as problems with their fix (D49). */
export const appProblems = {
  notAnAppId: () => badRequest('That isn’t a GitHub App’s id', 'Give its App ID, a number, or its Client ID (Iv…), from the app’s settings page on GitHub.').said('vcs.githubApp.notAnAppId'),
  notAKey: () =>
    badRequest('That isn’t a GitHub App’s private key', 'Give the .pem file GitHub made under the app’s Private keys, whole: from its BEGIN line to its END line.').said('vcs.githubApp.notAKey'),
  keyRefused: (status: number) =>
    badRequest(`GitHub didn’t take the app’s key (${status})`, 'Check the app’s id, and that the key is one of its private keys and wasn’t deleted. The server’s clock must be right to the minute.').said(
      'vcs.githubApp.keyRefused',
      { status },
    ),
  notInstalledOn: (repository: string) =>
    badRequest(`The app isn’t installed on ${repository}`, 'Install it there from the app’s page on GitHub (Install App), or give the installation to read through.').said('vcs.githubApp.notInstalledOn', {
      repository,
    }),
  notInstalled: () => badRequest('The app isn’t installed anywhere yet', 'Install it on the repository from the app’s page on GitHub (Install App).').said('vcs.githubApp.notInstalled'),
  whichInstallation: (installations: string) =>
    badRequest(`The app is installed on ${installations}: say which installation to read through`, 'Give its id, the number at the end of its address on GitHub (…/installations/12345678).').said(
      'vcs.githubApp.whichInstallation',
      { installations },
    ),
  installationGone: (id: string) =>
    badRequest(`The app’s installation ${id} is gone`, 'It was uninstalled, or is another app’s. Install the app again, and give the integration its new installation.').said('vcs.githubApp.installationGone', {
      id,
    }),
  suspended: (id: string) =>
    badRequest(`The app’s installation ${id} is suspended`, 'Unsuspend it on GitHub, in the settings of the account it’s installed on, under GitHub Apps.').said('vcs.githubApp.suspended', { id }),
  cantReadContents: () =>
    badRequest('The app may not read repositories’ contents', 'In the app’s settings on GitHub, give it Contents: Read-only under Repository permissions, then accept the new permissions on its installation.').said(
      'vcs.githubApp.cantReadContents',
    ),
  notGiven: (id: string, repository: string) =>
    badRequest(`The app’s installation ${id} isn’t given ${repository}`, 'On GitHub, add the repository to the installation’s Repository access, or give it all repositories.').said('vcs.githubApp.notGiven', {
      id,
      repository,
    }),
  unreachable: (host: string) => badRequest(`GitHub couldn’t be reached at ${host}`, INSTALL_HINT).said('vcs.githubApp.unreachable', { host }),
  answered: (host: string, status: number) => badRequest(`${host} answered ${status}`, `${INSTALL_HINT} Or try again in a minute.`).said('vcs.githubApp.answered', { host, status }),
};

/** The app's private key, as GitHub made it: an RSA key in PEM (PKCS#1 or PKCS#8). */
export function readKey(pem: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: pem.trim(), format: 'pem' });
  } catch {
    throw appProblems.notAKey();
  }
  if (key.asymmetricKeyType !== 'rsa') throw appProblems.notAKey();
  return key;
}

/** The JSON web token an app signs to speak as itself: RS256, issued a minute back, ten minutes long. */
export function appJwt(appId: string, key: KeyObject, now = Date.now()): string {
  const at = Math.floor(now / 1000);
  const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const signed = `${part({ alg: 'RS256', typ: 'JWT' })}.${part({ iat: at - 60, exp: at + 540, iss: /^\d+$/.test(appId) ? Number(appId) : appId })}`;
  return `${signed}.${sign('sha256', Buffer.from(signed), key).toString('base64url')}`;
}

interface Answer {
  status: number;
  json: unknown;
}

const repoPath = (repository: string) => repository.split('/').map(encodeURIComponent).join('/');

/** One request to GitHub's API: no redirects followed, ten seconds at most, never logged. */
async function ask(api: string, path: string, bearer: string, body?: unknown): Promise<Answer> {
  let res: Response;
  try {
    res = await fetch(`${api}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${bearer}`,
        'x-github-api-version': '2022-11-28',
        'user-agent': 'a4a',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw appProblems.unreachable(new URL(api).host);
  }
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

/** What GitHub answered, read as it answers: anything else is a problem naming the address. */
function read<T>(schema: z.ZodType<T>, got: Answer, api: string): T {
  const host = new URL(api).host;
  if (got.status >= 500) throw appProblems.unreachable(host);
  if (got.status >= 300) throw appProblems.answered(host, got.status);
  const parsed = schema.safeParse(got.json);
  if (!parsed.success) throw appProblems.answered(host, got.status);
  return parsed.data;
}

const Installation = z.object({ id: z.number().int(), account: z.object({ login: z.string() }).nullish(), suspended_at: z.string().nullish() });
const TokenAnswer = z.object({ token: z.string().min(1), expires_at: z.string() });
const AppAnswer = z.object({ slug: z.string().nullish() });
const messageOf = (got: Answer) => String((got.json as { message?: unknown } | null)?.message ?? '');

export interface InstallationToken {
  token: string;
  expiresAt: number;
}

/** An installation's token for the app: an hour long, reading contents only. */
async function takeToken(api: string, appId: string, key: KeyObject, installationId: string): Promise<InstallationToken> {
  const got = await ask(api, `/app/installations/${encodeURIComponent(installationId)}/access_tokens`, appJwt(appId, key), { permissions: READS });
  if (got.status === 401) throw appProblems.keyRefused(401);
  if (got.status === 404) throw appProblems.installationGone(installationId);
  if (got.status === 403 && /suspend/i.test(messageOf(got))) throw appProblems.suspended(installationId);
  if (got.status === 422) throw appProblems.cantReadContents();
  const t = read(TokenAnswer, got, api);
  const expiresAt = Date.parse(t.expires_at);
  return { token: t.token, expiresAt: Number.isFinite(expiresAt) ? expiresAt : Date.now() + 60 * 60_000 };
}

export interface AppGiven {
  appId: string;
  privateKey: string;
  installationId?: string | null;
}

export interface AppFound {
  appId: string;
  slug: string | null;
  installationId: string;
  account: string | null;
  token: InstallationToken;
}

/**
 * An app an administrator gives an integration, checked before it's kept: GitHub takes its key, it's
 * installed, and its installation may read the repository the integration is named after. The
 * installation is the one given, else the one on that repository, else the app's only one.
 */
export async function findGithubApp(api: string, given: AppGiven, repository: string | null): Promise<AppFound> {
  const appId = given.appId.trim();
  if (!APP_ID.test(appId)) throw appProblems.notAnAppId();
  const key = readKey(given.privateKey);
  const jwt = appJwt(appId, key);
  const me = await ask(api, '/app', jwt);
  if (me.status === 401 || me.status === 403 || me.status === 404) throw appProblems.keyRefused(me.status);
  const app = read(AppAnswer, me, api);
  const repo = repository && REPOSITORY.test(repository) ? repository : null;
  let installation: z.infer<typeof Installation>;
  let foundOnRepository = false;
  if (given.installationId) {
    const got = await ask(api, `/app/installations/${encodeURIComponent(given.installationId)}`, jwt);
    if (got.status === 404) throw appProblems.installationGone(given.installationId);
    installation = read(Installation, got, api);
  } else if (repo) {
    const got = await ask(api, `/repos/${repoPath(repo)}/installation`, jwt);
    if (got.status === 404) throw appProblems.notInstalledOn(repo);
    installation = read(Installation, got, api);
    foundOnRepository = true;
  } else {
    const all = read(z.array(Installation), await ask(api, '/app/installations?per_page=100', jwt), api);
    if (!all.length) throw appProblems.notInstalled();
    // The first ten, as the account and its id: enough to choose by, short enough to read.
    if (all.length > 1) throw appProblems.whichInstallation(`${all.slice(0, 10).map((i) => `${i.account?.login ?? '?'} (${i.id})`).join(', ')}${all.length > 10 ? ', …' : ''}`);
    installation = all[0]!;
  }
  const installationId = String(installation.id);
  if (installation.suspended_at) throw appProblems.suspended(installationId);
  const token = await takeToken(api, appId, key, installationId);
  if (repo && !foundOnRepository) {
    const got = await ask(api, `/repos/${repoPath(repo)}`, token.token);
    if (got.status === 404 || got.status === 403) throw appProblems.notGiven(installationId, repo);
    if (got.status >= 300) read(z.unknown(), got, api);
  }
  return { appId, slug: app.slug ?? null, installationId, account: installation.account?.login ?? null, token };
}

// The installation tokens a4a holds: in memory, per integration, never written down.
// ---------------------------------------------------------------------------------

export interface AppCredentials {
  api: string;
  appId: string;
  privateKey: string;
  installationId: string;
}

const held = new Map<string, { token: InstallationToken; fingerprint: string }>();
const taking = new Map<string, Promise<InstallationToken>>();

/** What a held token was taken with: another key, app, installation or address makes it stale. */
const fingerprintOf = (c: AppCredentials) => createHash('sha256').update([c.api, c.appId, c.installationId, c.privateKey.trim()].join('\n')).digest('hex');

/**
 * The installation's token for an integration: the one held, until five minutes before it expires,
 * else a new one (`fresh` takes a new one whatever is held). Reads at once share one exchange.
 */
export async function installationToken(integrationId: string, c: AppCredentials, opts: { fresh?: boolean } = {}): Promise<string> {
  const fingerprint = fingerprintOf(c);
  const kept = held.get(integrationId);
  if (!opts.fresh && kept?.fingerprint === fingerprint && kept.token.expiresAt - Date.now() > RENEW_BEFORE_MS) return kept.token.token;
  const flightKey = `${integrationId} ${fingerprint}`;
  let flight = taking.get(flightKey);
  if (!flight) {
    flight = takeToken(c.api, c.appId, readKey(c.privateKey), c.installationId)
      .then((token) => {
        held.set(integrationId, { token, fingerprint });
        return token;
      })
      .finally(() => taking.delete(flightKey));
    taking.set(flightKey, flight);
  }
  return (await flight).token;
}

/** Hold a token just taken (when an app is given), so the first read doesn't take another. */
export function holdInstallationToken(integrationId: string, c: AppCredentials, token: InstallationToken): void {
  held.set(integrationId, { token, fingerprint: fingerprintOf(c) });
}

/** Drop what's held for an integration: it changed, went, or GitHub refused its token. */
export function forgetInstallationToken(integrationId: string): void {
  held.delete(integrationId);
}
