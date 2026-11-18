/**
 * A person connecting their Forgejo account (docs/architecture.md, D54), as D46's connect does for
 * GitHub's: at the instance's own address, an authorization code with PKCE, the state bound to who
 * started it and taken once, GET /api/v1/user asked who the token is, and the token dropped. And its
 * token narrowed where the instance lets a4a (D66): taken back as soon as it's been used where the
 * instance offers revocation, said on the profile where it doesn't, and refused when the instance says
 * it reaches more than `read:user`. The fake Forgejo (fake-forgejo.ts) is one with and without each.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { systemCtx } from '../src/app-services';
import { codeHostsFromEnv, loadConfig } from '../src/config';
import { providerLogins } from '../src/db/schema';
import { createHttpApp } from '../src/http/app';
import { authorOf } from '../src/vcs/authors';
import { codeHosts, finishConnect, forgetOffered, startConnect } from '../src/vcs/connect';
import { startFakeForgejo, type FakeForgejo } from './fake-forgejo';
import { createWorld, type TestWorld } from './helpers';

let w: TestWorld;
let forge: FakeForgejo;

const web = (user = w.anna) => systemCtx(w.app, user, 'web');

/** Signed in at Forgejo, which sends the browser back with a code for that sign-in's challenge. */
async function signIn(user = w.anna): Promise<URLSearchParams> {
  const { url } = await startConnect(web(user), 'gitea');
  const q = new URL(url).searchParams;
  const code = `code-${forge.challenges.size + forge.exchanges.length + 1}`;
  forge.challenges.set(code, q.get('code_challenge') ?? '');
  return new URLSearchParams({ state: q.get('state')!, code });
}

const gitea = async () => (await codeHosts(w.app)).find((h) => h.provider === 'gitea');

beforeAll(async () => {
  forge = await startFakeForgejo({ clientId: 'forgejo-app', clientSecret: 'forgejo-secret', callback: () => `${w.app.config.publicUrl}/api/v1/auth/code-hosts/gitea/callback` });
  // As an administrator sets it up: FORGEJO_URL beside the app's id and secret.
  const hosts = codeHostsFromEnv({ FORGEJO_URL: `${forge.url}/`, FORGEJO_CLIENT_ID: 'forgejo-app', FORGEJO_CLIENT_SECRET: 'forgejo-secret' });
  w = await createWorld({ config: { codeHosts: hosts } });
});

beforeEach(() => {
  // What an instance offers is kept an hour; each test sets up its own.
  forgetOffered();
  forge.mode = { scopes: 'none', granted: 'read:user', revokes: false };
});

afterAll(async () => {
  await forge.close();
  await w.close();
});

