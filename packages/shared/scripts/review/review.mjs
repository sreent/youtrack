/**
 * A native speaker's read of one language (docs/translating.md, "A native speaker's read"): a sheet
 * to read in an hour, and an import that can't break a catalog.
 *
 * - `exportSheet` writes `<lang>.xlsx`: Start here, Terms (the language's table in translating.md),
 *   Messages (every message, by tier, then where, then key) and Questions (the language's open items
 *   in translation-questions.md).
 * - `importSheet` checks each suggestion as check:words checks a catalog (catalog-rules.mjs), refuses
 *   what changed since the sheet was made, and writes the catalog only if all it applies passes,
 *   under a lock, atomically, and then runs check:words, putting the catalog back if that fails. It
 *   records the read in the language's head in translation-questions.md.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { langTagOf, labelPairs, labelProblem, languageName, listedLocales, messageProblems, readCatalogs } from '../catalog-rules.mjs';
import { READING_PACE, tierOf, wordsIn } from './tiers.mjs';
import { MAX_FILE, STYLE, readWorkbook, writeWorkbook } from './xlsx.mjs';

/** A refusal of the whole import or export, said to the person running it. */
export class ReviewError extends Error {}

export const SHEET = { start: 'Start here', terms: 'Terms', messages: 'Messages', questions: 'Questions' };
/** How far the reader got, as Start here's list offers it and the read's record says it. */
export const HOW_FAR = ['Part of tier 1', 'The terms and tier 1', 'Tiers 1 and 2', 'All three tiers'];
const HEAD = { tier: 'Tier', where: 'Where', key: 'Key', english: 'English', suggestion: 'Your suggestion', note: 'Your note', check: 'Check' };
const QUESTIONS_DOC = 'docs/translation-questions.md';
const RECORD = '**Read by a native speaker:**';

const sha = (s) => createHash('sha256').update(s).digest('hex');
/** A row's fingerprint: whether its key, English or words were changed in the sheet. */
const fingerprint = (key, english, words) => sha(`${key}\u0000${english}\u0000${words}`).slice(0, 12);
const nfc = (s) => String(s ?? '').normalize('NFC');
const day = (d) => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(d);
const minutes = (words) => Math.max(1, Math.round(words / READING_PACE));
const duration = (m) => (m < 90 ? `about ${m} minutes` : `about ${Math.round(m / 30) / 2} hours`);
const plural = (n, one, other) => (new Intl.PluralRules('en').select(n) === 'one' ? `${n} ${one}` : `${n.toLocaleString('en-GB')} ${other}`);

function localeOf(root, locale) {
  const listed = listedLocales(root);
  if (locale === 'en') throw new ReviewError('English is the source: there is no sheet to read for it');
  if (!listed.includes(locale)) throw new ReviewError(`a4a has no catalog “${locale}”: it has ${listed.filter((l) => l !== 'en').join(', ')}`);
  return locale;
}

// ---------------------------------------------------------------------------
// What the docs hold for a language
// ---------------------------------------------------------------------------

/** Markdown's marks off a table cell or a bullet: emphasis, code and links, as a reader sees them. */
const plain = (s) =>
  s
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|[^\w*])\*([^*\s][^*]*)\*(?=[^\w*]|$)/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .trim();

/** The language's terms table in translating.md: [{ english, word }], the word's cell holding why, as the table does. */
export function termsOf(root, locale) {
  const lines = readFileSync(path.join(root, 'docs/translating.md'), 'utf8').split('\n');
  const at = lines.findIndex((l) => l.trim() === `| English | ${languageName(locale)} |`);
  if (at < 0) return [];
  const terms = [];
  for (let i = at + 2; i < lines.length && lines[i].startsWith('|'); i++) {
    const cells = lines[i].replace(/^\||\|\s*$/g, '').split(/(?<!\\)\|/).map((c) => plain(c.replace(/\\\|/g, '|')));
    if (cells.length >= 2 && cells[0]) terms.push({ english: cells[0], word: cells.slice(1).join(' | ') });
  }
  return terms;
}

