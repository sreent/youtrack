/**
 * Copy every file from DATA_DIR/attachments to the bucket in S3_* (docs/architecture.md, D35).
 *
 *   pnpm --filter @a4a/server files:to-s3 [--dry-run] [--verify-all] [--concurrency N]
 *   node packages/server/dist/files-to-s3.js …        (from a build)
 *
 * With the server's own settings (DATABASE_URL, DATA_DIR, S3_*). Run it while the server still
 * runs on local disk, then stop the server and run it again, which copies only what came since;
 * then start the server with ATTACHMENT_STORAGE=s3. The embedded database (no DATABASE_URL)
 * opens in one process at a time, so with it the server stops first.
 */
import { loadConfig } from '../config';
import { openDatabase } from '../db/client';
import { copyFilesToS3, manifestFor } from './copy-to-s3';
import { S3Storage } from './s3';
import { formatBytes } from './sniff';
import { LocalDiskStorage, localAttachmentsDir } from './storage';

const USAGE = `Copies every file a4a keeps on disk (DATA_DIR/attachments) to the bucket in S3_BUCKET, and checks each copy.

  files:to-s3 [--dry-run] [--verify-all] [--concurrency N]

  --dry-run       count what would be copied, and copy nothing
  --verify-all    read back every file already in the bucket, not only those not yet verified
  --concurrency   files copied at once (4)

It uses the server's settings: DATABASE_URL (or the embedded database in DATA_DIR), DATA_DIR,
and S3_BUCKET, S3_ENDPOINT, S3_REGION, S3_PREFIX, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY.
Run it again whenever: it skips what it has verified, and carries on where a run stopped.`;

function option(args: string[], name: string): string | undefined {
  const i = args.findIndex((a) => a === name || a.startsWith(`${name}=`));
  if (i < 0) return undefined;
  return args[i]!.includes('=') ? args[i]!.split('=')[1] : args[i + 1];
}

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(USAGE);
  process.exit(0);
}
const concurrency = Number(option(args, '--concurrency') ?? 4);
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 64) {
  console.error('--concurrency takes a whole number from 1 to 64.');
  process.exit(2);
}

const config = loadConfig();
if (!config.s3) {
  console.error('Set S3_BUCKET to the bucket the files go to (with S3_ENDPOINT for a store other than AWS, S3_REGION, and keys).\n');
  console.error(USAGE);
  process.exit(2);
}
const to = new S3Storage(config.s3);
const folder = localAttachmentsDir(config.dataDir);
const database = await openDatabase({ url: config.databaseUrl, dataDir: config.dataDir });
try {
  await to.check();
  const report = await copyFilesToS3(database.db, new LocalDiskStorage(folder), to, {
    manifest: manifestFor(folder, config.s3),
    concurrency,
    dryRun: args.includes('--dry-run'),
    verifyAll: args.includes('--verify-all'),
    log: (line) => console.log(line),
  });
  if (!args.includes('--dry-run')) {
    console.log(
      `Copied ${report.copied} (${formatBytes(report.copiedBytes)}), found ${report.checked} already copied and whole, ` +
        `${report.already} verified before, ${report.failed.length} not copied.`,
    );
  }
  if (report.failed.length) {
    console.log('\nNot copied:');
    for (const f of report.failed) console.log(`  ${f.name} (${f.key}): ${f.why}`);
  }
  if (!report.stopped && !report.failed.length && !args.includes('--dry-run')) {
    console.log(`\nEvery file is in ${to.where}. Start the server with ATTACHMENT_STORAGE=s3 once nothing else is uploading to disk.`);
  }
  process.exitCode = report.stopped || report.failed.length ? 1 : 0;
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
} finally {
  await database.close();
}
