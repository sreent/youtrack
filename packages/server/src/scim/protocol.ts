/**
 * SCIM 2.0's wire (RFC 7643, RFC 7644), as much of it as provisioning clients use: the one filter
 * they send, PATCH operations, and the errors. Written to take what Microsoft Entra ID sends:
 * "Replace" for replace, "False" for false, `emails[type eq "work"].value` for a path, and a
 * value with no path that is several attributes at once, some written with dots.
 */
export const SCIM = {
  user: 'urn:ietf:params:scim:schemas:core:2.0:User',
  group: 'urn:ietf:params:scim:schemas:core:2.0:Group',
  enterpriseUser: 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User',
  list: 'urn:ietf:params:scim:api:messages:2.0:ListResponse',
  patch: 'urn:ietf:params:scim:api:messages:2.0:PatchOp',
  error: 'urn:ietf:params:scim:api:messages:2.0:Error',
  serviceProviderConfig: 'urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig',
  resourceType: 'urn:ietf:params:scim:schemas:core:2.0:ResourceType',
  schema: 'urn:ietf:params:scim:schemas:core:2.0:Schema',
} as const;

export const SCIM_JSON = 'application/scim+json';

/** An error as SCIM writes one; `detail` says what to change. */
export class ScimError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
    readonly scimType?: 'invalidFilter' | 'invalidSyntax' | 'invalidPath' | 'invalidValue' | 'uniqueness' | 'mutability' | 'noTarget' | 'tooMany',
  ) {
    super(detail);
  }
}

export function errorBody(status: number, detail: string, scimType?: string) {
  return { schemas: [SCIM.error], status: String(status), ...(scimType ? { scimType } : {}), detail };
}

export interface Filter {
  /** Lower-cased, without the core schema's URN. */
  attribute: string;
  value: string;
}

/** `userName eq "anna@corp.com"`: the one form of filter provisioning clients send. */
export function parseFilter(text: string | undefined): Filter | null {
  if (!text?.trim()) return null;
  const m = /^\s*([A-Za-z][\w.:$-]*)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/i.exec(text);
  if (!m) throw new ScimError(400, 'Only filters of the form attribute eq "value" work here, e.g. userName eq "anna@corp.com"', 'invalidFilter');
  return { attribute: bare(m[1]!).toLowerCase(), value: m[2]!.replace(/\\(.)/g, '$1') };
}

/** An attribute's path without the core schemas' URNs: "urn:…:core:2.0:User:userName" → "userName". */
export function bare(path: string): string {
  return path.replace(/^urn:ietf:params:scim:schemas:core:2\.0:(?:User|Group):/i, '').trim();
}

/** true and false, also as Entra writes them: "True", "False". */
export function scimBool(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const t = value.trim().toLowerCase();
    if (t === 'true') return true;
    if (t === 'false') return false;
  }
  return undefined;
}

export interface PatchOp {
  op: 'add' | 'replace' | 'remove';
  path: string | null;
  value: unknown;
}

/** The operations of a PATCH, with `op` in any case. */
export function patchOps(body: unknown): PatchOp[] {
  const raw = body && typeof body === 'object' ? ((body as Record<string, unknown>).Operations ?? (body as Record<string, unknown>).operations) : undefined;
  if (!Array.isArray(raw) || !raw.length) throw new ScimError(400, 'A PATCH takes "Operations": a list of { "op", "path", "value" }', 'invalidSyntax');
  return raw.map((o: Record<string, unknown>) => {
    const op = String(o?.op ?? '').toLowerCase();
    if (op !== 'add' && op !== 'replace' && op !== 'remove') throw new ScimError(400, `"${String(o?.op)}" isn't an operation: use add, replace or remove`, 'invalidSyntax');
    const path = typeof o.path === 'string' && o.path.trim() ? o.path.trim() : null;
    if (op === 'remove' && !path) throw new ScimError(400, 'remove needs a path: the attribute to take away', 'noTarget');
    return { op, path, value: o.value };
  });
}

/**
 * A value given with no path is several attributes at once: {"active": false, "name.givenName":
 * "Anna", "name": {"familyName": "Schmidt"}}. As (path, value) pairs.
 */
export function attributesOf(value: unknown, prefix = ''): Array<[string, unknown]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return prefix ? [[prefix, value]] : [];
  const out: Array<[string, unknown]> = [];
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v) && (k.toLowerCase() === 'name' || /^urn:/i.test(k))) out.push(...attributesOf(v, key));
    else out.push([key, v]);
  }
  return out;
}

/** Text, trimmed; null for nothing. */
export function text(value: unknown, what: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' && typeof value !== 'number') throw new ScimError(400, `${what} takes text`, 'invalidValue');
  const t = String(value).trim();
  return t || null;
}

/** The ids in a members value: [{ "value": "…" }], or one such object. */
export function memberIds(value: unknown): string[] {
  const list = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  return list.map((m) => {
    const id = m && typeof m === 'object' ? (m as Record<string, unknown>).value : m;
    if (typeof id !== 'string' || !id.trim()) throw new ScimError(400, 'Each member is { "value": "<a user’s id>" }', 'invalidValue');
    return id.trim();
  });
}

export function listResponse<T>(total: number, startIndex: number, resources: T[]) {
  return { schemas: [SCIM.list], totalResults: total, startIndex, itemsPerPage: resources.length, Resources: resources };
}

/** startIndex is 1-based; count is at most 200. */
export function paging(query: { startIndex?: string; count?: string }): { startIndex: number; count: number } {
  const startIndex = Math.max(1, Math.floor(Number(query.startIndex ?? 1)) || 1);
  const asked = query.count === undefined ? 100 : Math.floor(Number(query.count));
  const count = Number.isFinite(asked) ? Math.min(200, Math.max(0, asked)) : 100;
  return { startIndex, count };
}
