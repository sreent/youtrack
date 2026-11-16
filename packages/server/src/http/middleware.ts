import { localeOfRequest } from '../i18n';
import { createHash } from 'node:crypto';
import { and, eq, lt, sql } from 'drizzle-orm';
import type { Context, MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ZodError } from 'zod';
import type { Runtime } from '../app-services';
import type { Ctx } from '../context';
import { idempotencyKeys } from '../db/schema';
import { AppError } from '../lib/errors';
import { newId } from '../lib/ids';
import { ACCESS_PREFIX, mcpChallenge } from '../oauth/common';
import { actorFromOAuthToken } from '../oauth/tokens';
import { actorFromSession, actorFromToken, SESSION_COOKIE } from '../services/auth';
import { guestCtx, guestMayRequest } from '../services/guests';
import type { HttpEnv } from './env';

export function errorBody(code: string, message: string, hint?: string, details?: unknown) {
  return { error: { code, message, ...(hint ? { hint } : {}), ...(details !== undefined ? { details } : {}) } };
}

/** Map anything thrown to the API's error shape. */
export function toErrorResponse(c: Context<HttpEnv>, err: unknown): Response {
  if (err instanceof AppError) {
    return c.json(errorBody(err.code, err.message, err.hint, err.details), err.status as ContentfulStatusCode);
  }
  if (err instanceof ZodError) {
    return c.json(errorBody('validation_failed', 'The request is not valid', undefined, err.issues), 400);
  }
  const pgCode = (err as { code?: string; cause?: { code?: string } })?.code ?? (err as { cause?: { code?: string } })?.cause?.code;
  if (pgCode === '23505') return c.json(errorBody('conflict', 'That already exists'), 409);
  if (pgCode === '23503') return c.json(errorBody('conflict', 'It is still referenced by something else'), 409);
  console.error(`[${c.get('requestId')}]`, err);
  return c.json(errorBody('internal', 'Something went wrong on the server', `Request ${c.get('requestId')}`), 500);
}

/** Resolve who is acting: a bearer token (API / MCP) or the session cookie (web). */
export function authenticate(runtime: Runtime): MiddlewareHandler<HttpEnv> {
  return async (c, next) => {
    c.set('runtime', runtime);
    c.set('requestId', newId(10));
    let ctx: Ctx | null = null;
    // SCIM takes its own tokens, and nothing else (scim/routes.ts, D38); so does a CI posting a build (D46).
    if (c.req.path === '/scim' || c.req.path.startsWith('/scim/') || c.req.path.startsWith('/api/v1/builds/hooks/')) {
      c.set('ctx', null);
      return next();
    }
    // Teams' activities come with Bot Framework's token, which the endpoint checks itself (D42).
    if (c.req.path === '/api/v1/chat/teams/messages') {
      c.set('ctx', null);
      return next();
    }
    const header = c.req.header('authorization');
    const isMcp = c.req.path === '/mcp' || c.req.path.startsWith('/mcp/');
    if (header?.toLowerCase().startsWith('bearer ')) {
      const bearer = header.slice(7).trim();
      // An app's token (OAuth, D28) is for /mcp alone: its audience. Elsewhere it's refused unread.
      const oauth = bearer.startsWith(ACCESS_PREFIX);
      if (oauth && !isMcp) {
        return c.json(errorBody('unauthorized', 'This token is an app’s, for MCP: it works at /mcp only', 'For the REST API, create an API token in Profile → API tokens.'), 401);
      }
      const actor = oauth ? await actorFromOAuthToken(runtime, bearer) : await actorFromToken(runtime.db, bearer, isMcp ? 'mcp' : 'api');
      if (!actor) {
        // At /mcp the challenge says where to sign in again, so a client can renew what expired.
        if (isMcp) c.header('www-authenticate', mcpChallenge(runtime.config, { code: 'invalid_token', description: 'The token is unknown, expired or revoked' }));
        return c.json(errorBody('unauthorized', 'The token is unknown, expired or revoked', 'Create a new token in Profile → API tokens.'), 401);
      }
      ctx = { app: runtime, db: runtime.db, actor };
    } else if (!isMcp) {
      const session = getCookie(c, SESSION_COOKIE);
      if (session) {
        const actor = await actorFromSession(runtime.db, session);
        if (actor) ctx = { app: runtime, db: runtime.db, actor };
      }
    }
    // Not signed in, and reading: a guest, while some project is open to guests (D37).
    if (!ctx && !header && c.req.path.startsWith('/api/v1/') && guestMayRequest(c.req.method, c.req.path.slice('/api/v1'.length))) {
      ctx = await guestCtx(runtime);
    }
    // The language its answer's words for a person are in (D49): the page's, theirs, their browser's.
    if (ctx) ctx.locale = localeOfRequest(ctx, { pageLocale: c.req.header('x-a4a-locale'), acceptLanguage: c.req.header('accept-language') });
    c.set('ctx', ctx);
    await next();
  };
}

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Cookie-authenticated writes must come from our own pages. Bearer-token requests
 * carry no ambient credentials, so they are not subject to CSRF. `exempt` paths take
 * posts from other sites by design and check what they're sent themselves: the SAML
 * assertion consumer, which a same-site identity provider reaches with the session cookie.
 */
