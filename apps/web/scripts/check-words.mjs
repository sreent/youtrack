#!/usr/bin/env node
/**
 * a4a's words are in its catalogs, not in its code (docs/architecture.md, D49). This check fails when:
 *   - a catalog lacks a key English has, has one English lacks, or a message doesn't parse;
 *   - a translation names other placeholders or tags than English's message;
 *   - code says a key no catalog has, or a catalog keeps a key nothing says;
 *   - words are written straight into the web app's JSX (text, or an attribute a person reads), or
 *     into what a page says from code (a status line, a label in a ternary).
 * A string that only looks like words (a query, a field's name kept as data) says so with a
 * `// not words` comment on its line or the one above.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const require = createRequire(import.meta.url);
const ts = require('typescript');
const { IntlMessageFormat } = require(require.resolve('intl-messageformat', { paths: [path.join(root, 'packages/shared')] }));

const problems = [];
const say = (where, what) => problems.push(`${where}: ${what}`);

// ---------------------------------------------------------------------------
// The catalogs
// ---------------------------------------------------------------------------
const catalogDir = path.join(root, 'packages/shared/i18n');
const catalogs = Object.fromEntries(
  readdirSync(catalogDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => [f.replace(/\.json$/, ''), JSON.parse(readFileSync(path.join(catalogDir, f), 'utf8'))]),
);
const en = catalogs.en;
if (!en) throw new Error('packages/shared/i18n/en.json is missing');
const localesTs = readFileSync(path.join(root, 'packages/shared/src/i18n.ts'), 'utf8');
const listed = JSON.parse(localesTs.match(/export const LOCALES = (\[[^\]]*\])/)[1].replace(/'/g, '"'));
for (const l of listed) if (!catalogs[l]) say(`LOCALES`, `${l} is listed, but packages/shared/i18n/${l}.json is missing`);
for (const l of Object.keys(catalogs)) if (!listed.includes(l)) say(`i18n/${l}.json`, `isn't in LOCALES (packages/shared/src/i18n.ts)`);

function argumentsOf(source, where) {
  try {
    const names = new Set();
    const walk = (els) => {
      for (const el of els) {
        if (el.type !== 0 && el.type !== 7 && typeof el.value === 'string') names.add(el.value);
        if (el.options) for (const o of Object.values(el.options)) walk(o.value);
        if (el.children) walk(el.children);
      }
    };
    walk(new IntlMessageFormat(source, 'en').getAst());
    return [...names].sort().join(',');
  } catch (e) {
    say(where, `doesn't parse: ${e.message}`);
    return null;
  }
}
const enArgs = Object.fromEntries(Object.entries(en).map(([k, v]) => [k, argumentsOf(v, `en ${k}`)]));
for (const [locale, messages] of Object.entries(catalogs)) {
  if (locale === 'en') continue;
  for (const k of Object.keys(en)) if (!(k in messages)) say(`${locale}.json`, `lacks ${k}`);
  for (const [k, v] of Object.entries(messages)) {
    if (!(k in en)) {
      say(`${locale}.json`, `has ${k}, which English hasn't`);
      continue;
    }
    const args = argumentsOf(v, `${locale} ${k}`);
    if (args !== null && enArgs[k] !== null && args !== enArgs[k]) say(`${locale}.json ${k}`, `names {${args}}, English names {${enArgs[k]}}`);
  }
}

// ---------------------------------------------------------------------------
// What code says: keys used, and words left in it
// ---------------------------------------------------------------------------
const KEY = /^[a-z][A-Za-z0-9]*(\.[A-Za-z0-9]+)+$/;
/** Keys made from a value (a problem's code, an enum's name): used though no literal names them. */
const DYNAMIC = ['problem.', 'enum.', 'server.notify.because.'];
const used = new Set();

