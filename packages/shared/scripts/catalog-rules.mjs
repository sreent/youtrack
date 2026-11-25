/**
 * What a catalog's message must keep from English's, in every language (docs/translating.md, D49).
 * `check:words` (apps/web/scripts/check-words.mjs) runs these over every catalog, and a native
 * speaker's sheet (`pnpm i18n:review import`) runs them over each suggestion before a word of it is
 * written, so a suggestion passes exactly when the catalog would. A rule says what's wrong and what
 * to keep, in words a reader of the import's report can act on.
 *
 * Plain JavaScript, so `node` runs it as check:words does, with no build.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { IntlMessageFormat } = require('intl-messageformat');

// The parser's element types (@formatjs/icu-messageformat-parser).
const LITERAL = 0;
const SELECT = 5;
const PLURAL = 6;
const POUND = 7;
const TAG = 8;

/** The languages `packages/shared/src/i18n.ts` lists, read from its source, as the web's checks always have. */
export function listedLocales(root) {
  const src = readFileSync(path.join(root, 'packages/shared/src/i18n.ts'), 'utf8');
  return JSON.parse(src.match(/export const LOCALES = (\[[^\]]*\])/)[1].replace(/'/g, '"'));
}

/** Every catalog in `packages/shared/i18n`, by its language's code. */
export function readCatalogs(root) {
  const dir = path.join(root, 'packages/shared/i18n');
  return Object.fromEntries(
    readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => [f.replace(/\.json$/, ''), JSON.parse(readFileSync(path.join(dir, f), 'utf8'))]),
  );
}

/**
 * Intl's tag for a language's plurals, as `intlTag` in src/i18n.ts says it (a test holds the two
 * together): Portugal's Portuguese counts 0 as "other", Brazil's as "one".
 */
export function pluralTag(locale) {
  if (locale === 'th') return 'th-TH-u-ca-gregory-nu-latn';
  if (locale === 'pt') return 'pt-PT';
  return locale === 'en' ? 'en-GB' : locale;
}

const NAMES = { en: 'English', de: 'German', es: 'Spanish', fr: 'French', id: 'Indonesian', ja: 'Japanese', ko: 'Korean', pt: 'Portuguese', th: 'Thai', vi: 'Vietnamese', zh: 'Chinese' };
/** A language's name in English, for the checks' and the review's words. */
export const languageName = (locale) => NAMES[locale] ?? locale;

/** A message's tree, or a thrown error saying where it doesn't parse. */
export function astOf(source) {
  return new IntlMessageFormat(source, 'en').getAst();
}

function walk(els, visit, parents = []) {
  for (const el of els) {
    visit(el, parents);
    if (el.options) for (const o of Object.values(el.options)) walk(o.value, visit, [...parents, el]);
    if (el.children) walk(el.children, visit, [...parents, el]);
  }
}

/** The placeholders and tags a message names, sorted: a translation names the same. */
export function namesOf(ast) {
  const names = new Set();
  walk(ast, (el) => {
    if (el.type !== LITERAL && el.type !== POUND && typeof el.value === 'string') names.add(el.value);
  });
  return [...names].sort();
}

const blank = (els) => els.every((el) => el.type === LITERAL && !el.value.trim());
/** `{n, plural, other {}}`: a placeholder a language keeps only because English says it (docs/translating.md). */
const unsaid = (el) => Object.keys(el.options).length === 1 && 'other' in el.options && blank(el.options.other.value);

/**
 * The values a run of elements shows, wherever its selects and plurals go: a placeholder, a number,
 * a date, and a plural's # (its argument's number). A select's or a plural's own argument only
 * chooses words, so it shows nothing by itself.
 */
function shownIn(els, plural = null, shown = new Set()) {
  for (const el of els) {
    if (el.type === POUND) {
      if (plural) shown.add(plural);
    } else if (el.type === SELECT || el.type === PLURAL) {
      for (const o of Object.values(el.options)) shownIn(o.value, el.type === PLURAL ? el.value : plural, shown);
    } else if (el.type === TAG) shownIn(el.children, plural, shown);
    else if (el.type !== LITERAL && typeof el.value === 'string') shown.add(el.value);
  }
  return shown;
}
const showsNumber = (els, arg, plural = null) => shownIn(els, plural).has(arg);

