import path from "node:path";
import { watch } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { BackupStore, type BackupJob, type RemoteReceipt } from "./store";
import { cleanJob, cleanPackedVerification, jobDirectory, sha256, syncFile } from "./files";
import { verifyCapture } from "./capture";
import { run } from "./process";
import { SftpTransport, type BackupTransport } from "./transport";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export function confirmed(job: BackupJob, receipt: RemoteReceipt | null): boolean {
  return receipt?.status === "succeeded" && receipt.jobId === job.id && receipt.sha256 === job.sha256 && receipt.size === job.size &&
    ["slot-1", "slot-2"].includes(receipt.slot ?? "") && !!receipt.committedAt && receipt.cleanupPending === false;
}

export class BackupWorker {
  constructor(readonly store: BackupStore, readonly staging: string, readonly extractor: string,
              readonly transportFactory: (directory: string) => BackupTransport = directory => new SftpTransport(directory),
              readonly remoteTimeout = 600_000) {}

  async execute(initial: BackupJob): Promise<void> {
    let job = initial;
    let committed: RemoteReceipt | null = initial.remote ?? null;
    let directory: string | null = null;
    let transport: BackupTransport | null = null;
    try {
      try { directory = await jobDirectory(this.staging, job.id); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !job.attemptedUpload) throw error;
        directory = await jobDirectory(this.staging, job.id, true);
      }
      transport = this.transportFactory(directory);
      const artifact = path.join(directory, `avku-certificates-${job.id}.tar.gz`);
      if (job.attemptedUpload || job.remote) {
        job = this.store.update(job.id, "reconciling");
        const receipt = await transport.receipt(job.id);
        if (confirmed(job, receipt)) committed = receipt;
        else if (receipt?.status === "succeeded") {
          if (receipt.cleanupPending) throw new Error("REMOTE_CLEANUP_PENDING");
          // The receiver has committed, but has not finished durable cleanup yet.
          committed = await this.waitRemote(job, transport);
        }
        else if (receipt?.status === "failed") {
          if (receipt.cleanupPending) throw new Error("REMOTE_CLEANUP_PENDING");
          throw new Error("REMOTE_CANDIDATE_REJECTED");
        }
        else if (receipt && ["publishing", "remote_verifying"].includes(receipt.status)) {
          committed = await this.waitRemote(job, transport);
        }
      }
      if (!committed) {
        if (!job.attemptedUpload) {
          job = this.store.update(job.id, "validating");
          await verifyCapture(path.join(directory, "payload"));
          job = this.store.update(job.id, "packaging");
          const temporary = artifact + ".partial";
          // Interrupted packaging is repeated from the immutable capture.
          for (const name of [artifact, temporary]) await rm(name, { force: true });
          await cleanPackedVerification(this.staging, job.id);
          await run("tar", ["--format=ustar", "-czf", temporary, "-C", path.join(directory, "payload"), "."]);
          const archiveChecksum = await sha256(temporary);
          const packaged = path.join(directory, "packed-verify");
          await run("python3", ["-B", this.extractor, temporary, packaged]);
          await verifyCapture(packaged);
          if (await sha256(temporary) !== archiveChecksum) throw new Error("LOCAL_ARTIFACT_CORRUPTED");
          await cleanPackedVerification(this.staging, job.id);
          await syncFile(temporary); await rename(temporary, artifact); await syncFile(directory);
          job = this.store.update(job.id, "uploading", { size: (await stat(artifact)).size, sha256: archiveChecksum, attemptedUpload: true });
        }
        if ((await stat(artifact)).size !== job.size || await sha256(artifact) !== job.sha256) throw new Error("LOCAL_ARTIFACT_CORRUPTED");
        await transport.upload(job.id, artifact, job.size!, job.sha256!);
        committed = await this.waitRemote(job, transport);
      }
      if (!committed || !confirmed(job, committed)) throw new Error("REMOTE_COMMIT_NOT_CONFIRMED");
      if (committed.cleanupPending) throw new Error("REMOTE_CLEANUP_PENDING");
      this.store.update(job.id, "cleaning", { remote: committed });
      // Remote inventory is read before local cleanup, so ACK reconciliation survives it.
      const slots = await this.waitInventory(job, committed, transport);
      this.store.setSlots(slots);
      await cleanJob(this.staging, job.id);
      this.store.update(job.id, "succeeded", { remote: committed, error: undefined });
    } catch (error) {
      const code = error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : "BACKUP_STAGE_FAILED";
      if (code === "REMOTE_CANDIDATE_REJECTED") {
        try { await cleanJob(this.staging, job.id); this.store.update(job.id, "failed", { error: code }); }
        catch { this.store.update(job.id, "needs_attention", { error: "LOCAL_CLEANUP_FAILED" }); }
      } else if (job.attemptedUpload || committed) {
        this.store.update(job.id, "needs_attention", { error: code, ...(committed ? { remote: committed } : {}) });
      } else {
        try { await cleanJob(this.staging, job.id); this.store.update(job.id, "failed", { error: code }); }
        catch { this.store.update(job.id, "needs_attention", { error: "LOCAL_CLEANUP_FAILED" }); }
      }
    }
  }
  private async waitInventory(job: BackupJob, receipt: RemoteReceipt, transport: BackupTransport): Promise<RemoteReceipt[]> {
    const deadline = Date.now() + this.remoteTimeout;
    do {
      const slots = await transport.slots();
      if (slots.some(slot => slot.jobId === job.id && slot.sha256 === job.sha256 && slot.size === job.size &&
          slot.slot === receipt.slot && slot.generation === receipt.generation && slot.cleanupPending === false)) return slots;
      if (Date.now() >= deadline) break;
      // Receipt and inventory are separate atomic files. Wait within this manual
      // job for the catalog write following the final receipt.
      await sleep(2000);
    } while (Date.now() < deadline);
    throw new Error("REMOTE_INVENTORY_UNCONFIRMED");
  }
  private async waitRemote(job: BackupJob, transport: BackupTransport): Promise<RemoteReceipt> {
    this.store.update(job.id, "remote_verifying");
    const deadline = Date.now() + this.remoteTimeout;
    while (Date.now() < deadline) {
      const receipt = await transport.receipt(job.id);
      if (receipt && confirmed(job, receipt)) return receipt;
      if (receipt?.status === "succeeded" && receipt.cleanupPending) throw new Error("REMOTE_CLEANUP_PENDING");
      if (receipt?.status === "failed") {
        if (receipt.cleanupPending) throw new Error("REMOTE_CLEANUP_PENDING");
        // Definite pre-commit failure: existing slots untouched and future jobs allowed.
        this.store.update(job.id, "failed", { error: "REMOTE_" + String(receipt.error ?? "REJECTED").replace(/[^A-Z_]/g, "") });
        throw new Error("REMOTE_CANDIDATE_REJECTED");
      }
      if (receipt?.status === "publishing") this.store.update(job.id, "publishing");
      await sleep(2000);
    }
    throw new Error("REMOTE_ACK_UNCONFIRMED");
  }
}

