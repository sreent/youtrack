/**
 * Reading a message that came in for a help desk (D30): who sent it and to whom, what it says,
 * its files, and whether a person wrote it at all. Pure but for parsing: nothing here touches the
 * database, so every rule is tested against fixtures (test/fixtures/mail).
 *
 * - What a reply says is what's above the quoted history and the signature. Clients mark the
 *   history differently (Gmail's "On … wrote:", Outlook's header block, Apple Mail's blockquote),
 *   so each known way is cut; what's left, if anything, is the reply.
 * - HTML-only mail is turned into text, its quoted parts dropped before; nothing of its markup
 *   survives, as nothing of anyone's markup survives anywhere in a4a.
 * - Mail no person wrote (auto-replies, bounces, lists) is named, so it never becomes a request
 *   and no reply to it loops.
 */
import { createHash } from 'node:crypto';
import { convert } from 'html-to-text';
import { simpleParser, type AddressObject, type ParsedMail } from 'mailparser';

export interface MailFile {
  name: string;
  contentType: string;
  content: Buffer;
}

export interface ReadMail {
  /** As the sender's server gave it, or a hash of the bytes when there's none. */
  messageId: string;
  from: { address: string; name: string } | null;
  subject: string;
  /** Every address it was sent to, in lower case: To, Cc, and what servers add on delivery. */
  recipients: string[];
  /** Its Cc header alone, with the names it gives (D57): whom its sender copied. At most 100. */
  cc: { address: string; name: string }[];
  /** Message-IDs it answers (In-Reply-To and References), with their angle brackets. */
  answers: string[];
  /** All of its words: the text part, or the HTML's words when it has no text part. */
  text: string;
  /** Its words with quoted history and signature cut, as a reply's are read. */
  reply: string;
  /** It had no text part, so its words were read from its HTML. */
  htmlOnly: boolean;
  files: MailFile[];
  /** Files left out, and why: "logo.png: a small picture in the signature". */
  skipped: string[];
  /** Why no person wrote it, in words; null when one did. */
  automatic: string | null;
  /** Its own server says it failed DMARC: whoever it says sent it may not have. */
  failedSenderChecks: boolean;
  /** Its Authentication-Results headers' values, top first as they came (RFC 8601): whom a4a trusts is read from them (helpdesk/trust.ts, D67). */
  authResults: string[];
  /** The message as it came, to keep when what's shown isn't all of it. */
  raw: Buffer;
}

/** Inline pictures under this size are signatures' logos and the like, not what someone meant to send. */
export const SMALL_INLINE_BYTES = 16 * 1024;
/** No more files than this from one message. */
export const MAX_FILES = 20;
/** Signatures and wrappers, which nobody can open or needs. */
const SKIP_TYPES = new Set([
  'application/pkcs7-signature',
  'application/x-pkcs7-signature',
  'application/pgp-signature',
  'application/ms-tnef',
  'application/vnd.ms-tnef',
  'message/delivery-status',
]);

export async function readMail(raw: Buffer): Promise<ReadMail> {
  const mail = await simpleParser(raw, { skipHtmlToText: true, skipTextToHtml: true, skipTextLinks: true, skipImageLinks: true });
  const lines = mail.headerLines.map((l) => ({ key: l.key.toLowerCase(), value: l.line.slice(l.line.indexOf(':') + 1).trim() }));
  const from = firstAddress(mail.from);
  const htmlOnly = !mail.text?.trim() && typeof mail.html === 'string' && mail.html.trim() !== '';
  const text = normalize(htmlOnly ? htmlText(mail.html as string) : (mail.text ?? ''));
  const reply = stripReply(htmlOnly ? htmlText(withoutQuotedHtml(mail.html as string)) : text);
  const { files, skipped } = filesOf(mail);
  return {
    messageId: messageIdOf(mail, raw),
    from,
    subject: (mail.subject ?? '').replace(/\s+/g, ' ').trim(),
    recipients: recipientsOf(mail, lines),
    cc: ccOf(mail),
    answers: [...new Set([...ids(mail.inReplyTo), ...ids(mail.references)])],
    text,
    reply,
    htmlOnly,
    files,
    skipped,
    automatic: automaticReason(mail, lines, from),
    failedSenderChecks: failedDmarc(lines),
    authResults: lines.filter((l) => l.key === 'authentication-results').map((l) => l.value),
    raw,
  };
}

function messageIdOf(mail: ParsedMail, raw: Buffer): string {
  const given = mail.messageId?.trim();
  if (given) return given.startsWith('<') ? given : `<${given}>`;
  return `<${createHash('sha256').update(raw).digest('hex')}@no-message-id>`;
}

function firstAddress(field: AddressObject | AddressObject[] | undefined): { address: string; name: string } | null {
  const list = Array.isArray(field) ? field.flatMap((f) => f.value) : (field?.value ?? []);
  const first = list.find((a) => a.address);
  return first?.address ? { address: first.address.trim().toLowerCase(), name: (first.name ?? '').replace(/\s+/g, ' ').trim() } : null;
}

