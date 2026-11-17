/**
 * What an export's columns and values mean here. Headers are matched to targets by the names Jira
 * and YouTrack give them; values (states, priorities, types, people, sprints) are matched by name,
 * by the words the two trackers use, and for people by email, login or name. Everything found
 * this way is a suggestion the person can change before anything is written.
 */
import { parsePeriod } from '@a4a/shared';
import { normalizeName } from '../lib/text';
import { zonedTime } from '../reports/tz';

export type Source = 'jira' | 'youtrack' | 'csv' | 'github' | 'redmine' | 'zendesk';

/** A header, as matched: lower case, single spaces, without Jira's "Custom field (…)". */
export function headerKey(name: string): string {
  const n = normalizeName(name);
  const custom = /^custom field \((.+)\)$/.exec(n);
  return custom ? custom[1]!.trim() : n;
}

const KEYISH = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;
const NUMERIC = /^\d+$/;

/** Jira's link types, as the a4a phrase each direction becomes (A blocks B: B depends on A). */
const JIRA_LINKS: Record<string, { outward: string; inward: string }> = {
  blocks: { outward: 'is required for', inward: 'depends on' },
  dependency: { outward: 'depends on', inward: 'is required for' },
  depends: { outward: 'depends on', inward: 'is required for' },
  duplicate: { outward: 'duplicates', inward: 'is duplicated by' },
  relates: { outward: 'relates to', inward: 'relates to' },
  relation: { outward: 'relates to', inward: 'relates to' },
  cloners: { outward: 'relates to', inward: 'relates to' },
};

const HEADERS: [string[], string][] = [
  [['summary', 'title'], 'summary'],
  [['description'], 'description'],
  [['issue key', 'key'], 'key'],
  [['reporter', 'reported by', 'created by'], 'reporter'],
  [['created', 'created date', 'date created', 'created at', 'creation date'], 'created'],
  [['updated', 'updated date', 'last updated', 'updated at', 'date updated'], 'updated'],
  [['resolved', 'resolution date', 'resolved date', 'resolved at', 'date resolved'], 'resolved'],
  [['labels', 'label', 'tags', 'tag'], 'tags'],
  [['parent', 'parent id', 'parent key', 'parent issue', 'parent issue id', 'subtask of', 'epic link', 'parent link'], 'parent'],
  [['sprint', 'sprints'], 'sprint'],
  [['comment', 'comments'], 'comment'],
  [['time spent', 'spent time', 'spent', 'time logged'], 'spent'],
];

/** Headers that name a project field by another name: [header words, well-known field]. */
const FIELD_HEADERS: [string[], string][] = [
  [['status', 'state'], 'State'],
  [['priority'], 'Priority'],
  [['issue type', 'type', 'issuetype'], 'Type'],
  [['assignee', 'assigned to'], 'Assignee'],
  [['original estimate', 'estimation', 'estimate', 'original estimation'], 'Estimation'],
  [['due date', 'due'], 'Due date'],
  [['start date'], 'Start date'],
  [['fix version/s', 'fix versions', 'fix version'], 'Fix versions'],
  [['component/s', 'components', 'component', 'subsystem', 'subsystems'], 'Subsystem'],
];

export interface FieldInfo {
  name: string;
  type: string;
  multi: boolean;
}

/**
 * The target a column takes from its header and a few of its values. `fields` are the project's
 * fields; `phrases` the link phrases a4a knows. Returns the target and whether it was found.
 */
export function targetFor(header: string, samples: string[], fields: FieldInfo[], phrases: string[]): { target: string; found: boolean } {
  const k = headerKey(header);
  const fieldNamed = (name: string) => fields.find((f) => f.name.toLowerCase() === name.toLowerCase());
  const filled = samples.filter((s) => s.trim());
  // "Issue id" is a key in YouTrack (PRJ-12) and a number in Jira (10023).
  if (k === 'issue id' || k === 'id') {
    if (filled.length && filled.every((s) => KEYISH.test(s.trim()))) return { target: 'key', found: true };
    if (filled.length && filled.every((s) => NUMERIC.test(s.trim()))) return { target: 'external-id', found: true };
    return { target: 'ignore', found: false };
  }
  const link = /^(outward|inward) issue link \((.+)\)$/.exec(k);
  if (link) {
    const type = JIRA_LINKS[link[2]!.trim()] ?? JIRA_LINKS.relates!;
    const phrase = link[1] === 'outward' ? type.outward : type.inward;
    return phrases.includes(phrase) ? { target: `link:${phrase}`, found: true } : { target: 'ignore', found: false };
  }
  for (const [words, target] of HEADERS) if (words.includes(k)) return { target, found: true };
  for (const [words, name] of FIELD_HEADERS) {
    if (!words.includes(k)) continue;
    const f = fieldNamed(name);
    if (f) return { target: `field:${f.name}`, found: true };
  }
  const own = fieldNamed(k);
  if (own) return { target: `field:${own.name}`, found: true };
  if (phrases.includes(k)) return { target: k === 'subtask of' ? 'parent' : `link:${k}`, found: true };
  return { target: 'ignore', found: false };
}

