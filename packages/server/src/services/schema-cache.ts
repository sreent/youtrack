import type { FieldType, StateTransition } from '@a4a/shared';
import { asc } from 'drizzle-orm';
import type { Db } from '../db/client';
import { fields, fieldValues, linkTypes, projectFields, projects, rules, stateMachines, tags, users, workflowActions } from '../db/schema';

export type FieldRow = typeof fields.$inferSelect & { type: FieldType };
export type FieldValueRow = typeof fieldValues.$inferSelect;
export type ProjectRow = typeof projects.$inferSelect;
export type ProjectFieldRow = typeof projectFields.$inferSelect;
export type TagRow = typeof tags.$inferSelect;
export type LinkTypeRow = typeof linkTypes.$inferSelect;
export type UserRow = typeof users.$inferSelect;
export type RuleRow = typeof rules.$inferSelect;
export type MachineRow = typeof stateMachines.$inferSelect;
export type ActionRow = typeof workflowActions.$inferSelect;

export interface LinkPhrase {
  phrase: string; // lower-case
  display: string;
  type: LinkTypeRow;
  /** 'outward': this issue is the link source. 'inward': this issue is the target. */
  direction: 'outward' | 'inward' | 'both';
}

export interface SchemaSnapshot {
  fields: Map<string, FieldRow>;
  fieldsByName: Map<string, FieldRow>;
  values: Map<string, FieldValueRow>;
  valuesByField: Map<string, FieldValueRow[]>;
  projects: Map<string, ProjectRow>;
  projectsByKey: Map<string, ProjectRow>;
  projectFields: Map<string, ProjectFieldRow[]>;
  tags: Map<string, TagRow>;
  tagsByName: Map<string, TagRow>;
  linkTypes: LinkTypeRow[];
  linkPhrases: LinkPhrase[];
  users: Map<string, UserRow>;
  usersByLogin: Map<string, UserRow>;
  /** Workflow rules, oldest first, so the write path finds a project's guards without a query. */
  rules: RuleRow[];
  /** State machines (D40): the write path checks a move of a state field without a query. */
  machines: MachineRow[];
  /** Custom actions (D40), by position: the command language reads their names. */
  actions: ActionRow[];
  loadedAt: number;
}

const TTL_MS = 60_000;

/**
 * Small, frequently read reference data (fields, values, projects, tags, link
 * types, users, workflow rules). Reloaded after a write on any instance: locally at once, on the
 * others when the write's NOTIFY arrives. A reload at most a minute old is the
 * safety net for a notification that was lost.
 */
export class SchemaCache {
  private snapshot: SchemaSnapshot | null = null;
  private loading: Promise<SchemaSnapshot> | null = null;
  /**
   * Bumped by every invalidation. A load that started before an invalidation
   * must not publish its (possibly stale) result, or a write's effect could be
   * hidden for a whole TTL.
   */
  private generation = 0;
  /** Tells the other instances (set by the runtime; see Signals.announceSchemaChange). */
  broadcast: ((tx?: Db) => Promise<void>) | null = null;

  constructor(private db: Db) {}

  /** After a committed write: reload here, and tell the other instances. */
  invalidate(): void {
    this.drop();
    this.broadcast?.().catch((e) => console.warn(`schema cache: NOTIFY failed (${e instanceof Error ? e.message : e}); other instances reload within a minute`));
  }

  /**
   * Inside a transaction: reload here now, and on every instance (this one too)
   * once `tx` commits; nothing is sent if it rolls back.
   */
  async invalidateOnCommit(tx: Db): Promise<void> {
    this.drop();
    await this.broadcast?.(tx);
  }

  /** A change another instance made: reload here only. */
  drop(): void {
    this.generation++;
    this.snapshot = null;
    this.loading = null;
  }

