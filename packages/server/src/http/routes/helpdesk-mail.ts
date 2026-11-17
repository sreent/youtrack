/**
 * The help desk's mail over HTTP (D30): where a desk's mail provider posts each message, and what
 * the desk's managers set up. The post needs no sign-in: the desk's secret, as HTTP Basic's
 * password, is its authority, and a desk that doesn't exist or has another secret answers alike.
 */
import type { OpenAPIHono } from '@hono/zod-openapi';
import { HelpdeskInboundAnswerSchema, HelpdeskInboundSchema, HelpdeskMailBody, HelpdeskMailSchema, HelpdeskMailSecretSchema } from '@a4a/shared';
import type { Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { receiveMail } from '../../helpdesk/inbound';
import { AppError, badRequest } from '../../lib/errors';
import { deskForSecret, deskMail, inboundLog, newMailSecret, removeMailSecret, setDeskAddress } from '../../services/helpdesk-mail';
import type { HttpEnv } from '../env';
import { errorBody } from '../middleware';
import { route } from '../route';
import { hit, ip } from './helpdesk';

const Key = z.object({ key: z.string().min(1).max(10) });

/** HTTP Basic's password, which is where a provider puts what a URL's credentials carry. */
function basicPassword(header: string | undefined): string | null {
  if (!header?.toLowerCase().startsWith('basic ')) return null;
  const decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  return colon >= 0 ? decoded.slice(colon + 1) : null;
}

/**
 * The message, raw, however the provider sends it: as the body itself (message/rfc822, as Cloudflare
 * and scripts send it), as a form's `email` (SendGrid's raw option) or `body-mime` (Mailgun), or as
 * JSON's `RawEmail` (Postmark, with raw content on).
 */
async function rawMessage(c: Context<HttpEnv>): Promise<Buffer | null> {
  const type = (c.req.header('content-type') ?? '').toLowerCase();
  if (type.startsWith('multipart/form-data') || type.startsWith('application/x-www-form-urlencoded')) {
    const form = await c.req.parseBody();
    const field = form.email ?? form['body-mime'];
    if (typeof field === 'string') return Buffer.from(field, 'utf8');
    if (field instanceof File) return Buffer.from(await field.arrayBuffer());
    return null;
  }
  if (type.startsWith('application/json')) {
    const body = (await c.req.json().catch(() => null)) as { RawEmail?: unknown; raw?: unknown } | null;
    const raw = body?.RawEmail ?? body?.raw;
    return typeof raw === 'string' ? Buffer.from(raw, 'utf8') : null;
  }
  return Buffer.from(await c.req.arrayBuffer());
}

export function helpdeskMailRoutes(app: OpenAPIHono<HttpEnv>) {
  const tags = ['Help desk'];

  // A message with its attachments, plus what a form or JSON wraps it in.
  app.use('/mail/inbound/*', async (c, next) => {
    const max = c.get('runtime').config.helpdeskMailMaxBytes;
    const limit = bodyLimit({
      maxSize: Math.ceil(max * 1.1) + 1024 * 1024,
      onError: (cc) => cc.json(errorBody('too_large', 'The message is too large', `A help desk takes messages up to ${Math.round(max / 1024 / 1024)} MB.`), 413),
    });
    return limit(c, next);
  });

  route(
    app,
    {
      method: 'post',
      path: '/mail/inbound/{key}',
      tags,
      summary: "Where a help desk's mail provider posts each message",
      description:
        "The desk's secret is HTTP Basic's password (any user name): give the provider the URL a4a shows with the secret in it. The message comes raw, as the body (`message/rfc822`), as a form's `email` or `body-mime` field, or as JSON's `RawEmail`. Each becomes a request, a reply on one, or nothing, said in the answer and the desk's log; one sent again is a duplicate. An error of a4a's own answers 5xx, so the provider tries again.",
      auth: 'none',
      params: Key,
      response: HelpdeskInboundAnswerSchema,
      status: 200,
    },
    async ({ c, params }) => {
      const runtime = c.get('runtime');
      const desk = await deskForSecret(runtime, params.key, basicPassword(c.req.header('authorization')));
      if (!desk) {
        await hit(c, [['mailAuth', ip(c)]], 'Too many posts without the secret from your address', 'helpdesk.tooManyWithoutSecret');
        c.header('www-authenticate', 'Basic realm="a4a help desk mail"');
        // api only: a mail provider posts here, never a page
        throw new AppError(401, 'unauthorized', 'This help desk takes no mail with that secret', "Give the mail provider the address a4a showed with the desk's secret, whole.");
      }
      const raw = await rawMessage(c);
      if (!raw?.length) {
        // api only: a mail provider posts here, never a page
        throw badRequest('There is no message in this post', 'Post it raw (message/rfc822), as a form\'s "email" or "body-mime" field, or as "RawEmail" in JSON.');
      }
      const got = await receiveMail(runtime, raw, { via: 'webhook', desk });
      return { outcome: got.outcome, reason: got.reason };
    },
  );

  route(
    app,
    {
      method: 'get',
      path: '/projects/{key}/helpdesk/mail',
      tags,
      summary: "A help desk's mail: its address, where a provider posts, and the shared mailbox (its managers)",
      params: Key,
      response: HelpdeskMailSchema,
    },
    ({ ctx, params }) => deskMail(ctx, params.key),
  );

  route(
    app,
    {
      method: 'put',
      path: '/projects/{key}/helpdesk/mail',
      tags,
      summary: "Set a help desk's address, or stop its mail (its managers)",
      description:
        'Each desk has an address of its own. a4a answers requesters from reply addresses made from it (support+<token>@…), so the mail server must deliver those to the same mailbox. `null` stops the mail and forgets the secret.',
      params: Key,
      body: HelpdeskMailBody,
      response: HelpdeskMailSchema,
    },
    ({ ctx, params, body }) => setDeskAddress(ctx, params.key, body.address),
  );

  route(
    app,
    {
      method: 'post',
      path: '/projects/{key}/helpdesk/mail/secret',
      tags,
      summary: "Make the secret a desk's mail provider posts with, or a new one in its place (its managers)",
      description: 'Shown once. The old secret stops working at once.',
      params: Key,
      response: HelpdeskMailSecretSchema,
      status: 201,
    },
    ({ ctx, params }) => newMailSecret(ctx, params.key),
  );

  route(
    app,
    { method: 'delete', path: '/projects/{key}/helpdesk/mail/secret', tags, summary: "Stop a desk's mail webhook (its managers)", params: Key, status: 204 },
    async ({ ctx, params }) => {
      await removeMailSecret(ctx, params.key);
      return null;
    },
  );

  route(
    app,
    {
      method: 'get',
      path: '/projects/{key}/helpdesk/mail/log',
      tags,
      summary: 'What came in for a help desk by email in the last 30 days, and what became of each (its managers)',
      params: Key,
      response: z.array(HelpdeskInboundSchema),
    },
    ({ ctx, params }) => inboundLog(ctx, params.key),
  );
}