export function csrfGuard(publicUrl: string, exempt: string[] = []): MiddlewareHandler<HttpEnv> {
  const allowed = new Set([new URL(publicUrl).host]);
  const open = new Set(exempt);
  return async (c, next) => {
    const ctx = c.get('ctx');
    if (UNSAFE.has(c.req.method) && ctx?.actor.authMethod === 'session' && !open.has(c.req.path)) {
      const origin = c.req.header('origin') ?? c.req.header('referer');
      const host = c.req.header('host');
      let ok = false;
      if (origin) {
        try {
          const h = new URL(origin).host;
          ok = allowed.has(h) || h === host;
        } catch {
          ok = false;
        }
      }
      if (!ok) return c.json(errorBody('forbidden', 'Cross-site request refused'), 403);
    }
    await next();
  };
}

/**
 * Simple fixed-window counters, per instance, on purpose: a shared counter would add a
 * database write to every request to guard capacity that is per instance anyway. With
 * N instances behind a load balancer a client gets up to N times the limit (see
 * docs/architecture.md, D17). The login throttle, which guards accounts, is shared.
 */
export class RateLimiter {
  private windows = new Map<string, { start: number; count: number }>();
  constructor(
    private limit: number,
    private windowMs: number,
  ) {}

  /** Returns seconds to wait, or 0 if allowed. */
  hit(key: string): number {
    const now = Date.now();
    const w = this.windows.get(key);
    if (!w || now - w.start >= this.windowMs) {
      this.windows.set(key, { start: now, count: 1 });
      if (this.windows.size > 50_000) this.prune(now);
      return 0;
    }
    w.count++;
    return w.count > this.limit ? Math.ceil((w.start + this.windowMs - now) / 1000) : 0;
  }

  reset(key: string) {
    this.windows.delete(key);
  }

  private prune(now: number) {
    for (const [k, w] of this.windows) if (now - w.start >= this.windowMs) this.windows.delete(k);
  }
}

export function rateLimit(limiter: RateLimiter, trustedProxies = 0, guests?: RateLimiter): MiddlewareHandler<HttpEnv> {
  return async (c, next) => {
    const ctx = c.get('ctx');
    // A guest is nobody in particular (D37): each address has an allowance of its own, a smaller one.
    const guest = Boolean(ctx?.actor.guest);
    const key = ctx && !guest ? (ctx.actor.tokenId ?? ctx.actor.user.id) : `ip:${clientIp(c, trustedProxies)}`;
    const wait = guest && guests ? guests.hit(key) : limiter.hit(key);
    if (wait) {
      c.header('retry-after', String(wait));
      return c.json(errorBody('rate_limited', 'Too many requests', `Retry in ${wait}s`), 429);
    }
    await next();
  };
}

/**
 * The client's address. Each trusted proxy appends the address it received the request
 * from to X-Forwarded-For, so with `trustedProxies` of them the client is the entry the
 * outermost one added; anything to its left came from the client and proves nothing.
 * Without trusted proxies the header is ignored.
 */
export function clientIp(c: Context, trustedProxies = 0): string {
  const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming;
  const peer = incoming?.socket?.remoteAddress ?? 'unknown';
  if (trustedProxies <= 0) return peer;
  const chain = (c.req.header('x-forwarded-for') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!chain.length) return peer;
  return chain[Math.max(0, chain.length - trustedProxies)]!.slice(0, 64);
}

/** A claimed key whose request hasn't finished after this long is taken to be abandoned. */
const ABANDONED_CLAIM_MS = 5 * 60_000;

/**
 * Idempotency-Key for POSTs. The key is claimed before the work runs, so two
 * concurrent retries can't both create, on any instance; a finished request's
 * response is replayed; reusing a key with a different body is an error.
 */
