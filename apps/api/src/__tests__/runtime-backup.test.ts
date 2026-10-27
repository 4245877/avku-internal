import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const exec = promisify(execFile);
const scripts = path.resolve("../../infra/scripts");
const modules = ["certificates", "elections", "employees", "warehouse", "logistics"];

async function runScript(name: string, env: Record<string, string>) {
  return exec("sh", [path.join(scripts, name)], {
    env: { ...process.env, BACKUP_ENCRYPTION_KEY_FILE: "", ...env },
  });
}

test("runtime backup folds committed WAL for all five stores and restores photos and territory", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "avku-runtime-backup-"));
  const databases: DatabaseSync[] = [];
  try {
    const data = path.join(root, "data"), backups = path.join(root, "backups"), restored = path.join(root, "restored");
    for (const module of modules) {
      const directory = path.join(data, module);
      await mkdir(directory, { recursive: true });
      const db = new DatabaseSync(path.join(directory, `${module}.sqlite`));
      databases.push(db);
      db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE saved(value TEXT); INSERT INTO saved VALUES('committed WAL');");
    }
    await mkdir(path.join(data, "certificates/photos"));
    await writeFile(path.join(data, "certificates/photos/test.png"), "synthetic photo bytes");
    await writeFile(path.join(data, "elections/workspace-area.geo.json"), '{"synthetic":true}');
    await runScript("backup-db.sh", { DATA_ROOT: data, BACKUP_ROOT: backups });
    const [stamp] = await readdir(backups);
    const backup = path.join(backups, stamp);
    await runScript("restore-db.sh", { BACKUP_DIR: backup, RESTORE_ROOT: restored });
    for (const module of modules) {
      const file = path.join(restored, module, `${module}.sqlite`);
      const db = new DatabaseSync(file, { readOnly: true });
      try {
        assert.equal(db.prepare("SELECT value FROM saved").get()?.value, "committed WAL");
        assert.equal(db.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
      } finally { db.close(); }
    }
    assert.equal(await readFile(path.join(restored, "certificates/photos/test.png"), "utf8"), "synthetic photo bytes");
    assert.equal(await readFile(path.join(restored, "elections/workspace-area.geo.json"), "utf8"), '{"synthetic":true}');
  } finally {
    databases.forEach(db => db.close());
    await rm(root, { recursive: true, force: true });
  }
});

test("a corrupt photo archive is rejected before an existing database is replaced", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "avku-runtime-restore-"));
  try {
    const backup = path.join(root, "backup"), restored = path.join(root, "restored");
    await mkdir(path.join(backup, "certificates"), { recursive: true });
    await mkdir(path.join(restored, "certificates"), { recursive: true });
    const db = new DatabaseSync(path.join(backup, "certificates/certificates.sqlite"));
    db.exec("CREATE TABLE saved(value TEXT)"); db.close();
    const target = path.join(restored, "certificates/certificates.sqlite");
    await writeFile(target, "original must survive");
    await writeFile(path.join(backup, "certificates/photos.tar.gz"), "corrupt gzip");
    await assert.rejects(runScript("restore-db.sh", { BACKUP_DIR: backup, RESTORE_ROOT: restored }));
    assert.equal(await readFile(target, "utf8"), "original must survive");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("empty backups and corrupt SQLite files leave the restore destination untouched", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "avku-runtime-invalid-"));
  try {
    const backup = path.join(root, "backup"), restored = path.join(root, "restored");
    await mkdir(backup);
    await assert.rejects(runScript("restore-db.sh", { BACKUP_DIR: backup, RESTORE_ROOT: restored }));
    await assert.rejects(access(restored));
    await mkdir(path.join(backup, "certificates"));
    await writeFile(path.join(backup, "certificates/certificates.sqlite"), "corrupt database");
    await assert.rejects(runScript("restore-db.sh", { BACKUP_DIR: backup, RESTORE_ROOT: restored }));
    await assert.rejects(access(restored));
  } finally { await rm(root, { recursive: true, force: true }); }
});