export function installWorkerShutdown(close: () => void, drain: () => Promise<void>): () => boolean {
  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    close();
    console.info(`certificate_backup_worker_shutdown ${signal}`);
    void drain().then(() => {
      console.info('certificate_backup_worker_shutdown_complete');
      process.exit(0);
    }, () => {
      console.error('certificate_backup_worker_shutdown_failed');
      process.exit(1);
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  return () => stopping;
}

async function main(): Promise<void> {
  const root = process.env.CERTIFICATE_BACKUP_STATE, staging = process.env.CERTIFICATE_BACKUP_STAGING;
  if (!root || !staging) throw new Error("BACKUP_CONFIG_MISSING");
  await mkdir(staging, { recursive: true, mode: 0o700 });
  const store = new BackupStore(root);
  const worker = new BackupWorker(store, staging, "/app/infra/certificate-backup/extract.py");
  let running = false;
  let activeRun: Promise<void> | undefined;
  let isStopping = () => false;
  const drain = async (resumeAttention = false) => {
    if (running || isStopping()) return;
    const job = store.active();
    if (!job || ["accepted", "capturing"].includes(job.status)) return;
    if (job.status === "needs_attention" && !resumeAttention) return;
    running = true;
    try {
      if (job.status === "needs_attention" && !job.attemptedUpload) return;
      activeRun = worker.execute(job);
      await activeRun;
    } finally { running = false; activeRun = undefined; }
  };
  const watcher = watch(root, () => void drain().catch(() => console.error('certificate_backup_worker_state_error')));
  isStopping = installWorkerShutdown(() => watcher.close(), async () => { await activeRun; });
  // Startup/restart can resume a previously accepted job once. Further uncertain
  // failures require an explicit reconciliation; no periodic retry is scheduled.
  await drain(true);
  console.info('certificate_backup_worker_ready');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('certificate_backup_worker_start_failed'); process.exitCode = 1; });
}
