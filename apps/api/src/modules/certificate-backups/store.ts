import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync, openSync, writeSync, fsyncSync, closeSync, constants } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { assertJob, JOB_PATTERN } from "./files";
import { HttpError } from "../../http/responses";

export type JobStatus = "accepted" | "capturing" | "validating" | "packaging" | "uploading" | "remote_verifying" | "publishing" | "cleaning" | "succeeded" | "failed" | "interrupted" | "reconciling" | "needs_attention";
export interface BackupJob {
  id: string; actor: string; idempotencyKey: string; status: JobStatus; createdAt: string; updatedAt: string;
  snapshotAt?: string; error?: string; size?: number; sha256?: string; remote?: RemoteReceipt;
  counts?: { active: number; draft: number; total: number; photos: number }; attemptedUpload?: boolean;
  history: { status: JobStatus; at: string; durationMs: number }[];
}
export interface RemoteReceipt { jobId: string; status: string; slot?: string; sha256?: string; size?: number; snapshotAt?: string; committedAt?: string; verifiedAt?: string; error?: string; cleanupPending?: boolean; generation?: number }
const TERMINAL = new Set<JobStatus>(["succeeded", "failed", "interrupted"]);
export class BackupStore {
  readonly db: DatabaseSync;
  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const file = path.join(root, "jobs.sqlite");
    this.db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=10000; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, actor TEXT NOT NULL, idem TEXT NOT NULL, finished INTEGER NOT NULL, data TEXT NOT NULL, created TEXT NOT NULL, UNIQUE(actor,idem));
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_backup ON jobs(finished) WHERE finished=0;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, data TEXT NOT NULL);`);
  }
  accept(actor: string, idem: string): { job: BackupJob; replay: boolean } {
    if (!JOB_PATTERN.test(idem)) throw new HttpError(400, "Потрібен коректний Idempotency-Key.");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db.prepare("SELECT data FROM jobs WHERE actor=? AND idem=?").get(actor, idem);
      if (existing) { this.db.exec("COMMIT"); const job = JSON.parse(String(existing.data)) as BackupJob; this.audit(job, "idempotency_replay"); return { job, replay: true }; }
      const active = this.active();
      if (active) throw new HttpError(409, `Резервне копіювання вже виконується: ${active.id}`);
      const at = new Date().toISOString();
      const job: BackupJob = { id: randomUUID(), actor, idempotencyKey: idem, status: "accepted", createdAt: at, updatedAt: at, history: [{ status: "accepted", at, durationMs: 0 }] };
      this.db.prepare("INSERT INTO jobs VALUES(?,?,?,?,?,?)").run(job.id, actor, idem, 0, JSON.stringify(job), at);
      this.db.exec("COMMIT"); this.audit(job, "accepted"); return { job, replay: false };
    } catch (error) { this.db.exec("ROLLBACK"); if (error instanceof HttpError && error.statusCode === 409) console.info(JSON.stringify({ event: "parallel_backup_rejected", actor, at: new Date().toISOString() })); throw error; }
  }
  get(id: string): BackupJob | null { assertJob(id); const row = this.db.prepare("SELECT data FROM jobs WHERE id=?").get(id); return row ? JSON.parse(String(row.data)) : null; }
  active(): BackupJob | null { const row = this.db.prepare("SELECT data FROM jobs WHERE finished=0").get(); return row ? JSON.parse(String(row.data)) : null; }
  list(): BackupJob[] { return this.db.prepare("SELECT data FROM jobs ORDER BY created DESC LIMIT 20").all().map(r => JSON.parse(String(r.data))); }
  lastSuccessful(): BackupJob | null { const row = this.db.prepare("SELECT data FROM jobs WHERE json_extract(data,'$.status')='succeeded' ORDER BY created DESC LIMIT 1").get(); return row ? JSON.parse(String(row.data)) : null; }
  update(id: string, status: JobStatus, extra: Partial<BackupJob> = {}): BackupJob {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const job = this.get(id);
      if (!job) throw new Error("JOB_NOT_FOUND");
      if (job.status === status && Object.keys(extra).length === 0) { this.db.exec("COMMIT"); return job; }
      const at = new Date().toISOString();
      const next: BackupJob = { ...job, ...extra, status, updatedAt: at, history: [...job.history, { status, at, durationMs: Date.parse(at) - Date.parse(job.updatedAt) }] };
      this.db.prepare("UPDATE jobs SET finished=?,data=? WHERE id=?").run(TERMINAL.has(status) ? 1 : 0, JSON.stringify(next), id);
      this.db.exec("COMMIT"); this.audit(next, status);
      // WAL writes can notify another process before the transaction commits.
      // Signal only after durable capture completion, so fs.watch never reads
      // the old state with no subsequent event. Restart also reads the DB.
      if (status === "validating") {
        const fd = openSync(path.join(this.root, "worker.wake"), constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
        try { writeSync(fd, `${id}\n${at}\n`); fsyncSync(fd); } finally { closeSync(fd); }
      }
      return next;
    } catch (error) { if (this.db.isTransaction) this.db.exec("ROLLBACK"); throw error; }
  }
  setSlots(slots: RemoteReceipt[]): void { this.db.prepare("INSERT INTO settings VALUES('slots',?) ON CONFLICT(key) DO UPDATE SET data=excluded.data").run(JSON.stringify({ slots, checkedAt: new Date().toISOString() })); }
  slots(): { slots: RemoteReceipt[]; checkedAt: string | null } { const row = this.db.prepare("SELECT data FROM settings WHERE key='slots'").get(); return row ? JSON.parse(String(row.data)) : { slots: [], checkedAt: null }; }
  audit(job: BackupJob, event: string): void { console.info(JSON.stringify({ event: `certificate_backup_${event}`, jobId: job.id, actor: job.actor, at: job.updatedAt, durationMs: job.history.at(-1)?.durationMs, counts: job.counts, size: job.size, sha256: job.sha256, slot: job.remote?.slot, error: job.error })); }
}
