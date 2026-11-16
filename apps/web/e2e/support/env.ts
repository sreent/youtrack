/**
 * What the whole run shares: the server's address, the administrator it is set up with, where
 * the signed-in state is kept, and the instant every page's clock is fixed at.
 *
 * The runner sets these once, in playwright.config.ts, before any worker starts; workers inherit
 * them, so they all talk to the one server the run started.
 */
import path from 'node:path';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set: run the suite through e2e/playwright.config.ts (pnpm test:e2e)`);
  return value;
}

export const PORT = Number(required('E2E_PORT'));
export const BASE_URL = `http://127.0.0.1:${PORT}`;

/** The run's own folder: the server's database, and the signed-in state. Removed when the run ends. */
export const RUN_DIR = required('E2E_RUN_DIR');
export const DATA_DIR = path.join(RUN_DIR, 'data');
export const AUTH_FILE = path.join(RUN_DIR, 'auth', 'admin.json');
export const TOUR_AUTH_FILE = path.join(RUN_DIR, 'auth', 'tour.json');
export const SECOND_AUTH_FILE = path.join(RUN_DIR, 'auth', 'second.json');
export const TOKEN_FILE = path.join(RUN_DIR, 'auth', 'token.json');

/** The first administrator, made by the server itself from ADMIN_LOGIN and ADMIN_PASSWORD. */
export const ADMIN = { login: 'admin', name: 'admin', password: 'e2e-admin-pass-1' } as const;

/**
 * A second administrator, who takes the tour. The server limits each person to 1200 API requests
 * a minute; the tour's pages and the flows' pages, all at once, came to about 900, so each has
 * its own person, and room to grow.
 */
export const GUIDE = { login: 'mira', name: 'Mira Patel', password: 'e2e-guide-pass-1' } as const;
/**
 * A third administrator, for half the flows. The flows' pages grew past one person's 1200 requests a
 * minute on four workers, so they're split between `admin` and Theo, a spec file at a time: a file
 * reads what's personal to its page's person (saved searches, tokens) only through that person.
 */
export const SECOND = { login: 'theo', name: 'Theo Ruiz', password: 'e2e-second-pass-1' } as const;

/**
 * Every page's clock reads this instant, the moment the run started, so "2 minutes ago" and
 * "today" read the same however long a test takes. What the run itself creates is later than it,
 * and reads "just now".
 */
export const NOW = new Date(required('E2E_NOW'));
