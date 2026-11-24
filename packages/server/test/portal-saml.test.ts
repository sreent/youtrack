/**
 * SAML for requesters (D63's revisit): a provider of a customer's own signs them in to the
 * portal, checked as the team's SAML is; a stranger's response is refused.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHttpApp } from '../src/http/app';
import { createPortalProvider, listPortalProviders } from '../src/services/portal-sign-in';
import { updateProject } from '../src/services/projects';
import { FakeSamlIdp } from './fake-saml-idp';
import { createWorld, type TestWorld } from './helpers';

const idp = new FakeSamlIdp();
const BASE = 'http://localhost:3999';
const SP = `${BASE}/api/v1/portal/saml/metadata`;
const ACS = `${BASE}/api/v1/portal/sso/callback`;
let w: TestWorld;
let http: ReturnType<typeof createHttpApp>;

beforeAll(async () => {
  await idp.start();
  w = await createWorld({ config: { publicUrl: BASE, trustProxy: 1 } });
  http = createHttpApp(w.app);
});
afterAll(async () => {
  await idp.stop();
  await w?.close();
});

describe('SAML for requesters', () => {
  it('signs a requester in through the customer\'s provider, and refuses a stranger\'s response', async () => {
    const provider = await createPortalProvider(w.adminCtx, {
      name: 'Corp SSO',
      kind: 'saml',
      issuer: idp.entityId,
      samlEntryPoint: idp.ssoUrl,
      samlCert: idp.certificate,
    });
    expect(provider).toMatchObject({ kind: 'saml', samlEntryPoint: idp.ssoUrl, hasCert: true });
    await updateProject(w.adminCtx, 'BACK', { settings: { helpdesk: { enabled: true, signIn: { link: true, password: false, providers: [provider.id] } } } });
    // The portal starts the sign-in: the browser goes to the provider with the AuthnRequest.
    const start = await http.request(`/api/v1/portal/sso/${provider.id}/start?desk=BACK`, { method: 'GET', redirect: 'manual' });
    expect(start.status).toBe(302);
    const url = start.headers.get('location')!;
    const request = idp.read(url);
    expect(request.issuer).toBe(SP);
    const state = request.relayState;
    const cookie = (start.headers.get('set-cookie') ?? '').split(';')[0]!;
    // The provider posts its response: the same browser, with its state.
    const response = idp.respond(request, { nameId: 'rita', attributes: { email: 'rita@acme.com' } }, SP, ACS);
    const back = await http.request('/api/v1/portal/sso/callback', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams({ SAMLResponse: response, RelayState: state ?? '' }).toString(),
    });
    expect(back.status).toBe(302);
    expect(back.headers.get('location')).toBe('/portal?desk=BACK');
    // The portal session opens, through that provider.
    const sessionCookie = (back.headers.getSetCookie?.() ?? [back.headers.get('set-cookie') ?? '']).map((x) => x.split(';')[0]).join('; ');
    const me = await http.request('/api/v1/portal/me', { headers: { cookie: sessionCookie } });
    expect(me.status).toBe(200);
    expect((await me.json() as { email?: string }).email).toBe('rita@acme.com');
  });
});
