/**
 * Rich text from other trackers, as Markdown: Jira's Atlassian Document Format (Jira Cloud's API,
 * version 3) and wiki markup (Jira Data Center's), Asana's rich text (html_notes, html_text: a small
 * XML dialect) and ClickUp's comments (Quill's delta). What a4a has no Markdown for keeps its words:
 * a panel becomes a quote, a mention its name, a file "(a file: name)", underlining plain text.
 * YouTrack writes Markdown already, and so does ClickUp's markdown_description.
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

// ---------------------------------------------------------------------------
// Asana's rich text (D61)
// ---------------------------------------------------------------------------

interface XmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: (XmlNode | string)[];
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Text with its entities read: &amp;, &#39;, &#x1F600; and the like. */
function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[e.toLowerCase()] ?? whole;
  });
}

/** A forgiving reader of Asana's rich text: tags, attributes and text; a close without its open is dropped, and what's left open closes at the end. */
function parseXml(source: string): XmlNode {
  const root: XmlNode = { tag: '#root', attrs: {}, children: [] };
  const stack: XmlNode[] = [root];
  const re = /<(\/?)([a-zA-Z][\w:-]*)((?:\s+[\w:-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*(\/?)>|<!--[\s\S]*?-->/g;
  let last = 0;
  for (let m = re.exec(source); m; m = re.exec(source)) {
    if (m.index > last) stack[stack.length - 1]!.children.push(decode(source.slice(last, m.index)));
    last = re.lastIndex;
    if (!m[2]) continue; // a comment
    const tag = m[2].toLowerCase();
    if (m[1]) {
      const at = stack.map((n) => n.tag).lastIndexOf(tag);
      if (at > 0) stack.length = at;
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const a of m[3]!.matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) attrs[a[1]!.toLowerCase()] = decode(a[2] ?? a[3] ?? a[4] ?? '');
    const node: XmlNode = { tag, attrs, children: [] };
    stack[stack.length - 1]!.children.push(node);
    if (!m[4] && !['hr', 'br', 'img'].includes(tag)) stack.push(node);
  }
  if (last < source.length) stack[stack.length - 1]!.children.push(decode(source.slice(last)));
  return root;
}

const BLOCK_TAGS = new Set(['body', 'h1', 'h2', 'h3', 'ul', 'ol', 'blockquote', 'pre', 'hr', 'table', 'p', 'div']);
const isBlock = (n: XmlNode | string) => typeof n !== 'string' && BLOCK_TAGS.has(n.tag);
const textOf = (n: XmlNode | string): string => (typeof n === 'string' ? n : n.children.map(textOf).join(''));

function xmlInline(nodes: (XmlNode | string)[]): string {
  return nodes.map(xmlInlineOne).join('');
}

function xmlInlineOne(n: XmlNode | string): string {
  if (typeof n === 'string') return n;
  const inner = () => xmlInline(n.children);
  switch (n.tag) {
    case 'strong':
    case 'b':
      return withMarks(inner(), [{ type: 'strong' }]);
    case 'em':
    case 'i':
      return withMarks(inner(), [{ type: 'em' }]);
    case 's':
    case 'del':
      return withMarks(inner(), [{ type: 'strike' }]);
    case 'code':
      return withMarks(textOf(n), [{ type: 'code' }]);
    case 'br':
      return '\n';
    case 'img':
      return `(a file${n.attrs.alt ? `: ${n.attrs.alt}` : ''})`;
    case 'a': {
      const text = inner();
      // A mention of a person, a task or a project there keeps its words: its link is Asana's alone.
      if (n.attrs['data-asana-type'] || n.attrs['data-asana-gid']) return text || n.attrs.href || '';
      const href = n.attrs.href ?? '';
      if (!/^(https?:|mailto:)/i.test(href)) return text;
      return !text || text === href ? `<${href}>` : `[${text}](${href})`;
    }
    default:
      return inner();
  }
}

/** Inline content, its lines as Asana keeps them: a newline a line break, a blank line a new paragraph. */
function paragraphs(nodes: (XmlNode | string)[]): string {
  return xmlInline(nodes)
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((p) =>
      p
        .split('\n')
        .map((l) => l.trimEnd())
        .filter((l) => l !== '')
        .join('  \n'),
    )
    .filter((p) => p.trim() !== '')
    .join('\n\n');
}

function xmlList(n: XmlNode, indent: string): string {
  const ordered = n.tag === 'ol';
  return n.children
    .filter((c): c is XmlNode => typeof c !== 'string' && c.tag === 'li')
    .map((li, i) => {
      const marker = ordered ? `${i + 1}. ` : '- ';
      const pad = ' '.repeat(marker.length);
      const own = li.children.filter((c) => !(typeof c !== 'string' && (c.tag === 'ul' || c.tag === 'ol')));
      const nested = li.children.filter((c): c is XmlNode => typeof c !== 'string' && (c.tag === 'ul' || c.tag === 'ol'));
      const first = prefixLines(paragraphs(own).replace(/\n\n/g, '\n') || ' ', `${indent}${marker}`, `${indent}${pad}`);
      return [first, ...nested.map((l) => xmlList(l, `${indent}${pad}`))].join('\n');
    })
    .join('\n');
}

function xmlTable(n: XmlNode): string {
  const rows: XmlNode[] = [];
  const walk = (x: XmlNode) => x.children.forEach((c) => typeof c !== 'string' && (c.tag === 'tr' ? rows.push(c) : walk(c)));
  walk(n);
  if (!rows.length) return '';
  const cells = rows.map((r) =>
    r.children
      .filter((c): c is XmlNode => typeof c !== 'string' && (c.tag === 'td' || c.tag === 'th'))
      .map((c) =>
        paragraphs(c.children)
          .replace(/\s*\n+\s*/g, ' ')
          .replace(/\|/g, '\\|')
          .trim(),
      ),
  );
  const width = Math.max(1, ...cells.map((c) => c.length));
  const line = (c: string[]) => `| ${Array.from({ length: width }, (_, i) => c[i] ?? '').join(' | ')} |`;
  return [line(cells[0]!), `| ${Array.from({ length: width }, () => '---').join(' | ')} |`, ...cells.slice(1).map(line)].join('\n');
}

function xmlBlocks(nodes: (XmlNode | string)[]): string {
  const out: string[] = [];
  let run: (XmlNode | string)[] = [];
  const flush = () => {
    if (run.length) out.push(paragraphs(run));
    run = [];
  };
  for (const n of nodes) {
    if (!isBlock(n)) {
      run.push(n);
      continue;
    }
    flush();
    const b = n as XmlNode;
    switch (b.tag) {
      case 'h1':
      case 'h2':
      case 'h3':
        out.push(`${'#'.repeat(Number(b.tag[1]))} ${paragraphs(b.children).replace(/\s*\n+\s*/g, ' ')}`);
        break;
      case 'ul':
      case 'ol':
        out.push(xmlList(b, ''));
        break;
      case 'blockquote':
        out.push(prefixLines(xmlBlocks(b.children), '> ', '> '));
        break;
      case 'pre': {
        const code = textOf(b).replace(/^\n/, '').replace(/\n$/, '');
        const fence = code.includes('```') ? '~~~' : '```';
        out.push(`${fence}\n${code}\n${fence}`);
        break;
      }
      case 'hr':
        out.push('---');
        break;
      case 'table':
        out.push(xmlTable(b));
        break;
      default:
        out.push(xmlBlocks(b.children));
    }
  }
  flush();
  return out.filter((t) => t.trim() !== '').join('\n\n');
}

/** Markdown from Asana's rich text (a task's html_notes, a comment's html_text); null or empty gives "". */
export function asanaToMarkdown(html: string | null | undefined): string {
  if (!html?.trim()) return '';
  return xmlBlocks(parseXml(html).children)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------------------------------------------------------------------------
// ClickUp's comments: Quill's delta (D61)
// ---------------------------------------------------------------------------

interface DeltaOp {
  text?: string;
  type?: string;
  attributes?: Record<string, unknown>;
  user?: { username?: string | null; email?: string | null } | null;
  emoticon?: { code?: string } | null;
  task_mention?: { task_id?: string } | null;
}

type LineKind = 'plain' | 'list' | 'quote' | 'code' | 'heading';

/** A line's kind, from the attributes on the newline that ends it. */
function lineKind(a: Record<string, unknown> = {}): { kind: LineKind; prefix: string } {
  const list = typeof a.list === 'string' ? a.list : typeof (a.list as { list?: unknown } | undefined)?.list === 'string' ? (a.list as { list: string }).list : null;
  const indent = '  '.repeat(Math.min(8, Math.max(0, Number(a.indent) || 0)));
  if (list) return { kind: 'list', prefix: `${indent}${list === 'ordered' ? '1. ' : list === 'checked' ? '- [x] ' : list === 'unchecked' ? '- [ ] ' : '- '}` };
  if (a['code-block']) return { kind: 'code', prefix: '' };
  if (a.blockquote) return { kind: 'quote', prefix: '> ' };
  const level = Number(a.header);
  if (level >= 1 && level <= 6) return { kind: 'heading', prefix: `${'#'.repeat(level)} ` };
  return { kind: 'plain', prefix: '' };
}

/** Markdown from a ClickUp comment's blocks; null when it isn't a list of them, so its plain text is used. */
export function deltaToMarkdown(ops: unknown): string | null {
  if (!Array.isArray(ops)) return null;
  const lines: { kind: LineKind; text: string }[] = [];
  let current = '';
  for (const op of ops as DeltaOp[]) {
    if (!op || typeof op !== 'object') continue;
    if (op.type === 'tag') {
      current += `@${op.user?.username || op.user?.email || 'someone'}`;
      continue;
    }
    if (op.type === 'emoticon') {
      const code = op.emoticon?.code ?? '';
      current += /^[0-9a-f]{2,6}(-[0-9a-f]{2,6})*$/i.test(code) ? String.fromCodePoint(...code.split('-').map((c) => parseInt(c, 16))) : (op.text ?? '');
      continue;
    }
    if (op.type === 'task_mention') {
      current += op.task_mention?.task_id ? `#${op.task_mention.task_id}` : '';
      continue;
    }
    const a = op.attributes ?? {};
    (typeof op.text === 'string' ? op.text : '').split('\n').forEach((part, i) => {
      if (i > 0) {
        // A newline ends a line, and its attributes say what kind of line it was.
        const { kind, prefix } = lineKind(a);
        lines.push({ kind, text: `${prefix}${current}` });
        current = '';
      }
      if (!part) return;
      if (a['code-block']) {
        current += part;
        return;
      }
      const marks: AdfMark[] = [];
      if (a.code) marks.push({ type: 'code' });
      if (a.bold) marks.push({ type: 'strong' });
      if (a.italic) marks.push({ type: 'em' });
      if (a.strike) marks.push({ type: 'strike' });
      if (typeof a.link === 'string' && /^(https?:|mailto:)/i.test(a.link)) marks.push({ type: 'link', attrs: { href: a.link } });
      current += withMarks(part, marks);
    });
  }
  if (current) lines.push({ kind: 'plain', text: current });
  // Lists, quotes and code keep their lines together; each other line is a paragraph.
  const out: string[] = [];
  for (let i = 0; i < lines.length; ) {
    const kind = lines[i]!.kind;
    const group: string[] = [lines[i++]!.text];
    if (kind === 'list' || kind === 'quote' || kind === 'code') while (i < lines.length && lines[i]!.kind === kind) group.push(lines[i++]!.text);
    if (kind === 'code') {
      const code = group.join('\n');
      const fence = code.includes('```') ? '~~~' : '```';
      out.push(`${fence}\n${code}\n${fence}`);
    } else out.push(group.join('\n'));
  }
  return out
    .filter((t) => t.trim() !== '')
    .join('\n\n')
    .trim();
}
