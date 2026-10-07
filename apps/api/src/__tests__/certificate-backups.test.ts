import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import sharp from "sharp";
import { CertificateRepository } from "../modules/certificates/certificate-records";
import { finishCapture, verifyCapture } from "../modules/certificate-backups/capture";
import { BackupStore, type BackupJob, type RemoteReceipt } from "../modules/certificate-backups/store";
import { BackupWorker } from "../modules/certificate-backups/worker";
import type { BackupTransport } from "../modules/certificate-backups/transport";
import { jobDirectory, sha256 } from "../modules/certificate-backups/files";
import { restoreVerify } from "../modules/certificate-backups/restore";
import { BackupService } from "../modules/certificate-backups/service";
import { handleCertificateBackupRequest } from "../routes/certificate-backups";
import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError } from "../http/responses";

const templates = path.resolve("../../storage/certificates/templates");
const extractor = path.resolve("../../infra/certificate-backup/extract.py");
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "avku-manual-backup-test-"));
  const store = new BackupStore(path.join(root, "jobs"));
  const staging = path.join(root, "staging"); await mkdir(staging);
  const repository = new CertificateRepository({ storageRoot: path.join(root, "certificates"), templatesDirectory: templates });
  const photo = await sharp({ create: { width: 600, height: 800, channels: 3, background: '#a09080' } }).png().toBuffer();
  const active = await repository.create({ fullName: "Тестовий Волонтер", firstNameEn: "Test", lastNameEn: "Volunteer", certificateNumber: "BACKUP-ACTIVE", issuedAt: "2026-10-06", validUntil: "2027-10-06", photoDataUrl: `data:image/png;base64,${photo.toString('base64')}` });
  await repository.create({ status: "draft", fullName: "Чернетка Тестова", certificateNumber: "BACKUP-DRAFT" });
  const env = { ...process.env, DATA_ROOT: path.join(root, "certificates") };
  return { root, store, staging, repository, active, env };
}
async function captured(f: Awaited<ReturnType<typeof fixture>>) {
  const job = f.store.accept('verified-admin@example.test', randomUUID()).job;
  const dir = await jobDirectory(f.staging, job.id, true), payload = path.join(dir, 'payload'); await mkdir(payload);
  const info = await f.repository.captureBackup(payload);
  await finishCapture(payload, info, job, { fonts: '/usr/share/fonts/truetype', source: path.resolve('src'), packageRoot: process.cwd(), release: 'isolated-test-release' });
  return f.store.update(job.id, 'validating', { counts: info.counts, snapshotAt: info.snapshotAt });
}

test('capture includes active/draft, WAL snapshot, every photo and both templates; gate protects concurrent removal', async () => {
  const f = await fixture();
  try {
    const job = f.store.accept('admin@example.test', randomUUID()).job;
    const dir = await jobDirectory(f.staging, job.id, true), payload = path.join(dir, 'payload'); await mkdir(payload);
    const capture = f.repository.captureBackup(payload);
    const removal = f.repository.remove(f.active.id);
    const info = await capture; await removal;
    await finishCapture(payload, info, job, { fonts: '/usr/share/fonts/truetype', source: path.resolve('src'), packageRoot: process.cwd(), release: 'test' });
    const verified = await verifyCapture(payload);
    assert.deepEqual(verified.counts, { total: 2, active: 1, draft: 1, photos: 1 });
    assert.deepEqual(verified.templates, ['volunteer-card-v1-en', 'volunteer-card-v1-uk']);
    assert.equal((await f.repository.list()).length, 1);
    assert.ok((await readdir(path.join(payload, 'photos'))).includes(f.active.photoFileName!));
    assert.equal((await readdir(path.join(payload, 'database'))).length, 1);
    assert.equal(Object.keys(verified.files).some(name => /generated|\.env|id_ed25519|recovery\.key/.test(name)), false);
    for (const resource of ['deployment/api-entrypoint.sh', 'deployment/dockerignore', 'deployment/extract.py', 'web/public/data/elections/houses.json']) {
      assert.ok(verified.files['recovery/' + resource], `missing recovery build resource ${resource}`);
    }
    // A structurally incomplete recovery set must fail even when its checksum
    // index has been made internally consistent.
    const required = 'recovery/deployment/api-entrypoint.sh';
    await unlink(path.join(payload, required)); delete verified.files[required];
    await chmod(path.join(payload, 'manifest.json'), 0o600); await chmod(path.join(payload, 'SHA256SUMS'), 0o600);
    await writeFile(path.join(payload, 'manifest.json'), JSON.stringify(verified));
    await writeFile(path.join(payload, 'SHA256SUMS'), Object.entries(verified.files).map(([name, value]) => `${value.sha256}  ${name}`).join('\n') + '\n');
    await assert.rejects(() => verifyCapture(payload), /RECOVERY_RESOURCES_MISSING/);
  } finally { f.store.db.close(); await rm(f.root, { recursive: true }); }
});