  /**
   * Inside a transaction, pass it as `db`. A reload then runs on the transaction's
   * own connection — PGlite has only one, so loading through the pool there would
   * wait for the transaction while the transaction waits for the load — and its
   * result, which may include uncommitted rows, is not shared with other requests.
   */
  async get(db?: Db): Promise<SchemaSnapshot> {
    if (db && db !== this.db) {
      const snap = this.snapshot;
      if (snap && Date.now() - snap.loadedAt < TTL_MS) return snap;
      return this.load(db);
    }
    for (let attempt = 0; attempt < 5; attempt++) {
      const snap = this.snapshot;
      if (snap && Date.now() - snap.loadedAt < TTL_MS) return snap;
      const generation = this.generation;
      if (!this.loading) {
        const p = this.load();
        this.loading = p;
        p.finally(() => {
          if (this.loading === p) this.loading = null;
        }).catch(() => {});
      }
      const result = await this.loading!;
      if (generation === this.generation) {
        this.snapshot = result;
        return result;
      }
      // Invalidated while loading: load again so the caller sees its own write.
    }
    return this.load();
  }

  private async load(db: Db = this.db): Promise<SchemaSnapshot> {
    // Sequential on purpose: a transaction's connection runs one query at a time.
    const fieldRows = await db.select().from(fields).orderBy(asc(fields.ordinal), asc(fields.name));
    const valueRows = await db.select().from(fieldValues).orderBy(asc(fieldValues.ordinal), asc(fieldValues.name));
    const projectRows = await db.select().from(projects).orderBy(asc(projects.key));
    const pfRows = await db.select().from(projectFields).orderBy(asc(projectFields.ordinal));
    const tagRows = await db.select().from(tags).orderBy(asc(tags.name));
    const linkRows = await db.select().from(linkTypes).orderBy(asc(linkTypes.ordinal));
    const userRows = await db.select().from(users).orderBy(asc(users.login));
    const ruleRows = await db.select().from(rules).orderBy(asc(rules.createdAt), asc(rules.id));
    const machineRows = await db.select().from(stateMachines).orderBy(asc(stateMachines.createdAt), asc(stateMachines.id));
    const actionRows = await db.select().from(workflowActions).orderBy(asc(workflowActions.position), asc(workflowActions.createdAt), asc(workflowActions.id));
    const snap: SchemaSnapshot = {
      fields: new Map(),
      fieldsByName: new Map(),
      values: new Map(),
      valuesByField: new Map(),
      projects: new Map(),
      projectsByKey: new Map(),
      projectFields: new Map(),
      tags: new Map(),
      tagsByName: new Map(),
      linkTypes: linkRows,
      linkPhrases: [],
      users: new Map(),
      usersByLogin: new Map(),
      rules: ruleRows,
      machines: machineRows,
      actions: actionRows,
      loadedAt: Date.now(),
    };
    for (const f of fieldRows) {
      const row = f as FieldRow;
      snap.fields.set(f.id, row);
      snap.fieldsByName.set(f.name.toLowerCase(), row);
      snap.valuesByField.set(f.id, []);
    }
    for (const v of valueRows) {
      snap.values.set(v.id, v);
      snap.valuesByField.get(v.fieldId)?.push(v);
    }
    for (const p of projectRows) {
      snap.projects.set(p.id, p);
      snap.projectsByKey.set(p.key.toUpperCase(), p);
      snap.projectFields.set(p.id, []);
    }
    for (const pf of pfRows) snap.projectFields.get(pf.projectId)?.push(pf);
    for (const t of tagRows) {
      snap.tags.set(t.id, t);
      snap.tagsByName.set(t.name.toLowerCase(), t);
    }
    for (const u of userRows) {
      snap.users.set(u.id, u);
      snap.usersByLogin.set(u.login.toLowerCase(), u);
    }
    for (const lt of linkRows) {
      if (lt.directed) {
        snap.linkPhrases.push({ phrase: lt.outward.toLowerCase(), display: lt.outward, type: lt, direction: 'outward' });
        snap.linkPhrases.push({ phrase: lt.inward.toLowerCase(), display: lt.inward, type: lt, direction: 'inward' });
      } else {
        snap.linkPhrases.push({ phrase: lt.outward.toLowerCase(), display: lt.outward, type: lt, direction: 'both' });
        if (lt.inward.toLowerCase() !== lt.outward.toLowerCase()) {
          snap.linkPhrases.push({ phrase: lt.inward.toLowerCase(), display: lt.inward, type: lt, direction: 'both' });
        }
      }
    }
    // Longest phrases first so "is duplicated by" wins over "duplicates".
    snap.linkPhrases.sort((a, b) => b.phrase.length - a.phrase.length);
    return snap;
  }
}

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

