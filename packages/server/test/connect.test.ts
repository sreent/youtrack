/**
 * People connecting their own code-host accounts (docs/architecture.md, D46): proved by signing in
 * there, bound to who started it, once; the token asked one question and dropped.
 */
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { systemCtx } from '../src/app-services';
import { providerLogins } from '../src/db/schema';
import { createHttpApp } from '../src/http/app';
import { authorOf } from '../src/vcs/authors';
import { codeHosts, finishConnect, startConnect } from '../src/vcs/connect';
import { addProviderLogin, listProviderLogins, removeProviderLogin } from '../src/vcs/logins';
import { createWorld, type TestWorld } from './helpers';

let w: TestWorld;
let fake: Server;
let base = '';
/** What the fake provider saw: each token exchange's form, and the challenge its sign-in page was given. */
const exchanges: URLSearchParams[] = [];
let challenge = '';
let account = { id: 4242, login: 'anna-s' };

const web = (user = w.anna) => systemCtx(w.app, user, 'web');

async function signIn(provider: 'github' | 'gitlab', user = w.anna): Promise<URLSearchParams> {
  const { url } = await startConnect(web(user), provider);
  const q = new URL(url).searchParams;
  challenge = q.get('code_challenge') ?? '';
  return new URLSearchParams({ state: q.get('state')!, code: 'the-code' });
}

beforeAll(async () => {
  fake = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://fake');
      const send = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      if (url.pathname === '/login/oauth/access_token' || url.pathname === '/oauth/token') {
        const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
        exchanges.push(form);
        const pkce = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url') === challenge;
        if (form.get('client_secret') !== 'app-secret' || form.get('code') !== 'the-code' || !pkce) return send(400, { error: 'bad_verification_code' });
        return send(200, { access_token: 'gho_short_lived', token_type: 'bearer' });
      }
      if (req.headers.authorization !== 'Bearer gho_short_lived') return send(401, { message: 'Bad credentials' });
      if (url.pathname === '/user') return send(200, account);
      if (url.pathname === '/api/v4/user') return send(200, { id: 77, username: 'anna.s' });
      send(404, {});
    });
  });
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  w = await createWorld({
    config: {
      codeHosts: {
        github: { clientId: 'gh-app', clientSecret: 'app-secret', webUrl: base, apiUrl: base },
        gitlab: { clientId: 'gl-app', clientSecret: 'app-secret', webUrl: base, apiUrl: `${base}/api/v4` },
      },
    },
  });
});

afterAll(async () => {
  await new Promise<void>((r) => fake.close(() => r()));
  await w.close();
});

describe('connecting your own account', () => {
  it('offers the providers an administrator set up', () => {
    expect(codeHosts(w.app)).toEqual([
      { provider: 'github', name: 'GitHub', available: true },
      { provider: 'gitlab', name: 'GitLab', available: true },
      { provider: 'bitbucket', name: 'Bitbucket', available: false },
    ]);
  });

  it('sends you to sign in there with a state and PKCE, and makes the account it proves your login', async () => {
    const { url } = await startConnect(web(), 'github');
    const q = new URL(url).searchParams;
    expect(url.startsWith(`${base}/login/oauth/authorize?`)).toBe(true);
    expect([q.get('client_id'), q.get('scope'), q.get('code_challenge_method'), q.get('redirect_uri')]).toEqual(['gh-app', 'read:user', 'S256', `${w.app.config.publicUrl}/api/v1/auth/code-hosts/github/callback`]);
    challenge = q.get('code_challenge')!;
    const made = await finishConnect(w.app, web(), 'github', new URLSearchParams({ state: q.get('state')!, code: 'the-code' }));
    expect(made).toMatchObject({ provider: 'github', login: 'anna-s', connected: true });
    const [row] = await w.app.db.select().from(providerLogins).where(eq(providerLogins.id, made.id));
    expect(row).toMatchObject({ userId: w.anna.id, providerUserId: '4242', addedById: w.anna.id });
    // The token isn't kept anywhere.
    expect(JSON.stringify(await w.app.db.select().from(providerLogins))).not.toContain('gho_short_lived');
    // Commits GitHub says that account wrote are hers now.
    const s = await w.app.schema.get();
    const author = await authorOf(w.app.db, s, 'github', { name: 'Anna', email: null, login: 'anna-s', match: ['anna-s'] });
    expect(author.user?.id).toBe(w.anna.id);
  });

  it('takes a state once, only back to who started it, and says no when you did', async () => {
    const params = await signIn('gitlab');
    await expect(finishConnect(w.app, web(w.ben), 'gitlab', params)).rejects.toMatchObject({ failure: 'mismatch' });
    // That state is spent: even the right person can't use it again.
    await expect(finishConnect(w.app, web(), 'gitlab', params)).rejects.toMatchObject({ failure: 'expired' });
    const denied = await signIn('gitlab');
    denied.delete('code');
    denied.set('error', 'access_denied');
    await expect(finishConnect(w.app, web(), 'gitlab', denied)).rejects.toMatchObject({ failure: 'denied' });
    await expect(finishConnect(w.app, web(), 'gitlab', new URLSearchParams({ state: 'made-up', code: 'x' }))).rejects.toMatchObject({ failure: 'expired' });
    const ok = await finishConnect(w.app, web(), 'gitlab', await signIn('gitlab'));
    expect(ok).toMatchObject({ provider: 'gitlab', login: 'anna.s', connected: true });
  });

  it("refuses an account that's someone else's, and lets you disconnect your own, not an administrator's record", async () => {
    await addProviderLogin(w.adminCtx, 'ben', { provider: 'github', login: 'ben-o' });
    account = { id: 99, login: 'ben-o' };
    await expect(finishConnect(w.app, web(), 'github', await signIn('github'))).rejects.toMatchObject({ failure: 'taken' });
    const recorded = await addProviderLogin(w.adminCtx, 'anna', { provider: 'bitbucket-dc', login: 'anna' });
    const mine = await listProviderLogins(w.as(w.anna), 'anna');
    const connected = mine.find((l) => l.provider === 'github')!;
    await expect(removeProviderLogin(w.as(w.anna), 'anna', recorded.id)).rejects.toMatchObject({ status: 403 });
    await removeProviderLogin(w.as(w.anna), 'anna', connected.id);
    expect((await listProviderLogins(w.as(w.anna), 'anna')).map((l) => l.provider).sort()).toEqual(['bitbucket-dc', 'gitlab']);
  });

  it('answers the callback with a redirect to the profile, saying why not', async () => {
    const http = createHttpApp(w.app);
    const res = await http.request('/api/v1/auth/code-hosts/github/callback?state=nope&code=x', { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/me?connect=expired#code-hosts');
    const unset = await startConnect(web(), 'bitbucket').catch((e: Error) => e);
    expect(unset).toMatchObject({ status: 400 });
  });
});