test('persistent unique active job, two stores, double click and restart idempotency', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'avku-job-state-'));
  const first = new BackupStore(root), second = new BackupStore(root), key = randomUUID();
  try {
    const job = first.accept('admin@example.test', key).job;
    assert.equal(second.accept('admin@example.test', key).job.id, job.id);
    assert.throws(() => second.accept('other@example.test', randomUUID()), error => error instanceof HttpError && error.statusCode === 409);
    first.db.close();
    assert.equal(second.active()!.id, job.id);
    second.update(job.id, 'failed');
    assert.equal(second.accept('admin@example.test', key).job.id, job.id);
    assert.notEqual(second.accept('admin@example.test', randomUUID()).job.id, job.id);
  } finally { if (first.db.isOpen) first.db.close(); second.db.close(); await rm(root, { recursive: true }); }
});

test('capture wakeup is explicit after SQLite commit for a separate worker connection', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'avku-capture-wakeup-'));
  const api = new BackupStore(root), worker = new BackupStore(root);
  try {
    const job = api.accept('trusted-local', randomUUID()).job;
    assert.equal((await readdir(root)).includes('worker.wake'), false);
    api.update(job.id, 'capturing');
    assert.equal((await readdir(root)).includes('worker.wake'), false);
    api.update(job.id, 'validating');
    assert.equal((await readFile(path.join(root, 'worker.wake'), 'utf8')).split('\n')[0], job.id);
    assert.equal(worker.active()!.status, 'validating');
    assert.equal(worker.active()!.id, job.id);
    assert.equal(api.list().length, 1, 'wakeup only resumes the existing manually accepted job');
  } finally { api.db.close(); worker.db.close(); await rm(root, { recursive: true }); }
});

