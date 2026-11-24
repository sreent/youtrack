/**
 * App catalogs (docs/architecture.md, D48): JSON indexes at addresses an administrator configured
 * (APP_CATALOGS), each listing apps with the address of their package and its SHA-256.
 *
 *   { "name": "Acme apps", "signed": true,
 *     "apps": [{ "name": "time-report", "title": "Time report", "version": "1.2.0",
 *                "url": "time-report-1.2.0.zip", "sha256": "…", "signature": "…" }] }
 *
 * - Read as the importers read other trackers (imports/remote.ts): https, public addresses, each
 *   redirect checked; plain http only to this machine, in tests.
 * - A package is checked against its digest before anything in it is read.
 * - A signature is Ed25519, by a key the configuration trusts (APP_TRUSTED_KEYS), over
 *   `${name}@${version}\n${sha256}`: so it vouches for that app at that version, and its bytes.
 *   A catalog that says it signs has every app checked; an app that isn't signed, or is signed by a
 *   key a4a doesn't trust, is refused. A catalog that doesn't sign gives the digest alone.
 */
import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';
import { AppError, asSentence, badRequest } from '../lib/errors';
import { Remote, RemoteError, type RemotePolicy } from '../imports/remote';
import type { Config } from '../config';
import { sha256Hex } from './package';

export interface CatalogEntry {
  name: string;
  title: string;
  version: string;
  vendor: string | null;
  description: string;
  url: string;
  sha256: string;
  signature: string | null;
}

export interface Catalog {
  url: string;
  name: string;
  signed: boolean;
  apps: CatalogEntry[];
}

const CACHE_MS = 5 * 60_000;
const cache = new Map<string, { at: number; catalog: Catalog }>();

/** Forget what catalogs said: for tests, and after the configuration changes. */
export function forgetCatalogs(): void {
  cache.clear();
}

const policyOf = (config: Config): RemotePolicy => ({ allowHosts: [], allowHttpLoopback: config.appAllowHttpLoopback });

const NAMES = {
  name: 'the catalog',
  example: 'https://apps.example.com/catalog.json',
  authHint: 'a4a reads catalogs without signing in: give one that is public.',
  badRequestHint: 'Check the catalog\'s address.',
};

function remoteFor(config: Config, url: string): Remote {
  return new Remote(new URL(url), '', [], policyOf(config), NAMES);
}

function words(e: unknown): string {
  if (e instanceof RemoteError) return `${e.message}${e.hint ? ` ${e.hint}` : ''}`;
  if (e instanceof AppError) return e.message;
  return e instanceof Error ? e.message : String(e);
}

/** A catalog a4a was configured with, read (or remembered for five minutes). */
export async function readCatalog(config: Config, url: string): Promise<Catalog> {
  if (!config.appCatalogs.includes(url)) {
    throw config.appCatalogs.length
      ? badRequest(`${url} isn't one of the catalogs this a4a reads`, `The catalogs are set in APP_CATALOGS: ${config.appCatalogs.join(', ')}.`).said('apps.catalogUnknown', { url, catalogs: [...config.appCatalogs] })
      : badRequest(`${url} isn't one of the catalogs this a4a reads`, 'The catalogs are set in APP_CATALOGS, and none is.').said('apps.catalogUnknownNone', { url });
  }
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.catalog;
  let raw: unknown;
  try {
    raw = await remoteFor(config, url).json<unknown>('');
  } catch (e) {
    throw badRequest(`The catalog at ${url} can't be read: ${words(e)}`, 'Try again later, or ask whoever keeps it.').said('apps.catalogUnreadable', { url, error: asSentence(words(e)) });
  }
  const catalog = catalogOf(url, raw);
  cache.set(url, { at: Date.now(), catalog });
  return catalog;
}

function catalogOf(url: string, raw: unknown): Catalog {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  if (!o || !Array.isArray(o.apps)) throw badRequest(`The catalog at ${url} lists no apps`, 'A catalog is JSON with an "apps" list.').said('apps.catalogEmpty', { url });
  const apps: CatalogEntry[] = [];
  for (const a of o.apps) {
    if (!a || typeof a !== 'object') continue;
    const r = a as Record<string, unknown>;
    const s = (k: string) => (typeof r[k] === 'string' && (r[k] as string).trim() ? (r[k] as string).trim() : null);
    const name = s('name');
    const version = s('version');
    const pkg = s('url');
    const digest = s('sha256')?.toLowerCase() ?? null;
    if (!name || !version || !pkg || !digest || !/^[0-9a-f]{64}$/.test(digest)) continue;
    apps.push({ name, title: s('title') ?? name, version, vendor: s('vendor'), description: s('description') ?? '', url: pkg, sha256: digest, signature: s('signature') });
  }
  return { url, name: typeof o.name === 'string' && o.name.trim() ? o.name.trim() : new URL(url).host, signed: o.signed === true, apps };
}

