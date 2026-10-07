import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdir, realpath, stat, symlink } from "node:fs/promises";
import { copyPlain, copyTree, plainFile, sha256 } from "./files";
import { verifyCapture } from "./capture";
import { run } from "./process";
import { prepareRecoveryContext } from "./recovery-context";

export async function restoreVerify(artifact: string, checksum: string, directory: string, extractor: string, render = true) {
  if (!/^[a-f0-9]{64}$/.test(checksum)) throw new Error("EXPECTED_TRANSPORT_SHA256_REQUIRED");
  const destination = path.resolve(directory);
  if (await realpath(path.dirname(destination)) !== path.dirname(destination)) throw new Error("UNSAFE_RESTORE_PARENT");
  for (const forbidden of ['/var/lib/avku-internal/data', '/data', process.env.DATA_ROOT].filter(Boolean) as string[]) {
    const root = path.resolve(forbidden);
    if (destination === root || destination.startsWith(root + path.sep)) throw new Error('PRODUCTION_RESTORE_TARGET_FORBIDDEN');
  }
  await plainFile(artifact);
  if (await sha256(artifact) !== checksum) throw new Error("TRANSPORT_CHECKSUM_MISMATCH");
  await mkdir(directory, { mode: 0o700 }); // New isolated directory; never accepts an existing production path.
  const payload = path.join(directory, "payload");
  await run("python3", ["-B", extractor, artifact, payload]);
  const manifest = await verifyCapture(payload);
  if (manifest.runtime.node !== process.version || JSON.stringify(manifest.runtime.sharp) !== JSON.stringify((await import("sharp")).default.versions)) throw new Error("MATCHING_RECOVERY_RUNTIME_REQUIRED");
  if (render) {
    const previousFontConfig = process.env.FONTCONFIG_FILE;
    try {
    const context = path.join(directory, "recovery-context");
    await prepareRecoveryContext(payload, context);
    // Use the verified archived API source with this matching runtime's
    // dependencies. The extracted payload remains untouched.
    await symlink(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../node_modules"), path.join(context, "apps/api/node_modules"));
    const { CertificateRepository } = await import(pathToFileURL(path.join(context, "apps/api/src/modules/certificates/certificate-records.ts")).href) as typeof import("../certificates/certificate-records");
    const instance = path.join(directory, "isolated-instance");
    await mkdir(instance, { mode: 0o700 });
    await copyPlain(path.join(payload, "database/certificates.sqlite"), path.join(instance, "certificates.sqlite"));
    // This copy is disposable and must be writable for the repository's WAL and migration checks.
    const { chmod } = await import("node:fs/promises"); await chmod(path.join(instance, "certificates.sqlite"), 0o600);
    await copyTree(path.join(payload, "photos"), path.join(instance, "photos"));
    process.env.FONTCONFIG_FILE = path.join(payload, "recovery/fonts.conf");
    await run("fc-cache", ["-f"], undefined, 120_000);
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    for (const [font, resource] of Object.entries(manifest.fontResolutions)) {
      const { stdout } = await promisify(execFile)("fc-match", ["--format=%{file}", font]);
      if (await sha256(stdout.trim()) !== manifest.files[resource].sha256) throw new Error("RESTORED_FONT_MISMATCH");
    }
    const repository = new CertificateRepository({ storageRoot: instance, templatesDirectory: path.join(payload, "templates") });
    await repository.check();
    const records = await repository.list();
    if (records.length !== manifest.counts.total) throw new Error("RESTORED_REGISTRY_COUNT_MISMATCH");
    const active = records.find(record => record.status === "active");
    if (active) {
      for (const id of ["volunteer-card-v1-uk", "volunteer-card-v1-en"]) {
        const png = await repository.renderPng(active.id, id);
        if ((await stat(png)).size === 0) throw new Error("RESTORED_RENDER_FAILED");
        const pdf = await repository.renderPdf(active.id, id);
        if (!pdf.subarray(0, 4).equals(Buffer.from("%PDF"))) throw new Error("RESTORED_PDF_FAILED");
      }
      await repository.renderPrintSheet([active.id]);
    }
    const draft = records.find(record => record.status === "draft");
    if (draft && (await repository.get(draft.id)).status !== "draft") throw new Error("RESTORED_DRAFT_FAILED");
    } finally {
      if (previousFontConfig === undefined) delete process.env.FONTCONFIG_FILE;
      else process.env.FONTCONFIG_FILE = previousFontConfig;
    }
  }
  return { jobId: manifest.jobId, counts: manifest.counts, schemaVersion: manifest.schemaVersion, snapshotAt: manifest.snapshotAt, templates: manifest.templates, renderVerified: render };
}
async function main() {
  const [artifact, checksum, directory] = process.argv.slice(2);
  if (!artifact || !checksum || !directory || process.argv.length !== 5) throw new Error("USAGE_ARTIFACT_SHA256_NEW_ISOLATED_DIRECTORY");
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
  console.info(JSON.stringify(await restoreVerify(artifact, checksum, directory, path.join(root, "infra/certificate-backup/extract.py"))));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : "ISOLATED_RESTORE_FAILED"); process.exitCode = 1; });
}
