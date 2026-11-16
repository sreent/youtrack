/** Packaging an app from a folder (docs/architecture.md, D48): for tests, and the apps:pack script. */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { packApp } from './package';

/** Every file under `dir`, by its path relative to it, zipped. */
export function packDirectory(dir: string): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  const walk = (at: string) => {
    for (const name of readdirSync(at).sort()) {
      const full = path.join(at, name);
      if (statSync(full).isDirectory()) walk(full);
      else files[path.relative(dir, full).split(path.sep).join('/')] = readFileSync(full);
    }
  };
  walk(dir);
  return packApp(files);
}
