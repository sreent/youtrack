import type { ParsedQuery, QueryNode, ValueNode } from './parser';

function value(v: ValueNode): string {
  if (v.kind === 'range') {
    if (v.from && v.to) return `between ${v.from} and ${v.to}`;
    if (v.from) return `${v.from} or later`;
    if (v.to) return `up to ${v.to}`;
    return 'any';
  }
  return v.negated ? `not ${v.raw}` : v.raw;
}

function values(vs: ValueNode[]): string {
  const pos = vs.filter((v) => !(v.kind === 'single' && v.negated)).map(value);
  const neg = vs.filter((v) => v.kind === 'single' && v.negated).map(value);
  const parts: string[] = [];
  if (pos.length) parts.push(pos.length === 1 ? pos[0]! : `${pos.slice(0, -1).join(', ')} or ${pos[pos.length - 1]}`);
  if (neg.length) parts.push(neg.join(' and '));
  return parts.join(' and ');
}

function node(n: QueryNode): string {
  switch (n.kind) {
    case 'and':
      return n.items.map(node).filter(Boolean).join(', ');
    case 'or':
      return `(${n.items.map(node).join(' or ')})`;
    case 'not':
      return `not (${node(n.item)})`;
    case 'text':
      return n.exact ? `containing the phrase "${n.text}"` : `matching "${n.text}"`;
    case 'hash': {
      const v = n.value.toLowerCase();
      if (v === 'unresolved') return 'unresolved';
      if (v === 'resolved') return 'resolved';
      if (v === 'me' || v === 'my') return 'assigned to you';
      return `#${n.value}`;
    }
    case 'term': {
      const name = n.def.name;
      const t = n.def.term;
      if (t.kind === 'has') {
        const set = n.values.filter((v) => !(v.kind === 'single' && v.negated)).map(value);
        const unset = n.values.filter((v) => v.kind === 'single' && v.negated).map((v) => (v.kind === 'single' ? v.raw : ''));
        return [set.length ? `with ${set.join(', ')} set` : '', unset.length ? `without ${unset.join(', ')}` : ''].filter(Boolean).join(' and ');
      }
      if (t.kind === 'assigneeAlias') return `assigned to ${values(n.values).replace(/\bme\b/g, 'you')}`;
      if (t.kind === 'userAttr' && t.column === 'watcher') return `watched by ${values(n.values).replace(/\bme\b/g, 'you')}`;
      if (t.kind === 'sla') return `whose first response is ${values(n.values)}`;
      if (t.kind === 'requester') return `asked for by ${values(n.values)}`;
      if (t.kind === 'project') return `in project ${values(n.values)}`;
      if (t.kind === 'dateAttr') return `${name} ${values(n.values)}`;
      if (t.kind === 'linkPhrase') return `that ${name} ${values(n.values)}`;
      return `${name}: ${values(n.values).replace(/\bme\b/g, 'you')}`;
    }
  }
}

export function explainParsed(parsed: ParsedQuery): string {
  const body = parsed.root ? node(parsed.root) : '';
  const sort = parsed.sort.length
    ? ` sorted by ${parsed.sort.map((s) => `${s.display}${s.dir === 'desc' ? ' (descending)' : ''}`).join(', ')}`
    : '';
  if (!body) return `All issues${sort || ' (most recently updated first)'}`;
  return `Issues ${body}${sort}`;
}
