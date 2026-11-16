import type { Channel, Role, Scope } from '@a4a/shared';
import type { Config } from './config';
import type { Db } from './db/client';
import type { users } from './db/schema';
import type { EventBus } from './events/bus';
import type { Signals } from './events/signals';
import { forbidden } from './lib/errors';
import type { SchemaCache } from './services/schema-cache';

export type UserRow = typeof users.$inferSelect;

/** Who is acting, and through which channel. */
export interface Actor {
  user: UserRow;
  scopes: Scope[];
  channel: Channel;
  tokenId: string | null;
  tokenName: string | null;
  authMethod: 'session' | 'token' | 'system';
  /**
   * The only projects this actor may reach (ids), as a token limited to projects has them:
   * its access is its person's access to these projects alone. Absent or null: no such limit.
   */
  projectIds?: string[] | null;
}

/** Long-lived services shared by every request. */
export interface AppServices {
  config: Config;
  db: Db;
  bus: EventBus;
  /** What instances tell each other (LISTEN/NOTIFY on Postgres; nothing to tell on PGlite). */
  signals: Signals;
  schema: SchemaCache;
  /** Late-bound hooks so services can trigger AI work without import cycles. */
  hooks: {
    onIssueCreated?: (issueId: string, actor: Actor) => void;
  };
}

/**
 * Set while a workflow rule makes a change: which rule, the change that started the chain (an
 * event id; null for a scheduled run), how many rules deep this change is, and whose change set
 * the chain off. Every activity recorded under it carries it as `data.automation`, which is how
 * the rule engine stops loops and replays.
 */
export interface AutomationCause {
  rule: string;
  name: string;
  origin: string | null;
  depth: number;
  by: string | null;
}

/** Per-call context passed to every service function. */
export interface Ctx {
  app: AppServices;
  db: Db;
  actor: Actor;
  automation?: AutomationCause;
}

export function withChannel(ctx: Ctx, channel: Channel): Ctx {
  return { ...ctx, actor: { ...ctx.actor, channel } };
}

const ROLE_SCOPES: Record<Role, Scope[]> = {
  admin: ['read', 'write', 'admin'],
  member: ['read', 'write'],
  viewer: ['read'],
};

export function scopesForRole(role: string): Scope[] {
  return ROLE_SCOPES[(role as Role) in ROLE_SCOPES ? (role as Role) : 'viewer'];
}

/** Effective scopes = token scopes ∩ role scopes. */
export function effectiveScopes(role: string, tokenScopes?: string[] | null): Scope[] {
  const allowed = scopesForRole(role);
  if (!tokenScopes) return allowed;
  return allowed.filter((s) => tokenScopes.includes(s));
}

export function can(ctx: Ctx, scope: Scope): boolean {
  return ctx.actor.scopes.includes(scope);
}

export function requireScope(ctx: Ctx, scope: Scope): void {
  if (can(ctx, scope)) return;
  if (scope === 'admin') throw forbidden('This action requires an administrator');
  if (ctx.actor.authMethod === 'token') {
    throw forbidden(`This token lacks the "${scope}" scope`, 'Create a token with the required scope in Profile → API tokens.');
  }
  throw forbidden(scope === 'write' ? 'Your role is read-only' : 'You do not have access');
}

export function isAdmin(ctx: Ctx): boolean {
  return ctx.actor.scopes.includes('admin');
}
