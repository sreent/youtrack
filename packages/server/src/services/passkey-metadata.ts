/**
 * FIDO's Metadata Service (docs/architecture.md, D68): what a4a knows of authenticators' makers, for
 * an instance that takes only some authenticators.
 *
 * - **The BLOB** is FIDO's signed list of authenticators: a JWT whose certificate chains to FIDO's
 *   root. It's fetched from PASSKEY_MDS_URL (FIDO's, by default) or read from PASSKEY_MDS_FILE, and
 *   verified by `@simplewebauthn/server`'s `verifyMDSBlob`, the function its `MetadataService` uses:
 *   the chain to the root (PASSKEY_MDS_ROOT_CERT, else FIDO's own), the JWT's signature by the leaf.
 *   As MetadataService does, a BLOB whose number isn't past the last one's is ignored.
 * - **What MetadataService doesn't do, a4a does here:** it keeps the BLOB in Postgres, so every
 *   instance uses the same one and a restart loses nothing; a fetch that fails keeps the last good
 *   one and says when and why; it reads a file for an instance that can't reach FIDO; it fetches
 *   with a timeout and a size cap, and only while a list is on, never in the middle of a sign-in.
 * - **Attestation** is still checked by the library: `verifyRegistrationResponse` asks its global
 *   MetadataService for the statement of the authenticator that answered, and checks the
 *   attestation's certificates chain to the roots it names. a4a loads that service with the BLOB's
 *   statements (`mdsServers: []`, so it never fetches) before each registration under a list.
 */
import type { PasskeyMetadata, PasskeyMetadataFailure } from '@a4a/shared';
import { MetadataService, SettingsService, type MetadataStatement } from '@simplewebauthn/server';
import { verifyMDSBlob } from '@simplewebauthn/server/helpers';
import { eq, sql } from 'drizzle-orm';
import { readFile } from 'node:fs/promises';
import type { AppServices } from '../context';
import type { Db } from '../db/client';
import { passkeyMetadata } from '../db/schema';

const ROW = 'mds';
/** FIDO's own roots, as the library ships them, read before anything sets others. */
const FIDO_ROOTS = SettingsService.getRootCertificates({ identifier: 'mds' });
/** FIDO's BLOB was about 6 MB in 2025; this is room to grow, not a guess at its size. */
export const MAX_BLOB_BYTES = 64 * 1024 * 1024;
const FETCH_MS = 30_000;
/** While a list is on: read daily, and every half hour while none was read, the last try failed, or the BLOB is stale. */
export const REFRESH_MS = 24 * 3600_000;
export const RETRY_MS = 30 * 60_000;

/** One authenticator the BLOB describes: its statement (icon dropped) and what FIDO has said of it since. */
export interface MdsEntry {
  aaguid: string;
  statement: MetadataStatement;
  statusReports: { status: string; effectiveDate?: string }[];
}

/** Statuses after which FIDO says an authenticator can't be trusted (FIDO's AuthenticatorStatus): MetadataService's, and REVOKED. */
const UNTRUSTED = new Set(['USER_VERIFICATION_BYPASS', 'ATTESTATION_KEY_COMPROMISE', 'USER_KEY_REMOTE_COMPROMISE', 'USER_KEY_PHYSICAL_COMPROMISE', 'REVOKED']);
export const untrusted = (e: MdsEntry) => e.statusReports.some((r) => UNTRUSTED.has(r.status));
export const nameOf = (e: MdsEntry) => (e.statement.description || e.aaguid).slice(0, 60);

class Refused extends Error {
  constructor(
    readonly kind: PasskeyMetadataFailure,
    message: string,
  ) {
    super(message);
  }
}

const words = (e: unknown) => (e instanceof Error ? (e.cause instanceof Error ? `${e.message}: ${e.cause.message}` : e.message) : String(e));

// ---------------------------------------------------------------------------
// Reading and verifying a BLOB
// ---------------------------------------------------------------------------

async function capped(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BLOB_BYTES) {
      await reader.cancel();
      throw new Refused('tooLarge', `The BLOB is larger than ${MAX_BLOB_BYTES / 1024 / 1024} MB`);
    }
    parts.push(value);
  }
  return Buffer.concat(parts).toString('utf8');
}

