/**
 * The languages a4a speaks to people in (docs/architecture.md, D49). Each has one catalog,
 * `packages/shared/i18n/<locale>.json`: message keys to ICU MessageFormat, English the source.
 * The web loads the one its person reads; the server holds them all, to write each person's email,
 * inbox, push and chat in theirs. The API's and MCP's own words stay English: agents read them.
 */
import { IntlMessageFormat, type PrimitiveType } from 'intl-messageformat';

/** The languages there are catalogs for. A new one is a catalog and a line here (docs/translating.md). */
export const LOCALES = ['en', 'de', 'es', 'fr', 'ja'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'en';

/** Each language by its own name, as a person looking for theirs reads it. */
export const LOCALE_NAMES: Record<Locale, string> = { en: 'English', de: 'Deutsch', es: 'Español', fr: 'Français', ja: '日本語' };

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/** The first of these preferences (a browser's languages, an Accept-Language) a4a speaks, by language. */
export function matchLocale(preferences: readonly string[] | string | null | undefined, fallback: Locale = DEFAULT_LOCALE): Locale {
  const list = typeof preferences === 'string' ? parseAcceptLanguage(preferences) : (preferences ?? []);
  for (const tag of list) {
    const lang = tag.trim().toLowerCase().split(/[-_]/)[0];
    if (isLocale(lang)) return lang;
  }
  return fallback;
}

/** An Accept-Language header's tags, by the weight each gives. */
function parseAcceptLanguage(header: string): string[] {
  return header
    .split(',')
    .map((part) => {
      const [tag, ...params] = part.trim().split(';');
      const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
      return { tag: tag!.trim(), q: q ? Number(q.slice(2)) || 0 : 1 };
    })
    .filter((x) => x.tag && x.tag !== '*' && x.q > 0)
    .sort((a, b) => b.q - a.q)
    .map((x) => x.tag);
}

export type Messages = Record<string, string>;
/** A message's values: what fills its placeholders; a rich one's tags take functions. */
export type MessageValues = Record<string, unknown>;

export interface Translator {
  readonly locale: Locale;
  /** The message, its placeholders filled: plain words, for an attribute, an email or a push. */
  t(key: string, values?: MessageValues): string;
  /** The message's parts: words, and whatever a tag's function or a value made of them (a page's elements). */
  parts<T>(key: string, values?: MessageValues): (string | T)[];
  has(key: string): boolean;
}

/**
 * A translator over one catalog. Each message is compiled once, when first said. A key the catalog
 * lacks says itself, so a gap shows where it is rather than as nothing (the checks keep there being none).
 */
export function createTranslator(locale: Locale, messages: Messages): Translator {
  const compiled = new Map<string, IntlMessageFormat>();
  // As a page draws them: nothing for false, null and undefined; a number as written (an id, a
  // year), unless the message formats it ({n, number}, {n, plural, ...}).
  const prepare = (key: string, values?: MessageValues): MessageValues | undefined => {
    if (!values) return values;
    const source = messages[key] ?? '';
    const out: MessageValues = {};
    for (const [name, v] of Object.entries(values)) {
      if (v === null || v === undefined || v === false || v === true) out[name] = '';
      else if (typeof v === 'number' && !source.includes(`{${name},`)) out[name] = String(v);
      else out[name] = v;
    }
    return out;
  };
  const format = (key: string): IntlMessageFormat | null => {
    const hit = compiled.get(key);
    if (hit) return hit;
    const source = messages[key];
    if (source === undefined) return null;
    const made = new IntlMessageFormat(source, locale, undefined, { ignoreTag: false });
    compiled.set(key, made);
    return made;
  };
  return {
    locale,
    has: (key) => key in messages,
    t(key, values) {
      const f = format(key);
      if (!f) return key;
      const out = f.format(prepare(key, values) as Record<string, PrimitiveType> | undefined);
      return Array.isArray(out) ? out.join('') : String(out);
    },
    parts<T>(key: string, values?: MessageValues) {
      const f = format(key);
      if (!f) return [key];
      const out = f.format<T>(prepare(key, values) as Record<string, PrimitiveType | T>);
      return (Array.isArray(out) ? out : [out]) as (string | T)[];
    },
  };
}

/** The placeholders and tags a message names, for the checks: a translation must name the same. */
export function messageArguments(source: string): string[] {
  const names = new Set<string>();
  const walk = (els: unknown[]) => {
    for (const el of els as { type: number; value?: string; options?: Record<string, { value: unknown[] }>; children?: unknown[] }[]) {
      if (el.type !== 0 && el.type !== 7 && typeof el.value === 'string') names.add(el.value);
      if (el.options) for (const o of Object.values(el.options)) walk(o.value);
      if (el.children) walk(el.children);
    }
  };
  walk(new IntlMessageFormat(source, 'en').getAst() as unknown[]);
  return [...names].sort();
}

/**
 * A problem's words in any language (D49): its key under problem.* and its values. A value may be
 * another problem, or a list of them (a query's problems), each said whole in its place.
 */
export type ProblemSaid = { key: string; values?: Record<string, string | number | ProblemSaid | ProblemSaid[]> };

/** What goes between two sentences said one after the other: a space, but nothing after Japanese's 。. */
const SENTENCE_GAP: Record<Locale, string> = { en: ' ', de: ' ', es: ' ', fr: ' ', ja: '' };

/** Sentences said one after the other, as the translator's language puts them; empty ones left out. */
export function joinSentences(tr: Translator, sentences: readonly string[]): string {
  return sentences.filter(Boolean).join(SENTENCE_GAP[tr.locale]);
}

/** A problem in a translator's language; the problems among its values are said first, in the same language. */
/**
 * Whether a catalog can say a problem whole: its key, and each problem among its values. One it
 * can't is said in the server's English instead, so a page never shows a key for words it lacks.
 */
export function canSayProblem(tr: Translator, p: ProblemSaid): boolean {
  if (!tr.has(`problem.${p.key}`)) return false;
  return Object.values(p.values ?? {}).every((v) => (Array.isArray(v) ? v.every((q) => canSayProblem(tr, q)) : typeof v === 'object' ? canSayProblem(tr, v) : true));
}

export function sayProblem(tr: Translator, p: ProblemSaid): string {
  const values: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(p.values ?? {})) {
    values[k] = Array.isArray(v) ? v.map((q) => sayProblem(tr, q)).join(SENTENCE_GAP[tr.locale]) : typeof v === 'object' ? sayProblem(tr, v) : v;
  }
  return tr.t(`problem.${p.key}`, values);
}
