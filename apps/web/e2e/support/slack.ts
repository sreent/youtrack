/**
 * Slack's Web API, as the server's Slack app meets it (D42, D60), on this machine: the calls a message
 * shortcut makes, and what's posted. The server is set up with its address before it starts
 * (playwright.config.ts); what Slack sends the server, the spec signs with the app's signing secret.
 */
import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { SLACK } from './env';

export interface SlackCall {
  method: string;
  body: Record<string, unknown>;
}

export interface SlackMessage {
  ts: string;
  user?: string;
  text?: string;
  thread_ts?: string;
}

export async function startSlack() {
  const calls: SlackCall[] = [];
  const people: Record<string, string> = {};
  const threads = new Map<string, SlackMessage[]>();
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => (raw += c));
    req.on('end', () => {
      const send = (data: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(data));
      const method = (req.url ?? '').replace(/^\/api\//, '').split('?')[0]!;
      const body = (req.headers['content-type'] ?? '').startsWith('application/json') ? (JSON.parse(raw || '{}') as Record<string, unknown>) : Object.fromEntries(new URLSearchParams(raw));
      calls.push({ method, body });
      if (req.headers.authorization !== `Bearer ${SLACK.botToken}`) return send({ ok: false, error: 'invalid_auth' });
      switch (method) {
        case 'auth.test':
          return send({ ok: true, team_id: SLACK.teamId, team: 'Acme', user_id: 'UE2EBOT' });
        case 'conversations.list':
          return send({ ok: true, channels: [{ id: 'CE2EENG', name: 'eng', is_member: true }] });
        case 'conversations.info':
          return send({ ok: true, channel: { id: body.channel, name: 'eng', is_member: true } });
        case 'chat.getPermalink':
          return send({ ok: true, permalink: `https://acme.slack.com/archives/${String(body.channel)}/p${String(body.message_ts).replace('.', '')}` });
        case 'users.info': {
          const name = people[String(body.user)];
          return send(name ? { ok: true, user: { id: body.user, profile: { display_name: name } } } : { ok: false, error: 'user_not_found' });
        }
        case 'conversations.replies': {
          const thread = threads.get(`${String(body.channel)}:${String(body.ts)}`);
          return send(thread ? { ok: true, messages: thread } : { ok: false, error: 'thread_not_found' });
        }
        case 'chat.postMessage':
          return send({ ok: true, ts: `${Date.now() / 1000}`, channel: body.channel });
        default:
          return send({ ok: true });
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(Number(new URL(SLACK.url).port), '127.0.0.1', resolve);
  });
  return {
    calls,
    people,
    threads,
    callsOf: (method: string) => calls.filter((c) => c.method === method),
    /** Headers as Slack signs what it sends: v0, over the timestamp and the raw body. */
    signed(body: string): Record<string, string> {
      const ts = String(Math.floor(Date.now() / 1000));
      return { 'x-slack-request-timestamp': ts, 'x-slack-signature': `v0=${createHmac('sha256', SLACK.signingSecret).update(`v0:${ts}:${body}`).digest('hex')}` };
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
