/**
 * Signing in with a password an LDAP directory checks (D38), against a directory made for the
 * test: the account made at the first sign-in, groups from the directory, and each way it must fail.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ldapFromEnv, type LdapConfig } from '../src/config';
import { groupMembers, groups, userIdentities, users } from '../src/db/schema';
import { createHttpApp } from '../src/http/app';
import { newId } from '../src/lib/ids';
import { escapeFilter, nameFromDn } from '../src/services/ldap';
import { FakeDirectory } from './fake-ldap';
import { createWorld, type TestWorld } from './helpers';

const BASE = 'http://localhost:3999';
const dir = new FakeDirectory();
let w: TestWorld;
let app: ReturnType<typeof createHttpApp>;
let browsers = 0;

function ldapConfig(extra: Partial<LdapConfig> = {}): LdapConfig {
  return {
    url: dir.url,
    startTls: false,
    bindDn: dir.serviceDn,
    bindPassword: dir.servicePassword,
    baseDn: dir.base,
    userFilter: '(&(objectClass=person)(|(uid={login})(mail={login})))',
    loginAttribute: 'uid',
    emailAttribute: 'mail',
    nameAttribute: 'displayName',
    idAttribute: null,
    groupsAttribute: 'memberOf',
    groupBaseDn: null,
    groupFilter: '(|(member={dn})(uniqueMember={dn}))',
    groupNameAttribute: 'cn',
    caCerts: [],
    name: 'Corp directory',
    createUsers: true,
    trustEmail: false,
    allowedDomains: [],
    ...extra,
  };
}

async function signIn(login: string, password: string) {
  const res = await app.request('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.2.0.${(++browsers % 250) + 1}` },
    body: JSON.stringify({ login, password }),
  });
  return { status: res.status, body: JSON.parse(await res.text()) };
}

beforeAll(async () => {
  await dir.start();
  dir.entries = [
    {
      dn: 'uid=lena,ou=people,dc=corp,dc=test',
      password: 'lena-directory-pw',
      attributes: {
        objectClass: ['person', 'inetOrgPerson'],
        uid: 'lena',
        mail: 'lena@corp.test',
        displayName: 'Lena Lindqvist',
        entryUUID: '0b7c6a84-1111-4d3e-9a6e-2f2f2f2f2f2f',
        memberOf: ['cn=Platform,ou=groups,dc=corp,dc=test', 'cn=Everyone,ou=groups,dc=corp,dc=test'],
      },
    },
    { dn: 'uid=twin1,ou=people,dc=corp,dc=test', password: 'twin-pw', attributes: { objectClass: 'person', uid: 'twin', mail: 'twin1@corp.test' } },
    { dn: 'uid=twin2,ou=people,dc=corp,dc=test', password: 'twin-pw', attributes: { objectClass: 'person', uid: 'twin', mail: 'twin2@corp.test' } },
    { dn: 'cn=Platform,ou=groups,dc=corp,dc=test', attributes: { objectClass: 'groupOfNames', cn: 'Platform', member: 'uid=lena,ou=people,dc=corp,dc=test' } },
  ];
  w = await createWorld({ projects: false, config: { publicUrl: BASE, trustProxy: 1, secretKey: 'the test instance key', passwordLogin: true } });
  w.app.config.ldap = ldapConfig();
  app = createHttpApp(w.app);
});
afterAll(async () => {
  await w.close();
  await dir.stop();
});

describe('LDAP filters and names', () => {
  it('escapes what someone types, so it can’t widen a search', () => {
    expect(escapeFilter('*)(uid=*')).toBe('\\2a\\29\\28uid=\\2a');
    expect(escapeFilter('a\\b')).toBe('a\\5cb');
    expect(escapeFilter('anna')).toBe('anna');
  });
  it('reads a group’s name from its DN', () => {
    expect(nameFromDn('cn=Platform,ou=groups,dc=corp,dc=test')).toBe('Platform');
    expect(nameFromDn('CN=R\\, and D,OU=Groups,DC=corp')).toBe('R, and D');
    expect(nameFromDn('nonsense')).toBeNull();
  });
});

describe('signing in with the directory', () => {
  it('says so in the setup status, beside a4a’s own passwords', async () => {
    const status = JSON.parse(await (await app.request('/api/v1/auth/setup')).text());
    expect(status.signIn).toMatchObject({ password: true, ldap: { name: 'Corp directory' } });
  });

  it('makes the account at the first sign-in, with groups that follow the directory', async () => {
    const platform = { id: newId(), name: 'Platform team', providerName: 'Platform' };
    await w.app.db.insert(groups).values(platform);
    const res = await signIn('lena', 'lena-directory-pw');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ login: 'lena', name: 'Lena Lindqvist', email: 'lena@corp.test', role: 'member', auth: { method: 'session' } });
    // The service account searched; then a4a bound as Lena with what she typed.
    expect(dir.binds.slice(-2)).toEqual([
      { dn: dir.serviceDn, password: dir.servicePassword },
      { dn: 'uid=lena,ou=people,dc=corp,dc=test', password: 'lena-directory-pw' },
    ]);
    const [lena] = await w.app.db.select().from(users).where(eq(users.login, 'lena'));
    // Kept by the directory's id for her; her email isn't vouched for (LDAP_TRUST_EMAIL is off), and a4a holds no password.
    expect(lena!.passwordHash).toBeNull();
    expect(lena!.emailVerified).toBe(false);
    const [link] = await w.app.db.select().from(userIdentities).where(eq(userIdentities.userId, lena!.id));
    expect(link).toMatchObject({ provider: `ldap:${new URL(dir.url).host}`, subject: '0b7c6a84-1111-4d3e-9a6e-2f2f2f2f2f2f' });
    const members = await w.app.db.select().from(groupMembers).where(eq(groupMembers.groupId, platform.id));
    expect(members.map((m) => m.userId)).toEqual([lena!.id]);
    // "Everyone" has no group following it here, so nothing is made for it.
    expect((await w.app.db.select().from(groups)).map((g) => g.name)).toEqual(['Platform team']);
  });

  it('finds the same person again by the directory’s id, by login or email', async () => {
    dir.entries[0]!.attributes.displayName = 'Lena L.';
    const again = await signIn('lena@corp.test', 'lena-directory-pw');
    expect(again.status).toBe(200);
    expect(again.body.login).toBe('lena');
    expect((await w.app.db.select().from(users).where(eq(users.login, 'lena'))).length).toBe(1);
  });

  it('drops someone from a group the directory no longer has them in', async () => {
    dir.entries[0]!.attributes.memberOf = ['cn=Everyone,ou=groups,dc=corp,dc=test'];
    expect((await signIn('lena', 'lena-directory-pw')).status).toBe(200);
    const [platform] = await w.app.db.select().from(groups).where(eq(groups.providerName, 'Platform'));
    expect(await w.app.db.select().from(groupMembers).where(eq(groupMembers.groupId, platform!.id))).toEqual([]);
  });

  it('can find groups by a search instead of memberOf', async () => {
    w.app.config.ldap = ldapConfig({ groupsAttribute: null, groupBaseDn: 'ou=groups,dc=corp,dc=test' });
    try {
      expect((await signIn('lena', 'lena-directory-pw')).status).toBe(200);
      expect(dir.filters.at(-1)).toContain('member=uid=lena,ou=people,dc=corp,dc=test');
      const [platform] = await w.app.db.select().from(groups).where(eq(groups.providerName, 'Platform'));
      expect((await w.app.db.select().from(groupMembers).where(eq(groupMembers.groupId, platform!.id))).length).toBe(1);
    } finally {
      w.app.config.ldap = ldapConfig();
    }
  });

  it('refuses a wrong password, an empty one, a filter trick, and a name that is two people', async () => {
    const before = dir.binds.length;
    expect((await signIn('lena', 'wrong')).status).toBe(401);
    expect((await signIn('*', 'lena-directory-pw')).status).toBe(401);
    expect(dir.filters.at(-1)).toContain('uid=\\2a');
    expect((await signIn('lena)(uid=*', 'lena-directory-pw')).status).toBe(401);
    // Two people answer to "twin": no password is tried for either.
    const twins = dir.binds.length;
    expect((await signIn('twin', 'twin-pw')).status).toBe(401);
    expect(dir.binds.slice(twins).map((b) => b.dn)).toEqual([dir.serviceDn]);
    // Only the service account bound: no one was bound as with a guessed password but Lena.
    expect(dir.binds.slice(before).filter((b) => b.dn !== dir.serviceDn).map((b) => b.dn)).toEqual(['uid=lena,ou=people,dc=corp,dc=test']);
  });

  it('turns a new person away when accounts aren’t made at sign-in', async () => {
    dir.entries.push({ dn: 'uid=nils,ou=people,dc=corp,dc=test', password: 'nils-pw', attributes: { objectClass: 'person', uid: 'nils', mail: 'nils@corp.test' } });
    w.app.config.ldap = ldapConfig({ createUsers: false });
    try {
      const res = await signIn('nils', 'nils-pw');
      expect(res.status).toBe(403);
      expect(res.body.error.code).toMatch(/^sso_/);
    } finally {
      w.app.config.ldap = ldapConfig();
    }
  });

  it('says so when the directory can’t be reached, without saying more', async () => {
    w.app.config.ldap = ldapConfig({ url: 'ldap://127.0.0.1:1' });
    try {
      const res = await signIn('lena', 'lena-directory-pw');
      expect(res.status).toBe(502);
      expect(res.body.error).toMatchObject({ code: 'ldap_unreachable' });
      expect(JSON.stringify(res.body)).not.toContain('127.0.0.1');
    } finally {
      w.app.config.ldap = ldapConfig();
    }
  });

  it('still takes a4a’s own passwords first', async () => {
    const res = await signIn('admin', 'password-admin');
    expect(res.status).toBe(200);
    expect(res.body.login).toBe('admin');
  });

  it('keeps the form when a4a’s own passwords are off', async () => {
    w.app.config.passwordLogin = false;
    try {
      expect((await signIn('admin', 'password-admin')).status).toBe(401);
      expect((await signIn('lena', 'lena-directory-pw')).status).toBe(200);
    } finally {
      w.app.config.passwordLogin = true;
    }
  });
});

describe('LDAP settings', () => {
  const env = (extra: Record<string, string>) => ({ ldap: ldapFromEnv({ LDAP_BASE_DN: 'dc=corp,dc=test', ...extra }) });
  it('take ldaps, or plain ldap only with StartTLS or to this machine', () => {
    expect(env({ LDAP_URL: 'ldaps://dc.corp.test' }).ldap).toMatchObject({ url: 'ldaps://dc.corp.test', startTls: false, name: 'dc.corp.test' });
    expect(env({ LDAP_URL: 'ldap://dc.corp.test', LDAP_STARTTLS: 'true' }).ldap).toMatchObject({ startTls: true });
    expect(env({ LDAP_URL: 'ldap://127.0.0.1:389' }).ldap).toMatchObject({ startTls: false });
    expect(() => env({ LDAP_URL: 'ldap://dc.corp.test' })).toThrow(/StartTLS|LDAP_STARTTLS/);
    expect(() => env({ LDAP_URL: 'https://dc.corp.test' })).toThrow();
    expect(() => env({ LDAP_URL: 'ldaps://dc.corp.test', LDAP_USER_FILTER: '(uid=x)' })).toThrow(/\{login\}/);
    expect(env({}).ldap).toBeNull();
  });
});
