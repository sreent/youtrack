/**
 * The access tokens integrations keep to read from their provider (Bitbucket's commits, D33; GitHub's
 * compare for builds, D46). a4a sends them, so it must read them back: since D46 they're kept
 * encrypted with SECRET_KEY (lib/secret-box.ts). One kept as it was given before then is still read.
 */
import type { AppServices } from '../context';
import { open, seal } from '../lib/secret-box';

const keySource = (app: AppServices) => ({ secretKey: app.config.secretKey, dataDir: app.config.dataDir });

export function sealToken(app: AppServices, token: string): string {
  return seal(keySource(app), token);
}

/** The token as it was given, or null when there is none (or it was sealed with another key). */
export function tokenOf(app: AppServices, stored: string | null | undefined): string | null {
  if (!stored) return null;
  if (stored.startsWith('v1.')) {
    const plain = open(keySource(app), stored);
    if (plain !== null) return plain;
    if (stored.split('.').length === 4) return null;
  }
  return stored;
}
