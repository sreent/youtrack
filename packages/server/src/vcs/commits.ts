/**
 * The commits a delivery leaves out, read from the provider with the integration's access token
 * (D33). Bitbucket Data Center's push deliveries name the commits a branch moved between, not what
 * they say; Bitbucket Cloud's carry the latest five a branch got. a4a reads the rest from their
 * REST APIs, a page at a time, newest first, up to as many as it reads from one push.
 *
 * The address is the one an administrator gave (https; plain http only to this machine, and only
 * in tests). Redirects aren't followed, and a page's link to the next stays on that address, so a
 * reply can't send a4a anywhere else.
 */
import { z } from 'zod';
import { badRequest } from '../lib/errors';
import type { IntegrationRow } from './links';
import { BitbucketCommit, bitbucketCommit, DcUser, dcUser, link, when, type Commit, type PushRef } from './payloads';

const TIMEOUT_MS = 10_000;
const PAGE = 100;
export const BITBUCKET_CLOUD_API = 'https://api.bitbucket.org';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const underTest = () => Boolean(process.env.VITEST) || process.env.NODE_ENV === 'test';

/** An address an administrator gave, as a4a will use it: https, without a path's trailing slash. */
export function checkBaseUrl(raw: string, at: { name: string; example: string } = { name: 'Bitbucket', example: 'https://bitbucket.acme.example' }): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw badRequest('That isn’t an address', `Give ${at.name}’s address, e.g. ${at.example}`).said('vcs.notAnAddress', { host: at.name, example: at.example });
  }
  const loopbackHttp = url.protocol === 'http:' && LOOPBACK.has(url.hostname) && underTest();
  if (url.protocol !== 'https:' && !loopbackHttp) throw badRequest(`${at.name}’s address must be https`, `e.g. https://${url.host || new URL(at.example).host}`).said('vcs.httpsOnly', { host: at.name, example: url.host || new URL(at.example).host });
  if (url.username || url.password) throw badRequest('Give the address without a name or password in it', 'The access token is how a4a signs in.').said('vcs.noCredentialsInAddress');
  if (url.search || url.hash) throw badRequest('Give the address alone, without ? or #', `e.g. ${url.origin}${url.pathname.replace(/\/+$/, '')}`).said('vcs.addressAlone', { origin: url.origin, path: url.pathname.replace(/\/+$/, '') });
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

export class ReadError extends Error {}

/** JSON from a provider's API, with a token, no redirects followed (D33; D46 reads GitHub's compare with it). */
export async function getJson(url: string, token: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    const why = e instanceof Error && e.name === 'TimeoutError' ? `no answer in ${TIMEOUT_MS / 1000}s` : 'it couldn’t be reached';
    throw new ReadError(why);
  }
  if (res.status === 401 || res.status === 403) throw new ReadError(`the access token was refused (${res.status}): is it still valid, and may it read the repository?`);
  if (res.status === 404) throw new ReadError('the repository or a commit wasn’t found (404): may the token read it?');
  if (!res.ok) throw new ReadError(`it answered ${res.status}`);
  try {
    return await res.json();
  } catch {
    throw new ReadError('its answer wasn’t JSON');
  }
}

// Bitbucket Cloud ------------------------------------------------------------

const CloudPage = z.object({ values: z.array(BitbucketCommit).default([]), next: z.string().nullish() });
const CloudRepository = z.object({ mainbranch: z.object({ name: z.string() }).nullish() });

async function readCloud(base: string, token: string, repository: string, ref: PushRef & { more: NonNullable<PushRef['more']> }, max: number): Promise<Commit[]> {
  const repo = repository.split('/').map(encodeURIComponent).join('/');
  const params = new URLSearchParams({ include: ref.more.to, pagelen: String(Math.min(PAGE, max)) });
  if (ref.more.from) params.append('exclude', ref.more.from);
  else if (ref.branch) {
    // A new branch: what it has that the main branch hasn't.
    const r = CloudRepository.parse(await getJson(`${base}/2.0/repositories/${repo}?fields=mainbranch.name`, token));
    if (r.mainbranch?.name && r.mainbranch.name !== ref.branch) params.append('exclude', r.mainbranch.name);
  }
  const out: Commit[] = [];
  let url: string | null = `${base}/2.0/repositories/${repo}/commits?${params}`;
  const origin = new URL(base).origin;
  while (url && out.length < max) {
    const page = CloudPage.parse(await getJson(url, token));
    out.push(...page.values.map(bitbucketCommit));
    url = page.next && new URL(page.next).origin === origin ? page.next : null;
  }
  return out.slice(0, max);
}

