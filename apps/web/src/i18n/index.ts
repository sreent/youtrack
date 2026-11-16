/**
 * The web app's words, in the language its person reads (docs/architecture.md, D49).
 *
 * The page loads one catalog, its person's, before it runs the app (main.tsx), so every word the
 * app says, a constant at a module's top included, is already in that language; the app's chunk
 * downloads meanwhile. Changing language reloads the page: nothing has to say itself again.
 *
 * Which language: the one the person chose on their profile (kept here once the server says it), else
 * the browser's, else the server's default, else English.
 */
import { createTranslator, DEFAULT_LOCALE, isLocale, matchLocale, type Locale, type MessageValues, type Translator } from '@a4a/shared/i18n';
import { createElement, Fragment, type ReactNode } from 'react';

const catalogs = import.meta.glob<{ default: Record<string, string> }>('../../../../packages/shared/i18n/*.json');
const catalogOf = (locale: Locale) => catalogs[`../../../../packages/shared/i18n/${locale}.json`];

/** The person's own choice, as the server last said it ('' when they chose none). */
const CHOSEN = 'a4a.locale';
/** The server's default, for a browser that asks for no language a4a speaks. */
const SERVER_DEFAULT = 'a4a.defaultLocale';

let translator: Translator = createTranslator(DEFAULT_LOCALE, {});

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // A private window keeps nothing: the browser's language it is, each time.
  }
}

/** The language this page should be in, by what it knows before anything loads. */
export function wantedLocale(): Locale {
  const chosen = stored(CHOSEN);
  if (isLocale(chosen)) return chosen;
  const fallback = stored(SERVER_DEFAULT);
  return matchLocale(navigator.languages?.length ? navigator.languages : [navigator.language], isLocale(fallback) ? fallback : DEFAULT_LOCALE);
}

/** Load the page's one catalog. Called once, before the app's modules run. */
export async function startI18n(locale: Locale = wantedLocale()): Promise<void> {
  const load = catalogOf(locale) ?? catalogOf(DEFAULT_LOCALE);
  const messages = load ? (await load()).default : {};
  translator = createTranslator(catalogOf(locale) ? locale : DEFAULT_LOCALE, messages);
  document.documentElement.lang = translator.locale;
}

/** A message in plain words: for an attribute, a title, a status line. */
export function t(key: string, values?: MessageValues): string {
  return translator.t(key, values);
}

/** A message whose tags or values are elements: what a page draws. */
export function tr(key: string, values?: MessageValues): ReactNode {
  const parts = translator.parts<ReactNode>(key, values);
  if (parts.length === 1) return parts[0];
  return createElement(Fragment, null, ...parts.map((part, i) => createElement(Fragment, { key: i }, part)));
}

/**
 * A problem from the server in the page's language, by its key; null when it has none, or no words
 * here (D49). In English the server's own words stand, as they always did: they're the source.
 */
export function problemWords(e: unknown): string | null {
  if (translator.locale === DEFAULT_LOCALE || !e || typeof e !== 'object') return null;
  const { key, values } = e as { key?: unknown; values?: unknown };
  if (typeof key !== 'string' || !translator.has(`problem.${key}`)) return null;
  return translator.t(`problem.${key}`, values && typeof values === 'object' ? (values as MessageValues) : undefined);
}

/** The language the page is in. */
export function getLocale(): Locale {
  return translator.locale;
}

/** Intl's tag for the page's language: a4a's English writes dates the British way ("9 Nov"). */
export function intlLocale(): string {
  return translator.locale === 'en' ? 'en-GB' : translator.locale;
}

/** Languages whose nouns keep their capital inside a sentence. */
const CAPITAL_NOUNS: ReadonlySet<Locale> = new Set<Locale>(['de']);

/** A label set inside a sentence ("Time logged, by person"): lower-cased at its start, unless the page's language capitalises its nouns. */
export function inSentence(label: string): string {
  return CAPITAL_NOUNS.has(translator.locale) ? label : label.charAt(0).toLowerCase() + label.slice(1);
}

/**
 * What the server says of the person's language: their choice (null: none) and its default. When
 * the page isn't in the language that makes, it's kept and the page reloads into it.
 */
export function keepLocale(theirs: string | null | undefined, serverDefault?: string | null): void {
  if (isLocale(serverDefault)) store(SERVER_DEFAULT, serverDefault);
  store(CHOSEN, isLocale(theirs) ? theirs : '');
  reloadIfAnother();
}

/** After the person chooses a language on their profile: show it now. */
export function useLocaleNow(locale: Locale | null): void {
  store(CHOSEN, locale ?? '');
  reloadIfAnother();
}

/** Reload into the language wanted, if it isn't this page's and a catalog for it is there (no loop). */
function reloadIfAnother(): void {
  const wanted = wantedLocale();
  if (wanted !== translator.locale && catalogOf(wanted)) location.reload();
}

// Intl's formats, in the page's language. A date's time zone is the person's, where it matters (D31).
export const formatNumber = (n: number, options?: Intl.NumberFormatOptions) => new Intl.NumberFormat(intlLocale(), options).format(n);
export const formatDate = (d: Date | string | number, options?: Intl.DateTimeFormatOptions) => new Date(d).toLocaleDateString(intlLocale(), options);
export const formatDateTime = (d: Date | string | number, options?: Intl.DateTimeFormatOptions) => new Date(d).toLocaleString(intlLocale(), options);
export const formatTime = (d: Date | string | number, options?: Intl.DateTimeFormatOptions) => new Date(d).toLocaleTimeString(intlLocale(), options);
export const formatList = (items: string[], type: Intl.ListFormatType = 'conjunction') => new Intl.ListFormat(intlLocale(), { style: 'long', type }).format(items);
const EN_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const EN_DAYS = { short: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], long: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] };
/** The months' short names, January first, in the page's language (English keeps its three letters). */
export function monthNames(): string[] {
  if (translator.locale === 'en') return EN_MONTHS;
  const f = new Intl.DateTimeFormat(intlLocale(), { month: 'short', timeZone: 'UTC' });
  return Array.from({ length: 12 }, (_, m) => f.format(Date.UTC(2021, m, 1)));
}
/** The weekdays' names, Sunday first, as getDay() counts them, in the page's language. */
export function weekdayNames(width: 'short' | 'long' = 'short'): string[] {
  if (translator.locale === 'en') return EN_DAYS[width];
  const f = new Intl.DateTimeFormat(intlLocale(), { weekday: width, timeZone: 'UTC' });
  // 3 January 2021 was a Sunday.
  return Array.from({ length: 7 }, (_, d) => f.format(Date.UTC(2021, 0, 3 + d)));
}
/** "5 minutes ago", "in 2 days": numbers always, so English reads as it did ("1 day ago", not "yesterday"). */
export const formatRelative = (value: number, unit: Intl.RelativeTimeFormatUnit) => new Intl.RelativeTimeFormat(intlLocale(), { numeric: 'always' }).format(value, unit);
