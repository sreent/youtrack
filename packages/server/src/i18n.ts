/**
 * The server's words for people, in each one's language (docs/architecture.md, D49): what an email,
 * a push, the inbox or a chat says to them. The API's and MCP's own words stay English, as agents
 * and scripts read them; a problem shown on a page carries its key and values beside its English.
 */
import { createTranslator, DEFAULT_LOCALE, isLocale, matchLocale, type Locale, type Translator } from '@a4a/shared/i18n';
import de from '@a4a/shared/i18n/de.json';
import en from '@a4a/shared/i18n/en.json';
import es from '@a4a/shared/i18n/es.json';
import fr from '@a4a/shared/i18n/fr.json';
import ja from '@a4a/shared/i18n/ja.json';
import type { Ctx } from './context';

/** Every catalog, by language. A new language is a catalog, a line in LOCALES, and a line here. */
const catalogs: Record<Locale, Record<string, string>> = { en, de, es, fr, ja };

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
export function problemFor(tr: Translator, e: { message: string; hint?: string; words?: { key: string; values?: Record<string, string | number> } }): string {
  const key = e.words ? `problem.${e.words.key}` : null;
  if (key && tr.locale !== DEFAULT_LOCALE && tr.has(key)) return tr.t(key, e.words!.values);
  return e.hint ? `${e.message}. ${e.hint}` : e.message;
}

/** Items as a list in a language, "read, write or admin": a problem's values say a list in its reader's language (D49). */
export function listIn(locale: Locale | undefined, items: readonly string[], type: 'and' | 'or' = 'and'): string {
  return new Intl.ListFormat(intlTag(locale ?? DEFAULT_LOCALE), { style: 'long', type: type === 'or' ? 'disjunction' : 'conjunction' }).format(items);
}

/** Intl's tag for a language: a4a's English writes dates the British way, as it always has. */
export function intlTag(locale: Locale): string {
  return locale === 'en' ? 'en-GB' : locale;
}
