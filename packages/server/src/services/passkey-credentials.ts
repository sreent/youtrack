/**
 * One credential, one side (D69). Members' passkeys (D62) and requesters' (D69) share PUBLIC_URL's
 * relying party id, so one authenticator answers the team's sign-in page and the portal's alike, and
 * each side reads only its own table. A credential id already on one side is refused on the other:
 * nobody can register a member's credential id (sent to browsers in `allowCredentials`) as a
 * requester's, nor the reverse, to stand in its way.
 */
import { eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { passkeys, requesterPasskeys } from '../db/schema';

/**
 * Whether no passkey, on either side, has this credential id. Call it in the transaction that adds
 * one: it holds a lock on the id until that commits, so two additions of one id at once, one on each
 * side, can't both pass (each side's unique index stops two on the same side).
 */
export async function credentialFree(tx: Db, credentialId: string): Promise<boolean> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`a4a:passkey-credential:${credentialId}`}))`);
  const [member] = await tx.select({ id: passkeys.id }).from(passkeys).where(eq(passkeys.credentialId, credentialId)).limit(1);
  if (member) return false;
  const [requester] = await tx.select({ id: requesterPasskeys.id }).from(requesterPasskeys).where(eq(requesterPasskeys.credentialId, credentialId)).limit(1);
  return !requester;
}