/** Which tracker wrote the file, from its headers. */
export function detectSource(header: string[]): Source {
  const keys = new Set(header.map(headerKey));
  if (keys.has('issue key') || [...keys].some((k) => /^(outward|inward) issue link \(/.test(k)) || keys.has('issue type')) return 'jira';
  if (keys.has('issue id') && (keys.has('state') || keys.has('spent time') || keys.has('estimation'))) return 'youtrack';
  return 'csv';
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

/** What Jira and YouTrack call states, priorities and types, as a4a's defaults name them. */
const SYNONYMS: Record<string, Record<string, string[]>> = {
  state: {
    Submitted: ['new', 'submitted', 'triage', 'needs triage'],
    Open: ['to do', 'todo', 'open', 'backlog', 'selected for development', 'reopened', 'ready', 'ready for development', 'planned'],
    'In Progress': ['in progress', 'in development', 'doing', 'started', 'in work'],
    'In Review': ['in review', 'code review', 'review', 'in qa', 'testing', 'in testing', 'to verify', 'ready for review'],
    Blocked: ['blocked', 'on hold', 'waiting', 'waiting for support', 'waiting for customer', 'wait'],
    Fixed: ['fixed', 'resolved'],
    Verified: ['verified', 'tested'],
    Done: ['done', 'closed', 'complete', 'completed', 'shipped', 'released'],
    "Won't fix": ["won't fix", 'wont fix', "won't do", 'wont do', 'declined', 'rejected', 'as designed', 'not a bug'],
    Duplicate: ['duplicate', 'duplicated'],
    Obsolete: ['obsolete', 'cannot reproduce', "can't reproduce", 'incomplete', 'outdated'],
  },
  priority: {
    'Show-stopper': ['show-stopper', 'showstopper', 'blocker', 'highest', 'urgent', 'p0'],
    Critical: ['critical', 'high', 'p1'],
    Major: ['major', 'p2'],
    Normal: ['normal', 'medium', 'p3'],
    Minor: ['minor', 'low', 'lowest', 'trivial', 'p4', 'p5'],
  },
  type: {
    Bug: ['bug', 'defect', 'incident', 'problem'],
    Feature: ['feature', 'story', 'user story', 'new feature', 'improvement', 'enhancement'],
    Task: ['task', 'sub-task', 'subtask', 'technical task', 'chore', 'cosmetics'],
    Epic: ['epic'],
    Milestone: ['milestone'],
  },
};

/**
 * The a4a value an exported value most likely is: the same name, or what the trackers call it.
 * `found` is whether that's sure enough to take without asking.
 */
export function suggestOption(fieldName: string, value: string, options: string[]): { to: string | null; found: boolean } {
  const v = normalizeName(value);
  const exact = options.find((o) => o.toLowerCase() === v);
  if (exact) return { to: exact, found: true };
  const table = SYNONYMS[normalizeName(fieldName)] ?? (normalizeName(fieldName) === 'status' ? SYNONYMS.state : undefined);
  if (table) {
    for (const [target, words] of Object.entries(table)) {
      if (!words.includes(v)) continue;
      const option = options.find((o) => o.toLowerCase() === target.toLowerCase());
      if (option) return { to: option, found: true };
    }
  }
  return { to: null, found: false };
}

export interface PersonInfo {
  id: string;
  login: string;
  name: string;
  email: string | null;
}

/** Someone here by the export's email, login or name; null (unassigned) when nobody is. */
export function matchPerson(value: string, people: PersonInfo[]): PersonInfo | null {
  const v = normalizeName(value);
  if (!v) return null;
  const email = /<([^>]+@[^>]+)>/.exec(value)?.[1]?.toLowerCase() ?? (v.includes('@') ? v : null);
  if (email) {
    const byEmail = people.find((p) => p.email?.toLowerCase() === email);
    if (byEmail) return byEmail;
  }
  const bare = normalizeName(value.replace(/<[^>]*>/g, ''));
  return people.find((p) => p.login.toLowerCase() === bare) ?? people.find((p) => normalizeName(p.name) === bare) ?? null;
}

/** Cells that hold several values: tags, versions, sprints, labels ("a, b" or "a;b"). */
export function splitMulti(value: string): string[] {
  return value
    .split(/[,;]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Dates, durations and comments
// ---------------------------------------------------------------------------

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/**
 * An instant from a date as the trackers write them: ISO 8601 (with or without a time and a zone),
 * Jira's "12/Mar/24 2:15 PM", YouTrack's "12 Mar 2024 14:15", "12.03.2024 14:15", or epoch seconds
 * or milliseconds. A time without a zone is read in `tz`. Null when it isn't a date.
 */
export function parseDate(text: string, tz: string): number | null {
  const v = text.trim();
  if (!v) return null;
  if (/^\d{13}$/.test(v)) return Number(v);
  if (/^\d{10}$/.test(v)) return Number(v) * 1000;
  let m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i.exec(v);
  if (m) {
    if (m[7]) {
      const zone = m[7].toUpperCase() === 'Z' ? 'Z' : m[7].includes(':') ? m[7] : `${m[7].slice(0, 3)}:${m[7].slice(3)}`;
      const t = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${(m[4] ?? '00').padStart(2, '0')}:${m[5] ?? '00'}:${m[6] ?? '00'}${zone}`);
      return Number.isNaN(t) ? null : t;
    }
    return checked(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0), tz);
  }
  // Jira: 12/Mar/24 2:15 PM, 12/Mar/2024 14:15
  m = /^(\d{1,2})[/ -]([A-Za-z]{3})[a-z]*[/ -](\d{2}|\d{4})(?:[ ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?)?$/.exec(v);
  if (m && MONTHS[m[2]!.toLowerCase()]) {
    let h = Number(m[4] ?? 0);
    if (m[7]) h = (h % 12) + (m[7].toLowerCase() === 'pm' ? 12 : 0);
    const y = m[3]!.length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return checked(y, MONTHS[m[2]!.toLowerCase()]!, Number(m[1]), h, Number(m[5] ?? 0), Number(m[6] ?? 0), tz);
  }
  // 12.03.2024 14:15
  m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(v);
  if (m) return checked(Number(m[3]), Number(m[2]), Number(m[1]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0), tz);
  return null;
}

function checked(y: number, mo: number, d: number, h: number, mi: number, s: number, tz: string): number | null {
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCMonth() !== mo - 1) return null; // 31 Feb
  return zonedTime(y, mo, d, h, mi, s, tz);
}

/**
 * Minutes from a duration as the trackers export one: Jira's seconds (28800), YouTrack's minutes or
 * its presentation ("1d 4h"), or "2h 30m". Null when it isn't one.
 */
export function parseDuration(text: string, source: Source): number | null {
  const v = text.trim();
  if (!v) return null;
  if (/^\d+(\.\d+)?$/.test(v)) {
    const n = Number(v);
    return Math.round(source === 'jira' ? n / 60 : n);
  }
  return parsePeriod(v);
}

export interface ParsedComment {
  at: number | null;
  author: string | null;
  text: string;
}

/** A comment cell: Jira's "date;author;text", or the text alone. */
export function parseComment(cell: string, tz: string): ParsedComment | null {
  const raw = cell.trim();
  if (!raw) return null;
  const first = raw.indexOf(';');
  const second = first >= 0 ? raw.indexOf(';', first + 1) : -1;
  if (first > 0 && second > first) {
    const at = parseDate(raw.slice(0, first), tz);
    if (at !== null) {
      const text = raw.slice(second + 1).trim();
      return text ? { at, author: raw.slice(first + 1, second).trim() || null, text } : null;
    }
  }
  return { at: null, author: null, text: raw };
}
