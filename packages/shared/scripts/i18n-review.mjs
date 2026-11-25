#!/usr/bin/env node
/**
 * A native speaker's read (docs/translating.md):
 *
 *   pnpm i18n:review export <lang|all> [--out <folder, or file.xlsx>]
 *   pnpm i18n:review import <file.xlsx> [--dry-run] [--reader "<name>"]
 *
 * export writes <lang>.xlsx; import checks each suggestion as check:words checks a catalog and
 * writes what passes. It exits 0 when everything was taken, 2 when some rows were refused (the
 * rest taken), and 1 when nothing could be: a file it can't read, or a catalog that wouldn't pass.
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { languageName, listedLocales } from './catalog-rules.mjs';
import { ReviewError, exportSheet, importSheet } from './review/review.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const here = process.env.INIT_CWD || process.cwd();
const [command, subject, ...rest] = process.argv.slice(2);
const flag = (name) => {
  const i = rest.indexOf(name);
  return i < 0 ? null : (rest[i + 1] ?? '');
};
const usage = 'Usage:\n  pnpm i18n:review export <lang|all> [--out <folder, or file.xlsx>]\n  pnpm i18n:review import <file.xlsx> [--dry-run] [--reader "<name>"]';
/** What a sheet's reader wrote, made safe for a terminal: a control or a direction mark is shown, never sent. */
const shown = (s) => String(s).replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩]/g, (c) => `<U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}>`);
const quote = (s) => `“${shown(s).replace(/\n/g, '⏎')}”`;
const indent = (s) => shown(s).split('\n').join('\n      ');

async function main() {
  if (command === 'export' && subject) {
    const locales = subject === 'all' ? listedLocales(root).filter((l) => l !== 'en') : [subject];
    const out = path.resolve(here, flag('--out') ?? '.');
    if (!out.endsWith('.xlsx')) await mkdir(out, { recursive: true });
    else if (locales.length > 1) throw new ReviewError('--out names one file, and “all” makes one sheet per language: give a folder');
    for (const locale of locales) {
      const made = await exportSheet({ root, locale, out });
      const tiers = made.tiers.map((t) => `tier ${t.tier} ${t.messages} (${t.words} words)`).join(', ');
      const shown = path.relative(here, made.file);
      const open = new Intl.PluralRules('en').select(made.questions) === 'one' ? 'open question' : 'open questions';
      console.log(`${shown.startsWith('..') ? made.file : shown}: ${languageName(locale)}, sheet ${made.id}. ${made.terms} terms; ${tiers}; ${made.questions} ${open}.`);
    }
    return 0;
  }
  if (command === 'import' && subject) {
    const dryRun = rest.includes('--dry-run');
    const reader = flag('--reader');
    const r = await importSheet({ root, file: path.resolve(here, subject), dryRun, reader: reader || null });
    const name = languageName(r.locale);
    console.log(`${name}, sheet ${r.sheetId} made ${r.made.toISOString()}${dryRun ? ' (a dry run: nothing is written)' : ''}:`);
    console.log(`  ${r.applied.length} ${dryRun ? 'would be applied' : 'applied'}, ${r.refused.length} refused, ${r.already.length} already in the catalog.`);
    if (r.applied.length) {
      console.log(`\n${dryRun ? 'Would apply' : 'Applied'}:`);
      for (const a of r.applied) console.log(`  ${a.key}\n      ${indent(quote(a.before))}\n    → ${indent(quote(a.after))}`);
    }
    if (r.refused.length) {
      console.log('\nRefused (the catalog keeps its words):');
      for (const x of r.refused) console.log(`  ${shown(x.key)}${x.row ? ` (row ${x.row})` : ''}: ${quote(x.suggestion)}\n      ${x.why.map(indent).join('\n      ')}`);
    }
    if (r.notes.length) {
      console.log("\nThe reader's notes:");
      for (const n of r.notes) console.log(`  ${n.key} (${quote(n.words)}): ${indent(n.note)}`);
    }
    if (r.answers.length) {
      console.log("\nThe reader's answers:");
      for (const a of r.answers) console.log(`  ${shown(a.kind)}: ${indent(a.question)}\n    → ${indent(a.answer)}`);
    }
    if (r.terms.length) {
      console.log('\nBetter terms (change them by hand, with the terms table in docs/translating.md):');
      for (const t of r.terms) {
        const prefixes = new Map();
        for (const k of t.messages) prefixes.set(k.split('.').slice(0, 2).join('.'), (prefixes.get(k.split('.').slice(0, 2).join('.')) ?? 0) + 1);
        console.log(`  ${shown(t.english)}: now ${quote(t.word)}${t.better ? `, better ${quote(t.better)}` : ''}${t.note ? `\n      ${indent(t.note)}` : ''}`);
        console.log(`      ${t.messages.length} messages say ${quote(t.form)}${prefixes.size ? `: ${[...prefixes].map(([p, n]) => `${p} (${n})`).join(', ')}` : ''}`);
      }
    }
    if (r.record) console.log(`\n${dryRun ? 'Would record' : 'Recorded'} in docs/translation-questions.md:\n  ${r.record}`);
    if (r.checked) console.log(`\ncheck:words: ${r.checked.ok ? 'passed' : 'failed'}.`);
    return r.refused.length ? 2 : 0;
  }
  console.error(usage);
  return 1;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e instanceof ReviewError ? `Nothing was changed: ${e.message}` : e.stack);
    process.exit(1);
  },
);