/** The BLOB's text: from the file, else from the address (https; plain http only to this machine, in tests). */
async function readBlob(app: AppServices): Promise<string> {
  const { file, url, allowHttpLoopback } = app.config.passkeyMds;
  if (file) {
    let bytes: Buffer;
    try {
      bytes = await readFile(file);
    } catch (e) {
      throw new Refused('unreadable', `${file} can't be read: ${words(e)}`);
    }
    if (bytes.length > MAX_BLOB_BYTES) throw new Refused('tooLarge', `${file} is larger than ${MAX_BLOB_BYTES / 1024 / 1024} MB`);
    return bytes.toString('utf8');
  }
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(FETCH_MS), redirect: 'follow', headers: { accept: 'application/jwt, text/plain;q=0.9, */*;q=0.1' } });
  } catch (e) {
    throw new Refused('unreachable', `${url} didn't answer: ${words(e)}`);
  }
  const final = new URL(res.url || url);
  const loopback = allowHttpLoopback && ['127.0.0.1', 'localhost', '[::1]'].includes(final.hostname);
  if (final.protocol !== 'https:' && !(loopback && final.protocol === 'http:')) throw new Refused('unreachable', `${url} sent a4a to ${final.origin}, which isn't https`);
  if (!res.ok) throw new Refused('unreachable', `${url} answered ${res.status}`);
  return capped(res);
}

/** A BLOB checked as MetadataService checks one: signed by a certificate that chains to the root, and readable. */
async function verify(app: AppServices, jwt: string): Promise<{ no: number; nextUpdate: string; entries: MdsEntry[] }> {
  const blob = jwt.trim();
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(blob)) throw new Refused('unreadable', 'What came isn’t a BLOB: a signed JWT, in three parts');
  // The library reads its roots from a shared setting: set in the same turn it reads them, so this BLOB is checked against this instance's.
  SettingsService.setRootCertificates({ identifier: 'mds', certificates: app.config.passkeyMds.rootCerts ?? FIDO_ROOTS });
  let payload: { no?: unknown; nextUpdate?: unknown; entries?: unknown };
  try {
    payload = (await verifyMDSBlob(blob)).payload as typeof payload;
  } catch (e) {
    throw new Refused('unverified', `The BLOB's signature doesn't check out: ${words(e)}`);
  }
  if (typeof payload.no !== 'number' || typeof payload.nextUpdate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(payload.nextUpdate) || !Array.isArray(payload.entries)) {
    throw new Refused('unreadable', 'The BLOB has no number, next update or entries');
  }
  const entries: MdsEntry[] = [];
  for (const raw of payload.entries as { aaguid?: unknown; metadataStatement?: MetadataStatement & { icon?: unknown; friendlyNames?: unknown }; statusReports?: { status: string; effectiveDate?: string }[] }[]) {
    if (typeof raw?.aaguid !== 'string' || !raw.metadataStatement) continue;
    const aaguid = raw.aaguid.toLowerCase();
    // Icons are most of the BLOB's size, and a4a shows none; names are products', the same in every language.
    const { icon: _icon, friendlyNames: _names, ...statement } = raw.metadataStatement;
    entries.push({
      aaguid,
      statement: { ...statement, aaguid } as MetadataStatement,
      statusReports: (raw.statusReports ?? []).map((r) => ({ status: String(r.status), ...(r.effectiveDate ? { effectiveDate: String(r.effectiveDate) } : {}) })),
    });
  }
  return { no: payload.no, nextUpdate: payload.nextUpdate, entries };
}

// ---------------------------------------------------------------------------
// Keeping it
// ---------------------------------------------------------------------------

type Row = typeof passkeyMetadata.$inferSelect;

async function currentRow(db: Db): Promise<Row | undefined> {
  const [row] = await db.select().from(passkeyMetadata).where(eq(passkeyMetadata.id, ROW));
  return row;
}

const today = () => new Date().toISOString().slice(0, 10);
const isStale = (row: Pick<Row, 'nextUpdate'> | undefined) => Boolean(row?.nextUpdate && row.nextUpdate < today());

/** Whether it's time to read the BLOB again. */
function due(row: Row | undefined): boolean {
  if (!row?.triedAt) return true;
  const healthy = row.no !== null && !row.failedAt && !isStale(row);
  return Date.now() - row.triedAt.getTime() >= (healthy ? REFRESH_MS : RETRY_MS);
}

/**
 * Read FIDO's BLOB again, when it's due or an administrator asks: a newer one that verifies replaces
 * the one in use; the same number again says it's still current; anything else keeps the last good
 * one, and records why. Several instances may try at once: the write keeps the highest number.
 */