/** For each argument: the selects and plurals on it, and each tag with the values it shows. */
function shapeOf(ast) {
  const selects = new Map();
  const plurals = new Map();
  const tags = [];
  walk(ast, (el, parents) => {
    if (el.type === SELECT || el.type === PLURAL) {
      const at = el.type === SELECT ? selects : plurals;
      if (!at.has(el.value)) at.set(el.value, []);
      at.get(el.value).push(el);
    }
    if (el.type === TAG) {
      const parent = [...parents].reverse().find((p) => p.type === TAG);
      const plural = [...parents].reverse().find((p) => p.type === PLURAL);
      tags.push({ name: el.value, shows: shownIn(el.children, plural?.value ?? null), parent: parent?.value ?? '', empty: blank(el.children) });
    }
  });
  return { selects, plurals, tags };
}

const coverCache = new Map();
/** How many whole numbers up to 1000 each of a language's plural categories takes. */
function coverOf(locale, type) {
  const id = `${locale}:${type}`;
  if (!coverCache.has(id)) {
    const rules = new Intl.PluralRules(pluralTag(locale), { type });
    const cover = new Map(rules.resolvedOptions().pluralCategories.map((c) => [c, 0]));
    for (let i = 0; i <= 1000; i++) cover.set(rules.select(i), cover.get(rules.select(i)) + 1);
    coverCache.set(id, cover);
  }
  return coverCache.get(id);
}

const list = (xs) => xs.map((x) => `“${x}”`).join(', ');
const braces = (xs) => `{${[...xs].join(',')}}`;

/**
 * What's wrong with a language's message beside English's, as sentences: empty when it keeps all
 * English must keep. `english` is English's source; `words` the language's.
 */
