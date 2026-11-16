import { APP_NAME } from '@a4a/shared';
import { AI_PROVIDERS } from './ai/providers';
import { needsSetup } from './services/auth';
import { startServer } from './server';
import './ai/register';
import './knowledge/register';
import './notify/register';
import './oauth/register';

const started = await startServer();
const { runtime, url } = started;
const db = runtime.database.kind === 'pglite' ? `embedded PGlite in ${runtime.config.dataDir}` : 'Postgres';
const ai = runtime.config.aiEnabled ? `on (${runtime.config.aiModel}, from ${AI_PROVIDERS[runtime.config.aiProvider].label})` : `off (${runtime.config.aiOffReason ?? 'turned off'})`;
console.log(`\n${APP_NAME} is running at ${url}`);
console.log(`  API docs   ${url}/api/docs`);
console.log(`  MCP        ${url}/mcp  (Authorization: Bearer <token>)`);
console.log(`  Database   ${db}`);
console.log(`  AI         ${ai}`);
if (await needsSetup(runtime.db)) console.log(`\n  Open ${url} to create the first administrator.`);
if (!runtime.config.webDist) console.log('\n  The web UI is not built; in development run "pnpm dev" and open http://localhost:5173');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    console.log(`\n${signal}: shutting down`);
    void started.stop().then(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
