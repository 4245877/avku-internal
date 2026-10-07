import path from "node:path";
import { DatabaseSync, backup } from "node:sqlite";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { allFiles, copyPlain, copyTree, sha256, syncDirectories, syncFile } from "./files";
import sharp from "sharp";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export interface CaptureInfo { snapshotAt: string; schemaVersion: number; counts: { total: number; active: number; draft: number; photos: number }; templates: string[]; }
export interface Manifest extends CaptureInfo {
  formatVersion: 3; jobId: string; actor: string; createdAt: string;
  runtime: { node: string; sqlite: string; sharp: Record<string, string>; release: string };
  files: Record<string, { size: number; sha256: string }>;
  fontResolutions: Record<string, string>;
  recovery: { database: string; photos: string; templates: string; fonts: string; schemaVersion: number; generatedExcluded: boolean };
}
export async function captureDatabaseAndFiles(database: DatabaseSync, photos: string, templates: string, target: string): Promise<CaptureInfo> {
  await mkdir(path.join(target, "database"), { recursive: true, mode: 0o700 });
  await mkdir(path.join(target, "photos"), { mode: 0o700 });
  const snapshotAt = new Date().toISOString();
  const file = path.join(target, "database/certificates.sqlite");
  await backup(database, file);
  const snapshot = new DatabaseSync(file);
  let info: CaptureInfo;
  try {
    // Make the snapshot a standalone SQLite file, with no WAL/shm dependency.
    snapshot.exec("PRAGMA journal_mode=DELETE");
    const schemaVersion = Number(snapshot.prepare("PRAGMA user_version").get()!.user_version);
    if (schemaVersion !== 4) throw new Error("UNSUPPORTED_SCHEMA");
    const counts = { total: 0, active: 0, draft: 0, photos: 0 };
    for (const row of snapshot.prepare("SELECT status,count(*) AS n FROM certificate_records GROUP BY status").all()) {
      if (row.status !== "active" && row.status !== "draft") throw new Error("INVALID_RECORD_STATUS");
      counts[row.status] = Number(row.n); counts.total += Number(row.n);
    }
    const refs = snapshot.prepare("SELECT DISTINCT photo_file_name FROM certificate_records WHERE photo_file_name IS NOT NULL").all().map(row => String(row.photo_file_name));
    for (const name of refs) {
      if (!/^[a-zA-Z0-9._-]+$/.test(name) || name === "." || name === "..") throw new Error("UNSAFE_PHOTO_REFERENCE");
      await copyPlain(path.join(photos, name), path.join(target, "photos", name));
    }
    counts.photos = refs.length;
    const used = snapshot.prepare("SELECT DISTINCT template_id FROM certificate_records").all().map(r => String(r.template_id));
    const templateIds = [...new Set(["volunteer-card-v1-uk", "volunteer-card-v1-en", ...used])].sort();
    for (const id of templateIds) {
      if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error("UNSAFE_TEMPLATE_ID");
      for (const resource of ["layout.json", "background.png", "stamp-overlay.png"]) {
        await copyPlain(path.join(templates, id, resource), path.join(target, "templates", id, resource));
      }
    }
    info = { snapshotAt, schemaVersion, counts, templates: templateIds };
  } finally { snapshot.close(); }
  await chmod(file, 0o400);
  return info;
}

