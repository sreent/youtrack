#!/usr/bin/env node
/**
 * a4a takes its look from Ocean (docs/products.md in sreent/ocean, rule 7): what it needs
 * and Ocean doesn't have is drawn in Ocean first. a4a's own stylesheets keep only its
 * pages' own compositions, under its own selectors.
 *
 * It fails on any rule in a4a's stylesheets but one: `#root`, which lets React's root hold
 * Ocean's frame. Everything else a4a's pages look like, and how they place Ocean's pieces, is
 * Ocean's. Its first report says, for each rule, whether it also styles a selector Ocean's
 * pieces or charts style (one of Ocean's classes, or an element Ocean styles), the check
 * a5s holds itself to in its tests/test_design.py.
 *
 *   node scripts/check-design.mjs            exits 1 and lists each rule, if any
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, '..');
const require = createRequire(join(web, 'package.json'));
const ocean = dirname(require.resolve('@sreent/ocean/components.css'));

/** Style rules as [selector, …] lists, through @media, @container, @supports and @layer. */
function rules(css) {
  css = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  let i = 0;
  const walk = (end) => {
    let start = i;
    while (i < end) {
      const ch = css[i];
      if (ch === ';') {
        start = ++i; // a statement such as @import
      } else if (ch === '{') {
        const prelude = css.slice(start, i).trim();
        let depth = 1;
        let j = i + 1;
        while (j < css.length && depth) {
          if (css[j] === '{') depth++;
          else if (css[j] === '}') depth--;
          j++;
        }
        const bodyEnd = j - 1;
        if (/^@(media|container|supports|layer)\b/.test(prelude)) {
          i++;
          walk(bodyEnd);
        } else if (!prelude.startsWith('@')) {
          out.push(splitSelectors(prelude));
        }
        // @theme, @keyframes, @font-face and the like hold no selectors of a page
        i = j;
        start = i;
      } else {
        i++;
      }
    }
  };
  walk(css.length);
  return out;
}

function splitSelectors(prelude) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const ch of prelude) {
    if (ch === '(' || ch === '[') depth++;
    if (ch === ')' || ch === ']') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

/** The classes and element names a selector names, leaving out attribute values and strings. */
function names(selector) {
  const bare = selector.replace(/\[[^\]]*\]/g, '').replace(/"[^"]*"|'[^']*'/g, '');
  const classes = [...bare.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1]);
  const elements = [...bare.matchAll(/(?:^|[\s>+~(,])([a-z][a-z0-9]*)(?=[.:#[\s>+~),]|$)/g)].map((m) => m[1]);
  return { classes, elements };
}

const oceanClasses = new Set();
const oceanElements = new Set();
for (const file of ['components.css', 'charts.css']) {
  for (const list of rules(readFileSync(join(ocean, file), 'utf8'))) {
    for (const sel of list) {
      const n = names(sel);
      n.classes.forEach((c) => oceanClasses.add(c));
      n.elements.forEach((e) => oceanElements.add(e));
    }
  }
}
for (const e of ['html', 'body']) oceanElements.delete(e); // the frame is Ocean's; a4a never styles them anyway

function cssFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return cssFiles(p);
    return p.endsWith('.css') ? [p] : [];
  });
}

/** The one rule a4a keeps: React's root holds Ocean's frame (body.app's sidebar and page). */
const ALLOWED = new Set(['#root']);

const problems = [];
for (const file of cssFiles(join(web, 'src'))) {
  for (const list of rules(readFileSync(file, 'utf8'))) {
    for (const sel of list) {
      if (ALLOWED.has(sel)) continue;
      const n = names(sel);
      const styles = [...n.classes.filter((c) => oceanClasses.has(c)).map((c) => `.${c}`), ...n.elements.filter((e) => oceanElements.has(e))];
      problems.push({ file: relative(web, file), selector: sel, styles });
    }
  }
}

/**
 * Tailwind places things where Ocean has no say: a grid's columns and spans, order, alignment,
 * gaps and sizes. Never a look (type, colour, borders) and never spacing around a piece, which
 * Ocean's stacks and clusters give. A utility outside that, in any component, is a rule of a4a's own.
 */
const STRUCTURE = [
  /^(grid|inline-grid|flex|inline-flex|contents|hidden|block)$/,
  /^(grid-cols|grid-rows|col-span|col-start|col-end|row-span|row-start|row-end|grid-flow|auto-cols|auto-rows)-/,
  /^(flex-(wrap|nowrap|col|row|1|auto|none|initial)|basis-.+|grow|grow-0|shrink|shrink-0)$/,
  /^(items|justify|justify-items|justify-self|self|content|place-content|place-items|place-self)-/,
  /^-?order-/,
  /^gap(-x|-y)?-/,
  /^(w|h|min-w|min-h|max-w|max-h|size)-/,
];
function sourceFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return /\.(tsx|ts)$/.test(p) ? [p] : [];
  });
}
/** The utility itself, after its variants: `max-[900px]:-order-1` is `-order-1`. */
function utilityOf(cls) {
  let depth = 0;
  let last = 0;
  for (let i = 0; i < cls.length; i++) {
    if (cls[i] === '[') depth++;
    else if (cls[i] === ']') depth--;
    else if (cls[i] === ':' && depth === 0) last = i + 1;
  }
  return cls.slice(last);
}
for (const file of sourceFiles(join(web, 'src'))) {
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/(?<![\w-])tw:([^\s"'`}]+)/g)) {
      const utility = utilityOf(m[1]);
      if (!STRUCTURE.some((re) => re.test(utility))) {
        problems.push({ file: `${relative(web, file)}:${i + 1}`, selector: `tw:${m[1]}`, styles: [], kind: 'utility' });
      }
    }
  });
}

if (problems.length) {
  const ocean = problems.filter((p) => p.styles.length).length;
  console.error(
    `a4a's stylesheets hold ${problems.length} rule${problems.length === 1 ? '' : 's'} of their own, ${ocean} of them restyling Ocean's pieces. Draw what's needed in Ocean instead:\n`,
  );
  for (const p of problems) {
    const why = p.kind === 'utility' ? '   (a look or spacing, not structure: Ocean draws it)' : p.styles.length ? `   (restyles ${p.styles.join(', ')})` : '';
    console.error(`  ${p.file}: ${p.selector}${why}`);
  }
  process.exit(1);
}
console.log(`a4a's stylesheets hold no rules of their own: its look is Ocean's (${oceanClasses.size} classes, ${oceanElements.size} elements).`);
