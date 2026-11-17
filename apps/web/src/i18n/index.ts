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
import { canSayProblem, createTranslator, DEFAULT_LOCALE, isLocale, joinSentences, matchLocale, sayProblem, type Locale, type MessageValues, type ProblemSaid, type Translator } from '@a4a/shared/i18n';
import { noteIn } from '@a4a/shared/notes';
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

/** Whether the page's catalog has a message: a key the server kept with something may be one a later a4a renamed. */
export function canSay(key: string): boolean {
  return translator.has(key);
}

/** A list of things a page draws, joined as the page's language joins a list: "A, B and C", "A、B、C". */
export function listNodes(items: ReactNode[], type: Intl.ListFormatType = 'conjunction'): ReactNode {
  if (items.length <= 1) return items[0] ?? null;
  const marks = items.map((_, i) => `\u0001${i}\u0001`);
  const parts = new Intl.ListFormat(intlLocale(), { style: 'long', type }).formatToParts(marks);
  return createElement(Fragment, null, ...parts.map((p, i) => createElement(Fragment, { key: i }, p.type === 'element' ? items[Number(p.value.slice(1, -1))] : p.value)));
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
  if (typeof key !== 'string') return null;
  const words: ProblemSaid = { key, values: values && typeof values === 'object' ? (values as ProblemSaid['values']) : undefined };
  return canSayProblem(translator, words) ? sayProblem(translator, words) : null;
}

/**
 * A parser's problem (the query's, a command's, a rule's, a move's) in the page's language (D49): its
 * whole sentence, fix included, from problem.<key>. Null on an English page, and for a problem no
 * catalog has, where the page shows the server's English. With `guessShown`, it leaves out its own
 * "Did you mean …?", for a page that offers the guess as a button of its own.
 */
export function problemSaid(p: { key?: string; values?: Record<string, string | number> }, guessShown = false): string | null {
  if (!p.key) return null;
  return problemWords(guessShown && p.values?.hasGuess === 'yes' ? { key: p.key, values: { ...p.values, hasGuess: 'no' } } : p);
}

/**
 * What went wrong, as the server gave it: in the page's language by its words (D49), else in the
 * English it came in. A script's engine's own words have none, and stay as it said them.
 */
export function errorSaid(words: unknown, english: string): string {
  return problemWords(words) ?? english;
}

/** Sentences one after the other, as the page's language puts them: a space, but none after Japanese's 。. */
export function sentences(parts: readonly string[]): string {
  return joinSentences(translator, parts);
}

/**
 * A commit's command note, in the page's language (D49): why it wasn't applied (without the API's
 * "Not applied:"), or what it did. One kept before a4a kept its words, or one that is only field names
 * and values, as its English says it.
 */
export function commandNote(said: unknown, note: unknown): string {
  const english = (typeof note === 'string' ? note : '').replace(/^Not applied:\s*/i, '');
  const kept = said && typeof said === 'object' && typeof (said as { key?: unknown }).key === 'string' ? (said as { key: string; values?: Record<string, unknown> }) : null;
  return noteIn(translator, kept, english);
}

/** Words the shared package says with a translator (`@a4a/shared/notes`), said in the page's language. */
export function inPage<T>(say: (tr: Translator) => T): T {
  return say(translator);
}

/** The language the page is in. */
export function getLocale(): Locale {
  return translator.locale;
}

/** Intl's tag for the page's language: a4a's English writes dates the British way ("9 Nov"). */
export function intlLocale(): string {
  return translator.locale === 'en' ? 'en-GB' : translator.locale;
}

/**
 * Languages that keep a label's first letter inside a sentence: German, whose nouns keep their capital,
 * and Chinese, which has none to lower, so a capital there begins a name ("Backend 中的新问题").
 */
const CAPITAL_NOUNS: ReadonlySet<Locale> = new Set<Locale>(['de', 'zh']);

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