export function fieldByName(s: SchemaSnapshot, name: string): FieldRow | undefined {
  return s.fieldsByName.get(name.trim().toLowerCase());
}

export function projectByKey(s: SchemaSnapshot, key: string): ProjectRow | undefined {
  return s.projectsByKey.get(key.trim().toUpperCase());
}

/** Projects that have the field attached. */
export function projectsUsingField(s: SchemaSnapshot, fieldId: string): ProjectRow[] {
  const out: ProjectRow[] = [];
  for (const [projectId, pfs] of s.projectFields) {
    if (pfs.some((pf) => pf.fieldId === fieldId)) {
      const p = s.projects.get(projectId);
      if (p) out.push(p);
    }
  }
  return out;
}

/** Values of an option field allowed in a project (shared + project-scoped), excluding archived. */
export function allowedValues(s: SchemaSnapshot, fieldId: string, projectId: string | null): FieldValueRow[] {
  const all = s.valuesByField.get(fieldId) ?? [];
  return all.filter((v) => !v.archived && (v.projectId === null || projectId === null || v.projectId === projectId));
}

export function findValue(
  s: SchemaSnapshot,
  fieldId: string,
  projectId: string | null,
  name: string,
): FieldValueRow | undefined {
  const lower = name.trim().toLowerCase();
  const candidates = (s.valuesByField.get(fieldId) ?? []).filter(
    (v) => v.name.toLowerCase() === lower && (v.projectId === null || projectId === null || v.projectId === projectId),
  );
  // Prefer the project-scoped value, then the shared one; non-archived first.
  candidates.sort((a, b) => Number(a.archived) - Number(b.archived) || Number(b.projectId !== null) - Number(a.projectId !== null));
  return candidates[0];
}

export function findUser(s: SchemaSnapshot, loginOrName: string, meId?: string): UserRow | undefined {
  const v = loginOrName.trim().toLowerCase();
  if (v === 'me' && meId) return s.users.get(meId);
  const byLogin = s.usersByLogin.get(v);
  if (byLogin) return byLogin;
  for (const u of s.users.values()) if (u.name.toLowerCase() === v) return u;
  return undefined;
}

/** A project's state machines (D40): one per state field at most. */
export function machinesFor(s: SchemaSnapshot, projectId: string): MachineRow[] {
  return s.machines.filter((m) => m.projectId === projectId);
}

/** A state machine's transitions, as they were checked when it was saved. */
export function transitionsOf(m: MachineRow): StateTransition[] {
  const list = Array.isArray(m.transitions) ? (m.transitions as unknown[]) : [];
  return list.flatMap((x): StateTransition[] => {
    if (!x || typeof x !== 'object') return [];
    const t = x as Record<string, unknown>;
    if (typeof t.name !== 'string' || typeof t.to !== 'string' || !Array.isArray(t.from)) return [];
    return [
      {
        name: t.name,
        from: t.from.filter((f): f is string => typeof f === 'string'),
        to: t.to,
        condition: typeof t.condition === 'string' && t.condition.trim() ? t.condition : null,
        command: typeof t.command === 'string' && t.command.trim() ? t.command : null,
      },
    ];
  });
}

/** A project's custom actions (D40), in their order. */
export function actionsFor(s: SchemaSnapshot, projectId: string): ActionRow[] {
  return s.actions.filter((a) => a.projectId === projectId);
}

/** The rules that apply in a project: its own and the global ones, oldest first. */
export function rulesFor(s: SchemaSnapshot, projectId: string): RuleRow[] {
  return s.rules.filter((r) => r.projectId === projectId || r.projectId === null);
}

export function stateField(s: SchemaSnapshot): FieldRow | undefined {
  for (const f of s.fields.values()) if (f.type === 'state') return f;
  return undefined;
}
