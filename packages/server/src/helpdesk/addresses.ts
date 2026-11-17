/**
 * A help desk's address, and the reply addresses made from it (D30): support@acme.example, and
 * support+<token>@acme.example in each email to a requester, so an answer by email finds its
 * request. The token is random (130 bits), in lower case (some servers fold a local part's case),
 * and kept only as its SHA-256 hash; each email mints one, as tracking tokens are minted.
 */
import { randomBytes } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import type { Db } from '../db/client';
import { helpdeskReplyTokens } from '../db/schema';
import { sha256 } from '../lib/crypto';

/** A reply address's token: 26 characters of lower-case base 32. */
export const REPLY_TOKEN = /^[a-z2-7]{26}$/;
/** What a reply address adds to the desk's local part: "+" and the token. */
const TOKEN_ROOM = 27;
/** RFC 5321's limit on a local part. */
const LOCAL_MAX = 64;

export function splitAddress(address: string): { local: string; domain: string } | null {
  const at = address.lastIndexOf('@');
  if (at <= 0 || at === address.length - 1) return null;
  return { local: address.slice(0, at).toLowerCase(), domain: address.slice(at + 1).toLowerCase() };
}

/** Why an address can't be a desk's, in words; null when it can. */
export function deskAddressProblem(address: string): { message: string; key: string; values?: Record<string, number> } | null {
  // Each with its key under problem.* (D49): the page says it, and the fix the caller gives, in its person's language.
  const parts = splitAddress(address);
  if (!parts) return { message: 'That isn’t an email address', key: 'helpdeskMail.notAnAddress' };
  if (parts.local.includes('+')) return { message: 'Leave out the “+” part: a4a adds one to each reply address', key: 'helpdeskMail.leaveOutPlus' };
  if (parts.local.length + TOKEN_ROOM > LOCAL_MAX) {
    return {
      message: `Its part before the “@” is too long: reply addresses add ${TOKEN_ROOM} characters to it, and ${LOCAL_MAX} is the most`,
      key: 'helpdeskMail.localPartTooLong',
      values: { room: TOKEN_ROOM, max: LOCAL_MAX },
    };
  }
  return null;
}

/**
 * Whether a recipient is this desk's address, and the token in it if it's a reply address. Null
 * when it isn't the desk's at all.
 */
export function deskRecipient(desk: string, recipient: string): { token: string | null } | null {
  const d = splitAddress(desk);
  const r = splitAddress(recipient);
  if (!d || !r || d.domain !== r.domain) return null;
  if (r.local === d.local) return { token: null };
  if (!r.local.startsWith(`${d.local}+`)) return null;
  const token = r.local.slice(d.local.length + 1);
  return { token: REPLY_TOKEN.test(token) ? token : null };
}

export function replyAddress(desk: string, token: string): string {
  const d = splitAddress(desk)!;
  return `${d.local}+${token}@${d.domain}`;
}

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

function base32(bytes: Buffer): string {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function newReplyToken(): string {
  return base32(randomBytes(17)).slice(0, 26);
}

/**
 * Mint a reply token for a request; only its hash is kept. `email` is whom the email goes to when
 * it isn't the requester (someone copied on it, D57): the token then answers for that address alone.
 */
export async function mintReplyToken(db: Db, issueId: string, email: string | null = null): Promise<string> {
  const token = newReplyToken();
  await db.insert(helpdeskReplyTokens).values({ tokenHash: sha256(token), issueId, email });
  return token;
}

/** The request a reply address's token belongs to, among these tokens, and whom it was sent to (null: its requester); null when none is known. */
export async function replyTokenOf(db: Db, tokens: string[]): Promise<{ issueId: string; email: string | null } | null> {
  const valid = tokens.filter((t) => REPLY_TOKEN.test(t));
  if (!valid.length) return null;
  const rows = await db
    .select({ issueId: helpdeskReplyTokens.issueId, email: helpdeskReplyTokens.email })
    .from(helpdeskReplyTokens)
    .where(inArray(helpdeskReplyTokens.tokenHash, valid.map(sha256)));
  return rows[0] ?? null;
}