/** The sections of translation-questions.md, by heading. */
function sectionsOf(md) {
  const sections = new Map();
  let name = null;
  for (const line of md.split('\n')) {
    const h = line.match(/^## (.+)$/);
    if (h) {
      name = h[1].trim();
      sections.set(name, []);
    } else if (name) sections.get(name).push(line);
  }
  return sections;
}

/**
 * The language's open items in translation-questions.md: its own section's bullets (kind from the
 * line before them: "Left for a native speaker:", "Needs the code to change:"), and the bullets of
 * "What a catalog can't say yet" that name it.
 */
export function questionsOf(root, locale, en = {}) {
  const sections = sectionsOf(readFileSync(path.join(root, QUESTIONS_DOC), 'utf8'));
  const name = languageName(locale);
  const keysIn = (s) => [...new Set([...s.matchAll(/`([a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9*]+)+)`/g)].map((m) => m[1]).filter((k) => k in en || k.endsWith('.*')))];
  const items = [];
  let kind = 'Left for a native speaker';
  for (const line of sections.get(name) ?? []) {
    if (/^\S.*:$/.test(line.trim()) && !line.startsWith('-')) kind = line.trim().replace(/:$/, '');
    if (!line.startsWith('- ')) continue;
    const text = line.slice(2);
    items.push({ kind: /^\*\*Needs (the )?code/.test(text) ? 'Needs the code to change' : kind, text: plain(text), keys: keysIn(text) });
  }
  const word = name.split(' ').pop();
  for (const line of sections.get("What a catalog can't say yet") ?? []) {
    const head = line.match(/^- \*\*([^*]+)\*\*/);
    if (head && new RegExp(`\\b${word}`).test(head[1])) items.push({ kind: "What a catalog can't say yet", text: plain(line.slice(2)), keys: keysIn(line) });
  }
  return items;
}

// ---------------------------------------------------------------------------
// The sheet, made
// ---------------------------------------------------------------------------

/** A short message of the catalog's, as an example of what a reader keeps: English, then the language's (tier 1's first). */
function exampleOf(rows, test) {
  const fits = rows.filter((r) => r.english === r.english.trim() && r.words === r.words.trim() && r.english.length < 90 && test(r.english));
  const found = fits.sort((a, b) => a.tier - b.tier || a.english.length - b.english.length || (a.key < b.key ? -1 : 1))[0];
  return found ? `“${found.english}”, now “${found.words}”` : null;
}

/**
 * Writes the sheet for `locale` to `out` (a directory, or a path ending in .xlsx), and returns what
 * it holds. `now` is when the sheet is made: the import refuses rows changed since.
 */
export async function exportSheet({ root, locale, out, now = new Date() }) {
  localeOf(root, locale);
  const catalogs = readCatalogs(root);
  const en = catalogs.en;
  const words = catalogs[locale];
  const name = languageName(locale);
  const made = new Date(Math.floor(now.getTime() / 1000) * 1000);
  const id = `r${sha(`${locale}\n${made.toISOString()}\n${sha(JSON.stringify(en))}\n${sha(JSON.stringify(words))}`).slice(0, 9)}`;

  const rows = Object.keys(en)
    .map((key) => ({ key, ...tierOf(key), english: en[key], words: words[key] ?? '' }))
    .sort((a, b) => a.tier - b.tier || a.rank - b.rank || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const tiers = [1, 2, 3].map((t) => {
    const of = rows.filter((r) => r.tier === t);
    return { tier: t, messages: of.length, words: of.reduce((n, r) => n + wordsIn(r.english), 0) };
  });
  const terms = termsOf(root, locale);
  const questions = questionsOf(root, locale, en);

  const t = (v, s = STYLE.text) => ({ v, s });
  const examples = [
    ['A value a4a puts in, such as {name}, stays as it is, spelled the same', exampleOf(rows, (e) => /^[^{}<]*\{name\}[^{}<]*$/.test(e) && /[a-z]{3}/.test(e))],
    ['{count, plural, …} chooses words by a number: keep “{count, plural,”, the braces and each category before a brace, word each case, and keep # (the number)', exampleOf(rows, (e) => /^\{\w+, plural, one \{# [^{}]+\} other \{# [^{}]+\}\}$/.test(e))],
    ['{who, select, …} chooses by a code: keep each code before a brace (you, other) and word what is inside', exampleOf(rows, (e) => /^[^{}<]*\{\w+, select,( \w+ \{[^{}<]+\})+\}[^{}<]*$/.test(e))],
    ['<b>…</b> and <t0>…</t0> mark words a page shows in bold or as a link: keep each mark around the words that mean the same', exampleOf(rows, (e) => /^[^{}]*<(b|t0)>[^<{]*[a-z]{3}[^<{]*<\/\1>[^{}]*$/.test(e))],
  ].map(([what, ex]) => (ex ? `${what}: ${ex}.` : `${what}.`));
  const termMinutes = Math.max(5, Math.round(terms.length / 4));
  const start = [
    [t(`a4a in ${name}: a native speaker's read`, STYLE.title)],
    [],
    [
      t('What we ask', STYLE.label),
      t(
        `a4a's ${name} was written and edited by language models, not by people who speak ${name}. Read it as someone who uses software in ${name} every day, and say where it reads wrong, stiff or unclear, or where a word isn't the one people use. Where it reads right, leave it: that tells us as much.`,
      ),
    ],
    [
      t('In this order', STYLE.label),
      t(
        `1. Terms: the words a4a chose for its own terms (issue, request, board…). One term fixed fixes every message that uses it.\n2. Messages, tier 1: what most people see most, and what customers see. Then tiers 2 and 3, if you have time.\n3. Questions: ${questions.length ? `${plural(questions.length, 'choice', 'choices')} left for a native speaker's ear, and one about the whole` : 'one about the whole'}.`,
      ),
    ],
    [
      t('How long', STYLE.label),
      t(
        [
          `Terms: ${plural(terms.length, 'term', 'terms')}, ${duration(termMinutes)}.`,
          ...tiers.map((x) => `Tier ${x.tier}: ${plural(x.messages, 'message', 'messages')}, ${duration(minutes(x.words))}.`),
          'The terms and tier 1 make a first read; the questions take a few minutes more.',
        ].join('\n'),
      ),
    ],
    [
      t('How to suggest', STYLE.label),
      t(
        'Write your words under Your suggestion, beside the message they would replace, and leave it empty where the words are right. Use Your note for why, or for a question. On Terms, write a better word under A better word: an editor then changes the term everywhere, with the messages that use it.\nThe other cells are locked so a slip can’t change them. If your app asks, you can unlock them, and nothing breaks.',
      ),
    ],
    [t('Keep as they are', STYLE.label), t(`What a4a puts in or acts on stays as English has it; the words around it are yours.\n${examples.join('\n')}`)],
    [t('Spaces', STYLE.label), t('A space at a message’s start or end joins it to the words beside it, so it stays as it is: you needn’t type it.')],
    [t('Send it back', STYLE.label), t('Save it as .xlsx, as it came (Numbers: File › Export To › Excel; Google Sheets: File › Download › Microsoft Excel), and send it to whoever sent it to you. Not as CSV, which can lose your letters.')],
    [],
    [t('How far you read', STYLE.label), { v: '', s: STYLE.field }],
    [t('', STYLE.text), t(`Choose from the list: ${HOW_FAR.join(', ')}.`, STYLE.small)],
    [],
    [t('About this sheet', STYLE.label)],
    [t('Language', STYLE.text), t(locale)],
    [t('Made', STYLE.text), t(made.toISOString().replace('.000Z', 'Z'))],
    [t('Sheet', STYLE.text), t(id)],
    [t('Catalog', STYLE.text), t(plural(rows.length, 'message', 'messages'))],
  ];
  const howFarRow = start.findIndex((r) => r[0]?.v === 'How far you read') + 1;

  const termRows = [
    [t(HEAD.english, STYLE.head), t(`${name}: a4a's word, and why`, STYLE.head), t('A better word', STYLE.head), t(HEAD.note, STYLE.head)],
    ...terms.map((x) => [t(x.english, STYLE.english), t(x.word, STYLE.words), { v: '', s: STYLE.wordsInput }, { v: '', s: STYLE.input }]),
  ];
  const messageRows = [
    [HEAD.tier, HEAD.where, HEAD.key, HEAD.english, `${name} now`, HEAD.suggestion, HEAD.note, HEAD.check].map((h) => t(h, STYLE.head)),
    ...rows.map((r) => [
      { v: r.tier, s: STYLE.tier },
      t(r.where),
      t(r.key, STYLE.key),
      t(r.english, STYLE.english),
      t(r.words, STYLE.words),
      { v: '', s: STYLE.input },
      { v: '', s: STYLE.input },
      t(fingerprint(r.key, r.english, r.words), STYLE.small),
    ]),
  ];
  const questionRows = [
    [t('Kind', STYLE.head), t('Question', STYLE.head), t('Keys it names', STYLE.head), t('Your answer', STYLE.head)],
    ...questions.map((q) => [t(q.kind), t(q.text, STYLE.english), t(q.keys.join('\n'), STYLE.key), { v: '', s: STYLE.wordsInput }]),
    [t('Anything else'), t(`Anything else you'd tell us about a4a's ${name}: its voice, how formal it is, a word that keeps reading wrong?`, STYLE.english), t(''), { v: '', s: STYLE.wordsInput }],
  ];
  const buf = writeWorkbook({
    locale,
    langTag: langTagOf(locale),
    title: `a4a in ${name}: a native speaker's read`,
    made,
    sheets: [
      { name: SHEET.start, cols: [{ width: 20 }, { width: 110 }], rows: start, protect: true, active: true, fit: true, select: `B${howFarRow}`, lists: [{ ref: `B${howFarRow}`, items: HOW_FAR }] },
      { name: SHEET.terms, cols: [{ width: 34 }, { width: 62 }, { width: 30 }, { width: 40 }], rows: termRows, freeze: 1, filter: `A1:D${termRows.length}`, protect: true, fit: true, select: 'C2' },
      {
        name: SHEET.messages,
        cols: [{ width: 6 }, { width: 18 }, { width: 30 }, { width: 46 }, { width: 46 }, { width: 46 }, { width: 30 }, { width: 14, hidden: true }],
        rows: messageRows,
        freeze: 1,
        filter: `A1:H${messageRows.length}`,
        protect: true,
        fit: true,
        select: 'F2',
      },
      { name: SHEET.questions, cols: [{ width: 24 }, { width: 80 }, { width: 30 }, { width: 60 }], rows: questionRows, freeze: 1, protect: true, fit: true, select: 'D2' },
    ],
  });
  const file = out.endsWith('.xlsx') ? out : path.join(out, `${locale}.xlsx`);
  await writeFile(file, buf);
  return { file, id, locale, made, tiers, terms: terms.length, questions: questions.length, bytes: buf.length };
}

// ---------------------------------------------------------------------------
// The sheet, brought back
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

/**
 * One import at a time, across processes: a lock file beside the catalogs, made with O_EXCL. One
 * whose process is gone is taken over; a live one is waited for, up to `wait` ms, which leaves it
 * time to run check:words.
 */
async function withLock(root, fn, wait = 180000) {
  const lock = path.join(root, 'packages/shared/i18n/.review.lock');
  const until = Date.now() + wait;
  for (;;) {
    try {
      const h = await open(lock, 'wx');
      await h.writeFile(JSON.stringify({ pid: process.pid, since: new Date().toISOString() }));
      await h.close();
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let holder = null;
      try {
        holder = JSON.parse(await readFile(lock, 'utf8'));
      } catch {
        // Made but not yet written, or cut short: stale once it's older than a few seconds.
        const s = await stat(lock).catch(() => null);
        if (s && Date.now() - s.mtimeMs > 5000) await unlink(lock).catch(() => {});
      }
      if (holder?.pid && !alive(holder.pid)) await unlink(lock).catch(() => {});
      else if (Date.now() > until) throw new ReviewError(`another import is running${holder?.pid ? ` (process ${holder.pid})` : ''}. If none is, remove ${path.relative(root, lock)}`);
      else await sleep(20);
    }
  }
  try {
    return await fn();
  } finally {
    await unlink(lock).catch(() => {});
  }
}

/** Writes a file whole or not at all: a temporary file beside it, then a rename over it. */
async function writeWhole(file, data) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Math.random().toString(36).slice(2)}.review-tmp`);
  await writeFile(tmp, data);
  await rename(tmp, file).catch(async (e) => {
    await unlink(tmp).catch(() => {});
    throw e;
  });
}

/** A catalog as its file holds it: JSON with two spaces, one message a line, and a last newline. */
export const catalogText = (messages) => `${JSON.stringify(messages, null, 2)}\n`;

/** Runs the web's check:words over the tree at `root`: { ok, output }. */
export function checkWords(root) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(root, 'apps/web/scripts/check-words.mjs')], { cwd: root, env: { ...process.env, CHECK_WORDS_ROOT: root } });
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    child.on('error', (e) => resolve({ ok: false, output: e.message }));
    child.on('close', (code) => resolve({ ok: code === 0, output: output.trim() }));
  });
}

/** Characters nobody can see, which a sheet's cell can carry in from a paste: never brought into a catalog. */
const INVISIBLE = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/u;
const LINKS = /https?:\/\/[^\s<>{}"]+|www\.[^\s<>{}"]+|[\w.+-]+@[\w-]+(?:\.[\w-]+)+/gi;

/** Why a suggestion can't be taken whatever its words: a size, a character or a link it shouldn't bring. */
function unsafe(suggestion, english, words) {
  const why = [];
  const cap = Math.max(400, english.length * 4);
  if (suggestion.length > cap) why.push(`it's ${suggestion.length} characters, where English is ${english.length}: say it in fewer, or write it as a note`);
  const odd = suggestion.match(INVISIBLE);
  if (odd && !english.includes(odd[0]) && !words.includes(odd[0])) why.push(`it holds a character nobody sees (U+${odd[0].codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}), most likely from a paste: type it again`);
  if (suggestion.includes('\n') && !english.includes('\n')) why.push('it breaks a line, where English is one line: write it on one');
  const known = new Set([...(english.match(LINKS) ?? []), ...(words.match(LINKS) ?? [])]);
  const added = (suggestion.match(LINKS) ?? []).filter((l) => !known.has(l));
  if (added.length) why.push(`it adds ${added.length === 1 ? 'a link or an address' : 'links or addresses'} English hasn't (${added.join(', ')}): a4a's words link nowhere English doesn't`);
  return why;
}

/** The sheet's rows, by the head's names: [{ row, cells }] with each column found by its head, wherever it moved. */
function table(sheet, wanted) {
  if (!sheet) return null;
  const rowNumbers = [...sheet.rows.keys()].sort((a, b) => a - b);
  for (const r of rowNumbers.slice(0, 5)) {
    const head = sheet.rows.get(r);
    const at = {};
    for (const [c, text] of head) for (const [id, test] of Object.entries(wanted)) if (at[id] === undefined && test(nfc(text).trim().toLowerCase())) at[id] = c;
    if (Object.keys(at).length >= 2) {
      return rowNumbers.filter((n) => n > r).map((n) => ({ row: n, get: (id) => (at[id] === undefined ? '' : nfc(sheet.rows.get(n).get(at[id]) ?? '')) }));
    }
  }
  return null;
}

const sheetNamed = (wb, name, test) => wb.sheets.find((s) => s.name === name) ?? wb.sheets.find(test);
const headHas = (s, text) => [...s.rows.values()].slice(0, 5).some((r) => [...r.values()].some((v) => nfc(v).trim().toLowerCase() === text));

/** The words the reader can't see at a message's ends, put back: a space that joins it to the words beside it. */
function keepEdges(suggestion, words) {
  const body = suggestion.replace(/\r\n?/g, '\n').trim();
  if (!words.trim()) return body;
  return `${words.match(/^\s*/)[0]}${body}${words.match(/\s*$/)[0]}`;
}

/** The first form a terms table's cell gives (before its why), to find the messages that use it. */
function firstForm(word) {
  return word
    .split(/[,;:(]| as | never | not /)[0]
    .replace(/[“”"«»„「」*]/g, '')
    .trim();
}

/**
 * Brings a sheet back into its catalog. Returns what it applied and refused, the reader's notes,
 * answers and better terms, and the read's record. `dryRun` writes nothing; `reader` is a name for
 * the record, only if the owner gives one; `check` runs check:words after the write (the CLI's is
 * the real one); `hooks.beforeWrite` lets a test hold an import between its read and its write.
 */
export async function importSheet({ root, file, dryRun = false, reader = null, now = new Date(), check = checkWords, hooks = {} }) {
  const size = (await stat(file).catch(() => null))?.size;
  if (size === undefined) throw new ReviewError(`there's no file at ${file}`);
  if (size > MAX_FILE) throw new ReviewError(`${path.basename(file)} is ${Math.round(size / 1048576)} MB, and a sheet is at most ${MAX_FILE / 1048576} MB`);
  let wb;
  try {
    wb = readWorkbook(await readFile(file));
  } catch (e) {
    throw new ReviewError(`${path.basename(file)} can't be read as a sheet: ${e.message}`);
  }
  const startSheet = sheetNamed(wb, SHEET.start, (s) => [...s.rows.values()].some((r) => r.get(0) === 'About this sheet'));
  const about = new Map();
  for (const r of startSheet?.rows.values() ?? []) if (r.get(0)) about.set(nfc(r.get(0)).trim(), nfc(r.get(1) ?? '').trim());
  const locale = about.get('Language');
  const sheetId = about.get('Sheet');
  const made = new Date(about.get('Made') ?? '');
  if (!locale || !sheetId || Number.isNaN(made.getTime())) {
    throw new ReviewError(`${path.basename(file)} isn't an a4a review sheet, or its rows under “About this sheet” (Language, Made, Sheet) were changed: make one with “pnpm i18n:review export <lang>”`);
  }
  localeOf(root, locale);
  const messages = table(sheetNamed(wb, SHEET.messages, (s) => headHas(s, 'your suggestion')), {
    key: (h) => h === 'key',
    english: (h) => h === 'english',
    words: (h) => h.endsWith(' now'),
    suggestion: (h) => h === 'your suggestion',
    note: (h) => h === 'your note',
    check: (h) => h === 'check',
  });
  if (!messages) throw new ReviewError(`${path.basename(file)} has no Messages sheet with its head (Key, English, Your suggestion) in its first rows`);

  const run = async () => {
    const catalogs = readCatalogs(root);
    const en = catalogs.en;
    const target = path.join(root, 'packages/shared/i18n', `${locale}.json`);
    const before = await readFile(target, 'utf8');
    const words = JSON.parse(before);
    const report = { locale, sheetId, made, applied: [], already: [], refused: [], notes: [], answers: [], terms: [], howFar: about.get('How far you read') || null, record: null, wrote: false, checked: null };

    // Each row, by its key: a key twice with two suggestions is refused, the same one twice is one.
    const byKey = new Map();
    for (const r of messages) {
      const key = r.get('key').trim();
      if (!key) continue;
      const row = { key, row: r.row, english: r.get('english'), words: r.get('words'), suggestion: r.get('suggestion'), note: r.get('note').trim(), check: r.get('check').trim() };
      if (row.note) report.notes.push({ key, english: en[key] ?? row.english, words: words[key] ?? row.words, note: row.note });
      if (!row.suggestion.trim()) continue;
      const seen = byKey.get(key);
      if (seen && seen.suggestion.trim() !== row.suggestion.trim()) seen.twice = true;
      else if (!seen) byKey.set(key, row);
    }
    const pairs = labelPairs(root);
    const next = { ...words };
    for (const row of byKey.values()) {
      const refuse = (...why) => report.refused.push({ key: row.key, row: row.row, suggestion: row.suggestion, why });
      if (row.twice) {
        refuse('the sheet gives it two different suggestions: keep one');
        continue;
      }
      if (!(row.key in en)) {
        refuse('no message has this key (the sheet may be older than a change that removed it)');
        continue;
      }
      if (row.check && row.check !== fingerprint(row.key, row.english, row.words)) {
        refuse('its English or its words were changed in the sheet itself: put the change under Your suggestion, and leave the other cells as they came');
        continue;
      }
      const suggestion = keepEdges(nfc(row.suggestion), nfc(words[row.key]));
      if (nfc(row.english) !== nfc(en[row.key])) {
        refuse(`changed since this sheet was made: read it again. English now says “${en[row.key]}”`);
        continue;
      }
      if (nfc(row.words) !== nfc(words[row.key])) {
        if (nfc(words[row.key]) === suggestion) report.already.push(row.key);
        else refuse(`changed since this sheet was made: read it again. ${languageName(locale)} now says “${words[row.key]}”`);
        continue;
      }
      if (suggestion === nfc(words[row.key])) continue;
      const why = [...unsafe(suggestion, en[row.key], words[row.key]), ...messageProblems(locale, en[row.key], suggestion)];
      if (why.length) {
        refuse(...why);
        continue;
      }
      next[row.key] = suggestion;
      report.applied.push({ key: row.key, row: row.row, before: words[row.key], after: suggestion });
    }

    // A control's name and the words it shows are two messages, so a pair is checked with every
    // suggestion in place (a reader may change both, together), and what still breaks one is put
    // back, until none does.
    for (let changed = true; changed; ) {
      changed = false;
      for (const p of pairs) {
        const touched = report.applied.filter((a) => a.key === p.nameKey || a.key === p.shownKey);
        const said = touched.length && labelProblem(next[p.nameKey], next[p.shownKey]);
        if (!said) continue;
        for (const a of touched) {
          report.applied.splice(report.applied.indexOf(a), 1);
          next[a.key] = words[a.key];
          const both = touched.length > 1 ? `, with the suggestion for ${a.key === p.nameKey ? p.shownKey : p.nameKey}` : '';
          report.refused.push({ key: a.key, row: a.row, suggestion: a.after, why: [`a control is named by ${p.nameKey} and shows ${p.shownKey}${both}: ${said}`] });
        }
        changed = true;
      }
    }

    // The reader's answers, better terms and how far they read.
    const questions = table(sheetNamed(wb, SHEET.questions, (s) => headHas(s, 'your answer')), { kind: (h) => h === 'kind', question: (h) => h === 'question', answer: (h) => h === 'your answer' });
    for (const q of questions ?? []) if (q.get('answer').trim()) report.answers.push({ kind: q.get('kind'), question: q.get('question'), answer: q.get('answer').trim() });
    const terms = table(sheetNamed(wb, SHEET.terms, (s) => headHas(s, 'a better word')), { english: (h) => h === 'english', word: (h) => h.endsWith("a4a's word, and why"), better: (h) => h === 'a better word', note: (h) => h === 'your note' });
    for (const x of terms ?? []) {
      if (!x.get('better').trim() && !x.get('note').trim()) continue;
      const form = firstForm(x.get('word')).toLocaleLowerCase(langTagOf(locale));
      const using = form ? Object.keys(next).filter((k) => nfc(next[k]).toLocaleLowerCase(langTagOf(locale)).includes(form)) : [];
      report.terms.push({ english: x.get('english'), word: x.get('word'), form, better: x.get('better').trim(), note: x.get('note').trim(), messages: using });
    }

    // The whole catalog as it would be, by check:words' rules: written only if every message passes.
    if (report.applied.length) {
      const broken = Object.keys(en).flatMap((k) => (k in next ? messageProblems(locale, en[k], next[k]).map((p) => `${k}: ${p}`) : [`${k}: missing`]));
      for (const p of pairs) {
        const said = labelProblem(next[p.nameKey], next[p.shownKey]);
        if (said) broken.push(`${p.nameKey}: ${said}`);
      }
      if (broken.length) throw new ReviewError(`the catalog wouldn't pass check:words, so nothing was written:\n${broken.slice(0, 20).join('\n')}`);
    }

    // The read, recorded in the language's head, once per sheet.
    const filled = report.applied.length + report.already.length + report.notes.length + report.answers.length + report.terms.length > 0 || report.howFar;
    const docFile = path.join(root, QUESTIONS_DOC);
    const docBefore = await readFile(docFile, 'utf8');
    const docAfter = filled ? recordRead(docBefore, { locale, sheetId, made, now, reader, howFar: report.howFar, changes: report.applied.length + report.already.length, newChanges: report.applied.length, report }) : docBefore;
    report.record = docAfter === docBefore ? null : docAfter.split('\n').find((l) => l.includes(sheetId)) ?? null;
    if (dryRun || (!report.applied.length && docAfter === docBefore)) return report;

    await hooks.beforeWrite?.(report);
    if (report.applied.length) {
      if ((await readFile(target, 'utf8')) !== before) throw new ReviewError(`${locale}.json changed while this import ran (an editor saved it?): nothing was written. Run the import again`);
      await writeWhole(target, catalogText(next));
      report.wrote = true;
      report.checked = await check(root);
      if (!report.checked.ok) {
        const said = report.checked.output.split('\n').slice(0, 30).join('\n');
        // Put back only what this import wrote: a save by someone else since stays theirs.
        if ((await readFile(target, 'utf8')) !== catalogText(next)) throw new ReviewError(`check:words failed after the write, and ${locale}.json was saved by someone else since, so it's left as they saved it. It said:\n${said}`);
        await writeWhole(target, before);
        report.wrote = false;
        throw new ReviewError(`check:words failed after the write, so ${locale}.json is as it was, and nothing was recorded. It said:\n${said}`);
      }
    }
    if (docAfter !== docBefore) await writeWhole(docFile, docAfter);
    return report;
  };
  return dryRun ? run() : withLock(root, run);
}

/**
 * The language's head in translation-questions.md says who read it, how far and when, a sentence
 * per sheet: "The terms and tier 1, from a sheet made on 25 November 2026, brought back on 2 December
 * 2026, by Ana Silva: 14 changes (sheet `r3f9a1c2b`)." A sheet already recorded is left as it was,
 * unless this import changed more.
 */
export function recordRead(doc, { locale, sheetId, made, now, reader, howFar, changes, newChanges, report }) {
  const lines = doc.split('\n');
  const heading = lines.findIndex((l) => l.trim() === `## ${languageName(locale)}`);
  if (heading < 0) return doc;
  let end = lines.findIndex((l, i) => i > heading && l.startsWith('## '));
  if (end < 0) end = lines.length;
  let at = lines.findIndex((l, i) => i > heading && i < end && l.startsWith(RECORD));
  if (at < 0) {
    lines.splice(heading + 1, 0, '', `${RECORD} not yet.`);
    at = heading + 2;
  }
  const said = lines[at].slice(RECORD.length).trim();
  const sentences = said === 'not yet.' ? [] : said.split(/(?<=\(sheet `[^`]+`\)\.)\s+/).filter(Boolean);
  const mine = sentences.findIndex((s) => s.includes(`(sheet \`${sheetId}\`)`));
  if (mine >= 0 && !newChanges) return doc;
  const deepest = Math.max(0, ...[...report.applied, ...report.notes.map((n) => ({ key: n.key }))].map((x) => tierOf(x.key).tier));
  const far = howFar && HOW_FAR.includes(howFar) ? howFar : deepest ? `As far as tier ${deepest} at least (how far wasn't said)` : 'The terms or the questions (how far wasn’t said)';
  const name = reader ? reader.replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069`*_[\]<>|\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) : '';
  const by = name ? `, by ${name}` : '';
  const counted = changes === 0 ? 'no changes' : plural(changes, 'change', 'changes');
  const sentence = `${far}, from a sheet made on ${day(made)}, brought back on ${day(now)}${by}: ${counted} (sheet \`${sheetId}\`).`;
  if (mine >= 0) sentences[mine] = sentence;
  else sentences.push(sentence);
  lines[at] = `${RECORD} ${sentences.join(' ')}`;
  return lines.join('\n');
}