// Bitbucket Data Center --------------------------------------------------------

const DcCommit = z.object({
  id: z.string().min(4).max(64),
  message: z.string().nullish(),
  authorTimestamp: z.number().nullish(),
  author: DcUser.nullish(),
});
const DcPage = z.object({ values: z.array(DcCommit).default([]), isLastPage: z.boolean().default(true), nextPageStart: z.number().nullish() });
const DcBranch = z.object({ displayId: z.string().nullish(), latestCommit: z.string().nullish() });

async function readDc(base: string, token: string, repository: string, ref: PushRef & { more: NonNullable<PushRef['more']> }, max: number): Promise<Commit[]> {
  const [key, slug] = repository.split('/');
  if (!key || !slug) throw new ReadError(`“${repository}” isn’t a repository's PROJECT/name`);
  const repo = `${base}/rest/api/1.0/projects/${encodeURIComponent(key)}/repos/${encodeURIComponent(slug)}`;
  let since = ref.more.from;
  if (!since && ref.branch) {
    // A new branch: what it has that the default branch hasn't.
    const def = DcBranch.parse(await getJson(`${repo}/branches/default`, token));
    if (def.displayId && def.displayId !== ref.branch && def.latestCommit) since = def.latestCommit;
  }
  const out: Commit[] = [];
  let start = 0;
  for (;;) {
    const params = new URLSearchParams({ until: ref.more.to, limit: String(Math.min(PAGE, max)), start: String(start) });
    if (since) params.set('since', since);
    const page = DcPage.parse(await getJson(`${repo}/commits?${params}`, token));
    for (const c of page.values) {
      // An author Bitbucket matched to one of its users comes as that user; otherwise as git wrote them.
      const known = Boolean(c.author?.slug) || (c.author?.id !== undefined && c.author?.id !== null);
      out.push({
        sha: c.id,
        message: c.message ?? '',
        url: link(`${base}/projects/${encodeURIComponent(key)}/repos/${encodeURIComponent(slug)}/commits/${c.id}`),
        at: when(c.authorTimestamp ?? null),
        author: known ? dcUser(c.author) : { name: c.author?.name ?? null, email: c.author?.emailAddress ?? null, login: null, match: [] },
      });
    }
    if (page.isLastPage || page.nextPageStart === null || page.nextPageStart === undefined || out.length >= max || !page.values.length) break;
    start = page.nextPageStart;
  }
  return out.slice(0, max);
}

/**
 * The commits of one branch a delivery left out, with what it sent: read when the integration
 * has a token, and said why not when it hasn't or the read failed.
 */
export async function moreCommits(
  integration: IntegrationRow,
  repository: string,
  ref: PushRef,
  max: number,
): Promise<{ commits: Commit[]; problem: string | null }> {
  if (!ref.more) return { commits: ref.commits.slice(0, max), problem: null };
  const more = ref as PushRef & { more: NonNullable<PushRef['more']> };
  const cloud = integration.provider === 'bitbucket';
  if (!integration.accessToken) {
    return {
      commits: ref.commits.slice(0, max),
      problem: cloud
        ? `Bitbucket sent the latest ${ref.commits.length} of more commits on ${ref.branch ?? 'a branch'}; give the integration an access token so a4a reads the rest`
        : `Bitbucket Data Center sends no commits with a push; give the integration an access token so a4a reads the commits on ${ref.branch ?? 'a branch'}`,
    };
  }
  const base = cloud ? (integration.baseUrl ?? BITBUCKET_CLOUD_API) : integration.baseUrl;
  if (!base) return { commits: ref.commits.slice(0, max), problem: 'The integration has no address for Bitbucket Data Center, so a4a can’t read the commits' };
  try {
    const read = cloud ? await readCloud(base, integration.accessToken, repository, more, max) : await readDc(base, integration.accessToken, repository, more, max);
    // What the delivery sent is in what was read; keep any it sent that wasn't, as it sent them.
    const seen = new Set(read.map((c) => c.sha));
    return { commits: [...read, ...ref.commits.filter((c) => !seen.has(c.sha))].slice(0, max), problem: null };
  } catch (e) {
    if (!(e instanceof ReadError) && !(e instanceof z.ZodError)) throw e;
    const why = e instanceof ReadError ? e.message : 'its answer wasn’t what a4a expected';
    return { commits: ref.commits.slice(0, max), problem: `a4a couldn’t read the commits on ${ref.branch ?? 'a branch'} from ${new URL(base).host}: ${why}` };
  }
}
