/**
 * Whether a4a can trust who sent an email (D67): when its sender's domain passed DMARC at a mail
 * server the administrator names (HELPDESK_TRUSTED_AUTHSERV_IDS, by authserv-id), as that server's
 * own Authentication-Results header says (RFC 8601). Pure: nothing here touches the database.
 *
 * - Only the topmost header from a named server counts. Each server that takes a message adds its
 *   header above everything that came with it, so whatever a sender wrote lies below the named
 *   server's own; and RFC 8601 asks a server to remove headers that claim its authserv-id. A header
 *   from a server nobody named, or with no authserv-id at all (Exchange Online writes those), says
 *   nothing either way.
 * - Its DMARC results must all be `pass`, one of them for the domain the message says it's from
 *   (`header.from`): a pass for another domain says nothing of this sender.
 * - Read as RFC 8601 writes it: comments in parentheses (nested), quoted strings, folded lines, an
 *   optional version after the authserv-id, spaces around `=` and `;`, and keywords and the
 *   authserv-id in any case.
 */

export interface AuthResult {
  /** The method in lower case, without its version: `dmarc`, `dkim`, `spf`. */
  method: string;
  /** In lower case: `pass`, `fail`, `none`, `temperror`… */
  result: string;
  /** Its properties by `ptype.property` in lower case (`header.from`), with their values as written. */
  props: Map<string, string>;
}

export interface AuthResults {
  /** Who checked, in lower case: the server's authserv-id, usually its host name. */
  authservId: string;
  results: AuthResult[];
}

/** Why a sender can't be trusted, as a code the desk's log words. */
export type Untrusted = 'noneNamed' | 'noHeader' | 'noDmarc' | 'notPass' | 'otherDomain';
export type SenderTrust = { trusted: true; by: string } | { trusted: false; why: Untrusted };

type Token = { t: 'word' | 'quoted'; v: string } | { t: ';' | '=' };

/** A header's value as tokens, its comments dropped and its lines unfolded; null when it doesn't read (an unclosed quote or comment). */
function tokens(value: string): Token[] | null {
  const s = value.replace(/\r?\n[ \t]+/g, ' ');
  const out: Token[] = [];
  let i = 0;
  let word = '';
  const flush = () => {
    if (word) out.push({ t: 'word', v: word });
    word = '';
  };
  while (i < s.length) {
    const c = s[i]!;
    if (c === '(') {
      // A comment, which may nest and escape: it reads as a space.
      flush();
      let depth = 0;
      for (; i < s.length; i++) {
        const d = s[i]!;
        if (d === '\\') i++;
        else if (d === '(') depth++;
        else if (d === ')' && --depth === 0) break;
      }
      if (depth !== 0) return null;
      i++;
      continue;
    }
    if (c === '"') {
      flush();
      let v = '';
      let closed = false;
      for (i++; i < s.length; i++) {
        const d = s[i]!;
        if (d === '\\' && i + 1 < s.length) v += s[++i]!;
        else if (d === '"') {
          closed = true;
          break;
        } else v += d;
      }
      if (!closed) return null;
      out.push({ t: 'quoted', v });
      i++;
      continue;
    }
    if (c === ';' || c === '=') {
      flush();
      out.push({ t: c });
    } else if (/\s/.test(c)) flush();
    else word += c;
    i++;
  }
  flush();
  return out;
}

const isValue = (t: Token | undefined): t is { t: 'word' | 'quoted'; v: string } => t?.t === 'word' || t?.t === 'quoted';

/**
 * One Authentication-Results header's value, read: who checked, and what each method found. Null
 * when it names no authserv-id (its first word is a method's result) or doesn't read.
 */
export function parseAuthResults(value: string): AuthResults | null {
  const ts = tokens(value);
  if (!ts?.length) return null;
  const id = ts[0];
  if (!isValue(id) || ts[1]?.t === '=') return null;
  let i = 1;
  // An optional version, "1" today.
  if (ts[i]?.t === 'word' && /^\d+$/.test((ts[i] as { v: string }).v)) i++;
  const results: AuthResult[] = [];
  while (i < ts.length) {
    if (ts[i]!.t !== ';') {
      i++;
      continue;
    }
    i++;
    const m = ts[i];
    const eq = ts[i + 1];
    const r = ts[i + 2];
    // "; none": nothing was checked.
    if (!isValue(m) || eq?.t !== '=' || !isValue(r)) continue;
    const props = new Map<string, string>();
    i += 3;
    while (i < ts.length && ts[i]!.t !== ';') {
      const k = ts[i];
      const v = ts[i + 2];
      if (k?.t === 'word' && ts[i + 1]?.t === '=' && isValue(v)) {
        if (k.v.includes('.')) props.set(k.v.toLowerCase(), v.v);
        i += 3;
      } else i++;
    }
    results.push({ method: m.v.toLowerCase().replace(/\s*\/.*$/, ''), result: r.v.toLowerCase(), props });
  }
  return { authservId: id.v.toLowerCase(), results };
}

/** The domain an address or a bare domain names, in lower case. */
function domainOf(value: string): string {
  return value.trim().toLowerCase().replace(/^.*@/, '').replace(/\.$/, '');
}

/**
 * Whether the sender of a message is who it says, by its Authentication-Results headers (top first,
 * as they came) and the authserv-ids the administrator named.
 */
export function senderTrust(headers: readonly string[], sender: string, named: readonly string[]): SenderTrust {
  if (!named.length) return { trusted: false, why: 'noneNamed' };
  const names = new Set(named.map((n) => n.trim().toLowerCase()));
  let found: AuthResults | null = null;
  for (const h of headers) {
    const read = parseAuthResults(h);
    if (read && names.has(read.authservId)) {
      found = read;
      break;
    }
  }
  if (!found) return { trusted: false, why: 'noHeader' };
  const dmarc = found.results.filter((r) => r.method === 'dmarc');
  if (!dmarc.length) return { trusted: false, why: 'noDmarc' };
  if (dmarc.some((r) => r.result !== 'pass')) return { trusted: false, why: 'notPass' };
  const domain = domainOf(sender);
  if (!domain || !dmarc.some((r) => domainOf(r.props.get('header.from') ?? '') === domain)) return { trusted: false, why: 'otherDomain' };
  return { trusted: true, by: found.authservId };
}

/** The desk's log's words for why a sender couldn't be trusted (D67). */
export function untrustedWords(why: Untrusted): string {
  switch (why) {
    case 'noneNamed':
      return 'this server names no mail server whose DMARC results it trusts';
    case 'noHeader':
      return 'no mail server this server trusts checked it';
    case 'noDmarc':
      return 'the mail server that checked it checked no DMARC';
    case 'notPass':
      return 'its sender’s domain didn’t pass DMARC';
    default:
      return 'DMARC passed for a domain other than its sender’s';
  }
}