export function messageProblems(locale, english, words) {
  let ast;
  try {
    ast = astOf(words);
  } catch (e) {
    return [`doesn't parse: ${e.message}`];
  }
  if (locale === 'en') return typographyProblems(locale, ast);
  let enAst;
  try {
    enAst = astOf(english);
  } catch {
    return [];
  }
  const problems = [];
  const [names, enNames] = [namesOf(ast), namesOf(enAst)];
  if (names.join(',') !== enNames.join(',')) problems.push(`names ${braces(names)}, English names ${braces(enNames)}`);
  const [shape, en] = [shapeOf(ast), shapeOf(enAst)];

  // A select's cases: each code English words is worded here too, and no other.
  for (const [arg, enSelects] of en.selects) {
    const cases = new Set(enSelects.flatMap((s) => Object.keys(s.options)));
    const here = shape.selects.get(arg) ?? [];
    if (!here.length && names.includes(arg)) problems.push(`{${arg}} chooses by a code in English (a select): word each of its cases, ${list([...cases])}`);
    for (const s of here) {
      if (unsaid(s)) continue;
      const lost = [...cases].filter((c) => !(c in s.options));
      const extra = Object.keys(s.options).filter((c) => !cases.has(c));
      if (lost.length) problems.push(`{${arg}, select} has lost ${lost.length === 1 ? 'a case' : 'cases'} English has: ${list(lost)}`);
      if (extra.length) problems.push(`{${arg}, select} has ${extra.length === 1 ? 'a case' : 'cases'} English hasn't, which nothing passes: ${list(extra)}`);
    }
  }

  // A plural: the language's own categories, and the number kept wherever English shows it and a
  // category takes more than one number (French's "one" takes 0 and 1).
  for (const [arg, enPlurals] of en.plurals) {
    const here = shape.plurals.get(arg) ?? [];
    const enShows = enPlurals.some((p) => p.options.other && showsNumber(p.options.other.value, arg, arg));
    if (!here.length && names.includes(arg) && enShows && !showsNumber(ast, arg)) {
      problems.push(`{${arg}} is a plural in English that shows its number: keep it a plural with #, or show {${arg}, number}`);
    }
    for (const p of here) {
      const cover = coverOf(locale, p.pluralType === 'ordinal' ? 'ordinal' : 'cardinal');
      const kinds = Object.keys(p.options).filter((c) => !/^=\d+$/.test(c));
      const foreign = kinds.filter((c) => !cover.has(c));
      if (foreign.length) problems.push(`{${arg}, plural} has ${list(foreign)}, which ${languageName(locale)} hasn't: its categories are ${list([...cover.keys()])}`);
      if (unsaid(p) || showsNumber(ast.filter((el) => el !== p), arg)) continue;
      for (const c of kinds) {
        // English's branch for the same numbers: its own "one" for "one", else its "other".
        const enBranch = enPlurals.map((e) => (c === 'one' ? e.options.one : e.options[c] ?? e.options.other)).find(Boolean);
        if (!enBranch || !showsNumber(enBranch.value, arg, arg) || !cover.has(c) || cover.get(c) < 2) continue;
        if (!showsNumber(p.options[c].value, arg, arg)) problems.push(`{${arg}, plural}'s “${c}” has lost #, the number, which English shows: in ${languageName(locale)} “${c}” takes more than one number`);
      }
    }
  }

  // Tags around the same words: each value English's tag shows stays inside it, in the same tag.
  const byName = (tags) => {
    const m = new Map();
    for (const t of tags) {
      const g = m.get(t.name) ?? { shows: new Set(), parents: new Set(), empty: true };
      for (const v of t.shows) g.shows.add(v);
      g.parents.add(t.parent);
      g.empty &&= t.empty;
      m.set(t.name, g);
    }
    return m;
  };
  const [tagsHere, tagsEn] = [byName(shape.tags), byName(en.tags)];
  for (const [name, t] of tagsHere) {
    const e = tagsEn.get(name);
    if (!e) continue;
    const left = [...e.shows].filter((v) => !t.shows.has(v));
    if (left.length) problems.push(`<${name}> no longer holds ${braces(left)}, which English's holds: keep the tag around the same words`);
    const [ps, eps] = [[...t.parents].sort().join(','), [...e.parents].sort().join(',')];
    if (ps !== eps) problems.push(`<${name}> sits ${ps ? `inside <${ps}>` : 'outside any tag'}, where English's ${eps ? `sits inside <${eps}>` : "isn't inside another"}`);
    if (shape.tags.some((x) => x.name === name && x.empty) && !e.empty) problems.push(`<${name}> is empty: put it around the words English's is around`);
  }
  return [...problems, ...typographyProblems(locale, ast)];
}

/**
 * The words a message writes itself, one string per way through its selects and plurals, with each
 * value a4a puts in shown as U+2063 (so a value never reads as punctuation), for typography's rules.
 */
function textsOf(els) {
  let ways = [''];
  for (const el of els) {
    if (el.type === LITERAL) ways = ways.map((w) => w + el.value);
    else if (el.type === TAG) {
      const inner = textsOf(el.children);
      ways = ways.flatMap((w) => inner.map((i) => w + i)).slice(0, 64);
    } else if (el.options) {
      const inner = Object.values(el.options).flatMap((o) => textsOf(o.value));
      ways = ways.flatMap((w) => inner.map((i) => w + i)).slice(0, 64);
    } else ways = ways.map((w) => `${w}⁣`);
  }
  return ways;
}

/**
 * A language's typography, as docs/translating.md gives it, where a machine can tell: each rule a
 * test over the words a message writes itself (a value a4a puts in is never checked).
 */
