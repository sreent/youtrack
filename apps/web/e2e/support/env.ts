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
export const THIRD_AUTH_FILE = path.join(RUN_DIR, 'auth', 'third.json');
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
 * A fourth administrator, for the flows that came with waves 1 and 2. A browser session counts as
 * its person, so every spec file of one person's shares that person's 1200 a minute: on four
 * workers, `admin`'s files passed it at 280 tests and pages began to log 429s. The files that
 * don't need `admin` itself (whose name the API's changes carry) moved to Una.
 */
export const THIRD = { login: 'una', name: 'Una Byrne', password: 'e2e-third-pass-1' } as const;

/**
 * Every page's clock reads this instant, the moment the run started, so "2 minutes ago" and
 * "today" read the same however long a test takes. What the run itself creates is later than it,
 * and reads "just now".
 */
export const NOW = new Date(required('E2E_NOW'));

/** The Teams bot the server is set up with, and where the chat spec's Bot Framework listens (support/teams.ts). */
export const TEAMS = {
  appId: '6a4f2e1d-e2e0-4a4a-9c1b-000000000e2e',
  appPassword: 'e2e-bot-secret',
  tenantId: '0e2e0e2e-1111-2222-3333-444455556666',
  url: `http://127.0.0.1:${Number(required('E2E_TEAMS_PORT'))}`,
} as const;

/** The Slack app's workspace, token and signing secret, and where the spec's Slack Web API listens (support/slack.ts). */
export const SLACK = {
  teamId: 'T0E2E',
  botToken: 'xoxb-e2e-bot-token',
  signingSecret: 'e2e-slack-signing-secret-0123456789',
  url: `http://127.0.0.1:${Number(required('E2E_SLACK_PORT'))}`,
} as const;

/** The Forgejo the server lets people connect their accounts at, on this machine (support/forgejo.ts). */
export const FORGEJO = {
  url: `http://127.0.0.1:${Number(required('E2E_FORGEJO_PORT'))}`,
  clientId: 'e2e-forgejo-app',
  clientSecret: 'e2e-forgejo-secret',
} as const;
