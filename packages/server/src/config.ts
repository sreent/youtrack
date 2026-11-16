import { existsSync } from 'node:fs';
import path from 'node:path';

export interface Config {
  port: number;
  publicUrl: string;
  databaseUrl: string | undefined;
  /** Postgres for the LISTEN connection, when DATABASE_URL goes through a pooler that drops LISTEN. */
  databaseListenUrl: string | undefined;
  dataDir: string;
  seedDemo: boolean;
  aiModel: string;
  aiEnabled: boolean;
  webDist: string | undefined;
  sessionTtlDays: number;
  isDev: boolean;
  /**
   * How many proxies in front of the server append to X-Forwarded-For (a load
   * balancer: 1). The client's address is the entry the outermost of them added;
   * with 0 the header is ignored, since anyone can send it.
   */
  trustProxy: number;
  /** Requests per minute per token, user or address, on each instance. */
  apiRateLimit: number;
  mcpRateLimit: number;
}

function intEnv(value: string | undefined, fallback: number, min = 0): number {
  const n = Number(value);
  return value !== undefined && value !== '' && Number.isInteger(n) && n >= min ? n : fallback;
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
  return {
    port,
    publicUrl: (env.PUBLIC_URL || `http://localhost:${port}`).replace(/\/$/, ''),
    databaseUrl: env.DATABASE_URL || undefined,
    databaseListenUrl: env.DATABASE_LISTEN_URL || undefined,
    dataDir: path.resolve(env.DATA_DIR || path.resolve(process.cwd(), 'data')),
    seedDemo: (env.SEED_DEMO ?? 'true') !== 'false',
    aiModel: env.AI_MODEL || 'claude-opus-5-5',
    aiEnabled: hasKey && env.AI_DISABLED !== 'true',
    webDist: webDistCandidates.find((p) => existsSync(path.join(p, 'index.html'))),
    sessionTtlDays: Number(env.SESSION_TTL_DAYS ?? 30),
    isDev: env.NODE_ENV !== 'production',
    trustProxy: intEnv(env.TRUST_PROXY, 0),
    apiRateLimit: intEnv(env.API_RATE_LIMIT, 1200, 1),
    mcpRateLimit: intEnv(env.MCP_RATE_LIMIT, 600, 1),
    ...overrides,
  };
}
