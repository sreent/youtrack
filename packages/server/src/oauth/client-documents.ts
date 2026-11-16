/**
 * Client ID metadata documents (docs/architecture.md, D38): an app whose client_id is an https
 * address, where a JSON document says what registration would have (its name, its redirect URIs).
 * MCP's authorization asks servers to take them, so a client needn't register with each one.
 *
 * Reading someone else's address is a request a4a makes for them, so it is held in:
 * - https only (http to this machine in tests), with a path, and no name, password, fragment or
 *   dot segments in it; an IP address must be a public one;
 * - the name is resolved as the connection is made, and only public addresses are offered, so a
 *   name that points inside the network (or is made to, between a check and the request) reaches
 *   nothing there;
 * - no redirect is followed; the answer is JSON of 5 KB at most, within five seconds;
 * - the document must name itself: its client_id is the address it was read from;
 * - an app known this way is a public client, as a registered one: no secret, PKCE.
 * The reading is kept for as long as the answer's Cache-Control allows, between five minutes and
 * a day (an hour when it says nothing), and read again when an app comes back after that.
 */
import http from 'node:http';
import https from 'node:https';
import { eq } from 'drizzle-orm';
import type { AppServices } from '../context';
import { oauthClients } from '../db/schema';
import { checkAddress, guardedLookup, RemoteError, type RemotePolicy } from '../imports/remote';
import { clientFields, type ClientRow } from './clients';
import { clip, OAuthError } from './common';

const MAX_BYTES = 5 * 1024;
const TIMEOUT_MS = 5_000;
const MIN_KEEP_S = 5 * 60;
const MAX_KEEP_S = 24 * 60 * 60;
const DEFAULT_KEEP_S = 60 * 60;

/** Whether a client_id is a document's address rather than an id a4a gave at registration. */
export function isDocumentId(clientId: string): boolean {
  return /^https?:\/\//i.test(clientId);
}

const refused = (why: string) => new OAuthError('invalid_client', why);

/** The address, checked as the draft asks, before anything is sent. */
function documentUrl(policy: RemotePolicy, clientId: string): URL {
  if (clientId.length > 500) throw refused('A client_id address may be 500 characters at most');
  let parsed: URL;
  try {
    parsed = new URL(clientId);
  } catch {
    throw refused(`${clip(clientId)} isn’t an address`);
  }
  if (parsed.protocol !== 'https:' && !(policy.allowHttpLoopback && parsed.protocol === 'http:')) throw refused('A client_id address must be https');
  let url: URL;
  try {
    url = checkAddress(policy, clientId, 'https://app.example/oauth/client.json');
  } catch (e) {
    // Its words only: its hints are about importing.
    throw refused(e instanceof RemoteError ? e.message : `${clip(clientId)} isn’t an address a4a reads`);
  }
  if (clientId.includes('#')) throw refused('A client_id address can’t have a fragment (#…)');
  if (url.pathname === '/' || url.pathname === '') throw refused('A client_id address needs a path, such as https://app.example/oauth/client.json');
  // As written, before the URL parser folds them away; %2e is a dot too.
  const rawPath = clientId.replace(/^https?:\/\/[^/?#]+/i, '').replace(/%2e/gi, '.');
  if (/\/\.\.?(\/|\?|$)/.test(rawPath)) {
    throw refused('A client_id address can’t have . or .. in its path');
  }
  return url;
}

/** How long a reading holds, from the answer's Cache-Control: within five minutes and a day. */
export function keepFor(cacheControl: string | undefined): number {
  const cc = (cacheControl ?? '').toLowerCase();
  if (/\bno-store\b|\bno-cache\b/.test(cc)) return MIN_KEEP_S;
  const m = /\bmax-age=(\d+)/.exec(cc);
  const asked = m ? Number(m[1]) : DEFAULT_KEEP_S;
  return Math.min(MAX_KEEP_S, Math.max(MIN_KEEP_S, asked));
}

/** The document at an address, as JSON, and how long it holds; the reason in words when it can't be had. */
function fetchDocument(policy: RemotePolicy, url: URL): Promise<{ body: unknown; keepS: number }> {
  return new Promise((resolve, reject) => {
    const where = url.host;
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(
      url,
      { method: 'GET', headers: { accept: 'application/json', 'user-agent': 'a4a' }, lookup: guardedLookup(policy, url) as never, timeout: TIMEOUT_MS },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.resume();
          return reject(refused(`The app’s metadata at ${where} sends a4a elsewhere, and a4a follows no redirects for it: its client_id must be the document’s own address`));
        }
        if (status !== 200) {
          res.resume();
          return reject(refused(`a4a couldn’t read the app’s metadata at ${where}: it answered ${status}`));
        }
        const type = String(res.headers['content-type'] ?? '');
        if (!/^application\/([\w.+-]+\+)?json\b/i.test(type)) {
          res.resume();
          return reject(refused(`The app’s metadata at ${where} isn’t JSON (${clip(type || 'no content type', 60)})`));
        }
        let size = 0;
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BYTES) {
            req.destroy();
            reject(refused(`The app’s metadata at ${where} is larger than ${MAX_BYTES / 1024} KB`));
          } else chunks.push(chunk);
        });
        res.on('end', () => {
          if (size > MAX_BYTES) return;
          try {
            resolve({ body: JSON.parse(Buffer.concat(chunks).toString('utf8')), keepS: keepFor(res.headers['cache-control']) });
          } catch {
            reject(refused(`The app’s metadata at ${where} isn’t JSON`));
          }
        });
        res.on('error', () => reject(refused(`a4a couldn’t read the app’s metadata at ${where}`)));
      },
    );
    req.on('timeout', () => req.destroy(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })));
    req.on('error', (e: NodeJS.ErrnoException) => {
      if (e instanceof OAuthError) return reject(e);
      if (e.code === 'A4A_INSIDE') return reject(refused(`The app’s metadata address ${where} is inside the network, and a4a reads only public addresses`));
      reject(refused(`a4a couldn’t reach the app’s metadata at ${where}${e.code ? ` (${e.code})` : ''}`));
    });
    req.end();
  });
}

