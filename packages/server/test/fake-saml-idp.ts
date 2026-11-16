/**
 * A small SAML 2.0 identity provider for tests: its metadata at a URL, a signing key and a
 * certificate made when it starts, and responses to a4a's AuthnRequests signed as a real provider
 * signs them (xml-crypto, exclusive canonicalisation, RSA-SHA256). A test plays the person's part,
 * and can make the provider misbehave in one way at a time.
 */
// @peculiar/x509 needs it loaded before itself.
import 'reflect-metadata';
import { randomBytes, webcrypto } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { inflateRawSync } from 'node:zlib';
import * as x509 from '@peculiar/x509';
import { SignedXml } from 'xml-crypto';

x509.cryptoProvider.set(webcrypto as unknown as Crypto);

export interface SamlPerson {
  nameId: string;
  nameIdFormat?: string;
  attributes?: Record<string, string | string[]>;
}

/** One way to get the next response wrong. */
export interface SamlMisbehaviour {
  /** What carries the signature: the assertion (as most providers do), the whole response, or nothing. */
  sign?: 'assertion' | 'response' | 'none';
  /** Sign with a key whose certificate the provider never published. */
  wrongKey?: boolean;
  audience?: string;
  recipient?: string;
  destination?: string;
  issuer?: string;
  /** Seconds from now that the assertion stops being good (negative: already past). */
  expiresIn?: number;
  /** Seconds from now that it starts being good. */
  startsIn?: number;
  /** Answer another request id, or none at all (null), as a provider starting the sign-in itself does. */
  inResponseTo?: string | null;
  /** Rework the signed response's XML before it is sent: an attacker's edits. */
  tamper?: (xml: string) => string;
}

interface KeyPair {
  keyPem: string;
  certPem: string;
  certBody: string;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const instant = (offsetSeconds = 0) => new Date(Date.now() + offsetSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const id = () => `_${randomBytes(16).toString('hex')}`;

async function makeKeyPair(name: string): Promise<KeyPair> {
  const alg = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256', publicExponent: new Uint8Array([1, 0, 1]), modulusLength: 2048 };
  const keys = (await webcrypto.subtle.generateKey(alg, true, ['sign', 'verify'])) as CryptoKeyPair;
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: randomBytes(8).toString('hex'),
    name: `CN=${name}`,
    notBefore: new Date(Date.now() - 86_400_000),
    notAfter: new Date(Date.now() + 365 * 86_400_000),
    signingAlgorithm: alg,
    keys,
  });
  const pkcs8 = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', keys.privateKey));
  const keyPem = `-----BEGIN PRIVATE KEY-----\n${pkcs8.toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END PRIVATE KEY-----\n`;
  const certPem = cert.toString('pem');
  return { keyPem, certPem, certBody: cert.toString('base64') };
}

/** Sign the element the XPath names, the signature placed after its Issuer, as SAML's schema wants. */
function sign(xml: string, element: 'Assertion' | 'Response', pair: KeyPair): string {
  const sig = new SignedXml({
    privateKey: pair.keyPem,
    publicCert: pair.certPem,
    signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
    canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#',
  });
  const self = `/*[local-name(.)='${element}']`;
  sig.addReference({
    xpath: self,
    digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
    transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/2001/10/xml-exc-c14n#'],
  });
  sig.computeSignature(xml, { prefix: 'ds', location: { reference: `${self}/*[local-name(.)='Issuer']`, action: 'after' } });
  return sig.getSignedXml();
}

/** What a4a asked for, read as the provider reads it. */
export interface AuthnRequest {
  id: string;
  acsUrl: string;
  issuer: string;
  destination: string;
  relayState: string | null;
}

export class FakeSamlIdp {
  url = '';
  readonly entityId = 'https://idp.example.test/saml';
  private server: Server | null = null;
  private pair!: KeyPair;
  private other!: KeyPair;
  /** Applied to the next response only. */
  next: SamlMisbehaviour = {};

  get certificate(): string {
    return this.pair.certBody;
  }

  get ssoUrl(): string {
    return `${this.url}/sso`;
  }

