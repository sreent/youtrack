/** pnpm db:seed — create demo data in the configured database (refuses if projects exist). */
import { eq } from 'drizzle-orm';
import { createRuntime } from '../app-services';
import { loadConfig } from '../config';
import { openDatabase } from './client';
import { users } from './schema';
import { seedDemo } from './seed';

const config = loadConfig();
const database = await openDatabase({ url: config.databaseUrl, dataDir: config.dataDir });
const runtime = await createRuntime(config, database);
const [admin] = await runtime.db.select().from(users).where(eq(users.role, 'admin'));
if (!admin) {
  console.error('Create the first administrator first (open the web UI, or set ADMIN_LOGIN and ADMIN_PASSWORD).');
  process.exit(1);
}
await seedDemo(runtime, admin);
console.log('Demo data is ready (it is skipped when projects already exist).');
await database.close();