test('backup uses existing Access or trusted LAN access, rejects anonymous external access and CSRF', async () => {
  const f = await fixture();
  try {
    const service = new BackupService(f.repository, { CERTIFICATE_BACKUP_STATE: path.join(f.root, 'api-jobs'), CERTIFICATE_BACKUP_STAGING: f.staging,
      CERTIFICATE_BACKUP_ORIGINS: 'https://internal.avku.org,http://192.168.0.151:18080' });
    const request = { method: 'POST', headers: { host: 'internal.avku.org', origin: 'https://internal.avku.org', 'content-type': 'application/json', 'x-avku-backup': 'manual', 'idempotency-key': randomUUID(), 'sec-fetch-site': 'same-origin' }, resume() {} } as unknown as IncomingMessage;
    const response = { setHeader() {}, writeHead() {}, end() {} } as unknown as ServerResponse;
    const route = (identity: { email: string } | null) => handleCertificateBackupRequest(request, response, '/api/certificates/backups', identity, service);
    const actors: string[] = [];
    // Avoid a detached capture; capture lifecycle is covered separately.
    service.accept = (actor) => { actors.push(actor); return f.store.accept(actor, request.headers['idempotency-key'] as string).job; };
    assert.throws(() => route(null), error => error instanceof HttpError && error.statusCode === 401);
    request.headers.origin = 'https://evil.example';
    assert.throws(() => route({ email: 'other@example.test' }), error => error instanceof HttpError && error.statusCode === 403);
    delete request.headers.origin;
    assert.throws(() => route({ email: 'other@example.test' }), error => error instanceof HttpError && error.statusCode === 403);
    request.headers.origin = 'https://internal.avku.org';
    request.headers['sec-fetch-site'] = 'cross-site';
    assert.throws(() => route({ email: 'other@example.test' }), error => error instanceof HttpError && error.statusCode === 403);
    request.headers['sec-fetch-site'] = 'same-origin';
    delete request.headers['x-avku-backup'];
    assert.throws(() => route({ email: 'other@example.test' }), error => error instanceof HttpError && error.statusCode === 403);
    request.headers['x-avku-backup'] = 'manual';
    route({ email: 'other@example.test' });
    assert.equal(actors[0], 'other@example.test');
    f.store.update(f.store.active()!.id, 'succeeded');
    request.headers.host = '192.168.0.151'; request.headers.origin = 'http://192.168.0.151:18080';
    request.headers['idempotency-key'] = randomUUID();
    route(null); assert.equal(actors[1], 'trusted-local');
    request.method = 'GET'; request.headers.host = 'internal.avku.org';
    assert.throws(() => route(null), error => error instanceof HttpError && error.statusCode === 401);
    request.headers.host = '192.168.0.152';
    assert.throws(() => route(null), error => error instanceof HttpError && error.statusCode === 401);
    request.headers.host = '192.168.0.151'; route(null);
    service.store.db.close();
  } finally { f.store.db.close(); await rm(f.root, { recursive: true }); }
});

test('missing photo or corrupted resource cannot upload or succeed; staging cleaned', async () => {
  const f = await fixture();
  try {
    let job = await captured(f), dir = await jobDirectory(f.staging, job.id);
    await unlink(path.join(dir, 'payload/photos', f.active.photoFileName!));
    let uploads = 0;
    const transport: BackupTransport = { async upload() { uploads++; }, async receipt() { return null; }, async slots() { return []; } };
    let worker = new BackupWorker(f.store, f.staging, extractor, () => transport);
    await worker.execute(job);
    assert.equal(f.store.get(job.id)!.status, 'failed'); assert.equal(uploads, 0); assert.deepEqual(await readdir(f.staging), []);
    job = await captured(f);
    dir = await jobDirectory(f.staging, job.id);
    const resource = path.join(dir, 'payload/templates/volunteer-card-v1-uk/layout.json');
    await chmod(resource, 0o600); await writeFile(resource, '{}');
    worker = new BackupWorker(f.store, f.staging, extractor, () => transport);
    await worker.execute(job);
    assert.equal(f.store.get(job.id)!.status, 'failed'); assert.equal(uploads, 0); assert.deepEqual(await readdir(f.staging), []);
  } finally { f.store.db.close(); await rm(f.root, { recursive: true }); }
});

