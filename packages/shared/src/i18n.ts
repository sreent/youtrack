/**
 * The languages a4a speaks to people in (docs/architecture.md, D49). Each has one catalog,
 * `packages/shared/i18n/<locale>.json`: message keys to ICU MessageFormat, English the source.
 * The web loads the one its person reads; the server holds them all, to write each person's email,
 * inbox, push and chat in theirs. The API's and MCP's own words stay English: agents read them.
 */
import { IntlMessageFormat, type PrimitiveType } from 'intl-messageformat';

/** The languages there are catalogs for. A new one is a catalog and a line here (docs/translating.md). */
export const LOCALES = ['en', 'de', 'es', 'fr', 'id', 'ja', 'ko', 'pt', 'th', 'vi', 'zh'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'en';

/** Each language by its own name, as a person looking for theirs reads it. */
export const LOCALE_NAMES: Record<Locale, string> = { en: 'English', de: 'Deutsch', es: 'Español', fr: 'Français', id: 'Bahasa Indonesia', ja: '日本語', ko: '한국어', pt: 'Português', th: 'ไทย', vi: 'Tiếng Việt', zh: '简体中文' };

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
      const text = Array.isArray(out) ? out.join('') : String(out);
      return locale === 'ko' ? koreanParticles(text) : text;
    },
    parts<T>(key: string, values?: MessageValues) {
      const f = format(key);
      if (!f) return [key];
      // Korean's particles follow what a tag holds too ("<b>{name}</b>을(를)"): each tag's words are kept to read its end by.
      const said = new Map<unknown, string>();
      const given = prepare(key, values);
      const watched =
        locale === 'ko' && given
          ? Object.fromEntries(
              Object.entries(given).map(([name, v]) => [
                name,
                typeof v === 'function'
                  ? (chunks: unknown[]) => {
                      const made = (v as (c: unknown[]) => unknown)(chunks);
                      said.set(made, chunks.map((c) => (typeof c === 'string' ? c : (said.get(c) ?? ''))).join(''));
                      return made;
                    }
                  : v,
              ]),
            )
          : given;
      const out = f.format<T>(watched as Record<string, PrimitiveType | T>);
      const parts = (Array.isArray(out) ? out : [out]) as (string | T)[];
      if (locale !== 'ko') return parts;
      const joined: (string | T)[] = [];
      for (const p of parts) {
        const last = joined.length - 1;
        if (typeof p === 'string' && typeof joined[last] === 'string') joined[last] = (joined[last] as string) + p;
        else joined.push(p);
      }
      return joined.map((p, i) => (typeof p === 'string' ? koreanParticles(p, i > 0 ? (said.get(joined[i - 1]) ?? '') : '') : p));
    },
  };
}

