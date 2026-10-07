// Synthetic HTTP/browser/worker/publication integration; no production mounts.
import path from "node:path";
import { mkdir, copyFile, readFile, writeFile } from "node:fs/promises";
import { watch } from "node:fs";
import { generateKeyPair, SignJWT } from "jose";
import sharp from "sharp";
import { CertificateRepository } from "../modules/certificates/certificate-records";
import { BackupService } from "../modules/certificate-backups/service";
import { BackupWorker } from "../modules/certificate-backups/worker";
import type { BackupTransport } from "../modules/certificate-backups/transport";
import { createCertificateApiServer } from "../server";
import { createAccessAuthenticator } from "../http/access-auth";
import { run } from "../modules/certificate-backups/process";
import type { RemoteReceipt } from "../modules/certificate-backups/store";

async function main() {
  const root = '/lab';
  process.env.DATA_ROOT = root + '/data';
  const repository = new CertificateRepository({ storageRoot: root + '/data/certificates', templatesDirectory: '/app/storage/certificates/templates' });
  const photo = await sharp({ create: { width: 600, height: 800, channels: 3, background: '#ac9070' } }).png().toBuffer();
  await repository.create({ fullName: 'Тестовий Волонтер', firstNameEn: 'Test', lastNameEn: 'Volunteer', certificateNumber: 'ISOLATED-001', issuedAt: '2026-10-06', validUntil: '2027-10-06', photoDataUrl: 'data:image/png;base64,' + photo.toString('base64') });
  await repository.create({ status: 'draft', fullName: 'Чернетка Тестова', certificateNumber: 'ISOLATED-002' });
  const staging = root + '/staging'; await mkdir(staging, { mode: 0o700 });
  const service = new BackupService(repository, { CERTIFICATE_BACKUP_STATE: root + '/jobs', CERTIFICATE_BACKUP_STAGING: staging,
    CERTIFICATE_BACKUP_ORIGINS: 'http://127.0.0.1:18183', AVKU_RELEASE_ID: process.env.AVKU_RELEASE_ID ?? 'isolated-e2e' });
  const remote = root + '/remote';
  for (const name of ['sftp/incoming', 'sftp/status', '.candidates', 'slots']) await mkdir(path.join(remote, name), { recursive: true, mode: 0o700 });
  const transport: BackupTransport = {
    async upload(jobId, artifact, size, sha256) {
      await copyFile(artifact, path.join(remote, 'sftp/incoming', jobId + '.partial'));
      await writeFile(path.join(remote, 'sftp/incoming', jobId + '.ready'), JSON.stringify({ jobId, size, sha256 }), { mode: 0o600 });
      await run('python3', ['-B', '/app/infra/certificate-backup/server/isolated_receiver.py', remote]);
    },
    async receipt(jobId) { try { return JSON.parse(await readFile(path.join(remote, 'sftp/status', jobId + '.json'), 'utf8')) as RemoteReceipt; } catch { return null; } },
    async slots() { return JSON.parse(await readFile(path.join(remote, 'sftp/status/slots.json'), 'utf8')).slots; },
  };
  const worker = new BackupWorker(service.store, staging, '/app/infra/certificate-backup/extract.py', () => transport);
  let busy = false;
  watch(service.store.root, () => {
    const job = service.store.active();
    if (!busy && job && !['accepted', 'capturing'].includes(job.status)) {
      busy = true; void worker.execute(job).finally(() => { busy = false; });
    }
  });
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const teamDomain = 'isolated.example.test', audience = 'isolated-test-audience';
  const token = await new SignJWT({ email: 'isolated-admin@example.test' }).setProtectedHeader({ alg: 'RS256' }).setIssuer('https://' + teamDomain).setAudience(audience).setExpirationTime('1h').sign(privateKey);
  await writeFile(root + '/test-token', token, { mode: 0o600 });
  const server = createCertificateApiServer({ certificateRepository: repository }, { backupService: service, authenticator: createAccessAuthenticator({ teamDomain, audience, createVerifyKey: () => () => publicKey }) });
  server.listen(3001, '0.0.0.0', () => console.info('isolated_e2e_ready'));
}
main().catch(() => { console.error('isolated_e2e_failed'); process.exitCode = 1; });
