/**
 * A Forgejo instance, as a person signs in at it to connect their account (D54), on this machine:
 * its authorize page, which asks and sends the browser back with a code; its token endpoint, which
 * checks the OAuth app's secret, the redirect and the PKCE verifier as Forgejo does; and
 * GET /api/v1/user. The server is set up with its address before it starts (playwright.config.ts).
 */
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { FORGEJO } from './env';

export async function startForgejo() {
  /** Who signs in at Forgejo next: the spec says, as a person would type it there. */
  let account = { id: 1, login: 'someone' };
  const codes = new Map<string, { challenge: string; redirect: string; account: typeof account }>();
  const tokens = new Map<string, typeof account>();
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', FORGEJO.url);
      const json = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      if (url.pathname === '/login/oauth/authorize') {
        const q = url.searchParams;
        if (q.get('client_id') !== FORGEJO.clientId || q.get('response_type') !== 'code' || q.get('code_challenge_method') !== 'S256') return json(400, { error: 'invalid_request' });
        const code = randomUUID();
        codes.set(code, { challenge: q.get('code_challenge') ?? '', redirect: q.get('redirect_uri') ?? '', account });
        const back = new URL(q.get('redirect_uri') ?? '');
        back.searchParams.set('code', code);
        back.searchParams.set('state', q.get('state') ?? '');
        const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Authorize Application - Forgejo</title><link rel="icon" href="data:,"></head>
<body><main><h1>Authorize a4a to access your account?</h1><p>Signed in as ${account.login}.</p><p><a href="${back.href.replace(/&/g, '&amp;')}">Authorize Application</a></p></main></body></html>`;
        return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html);
      }
      if (url.pathname === '/login/oauth/access_token' && req.method === 'POST') {
        const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
        const asked = codes.get(form.get('code') ?? '');
        const pkce = asked && createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url') === asked.challenge;
        if (!asked || !pkce || form.get('client_secret') !== FORGEJO.clientSecret || form.get('redirect_uri') !== asked.redirect) return json(400, { error: 'unauthorized_client' });
        codes.delete(form.get('code')!);
        const token = `forgejo_${randomUUID()}`;
        tokens.set(token, asked.account);
        return json(200, { access_token: token, token_type: 'bearer', expires_in: 3600 });
      }
      if (url.pathname === '/api/v1/user') {
        const who = tokens.get((req.headers.authorization ?? '').replace(/^Bearer /, ''));
        return who ? json(200, { id: who.id, login: who.login, username: who.login }) : json(401, { message: 'invalid token' });
      }
      if (url.pathname === '/favicon.ico') return res.writeHead(204).end();
      return json(404, { message: 'not found' });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(Number(new URL(FORGEJO.url).port), '127.0.0.1', resolve);
  });
  return {
    signInAs: (who: { id: number; login: string }) => (account = who),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