export const TYPOGRAPHY = [
  { id: 'ellipsis', locales: 'all', test: (s) => /\.\.\./.test(s), says: 'writes “...”, where the ellipsis is one character: “…”' },
  { id: 'exclamation', locales: 'all', test: (s) => /[\p{L}\p{N}]!(\s|$)/u.test(s), says: 'ends a sentence with an exclamation mark, which a4a never writes' },
  { id: 'spaces', locales: 'all', test: (s) => /\S {2,}\S/.test(s), says: 'has two spaces in a row' },
  { id: 'thai-stop', locales: ['th'], test: (s) => /[฀-๿]{3,}\.(\s|$)/.test(s), says: 'ends a Thai sentence with a full stop, where Thai ends one with a space, and its last with nothing' },
  { id: 'thai-particles', locales: ['th'], test: (s) => /ครับ|ค่ะ|กรุณา/.test(s), says: 'says ครับ, ค่ะ or กรุณา: a4a’s Thai has no speaker’s particle, and asks with โปรด' },
  { id: 'spanish-question', locales: ['es'], test: (s) => s.split(/(?<=[.?:])\s/).some((x) => /[\p{L}\p{N}»”)]\?(\s|$)/u.test(x) && !x.includes('¿')), says: 'asks without the opening “¿”' },
  { id: 'german-quotes', locales: ['de'], test: (s) => /[”«»]/.test(s), says: 'quotes with marks other than German’s „…“' },
  { id: 'french-guillemets', locales: ['fr'], test: (s) => /« | »/.test(s), says: 'puts a plain space inside « », where French puts a narrow no-break one (U+202F)' },
  { id: 'french-spaces', locales: ['fr'], test: (s) => / [;:?!]/.test(s), says: 'puts a plain space before ; : ? or !, where French puts a no-break one (U+202F before ; ? !, U+00A0 before :)' },
  { id: 'japanese-quotes', locales: ['ja'], test: (s) => /[“”]/.test(s), says: 'quotes with “…”, where Japanese quotes with 「…」' },
  { id: 'full-width', locales: ['ja', 'zh'], test: (s) => /[぀-ヿ一-鿿][,;:?!]/.test(s), says: 'puts a half-width , ; : ? or ! after its own words, where it writes full-width ones (，；：？！)' },
];

function typographyProblems(locale, ast) {
  const texts = textsOf(ast);
  return TYPOGRAPHY.filter((r) => r.locales === 'all' || r.locales.includes(locale))
    .filter((r) => texts.some((s) => r.test(s)))
    .map((r) => `[${r.id}] ${r.says}`);
}

// ---------------------------------------------------------------------------
// A control's name holds the words it shows (WCAG 2.5.3, docs/translating.md).
// ---------------------------------------------------------------------------

function tsxFiles(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'node_modules' && e.name !== 'dist') tsxFiles(p, out);
    } else if (e.name.endsWith('.tsx')) out.push(p);
  }
  return out;
}

/**
 * The web's controls named by one message and showing another: where a button or a link is named by
 * aria-label={t('a', …)} and shows {t('b')}, the pair [a, b]. The browser suite's axe checks it on
 * the pages it visits, mostly in English; this lets every language be checked.
 */
export function labelPairs(root) {
  const pairs = new Map();
  for (const f of tsxFiles(path.join(root, 'apps/web/src'))) {
    for (const [, nameKey, shownKey] of readFileSync(f, 'utf8').matchAll(/aria-label=\{tr?\('([\w.]+)'[^}]*\}[^>]*>\s*\{tr?\('([\w.]+)'\)\}\s*</g)) {
      pairs.set(`${nameKey} ${shownKey}`, { nameKey, shownKey, file: path.relative(root, f) });
    }
  }
  return [...pairs.values()];
}

const plainWords = (s) => s.replace(/\{[^{}]*\}/g, ' q9q ').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** Why a control's name (`name`) doesn't hold the words it shows (`shown`), or null when it does. */
export function labelProblem(name, shown) {
  if (!name || !shown || /[{}]/.test(shown) || /,\s*(select|plural)\s*,/.test(name)) return null;
  const [n, s] = [plainWords(name), plainWords(shown)];
  if (n.includes(s) || n.replace(/ /g, '').includes(s.replace(/ /g, ''))) return null;
  return `names a control that shows “${shown}”, so it should hold those words whole, in order: “${name}”`;
}
