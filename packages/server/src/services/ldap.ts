/**
 * Signing in with a password an LDAP directory checks (docs/architecture.md, D38).
 *
 * - a4a binds as its service account (or anonymously), finds the one person the filter names, and
 *   binds as them with the password they typed. That bind is the check: a4a never sees their hash.
 * - An empty password is refused before anything is sent: many directories take a bind with a name
 *   and no password as an anonymous one, and it would "succeed".
 * - What they typed goes into the filter escaped (RFC 4515), so it can't widen the search.
 * - Over ldaps, or StartTLS; plain ldap only to this machine (config refuses it otherwise).
 * - The person is found as single sign-on finds them (services/sso.ts): by the directory's stable
 *   id for them, the first time by an email the directory vouches for (LDAP_TRUST_EMAIL), and
 *   groups from the directory fill the groups that follow the provider (D27).
 */
import { Client, InvalidCredentialsError, type Entry } from 'ldapts';
import type { AppServices } from '../context';
import type { LdapConfig } from '../config';
import { AppError } from '../lib/errors';
import { syncProviderGroups } from './groups';
import type { UserRow } from './schema-cache';
import { personFromProvider } from './sso';

const TIMEOUT_MS = 10_000;

/** A value for an LDAP filter, escaped (RFC 4515): it can't open or close a clause, or match all. */
export function escapeFilter(value: string): string {
  return value.replace(/[\\*()\u0000]/g, (ch) => `\\${ch.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

/** Where identities from this directory are kept. */
export function ldapKey(cfg: LdapConfig): string {
  return `ldap:${new URL(cfg.url).host}`;
}

function client(cfg: LdapConfig): Client {
  const tlsOptions = cfg.caCerts.length ? { ca: cfg.caCerts } : undefined;
  return new Client({ url: cfg.url, timeout: TIMEOUT_MS, connectTimeout: TIMEOUT_MS, tlsOptions });
}

async function open(cfg: LdapConfig): Promise<Client> {
  const c = client(cfg);
  if (cfg.startTls) await c.startTLS(cfg.caCerts.length ? { ca: cfg.caCerts } : {});
  return c;
}

function first(entry: Entry, attribute: string): string | null {
  const v = entry[attribute] ?? entry[Object.keys(entry).find((k) => k.toLowerCase() === attribute.toLowerCase()) ?? ''];
  const one = Array.isArray(v) ? v[0] : v;
  if (one === undefined || one === null) return null;
  return Buffer.isBuffer(one) ? one.toString('utf8') : String(one);
}

function all(entry: Entry, attribute: string): string[] {
  const v = entry[attribute] ?? entry[Object.keys(entry).find((k) => k.toLowerCase() === attribute.toLowerCase()) ?? ''];
  const list = Array.isArray(v) ? v : v === undefined || v === null ? [] : [v];
  return list.map((x) => (Buffer.isBuffer(x) ? x.toString('utf8') : String(x)));
}

/** A person's stable id there: objectGUID (binary, as hex), entryUUID, or their DN, lower-cased. */
function idOf(cfg: LdapConfig, entry: Entry): string {
  for (const attr of [cfg.idAttribute, 'objectGUID', 'entryUUID'].filter((a): a is string => Boolean(a))) {
    const key = Object.keys(entry).find((k) => k.toLowerCase() === attr.toLowerCase());
    const v = key ? entry[key] : undefined;
    const one = Array.isArray(v) ? v[0] : v;
    if (Buffer.isBuffer(one) && one.length) return one.toString('hex');
    if (typeof one === 'string' && one.trim()) return one.trim().toLowerCase();
  }
  return entry.dn.toLowerCase();
}

/** A group's name from its DN: the value of its first part (cn=Platform,ou=Groups → Platform). */
export function nameFromDn(dn: string): string | null {
  const m = /^\s*[a-zA-Z0-9.-]+\s*=\s*((?:\\.|[^,\\])+)/.exec(dn);
  return m ? m[1]!.replace(/\\(.)/g, '$1').trim() : null;
}

const unreachable = (cfg: LdapConfig) =>
  new AppError(502, 'ldap_unreachable', `a4a can't reach ${cfg.name} right now`, 'Try again in a moment; if it goes on, an administrator can look at LDAP_URL and the service account.');

export interface DirectoryPerson {
  dn: string;
  id: string;
  login: string | null;
  email: string | null;
  name: string | null;
  groups: string[];
}

/**
 * The person whose password this is, as the directory has them; null when the directory has no
 * such person, or the password isn't theirs.
 */
export async function directoryPerson(cfg: LdapConfig, login: string, password: string): Promise<DirectoryPerson | null> {
  const typed = login.trim();
  if (!typed || !password) return null;
  let search: Client;
  try {
    search = await open(cfg);
    if (cfg.bindDn) await search.bind(cfg.bindDn, cfg.bindPassword ?? '');
  } catch (e) {
    console.warn(`LDAP: can't bind as the service account: ${(e as Error).message}`);
    throw unreachable(cfg);
  }
  try {
    const wanted = [cfg.loginAttribute, cfg.emailAttribute, cfg.nameAttribute, 'cn', 'givenName', 'sn', 'objectGUID', 'entryUUID'];
    if (cfg.idAttribute) wanted.push(cfg.idAttribute);
    if (cfg.groupsAttribute) wanted.push(cfg.groupsAttribute);
    const { searchEntries } = await search.search(cfg.baseDn, {
      scope: 'sub',
      filter: cfg.userFilter.split('{login}').join(escapeFilter(typed)),
      attributes: [...new Set(wanted)],
      explicitBufferAttributes: ['objectGUID'],
      sizeLimit: 2,
    });
    // Nobody, or more than one: the filter doesn't name one person, and no password is tried.
    if (searchEntries.length !== 1) return null;
    const entry = searchEntries[0]!;
    // The check: bind as them, with what they typed, on a connection of its own.
    const asThem = await open(cfg);
    try {
      await asThem.bind(entry.dn, password);
    } catch (e) {
      if (e instanceof InvalidCredentialsError) return null;
      throw e;
    } finally {
      await asThem.unbind().catch(() => {});
    }
    let groups: string[] = [];
    if (cfg.groupsAttribute) {
      groups = all(entry, cfg.groupsAttribute)
        .map(nameFromDn)
        .filter((n): n is string => Boolean(n));
    } else if (cfg.groupBaseDn) {
      const found = await search.search(cfg.groupBaseDn, {
        scope: 'sub',
        filter: cfg.groupFilter.split('{dn}').join(escapeFilter(entry.dn)),
        attributes: [cfg.groupNameAttribute],
      });
      groups = found.searchEntries.map((g) => first(g, cfg.groupNameAttribute)).filter((n): n is string => Boolean(n));
    }
    const name = first(entry, cfg.nameAttribute) ?? first(entry, 'cn') ?? ([first(entry, 'givenName'), first(entry, 'sn')].filter(Boolean).join(' ') || null);
    return {
      dn: entry.dn,
      id: idOf(cfg, entry),
      login: first(entry, cfg.loginAttribute),
      email: first(entry, cfg.emailAttribute)?.toLowerCase() ?? null,
      name,
      groups,
    };
  } catch (e) {
    if (e instanceof AppError) throw e;
    console.warn(`LDAP: a search or bind failed: ${(e as Error).message}`);
    throw unreachable(cfg);
  } finally {
    await search.unbind().catch(() => {});
  }
}

/**
 * Sign in with the directory: the a4a person its entry is, found or made as single sign-on does,
 * with their groups from the directory. Null when the directory doesn't take the password.
 */
export async function ldapSignIn(app: AppServices, cfg: LdapConfig, login: string, password: string): Promise<UserRow | null> {
  const person = await directoryPerson(cfg, login, password);
  if (!person) return null;
  const user = await personFromProvider(
    app,
    // Like SAML, the directory's own id links them, so someone new may get an account whose email stays unconfirmed.
    { key: ldapKey(cfg), name: cfg.name, allowedDomains: cfg.allowedDomains, createUsers: cfg.createUsers, createWithUnverifiedEmail: true },
    { subject: person.id, email: person.email, emailVerified: person.email !== null && cfg.trustEmail, login: person.login ?? login.trim(), name: person.name },
  );
  if (cfg.groupsAttribute || cfg.groupBaseDn) await syncProviderGroups(app, user.id, person.groups);
  return user;
}
