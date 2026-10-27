import path from "node:path";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { CertificateRepository } from "../certificates/certificate-records";
import { BackupStore, type BackupJob } from "./store";
import { cleanJob, jobDirectory } from "./files";
import { finishCapture } from "./capture";

export class BackupService {
  readonly store: BackupStore;
  readonly origins: Set<string>;
  readonly staging: string;
  private readonly captures = new Set<Promise<void>>();
  constructor(readonly repository: CertificateRepository, readonly env = process.env) {
    if (!env.CERTIFICATE_BACKUP_STATE || !env.CERTIFICATE_BACKUP_STAGING) throw new Error("BACKUP_CONFIG_MISSING");
    this.store = new BackupStore(env.CERTIFICATE_BACKUP_STATE);
    this.staging = env.CERTIFICATE_BACKUP_STAGING;
    this.origins = new Set((env.CERTIFICATE_BACKUP_ORIGINS ?? "").split(",").map(s => s.trim()).filter(Boolean));
    // Only a previously manually accepted capture can be interrupted by an API restart.
    const active = this.store.active();
    if (active && ["accepted", "capturing"].includes(active.status)) {
      this.store.update(active.id, "needs_attention", { error: "API_RESTART_DURING_CAPTURE" });
      void cleanJob(this.staging, active.id)
        .then(() => this.store.update(active.id, "interrupted", { error: "API_RESTART_DURING_CAPTURE" }))
        .catch(() => this.store.update(active.id, "needs_attention", { error: "LOCAL_CLEANUP_FAILED" }));
    }
  }
  accept(actor: string, idem: string): BackupJob {
    const { job, replay } = this.store.accept(actor, idem);
    if (!replay) {
      // Track accepted work before setImmediate so shutdown cannot miss it.
      const task = new Promise<void>(resolve => setImmediate(resolve)).then(() => this.capture(job));
      this.captures.add(task);
      void task.then(() => this.captures.delete(task), () => this.captures.delete(task));
    }
    return job;
  }
  async drain(): Promise<void> {
    await Promise.all([...this.captures]);
  }
  private async capture(job: BackupJob): Promise<void> {
    try {
      this.store.update(job.id, "capturing");
      await mkdir(this.staging, { recursive: true, mode: 0o700 });
      const directory = await jobDirectory(this.staging, job.id, true);
      const payload = path.join(directory, "payload");
      await mkdir(payload, { mode: 0o700 });
      const info = await this.repository.captureBackup(payload);
      // Image resources are immutable; copying them need not block registry mutations.
      const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
      await finishCapture(payload, info, job, {
        fonts: this.env.CERTIFICATE_BACKUP_FONTS ?? "/usr/share/fonts/truetype",
        source: path.join(packageRoot, "src"), packageRoot,
        release: this.env.AVKU_RELEASE_ID ?? "unversioned-build",
      });
      this.store.update(job.id, "validating", { counts: info.counts, snapshotAt: info.snapshotAt });
    } catch {
      try { await cleanJob(this.staging, job.id); this.store.update(job.id, "failed", { error: "CAPTURE_FAILED_CHECK_PHOTOS_RESOURCES_AND_SPACE" }); }
      catch { this.store.update(job.id, "needs_attention", { error: "LOCAL_CAPTURE_CLEANUP_FAILED" }); }
    }
  }
}
