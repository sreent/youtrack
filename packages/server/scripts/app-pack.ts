/**
 * Package apps, and write a catalog of them (docs/architecture.md, D48).
 *
 *   pnpm --filter @a4a/server apps:pack <out-dir> <app-dir>… [--sign <ed25519-private-key.pem>] [--name "Our apps"]
 *
 * Each app folder becomes <name>-<version>.zip in <out-dir>, and <out-dir>/catalog.json lists them
 * with their SHA-256, and their signature when a key is given: serve the folder over https and add
 * catalog.json's address to APP_CATALOGS (and the key's public half to APP_TRUSTED_KEYS).
 */
import { createPrivateKey, sign } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { signedText } from '../src/apps/catalog';
import { packDirectory } from '../src/apps/pack-dir';
import { readPackage } from '../src/apps/package';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  if (i < 0) return null;
  const v = args[i + 1] ?? null;
  args.splice(i, 2);
  return v;
};
const keyFile = flag('--sign');
const catalogName = flag('--name') ?? 'a4a apps';
const [out, ...dirs] = args;
if (!out || !dirs.length) {
  console.error('Usage: apps:pack <out-dir> <app-dir>… [--sign key.pem] [--name "Our apps"]');
  process.exit(2);
}
const key = keyFile ? createPrivateKey(readFileSync(keyFile)) : null;
mkdirSync(out, { recursive: true });
const apps = [];
for (const dir of dirs) {
  const bytes = packDirectory(dir);
  const pkg = readPackage(bytes, 50 * 1024 * 1024);
  const m = pkg.manifest;
  const file = `${m.name}-${m.version}.zip`;
  writeFileSync(path.join(out, file), bytes);
  apps.push({
    name: m.name,
    title: m.title,
    version: m.version,
    vendor: m.vendor,
    description: m.description,
    url: file,
    sha256: pkg.sha256,
    ...(key ? { signature: sign(null, signedText(m.name, m.version, pkg.sha256), key).toString('base64') } : {}),
  });
  console.log(`${file}  ${pkg.sha256}`);
}
writeFileSync(path.join(out, 'catalog.json'), `${JSON.stringify({ name: catalogName, signed: Boolean(key), apps }, null, 2)}\n`);
console.log(`${path.join(out, 'catalog.json')}: ${apps.length} ${apps.length === 1 ? 'app' : 'apps'}${key ? ', signed' : ''}`);