/** What the document says, checked: it names itself, it is a public client's, and its metadata holds. */
function fromDocument(clientId: string, body: unknown) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw refused('The app’s metadata document isn’t a JSON object');
  const b = body as Record<string, unknown>;
  if (b.client_id !== clientId) throw refused(`The app’s metadata document names another client_id: it must be ${clip(clientId)}, the address it is at`);
  if ('client_secret' in b || 'client_secret_expires_at' in b) throw refused('The app’s metadata document holds a client secret: a document is public, so it can’t');
  const method = b.token_endpoint_auth_method ?? 'none';
  if (method !== 'none') throw refused(`a4a takes apps as public clients (token_endpoint_auth_method "none"), not "${clip(String(method), 40)}"`);
  try {
    return clientFields(b);
  } catch (e) {
    if (e instanceof OAuthError) throw refused(`The app’s metadata document: ${e.message}`);
    throw e;
  }
}

/**
 * The app a client_id names: one that registered, or one known by its metadata document, read now
 * if a4a hasn't read it yet, or its reading ran out and `read` allows reading it again.
 * Null when there is no such app; an OAuthError when a document can't be had or doesn't hold.
 */
export async function findClient(app: AppServices, clientId: string, opts: { read: boolean }): Promise<ClientRow | null> {
  const [row] = await app.db.select().from(oauthClients).where(eq(oauthClients.id, clientId));
  if (!isDocumentId(clientId)) return row ?? null;
  if (!app.config.oauthClientDocuments) return null;
  if (row?.documentExpiresAt && row.documentExpiresAt > new Date()) return row;
  if (!opts.read) return row ?? null;
  const policy: RemotePolicy = { allowHosts: [], allowHttpLoopback: app.config.oauthClientDocumentsAllowHttpLoopback };
  const url = documentUrl(policy, clientId);
  const { body, keepS } = await fetchDocument(policy, url);
  const fields = fromDocument(clientId, body);
  const now = new Date();
  const reading = { ...fields, documentFetchedAt: now, documentExpiresAt: new Date(now.getTime() + keepS * 1000) };
  const [saved] = await app.db.insert(oauthClients).values({ id: clientId, ...reading }).onConflictDoUpdate({ target: oauthClients.id, set: reading }).returning();
  return saved!;
}
