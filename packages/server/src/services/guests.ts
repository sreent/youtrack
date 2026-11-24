import type { GuestInfo } from '@a4a/shared';
import type { Runtime } from '../app-services';
import type { Ctx, UserRow } from '../context';

/**
 * Guests (D37): someone not signed in, reading a project its administrators opened to anyone. A
 * guest has the read permission there and nowhere else, and no scope but read, so nothing they do
 * writes. They reach only the reading routes below; people's details stay with the users routes,
 * which they don't reach. Their requests are limited per address (GUEST_RATE_LIMIT).
 *
 * Beyond issues (D64): boards, the reports but the time report, a plan's schedule and whiteboards with
 * their live streams. Not a board's backlog, velocity or sprint plan, a plan's load, costs, baselines,
 * what-if or levelling, nor who looks at a whiteboard: those are the team's planning, its money and its
 * people.
 */

/** Who a guest is, as far as the code that wants a person goes: nobody in particular. */
export const GUEST_USER = {
  id: 'guest',
  login: 'guest',
  name: 'Guest',
  email: null,
  role: 'viewer',
  banned: false,
  isBot: false,
  avatarColor: '#8a8f98',
  timeZone: null,
} as unknown as UserRow;

/** The API paths (under /api/v1) a guest may read. */
const READABLE = [
  /^\/projects$/,
  /^\/projects\/[^/]+$/,
  /^\/projects\/[^/]+\/(fields|articles)$/,
  /^\/issues$/,
  /^\/issues\/[^/]+$/,
  /^\/issues\/[^/]+\/(activity|articles|attachments|comments|links)$/,
  /^\/search\/(count|parse|suggest)$/,
  /^\/articles$/,
  /^\/articles\/[^/]+$/,
  /^\/articles\/[^/]+\/attachments$/,
  /^\/attachments\/[^/]+$/,
  /^\/attachments\/[^/]+\/(content|text)$/,
  /^\/fields$/,
  /^\/tags$/,
  /^\/link-types$/,
  // D64: boards, reports, plans and whiteboards.
  /^\/boards$/,
  /^\/boards\/[^/]+$/,
  /^\/boards\/[^/]+\/view$/,
  /^\/reports\/(burndown|flow|created-resolved|cycle-time|issues-per-field|matrix|average-age|time-in-state)(\.csv)?$/,
  /^\/projects\/[^/]+\/schedule$/,
  /^\/whiteboards$/,
  /^\/whiteboards\/[^/]+$/,
  /^\/whiteboards\/[^/]+\/(cards|stream)$/,
];

/** Whether a guest may make this request: reading one of the paths above (a count or a parse is a read, sent as a post). */
export function guestMayRequest(method: string, apiPath: string): boolean {
  const reading = method === 'GET' || method === 'HEAD' || (method === 'POST' && /^\/search\/(count|parse)$/.test(apiPath));
  return reading && READABLE.some((r) => r.test(apiPath));
}

/** The projects anyone may read, signed in or not. */
export async function guestProjects(app: Ctx['app']): Promise<{ id: string; key: string; name: string }[]> {
  const s = await app.schema.get();
  return [...s.projects.values()]
    .filter((p) => p.guestAccess && p.visibility === 'open')
    .map((p) => ({ id: p.id, key: p.key, name: p.name }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

export async function guestInfo(app: Ctx['app']): Promise<GuestInfo> {
  return { projects: await guestProjects(app) };
}

/**
 * Nobody in particular, as a guest reads, whether or not a project is open to guests: what a check run
 * on a pull request may say (D66), since whoever sees the repository reads it.
 */
export function outsiderCtx(runtime: Ctx['app']): Ctx {
  return { app: runtime, db: runtime.db, actor: { user: GUEST_USER, scopes: ['read'], channel: 'web', tokenId: null, tokenName: null, authMethod: 'session', guest: true } };
}

/** A request's context as a guest, when some project is open to guests; null otherwise. */
export async function guestCtx(runtime: Runtime): Promise<Ctx | null> {
  if (!(await guestProjects(runtime)).length) return null;
  return {
    app: runtime,
    db: runtime.db,
    actor: { user: GUEST_USER, scopes: ['read'], channel: 'web', tokenId: null, tokenName: null, authMethod: 'session', guest: true },
  };
}
