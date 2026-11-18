/**
 * Email, for the specs that need a4a to send it. The run's own server sends none (playwright.config.ts
 * says why), so such a spec starts a mail server of its own, on this machine, and an a4a server of
 * its own that sends to it: its own port, database and administrator, the same build.
 *
 * The mail server speaks just enough SMTP for nodemailer (no TLS, no sign-in) and keeps each message,
 * its headers unfolded and its text part decoded.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type AddressInfo, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Mail {
  to: string[];
  headers: Map<string, string>;
  /** The text part, quoted-printable and base64 undone. */
  text: string;
}

export interface MailServer {
  port: number;
  messages: Mail[];
  /** The first message to this address that matches, within a while; it fails the test otherwise. */
  waitFor(to: string, match: (m: Mail) => boolean, ms?: number): Promise<Mail>;
  close(): Promise<void>;
}

function unfold(head: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) out.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim());
  }
  return out;
}

function decodeQp(s: string): string {
  const soft = s.replace(/=\r?\n/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < soft.length; i++) {
    const m = /^=([0-9A-F]{2})/i.exec(soft.slice(i, i + 3));
    if (m) {
      bytes.push(parseInt(m[1]!, 16));
      i += 2;
    } else bytes.push(...Buffer.from(soft[i]!, 'utf8'));
  }
  return Buffer.from(bytes).toString('utf8');
}

/** A message's text part, decoded, from a plain or multipart message. */
function textOf(headers: Map<string, string>, body: string): string {
  const type = headers.get('content-type') ?? 'text/plain';
  const boundary = /boundary="?([^";]+)"?/i.exec(type)?.[1];
  if (type.startsWith('multipart/') && boundary) {
    for (const chunk of body.split(`--${boundary}`).slice(1)) {
      if (chunk.startsWith('--')) break;
      const at = chunk.indexOf('\r\n\r\n');
      const found = textOf(unfold(chunk.slice(0, at)), chunk.slice(at + 4));
      if (found) return found;
    }
    return '';
  }
  if (!type.startsWith('text/plain')) return '';
  const enc = (headers.get('content-transfer-encoding') ?? '').toLowerCase();
  if (enc === 'quoted-printable') return decodeQp(body);
  if (enc === 'base64') return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
  return body;
}

export async function startMailServer(): Promise<MailServer> {
  const messages: Mail[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let buffer = '';
    let rcpt: string[] = [];
    let data: string | null = null;
    const say = (line: string) => socket.write(`${line}\r\n`);
    say('220 mail.e2e ESMTP');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        if (data !== null) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end < 0) return;
          data += buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          const raw = data.replace(/\r\n\.\./g, '\r\n.');
          const split = raw.indexOf('\r\n\r\n');
          const headers = unfold(raw.slice(0, split));
          messages.push({ to: rcpt, headers, text: textOf(headers, raw.slice(split + 4)) });
          data = null;
          rcpt = [];
          say('250 2.0.0 queued');
          continue;
        }
        const nl = buffer.indexOf('\r\n');
        if (nl < 0) return;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 2);
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === 'EHLO') say('250-mail.e2e\r\n250 8BITMIME');
        else if (verb === 'HELO' || verb === 'MAIL' || verb === 'RSET' || verb === 'NOOP') say('250 2.0.0 OK');
        else if (verb === 'RCPT') {
          rcpt.push((/<([^>]*)>/.exec(line)?.[1] ?? '').toLowerCase());
          say('250 2.1.5 OK');
        } else if (verb === 'DATA') {
          data = '\r\n';
          say('354 go ahead');
        } else if (verb === 'QUIT') {
          say('221 2.0.0 bye');
          socket.end();
        } else say('502 5.5.2 not here');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return {
    port: (server.address() as AddressInfo).port,
    messages,
    async waitFor(to, match, ms = 30_000) {
      const until = Date.now() + ms;
      for (;;) {
        const found = messages.find((m) => m.to.includes(to.toLowerCase()) && match(m));
        if (found) return found;
        if (Date.now() > until) throw new Error(`no email to ${to} came within ${ms / 1000} seconds; ${messages.length} came for others`);
        await new Promise((r) => setTimeout(r, 250));
      }
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

export interface MailingServer {
  url: string;
  admin: { login: string; password: string };
  close(): Promise<void>;
}

/**
 * An a4a server of the spec's own, from the same build, that sends its mail to `smtpPort`. With
 * `localhost`, its address is http://localhost:port, a domain a browser makes passkeys for (an IP
 * address can't be a relying party's id, D62).
 */
export async function startMailingServer(smtpPort: number, opts: { localhost?: boolean } = {}): Promise<MailingServer> {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
  const port = await freePort();
  const url = `http://${opts.localhost ? 'localhost' : '127.0.0.1'}:${port}`;
  const dir = mkdtempSync(path.join(tmpdir(), 'a4a-e2e-mail-'));
  const admin = { login: 'admin', password: 'e2e-mail-pass-1' };
  const child: ChildProcess = spawn(process.execPath, ['packages/server/dist/index.js'], {
    cwd: root,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      HOST: '127.0.0.1',
      PUBLIC_URL: url,
      DATA_DIR: path.join(dir, 'data'),
      WEB_DIST: path.join(root, 'apps/web/dist'),
      ADMIN_LOGIN: admin.login,
      ADMIN_PASSWORD: admin.password,
      SEED_DEMO: 'false',
      DATABASE_URL: '',
      DATABASE_LISTEN_URL: '',
      AI_DISABLED: 'true',
      AI_PROVIDER: '',
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_AUTH_TOKEN: '',
      OIDC_ISSUER: '',
      SMTP_URL: `smtp://127.0.0.1:${smtpPort}`,
      MAIL_FROM: 'a4a <a4a@desk.example>',
      MAIL_REPLY_ADDRESS: '',
      HELPDESK_IMAP_URL: '',
      PASSWORD_LOGIN: 'true',
      API_RATE_LIMIT: '1200',
      TRUST_PROXY: '0',
      TEAMS_APP_ID: '',
      SLACK_API_URL: '',
      FORGEJO_URL: '',
      GITEA_URL: '',
      VAPID_PUBLIC_KEY: '',
      VAPID_PRIVATE_KEY: '',
    },
  });
  let stderr = '';
  child.stderr?.on('data', (c: Buffer) => (stderr = (stderr + c.toString('utf8')).slice(-4000)));
  const stop = async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 5_000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    rmSync(dir, { recursive: true, force: true });
  };
  const until = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null) {
      await stop();
      throw new Error(`the mailing server stopped as it started: ${stderr}`);
    }
    const up = await fetch(`http://127.0.0.1:${port}/api/v1/health`).then((r) => r.ok).catch(() => false);
    if (up) break;
    if (Date.now() > until) {
      await stop();
      throw new Error(`the mailing server didn't answer within a minute: ${stderr}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return { url, admin, close: stop };
}
