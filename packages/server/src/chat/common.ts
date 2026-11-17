/**
 * What Teams and Slack share in a4a (D42): who's acting, where a4a may call, how a call can fail,
 * and what an answer to someone is.
 */
import { CHAT_PLATFORM_NAMES, type ChatPlatform } from '@a4a/shared';
import type { Locale, Translator } from '@a4a/shared/i18n';
import { effectiveScopes, type AppServices, type Ctx, type UserRow } from '../context';
import { localeOfPerson, translatorFor } from '../i18n';
import { open, seal } from '../lib/secret-box';

/** A linked person, acting from chat: as themselves, with their own access, through the chat channel. */
export function chatCtx(app: AppServices, user: UserRow, platform: ChatPlatform): Ctx {
  return {
    app,
    db: app.db,
    actor: { user, scopes: effectiveScopes(user.role), channel: 'chat', tokenId: null, tokenName: CHAT_PLATFORM_NAMES[platform], authMethod: 'session', projectIds: null },
    // What a4a says to them in chat is in their language (D49).
    locale: localeOfPerson(app, user),
  };
}

/** Whom a4a answers in chat: their language, or the server's when they chose none (D49). */
export const personTr = (app: AppServices, user: Pick<UserRow, 'locale'>): Translator => translatorFor(localeOfPerson(app, user));

/** A channel's language: the server's, since its people read a post together (D49). */
export const channelTr = (app: AppServices): Translator => translatorFor(app.config.defaultLocale);

const keySource = (app: AppServices) => ({ secretKey: app.config.secretKey, dataDir: app.config.dataDir });
export const sealSecret = (app: AppServices, plain: string) => seal(keySource(app), plain);
export const openSecret = (app: AppServices, sealed: string | null | undefined) => (sealed ? open(keySource(app), sealed) : null);

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * Whether a4a may call this address for chat: https to one of the hosts the chat's own service names
 * (Teams' Bot Framework hosts, Slack's API), or, in tests alone, plain http on this machine.
 */
export function callable(app: AppServices, url: string, hosts: readonly string[]): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  if (LOOPBACK.has(u.hostname)) return app.config.chatAllowHttpLoopback && (u.protocol === 'http:' || u.protocol === 'https:');
  return u.protocol === 'https:' && hosts.includes(u.hostname.toLowerCase());
}

/** A call to the chat service that failed: what to do about it. */
export class ChatCallError extends Error {
  constructor(
    message: string,
    /** retry: try again later; gone: the channel can't be posted to; removed: the app or bot is gone; failed: it won't work. */
    readonly outcome: 'retry' | 'gone' | 'removed' | 'failed',
    /** For retry: how long the service asked a4a to wait. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

/** Seconds from a Retry-After header, as milliseconds; a date there too. */
export function retryAfterMs(header: string | null | undefined): number | undefined {
  if (!header) return undefined;
  const n = Number(header);
  if (Number.isFinite(n) && n >= 0) return Math.min(n, 3_600) * 1000;
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, Math.min(at - Date.now(), 3_600_000)) : undefined;
}

/** What a4a says back to one person, as each chat draws it. */
export interface Answer {
  text: string;
  /** The language it's in, for the cards beside it. */
  locale: Locale;
  /** Issues to show as cards, as the person sees them. */
  issues?: import('./cards').CardIssue[];
  /** Whether the whole channel may see it (a subscription's confirmation); otherwise only the person. */
  public?: boolean;
}

/** The address of an issue's page. */
export function issueUrl(app: AppServices, id: string): string {
  return `${app.config.publicUrl}/issues/${encodeURIComponent(id)}`;
}
