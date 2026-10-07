// Operator recovery for an existing job. Never creates a backup or changes certificates.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BackupStore } from "./store";
import { BackupWorker } from "./worker";
import { cleanJob, assertJob } from "./files";

async function main() {
  const [command, id] = process.argv.slice(2);
  if (command !== 'reconcile' || !id || process.argv.length !== 4) throw new Error('USAGE_RECONCILE_EXISTING_JOB_ID');
  assertJob(id);
  const root = process.env.CERTIFICATE_BACKUP_STATE, staging = process.env.CERTIFICATE_BACKUP_STAGING;
  if (!root || !staging) throw new Error('BACKUP_CONFIG_MISSING');
  const store = new BackupStore(root), job = store.get(id);
  if (!job || job.status !== 'needs_attention') throw new Error('JOB_MUST_NEED_ATTENTION');
  if (!job.attemptedUpload) {
    await cleanJob(staging, id);
    store.update(id, 'failed', { error: 'LOCAL_FAILURE_CLEANUP_CONFIRMED' });
  } else {
    await new BackupWorker(store, staging, '/app/infra/certificate-backup/extract.py').execute(job);
  }
  console.info(JSON.stringify({ jobId: id, status: store.get(id)!.status })); store.db.close();
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('CERTIFICATE_BACKUP_RECONCILIATION_FAILED'); process.exitCode = 1; });
}
