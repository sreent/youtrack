/**
 * An email's words as plain text and as simple HTML: the same lines, the HTML escaped, with links
 * and nothing else. No images, no scripts, no styles and nothing loaded from outside, so it reads
 * the same in every client and gives nothing away when it's opened.
 */

export interface MailSection {
  /** Who did what, and when: "Anna Schmidt commented · Mon 16 Nov, 10:02 UTC". */
  head: string;
  /** Lines under it, such as each change: "State: Open → In Progress". */
  lines?: string[];
  /** What someone wrote, quoted as written (never rendered as Markdown or HTML). */
  quote?: string;
}

export interface MailContent {
  lead: string;
  sections: MailSection[];
  action: { label: string; url: string };
  /** Why this came: "You get this because you were mentioned." */
  why: string;
  stop?: { label: string; url: string };
  settings?: { label: string; url: string };
}

export interface RenderedMail {
  to: string;
  /** Who it's from, when not a4a's own address: a desk's address and name (D45). */
  from?: string;
  subject: string;
  text: string;
  html: string;
  headers: Record<string, string>;
  /** After the server accepted it, such as marking a notification emailed. */
  onSent?: () => Promise<void>;
  /** After an attempt failed, such as forgetting a tracking token nobody received. */
  onFailed?: () => Promise<void>;
}

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** A quote's lines, as written. */
function quoteLines(text: string): string[] {
  return text.replace(/\r\n?/g, '\n').trim().split('\n');
}

export function composeMail(subject: string, c: MailContent): { text: string; html: string } {
  const text: string[] = [c.lead, ''];
  const html: string[] = [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${esc(subject)}</title></head><body>`,
    `<p><strong>${esc(c.lead)}</strong></p>`,
  ];
  for (const s of c.sections) {
    text.push(s.head);
    html.push(`<p>${esc(s.head)}</p>`);
    if (s.lines?.length) {
      for (const l of s.lines) text.push(`    ${l}`);
      html.push(`<ul>${s.lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`);
    }
    if (s.quote?.trim()) {
      for (const l of quoteLines(s.quote)) text.push(`    > ${l}`);
      html.push(`<blockquote>${quoteLines(s.quote).map(esc).join('<br>')}</blockquote>`);
    }
    text.push('');
  }
  text.push(`${c.action.label}: ${c.action.url}`, '', '--', c.why);
  html.push(`<p><a href="${esc(c.action.url)}">${esc(c.action.label)}</a></p>`, '<hr>');
  const foot: string[] = [esc(c.why)];
  if (c.stop) {
    text.push(`${c.stop.label}: ${c.stop.url}`);
    foot.push(`<a href="${esc(c.stop.url)}">${esc(c.stop.label)}</a>`);
  }
  if (c.settings) {
    text.push(`${c.settings.label}: ${c.settings.url}`);
    foot.push(`<a href="${esc(c.settings.url)}">${esc(c.settings.label)}</a>`);
  }
  html.push(`<p><small>${foot.join('<br>')}</small></p>`, '</body></html>');
  return { text: `${text.join('\n')}\n`, html: html.join('\n') };
}

/** RFC 8058: a one-click POST to stop, which mail clients show as their own Unsubscribe. */
export function unsubscribeHeaders(oneClickUrl: string): Record<string, string> {
  return { 'List-Unsubscribe': `<${oneClickUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' };
}

/** Said of every mail a4a sends: it's automatic, so out-of-office replies shouldn't answer it. */
export const AUTOMATIC = { 'Auto-Submitted': 'auto-generated', 'X-Auto-Response-Suppress': 'All' } as const;

/** Mail about one thing threads under one id, so clients show its emails as one conversation. */
export function threadHeaders(threadId: string): Record<string, string> {
  return { 'In-Reply-To': threadId, References: threadId };
}