export async function finishCapture(target: string, info: CaptureInfo, job: { id: string; actor: string; createdAt: string }, resources: { fonts: string; source: string; packageRoot: string; release: string }): Promise<Manifest> {
  await copyTree(resources.fonts, path.join(target, "recovery/fonts"));
  await copyTree(resources.source, path.join(target, "recovery/api-src"));
  for (const name of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.json"]) await copyPlain(path.join(resources.packageRoot, name), path.join(target, "recovery", name));
  // The worktree may contain an uncommitted production UI (including drafts).
  // Preserve its immutable image source and lockfile, not merely a Git revision.
  const imageRecovery = path.resolve(resources.packageRoot, "../../recovery");
  await copyTree(path.join(imageRecovery, "web"), path.join(target, "recovery/web"));
  await copyTree(path.join(imageRecovery, "deployment"), path.join(target, "recovery/deployment"));
  const fontResolutions: Record<string, string> = {};
  const fontRules: string[] = [];
  const xml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  for (const id of info.templates) {
    const layout = JSON.parse(await readFile(path.join(target, "templates", id, "layout.json"), "utf8"));
    for (const field of Object.values(layout.fields) as { font?: string }[]) {
      if (!field.font || fontResolutions[field.font]) continue;
      const { stdout } = await promisify(execFile)("fc-match", ["--format=%{file}", field.font]);
      const relative = path.relative(resources.fonts, stdout.trim());
      if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("FONT_OUTSIDE_CAPTURED_RESOURCES");
      fontResolutions[field.font] = path.posix.join("recovery/fonts", relative);
      const scanned = await promisify(execFile)("fc-scan", ["--format=%{family[0]}|%{style[0]}|%{weight[0]}", stdout.trim()]);
      const [family, style, weight] = scanned.stdout.split('|');
      if (!family || !style || !/^\d+$/.test(weight)) throw new Error("FONT_METADATA_INVALID");
      fontRules.push(`<match target="pattern"><test name="family"><string>${xml(field.font)}</string></test><edit name="family" mode="assign" binding="strong"><string>${xml(family)}</string></edit><edit name="style" mode="assign" binding="strong"><string>${xml(style)}</string></edit><edit name="weight" mode="assign" binding="strong"><int>${weight}</int></edit></match>`);
    }
  }
  const fontConfig = `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig><dir prefix="relative">fonts</dir><cachedir>/tmp/avku-font-cache</cachedir>${fontRules.join('')}</fontconfig>`;
  await writeFile(path.join(target, "recovery/fonts.conf"), fontConfig, { mode: 0o400, flag: "wx" });
  const files: Manifest['files'] = {};
  for (const name of await allFiles(target)) {
    files[name] = { size: (await stat(path.join(target, name))).size, sha256: await sha256(path.join(target, name)) };
    await syncFile(path.join(target, name));
  }
  const memory = new DatabaseSync(":memory:");
  const sqlite = String(memory.prepare("SELECT sqlite_version() AS version").get()!.version); memory.close();
  const manifest: Manifest = { ...info, formatVersion: 3, jobId: job.id, actor: job.actor, createdAt: job.createdAt, fontResolutions,
    runtime: { node: process.version, sqlite, sharp: sharp.versions, release: resources.release }, files,
    recovery: { database: "database/certificates.sqlite", photos: "photos", templates: "templates", fonts: "recovery/fonts", schemaVersion: info.schemaVersion, generatedExcluded: true } };
  await writeFile(path.join(target, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o400, flag: "wx" });
  await writeFile(path.join(target, "SHA256SUMS"), Object.entries(files).map(([name, value]) => `${value.sha256}  ${name}`).join("\n") + "\n", { mode: 0o400, flag: "wx" });
  await syncFile(path.join(target, "manifest.json")); await syncFile(path.join(target, "SHA256SUMS"));
  await syncDirectories(target);
  await syncFile(path.dirname(target));
  await syncFile(path.dirname(path.dirname(target)));
  return manifest;
}

export async function verifyCapture(target: string): Promise<Manifest> {
  const manifest = JSON.parse(await readFile(path.join(target, "manifest.json"), "utf8")) as Manifest;
  if (manifest.formatVersion !== 3 || manifest.schemaVersion !== 4) throw new Error("UNSUPPORTED_BACKUP_FORMAT");
  const actual = await allFiles(target);
  const expected = [...Object.keys(manifest.files), "manifest.json", "SHA256SUMS"].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("FILE_SET_MISMATCH");
  const checksumText = Object.entries(manifest.files).map(([name, value]) => `${value.sha256}  ${name}`).join("\n") + "\n";
  if (await readFile(path.join(target, "SHA256SUMS"), "utf8") !== checksumText) throw new Error("CHECKSUM_INDEX_MISMATCH");
  if (!manifest.templates.includes("volunteer-card-v1-uk") || !manifest.templates.includes("volunteer-card-v1-en") ||
      !manifest.fontResolutions || Object.values(manifest.fontResolutions).some(name => !manifest.files[name])) throw new Error("RECOVERY_RESOURCES_MISSING");
  for (const resource of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.json", "fonts.conf",
    "api-src/main.ts", "api-src/modules/certificates/certificate-records.ts",
    "web/package.json", "web/pnpm-lock.yaml", "web/vite.config.js", "web/index.html", "web/src/main.jsx",
    "deployment/api.Dockerfile", "deployment/web.Dockerfile", "deployment/api-entrypoint.sh", "deployment/dockerignore",
    "deployment/extract.py", "deployment/fonts.conf", "deployment/nginx/app.conf", "deployment/nginx/web.conf"]) {
    if (!manifest.files[`recovery/${resource}`]) throw new Error("RECOVERY_RESOURCES_MISSING");
  }
  for (const [name, value] of Object.entries(manifest.files)) {
    if (path.posix.isAbsolute(name) || name.split("/").some(part => part === ".." || !part)) throw new Error("UNSAFE_MANIFEST_PATH");
    const file = path.join(target, name);
    if ((await stat(file)).size !== value.size || await sha256(file) !== value.sha256) throw new Error("INTERNAL_CHECKSUM_MISMATCH");
  }
  const database = new DatabaseSync(path.join(target, "database/certificates.sqlite"), { readOnly: true });
  try {
    if (JSON.stringify(database.prepare("PRAGMA integrity_check").all()) !== '[{"integrity_check":"ok"}]' || database.prepare("PRAGMA foreign_key_check").all().length) throw new Error("SQLITE_INTEGRITY_FAILED");
    if (Number(database.prepare("PRAGMA user_version").get()!.user_version) !== manifest.schemaVersion) throw new Error("SCHEMA_MISMATCH");
    const rows = database.prepare("SELECT status,photo_file_name,template_id FROM certificate_records").all();
    const refs = [...new Set(rows.filter(r => r.photo_file_name !== null).map(r => String(r.photo_file_name)))].sort();
    const counts = { total: rows.length, active: rows.filter(r => r.status === "active").length, draft: rows.filter(r => r.status === "draft").length, photos: refs.length };
    if (JSON.stringify(counts) !== JSON.stringify(manifest.counts)) throw new Error("COUNT_MISMATCH");
    const photos = actual.filter(name => name.startsWith("photos/")).map(name => name.slice(7)).sort();
    if (JSON.stringify(photos) !== JSON.stringify(refs)) throw new Error("PHOTO_REFERENCE_MISMATCH");
    if (rows.some(r => !manifest.templates.includes(String(r.template_id)) || (r.status === "active" && !r.photo_file_name))) throw new Error("RECORD_DEPENDENCY_MISSING");
    for (const name of refs) await sharp(path.join(target, "photos", name), { limitInputPixels: 100_000_000 }).stats();
    for (const id of manifest.templates) {
      const layout = JSON.parse(await readFile(path.join(target, "templates", id, "layout.json"), "utf8"));
      for (const field of Object.values(layout.fields) as { font?: string }[]) {
        if (field.font && !manifest.fontResolutions[field.font]) throw new Error("RECOVERY_FONT_MISSING");
      }
      const image = await sharp(path.join(target, "templates", id, "background.png")).metadata();
      if (image.width !== layout.canvas.width || image.height !== layout.canvas.height) throw new Error("INVALID_TEMPLATE");
      await sharp(path.join(target, "templates", id, "background.png")).stats();
      await sharp(path.join(target, "templates", id, "stamp-overlay.png")).stats();
    }
  } finally { database.close(); }
  return manifest;
}
