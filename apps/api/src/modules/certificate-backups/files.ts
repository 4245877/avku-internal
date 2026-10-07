import path from "node:path";
import { constants, createReadStream } from "node:fs";
import { chmod, copyFile, lstat, mkdir, open, readdir, realpath, rm } from "node:fs/promises";
import { createHash } from "node:crypto";

export const JOB_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function assertJob(id: string): void {
  if (!JOB_PATTERN.test(id)) throw new Error("INVALID_JOB_ID");
}
export async function sha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
export async function plainFile(file: string): Promise<void> {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error("UNSAFE_FILE");
}
export async function copyPlain(source: string, destination: string): Promise<void> {
  await plainFile(source);
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await copyFile(source, destination, constants.COPYFILE_EXCL);
  await chmod(destination, 0o400);
}
export async function copyTree(source: string, destination: string): Promise<void> {
  if ((await lstat(source)).isSymbolicLink()) throw new Error("UNSAFE_DIRECTORY");
  await mkdir(destination, { recursive: true, mode: 0o700 });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name), to = path.join(destination, entry.name);
    if (entry.isDirectory()) await copyTree(from, to);
    else if (entry.isFile()) await copyPlain(from, to);
    else throw new Error("UNSAFE_RESOURCE");
  }
}
export async function allFiles(root: string, relative = ""): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const name = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) result.push(...await allFiles(root, name));
    else if (entry.isFile()) { await plainFile(path.join(root, name)); result.push(name); }
    else throw new Error("UNSAFE_RESOURCE");
  }
  return result.sort();
}
export async function jobDirectory(root: string, id: string, create = false): Promise<string> {
  assertJob(id);
  const resolved = await realpath(root);
  if (resolved !== path.resolve(root)) throw new Error("UNSAFE_STAGING_ROOT");
  const dir = path.join(resolved, id);
  if (create) await mkdir(dir, { mode: 0o700 });
  if (await realpath(dir) !== dir || !(await lstat(dir)).isDirectory()) throw new Error("UNSAFE_JOB_DIRECTORY");
  return dir;
}
export async function cleanJob(root: string, id: string): Promise<void> {
  let dir: string;
  try { dir = await jobDirectory(root, id); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  // Walk first: never follow a substituted symlink or a special file.
  await allFiles(dir);
  await rm(dir, { recursive: true, force: false });
}
export async function cleanPackedVerification(root: string, id: string): Promise<void> {
  const parent = await jobDirectory(root, id), directory = path.join(parent, "packed-verify");
  try {
    if (await realpath(directory) !== directory || !(await lstat(directory)).isDirectory()) throw new Error("UNSAFE_VERIFICATION_DIRECTORY");
    await allFiles(directory);
    await rm(directory, { recursive: true, force: false });
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
export async function syncFile(file: string): Promise<void> {
  const fd = await open(file, "r");
  try { await fd.sync(); } finally { await fd.close(); }
}
export async function syncDirectories(root: string): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory()) await syncDirectories(path.join(root, entry.name));
    else if (!entry.isFile()) throw new Error("UNSAFE_RESOURCE");
  }
  await syncFile(root);
}
