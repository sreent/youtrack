import type { FieldType } from '@tracklet/shared';
import { allowedValues, type FieldRow, type SchemaSnapshot } from '../services/schema-cache';

/** What a query term targets. */
export type TermKind =
  | { kind: 'custom'; field: FieldRow }
  | { kind: 'project' }
  | { kind: 'issueId' }
  | { kind: 'textAttr'; column: 'summary' | 'description' }
  | { kind: 'userAttr'; column: 'reporter' | 'updatedBy' | 'commenter' }
  | { kind: 'dateAttr'; column: 'created' | 'updated' | 'resolved' }
  | { kind: 'tag' }
  | { kind: 'has' }
  | { kind: 'sprint' }
  | { kind: 'spent' }
  | { kind: 'links' }
  | { kind: 'linkPhrase'; phrase: string }
  | { kind: 'assigneeAlias' };

export interface TermDef {
  /** Canonical display name, e.g. "Priority", "created", "depends on". */
  name: string;
  term: TermKind;
  /** The value type used for parsing and completion. */
  valueType: FieldType | 'project' | 'issue' | 'tag' | 'has' | 'sprint';
  description: string;
}

/** Built-in attributes (lower-case keys, including aliases). */
const ATTRIBUTES: Record<string, Omit<TermDef, 'name'> & { name: string }> = {
  project: { name: 'project', term: { kind: 'project' }, valueType: 'project', description: 'Project key or name' },
  'issue id': { name: 'issue id', term: { kind: 'issueId' }, valueType: 'issue', description: 'Issue ids, e.g. BACK-12' },
  id: { name: 'issue id', term: { kind: 'issueId' }, valueType: 'issue', description: 'Issue ids' },
  summary: { name: 'summary', term: { kind: 'textAttr', column: 'summary' }, valueType: 'text', description: 'Words in the summary' },
  description: {
    name: 'description',
    term: { kind: 'textAttr', column: 'description' },
    valueType: 'text',
    description: 'Words in the description',
  },
  reporter: { name: 'reporter', term: { kind: 'userAttr', column: 'reporter' }, valueType: 'user', description: 'Who created the issue' },
  'created by': { name: 'reporter', term: { kind: 'userAttr', column: 'reporter' }, valueType: 'user', description: 'Who created the issue' },
  by: { name: 'reporter', term: { kind: 'userAttr', column: 'reporter' }, valueType: 'user', description: 'Who created the issue' },
  'updated by': { name: 'updated by', term: { kind: 'userAttr', column: 'updatedBy' }, valueType: 'user', description: 'Who last changed it' },
  updater: { name: 'updated by', term: { kind: 'userAttr', column: 'updatedBy' }, valueType: 'user', description: 'Who last changed it' },
  commenter: { name: 'commenter', term: { kind: 'userAttr', column: 'commenter' }, valueType: 'user', description: 'Who commented' },
  'commented by': { name: 'commenter', term: { kind: 'userAttr', column: 'commenter' }, valueType: 'user', description: 'Who commented' },
  for: { name: 'for', term: { kind: 'assigneeAlias' }, valueType: 'user', description: 'Assignee (shortcut)' },
  created: { name: 'created', term: { kind: 'dateAttr', column: 'created' }, valueType: 'date', description: 'Creation date' },
  updated: { name: 'updated', term: { kind: 'dateAttr', column: 'updated' }, valueType: 'date', description: 'Last update date' },
  resolved: { name: 'resolved date', term: { kind: 'dateAttr', column: 'resolved' }, valueType: 'date', description: 'Resolution date' },
  'resolved date': { name: 'resolved date', term: { kind: 'dateAttr', column: 'resolved' }, valueType: 'date', description: 'Resolution date' },
  tag: { name: 'tag', term: { kind: 'tag' }, valueType: 'tag', description: 'Tag name' },
  tags: { name: 'tag', term: { kind: 'tag' }, valueType: 'tag', description: 'Tag name' },
  has: { name: 'has', term: { kind: 'has' }, valueType: 'has', description: 'Field or attribute is set (use -name for empty)' },
  sprint: { name: 'sprint', term: { kind: 'sprint' }, valueType: 'sprint', description: 'Sprint name' },
  'spent time': { name: 'spent time', term: { kind: 'spent' }, valueType: 'period', description: 'Logged work' },
  links: { name: 'links', term: { kind: 'links' }, valueType: 'issue', description: 'Linked to an issue in any way' },
};

