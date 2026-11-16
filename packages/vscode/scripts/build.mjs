/**
 * The extension, bundled into dist/extension.js (vscode stays the host's), and Ocean's stylesheets
 * and fonts copied beside it into media/ocean, which the issue's webview loads: the extension has
 * no CSS of its own.
 */
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const ocean = path.dirname(require.resolve('@sreent/ocean/tokens.css').replace(/css[\\/]tokens\.css$/, 'package.json'));

await build({
  entryPoints: [path.join(root, 'src/extension.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  outfile: path.join(root, 'dist/extension.js'),
  sourcemap: false,
  logLevel: 'warning',
});

const media = path.join(root, 'media/ocean');
rmSync(media, { recursive: true, force: true });
mkdirSync(media, { recursive: true });
for (const dir of ['css', 'fonts']) {
  const from = path.join(ocean, dir);
  if (existsSync(from)) cpSync(from, path.join(media, dir), { recursive: true });
}
console.log('a4a for VS Code: dist/extension.js, and Ocean in media/ocean');