/** The trusted keys, read once per call: PEM, or base64 of the raw 32 bytes. */
export function trustedKeys(config: Config): { key: KeyObject; fingerprint: string }[] {
  const out: { key: KeyObject; fingerprint: string }[] = [];
  for (const text of config.appTrustedKeys) {
    try {
      const key = text.includes('BEGIN')
        ? createPublicKey(text)
        : createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(text, 'base64')]), format: 'der', type: 'spki' });
      if (key.asymmetricKeyType !== 'ed25519') continue;
      const raw = key.export({ format: 'der', type: 'spki' }).subarray(12);
      out.push({ key, fingerprint: createHash('sha256').update(raw).digest('hex').slice(0, 16) });
    } catch {
      // A key that can't be read vouches for nothing.
    }
  }
  return out;
}

/** What an app's signature covers. */
export const signedText = (name: string, version: string, sha256: string) => Buffer.from(`${name}@${version}\n${sha256}`, 'utf8');

/**
 * Whether the entry may be installed, as far as signing goes: the fingerprint of the key that
 * signed it, null when its catalog doesn't sign and it carries no signature; refused otherwise.
 */
export function checkSignature(config: Config, catalog: Catalog, entry: CatalogEntry): string | null {
  if (!catalog.signed && !entry.signature) return null;
  const keys = trustedKeys(config);
  if (!entry.signature) throw badRequest(`${entry.title} ${entry.version} isn't signed, and its catalog signs its apps`, 'Ask whoever keeps the catalog to sign it; a4a installs a signing catalog\'s apps only when signed.').said('apps.unsigned', { app: entry.title, version: entry.version });
  if (!keys.length) throw badRequest(`${entry.title} is signed, and this a4a trusts no key to check it with`, 'Add the catalog\'s public key to APP_TRUSTED_KEYS.').said('apps.noTrustedKey', { app: entry.title });
  const sig = Buffer.from(entry.signature, 'base64');
  for (const k of keys) {
    if (verify(null, signedText(entry.name, entry.version, entry.sha256), k.key, sig)) return k.fingerprint;
  }
  throw badRequest(`${entry.title} ${entry.version}'s signature isn't by a key this a4a trusts`, 'Install it only from a catalog you trust, signed with a key in APP_TRUSTED_KEYS.').said('apps.untrustedSignature', { app: entry.title, version: entry.version });
}

/** The entry for an app in a catalog: the version asked for, or its newest. */
export function entryOf(catalog: Catalog, name: string, version?: string, newer?: (a: string, b: string) => boolean): CatalogEntry {
  const found = catalog.apps.filter((a) => a.name === name && (!version || a.version === version));
  if (!found.length) {
    throw version
      ? badRequest(`${catalog.name} has no app ${name} at ${version}`, 'Pick one the catalog lists.').said('apps.noSuchVersion', { catalog: catalog.name, app: name, version })
      : badRequest(`${catalog.name} has no app ${name}`, 'Pick one the catalog lists.').said('apps.noSuchApp', { catalog: catalog.name, app: name });
  }
  return found.reduce((best, a) => (newer && newer(a.version, best.version) ? a : best));
}

/** Download an entry's package, refusing it unless its bytes are what the catalog says. */
export async function downloadPackage(config: Config, catalog: Catalog, entry: CatalogEntry): Promise<Buffer> {
  const remote = remoteFor(config, catalog.url);
  let file;
  try {
    file = await remote.download(new URL(entry.url, catalog.url).href);
  } catch (e) {
    throw badRequest(`${entry.title}'s package can't be downloaded: ${words(e)}`, 'Try again later, or ask whoever keeps the catalog.').said('apps.downloadFailed', { app: entry.title, error: asSentence(words(e)) });
  }
  if (file.size !== null && file.size > config.appMaxBytes) {
    file.abort();
    throw badRequest(`${entry.title}'s package is larger than this a4a takes`, 'Ask for APP_MAX_MB to be raised.').said('apps.tooLarge', { app: entry.title });
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of file.stream) {
    total += (chunk as Buffer).length;
    if (total > config.appMaxBytes) {
      file.abort();
      throw badRequest(`${entry.title}'s package is larger than this a4a takes`, 'Ask for APP_MAX_MB to be raised.').said('apps.tooLarge', { app: entry.title });
    }
    chunks.push(chunk as Buffer);
  }
  const bytes = Buffer.concat(chunks);
  // The digest first: nothing in a package that isn't the one the catalog names is read.
  if (sha256Hex(bytes) !== entry.sha256) throw badRequest(`${entry.title}'s package isn't the one its catalog names: its SHA-256 differs`, 'It may have been changed on its way here, or the catalog is out of date: install nothing, and tell whoever keeps the catalog.').said('apps.hashMismatch', { app: entry.title });
  return bytes;
}