export const HAS_ATTRIBUTES = ['description', 'comments', 'links', 'tags', 'subtasks', 'parent', 'work'];

export interface Vocabulary {
  snapshot: SchemaSnapshot;
  /** Resolve a (lower-case, single-spaced) term name. */
  term(nameLower: string): TermDef | undefined;
  /** All names usable before a colon (for completion), canonical first. */
  termNames(): string[];
  /** Known value names for a term, used for greedy multi-word matching and completion. */
  values(def: TermDef): string[];
  maxTermWords: number;
}

export function buildVocabulary(s: SchemaSnapshot): Vocabulary {
  const terms = new Map<string, TermDef>();
  for (const [key, def] of Object.entries(ATTRIBUTES)) terms.set(key, def);
  for (const p of s.linkPhrases) {
    terms.set(p.phrase, { name: p.display, term: { kind: 'linkPhrase', phrase: p.phrase }, valueType: 'issue', description: `Issues that ${p.display} the given issue` });
  }
  // Custom fields override attributes with the same name (e.g. a field called "Sprint").
  for (const f of s.fields.values()) {
    terms.set(f.name.toLowerCase(), { name: f.name, term: { kind: 'custom', field: f }, valueType: f.type, description: `${f.type} field` });
  }
  let maxTermWords = 1;
  for (const k of terms.keys()) maxTermWords = Math.max(maxTermWords, k.split(' ').length);

  const userNames = (): string[] => {
    const out = ['me', 'Unassigned'];
    for (const u of s.users.values()) {
      out.push(u.login);
      if (u.name.toLowerCase() !== u.login.toLowerCase()) out.push(u.name);
    }
    return out;
  };

  return {
    snapshot: s,
    maxTermWords,
    term: (nameLower) => terms.get(nameLower),
    termNames: () => {
      const seen = new Set<string>();
      const out: string[] = [];
      for (const f of s.fields.values()) {
        seen.add(f.name.toLowerCase());
        out.push(f.name);
      }
      for (const def of terms.values()) {
        if (!seen.has(def.name.toLowerCase())) {
          seen.add(def.name.toLowerCase());
          out.push(def.name);
        }
      }
      return out;
    },
    values: (def) => {
      const t = def.term;
      if (t.kind === 'custom') {
        if (t.field.type === 'user') return userNames();
        if (t.field.type === 'enum' || t.field.type === 'state' || t.field.type === 'version') {
          return [...new Set(allowedValues(s, t.field.id, null).map((v) => v.name))];
        }
        if (t.field.type === 'date') return ['today', 'yesterday', 'tomorrow', '{this week}', '{last week}', '{this month}', '-7d'];
        return [];
      }
      switch (t.kind) {
        case 'project':
          return [...s.projects.values()].flatMap((p) => [p.key, p.name]);
        case 'userAttr':
        case 'assigneeAlias':
          return userNames();
        case 'tag':
          return [...s.tags.values()].map((x) => x.name);
        case 'has':
          return [...[...s.fields.values()].map((f) => f.name), ...HAS_ATTRIBUTES];
        case 'dateAttr':
          return ['today', 'yesterday', '{this week}', '{last week}', '{this month}', '{last month}', '-7d', '-30d'];
        default:
          return [];
      }
    },
  };
}

export const SORT_ATTRIBUTES = ['created', 'updated', 'resolved date', 'summary', 'issue id', 'spent time'];
