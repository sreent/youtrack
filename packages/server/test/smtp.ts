/** A fake SMTP server for tests: it takes every message, or refuses as told, and keeps what it took. */
import { SMTPServer } from 'smtp-server';

export interface Received {
  from: string;
  to: string[];
  raw: string;
  headers: Map<string, string>;
  /** The decoded text and HTML parts (quoted-printable and base64 undone). */
  text: string;
  html: string;
}

export interface FakeSmtp {
  url: string;
  messages: Received[];
  /** Refuse the next n messages with this reply code (e.g. 451, a try-again; 550, never). */
  refuse(code: number, times?: number): void;
  close(): Promise<void>;
}

function decodeQp(s: string): string {
  const bytes: number[] = [];
  const soft = s.replace(/=\r?\n/g, '');
  for (let i = 0; i < soft.length; i++) {
    const m = /^=([0-9A-F]{2})/i.exec(soft.slice(i, i + 3));
    if (m) {
      bytes.push(parseInt(m[1]!, 16));
      i += 2;
    } else bytes.push(...Buffer.from(soft[i]!, 'utf8'));
  }
  return Buffer.from(bytes).toString('utf8');
}

function unfoldHeaders(head: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) out.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim());
  }
  return out;
}

/** The text/plain and text/html parts of a (possibly multipart) message, decoded. */
function parts(raw: string): { headers: Map<string, string>; text: string; html: string } {
  const split = raw.indexOf('\r\n\r\n');
  const headers = unfoldHeaders(raw.slice(0, split));
  const body = raw.slice(split + 4);
  const found = { text: '', html: '' };
  const decode = (h: Map<string, string>, b: string) => {
    const enc = (h.get('content-transfer-encoding') ?? '').toLowerCase();
    if (enc === 'quoted-printable') return decodeQp(b);
    if (enc === 'base64') return Buffer.from(b.replace(/\s+/g, ''), 'base64').toString('utf8');
    return b;
  };
  const walk = (h: Map<string, string>, b: string) => {
    const type = h.get('content-type') ?? 'text/plain';
    const boundary = /boundary="?([^";]+)"?/i.exec(type)?.[1];
    if (type.startsWith('multipart/') && boundary) {
      for (const chunk of b.split(`--${boundary}`).slice(1)) {
        if (chunk.startsWith('--')) break;
        const at = chunk.indexOf('\r\n\r\n');
        walk(unfoldHeaders(chunk.slice(0, at)), chunk.slice(at + 4));
      }
    } else if (type.startsWith('text/html')) found.html += decode(h, b);
    else if (type.startsWith('text/plain')) found.text += decode(h, b);
  };
  walk(headers, body);
  return { headers, ...found };
}

export async function fakeSmtp(port = 0): Promise<FakeSmtp> {
  const messages: Received[] = [];
  let refusals: { code: number; left: number } | null = null;
  const server = new SMTPServer({
    authOptional: true,
    disabledCommands: ['STARTTLS', 'AUTH'],
    logger: false,
    onData(stream, session, callback) {
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => {
        if (refusals && refusals.left > 0) {
          refusals.left--;
          const err = new Error(refusals.code >= 500 ? 'No such mailbox here' : 'Try again later') as Error & { responseCode: number };
          err.responseCode = refusals.code;
          return callback(err);
        }
        const raw = Buffer.concat(chunks).toString('utf8');
        messages.push({
          from: session.envelope.mailFrom ? session.envelope.mailFrom.address : '',
          to: session.envelope.rcptTo.map((r) => r.address),
          raw,
          ...parts(raw),
        });
        callback();
      });
    },
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  // Port 0 takes whichever is free: the one it got.
  const bound = (server.server.address() as { port?: number } | null)?.port ?? port;
  return {
    url: `smtp://127.0.0.1:${bound}`,
    messages,
    refuse: (code, times = 1) => {
      refusals = { code, left: times };
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
