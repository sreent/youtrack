/**
 * A query in words (D49): what the issues list and the query bar say a search finds. A page gets it in
 * its own language; an agent or a script, in English, as the API's words are. The query language's own
 * words in it (fields, values, #Unresolved as a tag) stay as written.
 */
import type { Translator } from '@a4a/shared/i18n';
import { intlTag, translatorFor } from '../i18n';
import type { ParsedQuery, QueryNode, ValueNode } from './parser';

const ENGLISH = translatorFor('en');

/** A list as the reader's language joins one: "a or b", "a, b und c", "a、b、c". */
function list(tr: Translator, items: string[], type: 'conjunction' | 'disjunction', style: 'long' | 'narrow' = 'long'): string {
  return new Intl.ListFormat(intlTag(tr.locale), { type, style }).format(items);
}

/** "me" is whoever reads it: "you", in their language, where a value names people. */
function value(v: ValueNode, tr: Translator, people = false): string {
  if (v.kind === 'range') {
    if (v.from && v.to) return tr.t('server.query.between', { from: v.from, to: v.to });
    if (v.from) return tr.t('server.query.orLater', { from: v.from });
    if (v.to) return tr.t('server.query.upTo', { to: v.to });
    return tr.t('server.query.any');
  }
  const raw = people && v.raw.toLowerCase() === 'me' ? tr.t('server.query.you') : v.raw;
  return v.negated ? tr.t('server.query.not', { value: raw }) : raw;
}

function values(vs: ValueNode[], tr: Translator, people = false): string {
  const pos = vs.filter((v) => !(v.kind === 'single' && v.negated)).map((v) => value(v, tr, people));
  const neg = vs.filter((v) => v.kind === 'single' && v.negated).map((v) => value(v, tr, people));
  const parts: string[] = [];
  if (pos.length) parts.push(list(tr, pos, 'disjunction'));
  if (neg.length) parts.push(list(tr, neg, 'conjunction'));
  return list(tr, parts, 'conjunction');
}

/** Which SLA target, as a code its message words. */
const slaTarget = (target: string | null | undefined) => (target === 'first_response' ? 'first_response' : 'resolution');

function node(n: QueryNode, tr: Translator): string {
  switch (n.kind) {
    case 'and':
      return list(tr, n.items.map((i) => node(i, tr)).filter(Boolean), 'conjunction', 'narrow');
    case 'or':
      return tr.t('server.query.group', { inner: list(tr, n.items.map((i) => node(i, tr)), 'disjunction') });
    case 'not':
      return tr.t('server.query.notGroup', { inner: node(n.item, tr) });
    case 'text':
      return tr.t(n.exact ? 'server.query.containingPhrase' : 'server.query.matchingText', { text: n.text });
    case 'hash': {
      const v = n.value.toLowerCase();
      if (v === 'unresolved') return tr.t('server.query.unresolved');
      if (v === 'resolved') return tr.t('server.query.resolved');
      if (v === 'me' || v === 'my') return tr.t('server.query.assignedToYou');
      return `#${n.value}`;
    }
    case 'term': {
      const name = n.def.name;
      const t = n.def.term;
      if (t.kind === 'has') {
        const set = n.values.filter((v) => !(v.kind === 'single' && v.negated)).map((v) => value(v, tr));
        const unset = n.values.filter((v) => v.kind === 'single' && v.negated).map((v) => (v.kind === 'single' ? v.raw : ''));
        const parts = [set.length ? tr.t('server.query.withSet', { fields: list(tr, set, 'conjunction') }) : '', unset.length ? tr.t('server.query.without', { fields: list(tr, unset, 'conjunction') }) : ''];
        return list(tr, parts.filter(Boolean), 'conjunction');
      }
      // "Ihnen zugewiesen", not "zugewiesen an Sie": you alone is a phrase of its own.
      const youAlone = n.values.length === 1 && n.values[0]!.kind === 'single' && !n.values[0]!.negated && n.values[0]!.raw.toLowerCase() === 'me';
      if (t.kind === 'assigneeAlias') return youAlone ? tr.t('server.query.assignedToYou') : tr.t('server.query.assignedTo', { values: values(n.values, tr, true) });
      if (t.kind === 'userAttr' && t.column === 'watcher') return youAlone ? tr.t('server.query.watchedByYou') : tr.t('server.query.watchedBy', { values: values(n.values, tr, true) });
      if (t.kind === 'sla') return t.target ? tr.t('server.query.slaTargetIs', { target: slaTarget(t.target), values: values(n.values, tr) }) : tr.t('server.query.slaIs', { values: values(n.values, tr) });
      if (t.kind === 'slaDue') return tr.t('server.query.slaTargetDue', { target: slaTarget(t.target), values: values(n.values, tr) });
      if (t.kind === 'requester') return tr.t('server.query.askedForBy', { values: values(n.values, tr) });
      if (t.kind === 'customer') return tr.t('server.query.fromCustomer', { values: values(n.values, tr) });
      if (t.kind === 'project') return tr.t('server.query.inProject', { values: values(n.values, tr) });
      // A date's and a field's name are the query language's: "created", "Priority".
      if (t.kind === 'dateAttr') return `${name} ${values(n.values, tr)}`;
      if (t.kind === 'linkPhrase') return tr.t('server.query.thatLinked', { name, values: values(n.values, tr) });
      return `${name}: ${values(n.values, tr, true)}`;
    }
  }
}

/**
 * The query's words in pieces: what it asks ("in project BACK, unresolved", '' for nothing) and how
 * it sorts, worded to follow what it asks (" sorted by Priority", '' when it doesn't say). A page
 * puts them after the count of what it found, "4 issues in project BACK", in its own words.
 */
export function explainParts(parsed: ParsedQuery, tr: Translator = ENGLISH): { body: string; sort: string } {
  const body = parsed.root ? node(parsed.root, tr) : '';
  const sort = parsed.sort.length
    ? tr.t('server.query.sortedBy', { sorts: list(tr, parsed.sort.map((s) => (s.dir === 'desc' ? tr.t('server.query.descending', { field: s.display }) : s.display)), 'conjunction', 'narrow') })
    : '';
  return { body, sort };
}

/** The pieces as one sentence: "Issues in project BACK, unresolved", "All issues (most recently updated first)". */
export function explanationOf({ body, sort }: { body: string; sort: string }, tr: Translator = ENGLISH): string {
  if (!body) return sort ? tr.t('server.query.allIssuesSorted', { sort }) : tr.t('server.query.allIssuesRecentFirst');
  return tr.t('server.query.issues', { body, sort });
}

/** The query in words, in a reader's language: English unless a page asked for its own. */
export function explainParsed(parsed: ParsedQuery, tr: Translator = ENGLISH): string {
  return explanationOf(explainParts(parsed, tr), tr);
}