const DELIVERED = new Set(['delivered-to', 'x-original-to', 'envelope-to', 'x-envelope-to', 'x-forwarded-to', 'x-delivered-to']);
const ADDRESS = /[^\s<>"',;:]+@[^\s<>"',;:]+/g;

function recipientsOf(mail: ParsedMail, lines: { key: string; value: string }[]): string[] {
  const out = new Set<string>();
  for (const field of [mail.to, mail.cc]) {
    const list = Array.isArray(field) ? field.flatMap((f) => f.value) : (field?.value ?? []);
    for (const a of list) if (a.address) out.add(a.address.trim().toLowerCase());
  }
  for (const l of lines) if (DELIVERED.has(l.key)) for (const m of l.value.matchAll(ADDRESS)) out.add(m[0].toLowerCase());
  return [...out];
}

function ccOf(mail: ParsedMail): { address: string; name: string }[] {
  const list = Array.isArray(mail.cc) ? mail.cc.flatMap((f) => f.value) : (mail.cc?.value ?? []);
  // A group in the header ("team: a@x, b@y;") lists its members under it.
  const flat = list.flatMap((a) => (a.group?.length ? a.group : [a]));
  return flat
    .filter((a) => a.address)
    .slice(0, 100)
    .map((a) => ({ address: a.address!.trim().toLowerCase(), name: (a.name ?? '').replace(/\s+/g, ' ').trim() }));
}

function ids(value: string | string[] | undefined): string[] {
  const all = Array.isArray(value) ? value.join(' ') : (value ?? '');
  return [...all.matchAll(/<[^<>\s]+>/g)].map((m) => m[0]);
}

// ---------------------------------------------------------------------------
// Mail no person wrote
// ---------------------------------------------------------------------------

export function automaticReason(mail: ParsedMail, lines: { key: string; value: string }[], from: { address: string } | null): string | null {
  const header = (key: string) => lines.find((l) => l.key === key)?.value.toLowerCase().trim();
  const has = (key: string) => lines.some((l) => l.key === key);
  // RFC 3834: anything but "no" was sent by a machine (auto-replied, auto-generated, auto-notified).
  const autoSubmitted = header('auto-submitted');
  if (autoSubmitted && autoSubmitted !== 'no') return autoSubmitted.startsWith('auto-replied') ? 'an automatic reply' : 'sent automatically';
  if (has('x-autoreply') || has('x-autorespond') || has('x-autoresponse')) return 'an automatic reply';
  const precedence = header('precedence');
  if (precedence && /^(bulk|junk|list|auto_reply)$/.test(precedence)) return 'bulk or list mail';
  if (has('list-id') || has('list-post')) return 'from a mailing list';
  const type = mail.headers.get('content-type') as { value?: string; params?: Record<string, string> } | undefined;
  if (type?.value === 'multipart/report') return 'a delivery report (a bounce)';
  if (has('x-failed-recipients')) return 'a delivery report (a bounce)';
  const returnPath = header('return-path');
  if (returnPath === '<>' || returnPath === '') return 'a delivery report (a bounce)';
  const local = from?.address.split('@')[0] ?? '';
  if (/^(mailer-daemon|postmaster)$/.test(local)) return 'a delivery report (a bounce)';
  if (/^(no-?reply|do-?not-?reply)([._+-]|$)/.test(local)) return 'from an address that takes no replies';
  return null;
}

/**
 * Whether its own server says it failed DMARC. Only the topmost Authentication-Results counts: it
 * is the receiving server's own, where any below it came with the message and could say anything.
 */
function failedDmarc(lines: { key: string; value: string }[]): boolean {
  const top = lines.find((l) => l.key === 'authentication-results');
  return top ? /\bdmarc\s*=\s*fail\b/i.test(top.value) : false;
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

function normalize(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/ /g, ' ')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** An HTML body's words, as plain text: no markup, links as their words with the address after unless they're the same. */
export function htmlText(html: string): string {
  return normalize(
    convert(html, {
      wordwrap: false,
      selectors: [
        { selector: 'img', format: 'skip' },
        { selector: 'style', format: 'skip' },
        { selector: 'script', format: 'skip' },
        { selector: 'head', format: 'skip' },
        { selector: 'a', options: { hideLinkHrefIfSameAsText: true, linkBrackets: ['<', '>'] } },
        { selector: 'h1', options: { uppercase: false } },
        { selector: 'h2', options: { uppercase: false } },
        { selector: 'h3', options: { uppercase: false } },
        { selector: 'table', format: 'dataTable', options: { uppercaseHeaderCells: false } },
      ],
    }),
  );
}

/**
 * HTML without what clients quote below a reply: Gmail's quote, Apple Mail's and Thunderbird's
 * cited blockquote, and everything after Outlook's reply header.
 */
export function withoutQuotedHtml(html: string): string {
  let out = html;
  // Outlook (desktop and web) puts its "From: … Sent: …" block in a div, and the history after it.
  const cut = out.search(/<div[^>]+id=["']?(divRplyFwdMsg|appendonsend)["'\s>]|<hr[^>]+id=["']?stopSpelling/i);
  if (cut >= 0) out = out.slice(0, cut);
  const gmail = out.search(/<div[^>]+class=["'][^"']*\bgmail_quote\b/i);
  if (gmail >= 0) out = out.slice(0, gmail);
  return out
    .replace(/<blockquote[^>]*type=["']?cite["']?[^>]*>[\s\S]*?<\/blockquote>/gi, '')
    .replace(/<div[^>]+class=["'][^"']*\b(gmail_signature|moz-signature)\b[^"']*["'][^>]*>[\s\S]*?<\/div>/gi, '');
}

/** Lines where the quoted history starts, as clients write them (and a few languages besides English). */
const HISTORY: RegExp[] = [
  // Gmail and Apple Mail: "On Mon, 16 Nov 2026 at 10:02, Jane Doe <jane@example.com> wrote:", which may wrap.
  /^On\b[^\n]*(?:\n[^\n]*){0,2}?\bwrote:[ \t]*$/m,
  /^Le\b[^\n]*(?:\n[^\n]*){0,2}?\ba écrit ?:[ \t]*$/m,
  /^Am\b[^\n]*(?:\n[^\n]*){0,2}?\bschrieb[^\n]*:[ \t]*$/m,
  /^El\b[^\n]*(?:\n[^\n]*){0,2}?\bescribió:[ \t]*$/m,
  /^Op\b[^\n]*(?:\n[^\n]*){0,2}?\bschreef[^\n]*:[ \t]*$/m,
  // Outlook: a rule, or the original message's header block.
  /^-{2,}[ \t]*Original Message[ \t]*-{2,}[ \t]*$/im,
  /^_{10,}[ \t]*\n(?:\*?From|\*?Von|\*?De):/m,
  /^\*?From:\*?[^\n]*\n\*?(?:Sent|Date):\*?[^\n]*\n/m,
  /^-{3,}[ \t]*Forwarded message[ \t]*-{3,}/im,
  /^Begin forwarded message:/m,
];

/** Where a signature starts: the "-- " line (RFC 3676), or what phones add. */
const SIGNATURE = /^(?:-- ?|Sent from my [^\n]+|Get Outlook for (?:iOS|Android)[^\n]*|Sent from Mail for Windows[^\n]*|Sent from Yahoo Mail[^\n]*)$/m;

/** What a reply says: what's above its quoted history, without trailing quotes and without its signature. */
export function stripReply(text: string): string {
  let out = normalize(text);
  let cut = out.length;
  for (const re of HISTORY) {
    const m = re.exec(out);
    if (m && m.index < cut) cut = m.index;
  }
  out = out.slice(0, cut);
  // A block of quoted lines at the end, with nothing after it, is history too.
  const lines = out.split('\n');
  while (lines.length && (lines[lines.length - 1]!.startsWith('>') || !lines[lines.length - 1]!.trim())) lines.pop();
  return stripSignature(lines.join('\n'));
}

/** Text without its signature. */
export function stripSignature(text: string): string {
  const m = SIGNATURE.exec(text);
  return normalize(m ? text.slice(0, m.index) : text);
}

/** At most `max` characters, cut at a word with an ellipsis when longer. Says whether it cut. */
export function clip(text: string, max: number): { text: string; cut: boolean } {
  if (text.length <= max) return { text, cut: false };
  const head = text.slice(0, max - 1);
  const space = head.lastIndexOf(' ');
  return { text: `${space > max * 0.8 ? head.slice(0, space) : head}…`, cut: true };
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

const EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/csv': 'csv',
  'application/json': 'json',
  'application/zip': 'zip',
  'message/rfc822': 'eml',
};

function filesOf(mail: ParsedMail): { files: MailFile[]; skipped: string[] } {
  const files: MailFile[] = [];
  const skipped: string[] = [];
  mail.attachments.forEach((a, i) => {
    const type = (a.contentType || 'application/octet-stream').toLowerCase();
    const name = a.filename?.trim() || `attachment-${i + 1}.${EXT[type] ?? 'bin'}`;
    if (SKIP_TYPES.has(type)) return;
    const inline = a.related || a.contentDisposition === 'inline';
    if (inline && type.startsWith('image/') && a.size < SMALL_INLINE_BYTES) {
      skipped.push(`${name}: a small picture in the message, such as a signature's`);
      return;
    }
    if (files.length >= MAX_FILES) {
      skipped.push(`${name}: one message brings at most ${MAX_FILES} files`);
      return;
    }
    files.push({ name, contentType: type, content: a.content });
  });
  return { files, skipped };
}
