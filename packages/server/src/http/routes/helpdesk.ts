/**
 * The help desk over HTTP: its public form and tracking page, which need no sign-in, and what the
 * team sees of a request. Each public route answers for one request at most, the same way whether
 * a project, request or token is missing or just not the caller's, and is limited per address
 * (services/help-throttle.ts, shared by every instance).
 */
import type { OpenAPIHono } from '@hono/zod-openapi';
import { HelpdeskRequestSchema, HelpFormSchema, HelpReplyBody, HelpRequestBody, HelpRequestReceivedSchema, TrackedRequestSchema } from '@a4a/shared';
import type { Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import { isLocale, type Locale } from '@a4a/shared/i18n';
import { checkCaptcha } from '../../helpdesk/captcha';
import { randomToken } from '../../lib/crypto';
import { AppError, badRequest } from '../../lib/errors';
import { helpHit, type HelpLimit } from '../../services/help-throttle';
import { deskProject, fileRequest, formTokenValid, helpForm, replyToRequest, requestOf, trackRequest } from '../../services/helpdesk';
import { projectSettings } from '../../services/projects';
import { waitInWords } from '../../services/login-throttle';
import type { HttpEnv } from '../env';
import { clientIp } from '../middleware';
import { route } from '../route';

export const HELP_COOKIE = 'a4a_help';
/** Where a tracking token travels: a header, so it stays out of addresses and logs. */
export const TRACKING_HEADER = 'x-tracking-token';

/**
 * Count a hit on each limit (shared by every instance) and refuse with 429 when one is over: in the
 * caller's words, keyed for a page in another language (D49), with how long to wait.
 */
export async function hit(c: Context<HttpEnv>, hits: [HelpLimit, string][], words: string, key: string): Promise<void> {
  const wait = await helpHit(c.get('runtime').db, hits);
  if (wait) {
    c.header('retry-after', String(wait));
    // As waitInWords says it: seconds under a minute, else minutes, rounded up.
    const unit = wait < 60 ? 'second' : 'minute';
    throw new AppError(429, 'rate_limited', words, `Try again in ${waitInWords(wait)}.`).said(key, { unit, n: wait < 60 ? wait : Math.ceil(wait / 60) });
  }
}

/** The caller's address, through the proxies TRUST_PROXY says are in front. */
export function ip(c: Context<HttpEnv>): string {
  return clientIp(c, c.get('runtime').config.trustProxy);
}

/** The language of the page that asked (its `x-a4a-locale`, D49), or null: a public page's mail carries it, for an address with none yet. */
export function pageLocaleOf(c: Context<HttpEnv>): Locale | null {
  const page = c.req.header('x-a4a-locale');
  return isLocale(page) ? page : null;
}

/**
 * Posts to the public pages must come from them: an Origin (or Referer) of this server. With the
 * form's token, tied to a SameSite=Strict cookie, that keeps other sites from posting for a visitor.
 */
export function sameOrigin(c: Context<HttpEnv>): void {
  const publicHost = new URL(c.get('runtime').config.publicUrl).host;
  const from = c.req.header('origin') ?? c.req.header('referer');
  let ok = false;
  if (from) {
    try {
      const h = new URL(from).host;
      ok = h === publicHost || h === c.req.header('host');
    } catch {
      ok = false;
    }
  }
  if (!ok) throw new AppError(403, 'forbidden', 'Cross-site request refused', 'Send it from the help desk page itself.').said('helpdesk.crossSite');
}

const Key = z.object({ key: z.string().min(1).max(10) });

export function helpdeskRoutes(app: OpenAPIHono<HttpEnv>) {
  const tags = ['Help desk'];
  route(
    app,
    {
      method: 'get',
      path: '/help/{key}',
      tags,
      summary: "A project's public request form",
      description: 'Public: no sign-in. 404 unless the project has its help desk on. Sets a cookie that, with `csrf`, must come back with the request.',
      auth: 'none',
      params: Key,
      response: HelpFormSchema,
    },
    async ({ c, params }) => {
      const runtime = c.get('runtime');
      await hit(c, [['form', ip(c)]], 'Too many requests for this form', 'helpdesk.tooManyForForm');
      const nonce = getCookie(c, HELP_COOKIE) ?? randomToken('', 18);
      const form = await helpForm(runtime, params.key, nonce);
      setCookie(c, HELP_COOKIE, nonce, {
        httpOnly: true,
        sameSite: 'Strict',
        path: '/api/v1/help',
        secure: runtime.config.publicUrl.startsWith('https://'),
        maxAge: 6 * 3600,
      });
      c.header('cache-control', 'no-store');
      return form;
    },
  );

  route(
    app,
    {
      method: 'post',
      path: '/help/{key}/requests',
      tags,
      summary: 'Ask for help: files an issue in the project',
      description:
        'Public: no sign-in. Needs the form\'s cookie and `csrf`, and an Origin of this server. Limited per address (5 in 15 minutes), per email (3 an hour) and per help desk. Leave `website` empty. The requester is emailed a link to follow the request; without SMTP the link comes back here, once.',
      auth: 'none',
      params: Key,
      body: HelpRequestBody,
      response: HelpRequestReceivedSchema,
    },
    async ({ c, params, body }) => {
      const runtime = c.get('runtime');
      sameOrigin(c);
      const project = await deskProject(runtime, params.key);
      if (!(await formTokenValid(runtime, project.key, getCookie(c, HELP_COOKIE), body.csrf))) {
        throw new AppError(403, 'form_expired', 'This form has expired', 'Reload the page and send it again: what you wrote is still there.').said('helpdesk.formExpired');
      }
      await hit(c, [['submitIp', ip(c)]], 'Too many requests from your address', 'helpdesk.tooManyFromAddress');
      // A bot filled the field people can't see: say it went, and do nothing.
      if (body.website?.trim()) return { received: true as const, email: body.email, tracking: null };
      if (projectSettings(project).helpdesk.captcha) {
        const verdict = await checkCaptcha(runtime, project.key, body.captcha);
        if (verdict === 'expired') throw new AppError(400, 'captcha_expired', 'The check that you’re not a bot has expired', 'It runs again by itself: send the request once more.').said('helpdesk.captchaExpired');
        if (verdict !== 'ok') throw new AppError(400, 'captcha_failed', 'The check that you’re not a bot didn’t pass', 'Reload the page and send it again: what you wrote is still there.').said('helpdesk.captchaFailed');
      }
      await hit(c, [['submitEmail', body.email]], 'Too many requests from this email address', 'helpdesk.tooManyFromEmail');
      await hit(c, [['submitDesk', project.id]], 'This help desk is taking too many requests just now', 'helpdesk.deskBusy');
      return fileRequest(runtime, project.key, body);
    },
  );

  route(
    app,
    {
      method: 'get',
      path: '/help/requests/by-token',
      tags,
      summary: 'A request, as its requester sees it',
      description: `Public: the tracking token is the authority, in the \`${TRACKING_HEADER}\` header. Shows its state and its public conversation, never anything internal.`,
      auth: 'none',
      response: TrackedRequestSchema,
    },
    async ({ c }) => {
      const runtime = c.get('runtime');
      await hit(c, [['track', ip(c)]], 'Too many requests', 'helpdesk.tooManyRequests');
      c.header('cache-control', 'no-store');
      return trackRequest(runtime, c.req.header(TRACKING_HEADER));
    },
  );

  route(
    app,
    {
      method: 'post',
      path: '/help/requests/by-token/replies',
      tags,
      summary: 'Reply to your request',
      description: `Public: the tracking token in the \`${TRACKING_HEADER}\` header, and an Origin of this server. The reply is public: the team sees it, and its watchers are told.`,
      auth: 'none',
      body: HelpReplyBody,
      response: TrackedRequestSchema,
      status: 200,
    },
    async ({ c, body }) => {
      const runtime = c.get('runtime');
      sameOrigin(c);
      const token = c.req.header(TRACKING_HEADER);
      await hit(c, [['replyIp', ip(c)]], 'Too many replies from your address', 'helpdesk.tooManyRepliesFromAddress');
      if (!token) throw badRequest('Missing the tracking token', `Send it in the ${TRACKING_HEADER} header.`).said('helpdesk.trackingTokenMissing', { header: TRACKING_HEADER });
      // Counted by its hash: a token is kept nowhere in plain text.
      await hit(c, [['replyRequest', token]], 'Too many replies to this request just now', 'helpdesk.tooManyRepliesToRequest');
      return replyToRequest(runtime, token, body.text);
    },
  );

  route(
    app,
    {
      method: 'get',
      path: '/issues/{id}/request',
      tags,
      summary: 'Who asked for an issue through the help desk, and its first-response target',
      params: z.object({ id: z.string() }),
      response: HelpdeskRequestSchema,
    },
    ({ ctx, params }) => requestOf(ctx, params.id),
  );
}
