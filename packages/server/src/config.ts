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
  /** SMTP server for email, e.g. smtp://user:pass@mail.example.com:587. Without it, no email is sent and nothing fails. */
  smtpUrl: string | undefined;
  /** Who email comes from, e.g. "a4a <a4a@example.com>". */
  mailFrom: string;
  /** Changes to one issue within this long fold into one notification (and one email). */
  notifyWindowMs: number;
  /** The hour (server time, 0-23) the daily digest goes out. */
  digestHour: number;
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

function hostnameOf(url: string | undefined): string {
  try {
    return url ? new URL(url).hostname : 'localhost';
  } catch {
    return 'localhost';
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
    smtpUrl: env.SMTP_URL || undefined,
    mailFrom: env.MAIL_FROM || `a4a <a4a@${hostnameOf(env.PUBLIC_URL)}>`,
    notifyWindowMs: Math.max(0, Number(env.NOTIFY_WINDOW_SECONDS ?? 120)) * 1000,
    digestHour: Math.min(23, Math.max(0, Number(env.DIGEST_HOUR ?? 8))),
    ...overrides,
  };
}