/** How a word ends, for the Korean particle after it: its last syllable's final consonant (ㄹ apart), or a digit's as Korean reads it ("12" 십이, "10" 십). Null where a4a can't know, as after a Latin word. */
function koreanEnd(text: string): 'vowel' | 'rieul' | 'consonant' | null {
  const ch = text.replace(/["'”’»)\]」』》〉>]+$/u, '').slice(-1);
  if (!ch) return null;
  const code = ch.charCodeAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) {
    const final = (code - 0xac00) % 28;
    return final === 0 ? 'vowel' : final === 8 ? 'rieul' : 'consonant';
  }
  const digits: Record<string, 'vowel' | 'rieul' | 'consonant'> = { '0': 'consonant', '1': 'rieul', '2': 'vowel', '3': 'consonant', '4': 'vowel', '5': 'vowel', '6': 'consonant', '7': 'rieul', '8': 'rieul', '9': 'vowel' };
  return digits[ch] ?? null;
}

/** Korean's particles written both ways, as a catalog must where a value goes before one. */
const KOREAN_PARTICLE = /을\(를\)|은\(는\)|이\(가\)|과\(와\)|\(으\)로|\(이\)(?=[가-힣])/g;

/**
 * Korean's particles chosen where the word before them says which (D49): "BACK-12을(를)" is
 * "BACK-12를", "민준이(가)" "민준이", "서울(으)로" "서울로". After a word a4a can't read the end of (a
 * Latin one: "Anna을(를)"), both ways stay, as Korean software writes them. `before` is what came
 * just before the text, when that was a page's element.
 */
export function koreanParticles(text: string, before = ''): string {
  return text.replace(KOREAN_PARTICLE, (form: string, offset: number) => {
    const end = koreanEnd(offset ? text.slice(0, offset) : before);
    if (!end) return form;
    const closed = end !== 'vowel';
    switch (form) {
      case '을(를)':
        return closed ? '을' : '를';
      case '은(는)':
        return closed ? '은' : '는';
      case '이(가)':
        return closed ? '이' : '가';
      case '과(와)':
        return closed ? '과' : '와';
      case '(으)로':
        return end === 'consonant' ? '으로' : '로';
      default:
        // (이)라는, (이)면: 이 after a consonant, nothing after a vowel.
        return closed ? '이' : '';
    }
  });
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

/**
 * Which words a subscription is said in (D31, D49), for a message that takes `{tells, select, …}`
 * and `{name}`: new issues in a project, every change in it, issues coming into a saved search, or
 * changes to issues in one. Each language words each case whole, in the case its sentence needs.
 */
export function subscriptionTells(target: 'project' | 'search', events: 'new' | 'all'): 'projectNew' | 'projectAll' | 'searchNew' | 'searchAll' {
  return target === 'project' ? (events === 'all' ? 'projectAll' : 'projectNew') : events === 'all' ? 'searchAll' : 'searchNew';
}

/** What goes between two sentences said one after the other: a space, but nothing after Japanese's or Chinese's 。 (Korean's . takes one). */
const SENTENCE_GAP: Record<Locale, string> = { en: ' ', de: ' ', es: ' ', fr: ' ', id: ' ', ja: '', ko: ' ', pt: ' ', th: ' ', vi: ' ', zh: '' };

/**
 * A language's tag for a page's `lang` and for Intl: its code, each language a4a speaks being one for
 * everyone who reads it (one Spanish, one Portuguese).
 */
export function langTag(locale: Locale): string {
  return locale;
}

/**
 * Intl's tag for a language: a4a's English writes dates and lists the British way, as it always has.
 * Thai's years are Gregorian, as every date a4a takes from people is (a query's, a command's, a date
 * field's), not the Buddhist era's that Intl's `th` counts by (2569 for 2026); its digits are Arabic.
 */
export function intlTag(locale: Locale): string {
  if (locale === 'th') return 'th-TH-u-ca-gregory-nu-latn';
  return locale === 'en' ? 'en-GB' : langTag(locale);
}

const THAI = /[\u0E00-\u0E7F]/;

/**
 * Intl's list of n items in a language (D49): each item as its index, each joining word as a string.
 * Thai's list is made for Thai words: a bare space between two, และ and หรือ glued to the next ("Anna
 * Ben และCarl", "SPRและที่ยังไม่ปิด"). Thai sets a name, an id or a number off with a space, so beside an
 * item that isn't Thai a joining word gets one, and a bare space a comma, as Thai's own "or" list has.
 */
export function listParts(locale: Locale, n: number, textOf: (i: number) => string, options: Intl.ListFormatOptions = {}): (string | number)[] {
  const marks = Array.from({ length: n }, (_, i) => `\u0001${i}\u0001`);
  const parts = new Intl.ListFormat(intlTag(locale), { style: 'long', type: 'conjunction', ...options }).formatToParts(marks);
  const out: (string | number)[] = parts.map((p) => (p.type === 'element' ? Number(p.value.slice(1, -1)) : p.value));
  if (locale !== 'th') return out;
  const latin = (i: unknown, end: boolean) => typeof i === 'number' && !THAI.test(end ? textOf(i).slice(-1) : textOf(i).slice(0, 1));
  return out.map((p, i) => {
    if (typeof p === 'number') return p;
    const before = latin(out[i - 1], true);
    const after = latin(out[i + 1], false);
    const word = p.trim();
    if (!before && !after) return p;
    if (!word) return ', ';
    if (!THAI.test(word)) return p;
    return `${before || /^\s/.test(p) ? ' ' : ''}${word}${after || /\s$/.test(p) ? ' ' : ''}`;
  });
}

/** Items as a list in a language: Intl's, Thai's spaced off from what isn't Thai (listParts). */
export function joinList(locale: Locale, items: readonly string[], options?: Intl.ListFormatOptions): string {
  return listParts(locale, items.length, (i) => items[i] ?? '', options)
    .map((p) => (typeof p === 'number' ? (items[p] ?? '') : p))
    .join('');
}

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
