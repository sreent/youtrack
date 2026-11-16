import { existsSync } from 'node:fs';
import path from 'node:path';

export interface Config {
  port: number;
  publicUrl: string;
  databaseUrl: string | undefined;
  dataDir: string;
  seedDemo: boolean;
  aiModel: string;
  aiEnabled: boolean;
  webDist: string | undefined;
  sessionTtlDays: number;
  isDev: boolean;
  /** The largest file one upload may carry (ATTACHMENT_MAX_MB, default 20). */
  attachmentMaxBytes: number;
  /** All the files on one issue, its comments' included, or on one article (ATTACHMENTS_PER_ISSUE_MB, default 100). */
  attachmentsPerIssueMaxBytes: number;
  /** Where files go: "local", under DATA_DIR/attachments, is the one store so far (ATTACHMENT_STORAGE). */
  attachmentStorage: 'local';
}

/** Megabytes from the environment, as bytes (1 MB = 1024 × 1024 bytes). */
function megabytes(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Math.round((Number.isFinite(n) && n > 0 ? n : fallback) * 1024 * 1024);
}

function loadDotEnv() {
  const candidates = [path.resolve(process.cwd(), '.env'), path.resolve(process.cwd(), '../../.env')];
  for (const file of candidates) {
    if (existsSync(file)) {
      try {
        process.loadEnvFile(file);
      } catch {
        // ignore malformed .env
      }
      return;
    }
  }
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  loadDotEnv();
  const env = process.env;
  const port = Number(env.PORT ?? 3000);
  const webDistCandidates = [
    env.WEB_DIST,
    path.resolve(process.cwd(), '../../apps/web/dist'),
    path.resolve(process.cwd(), 'apps/web/dist'),
  ].filter(Boolean) as string[];
  const hasKey = Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN);
  if (env.ATTACHMENT_STORAGE && env.ATTACHMENT_STORAGE !== 'local') {
    throw new Error(`ATTACHMENT_STORAGE=${env.ATTACHMENT_STORAGE} isn't available: files are stored on local disk ("local") so far`);
  }
  return {
    port,
    publicUrl: (env.PUBLIC_URL || `http://localhost:${port}`).replace(/\/$/, ''),
    databaseUrl: env.DATABASE_URL || undefined,
    dataDir: path.resolve(env.DATA_DIR || path.resolve(process.cwd(), 'data')),
    seedDemo: (env.SEED_DEMO ?? 'true') !== 'false',
    aiModel: env.AI_MODEL || 'claude-opus-5-5',
    aiEnabled: hasKey && env.AI_DISABLED !== 'true',
    webDist: webDistCandidates.find((p) => existsSync(path.join(p, 'index.html'))),
    sessionTtlDays: Number(env.SESSION_TTL_DAYS ?? 30),
    isDev: env.NODE_ENV !== 'production',
    attachmentMaxBytes: megabytes(env.ATTACHMENT_MAX_MB, 20),
    attachmentsPerIssueMaxBytes: megabytes(env.ATTACHMENTS_PER_ISSUE_MB, 100),
    attachmentStorage: 'local',
    ...overrides,
  };
}