test('lost upload acknowledgement, worker restart, keyless archive and isolated restore', async () => {
  const f = await fixture();
  try {
    const job = await captured(f), saved = path.join(f.root, 'retained.tar.gz');
    let receipt: RemoteReceipt | null = null, uploads = 0;
    const transport: BackupTransport = {
      async upload(id, artifact, size, checksum) {
        uploads++; const { copyFile } = await import('node:fs/promises'); await copyFile(artifact, saved);
        receipt = { jobId: id, status: 'succeeded', slot: 'slot-1', sha256: checksum, size, committedAt: new Date().toISOString(), verifiedAt: new Date().toISOString(), cleanupPending: false };
        throw new Error('SUBPROCESS_FAILED'); // Publication committed, SSH/HTTP ACK was lost.
      }, async receipt() { return receipt; }, async slots() { return receipt ? [receipt] : []; },
    };
    const worker = new BackupWorker(f.store, f.staging, extractor, () => transport);
    await worker.execute(job);
    assert.equal(f.store.get(job.id)!.status, 'needs_attention'); assert.equal(uploads, 1);
    const restarted = new BackupWorker(f.store, f.staging, extractor, () => transport);
    await restarted.execute(f.store.get(job.id)!);
    assert.equal(f.store.get(job.id)!.status, 'succeeded'); assert.equal(uploads, 1); assert.deepEqual(await readdir(f.staging), []);
    assert.deepEqual((await readFile(saved)).subarray(0, 2), Buffer.from([0x1f, 0x8b]));
    const result = await restoreVerify(saved, await sha256(saved), path.join(f.root, 'isolated-restore'), extractor);
    assert.ok((await readFile(path.join(f.root, 'isolated-restore/recovery-context/apps/api/docker-entrypoint.sh'), 'utf8')).includes('gosu'));
    assert.deepEqual(result.counts, { total: 2, active: 1, draft: 1, photos: 1 }); assert.equal(result.renderVerified, true);
    assert.equal((await f.repository.list()).length, 2, 'production-shaped source was never changed by restore');
    await assert.rejects(() => restoreVerify(saved, '0'.repeat(64), path.join(f.root, 'bad-restore'), extractor), /TRANSPORT_CHECKSUM_MISMATCH/);
  } finally { f.store.db.close(); await rm(f.root, { recursive: true }); }
});

test('initial commit receipt cannot succeed before durable cleanup and matching inventory', async () => {
  const f = await fixture();
  try {
    const job = await captured(f);
    let receipt: RemoteReceipt | null = null, reads = 0, uploads = 0, inventoryReady = false;
    const transport: BackupTransport = {
      async upload(id, artifact, size, checksum) {
        uploads++;
        receipt = { jobId: id, status: 'succeeded', slot: 'slot-1', generation: 1, sha256: checksum, size, committedAt: new Date().toISOString() };
      },
      async receipt() {
        reads++;
        assert.notEqual(f.store.get(job.id)!.status, 'succeeded');
        return receipt && (reads === 1 ? receipt : { ...receipt, cleanupPending: false });
      },
      async slots() { return inventoryReady && receipt ? [{ ...receipt, cleanupPending: false }] : []; },
    };
    const worker = new BackupWorker(f.store, f.staging, extractor, () => transport, 3000);
    await worker.execute(job);
    assert.ok(reads >= 2, 'an early commit receipt must be polled until cleanup is explicit');
    assert.equal(f.store.get(job.id)!.status, 'needs_attention');
    assert.equal(f.store.get(job.id)!.error, 'REMOTE_INVENTORY_UNCONFIRMED');
    assert.equal(uploads, 1);
    assert.ok((await readdir(f.staging)).includes(job.id), 'retain the local artifact for reconciliation');
    inventoryReady = true;
    await worker.execute(f.store.get(job.id)!);
    assert.equal(f.store.get(job.id)!.status, 'succeeded');
    assert.equal(uploads, 1, 'a committed artifact must never be uploaded or rotated again');
    assert.deepEqual(await readdir(f.staging), []);
  } finally { f.store.db.close(); await rm(f.root, { recursive: true }); }
});

test('failed remote candidate with pending cleanup blocks new jobs until repaired', async () => {
  const f = await fixture();
  try {
    const job = await captured(f);
    let cleanupPending = true;
    const transport: BackupTransport = {
      async upload() {}, async receipt(id) { return { jobId: id, status: 'failed', error: 'CHECKSUM_MISMATCH', cleanupPending }; }, async slots() { return []; },
    };
    const worker = new BackupWorker(f.store, f.staging, extractor, () => transport, 1);
    await worker.execute(job);
    assert.equal(f.store.get(job.id)!.status, 'needs_attention');
    assert.equal(f.store.get(job.id)!.error, 'REMOTE_CLEANUP_PENDING');
    assert.throws(() => f.store.accept('admin@example.test', randomUUID()), /вже виконується/);
    cleanupPending = false;
    await worker.execute(f.store.get(job.id)!);
    assert.equal(f.store.get(job.id)!.status, 'failed');
    assert.deepEqual(await readdir(f.staging), []);
  } finally { f.store.db.close(); await rm(f.root, { recursive: true }); }
});

