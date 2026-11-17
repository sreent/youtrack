/**
 * A person connecting their Forgejo account (docs/architecture.md, D54), as D46's connect does for
 * GitHub's: at the instance's own address, an authorization code with PKCE, the state bound to who
 * started it and taken once, GET /api/v1/user asked who the token is, and the token dropped. The
 * fake Forgejo checks the app's secret, the redirect and the verifier, as Forgejo does.
 */
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { systemCtx } from '../src/app-services';
import { codeHostsFromEnv, loadConfig } from '../src/config';
import { providerLogins } from '../src/db/schema';
import { createHttpApp } from '../src/http/app';
import { authorOf } from '../src/vcs/authors';
import { codeHosts, finishConnect, startConnect } from '../src/vcs/connect';
import { createWorld, type TestWorld } from './helpers';

let w: TestWorld;
let fake: Server;
let forgejo = '';
/** What Forgejo saw: each token exchange's form. */
const exchanges: URLSearchParams[] = [];
const challenges = new Map<string, string>();
let account = { id: 31, login: 'Anna-S', username: 'Anna-S' };

const web = (user = w.anna) => systemCtx(w.app, user, 'web');

/** Signed in at Forgejo, which sends the browser back with a code for that sign-in's challenge. */
async function signIn(user = w.anna): Promise<URLSearchParams> {
  const { url } = await startConnect(web(user), 'gitea');
  const q = new URL(url).searchParams;
  const code = `code-${challenges.size + 1}`;
  challenges.set(code, q.get('code_challenge') ?? '');
  return new URLSearchParams({ state: q.get('state')!, code });
}

beforeAll(async () => {
  fake = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://fake');
      const send = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      if (url.pathname === '/login/oauth/access_token' && req.method === 'POST') {
        const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
        exchanges.push(form);
        const code = form.get('code') ?? '';
        const pkce = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url') === challenges.get(code);
        const redirect = form.get('redirect_uri') === `${w.app.config.publicUrl}/api/v1/auth/code-hosts/gitea/callback`;
        if (form.get('grant_type') !== 'authorization_code' || form.get('client_id') !== 'forgejo-app' || form.get('client_secret') !== 'forgejo-secret' || !pkce || !redirect) {
          return send(400, { error: 'unauthorized_client', error_description: 'invalid code' });
        }
        challenges.delete(code);
        return send(200, { access_token: 'forgejo_access', token_type: 'bearer', expires_in: 3600, refresh_token: 'forgejo_refresh' });
      }
      if (req.headers.authorization !== 'Bearer forgejo_access') return send(401, { message: 'invalid token' });
      if (url.pathname === '/api/v1/user') return send(200, account);
      send(404, { message: 'not found' });
    });
  });
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  forgejo = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  // As an administrator sets it up: FORGEJO_URL beside the app's id and secret.
  const hosts = codeHostsFromEnv({ FORGEJO_URL: `${forgejo}/`, FORGEJO_CLIENT_ID: 'forgejo-app', FORGEJO_CLIENT_SECRET: 'forgejo-secret' });
  w = await createWorld({ config: { codeHosts: hosts } });
});

afterAll(async () => {
  await new Promise<void>((r) => fake.close(() => r()));
  await w.close();
});

describe('connecting your Forgejo account', () => {
  it('is set up by FORGEJO_URL beside the app, and offered by its name', () => {
    expect(w.app.config.codeHosts.gitea).toEqual({ clientId: 'forgejo-app', clientSecret: 'forgejo-secret', webUrl: forgejo, apiUrl: `${forgejo}/api/v1`, name: 'Forgejo' });
    expect(codeHosts(w.app).find((h) => h.provider === 'gitea')).toEqual({ provider: 'gitea', name: 'Forgejo', available: true });
    // Without an address there's nothing to connect to: GITEA_CLIENT_ID alone sets up nothing.
    expect(codeHostsFromEnv({ GITEA_CLIENT_ID: 'x', GITEA_CLIENT_SECRET: 'y' }).gitea).toBeUndefined();
    expect(codeHostsFromEnv({ GITEA_URL: 'https://gitea.acme.example', GITEA_CLIENT_ID: 'x', GITEA_CLIENT_SECRET: 'y' }).gitea?.name).toBe('Gitea');
    // Both named: Forgejo's is the one.
    const both = codeHostsFromEnv({ GITEA_URL: 'https://gitea.acme.example', GITEA_CLIENT_ID: 'x', GITEA_CLIENT_SECRET: 'y', FORGEJO_URL: 'https://codeberg.org', FORGEJO_CLIENT_ID: 'f', FORGEJO_CLIENT_SECRET: 'g' });
    expect(both.gitea).toMatchObject({ name: 'Forgejo', webUrl: 'https://codeberg.org', apiUrl: 'https://codeberg.org/api/v1' });
  });

  it('sends you to sign in at the instance with a state and PKCE, and makes the account it proves your login', async () => {
    const { url } = await startConnect(web(), 'gitea');
    const q = new URL(url).searchParams;
    expect(url.startsWith(`${forgejo}/login/oauth/authorize?`)).toBe(true);
    expect(Object.fromEntries(q)).toMatchObject({
      client_id: 'forgejo-app',
      response_type: 'code',
      scope: 'read:user',
      code_challenge_method: 'S256',
      redirect_uri: `${w.app.config.publicUrl}/api/v1/auth/code-hosts/gitea/callback`,
    });
    challenges.set('the-code', q.get('code_challenge')!);
    const made = await finishConnect(w.app, web(), 'gitea', new URLSearchParams({ state: q.get('state')!, code: 'the-code' }));
    expect(made).toMatchObject({ provider: 'gitea', login: 'Anna-S', connected: true });
    const [row] = await w.app.db.select().from(providerLogins).where(eq(providerLogins.id, made.id));
    expect(row).toMatchObject({ userId: w.anna.id, providerUserId: '31', matchKey: 'anna-s' });
    // The verifier went to Forgejo, and neither token is kept anywhere.
    expect(exchanges.at(-1)!.get('code_verifier')).toMatch(/^[\w-]{43}$/);
    const kept = JSON.stringify(await w.app.db.select().from(providerLogins));
    expect(kept).not.toContain('forgejo_access');
    expect(kept).not.toContain('forgejo_refresh');
    // A push Forgejo matched to that account is hers, however the login is cased.
    const s = await w.app.schema.get();
    const author = await authorOf(w.app.db, s, 'gitea', { name: 'Anna', email: 'anna@users.noreply.example', login: 'anna-s', match: ['anna-s'] });
    expect(author.user?.id).toBe(w.anna.id);
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
    challenges.set(forged.get('code')!, 'not-the-challenge');
    await expect(finishConnect(w.app, web(), 'gitea', forged)).rejects.toMatchObject({ failure: 'refused' });
    const denied = await signIn();
    denied.delete('code');
    denied.set('error', 'access_denied');
    await expect(finishConnect(w.app, web(), 'gitea', denied)).rejects.toMatchObject({ failure: 'denied' });
    // Signed out, the callback connects nobody.
    await expect(finishConnect(w.app, null, 'gitea', await signIn())).rejects.toMatchObject({ failure: 'mismatch' });
  });

  it("refuses an account that is someone else's, and answers the callback with the profile", async () => {
    account = { id: 32, login: 'ben-o', username: 'ben-o' };
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
      expect(codeHosts(w.app).find((h) => h.provider === 'gitea')).toEqual({ provider: 'gitea', name: 'Gitea or Forgejo', available: false });
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