function walkDir(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'node_modules' && e.name !== 'dist') walkDir(p, out);
    } else if (/\.(tsx?|mts)$/.test(e.name) && !/\.d\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

const NON_TEXT_ATTR = new Set(['className', 'id', 'type', 'role', 'href', 'to', 'key', 'name', 'value', 'defaultValue', 'htmlFor', 'rel', 'target', 'method', 'action', 'autoComplete', 'inputMode', 'pattern', 'src', 'tone', 'kind', 'variant', 'size', 'icon', 'mode', 'path', 'aria-live', 'aria-current', 'aria-haspopup', 'aria-controls', 'aria-labelledby', 'aria-describedby', 'aria-owns', 'aria-activedescendant', 'aria-autocomplete', 'aria-sort', 'aria-orientation', 'aria-checked', 'aria-pressed', 'aria-expanded', 'aria-hidden', 'aria-invalid', 'aria-required', 'aria-disabled', 'aria-selected', 'loading', 'decoding', 'dir', 'lang', 'form', 'list', 'accept', 'capture', 'enterKeyHint', 'spellCheck', 'wrap', 'step', 'min', 'max', 'scope', 'colSpan', 'rowSpan', 'headers', 'dateTime', 'download', 'referrerPolicy', 'sandbox', 'allow', 'queryKey', 'tab', 'status', 'section', 'at', 'state', 'field', 'by', 'unit', 'format', 'describedBy', 'labelledBy', 'uploadTo', 'endpoint', 'url', 'route', 'param', 'query', 'search', 'sort', 'order', 'align', 'side', 'placement', 'as', 'level', 'width', 'height', 'color', 'scheme', 'theme', 'layout', 'login', 'project', 'issue', 'board', 'point', 'slot', 'when', 'shape', 'mark', 'columns', 'grow', 'gap', 'dataKey', 'storageKey', 'focusKey', 'testId', 'nonce', 'accessKey', 'tabIndex', 'xmlns', 'viewBox', 'd', 'fill', 'stroke', 'transform', 'points', 'x', 'y', 'cx', 'cy', 'r', 'rx', 'ry', 'x1', 'x2', 'y1', 'y2', 'strokeWidth', 'strokeLinecap', 'strokeLinejoin', 'fillRule', 'clipRule', 'preserveAspectRatio', 'textAnchor', 'dominantBaseline', 'fontSize', 'offset', 'stopColor', 'gradientUnits', 'markerEnd', 'filter', 'mask', 'clipPath', 'patternUnits', 'vectorEffect']);
const VERBATIM = new Set(['code', 'pre', 'kbd', 'samp', 'var', 'script', 'style']);
const UI_PROPS = new Set(['text', 'label', 'title', 'help', 'hint', 'placeholder', 'message', 'description', 'heading', 'confirm', 'empty', 'emptyText', 'legend', 'tooltip', 'caption', 'note', 'okLabel', 'cancelLabel', 'busyLabel', 'about', 'word', 'words', 'group', 'why', 'did', 'verb', 'sub', 'long', 'short']);
// What the server sends people: emails, push and chat messages say every word through a translator.
const SENDS_PEOPLE = /packages\/server\/src\/(notify\/(mails|words)|push\/outbox|chat\/cards|helpdesk\/mails)\.ts$/;
const UI_CALLS = new Set(['setSaid', 'onSaid', 'setError', 'setStatus', 'setMessage', 'setNote', 'setProgress', 'setWarning', 'toast', 'alert', 'confirm']);
const letters = (s) => /[A-Za-zÀ-ÿ]/.test(s);
const looksLikeCode = (s) => {
  const t = s.trim();
  return !t || /^(\/|\.\/|\.\.\/|https?:|mailto:|#|@|data:|tw:|--)/.test(t) || /^[a-z0-9_.:/@-]+$/.test(t) || (/^[a-z][a-z0-9-]*( [a-z][a-z0-9-:/]*)+$/.test(t) && !/\b(is|are|an|the|of|to|in|for|and|or|on|with|by|from|as|at|it|its|you|your|this|that|be|not|no|days?|asks?|was|has|have|can|will|who|what|when)\b/.test(t)) || /[{}<>=]|\$\{/.test(t) || /^[A-Z0-9_]+$/.test(t);
};
const wordsLike = (s) => {
  const t = s.trim();
  if (!letters(t) || looksLikeCode(t)) return false;
  return /^[A-Z]/.test(t) || /\s/.test(t) || /[.!?…:]$/.test(t);
};

function checkFile(file, { web }) {
  const src = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const rel = path.relative(root, file);
  const lines = src.split('\n');
  const allowed = (node) => {
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;
    return /\/[/*] not words/.test(lines[line] ?? '') || /\/\/ not words/.test(lines[line - 1] ?? '');
  };
  const at = (node) => `${rel}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`;
  const visit = (node, verbatim) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (KEY.test(node.text) && node.text in en) used.add(node.text);
      else if (KEY.test(node.text) && web && ts.isCallExpression(node.parent) && /^(t|tr|tx|tw_|count)$/.test(node.parent.expression.getText(sf)) && !(node.text in en)) {
        say(at(node), `says ${node.text}, which no catalog has`);
      }
    }
    if (!web) {
      if (SENDS_PEOPLE.test(rel.replace(/\\/g, '/')) && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && wordsLike(node.text) && !KEY.test(node.text) && !allowed(node) && !ts.isImportDeclaration(node.parent) && !ts.isExportDeclaration(node.parent) && !ts.isLiteralTypeNode(node.parent) && !(ts.isBinaryExpression(node.parent) && /^(===|!==)$/.test(node.parent.operatorToken.getText(sf))) && !ts.isCaseClause(node.parent)) {
        say(at(node), `words sent to people: '${node.text.slice(0, 60)}'`);
      }
      ts.forEachChild(node, (c) => visit(c, verbatim));
      return;
    }
    if (ts.isJsxElement(node)) {
      const tag = node.openingElement.tagName.getText(sf);
      if (VERBATIM.has(tag)) verbatim = true;
    }
    if (ts.isJsxText(node) && !verbatim && letters(node.text) && !allowed(node)) say(at(node), `words in JSX: "${node.text.trim().slice(0, 60)}"`);
    if (ts.isJsxAttribute(node) && node.initializer && ts.isStringLiteral(node.initializer)) {
      const name = node.name.getText(sf);
      if (!NON_TEXT_ATTR.has(name) && !name.startsWith('data-') && wordsLike(node.initializer.text) && !allowed(node)) say(at(node), `words in ${name}="${node.initializer.text.slice(0, 60)}"`);
    }
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && !ts.isJsxAttribute(node.parent) && wordsLike(node.text) && !allowed(node)) {
      let n = node;
      let p = n.parent;
      while (p && (ts.isConditionalExpression(p) || ts.isParenthesizedExpression(p) || (ts.isBinaryExpression(p) && ['??', '||'].includes(p.operatorToken.getText(sf))))) {
        if (ts.isConditionalExpression(p) && p.condition === n) break;
        n = p;
        p = p.parent;
      }
      const inJsx = p && ts.isJsxExpression(p) && (ts.isJsxElement(p.parent) || ts.isJsxFragment(p.parent) || (ts.isJsxAttribute(p.parent) && !NON_TEXT_ATTR.has(p.parent.name.getText(sf))));
      const inProp = p && ts.isPropertyAssignment(p) && p.initializer === n && UI_PROPS.has(p.name.getText(sf).replace(/['"]/g, ''));
      const inCall = p && ts.isCallExpression(p) && p.arguments.includes(n) && UI_CALLS.has(ts.isIdentifier(p.expression) ? p.expression.text : '');
      if (inJsx || inProp || inCall) say(at(node), `words in code: '${node.text.slice(0, 60)}'`);
    }
    ts.forEachChild(node, (c) => visit(c, verbatim));
  };
  visit(sf, false);
}

for (const f of walkDir(path.join(root, 'apps/web/src'))) if (!f.includes(`${path.sep}i18n${path.sep}`)) checkFile(f, { web: true });
for (const f of walkDir(path.join(root, 'packages/server/src'))) checkFile(f, { web: false });

for (const k of Object.keys(en)) if (!used.has(k) && !DYNAMIC.some((p) => k.startsWith(p))) say('en.json', `keeps ${k}, which nothing says`);

if (problems.length) {
  console.error(`${problems.length} problem${problems.length === 1 ? '' : 's'} with a4a's words (D49):\n${problems.slice(0, 200).join('\n')}${problems.length > 200 ? `\n… and ${problems.length - 200} more` : ''}`);
  process.exit(1);
}
console.log(`a4a's words are in its catalogs: ${Object.keys(en).length} messages in ${Object.keys(catalogs).length} languages (${Object.keys(catalogs).sort().join(', ')}), each parsing, with English's placeholders.`);