describe('connecting your Forgejo account', () => {
  it('is set up by FORGEJO_URL beside the app, and offered by its name', async () => {
    expect(w.app.config.codeHosts.gitea).toEqual({ clientId: 'forgejo-app', clientSecret: 'forgejo-secret', webUrl: forge.url, apiUrl: `${forge.url}/api/v1`, name: 'Forgejo' });
    expect(await gitea()).toEqual({ provider: 'gitea', name: 'Forgejo', available: true, revokes: false });
    // Without an address there's nothing to connect to: GITEA_CLIENT_ID alone sets up nothing.
    expect(codeHostsFromEnv({ GITEA_CLIENT_ID: 'x', GITEA_CLIENT_SECRET: 'y' }).gitea).toBeUndefined();
    expect(codeHostsFromEnv({ GITEA_URL: 'https://gitea.acme.example', GITEA_CLIENT_ID: 'x', GITEA_CLIENT_SECRET: 'y' }).gitea?.name).toBe('Gitea');
    // Both named: Forgejo's is the one.
    const both = codeHostsFromEnv({ GITEA_URL: 'https://gitea.acme.example', GITEA_CLIENT_ID: 'x', GITEA_CLIENT_SECRET: 'y', FORGEJO_URL: 'https://codeberg.org', FORGEJO_CLIENT_ID: 'f', FORGEJO_CLIENT_SECRET: 'g' });
    expect(both.gitea).toMatchObject({ name: 'Forgejo', webUrl: 'https://codeberg.org', apiUrl: 'https://codeberg.org/api/v1' });
    // The other hosts' tokens read who you are and nothing more: nothing to say of them.
    expect((await codeHosts(w.app)).find((h) => h.provider === 'github')).toMatchObject({ revokes: null });
  });

  it('sends you to sign in at the instance with a state and PKCE, and makes the account it proves your login', async () => {
    const { url } = await startConnect(web(), 'gitea');
    const q = new URL(url).searchParams;
    expect(url.startsWith(`${forge.url}/login/oauth/authorize?`)).toBe(true);
    expect(Object.fromEntries(q)).toMatchObject({
      client_id: 'forgejo-app',
      response_type: 'code',
      scope: 'read:user',
      code_challenge_method: 'S256',
      redirect_uri: `${w.app.config.publicUrl}/api/v1/auth/code-hosts/gitea/callback`,
    });
    forge.challenges.set('the-code', q.get('code_challenge')!);
    const made = await finishConnect(w.app, web(), 'gitea', new URLSearchParams({ state: q.get('state')!, code: 'the-code' }));
    expect(made).toMatchObject({ provider: 'gitea', login: 'Anna-S', connected: true });
    const [row] = await w.app.db.select().from(providerLogins).where(eq(providerLogins.id, made.id));
    expect(row).toMatchObject({ userId: w.anna.id, providerUserId: '31', matchKey: 'anna-s' });
    // The verifier went to Forgejo, and neither token is kept anywhere.
    expect(forge.exchanges.at(-1)!.get('code_verifier')).toMatch(/^[\w-]{43}$/);
    const kept = JSON.stringify(await w.app.db.select().from(providerLogins));
    expect(kept).not.toMatch(/forgejo_(access|refresh)/);
    // This instance offers no revocation: the token was used once, and is still good there, as the profile said.
    expect(forge.asked).toHaveLength(1);
    expect(forge.revoked).toEqual([]);
    expect(forge.live.has(forge.asked[0]!)).toBe(true);
    // A push Forgejo matched to that account is hers, however the login is cased.
    const s = await w.app.schema.get();
    const author = await authorOf(w.app.db, s, 'gitea', { name: 'Anna', email: 'anna@users.noreply.example', login: 'anna-s', match: ['anna-s'] });
    expect(author.user?.id).toBe(w.anna.id);
  });

  it('takes the token back as soon as it has asked who you are, where the instance offers revocation', async () => {
    forge.mode.revokes = true;
    expect(await gitea()).toMatchObject({ revokes: true });
    const before = forge.asked.length;
    await finishConnect(w.app, web(), 'gitea', await signIn());
    const used = forge.asked.slice(before);
    expect(used).toHaveLength(1);
    // The refresh token first, which ends its grant, then the access token: both with the app's credentials.
    expect(forge.revoked.slice(-2)).toEqual([
      { token: used[0]!.replace('access', 'refresh'), hint: 'refresh_token' },
      { token: used[0], hint: 'access_token' },
    ]);
    expect(forge.live.has(used[0]!)).toBe(false);
  });

  it('refuses a token the instance says reaches more than read:user, before using it, and takes it back', async () => {
    forge.mode = { scopes: 'answer', granted: 'read:user', revokes: true };
    const asked = forge.asked.length;
    await finishConnect(w.app, web(), 'gitea', await signIn());
    expect(forge.asked.length).toBe(asked + 1);
    forge.mode.granted = 'read:user write:repository';
    const wide = await finishConnect(w.app, web(), 'gitea', await signIn()).catch((e: unknown) => e);
    expect(wide).toMatchObject({ failure: 'wide' });
    expect((wide as Error).message).toContain('(write:repository)');
    // Never asked who it is, and taken back all the same.
    expect(forge.asked.length).toBe(asked + 1);
    expect(forge.revoked.at(-1)).toMatchObject({ hint: 'access_token' });
    // By introspection, where the token's answer says nothing: OpenID's own scopes reach no API.
    forge.mode = { scopes: 'introspection', granted: 'openid read:user', revokes: false };
    forgetOffered();
    await finishConnect(w.app, web(), 'gitea', await signIn());
    expect(forge.introspected).toHaveLength(1);
    forge.mode.granted = 'read:user,read:repository';
    await expect(finishConnect(w.app, web(), 'gitea', await signIn())).rejects.toMatchObject({ failure: 'wide' });
    // The profile says why: the callback goes back with it.
    const http = createHttpApp(w.app);
    const cookie = await signedInCookie();
    const { url } = await startConnectAs(cookie);
    const q = new URL(url).searchParams;
    forge.challenges.set('http-code', q.get('code_challenge')!);
    const res = await http.request(`/api/v1/auth/code-hosts/gitea/callback?state=${q.get('state')}&code=http-code`, { headers: { cookie }, redirect: 'manual' });
    expect(res.headers.get('location')).toBe('/me?connect=wide#code-hosts');
  });

  it('binds the state to who started it, takes it once, and says no for a wrong verifier or a refusal', async () => {
    const theirs = await signIn();
    await expect(finishConnect(w.app, web(w.ben), 'gitea', theirs)).rejects.toMatchObject({ failure: 'mismatch' });
    await expect(finishConnect(w.app, web(), 'gitea', theirs)).rejects.toMatchObject({ failure: 'expired' });
    // A state from another provider's round trip isn't this one's.
    const other = await signIn();
    await expect(finishConnect(w.app, web(), 'github', other)).rejects.toMatchObject({ failure: 'expired' });
    // Forgejo refuses a code whose verifier isn't the challenge's: nothing is connected.
    const forged = await signIn();
    forge.challenges.set(forged.get('code')!, 'not-the-challenge');
    await expect(finishConnect(w.app, web(), 'gitea', forged)).rejects.toMatchObject({ failure: 'refused' });
    const denied = await signIn();
    denied.delete('code');
    denied.set('error', 'access_denied');
    await expect(finishConnect(w.app, web(), 'gitea', denied)).rejects.toMatchObject({ failure: 'denied' });
    // Signed out, the callback connects nobody.
    await expect(finishConnect(w.app, null, 'gitea', await signIn())).rejects.toMatchObject({ failure: 'mismatch' });
  });

  it("refuses an account that is someone else's, and answers the callback with the profile", async () => {
    forge.account = { id: 32, login: 'ben-o' };
    await finishConnect(w.app, web(w.ben), 'gitea', await signIn(w.ben));
    await expect(finishConnect(w.app, web(), 'gitea', await signIn())).rejects.toMatchObject({ failure: 'taken' });
    const http = createHttpApp(w.app);
    const res = await http.request('/api/v1/auth/code-hosts/gitea/callback?state=nope&code=x', { redirect: 'manual' });
    expect(res.headers.get('location')).toBe('/me?connect=expired#code-hosts');
  });

  it('says how to set it up where it is not', async () => {
    // The same server without FORGEJO_*: nothing to connect to.
    const hosts = w.app.config.codeHosts;
    w.app.config.codeHosts = { github: hosts.github };
    try {
      const e = await startConnect(web(), 'gitea').catch((x: unknown) => x);
      expect(e).toMatchObject({ status: 400, words: { key: 'vcs.connectNotSetUpForge' } });
      expect(await gitea()).toEqual({ provider: 'gitea', name: 'Forgejo/Gitea', available: false, revokes: null });
      // Only https outside tests: plain http to this machine needs VCS_ALLOW_HTTP_LOOPBACK.
      expect(loadConfig().vcsAllowHttpLoopback).toBe(false);
      process.env.VCS_ALLOW_HTTP_LOOPBACK = 'true';
      try {
        expect(loadConfig().vcsAllowHttpLoopback).toBe(true);
      } finally {
        delete process.env.VCS_ALLOW_HTTP_LOOPBACK;
      }
    } finally {
      w.app.config.codeHosts = hosts;
    }
  });
});

/** Anna, signed in on the web: a session's cookie, as the browser holds it. */
async function signedInCookie(): Promise<string> {
  const { SESSION_COOKIE, startSession } = await import('../src/services/auth');
  const s = await startSession(w.app.db, w.anna.id, 1);
  return `${SESSION_COOKIE}=${s.token}`;
}

/** Start connecting through the REST route, as the profile's button does. */
async function startConnectAs(cookie: string): Promise<{ url: string }> {
  const http = createHttpApp(w.app);
  const res = await http.request('/api/v1/me/code-hosts/gitea/connect', { method: 'POST', headers: { cookie, origin: w.app.config.publicUrl, 'content-type': 'application/json' }, body: '{}' });
  return (await res.json()) as { url: string };
}
