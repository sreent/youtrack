/**
 * Every problem a person can meet is keyed (docs/architecture.md, D49). Each AppError the server
 * makes carries `.said(key, values)`, so a page in another language says it in its person's
 * language, from `problem.<key>` in the catalogs. This lists the problems that don't carry a key,
 * and the keys said that en.json hasn't.
 *
 *   node apps/web/scripts/check-problems.mjs                    every file
 *   node apps/web/scripts/check-problems.mjs services/issues    files under these paths only
 *
 * The paths are relative to packages/server/src.
 *
 * A problem only programs meet (a protocol's own error, a webhook's signature, MCP's framing) is
 * marked `// api only: <why>` on its line or the one before, and stays English.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(process.env.CHECK_WORDS_ROOT ?? path.join(here, '../../..'));
const ts = createRequire(path.join(here, '../package.json'))('typescript');
const server = path.join(root, 'packages/server/src');
const en = JSON.parse(readFileSync(path.join(root, 'packages/shared/i18n/en.json'), 'utf8'));

/** The helpers that make an AppError (lib/errors.ts). Called with nothing, unauthorized() and forbidden() are keyed already. */
const HELPERS = new Set(['badRequest', 'notFound', 'forbidden', 'conflict', 'unauthorized']);
const KEYED_BARE = new Set(['unauthorized', 'forbidden']);

const only = process.argv.slice(2).map((p) => p.replace(/^\.?\//, '').replace(/\/$/, ''));

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

const unkeyed = [];
const unknownKeys = [];
let keyed = 0;

for (const file of walk(server)) {
  const rel = path.relative(server, file).split(path.sep).join('/');
  if (rel === 'lib/errors.ts') continue;
  if (only.length && !only.some((p) => rel === p || rel.startsWith(`${p}/`) || rel.startsWith(`${p}.`))) continue;
  const src = readFileSync(file, 'utf8');
  const lines = src.split('\n');
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const lineOf = (node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;
  const apiOnly = (node) => {
    const line = lineOf(node);
    return /\/\/ api only:/.test(lines[line] ?? '') || /\/\/ api only:/.test(lines[line - 1] ?? '');
  };
  /** `make(...).said(...)`: the problem carries its key where it's made. */
  const isSaid = (node) => ts.isPropertyAccessExpression(node.parent) && node.parent.name.text === 'said' && ts.isCallExpression(node.parent.parent) && node.parent.parent.expression === node.parent;
  const visit = (node) => {
    const made =
      (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'AppError') ||
      (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && HELPERS.has(node.expression.text));
    if (made) {
      const name = node.expression.text;
      const bare = ts.isCallExpression(node) && KEYED_BARE.has(name) && node.arguments.length === 0;
      if (bare || isSaid(node)) keyed++;
      else if (!apiOnly(node)) {
        const first = node.arguments?.[ts.isNewExpression(node) ? 2 : 0];
        const words = first ? first.getText(sf).replace(/\s+/g, ' ').slice(0, 90) : '';
        unkeyed.push(`packages/server/src/${rel}:${lineOf(node) + 1}: ${name}(${words})`);
      }
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'said') {
      const [key] = node.arguments;
      if (key && (ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key)) && !(`problem.${key.text}` in en)) {
        unknownKeys.push(`packages/server/src/${rel}:${lineOf(node) + 1}: says problem.${key.text}, which en.json hasn't`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

const problems = [...unkeyed, ...unknownKeys];
if (problems.length) {
  console.error(
    `${unkeyed.length} problem${unkeyed.length === 1 ? '' : 's'} without a key, ${unknownKeys.length} key${unknownKeys.length === 1 ? '' : 's'} no catalog has (D49)` +
      `${only.length ? `, under ${only.join(', ')}` : ''}:\n${problems.slice(0, 400).join('\n')}${problems.length > 400 ? `\n… and ${problems.length - 400} more` : ''}`,
  );
  process.exit(1);
}
console.log(`Every problem the server makes is keyed${only.length ? ` under ${only.join(', ')}` : ''}: ${keyed}, each in the catalogs.`);
