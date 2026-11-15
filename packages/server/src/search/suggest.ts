import type { SuggestItem } from '@a4a/shared';
import type { SchemaSnapshot } from '../services/schema-cache';
import { lex, type Token } from './lexer';
import { buildVocabulary, SORT_ATTRIBUTES, type TermDef, type Vocabulary } from './vocabulary';

function needsBraces(v: string): boolean {
  return /[\s:,(){}"#]/.test(v) && !/^\{.*\}$/.test(v);
}

function quoteValue(v: string): string {
  return needsBraces(v) ? `{${v}}` : v;
}

function matches(candidate: string, prefix: string): boolean {
  if (!prefix) return true;
  const c = candidate.toLowerCase();
  const p = prefix.toLowerCase().replace(/^\{/, '');
  return c.startsWith(p) || c.split(/\s+/).some((w) => w.startsWith(p));
}

/** Find which term (if any) the value at token index `idx` belongs to. */
function termBefore(tokens: Token[], idx: number, vocab: Vocabulary): { def: TermDef; colonIndex: number } | null {
  // Walk back over values/commas/ranges to the colon
  let i = idx;
  while (i >= 0) {
    const t = tokens[i]!;
    if (t.kind === 'colon') break;
    if (t.kind === 'comma' || t.kind === 'dotdot' || t.kind === 'minus' || t.kind === 'quoted' || t.kind === 'braced') {
      i--;
      continue;
    }
    if (t.kind === 'word') {
      // A word directly before a colon is a term name, not a value.
      if (tokens[i + 1]?.kind === 'colon' && i !== idx) return null;
      i--;
      continue;
    }
    return null;
  }
  if (i < 0) return null;
  for (let k = vocab.maxTermWords; k >= 1; k--) {
    const words = tokens.slice(i - k, i);
    if (words.length !== k || words.some((w) => w.kind !== 'word')) continue;
    const def = vocab.term(words.map((w) => w.value.toLowerCase()).join(' '));
    if (def) return { def, colonIndex: i };
  }
  return null;
}

export function suggest(s: SchemaSnapshot, query: string, caret: number, limit = 20): SuggestItem[] {
  const vocab = buildVocabulary(s);
  const before = query.slice(0, caret);
  const { tokens } = lex(before);
  const last = tokens[tokens.length - 1];
  const endsWithSpace = /\s$/.test(before);
  const out: SuggestItem[] = [];
  const push = (item: SuggestItem) => {
    if (out.length < limit && !out.some((o) => o.insert === item.insert && o.replaceStart === item.replaceStart)) out.push(item);
  };

  const partial = last && !endsWithSpace && (last.kind === 'word' || last.kind === 'hash' || last.kind === 'braced') ? last : undefined;
  const replaceStart = partial ? partial.start : caret;
  const prefix = partial ? (partial.kind === 'hash' ? partial.value : partial.value) : '';

  // "sort by:" context
  const lowerBefore = before.toLowerCase();
  const sortIdx = lowerBefore.lastIndexOf('sort by:');
  if (sortIdx >= 0) {
    const sortable = [...[...s.fields.values()].map((f) => f.name), ...SORT_ATTRIBUTES];
    const afterSort = before.slice(sortIdx + 8);
    const lastPart = afterSort.split(',').pop() ?? '';
    const words = lastPart.trim().split(/\s+/).filter(Boolean);
    const lastWord = endsWithSpace ? '' : (words[words.length - 1] ?? '');
    if (words.length && endsWithSpace) {
      push({ label: 'asc', insert: 'asc ', kind: 'sort', replaceStart: caret, replaceEnd: caret });
      push({ label: 'desc', insert: 'desc ', kind: 'sort', replaceStart: caret, replaceEnd: caret });
    }
    for (const f of sortable) {
      if (matches(f, lastWord)) {
        push({ label: f, insert: `${quoteValue(f)} `, kind: 'sort', description: 'Sort field', replaceStart: caret - lastWord.length, replaceEnd: caret });
      }
    }
    return out;
  }

  // "#" context
  if (partial?.kind === 'hash') {
    const specials = ['Unresolved', 'Resolved', 'me', 'Unassigned'];
    for (const sp of specials) if (matches(sp, prefix)) push({ label: `#${sp}`, insert: `#${sp} `, kind: 'keyword', replaceStart, replaceEnd: caret });
    for (const f of s.fields.values()) {
      if (f.type !== 'enum' && f.type !== 'state' && f.type !== 'version') continue;
      for (const v of s.valuesByField.get(f.id) ?? []) {
        if (!v.archived && matches(v.name, prefix)) {
          push({ label: `#${v.name}`, insert: `#${quoteValue(v.name)} `, kind: 'value', description: f.name, replaceStart, replaceEnd: caret });
        }
      }
    }
    for (const t of s.tags.values()) {
      if (matches(t.name, prefix)) push({ label: `#${t.name}`, insert: `#${quoteValue(t.name)} `, kind: 'tag', description: 'Tag', replaceStart, replaceEnd: caret });
    }
    return out;
  }

  // Value context: right after "field:" or inside a value list
  const idx = partial ? tokens.length - 1 : tokens.length - 1;
  const valueCtx =
    last && (last.kind === 'colon' || last.kind === 'comma' || last.kind === 'dotdot' || last.kind === 'minus' || (partial && tokens[tokens.length - 2]))
      ? termBefore(tokens, partial ? idx : idx, vocab)
      : null;
  const inValuePosition =
    valueCtx &&
    (last!.kind === 'colon' ||
      last!.kind === 'comma' ||
      last!.kind === 'dotdot' ||
      last!.kind === 'minus' ||
      (partial && valueCtx.colonIndex === tokens.length - 2) ||
      (partial && tokens[tokens.length - 2]?.kind === 'comma'));
  if (valueCtx && inValuePosition && !(endsWithSpace && last!.kind === 'word')) {
    const values = vocab.values(valueCtx.def);
    for (const v of values) {
      if (matches(v, prefix)) {
        push({
          label: v,
          insert: `${quoteValue(v)} `,
          kind: valueCtx.def.valueType === 'user' ? 'user' : valueCtx.def.valueType === 'project' ? 'project' : valueCtx.def.valueType === 'tag' ? 'tag' : 'value',
          description: valueCtx.def.name,
          replaceStart,
          replaceEnd: caret,
        });
      }
    }
    if (out.length) return out;
  }

  // Term names and keywords
  for (const name of vocab.termNames()) {
    if (matches(name, prefix)) {
      const def = vocab.term(name.toLowerCase());
      push({ label: `${name}:`, insert: `${name}: `, kind: 'field', description: def?.description, replaceStart, replaceEnd: caret });
    }
  }
  const keywords = [
    { label: '#Unresolved', insert: '#Unresolved ', description: 'Open issues' },
    { label: 'sort by:', insert: 'sort by: ', description: 'Order results' },
    { label: 'and', insert: 'and ', description: 'Both conditions' },
    { label: 'or', insert: 'or ', description: 'Either condition' },
  ];
  for (const k of keywords) {
    if (matches(k.label.replace(/^#/, ''), prefix) || matches(k.label, prefix)) {
      push({ label: k.label, insert: k.insert, kind: 'keyword', description: k.description, replaceStart, replaceEnd: caret });
    }
  }
  return out;
}
