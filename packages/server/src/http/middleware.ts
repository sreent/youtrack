import { createHash } from 'node:crypto';
import { and, eq, lt } from 'drizzle-orm';
import type { Context, MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ZodError } from 'zod';
import type { Runtime } from '../app-services';
import type { Ctx } from '../context';
import { idempotencyKeys } from '../db/schema';
import { AppError } from '../lib/errors';
import { newId } from '../lib/ids';
import { actorFromSession, actorFromToken, SESSION_COOKIE } from '../services/auth';
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
    const header = c.req.header('authorization');
    const isMcp = c.req.path === '/mcp' || c.req.path.startsWith('/mcp/');
    if (header?.toLowerCase().startsWith('bearer ')) {
      const actor = await actorFromToken(runtime.db, header.slice(7).trim(), isMcp ? 'mcp' : 'api');
      if (!actor) {
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
    c.set('ctx', ctx);
    await next();
  };
}

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Cookie-authenticated writes must come from our own pages. Bearer-token requests
 * carry no ambient credentials, so they are not subject to CSRF.
 */
export function csrfGuard(publicUrl: string): MiddlewareHandler<HttpEnv> {
  const allowed = new Set([new URL(publicUrl).host]);
  return async (c, next) => {
    const ctx = c.get('ctx');
    if (UNSAFE.has(c.req.method) && ctx?.actor.authMethod === 'session') {
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

/** Simple fixed-window counters, per instance. */
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

export function rateLimit(limiter: RateLimiter): MiddlewareHandler<HttpEnv> {
  return async (c, next) => {
    const ctx = c.get('ctx');
    const key = ctx ? (ctx.actor.tokenId ?? ctx.actor.user.id) : `ip:${clientIp(c)}`;
    const wait = limiter.hit(key);
    if (wait) {
      c.header('retry-after', String(wait));
      return c.json(errorBody('rate_limited', 'Too many requests', `Retry in ${wait}s`), 429);
    }
    await next();
  };
}

export function clientIp(c: Context): string {
  const fwd = c.req.header('x-forwarded-for');
  if (fwd) return fwd.split(',')[0]!.trim();
  const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming;
  return incoming?.socket?.remoteAddress ?? 'unknown';
}

/**
 * Idempotency-Key for POSTs. The key is claimed before the work runs, so two
 * concurrent retries can't both create; a finished request's response is
 * replayed; reusing a key with a different body is an error.
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
        return c.json(errorBody('conflict', 'A request with this Idempotency-Key is still in progress'), 409);
      }
      c.header('idempotent-replayed', 'true');
      return c.json(existing.responseBody as object, existing.statusCode as ContentfulStatusCode);
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
    c.header('x-frame-options', 'DENY');
    const type = c.res.headers.get('content-type') ?? '';
    // A response with a policy of its own, such as an uploaded file's sandbox, keeps it.
    if (type.includes('text/html') && !c.req.path.startsWith('/api/docs') && !c.res.headers.has('content-security-policy')) {
      c.header(
        'content-security-policy',
        "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      );
    }
  };
}
