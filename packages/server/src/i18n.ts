/**
 * The server's words for people, in each one's language (docs/architecture.md, D49): what an email,
 * a push, the inbox or a chat says to them. The API's and MCP's own words stay English, as agents
 * and scripts read them; a problem shown on a page carries its key and values beside its English.
 */
import { canSayProblem, createTranslator, DEFAULT_LOCALE, intlTag, isLocale, joinList, matchLocale, sayProblem, type Locale, type ProblemSaid, type Translator } from '@a4a/shared/i18n';
import de from '@a4a/shared/i18n/de.json';
import en from '@a4a/shared/i18n/en.json';
import es from '@a4a/shared/i18n/es.json';
import fr from '@a4a/shared/i18n/fr.json';
import id from '@a4a/shared/i18n/id.json';
import ja from '@a4a/shared/i18n/ja.json';
import ko from '@a4a/shared/i18n/ko.json';
import pt from '@a4a/shared/i18n/pt.json';
import th from '@a4a/shared/i18n/th.json';
import vi from '@a4a/shared/i18n/vi.json';
import zh from '@a4a/shared/i18n/zh.json';
import type { Ctx } from './context';

/** Every catalog, by language. A new language is a catalog, a line in LOCALES, and a line here. */
const catalogs: Record<Locale, Record<string, string>> = { en, de, es, fr, id, ja, ko, pt, th, vi, zh };

const translators = new Map<Locale, Translator>();

export function translatorFor(locale: Locale | string | null | undefined): Translator {
  const l = isLocale(locale) ? locale : DEFAULT_LOCALE;
  let hit = translators.get(l);
  if (!hit) {
    hit = createTranslator(l, catalogs[l] ?? catalogs[DEFAULT_LOCALE]);
    translators.set(l, hit);
  }
  return hit;
}

/** Whom a4a writes to by email or push: their language, or the server's default when they chose none. */
export function localeOfPerson(app: Pick<Ctx['app'], 'config'>, person: { locale?: string | null } | null | undefined): Locale {
  return isLocale(person?.locale) ? person.locale : app.config.defaultLocale;
}

/** What a4a knows of a requester's language: the one they chose on the portal, and the one their browser last asked for there. */
export type RequesterLanguage = { chosenLocale?: string | null; locale?: string | null } | null | undefined;

/**
 * A requester's language (D63's revisit), for the portal and every email to them: the one they chose,
 * else the one their browser last asked for, else, for an address a4a knows neither for, the language
 * of the page that asked for the mail (`asked`: a sign-in link's), else the desk's, the server's
 * default (D49). Every reader of a requester's language asks here.
 */
export function localeOfRequester(app: Pick<Ctx['app'], 'config'>, r: RequesterLanguage, asked?: string | null): Locale {
  if (isLocale(r?.chosenLocale)) return r.chosenLocale;
  if (isLocale(r?.locale)) return r.locale;
  if (isLocale(asked)) return asked;
  return app.config.defaultLocale;
}

/** A requester's language as the team sees it (D63's revisit): theirs when a4a knows one, and whether they chose it; null when it knows neither. */
export function languageOfRequester(r: RequesterLanguage): { locale: Locale; chosen: boolean } | null {
  if (isLocale(r?.chosenLocale)) return { locale: r.chosenLocale, chosen: true };
  if (isLocale(r?.locale)) return { locale: r.locale, chosen: false };
  return null;
}

/**
 * The language of an answer to a request: the page's (the web says which in `x-a4a-locale`), then the
 * person's choice, then what the browser asks for, then the server's default.
 */
export function localeOfRequest(ctx: Ctx, header?: { pageLocale?: string | null; acceptLanguage?: string | null }): Locale {
  if (isLocale(header?.pageLocale)) return header.pageLocale;
  if (isLocale(ctx.actor.user.locale)) return ctx.actor.user.locale;
  return matchLocale(header?.acceptLanguage ?? null, ctx.app.config.defaultLocale);
}

/**
 * A problem in a person's language, by its key (D49), where a4a speaks to them itself: a chat reply, say.
 * In English, or for a problem without a key, its own English, the fix after it.
 */
export function problemFor(tr: Translator, e: { message: string; hint?: string; words?: ProblemSaid }): string {
  const key = e.words ? `problem.${e.words.key}` : null;
  if (key && tr.locale !== DEFAULT_LOCALE && canSayProblem(tr, e.words!)) return sayProblem(tr, e.words!);
  return e.hint ? `${e.message}. ${e.hint}` : e.message;
}

/** Items as a list in a language, "read, write or admin": a problem's values say a list in its reader's language (D49). */
export function listIn(locale: Locale | undefined, items: readonly string[], type: 'and' | 'or' = 'and'): string {
  return joinList(locale ?? DEFAULT_LOCALE, items, { type: type === 'or' ? 'disjunction' : 'conjunction' });
}

export { intlTag };
