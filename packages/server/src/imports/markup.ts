/**
 * Jira's rich text, as Markdown: Atlassian Document Format (Jira Cloud's API, version 3) and wiki
 * markup (Jira Data Center's). What a4a has no Markdown for keeps its words: a panel becomes a
 * quote, a mention its name, a file "(a file: name)". YouTrack writes Markdown already.
 */

interface AdfMark {
  type: string;
  attrs?: Record<string, unknown>;
}

interface AdfNode {
  type: string;
  text?: string;
  content?: AdfNode[];
  attrs?: Record<string, unknown>;
  marks?: AdfMark[];
}

const isNode = (x: unknown): x is AdfNode => Boolean(x) && typeof x === 'object' && typeof (x as AdfNode).type === 'string';

/** Markdown from an ADF document; a string comes back as it is. */
export function adfToMarkdown(doc: unknown): string {
  if (typeof doc === 'string') return doc;
  if (!isNode(doc)) return '';
  return blocks(doc.content ?? (doc.type === 'doc' ? [] : [doc]), '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
}

function withMarks(text: string, marks: AdfMark[] = []): string {
  if (!text) return '';
  if (marks.some((m) => m.type === 'code')) {
    const tick = text.includes('`') ? '``' : '`';
    const link = marks.find((m) => m.type === 'link');
    const code = `${tick}${text}${tick}`;
    return link ? `[${code}](${str(link.attrs?.href)})` : code;
  }
  let t = text;
  // Markdown's emphasis can't start or end on a space: keep the spaces outside it.
  const lead = /^\s*/.exec(t)![0];
  const trail = /\s*$/.exec(t)![0];
  t = t.trim();
  if (!t) return text;
  for (const m of marks) {
    if (m.type === 'strong') t = `**${t}**`;
    else if (m.type === 'em') t = `*${t}*`;
    else if (m.type === 'strike') t = `~~${t}~~`;
  }
  const link = marks.find((m) => m.type === 'link');
  if (link) t = `[${t}](${str(link.attrs?.href)})`;
  return `${lead}${t}${trail}`;
}

function inline(nodes: AdfNode[] = []): string {
  return nodes.map(inlineOne).join('');
}

function inlineOne(n: AdfNode): string {
  switch (n.type) {
    case 'text':
      return withMarks(n.text ?? '', n.marks);
    case 'hardBreak':
      return '  \n';
    case 'mention':
      return str(n.attrs?.text) || '@someone';
    case 'emoji':
      return str(n.attrs?.text) || str(n.attrs?.shortName);
    case 'inlineCard':
      return str(n.attrs?.url) ? `<${str(n.attrs?.url)}>` : '';
    case 'status':
      return str(n.attrs?.text) ? `[${str(n.attrs?.text)}]` : '';
    case 'date': {
      const t = Number(n.attrs?.timestamp);
      return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : '';
    }
    case 'mediaInline':
    case 'media':
      return `(a file${str(n.attrs?.alt) ? `: ${str(n.attrs?.alt)}` : ''})`;
    case 'placeholder':
      return '';
    default:
      return inline(n.content);
  }
}

function prefixLines(text: string, first: string, rest: string): string {
  return text
    .split('\n')
    .map((line, i) => (i === 0 ? first : line ? rest : rest.trimEnd()) + line)
    .join('\n');
}

function listItem(item: AdfNode, marker: string, indent: string): string {
  const pad = ' '.repeat(marker.length);
  const parts = (item.content ?? []).map((child) => (child.type === 'paragraph' ? inline(child.content) : blocks([child], '')));
  const body = parts.filter(Boolean).join('\n');
  return prefixLines(body || ' ', `${indent}${marker}`, `${indent}${pad}`);
}

function cellText(cell: AdfNode): string {
  return blocks(cell.content ?? [], '')
    .replace(/\n+/g, ' ')
    .replace(/\|/g, '\\|')
    .trim();
}

function table(n: AdfNode): string {
  const rows = (n.content ?? []).filter((r) => r.type === 'tableRow');
  if (!rows.length) return '';
  const cells = rows.map((r) => (r.content ?? []).map(cellText));
  const width = Math.max(...cells.map((c) => c.length));
  const line = (c: string[]) => `| ${Array.from({ length: width }, (_, i) => c[i] ?? '').join(' | ')} |`;
  const out = [line(cells[0]!), `| ${Array.from({ length: width }, () => '---').join(' | ')} |`, ...cells.slice(1).map(line)];
  return out.join('\n');
}

function block(n: AdfNode, indent: string): string {
  switch (n.type) {
    case 'paragraph':
      return inline(n.content);
    case 'heading': {
      const level = Math.min(6, Math.max(1, Number(n.attrs?.level) || 1));
      return `${'#'.repeat(level)} ${inline(n.content)}`;
    }
    case 'bulletList':
      return (n.content ?? []).map((item) => listItem(item, '- ', indent)).join('\n');
    case 'orderedList': {
      const start = Number(n.attrs?.order) || 1;
      return (n.content ?? []).map((item, i) => listItem(item, `${start + i}. `, indent)).join('\n');
    }
    case 'taskList':
      return (n.content ?? []).map((item) => `${indent}- [${item.attrs?.state === 'DONE' ? 'x' : ' '}] ${inline(item.content)}`).join('\n');
    case 'decisionList':
      return (n.content ?? []).map((item) => `${indent}- ${inline(item.content)}`).join('\n');
    case 'codeBlock': {
      const text = (n.content ?? []).map((t) => t.text ?? '').join('');
      const fence = text.includes('```') ? '~~~' : '```';
      return `${fence}${str(n.attrs?.language)}\n${text}\n${fence}`;
    }
    case 'blockquote':
      return prefixLines(blocks(n.content ?? [], ''), '> ', '> ');
    case 'panel':
      return prefixLines(blocks(n.content ?? [], ''), '> ', '> ');
    case 'expand':
    case 'nestedExpand': {
      const title = str(n.attrs?.title);
      const body = blocks(n.content ?? [], '');
      return title ? `**${title}**\n\n${body}` : body;
    }
    case 'rule':
      return '---';
    case 'table':
      return table(n);
    case 'mediaSingle':
    case 'mediaGroup':
      return (n.content ?? []).map(inlineOne).join(' ');
    case 'blockCard':
    case 'embedCard':
      return str(n.attrs?.url) ? `<${str(n.attrs?.url)}>` : '';
    default:
      return n.content ? (n.content.every((c) => !c.content && c.type !== 'paragraph') ? inline(n.content) : blocks(n.content, indent)) : inlineOne(n);
  }
}

function blocks(nodes: AdfNode[], indent: string): string {
  return nodes
    .map((n) => block(n, indent))
    .filter((t) => t.trim() !== '')
    .join('\n\n');
}

// ---------------------------------------------------------------------------
// Wiki markup (Jira Data Center)
// ---------------------------------------------------------------------------

function wikiInline(text: string): string {
  const codes: string[] = [];
  const keep = (s: string) => `\u0000${codes.push(s) - 1}\u0000`;
  let t = text.replace(/\{\{(.+?)\}\}/g, (_, c: string) => keep(`\`${c}\``));
  t = t
    .replace(/\[([^\]|]+)\|((?:https?|mailto):[^\]]+)\]/g, (_, label: string, href: string) => keep(`[${label}](${href})`))
    .replace(/\[((?:https?):[^\]|]+)\]/g, (_, href: string) => keep(`<${href}>`))
    .replace(/\[~([^\]]+)\]/g, (_, who: string) => `@${who}`)
    .replace(/!([^!\s|][^!|]*)(?:\|[^!]*)?!/g, (_, file: string) => `(a file: ${file})`)
    .replace(/\{color(?::[^}]*)?\}/g, '')
    .replace(/(^|[\s(])\*(\S(?:[^*]*?\S)?)\*(?=$|[\s.,;:!?)])/g, '$1**$2**')
    .replace(/(^|[\s(])_(\S(?:[^_]*?\S)?)_(?=$|[\s.,;:!?)])/g, '$1*$2*')
    .replace(/(^|[\s(])-(\S(?:[^-]*?\S)?)-(?=$|[\s.,;:!?)])/g, '$1~~$2~~');
  return t.replace(/\u0000(\d+)\u0000/g, (_, i: string) => codes[Number(i)]!);
}