  async start(): Promise<void> {
    this.pair = await makeKeyPair('Test IdP');
    this.other = await makeKeyPair('Someone else');
    this.server = createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/metadata') {
        res.writeHead(200, { 'content-type': 'application/samlmetadata+xml' });
        res.end(this.metadata());
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', () => r()));
    this.url = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => this.server?.close(() => r()));
  }

  metadata(): string {
    return (
      `<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" entityID="${esc(this.entityId)}">` +
      `<md:IDPSSODescriptor WantAuthnRequestsSigned="false" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">` +
      `<md:KeyDescriptor use="encryption"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${this.other.certBody}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>` +
      `<md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>\n${this.pair.certBody.match(/.{1,64}/g)!.join('\n')}\n</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>` +
      `<md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${this.url}/sso-post"/>` +
      `<md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${this.ssoUrl}"/>` +
      `</md:IDPSSODescriptor></md:EntityDescriptor>`
    );
  }

  /** Read the AuthnRequest a4a sent the browser with. */
  read(redirectUrl: string): AuthnRequest {
    const u = new URL(redirectUrl);
    if (u.origin + u.pathname !== this.ssoUrl) throw new Error(`not this provider: ${redirectUrl}`);
    const xml = inflateRawSync(Buffer.from(u.searchParams.get('SAMLRequest') ?? '', 'base64')).toString('utf8');
    const attr = (name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(xml)?.[1] ?? '';
    return {
      id: attr('ID'),
      acsUrl: attr('AssertionConsumerServiceURL'),
      destination: attr('Destination'),
      issuer: /<(?:saml2?:)?Issuer[^>]*>([^<]*)</.exec(xml)?.[1] ?? '',
      relayState: u.searchParams.get('RelayState'),
    };
  }

  /** The person signs in at the provider: the SAMLResponse it posts back for this request (or for none). */
  respond(request: AuthnRequest | null, person: SamlPerson, spEntityId: string, acsUrl: string): string {
    const m = this.next;
    this.next = {};
    const inResponseTo = m.inResponseTo === undefined ? (request?.id ?? null) : m.inResponseTo;
    const recipient = m.recipient ?? request?.acsUrl ?? acsUrl;
    const issuer = esc(m.issuer ?? this.entityId);
    const notOnOrAfter = instant(m.expiresIn ?? 300);
    const notBefore = instant(m.startsIn ?? -5);
    const irt = inResponseTo ? ` InResponseTo="${esc(inResponseTo)}"` : '';
    const attributes = Object.entries(person.attributes ?? {})
      .map(
        ([name, value]) =>
          `<saml:Attribute Name="${esc(name)}" NameFormat="urn:oasis:names:tc:SAML:2.0:attrname-format:unspecified">` +
          (Array.isArray(value) ? value : [value])
            .map((v) => `<saml:AttributeValue xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="xs:string">${esc(v)}</saml:AttributeValue>`)
            .join('') +
          `</saml:Attribute>`,
      )
      .join('');
    let assertion =
      `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${id()}" Version="2.0" IssueInstant="${instant()}">` +
      `<saml:Issuer>${issuer}</saml:Issuer>` +
      `<saml:Subject><saml:NameID Format="${esc(person.nameIdFormat ?? 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent')}">${esc(person.nameId)}</saml:NameID>` +
      `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData${irt} NotOnOrAfter="${notOnOrAfter}" Recipient="${esc(recipient)}"/></saml:SubjectConfirmation></saml:Subject>` +
      `<saml:Conditions NotBefore="${notBefore}" NotOnOrAfter="${notOnOrAfter}"><saml:AudienceRestriction><saml:Audience>${esc(m.audience ?? spEntityId)}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
      `<saml:AuthnStatement AuthnInstant="${instant()}" SessionIndex="${id()}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>` +
      (attributes ? `<saml:AttributeStatement>${attributes}</saml:AttributeStatement>` : '') +
      `</saml:Assertion>`;
    const key = m.wrongKey ? this.other : this.pair;
    const how = m.sign ?? 'assertion';
    if (how === 'assertion') assertion = sign(assertion, 'Assertion', key);
    let response =
      `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ID="${id()}" Version="2.0" IssueInstant="${instant()}" Destination="${esc(m.destination ?? acsUrl)}"${irt}>` +
      `<saml:Issuer xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">${issuer}</saml:Issuer>` +
      `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>` +
      assertion +
      `</samlp:Response>`;
    if (how === 'response') response = sign(response, 'Response', key);
    if (m.tamper) response = m.tamper(response);
    return Buffer.from(response, 'utf8').toString('base64');
  }

  /** A response that says no: the person failed to sign in there. */
  refuse(request: AuthnRequest, acsUrl: string): string {
    const response =
      `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ID="${id()}" Version="2.0" IssueInstant="${instant()}" Destination="${esc(acsUrl)}" InResponseTo="${esc(request.id)}">` +
      `<saml:Issuer xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">${esc(this.entityId)}</saml:Issuer>` +
      `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Responder"><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:AuthnFailed"/></samlp:StatusCode></samlp:Status>` +
      `</samlp:Response>`;
    return Buffer.from(sign(response, 'Response', this.pair), 'utf8').toString('base64');
  }
}
