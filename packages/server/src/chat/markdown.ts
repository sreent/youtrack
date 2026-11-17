/**
 * A chat message as a4a's Markdown (D60): Slack's mrkdwn and Teams' HTML, converted so the message reads
 * as it did there, and so nothing in it runs or reaches out: no raw HTML (what looked like a tag is
 * text), links only to http, https and mailto, pictures never fetched (their words stay), and people
 * named as the chat named them, never mentioned in a4a, whose logins aren't theirs.
 */
import { convert, type FormatCallback } from 'html-to-text';

/** The most of a message the form holds: Slack's text input takes 3,000 characters, and Teams' form the same. */
export const FORM_MAX = 3000;
/** The longest summary the form offers: the message's first line, cut at a word. */
export const SUMMARY_MAX = 250;

/**
 * "@" and a person's name, as the chat showed it, with a word joiner between: it reads the same, and
 * a4a's mentions (@a4a/shared/mentions), which take a login straight after the "@", find none in it.
 */
export const named = (name: string) => `@⁠${escapeMd(name.trim() || '?')}`;

/** Text that reads as itself in Markdown: what would make emphasis, code, a link, a tag or a table is escaped. */
export function escapeMd(text: string): string {
  return text
    .replace(/[\\`*_[\]<>~|]/g, '\\$&')
    .replace(/&(?=#?[A-Za-z0-9]+;)/g, '\\&')
    .replace(/^(\s*)(#{1,6}|[-+=]+|\d{1,9}[.)])(?=\s|$)/gm, (_, space: string, mark: string) => `${space}${/^\d/.test(mark) ? mark.replace(/([.)])$/, '\\$1') : `\\${mark}`}`);
}

/** A link's address, if it may be one: http, https or mailto, written so Markdown keeps it whole. */
export function safeHref(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (!['http:', 'https:', 'mailto:'].includes(url.protocol)) return null;
  return url.href.replace(/[()<>\s\\]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
}

const link = (label: string, href: string | null) => (href ? `[${escapeMd(label) || escapeMd(href)}](${href})` : escapeMd(label));

/** Code as inline code, with enough backticks around it. */
function inlineCode(code: string): string {
  const longest = Math.max(0, ...[...code.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(longest + 1);
  return /^`|`$/.test(code) ? `${fence} ${code} ${fence}` : `${fence}${code}${fence}`;
}

function fenced(code: string): string {
  const longest = Math.max(2, ...[...code.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(longest + 1);
  return `\n\n${fence}\n${code.replace(/^\n+|\n+$/g, '')}\n${fence}\n\n`;
}

// ---------------------------------------------------------------------------
// Slack's mrkdwn
// ---------------------------------------------------------------------------

/** Slack escapes three characters in a message's text; everything else is as typed. */
const unescapeSlack = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** Slack's ids of people in a text: <@U123>, <@W123|name>. */
export function slackMentions(text: string): string[] {
  return [...new Set([...text.matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g)].map((m) => m[1]!))];
}

/** One of Slack's <…>: a person, a channel, a group, a date, @here, or a link. */
function slackToken(inner: string, names: ReadonlyMap<string, string>): string {
  const [target = '', ...rest] = inner.split('|');
  const label = unescapeSlack(rest.join('|'));
  if (/^@[UW][A-Z0-9]+$/.test(target)) return named(names.get(target.slice(1)) || label || target.slice(1));
  if (target.startsWith('#')) return `#${escapeMd(label || target.slice(1))}`;
  if (target.startsWith('!subteam^')) return named(label.replace(/^@/, '') || target.slice(9));
  if (/^!(here|channel|everyone)$/.test(target)) return named(target.slice(1));
  if (target.startsWith('!')) return escapeMd(label);
  const href = safeHref(unescapeSlack(target));
  return link(label || unescapeSlack(target), href);
}

/**
 * Slack's mrkdwn as Markdown: *bold*, _italic_, ~struck~, `code`, ```blocks``` and > quotes as
 * Markdown says them; links, people, channels and dates from their <…>; everything else as typed.
 * `names` gives people's names by their Slack id.
 */
export function mrkdwnToMarkdown(text: string, names: ReadonlyMap<string, string> = new Map()): string {
  const held: string[] = [];
  // What's worked out already waits in a private-use mark, so what follows leaves it alone.
  const hold = (md: string) => `${held.push(md) - 1}`;
  let s = text
    .replace(/```([\s\S]*?)```/g, (_, code: string) => hold(fenced(unescapeSlack(code))))
    .replace(/`([^`\n]+)`/g, (_, code: string) => hold(inlineCode(unescapeSlack(code))))
    .replace(/<([^<>\n]*)>/g, (_, inner: string) => hold(slackToken(inner, names)));
  s = escapeMd(unescapeSlack(s));
  // Slack's marks, escaped by now, become Markdown's where Slack would have read them: at a word's edges.
  const edge = '(^|[\\s(\\uE001"\'])';
  const end = '(?=$|[\\s.,;:!?)"\'\\uE000])';
  s = s
    .replace(new RegExp(`${edge}\\\\\\*(?=[^\\s*])((?:[^*\\n]|\\\\\\*)*?[^\\s\\\\])\\\\\\*${end}`, 'gm'), '$1**$2**')
    .replace(new RegExp(`${edge}\\\\_(?=[^\\s_])((?:[^_\\n])*?[^\\s\\\\])\\\\_${end}`, 'gm'), '$1_$2_')
    .replace(new RegExp(`${edge}\\\\~(?=[^\\s~])((?:[^~\\n])*?[^\\s\\\\])\\\\~${end}`, 'gm'), '$1~~$2~~')
    // A quote: "> " starting a line.
    .replace(/^\\>\s?/gm, '> ');
  return tidy(s.replace(/(\d+)/g, (_, i: string) => held[Number(i)] ?? ''));
}

// ---------------------------------------------------------------------------
// Teams' HTML
// ---------------------------------------------------------------------------

type Elem = Parameters<FormatCallback>[0];

/** An element's text, as it reads: for code, a person's name, and an image's words. */
function textIn(elem: Elem): string {
  const nodes = (elem as { children?: Elem[] }).children ?? [];
  return nodes
    .map((n) => {
      const node = n as unknown as { type?: string; data?: string; name?: string };
      if (node.type === 'text') return node.data ?? '';
      if (node.name === 'br') return '\n';
      return textIn(n);
    })
    .join('');
}

const attr = (elem: Elem, name: string): string => String((elem as { attribs?: Record<string, string> }).attribs?.[name] ?? '');

/** Markup around what an element holds: **, _, ~~. */
const around =
  (mark: string): FormatCallback =>
  (elem, walk, builder) => {
    builder.addInline(mark, { noWordTransform: true });
    walk((elem as { children?: Elem[] }).children ?? [], builder);
    builder.addInline(mark, { noWordTransform: true });
  };

const FORMATTERS: Record<string, FormatCallback> = {
  mdStrong: around('**'),
  mdEm: around('_'),
  mdStrike: around('~~'),
  mdCode: (elem, _walk, builder) => builder.addInline(inlineCode(textIn(elem)), { noWordTransform: true }),
  mdPre: (elem, _walk, builder) => {
    builder.openBlock({ isPre: true, leadingLineBreaks: 2 });
    builder.addInline(fenced(textIn(elem)).trim(), { noWordTransform: true });
    builder.closeBlock({ trailingLineBreaks: 2 });
  },
  mdLink: (elem, walk, builder) => {
    const href = safeHref(attr(elem, 'href'));
    if (!href) return walk((elem as { children?: Elem[] }).children ?? [], builder);
    builder.addInline('[', { noWordTransform: true });
    walk((elem as { children?: Elem[] }).children ?? [], builder);
    builder.addInline(`](${href})`, { noWordTransform: true });
  },
  // <at id="0">Ben Okafor</at>: named, never mentioned.
  mdMention: (elem, _walk, builder) => builder.addInline(named(textIn(elem)), { noWordTransform: true }),
  // A picture is never fetched: its words (an emoji's, an image's alt) stay.
  mdImage: (elem, _walk, builder) => {
    const alt = attr(elem, 'alt').trim();
    if (alt) builder.addInline(escapeMd(alt), { noWordTransform: true });
  },
  mdHeading: (elem, walk, builder) => {
    builder.openBlock({ leadingLineBreaks: 2 });
    builder.addInline('### ', { noWordTransform: true });
    walk((elem as { children?: Elem[] }).children ?? [], builder);
    builder.closeBlock({ trailingLineBreaks: 2 });
  },
  // A line break inside a paragraph stays one: Markdown's hard break.
  mdBreak: (_elem, _walk, builder) => {
    builder.addInline('\\', { noWordTransform: true });
    builder.addLineBreak();
  },
};

/** Elements whose content never reaches the description: what runs, what's drawn or asked, what's Teams' own. */
const SKIPPED = ['script', 'style', 'head', 'title', 'iframe', 'frame', 'object', 'embed', 'applet', 'template', 'noscript', 'svg', 'math', 'canvas', 'video', 'audio', 'form', 'input', 'button', 'select', 'textarea', 'attachment', 'systemEventMessage'];

/** A word of a message's text, escaped: inline marks everywhere, and a list's or a heading's mark when it stands alone. */
function escapeWord(word: string): string {
  if (/^(#{1,6}|[-+=]+)$/.test(word)) return `\\${word}`;
  if (/^\d{1,9}[.)]$/.test(word)) return word.replace(/([.)])$/, '\\$1');
  return escapeMd(word);
}

/** Teams' message HTML as Markdown, with nothing in it that runs. */
export function teamsHtmlToMarkdown(html: string): string {
  const markdown = convert(html, {
    wordwrap: false,
    decodeEntities: true,
    // The runtime takes a function too (its types say a map): each word of text, escaped.
    encodeCharacters: escapeWord as unknown as Record<string, string>,
    formatters: FORMATTERS,
    selectors: [
      ...SKIPPED.map((selector) => ({ selector, format: 'skip' })),
      { selector: 'b', format: 'mdStrong' },
      { selector: 'strong', format: 'mdStrong' },
      { selector: 'i', format: 'mdEm' },
      { selector: 'em', format: 'mdEm' },
      { selector: 's', format: 'mdStrike' },
      { selector: 'strike', format: 'mdStrike' },
      { selector: 'del', format: 'mdStrike' },
      { selector: 'code', format: 'mdCode' },
      { selector: 'pre', format: 'mdPre' },
      { selector: 'a', format: 'mdLink' },
      { selector: 'at', format: 'mdMention' },
      { selector: 'img', format: 'mdImage' },
      { selector: 'br', format: 'mdBreak' },
      ...['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].map((selector) => ({ selector, format: 'mdHeading' })),
      { selector: 'ul', format: 'unorderedList', options: { itemPrefix: '- ' } },
      { selector: 'ol', format: 'orderedList' },
      { selector: 'blockquote', format: 'blockquote' },
      { selector: 'table', format: 'block' },
      { selector: 'tr', format: 'block' },
      { selector: 'hr', format: 'horizontalLine', options: { length: 3 } },
    ],
  });
  // A hard break that ends a paragraph breaks nothing.
  return tidy(markdown.replace(/\\\n(?=\s*\n|\s*$)/g, '\n'));
}

// ---------------------------------------------------------------------------
// What the form starts with
// ---------------------------------------------------------------------------

function tidy(s: string): string {
  return s
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Markdown read as plain words, for a summary. */
export function plainOf(markdown: string): string {
  return markdown
    .replace(/^```.*$/gm, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|~~|`+)/g, '')
    .replace(/(^|\s)_(\S[^_]*\S|\S)_(?=\s|$)/g, '$1$2')
    .replace(/^\s*(>\s*|#{1,6}\s+|[-+]\s+)/gm, '')
    .replace(/\\([\\`*_[\]<>~|&#+=.)-])/g, '$1')
    .replace(/⁠/g, '');
}

/** The summary the form offers: the message's first line with words in it, cut at a word. */
export function firstLine(markdown: string): string {
  const line = plainOf(markdown)
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .find((l) => /[\p{L}\p{N}]/u.test(l));
  if (!line) return '';
  if (line.length <= SUMMARY_MAX) return line;
  const cut = line.slice(0, SUMMARY_MAX - 1);
  const atWord = cut.lastIndexOf(' ');
  return `${(atWord > SUMMARY_MAX / 2 ? cut.slice(0, atWord) : cut).trimEnd()}…`;
}

/** Text cut to a length, at a line or a word where one is near, and whether it was. */
export function cutTo(text: string, max: number): { text: string; cut: boolean } {
  if (text.length <= max) return { text, cut: false };
  const head = text.slice(0, max);
  const at = Math.max(head.lastIndexOf('\n'), head.lastIndexOf(' '));
  return { text: (at > max * 0.8 ? head.slice(0, at) : head).trimEnd(), cut: true };
}
