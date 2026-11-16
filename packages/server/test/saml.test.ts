/**
 * SAML 2.0 sign-in (D27) against a provider made for the test: the good paths, each way a
 * response must be refused (signatures, wrapping, audience, endpoint, time, replay, the browser it
 * comes back to), and the groups it puts people in.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createRuntime, type Runtime } from '../src/app-services';
import { loadConfig, type SamlConfig } from '../src/config';
import { openDatabase, type Database } from '../src/db/client';
import { groupMembers, groups, users } from '../src/db/schema';
import { createHttpApp } from '../src/http/app';
import { parseIdpMetadata } from '../src/services/saml';
import { newId } from '../src/lib/ids';
import { FakeSamlIdp, type SamlMisbehaviour, type SamlPerson } from './fake-saml-idp';
import { freshPostgres } from './helpers';

const BASE = 'http://localhost:3999';
const SP = `${BASE}/api/v1/auth/saml/metadata`;
const ACS = `${BASE}/api/v1/auth/saml/acs`;
const idp = new FakeSamlIdp();
let runtime: Runtime;
let database: Database;
let pg: Awaited<ReturnType<typeof freshPostgres>>;
let app: ReturnType<typeof createHttpApp>;
let adminCookie = '';

function saml(extra: Partial<SamlConfig> = {}): SamlConfig {
  return {
    name: 'Corp SAML',
    idpMetadataUrl: `${idp.url}/metadata`,
    idpEntityId: null,
    idpSsoUrl: null,
    idpCerts: [],
    spEntityId: SP,
    acsUrl: ACS,
    nameIdFormat: null,
    emailAttribute: null,
    nameAttribute: null,
    groupsAttribute: 'memberOf',
    trustEmail: false,
    allowedDomains: [],
    createUsers: true,
    allowIdpInitiated: false,
    ...extra,
  };
}

const cookieOf = (res: Response, name: string) => {
  const all = res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie') ?? ''];
  const hit = all.find((c) => c.startsWith(`${name}=`));
  return hit ? hit.split(';')[0]! : '';
};
const setCookieLine = (res: Response, name: string) => (res.headers.getSetCookie?.() ?? []).find((c) => c.startsWith(`${name}=`)) ?? '';

let browsers = 0;

/** Start a sign-in, from an address of its own: where the browser is sent, and the cookie it carries. */
async function begin(next?: string) {
  const res = await app.request(`/api/v1/auth/saml/start${next ? `?next=${encodeURIComponent(next)}` : ''}`, { headers: { 'x-forwarded-for': `10.1.${Math.floor(++browsers / 250)}.${browsers % 250}` } });
  expect(res.status).toBe(302);
  return { location: res.headers.get('location')!, cookie: cookieOf(res, 'a4a_saml'), res };
}

/** Post a response to the assertion consumer, as the browser does when the provider sends it back. */
async function post(samlResponse: string, cookie: string, relayState?: string) {
  const form = new URLSearchParams({ SAMLResponse: samlResponse });
  if (relayState !== undefined) form.set('RelayState', relayState);
  const res = await app.request('/api/v1/auth/saml/acs', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) },
    body: form.toString(),
  });
  return { status: res.status, location: res.headers.get('location') ?? '', session: cookieOf(res, 'a4a_session') };
}

/** A whole sign-in as `person`; `tamper` gets the provider to misbehave once. */
async function signIn(person: SamlPerson, opts: { next?: string; tamper?: SamlMisbehaviour } = {}) {
  const start = await begin(opts.next);
  const request = idp.read(start.location);
  if (opts.tamper) idp.next = opts.tamper;
  return { ...(await post(idp.respond(request, person, SP, ACS), start.cookie)), request, cookie: start.cookie };
}

async function me(session: string) {
  const res = await app.request('/api/v1/me', { headers: { cookie: session } });
  return { status: res.status, body: res.status === 200 ? JSON.parse(await res.text()) : null };
}

const person = (n: string, extra: Partial<SamlPerson> = {}): SamlPerson => ({
  nameId: `id-${n}`,
  attributes: { email: `${n}@corp.com`, displayName: `${n[0]!.toUpperCase()}${n.slice(1)} Example` },
  ...extra,
});

beforeAll(async () => {
  await idp.start();
  const config = loadConfig({ aiEnabled: false, seedDemo: false, publicUrl: BASE, webDist: undefined, saml: saml(), oidc: null, passwordLogin: true, trustProxy: 1 });
  pg = await freshPostgres();
  database = await openDatabase(pg ? { url: pg.url } : { memory: true });
  runtime = await createRuntime(config, database);
  app = createHttpApp(runtime);
  const setup = await app.request('/api/v1/auth/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login: 'ada', name: 'Ada Admin', email: 'ada@corp.com', password: 'correct horse battery', seedDemo: false }),
  });
  adminCookie = cookieOf(setup, 'a4a_session');
});