/** Markdown from Jira's wiki markup, the common part of it: headings, emphasis, lists, quotes, code, links and tables. */
export function wikiToMarkdown(text: string): string {
  if (!text) return '';
  const fences: string[] = [];
  const fenced = (lang: string, body: string) => {
    const code = body.replace(/^\n/, '').replace(/\n$/, '');
    const fence = code.includes('```') ? '~~~' : '```';
    return `\n\u0001${fences.push(`${fence}${lang}\n${code}\n${fence}`) - 1}\u0001\n`;
  };
  // A block's {code} is never inside braces: {{code}} is the word "code" in monospace.
  let t = text
    .replace(/\r\n?/g, '\n')
    .replace(/(?<!\{)\{code(?::([a-zA-Z0-9+#-]+))?(?:\|[^}]*)?\}(?!\})([\s\S]*?)(?<!\{)\{code\}(?!\})/g, (_, lang: string | undefined, body: string) => fenced(lang ?? '', body))
    .replace(/(?<!\{)\{noformat(?:\|[^}]*)?\}(?!\})([\s\S]*?)(?<!\{)\{noformat\}(?!\})/g, (_, body: string) => fenced('', body));
  t = t.replace(/\{quote\}([\s\S]*?)\{quote\}/g, (_, body: string) =>
    body
      .trim()
      .split('\n')
      .map((l) => `bq. ${l}`)
      .join('\n'),
  );
  const out: string[] = [];
  let tableHead = false;
  for (const line of t.split('\n')) {
    const fence = /^\u0001(\d+)\u0001$/.exec(line.trim());
    if (fence) {
      out.push(fences[Number(fence[1])]!);
      continue;
    }
    let m = /^h([1-6])\.\s+(.*)$/.exec(line);
    if (m) {
      out.push(`${'#'.repeat(Number(m[1]))} ${wikiInline(m[2]!)}`);
      continue;
    }
    m = /^bq\.\s?(.*)$/.exec(line);
    if (m) {
      out.push(`> ${wikiInline(m[1]!)}`);
      continue;
    }
    m = /^([*#-]+)\s+(.*)$/.exec(line);
    if (m && !/^-{4,}$/.test(line.trim())) {
      const depth = m[1]!.length;
      const ordered = m[1]!.endsWith('#');
      out.push(`${'  '.repeat(depth - 1)}${ordered ? '1.' : '-'} ${wikiInline(m[2]!)}`);
      continue;
    }
    if (/^-{4,}\s*$/.test(line)) {
      out.push('---');
      continue;
    }
    if (/^\|\|/.test(line)) {
      const cells = line.replace(/^\|\||\|\|\s*$/g, '').split('||');
      out.push(`| ${cells.map((c) => wikiInline(c.trim())).join(' | ')} |`, `| ${cells.map(() => '---').join(' | ')} |`);
      tableHead = true;
      continue;
    }
    if (/^\|/.test(line)) {
      const cells = line.replace(/^\||\|\s*$/g, '').split('|');
      if (!tableHead) out.push(`| ${cells.map(() => ' ').join(' | ')} |`, `| ${cells.map(() => '---').join(' | ')} |`);
      out.push(`| ${cells.map((c) => wikiInline(c.trim())).join(' | ')} |`);
      tableHead = true;
      continue;
    }
    tableHead = false;
    out.push(wikiInline(line));
  }
  return out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