export async function refreshMetadata(app: AppServices, opts: { force?: boolean } = {}): Promise<PasskeyMetadata> {
  const row = await currentRow(app.db);
  if (!opts.force && !due(row)) return describe(app, row);
  const now = new Date();
  try {
    const blob = await verify(app, await readBlob(app));
    if (row?.no != null && blob.no < row.no) throw new Refused('older', `The BLOB is number ${blob.no}, before number ${row.no}, which a4a has: FIDO numbers each one after the last`);
    await app.db
      .insert(passkeyMetadata)
      .values({ id: ROW, no: blob.no, nextUpdate: blob.nextUpdate, gotAt: now, entries: blob.entries, triedAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: passkeyMetadata.id,
        set: { no: blob.no, nextUpdate: blob.nextUpdate, gotAt: now, entries: blob.entries, triedAt: now, failedAt: null, failure: null, failureDetail: null, updatedAt: now },
        setWhere: sql`${passkeyMetadata.no} is null or ${passkeyMetadata.no} <= ${blob.no}`,
      });
  } catch (e) {
    const kind: PasskeyMetadataFailure = e instanceof Refused ? e.kind : 'unreadable';
    const detail = words(e).slice(0, 500);
    console.warn(`passkeys: FIDO's metadata wasn't taken (${kind}): ${detail}`);
    await app.db
      .insert(passkeyMetadata)
      .values({ id: ROW, triedAt: now, failedAt: now, failure: kind, failureDetail: detail, updatedAt: now })
      .onConflictDoUpdate({ target: passkeyMetadata.id, set: { triedAt: now, failedAt: now, failure: kind, failureDetail: detail, updatedAt: now } });
  }
  loaded.delete(app);
  return describe(app, await currentRow(app.db));
}

/** The lease holder's chore: read it again when due, only while an instance takes some authenticators alone. */
export async function refreshWhenListed(app: AppServices, listed: () => Promise<boolean>): Promise<void> {
  if (await listed()) await refreshMetadata(app);
}

const loaded = new WeakMap<AppServices, { no: number; byAaguid: Map<string, MdsEntry> }>();

/** The BLOB in use, by AAGUID; null when none was read yet. Read once per BLOB on each instance. */
export async function metadataInUse(app: AppServices): Promise<{ no: number; byAaguid: Map<string, MdsEntry> } | null> {
  const [head] = await app.db.select({ no: passkeyMetadata.no }).from(passkeyMetadata).where(eq(passkeyMetadata.id, ROW));
  if (head?.no == null) return null;
  const held = loaded.get(app);
  if (held?.no === head.no) return held;
  const row = await currentRow(app.db);
  if (row?.no == null) return null;
  const next = { no: row.no, byAaguid: new Map(((row.entries ?? []) as MdsEntry[]).map((e) => [e.aaguid, e])) };
  loaded.set(app, next);
  return next;
}

/** What an administrator sees: where it comes from, how old the one in use is, the last try, and what it describes. */
export async function metadataStatus(app: AppServices): Promise<PasskeyMetadata> {
  return describe(app, await currentRow(app.db));
}

function describe(app: AppServices, row: Row | undefined): PasskeyMetadata {
  const { file, url } = app.config.passkeyMds;
  const entries = (row?.entries ?? []) as MdsEntry[];
  return {
    source: file ? 'file' : 'url',
    from: file ?? url,
    no: row?.no ?? null,
    nextUpdate: row?.nextUpdate ?? null,
    gotAt: row?.gotAt?.toISOString() ?? null,
    stale: row?.no != null && isStale(row),
    triedAt: row?.triedAt?.toISOString() ?? null,
    failedAt: row?.failedAt?.toISOString() ?? null,
    failure: (row?.failure as PasskeyMetadataFailure | null) ?? null,
    failureDetail: row?.failureDetail ?? null,
    authenticators: entries.map((e) => ({ aaguid: e.aaguid, name: nameOf(e), revoked: untrusted(e) })).sort((a, b) => a.name.localeCompare(b.name, 'en')),
  };
}

// ---------------------------------------------------------------------------
// The library's MetadataService, for a registration's attestation
// ---------------------------------------------------------------------------

let holding: object | null = null;
const NONE = {};

/**
 * Load the library's MetadataService with these statements, so `verifyRegistrationResponse` checks
 * an attestation against its authenticator's (strict: one it doesn't hold is refused); or with none,
 * where any authenticator is taken. It's one per process, so a4a loads it before each registration;
 * with no servers to fetch from, loading is a step with no await, and never reaches the network.
 */
export async function holdStatements(entries: { no: number; byAaguid: Map<string, MdsEntry> } | null): Promise<void> {
  const key = entries ?? NONE;
  if (holding === key) return;
  await MetadataService.initialize({
    mdsServers: [],
    statements: entries ? [...entries.byAaguid.values()].map((e) => e.statement) : [],
    verificationMode: entries ? 'strict' : 'permissive',
  });
  holding = key;
}