beforeEach(() => {
  runtime.config.saml = saml();
  idp.next = {};
});

afterAll(async () => {
  await database?.close();
  await pg?.drop();
  await idp.stop();
});

describe('signing in with SAML', () => {
  it('says on the sign-in page that it can, and publishes its own metadata', async () => {
    const status = await (await app.request('/api/v1/auth/setup')).json();
    expect(status).toMatchObject({ signIn: { password: true, sso: null, saml: { name: 'Corp SAML', url: '/api/v1/auth/saml/start' } } });
    const res = await app.request('/api/v1/auth/saml/metadata');
    expect(res.headers.get('content-type')).toMatch(/samlmetadata\+xml/);
    const xml = await res.text();
    expect(xml).toContain(`entityID="${SP}"`);
    expect(xml).toMatch(new RegExp(`AssertionConsumerService[^>]*Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"[^>]*Location="${ACS}"`));
  });

  it('sends the browser with an AuthnRequest naming this endpoint, tied to the browser by a cookie', async () => {
    const { location, cookie, res } = await begin();
    const request = idp.read(location);
    expect(request).toMatchObject({ acsUrl: ACS, issuer: SP, destination: idp.ssoUrl });
    expect(request.id).toMatch(/^_[0-9a-f]{40}$/);
    expect(cookie).toMatch(/^a4a_saml=.{40,}/);
    // Plain http here (development), so Lax; over https it is SameSite=None; Secure, for the provider's post.
    expect(setCookieLine(res, 'a4a_saml')).toMatch(/HttpOnly/i);
    expect(setCookieLine(res, 'a4a_saml')).toMatch(/Path=\/api\/v1\/auth\/saml/);
    expect(setCookieLine(res, 'a4a_saml')).toMatch(/SameSite=Lax/i);
  });

  it('signs a new person in, with an account of their own, and back where they started', async () => {
    const res = await signIn(person('nia'), { next: '/issues/BACK-1' });
    expect(res).toMatchObject({ status: 302, location: '/issues/BACK-1' });
    expect(res.session).toMatch(/^a4a_session=/);
    const who = await me(res.session);
    expect(who.body).toMatchObject({ login: 'nia', name: 'Nia Example', email: 'nia@corp.com', role: 'member' });
    // The provider doesn't vouch for emails here (SAML_TRUST_EMAIL is off): the email stays unconfirmed.
    const [row] = await database.db.select().from(users).where(eq(users.login, 'nia'));
    expect(row!.emailVerified).toBe(false);
    // Administrators see how they sign in.
    const people = (await (await app.request('/api/v1/users', { headers: { cookie: adminCookie } })).json()) as { login: string; signIn?: unknown }[];
    expect(people.find((u) => u.login === 'nia')!.signIn).toMatchObject({ emailConfirmed: false, identities: [{ provider: 'Corp SAML', email: 'nia@corp.com' }] });
  });

  it('finds them by their NameID the next time, whatever their email says', async () => {
    const again = await signIn(person('nia', { attributes: { email: 'nia.new@corp.com' } }));
    expect((await me(again.session)).body.login).toBe('nia');
  });

  it('takes a response signed as a whole, its assertion unsigned', async () => {
    const res = await signIn(person('olu'), { tamper: { sign: 'response' } });
    expect(res.location).toBe('/issues');
    expect((await me(res.session)).body.login).toBe('olu');
  });

  it('reads a provider set out by hand, without metadata', async () => {
    runtime.config.saml = saml({ idpMetadataUrl: null, idpEntityId: idp.entityId, idpSsoUrl: idp.ssoUrl, idpCerts: [idp.certificate] });
    const res = await signIn(person('pia'));
    expect((await me(res.session)).body.login).toBe('pia');
  });

  it('links an existing account by email only when the provider is trusted for it, and the account’s email confirmed', async () => {
    const make = async (login: string, email: string, verified: boolean) =>
      database.db.insert(users).values({ id: newId(), login, name: login, email, emailVerified: verified, avatarColor: '#000', role: 'member' });
    await make('quinn', 'quinn@corp.com', true);
    await make('ravi', 'ravi@corp.com', false);
    // Not trusted: an email links nothing, and gives nobody a second account with it.
    expect((await signIn(person('quinn'))).location).toBe('/login?sso=unlinked');
    runtime.config.saml = saml({ trustEmail: true });
    const linked = await signIn(person('quinn'));
    expect((await me(linked.session)).body.login).toBe('quinn');
    // Trusted, but the account's own email was never confirmed: someone typed it for themselves.
    expect((await signIn(person('ravi'))).location).toBe('/login?sso=unconfirmed');
  });

  it('gives no account to someone unknown when accounts are not made on first sign-in', async () => {
    runtime.config.saml = saml({ createUsers: false });
    expect((await signIn(person('sam'))).location).toBe('/login?sso=no_account');
  });

  it('makes one account when the same new person comes back twice at once', async () => {
    const [a, b] = [await begin(), await begin()];
    const answers = [idp.respond(idp.read(a.location), person('tess'), SP, ACS), idp.respond(idp.read(b.location), person('tess'), SP, ACS)];
    const done = await Promise.all([post(answers[0]!, a.cookie), post(answers[1]!, b.cookie)]);
    expect(done.map((d) => d.status)).toEqual([302, 302]);
    expect((await database.db.select().from(users).where(eq(users.login, 'tess'))).length).toBe(1);
    expect((await me(done[0]!.session)).body.login).toBe('tess');
    expect((await me(done[1]!.session)).body.login).toBe('tess');
  });

  it('puts them in the groups from the provider the attribute names, at every sign-in', async () => {
    const eng = newId();
    const byHand = newId();
    await database.db.insert(groups).values([
      { id: eng, name: 'Engineering', providerName: 'eng' },
      { id: byHand, name: 'eng-by-hand' },
    ]);
    const first = await signIn(person('uma', { attributes: { email: 'uma@corp.com', memberOf: ['ENG', 'eng-by-hand', 'unknown'] } }));
    const uma = (await me(first.session)).body;
    const inGroup = async (groupId: string) => (await database.db.select().from(groupMembers).where(eq(groupMembers.groupId, groupId))).some((m) => m.userId === uma.id);
    expect([await inGroup(eng), await inGroup(byHand)]).toEqual([true, false]);
    // Next time the provider no longer names it.
    await signIn(person('uma', { attributes: { email: 'uma@corp.com', memberOf: 'other' } }));
    expect(await inGroup(eng)).toBe(false);
  });
});

