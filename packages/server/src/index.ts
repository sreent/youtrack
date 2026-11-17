import { APP_NAME } from '@a4a/shared';
import { AI_PROVIDERS } from './ai/providers';
import { needsSetup } from './services/auth';
import { startServer } from './server';
import './ai/register';
import './chat/register';
import './helpdesk/register';
import './knowledge/register';
import './notify/register';
import './oauth/register';
import './push/register';

// What stops it starting (a port in use, a bucket that refuses it, a setting it can't read) says
// so in a line; the stack too, in development.
const started = await startServer().catch((e: unknown) => {
  console.error(`${APP_NAME} didn't start: ${e instanceof Error ? e.message : String(e)}`);
  if (process.env.NODE_ENV !== 'production') console.error(e);
  process.exit(1);
});
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
