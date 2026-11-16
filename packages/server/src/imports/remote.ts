/**
 * Reading another tracker's API from the server. The address is someone's to give, so where a
 * request may go is checked as it connects, not only before:
 *
 * - https only. Plain http goes to this machine alone, and only when IMPORT_ALLOW_HTTP_LOOPBACK
 *   says so, which is for tests.
 * - Public addresses only. The name is resolved as the connection is made and every address it
 *   gives is checked then, so DNS can't answer one thing to a check and another to the connection.
 *   Addresses inside the network (private, loopback, link-local, the cloud's metadata service) are
 *   refused unless an administrator allows the host by name (IMPORT_ALLOW_HOSTS).
 * - Redirects are followed by hand, each hop checked the same way, and the credentials go only to
 *   the origin they were given for: a redirect elsewhere (Jira's files, served from Atlassian's
 *   media service) goes without them.
 *
 * The credentials never appear in an error, a log or the database: what the other tracker says
 * back is shown with them taken out.
 *
 * 429 and 503 are waited out as Retry-After asks (up to ten minutes a time), a dropped connection
 * is tried again, and the waits go through a hook, so a job can keep saying it's alive.
 */
import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from 'node:dns';
import http, { type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';
import type { Readable } from 'node:stream';

export interface RemotePolicy {
  /** Host names that may resolve inside the network (lower case). */
  allowHosts: string[];
  /** Plain http to this machine, for tests. */
  allowHttpLoopback: boolean;
}

export type RemoteFailure = 'address' | 'auth' | 'forbidden' | 'missing' | 'refused' | 'unavailable' | 'network' | 'shape' | 'too_large' | 'slow_down';

/** Something about reaching the other tracker, in words for the person importing. */
export class RemoteError extends Error {
  constructor(
    message: string,
    readonly hint: string | undefined,
    readonly kind: RemoteFailure,
    readonly status: number | null = null,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Where a request may go
// ---------------------------------------------------------------------------

const INSIDE = new BlockList();
const INSIDE_V4: [string, number][] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];
const INSIDE_V6: [string, number][] = [
  ['::', 128],
  ['::1', 128],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
];
for (const [net, prefix] of INSIDE_V4) INSIDE.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of INSIDE_V6) INSIDE.addSubnet(net, prefix, 'ipv6');

/** The IPv4 address an IPv6 one carries: mapped (::ffff:a.b.c.d) or NAT64 (64:ff9b::/96). */
function embeddedV4(address: string): string | null {
  const a = address.toLowerCase();
  const dotted = /^(?:::ffff:|64:ff9b::)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a);
  if (dotted) return dotted[1]!;
  const hex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(a);
  if (!hex) return null;
  const hi = parseInt(hex[1]!, 16);
  const lo = parseInt(hex[2]!, 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

const bare = (host: string) => host.replace(/^\[|\]$/g, '');

/** Whether an address is out on the internet, rather than inside a network or reserved. */
export function isPublicAddress(address: string): boolean {
  const a = bare(address);
  const family = isIP(a);
  if (family === 6) {
    const v4 = embeddedV4(a);
    if (v4) return isPublicAddress(v4);
    return !INSIDE.check(a, 'ipv6');
  }
  if (family === 4) return !INSIDE.check(a, 'ipv4');
  return false;
}

function isLoopback(address: string): boolean {
  const a = bare(address);
  const v4 = isIP(a) === 6 ? embeddedV4(a) : null;
  const plain = v4 ?? a;
  return isIP(plain) === 4 ? plain.startsWith('127.') : plain === '::1';
}

function addressAllowed(policy: RemotePolicy, url: URL, address: string): boolean {
  if (url.protocol === 'http:') return policy.allowHttpLoopback && isLoopback(address);
  if (isPublicAddress(address)) return true;
  if (policy.allowHosts.includes(bare(url.hostname).toLowerCase())) return true;
  return policy.allowHttpLoopback && isLoopback(address);
}

const insideError = (host: string) =>
  new RemoteError(`${host} is inside the network, and a4a reads only from public addresses`, 'An administrator can allow it by name: IMPORT_ALLOW_HOSTS on the server.', 'address');

/**
 * An address someone gave, checked before anything is sent: a URL, https (or http to this machine
 * in tests), no name and password in it, and, when it is an IP address, one a4a may reach.
 */
export function checkAddress(policy: RemotePolicy, raw: string, example: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new RemoteError(`"${raw.trim().slice(0, 100)}" isn't a web address`, `Give its address, such as ${example}.`, 'address');
  }
  if (url.username || url.password) throw new RemoteError('The address has a name and password in it', 'Give the address alone, and the token in its own field.', 'address');
  const host = bare(url.hostname);
  if (url.protocol === 'http:') {
    const local = host === 'localhost' || (isIP(host) !== 0 && isLoopback(host));
    if (!(policy.allowHttpLoopback && local)) throw new RemoteError('a4a reads other trackers over https only', `Use https://${url.host}${url.pathname === '/' ? '' : url.pathname}.`, 'address');
  } else if (url.protocol !== 'https:') {
    throw new RemoteError(`a4a can't read from a ${url.protocol.replace(/:$/, '')} address`, `Give its https address, such as ${example}.`, 'address');
  }
  if (isIP(host) && !addressAllowed(policy, url, host)) throw insideError(host);
  return url;
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/** DNS as the connection is made, offering only the addresses a4a may reach. */
export function guardedLookup(policy: RemotePolicy, url: URL) {
  return (hostname: string, options: LookupOptions, callback: LookupCallback) => {
    dnsLookup(hostname, { ...options, all: true }, (err, found) => {
      if (err) return callback(err, '');
      const ok = (found as LookupAddress[]).filter((a) => addressAllowed(policy, url, a.address));
      if (!ok.length) {
        const blocked = Object.assign(new Error(`${hostname} is inside the network`), { code: 'A4A_INSIDE' }) as NodeJS.ErrnoException;
        return callback(blocked, '');
      }
      if (options.all) callback(null, ok);
      else callback(null, ok[0]!.address, ok[0]!.family);
    });
  };
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;
const MAX_JSON_BYTES = 64 * 1024 * 1024;
/** The longest a single Retry-After is waited out; asked for longer, the fetch stops and says when to carry on. */
const MAX_WAIT_MS = 10 * 60_000;
const SLOW_DOWN_TRIES = 8;
const NETWORK_TRIES = 3;

export interface RemoteHooks {
  /** Wait this long; a job keeps its heartbeat going meanwhile. */
  wait?(ms: number): Promise<void>;
}

export interface RemoteNames {
  /** What the person calls it: YouTrack, Jira. */
  name: string;
  /** Its address, as an example: https://example.youtrack.cloud */
  example: string;
  /** How to get a token it accepts. */
  authHint: string;
  /** What to check when it refuses a request as wrong (a query, a JQL). */
  badRequestHint: string;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function retryAfterMs(value: string | string[] | undefined): number | null {
  const v = Array.isArray(value) ? value[0] : value;
  if (!v) return null;
  if (/^\d+(\.\d+)?$/.test(v.trim())) return Math.round(Number(v) * 1000);
  const at = Date.parse(v);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

const TLS = /^(CERT_|ERR_TLS|ERR_SSL|UNABLE_TO_|DEPTH_ZERO|SELF_SIGNED)/;
const DROPPED = new Set(['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNABORTED', 'EAI_AGAIN', 'UND_ERR_SOCKET']);

/** The other tracker's words for a refusal, from its JSON: YouTrack's error_description, Jira's errorMessages. */
function theirWords(text: string): string | null {
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    if (typeof j.error_description === 'string' && j.error_description) return j.error_description;
    if (Array.isArray(j.errorMessages) && j.errorMessages.length) return j.errorMessages.filter((x) => typeof x === 'string').join(' ');
    if (j.errors && typeof j.errors === 'object') {
      const v = Object.values(j.errors as Record<string, unknown>).filter((x): x is string => typeof x === 'string');
      if (v.length) return v.join(' ');
    }
    if (typeof j.message === 'string' && j.message) return j.message;
    if (typeof j.error === 'string' && j.error) return j.error;
  } catch {
    // not JSON: say nothing of it
  }
  return null;
}

export interface Download {
  stream: Readable;
  /** Its size as the server says, when it does. */
  size: number | null;
  abort(): void;
}

export class Remote {
  private hooks: RemoteHooks = {};

  constructor(
    readonly base: URL,
    private readonly authorization: string,
    /** Strings that must never be shown: the token, and the header built from it. */
    private readonly secrets: string[],
    private readonly policy: RemotePolicy,
    readonly names: RemoteNames,
  ) {}

  setHooks(hooks: RemoteHooks): void {
    this.hooks = hooks;
  }

  wait(ms: number): Promise<void> {
    return this.hooks.wait ? this.hooks.wait(ms) : sleep(ms);
  }

  /** Its words with every secret taken out, kept short. */
  private scrub(text: string): string {
    let out = text;
    for (const s of this.secrets) if (s) out = out.split(s).join('…');
    return out.length > 300 ? `${out.slice(0, 299)}…` : out;
  }

  /** The address of a path under the base, with its query. */
  url(path: string, query: Record<string, string | number | null | undefined> = {}): URL {
    const url = new URL(`${this.base.pathname.replace(/\/$/, '')}${path}`, this.base.origin);
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    return url;
  }

  private send(url: URL, method: string, headers: Record<string, string>, body?: string): Promise<IncomingMessage> {
    return new Promise((resolve, reject) => {
      const mod = url.protocol === 'https:' ? https : http;
      const req = mod.request(
        url,
        {
          method,
          headers: { 'user-agent': 'a4a-importer', ...headers, ...(body !== undefined ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) } : {}) },
          lookup: guardedLookup(this.policy, url) as never,
          timeout: REQUEST_TIMEOUT_MS,
        },
        resolve,
      );
      req.on('timeout', () => req.destroy(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })));
      req.on('error', reject);
      if (body !== undefined) req.write(body);
      req.end();
    });
  }

  /** A request, following redirects by hand: each hop checked, the credentials kept to the origin they belong to. */
  private async open(url: URL, method: string, extra: Record<string, string>, body?: string): Promise<{ res: IncomingMessage; url: URL }> {
    let at = url;
    for (let hops = 0; ; hops++) {
      const own = at.origin === this.base.origin;
      const headers: Record<string, string> = { ...extra, ...(own ? { authorization: this.authorization } : {}) };
      const res = await this.send(at, method, headers, body);
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location && method === 'GET') {
        res.resume();
        if (hops >= MAX_REDIRECTS) throw new RemoteError(`${this.names.name} sent a4a round in circles (too many redirects)`, `Check the address: ${this.names.name}'s own, such as ${this.names.example}.`, 'shape', status);
        at = checkAddress(this.policy, new URL(res.headers.location, at).href, this.names.example);
        continue;
      }
      return { res, url: at };
    }
  }

  /** A failure to connect, in words. */
  private networkError(e: unknown, url: URL): RemoteError {
    const code = (e as NodeJS.ErrnoException | undefined)?.code ?? '';
    const host = url.host;
    if (e instanceof RemoteError) return e;
    if (code === 'A4A_INSIDE') return insideError(bare(url.hostname));
    if (code === 'ENOTFOUND') return new RemoteError(`a4a can't find ${host}`, `Check the address: ${this.names.name}'s own, such as ${this.names.example}.`, 'network');
    if (TLS.test(code)) {
      return new RemoteError(`a4a can't make a secure connection to ${host} (${code})`, "Its certificate isn't one the server trusts. NODE_EXTRA_CA_CERTS on the server adds a certificate authority.", 'network');
    }
    return new RemoteError(`${this.names.name} at ${host} doesn't answer${code ? ` (${code})` : ''}`, 'Check the address, and that the a4a server can reach it.', 'network');
  }

  /** A refusal, in words, with the other tracker's own words when it gave some. */
  private httpError(status: number, text: string, url: URL): RemoteError {
    const theirs = theirWords(text);
    const said = theirs ? `: ${this.scrub(theirs)}` : '';
    const name = this.names.name;
    if (status === 401) return new RemoteError(`${name} didn't accept the token`, this.names.authHint, 'auth', status);
    if (status === 403) return new RemoteError(`The token may not read that in ${name}${said}`, 'Use a token of an account that can see these issues there.', 'forbidden', status);
    if (status === 404) return new RemoteError(`${name} has nothing at ${url.pathname}${said}`, `Check the address: ${name}'s base address, such as ${this.names.example}.`, 'missing', status);
    if (status === 400 || status === 422) return new RemoteError(`${name} refused the request${said}`, this.names.badRequestHint, 'refused', status);
    if (status === 429) return new RemoteError(`${name} asks a4a to slow down, for longer than a4a waits`, 'Carry on later: what has been read so far is kept.', 'slow_down', status);
    return new RemoteError(`${name} answered ${status}${said}`, 'Try again later: what has been read so far is kept.', 'unavailable', status);
  }

  /**
   * Open a request, waiting out 429 and 503 as Retry-After asks, and trying again after a dropped
   * connection, a 502 or a 504. Returns the response of the first other answer.
   */
  private async attempt(url: URL, method: 'GET' | 'POST', headers: Record<string, string>, body?: string): Promise<{ res: IncomingMessage; url: URL }> {
    let slow = 0;
    let dropped = 0;
    for (;;) {
      let got: { res: IncomingMessage; url: URL };
      try {
        got = await this.open(url, method, headers, body);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException | undefined)?.code ?? '';
        if ((DROPPED.has(code) || /socket hang up/i.test((e as Error)?.message ?? '')) && dropped < NETWORK_TRIES) {
          await this.wait(1000 * 2 ** dropped++);
          continue;
        }
        throw this.networkError(e, url);
      }
      const status = got.res.statusCode ?? 0;
      // GitHub says it's out of requests with a 403, and when they come back (x-ratelimit-reset, in seconds
      // since 1970); its secondary limit, with a 403 and Retry-After.
      const spent = status === 403 && (got.res.headers['x-ratelimit-remaining'] === '0' || got.res.headers['retry-after'] !== undefined);
      if (status === 429 || status === 503 || spent) {
        const reset = Number(got.res.headers['x-ratelimit-reset']);
        const asked = retryAfterMs(got.res.headers['retry-after']) ?? (spent && Number.isFinite(reset) && reset > 0 ? Math.max(0, reset * 1000 - Date.now()) + 1000 : null);
        got.res.resume();
        const ms = asked ?? 1000 * 2 ** Math.min(slow, 6);
        if (slow < SLOW_DOWN_TRIES && ms <= MAX_WAIT_MS) {
          slow++;
          await this.wait(ms);
          continue;
        }
        const minutes = Math.ceil(ms / 60_000);
        throw new RemoteError(
          status === 503 ? `${this.names.name} is unavailable for now` : `${this.names.name} asks a4a to wait ${minutes} ${minutes === 1 ? 'minute' : 'minutes'} before reading more`,
          'Carry on later: what has been read so far is kept.',
          status === 503 ? 'unavailable' : 'slow_down',
          status,
        );
      }
      if ((status === 502 || status === 504) && dropped < NETWORK_TRIES) {
        got.res.resume();
        await this.wait(1000 * 2 ** dropped++);
        continue;
      }
      return got;
    }
  }

  /** JSON from a path under the base. */
  async json<T>(path: string, init: { method?: 'GET' | 'POST'; query?: Record<string, string | number | null | undefined>; body?: unknown } = {}): Promise<T> {
    const url = this.url(path, init.query);
    const method = init.method ?? 'GET';
    const { res, url: at } = await this.attempt(url, method, { accept: 'application/json' }, init.body === undefined ? undefined : JSON.stringify(init.body));
    const text = await this.text(res, at);
    const status = res.statusCode ?? 0;
    if (status >= 400) throw this.httpError(status, text, at);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new RemoteError(`${at.host} didn't answer as ${this.names.name} does`, `Check the address: ${this.names.name}'s base address, such as ${this.names.example}.`, 'shape', status);
    }
  }

  /**
   * JSON with the answer's headers (a Link to the next page, D46): from a path under the base, or
   * an address a page gave, which must be on the base's own origin.
   */
  async jsonWithHeaders<T>(pathOrHref: string, query: Record<string, string | number | null | undefined> = {}): Promise<{ data: T; headers: IncomingHttpHeaders }> {
    let url: URL;
    if (/^https?:\/\//i.test(pathOrHref)) {
      url = new URL(pathOrHref);
      if (url.origin !== this.base.origin) throw new RemoteError(`${this.names.name} pointed a4a elsewhere (${url.host})`, `Check the address: ${this.names.name}'s own, such as ${this.names.example}.`, 'shape');
    } else url = this.url(pathOrHref, query);
    const { res, url: at } = await this.attempt(url, 'GET', { accept: 'application/json' });
    const text = await this.text(res, at);
    const status = res.statusCode ?? 0;
    if (status >= 400) throw this.httpError(status, text, at);
    try {
      return { data: JSON.parse(text) as T, headers: res.headers };
    } catch {
      throw new RemoteError(`${at.host} didn't answer as ${this.names.name} does`, `Check the address: ${this.names.name}'s base address, such as ${this.names.example}.`, 'shape', status);
    }
  }

  private async text(res: IncomingMessage, url: URL): Promise<string> {
    const chunks: Buffer[] = [];
    let n = 0;
    try {
      for await (const chunk of res) {
        n += (chunk as Buffer).length;
        if (n > MAX_JSON_BYTES) {
          res.destroy();
          throw new RemoteError(`${this.names.name}'s answer was larger than ${MAX_JSON_BYTES / 1024 / 1024} MB`, 'Import fewer issues at a time: narrow the query.', 'too_large');
        }
        chunks.push(chunk as Buffer);
      }
    } catch (e) {
      throw this.networkError(e, url);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  /**
   * A file, as a stream: an absolute address, or a path on the tracker's own origin. The
   * credentials go along only while it stays on that origin.
   */
  async download(href: string): Promise<Download> {
    const url = checkAddress(this.policy, new URL(href, this.base.origin).href, this.names.example);
    const { res, url: at } = await this.attempt(url, 'GET', { accept: '*/*' });
    const status = res.statusCode ?? 0;
    if (status >= 400) {
      const text = await this.text(res, at).catch(() => '');
      throw this.httpError(status, text, at);
    }
    const length = Number(res.headers['content-length']);
    return { stream: res, size: Number.isFinite(length) && length >= 0 ? length : null, abort: () => res.destroy() };
  }
}

export type { IncomingHttpHeaders };