describe('each way a response must be refused', () => {
  const refused = async (tamper: SamlMisbehaviour, why = 'failed') => {
    const res = await signIn(person('vic'), { tamper });
    expect(res).toMatchObject({ status: 302, location: `/login?sso=${why}`, session: '' });
  };

  it('nothing signed', () => refused({ sign: 'none' }));
  it('signed with a key the provider never published', () => refused({ wrongKey: true }));
  it('signed as a whole with a key the provider never published', () => refused({ sign: 'response', wrongKey: true }));
  it('for another service (its audience)', () => refused({ audience: 'https://other.example.test/sp' }));
  it('for another endpoint (its Recipient)', () => refused({ recipient: 'https://other.example.test/acs' }));
  it('posted for another endpoint (its Destination)', () => refused({ destination: 'https://other.example.test/acs' }));
  it('from another provider (its issuer)', () => refused({ issuer: 'https://evil.example.test/saml' }));
  it('past its time, beyond the minute clocks may differ', () => refused({ expiresIn: -120 }));
  it('not yet good, beyond that minute', () => refused({ startsIn: 120 }));

  it('within that minute either way, taken', async () => {
    const res = await signIn(person('wes'), { tamper: { expiresIn: -30, startsIn: 30 } });
    expect((await me(res.session)).body.login).toBe('wes');
  });

  it('an answer to a request a4a never made', () => refused({ inResponseTo: '_not-a-request-of-ours' }, 'expired'));

  it('the same response a second time', async () => {
    const first = await signIn(person('xan'));
    expect(first.session).not.toBe('');
    const res = await signIn(person('xan'));
    // Its request is taken: posting it again, even from the same browser, is refused.
    const again = await post(idp.respond(res.request, person('xan'), SP, ACS), res.cookie);
    expect(again).toMatchObject({ location: '/login?sso=expired', session: '' });
  });

  it('the response to a sign-in another browser started', async () => {
    const mine = await begin();
    const theirs = await begin();
    const res = await post(idp.respond(idp.read(theirs.location), person('yan'), SP, ACS), mine.cookie);
    expect(res).toMatchObject({ location: '/login?sso=expired', session: '' });
  });

  it('a sign-in the provider started, unless it is allowed', async () => {
    const unsolicited = () => idp.respond(null, person('zed'), SP, ACS);
    expect(await post(unsolicited(), '')).toMatchObject({ location: '/login?sso=expired', session: '' });
    runtime.config.saml = saml({ allowIdpInitiated: true });
    const allowed = await post(unsolicited(), '', '/boards');
    expect(allowed.location).toBe('/boards');
    expect((await me(allowed.session)).body.login).toBe('zed');
    // Allowed or not, an assertion is taken once.
    const once = unsolicited();
    expect((await post(once, '')).session).not.toBe('');
    expect(await post(once, '')).toMatchObject({ location: '/login?sso=expired', session: '' });
    // And a way back that leads off the site goes to the issues instead.
    expect((await post(unsolicited(), '', 'https://evil.example.test/')).location).toBe('/issues');
  });

  it('the provider saying no', async () => {
    const start = await begin();
    const res = await post(idp.refuse(idp.read(start.location), ACS), start.cookie);
    expect(res).toMatchObject({ location: '/login?sso=cancelled', session: '' });
  });

  describe('a signed assertion wrapped around, or beside, one an attacker wrote', () => {
    const evil = (xml: string, assertionId = '_evil') =>
      xml
        .replace(/^[\s\S]*?(<saml:Assertion[\s\S]*<\/saml:Assertion>)[\s\S]*$/, '$1')
        .replace(/<ds:Signature[\s\S]*<\/ds:Signature>/, '')
        .replace(/ID="[^"]*"/, `ID="${assertionId}"`)
        .replace(/id-mallet/g, 'id-mallory')
        .replace(/mallet@corp\.com/g, 'mallory@corp.com');
    const signed = (xml: string) => /(<saml:Assertion[\s\S]*<\/saml:Assertion>)/.exec(xml)![1]!;
    const signedId = (xml: string) => /<saml:Assertion[^>]* ID="([^"]*)"/.exec(xml)![1]!;

    /** Sign in as mallet, rework the response, and make sure mallory never gets a session. */
    const attempt = async (rework: (xml: string) => string) => {
      await database.db.insert(users).values({ id: newId(), login: `mallory${browsers}`, name: 'Mallory', email: 'mallory@corp.com', emailVerified: true, avatarColor: '#000', role: 'admin' }).onConflictDoNothing();
      const res = await signIn(person('mallet'), { tamper: { tamper: rework } });
      if (res.session) expect((await me(res.session)).body.login).toBe('mallet');
      else expect(res.location).toBe('/login?sso=failed');
      return res;
    };

    it('beside it: a second assertion in the response', async () => {
      const res = await attempt((xml) => xml.replace('</samlp:Response>', `${evil(xml)}</samlp:Response>`));
      expect(res.session).toBe('');
    });

    it('in its place, the signed one moved into Extensions under the same id', async () => {
      await attempt((xml) => {
        const original = signed(xml);
        const fake = evil(xml, signedId(xml)).replace('</saml:Issuer>', `</saml:Issuer>${/<ds:Signature[\s\S]*<\/ds:Signature>/.exec(original)![0]}`);
        return xml.replace(original, fake).replace('<samlp:Status>', `<samlp:Extensions>${original}</samlp:Extensions><samlp:Status>`);
      });
    });

    it('around it: the signed one inside the attacker’s Advice', async () => {
      await attempt((xml) => {
        const original = signed(xml);
        const fake = evil(xml).replace('</saml:Issuer>', `</saml:Issuer><saml:Advice>${original}</saml:Advice>`);
        return xml.replace(original, fake);
      });
    });

    it('a comment that cuts the NameID short', async () => {
      // The provider signed "id-mallet.evil": a comment changes no signature, and must change no identity.
      await database.db.insert(users).values({ id: newId(), login: 'mallet-victim', name: 'Victim', email: 'victim@corp.com', avatarColor: '#000', role: 'admin' });
      const victim = await signIn({ nameId: 'id-victim', attributes: { email: 'victim2@corp.com' } });
      expect(victim.session).not.toBe('');
      const res = await signIn({ nameId: 'id-victim.evil', attributes: { email: 'evil@corp.com' } }, { tamper: { tamper: (xml) => xml.replace('>id-victim.evil<', '>id-victim<!---->.evil<') } });
      if (res.session) expect((await me(res.session)).body.login).not.toBe((await me(victim.session)).body.login);
    });
  });

  it('too many sign-ins started from one address', async () => {
    let last = 0;
    for (let i = 0; i < 31; i++) last = (await app.request('/api/v1/auth/saml/start', { headers: { 'x-forwarded-for': '10.9.9.9' } })).status;
    expect(last).toBe(429);
  });
});

describe("the provider's metadata", () => {
  it('gives who it is, where requests go, and only the certificates it signs with', () => {
    const read = parseIdpMetadata(idp.metadata());
    expect(read).toEqual({ entityId: idp.entityId, ssoUrl: idp.ssoUrl, certs: [idp.certificate] });
    expect(() => parseIdpMetadata('<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="x"/>')).toThrow(/no identity provider/);
    expect(() => parseIdpMetadata(idp.metadata(), 'https://someone.else/')).toThrow(/no identity provider https:\/\/someone.else/);
  });
});