export function idempotency(runtime: Runtime): MiddlewareHandler<HttpEnv> {
  return async (c, next) => {
    const key = c.req.header('idempotency-key');
    const ctx = c.get('ctx');
    if (c.req.method !== 'POST' || !key || !ctx) return next();
    if (key.length > 200) return c.json(errorBody('bad_request', 'Idempotency-Key is too long'), 400);
    // An upload isn't read twice (it streams to storage): its key is matched on its length instead.
    const multipart = (c.req.header('content-type') ?? '').toLowerCase().startsWith('multipart/');
    const raw = multipart ? `multipart, ${c.req.header('content-length') ?? 'length unknown'}` : await c.req.raw.clone().text();
    const fingerprint = `${c.req.method} ${c.req.path} ${createHash('sha256').update(raw).digest('hex')}`;
    const db = runtime.db;
    // Forget keys after a day.
    await db.delete(idempotencyKeys).where(lt(idempotencyKeys.createdAt, new Date(Date.now() - 86_400_000))).catch(() => {});
    const claimed = await db
      .insert(idempotencyKeys)
      .values({ userId: ctx.actor.user.id, key, method: c.req.method, path: fingerprint, statusCode: 0, responseBody: null })
      .onConflictDoNothing()
      .returning();
    if (!claimed.length) {
      const [existing] = await db
        .select()
        .from(idempotencyKeys)
        .where(and(eq(idempotencyKeys.userId, ctx.actor.user.id), eq(idempotencyKeys.key, key)));
      if (!existing) return c.json(errorBody('conflict', 'Try again'), 409);
      if (existing.path !== fingerprint) {
        return c.json(errorBody('idempotency_mismatch', 'This Idempotency-Key was used for a different request'), 422);
      }
      if (existing.statusCode === 0) {
        // A claim that never finished: the instance holding it died mid-request (a crash,
        // or a deploy). After a while the key may be claimed again, or it would answer
        // 409 for a day. Times are the database's, so instances' clocks don't matter.
        const retaken = await db
          .update(idempotencyKeys)
          .set({ createdAt: sql`now()` })
          .where(
            and(
              eq(idempotencyKeys.userId, ctx.actor.user.id),
              eq(idempotencyKeys.key, key),
              eq(idempotencyKeys.statusCode, 0),
              sql`${idempotencyKeys.createdAt} < now() - ${ABANDONED_CLAIM_MS}::integer * interval '1 millisecond'`,
            ),
          )
          .returning({ key: idempotencyKeys.key });
        if (!retaken.length) {
          return c.json(errorBody('conflict', 'A request with this Idempotency-Key is still in progress', 'Retry once it has finished.'), 409);
        }
      } else {
        c.header('idempotent-replayed', 'true');
        return c.json(existing.responseBody as object, existing.statusCode as ContentfulStatusCode);
      }
    }
    await next();
    const res = c.res;
    if (res.status >= 500) {
      // Let the client retry the same key after a server error.
      await db.delete(idempotencyKeys).where(and(eq(idempotencyKeys.userId, ctx.actor.user.id), eq(idempotencyKeys.key, key)));
      return;
    }
    let body: unknown = null;
    try {
      body = await res.clone().json();
    } catch {
      body = null;
    }
    await db
      .update(idempotencyKeys)
      .set({ statusCode: res.status, responseBody: body as never })
      .where(and(eq(idempotencyKeys.userId, ctx.actor.user.id), eq(idempotencyKeys.key, key)));
  };
}

/** Security headers for every response; a strict CSP for pages. */
export function securityHeaders(): MiddlewareHandler<HttpEnv> {
  return async (c, next) => {
    await next();
    c.header('x-content-type-options', 'nosniff');
    c.header('referrer-policy', 'same-origin');
    // An app's widget files are framed by a4a's own pages (D48): they say so themselves.
    if (!c.res.headers.has('x-frame-options')) c.header('x-frame-options', 'DENY');
    const type = c.res.headers.get('content-type') ?? '';
    // A response with a policy of its own, such as an uploaded file's sandbox, keeps it.
    if (type.includes('text/html') && !c.req.path.startsWith('/api/docs') && !c.res.headers.has('content-security-policy')) {
      c.header(
        'content-security-policy',
        // The app's manifest and its service worker are its own files too (D47); frame-src: an app's
        // widgets (D48), from a4a's own signed addresses, each sandboxed.
        "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; media-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      );
    }
  };
}
