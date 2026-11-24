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

/**
 * A list among a message's values, which the translator joins in its reader's language (D49): its
 * items one after another, as the language puts a list's first items ("Ada, Ben", 「Ada、Ben」,
 * `joinItems`), as a problem lists the fields there are; or `{ and }` and `{ or }`, Intl's list with
 * its word ("Priority and Importance", "Priority e Importancia", "A, B ou C").
 */
export type ListSaid = readonly string[] | { readonly and: readonly string[] } | { readonly or: readonly string[] };

export function isListSaid(v: unknown): v is ListSaid {
  if (Array.isArray(v)) return v.every((x) => typeof x === 'string');
  if (!v || typeof v !== 'object') return false;
  const list = (v as { and?: unknown; or?: unknown }).and ?? (v as { or?: unknown }).or;
  return Array.isArray(list) && list.every((x) => typeof x === 'string') && !('key' in v);
}

/** A list in a language, as `ListSaid` says to join it. */
export function sayList(locale: Locale, list: ListSaid): string {
  if (isItems(list)) return joinItems(locale, list);
  return 'and' in list ? joinList(locale, list.and) : joinList(locale, list.or, { type: 'disjunction' });
}

const isItems = (list: ListSaid): list is readonly string[] => Array.isArray(list);

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
  const edges = EDGES[locale];
  // As a page draws them: nothing for false, null and undefined; a number as written (an id, a
  // year), unless the message formats it ({n, number}, {n, plural, ...}); a list joined in the
  // language (ListSaid).
  const prepare = (key: string, values?: MessageValues): MessageValues | undefined => {
    if (!values) return values;
    const source = messages[key] ?? '';
    const out: MessageValues = {};
    for (const [name, v] of Object.entries(values)) {
      if (v === null || v === undefined || v === false || v === true) out[name] = '';
      else if (typeof v === 'number' && !source.includes(`{${name},`)) out[name] = String(v);
      else if (isListSaid(v)) out[name] = sayList(locale, v);
      else out[name] = v;
      // The marks that tell a value's edges are a4a's alone.
      if (edges && typeof out[name] === 'string') out[name] = (out[name] as string).replace(MARKS, '');
    }
    return out;
  };
  const format = (key: string): IntlMessageFormat | null => {
    const hit = compiled.get(key);
    if (hit) return hit;
    const source = messages[key];
    if (source === undefined) return null;
    // Its plurals and numbers by the language's Intl tag: Portugal's Portuguese counts 0 as many, as Brazil's doesn't.
    const made = new IntlMessageFormat(source, intlTag(locale), undefined, { ignoreTag: false });
    // Where the language changes its own words at a value's edge (French's elision, Chinese's
    // spacing), each value is said between marks, so the words beside it can be found and only those.
    const said = edges ? new IntlMessageFormat(markValues(made.getAst()), intlTag(locale), undefined, { ignoreTag: false }) : made;
    compiled.set(key, said);
    return said;
  };
  return {
    locale,
    has: (key) => key in messages,
    t(key, values) {
      const f = format(key);
      if (!f) return key;
      const out = f.format(prepare(key, values) as Record<string, PrimitiveType> | undefined);
      const text = Array.isArray(out) ? out.join('') : String(out);
      if (edges) return atEdges(edges, piecesOf([text], new Map())).map((p) => ('text' in p ? p.text : '')).join('');
      return locale === 'ko' ? koreanParticles(text) : text;
    },
    parts<T>(key: string, values?: MessageValues) {
      const f = format(key);
      if (!f) return [key];
      if (edges) {
        // What each tag made, by the value at its start and its end, so the words beside it can be told.
        const made = new Map<unknown, Edged>();
        const given = prepare(key, values);
        const watched = given
          ? Object.fromEntries(
              Object.entries(given).map(([name, v]) => [
                name,
                typeof v === 'function'
                  ? (chunks: unknown[]) => {
                      const inside = atEdges(edges, piecesOf(chunks, made));
                      const result = (v as (c: unknown[]) => unknown)(rebuilt(inside));
                      if (result && typeof result === 'object') made.set(result, edgesOf(inside));
                      return result;
                    }
                  : v,
              ]),
            )
          : given;
        const out = f.format<T>(watched as Record<string, PrimitiveType | T>);
        return rebuilt(atEdges(edges, piecesOf(Array.isArray(out) ? out : [out], made))) as (string | T)[];
      }
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

/**
 * A value's edges, as a translator says a message in a language that changes its own words there:
 * each placeholder's value goes between these, and they're taken out before anyone sees the words.
 */
const OPEN = '\u0002';
const CLOSE = '\u0003';
const MARKS = /[\u0002\u0003]/g;

type Ast = ReturnType<IntlMessageFormat['getAst']>;

/** A message with each placeholder's value between marks, in every case of its plurals and selects and inside its tags. */
function markValues(els: Ast): Ast {
  return els.flatMap((el) => {
    const e = el as { type: number; options?: Record<string, { value: Ast }>; children?: Ast };
    if (e.type === 1) return [{ type: 0, value: OPEN }, el, { type: 0, value: CLOSE }] as Ast;
    if (e.options) return [{ ...el, options: Object.fromEntries(Object.entries(e.options).map(([k, o]) => [k, { ...o, value: markValues(o.value) }])) }] as Ast;
    if (e.children) return [{ ...el, children: markValues(e.children) }] as Ast;
    return [el];
  });
}

/** What a tag made of words, by its text, and the value it begins and ends with ('' where it begins or ends with the message's own words). */
type Edged = { text: string; first: string; last: string };

/** A message as it's said, in pieces: the message's own words, a value's, or something a page draws (what a tag made, a value's element). */
type Piece = { text: string; value: boolean } | { thing: unknown; edged?: Edged };

function piecesOf(parts: readonly unknown[], made: ReadonlyMap<unknown, Edged>): Piece[] {
  const out: Piece[] = [];
  for (const p of parts) {
    if (typeof p !== 'string') {
      out.push({ thing: p, edged: made.get(p) });
      continue;
    }
    let value = false;
    for (const bit of p.split(/([\u0002\u0003])/)) {
      if (bit === OPEN) value = true;
      else if (bit === CLOSE) value = false;
      else if (bit) out.push({ text: bit, value });
    }
  }
  return out;
}

/** Pieces back as a message's parts: words joined into strings, the marks gone. */
function rebuilt(pieces: readonly Piece[]): unknown[] {
  const out: unknown[] = [];
  for (const p of pieces) {
    if (!('text' in p)) out.push(p.thing);
    else if (typeof out[out.length - 1] === 'string') out[out.length - 1] += p.text;
    else out.push(p.text);
  }
  return out.length ? out : [''];
}

const textOf = (p: Piece | undefined): string => (!p ? '' : 'text' in p ? p.text : (p.edged?.text ?? ''));
/** The value a piece begins or ends with: a value's words, or those a tag made begin or end with. */
const valueAt = (p: Piece | undefined, end: boolean): string => (!p ? '' : 'text' in p ? (p.value ? p.text : '') : ((end ? p.edged?.last : p.edged?.first) ?? ''));
const ownWords = (p: Piece | undefined): p is { text: string; value: false } => Boolean(p && 'text' in p && !p.value);

function edgesOf(pieces: readonly Piece[]): Edged {
  return { text: pieces.map(textOf).join(''), first: valueAt(pieces[0], false), last: valueAt(pieces[pieces.length - 1], true) };
}

function atEdges(rule: (pieces: Piece[]) => void, pieces: Piece[]): Piece[] {
  rule(pieces);
  return pieces;
}

/** French's words that elide before a vowel's sound; si only before il and ils. */
const ELIDES = /(^|[^\p{L}\p{N}’'-])(de|le|la|que|ne|se|me|te|jusque|lorsque|puisque|si)[  ]$/iu;
const VOWEL = 'aeiouàâäéèêëîïôöùûüœæ';

/**
 * Whether French elides a word before this value (D49): before a vowel, and before a y that sounds
 * as one, before a consonant (d’Yves, de Yann). An acronym by its first letter, as French writes it:
 * l’API, d’iOS, de SQL (le FMI, la SNCF). Never before h, which a4a can't tell mute (d’Hélène) from
 * aspirated (de HubSpot), a digit (de 8, le 11), or a word that refuses it (de oui, le onze).
 */
export function frenchElides(word: string, value: string): boolean {
  const first = /^\p{L}+/u.exec(value)?.[0];
  if (!first) return false;
  if (word.toLowerCase() === 'si') return /^ils?$/i.test(first);
  if (/^(oui|onze|onzième)$/i.test(first)) return false;
  return new RegExp(`^([${VOWEL}]|y(?![${VOWEL}y]))`, 'iu').test(first);
}

/** French: a word that elides, just before a value that begins with a vowel's sound, is elided ("de {name}": "d’Ada"). */
function frenchElision(pieces: Piece[]): void {
  for (let i = 1; i < pieces.length; i++) {
    const before = pieces[i - 1];
    const value = valueAt(pieces[i], false);
    if (!value || !ownWords(before)) continue;
    const m = ELIDES.exec(before.text);
    if (m && frenchElides(m[2]!, value)) before.text = `${before.text.slice(0, m.index + m[1]!.length)}${m[2]!.slice(0, -1)}’`;
  }
}

/** Set in CJK's square cells, where Chinese puts no space: Han, kana, Hangul, and full-width punctuation and quotes. */
const SQUARE = '\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}\\u3000-\\u303f\\uff01-\\uff60“”';
const SQUARE_START = new RegExp(`^[${SQUARE}]`, 'u');
const SQUARE_END = new RegExp(`[${SQUARE}]$`, 'u');

/** Whether a value begins (or ends) in Chinese: Chinese spaces it from a Chinese word there only if it doesn't. */
export function squareAt(text: string, end: boolean): boolean {
  return (end ? SQUARE_END : SQUARE_START).test(text);
}

/**
 * Chinese: the space a message puts between its words and a value, which Chinese wants beside Latin
 * letters and digits, goes where the value begins or ends in Chinese and so do the words beside it
 * ("以 {name} 身份": "以 Ada 身份", "以王芳身份").
 */
function chineseSpacing(pieces: Piece[]): void {
  for (let i = 0; i < pieces.length; i++) {
    const before = pieces[i - 1];
    if (squareAt(valueAt(pieces[i], false), false) && ownWords(before) && before.text.endsWith(' ')) {
      const other = before.text.length > 1 ? before.text.slice(0, -1) : textOf(pieces[i - 2]);
      if (squareAt(other, true)) before.text = before.text.slice(0, -1);
    }
    const after = pieces[i + 1];
    if (squareAt(valueAt(pieces[i], true), true) && ownWords(after) && after.text.startsWith(' ')) {
      const other = after.text.length > 1 ? after.text.slice(1) : textOf(pieces[i + 2]);
      if (squareAt(other, false)) after.text = after.text.slice(1);
    }
  }
}

/** The languages whose words change at a value's edge, and how. Korean's particles hear what comes before them anywhere (koreanParticles). */
const EDGES: Partial<Record<Locale, (pieces: Piece[]) => void>> = { fr: frenchElision, zh: chineseSpacing };

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
 * a list (the fields there are, joined as the reader's language joins them), another problem, or a
 * list of problems (a query's), each said whole in its place.
 */
export type ProblemSaid = { key: string; values?: Record<string, string | number | ListSaid | ProblemSaid | ProblemSaid[]> };

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
 * A language's tag where its country matters, for a page's `lang` and for Intl: a4a's Portuguese is
 * Portugal's, so a screen reader reads it in a European voice, and dates, numbers and counts are
 * Portugal's ("16/11/2026", "1234,5", "0 itens"), whatever a runtime's own `pt` is (Brazil's).
 */
export function langTag(locale: Locale): string {
  return locale === 'pt' ? 'pt-PT' : locale;
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

/**
 * Things said one after another with no "and" (the fields a problem lists, a card's summary and its
 * state), with what the language puts between a list's first items: ", ", Japanese's and Chinese's
 * "、", Thai's space, or a comma beside a name (listParts). English's is ", ", as the API joins them.
 */
export function joinItems(locale: Locale, items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  // A list one longer has every one of these before its "and": keep it up to the last of them.
  const parts = listParts(locale, items.length + 1, (i) => items[Math.min(i, items.length - 1)]!);
  return parts
    .slice(0, parts.indexOf(items.length - 1) + 1)
    .map((p) => (typeof p === 'number' ? items[p] : p))
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
  return Object.values(p.values ?? {}).every((v) =>
    isListSaid(v) ? true : Array.isArray(v) ? v.every((q) => canSayProblem(tr, q)) : typeof v === 'object' ? canSayProblem(tr, v as ProblemSaid) : true,
  );
}

export function sayProblem(tr: Translator, p: ProblemSaid): string {
  const values: Record<string, string | number | ListSaid> = {};
  for (const [k, v] of Object.entries(p.values ?? {})) {
    // A list of words the translator joins as its language does; problems are said whole, one after another.
    values[k] = isListSaid(v) ? v : Array.isArray(v) ? v.map((q) => sayProblem(tr, q)).join(SENTENCE_GAP[tr.locale]) : typeof v === 'object' ? sayProblem(tr, v as ProblemSaid) : v;
  }
  return tr.t(`problem.${p.key}`, values);
}
