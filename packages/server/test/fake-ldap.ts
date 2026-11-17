/**
 * A directory made for the tests: an LDAP server on this machine (port 0) with a service account,
 * people and groups, answering binds and searches as OpenLDAP or Active Directory would.
 */
import ldap from 'ldapjs';

export interface DirectoryEntry {
  dn: string;
  password?: string;
  attributes: Record<string, string | string[]>;
}

const norm = (dn: string) => dn.replace(/\s*,\s*/g, ',').toLowerCase();

export class FakeDirectory {
  readonly base = 'dc=corp,dc=test';
  readonly serviceDn = 'cn=a4a,ou=services,dc=corp,dc=test';
  readonly servicePassword = 'service-password';
  entries: DirectoryEntry[] = [];
  /** Every bind, as (dn, password), for tests that check what was sent. */
  binds: Array<{ dn: string; password: string }> = [];
  /** Every search filter, as text. */
  filters: string[] = [];
  private server = ldap.createServer();
  url = '';

  async start(): Promise<void> {
    this.server.bind(this.base, (req: { dn: { toString(): string }; credentials: string }, res: { end(): void }, next: (e?: unknown) => void) => {
      const dn = norm(req.dn.toString());
      this.binds.push({ dn, password: req.credentials });
      const ok = dn === norm(this.serviceDn) ? req.credentials === this.servicePassword : this.entries.some((e) => norm(e.dn) === dn && e.password !== undefined && e.password === req.credentials);
      if (!ok) return next(new ldap.InvalidCredentialsError());
      res.end();
      return next();
    });
    this.server.search(this.base, (req: { dn: { toString(): string }; attributes?: string[]; filter: { matches(o: unknown, strict?: boolean): boolean; toString(): string } }, res: { attributes: string[]; send(e: unknown): void; end(): void }, next: () => void) => {
      this.filters.push(req.filter.toString());
      const under = norm(req.dn.toString());
      // Attributes are named in any case, as directories take them (ldapjs's server compares them lower-cased).
      res.attributes = res.attributes.map((a) => a.toLowerCase());
      for (const e of this.entries) {
        if (!norm(e.dn).endsWith(under)) continue;
        if (req.filter.matches(e.attributes, false)) res.send({ dn: e.dn, attributes: { ...e.attributes } });
      }
      res.end();
      return next();
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', () => resolve()));
    this.url = `ldap://127.0.0.1:${(this.server as unknown as { address(): { port: number } }).address().port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