test('backend restart interrupts an accepted capture and never creates a new job', async () => {
  const f = await fixture();
  try {
    const job = f.store.accept('admin@example.test', randomUUID()).job;
    const service = new BackupService(f.repository, { CERTIFICATE_BACKUP_STATE: f.store.root, CERTIFICATE_BACKUP_STAGING: f.staging });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(service.store.get(job.id)!.status, 'interrupted'); assert.equal(service.store.list().length, 1);
    assert.equal(service.store.active(), null); service.store.db.close();
  } finally { f.store.db.close(); await rm(f.root, { recursive: true }); }
});

test('SSH interruption/unavailable server keeps job unresolved; checksum rejection is terminal and cleans staging', async () => {
  const f = await fixture();
  try {
    let job = await captured(f);
    const unavailable: BackupTransport = { async upload() { throw new Error('SUBPROCESS_FAILED'); }, async receipt() { return null; }, async slots() { throw new Error('REMOTE_INVENTORY_UNAVAILABLE'); } };
    await new BackupWorker(f.store, f.staging, extractor, () => unavailable, 1).execute(job);
    assert.equal(f.store.get(job.id)!.status, 'needs_attention');
    assert.throws(() => f.store.accept('admin@example.test', randomUUID()), /вже виконується/);
    const rejected: BackupTransport = { async upload() {}, async receipt(id) { return { jobId: id, status: 'failed', error: 'CHECKSUM_MISMATCH' }; }, async slots() { return []; } };
    await new BackupWorker(f.store, f.staging, extractor, () => rejected, 1).execute(f.store.get(job.id)!);
    assert.equal(f.store.get(job.id)!.status, 'failed'); assert.deepEqual(await readdir(f.staging), []);
    job = await captured(f);
    const pending: BackupTransport = { async upload() {}, async receipt() { return null; }, async slots() { return []; } };
    await new BackupWorker(f.store, f.staging, extractor, () => pending, 1).execute(job);
    assert.equal(f.store.get(job.id)!.status, 'needs_attention');
  } finally { f.store.db.close(); await rm(f.root, { recursive: true }); }
});

test('post-commit cleanup error is visible and blocks new jobs until safely reconciled', async () => {
  const f = await fixture();
  try {
    const job = await captured(f), directory = await jobDirectory(f.staging, job.id);
    let receipt: RemoteReceipt | null = null;
    const escape = path.join(directory, 'unsafe-cleanup-symlink');
    const external = path.join(f.root, 'must-survive'); await writeFile(external, 'preserve');
    const transport: BackupTransport = {
      async upload(id, artifact, size, checksum) {
        const { symlink } = await import('node:fs/promises'); await symlink(external, escape);
        receipt = { jobId: id, status: 'succeeded', slot: 'slot-1', sha256: checksum, size, committedAt: new Date().toISOString(), cleanupPending: false };
      }, async receipt() { return receipt; }, async slots() { return receipt ? [receipt] : []; },
    };
    const worker = new BackupWorker(f.store, f.staging, extractor, () => transport);
    await worker.execute(job);
    assert.equal(f.store.get(job.id)!.status, 'needs_attention'); assert.equal(await readFile(external, 'utf8'), 'preserve');
    await unlink(escape); // Repair injected fault in this synthetic isolated namespace only.
    await worker.execute(f.store.get(job.id)!);
    assert.equal(f.store.get(job.id)!.status, 'succeeded'); assert.equal(await readFile(external, 'utf8'), 'preserve');
  } finally { f.store.db.close(); await rm(f.root, { recursive: true }); }
});
