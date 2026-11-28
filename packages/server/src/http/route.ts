import { createRoute, type OpenAPIHono } from '@hono/zod-openapi';
import { ErrorSchema } from '@a4a/shared';
import type { Context } from 'hono';
import type { z } from 'zod';
import type { Ctx } from '../context';
import { unauthorized } from '../lib/errors';
import type { HttpEnv } from './env';

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';
type AnyObject = z.ZodObject<z.ZodRawShape>;

export interface RouteSpec<P extends AnyObject | undefined, Q extends AnyObject | undefined, B extends z.ZodType | undefined> {
  method: Method;
  path: string;
  tags: string[];
  summary: string;
  description?: string;
  params?: P;
  query?: Q;
  body?: B;
  /** The body may be left out: a request without one reads as {}. */
  bodyOptional?: boolean;
  response?: z.ZodType;
  status?: 200 | 201 | 202 | 204 | 302;
  /**
   * A second answer some requests get, documented beside the first: a DELETE that answers 204, and
   * 200 with a body when asked for one. The handler returns it as a Response of its own.
   */
  also?: { status: 200; description: string; response: z.ZodType };
  /** 'required' (default): 401 without a user. 'none': public. */
  auth?: 'required' | 'none';
  /**
   * A guest, sending no credentials, reads it too, in the projects open to guests (D37, D64): said in
   * OpenAPI as a request that may go without credentials. Which requests a guest makes is decided by
   * `guestMayRequest` (services/guests.ts); a test holds the two to the same routes.
   */
  guests?: boolean;
  /** Hidden from the OpenAPI document. */
  hidden?: boolean;
}

type Infer<T> = T extends z.ZodType ? z.infer<T> : undefined;

export interface HandlerArgs<P, Q, B> {
  c: Context<HttpEnv>;
  ctx: Ctx;
  params: P;
  query: Q;
  body: B;
}

const errorContent = { 'application/json': { schema: ErrorSchema } };
const GUESTS_READ = 'Guests read it too, sending no credentials, in the projects an administrator opened to anyone, and see there what a guest may see (D37, D64).';
const ERRORS = {
  400: { description: 'Invalid request: the error says what to fix', content: errorContent },
  401: { description: 'Not signed in, or the token is unknown, expired or revoked', content: errorContent },
  403: { description: 'Not allowed for this role or token scope', content: errorContent },
  404: { description: 'Not found', content: errorContent },
  409: { description: 'Conflict, e.g. the issue changed since expectedVersion', content: errorContent },
};

/**
 * Register a typed, documented endpoint. Validation, OpenAPI and the context
 * (who is acting) come from the spec; handlers return data or a Response.
 */
export function route<P extends AnyObject | undefined, Q extends AnyObject | undefined, B extends z.ZodType | undefined>(
  app: OpenAPIHono<HttpEnv>,
  spec: RouteSpec<P, Q, B>,
  handler: (args: HandlerArgs<Infer<P>, Infer<Q>, Infer<B>>) => Promise<unknown>,
): void {
  const status = spec.status ?? (spec.method === 'post' ? 201 : 200);
  const config = createRoute({
    method: spec.method,
    path: spec.path,
    tags: spec.tags,
    summary: spec.summary,
    description: spec.guests ? [spec.description, GUESTS_READ].filter(Boolean).join('\n\n') : spec.description,
    hide: spec.hidden,
    // An empty requirement is OpenAPI's way of saying a request may go without any.
    security: spec.auth === 'none' ? [] : spec.guests ? [{ bearerAuth: [] }, { cookieAuth: [] }, {}] : [{ bearerAuth: [] }, { cookieAuth: [] }],
    request: {
      ...(spec.params ? { params: spec.params } : {}),
      ...(spec.query ? { query: spec.query } : {}),
      ...(spec.body ? { body: { content: { 'application/json': { schema: spec.body } }, required: !spec.bodyOptional } } : {}),
    },
    responses: {
      [status]:
        spec.response && status !== 204
          ? { description: 'OK', content: { 'application/json': { schema: spec.response } } }
          : { description: status === 204 ? 'Done' : status === 302 ? 'A redirect, for a browser to follow' : 'OK' },
      ...(spec.also ? { [spec.also.status]: { description: spec.also.description, content: { 'application/json': { schema: spec.also.response } } } } : {}),
      ...ERRORS,
    },
  });
  // The handler's return type is checked by the service signatures; Hono's typed
  // responses add nothing here, so the registration is untyped.
  (app as unknown as { openapi: (r: unknown, h: (c: Context<HttpEnv>) => Promise<Response>) => void }).openapi(
    config,
    async (c) => {
      const ctx = c.get('ctx');
      if (spec.auth !== 'none' && !ctx) {
        throw unauthorized('Sign in, or send "Authorization: Bearer <token>"', 'Create a token under Agents and tokens.').said('access.signInOrToken');
      }
      const req = c.req as unknown as { valid: (t: string) => unknown };
      const args = {
        c,
        ctx: ctx as Ctx,
        params: (spec.params ? req.valid('param') : undefined) as Infer<P>,
        query: (spec.query ? req.valid('query') : undefined) as Infer<Q>,
        body: (spec.body ? req.valid('json') : undefined) as Infer<B>,
      };
      const result = await handler(args);
      if (result instanceof Response) return result;
      if (status === 204) return c.body(null, 204);
      return c.json(result as object, status as 200);
    },
  );
}
