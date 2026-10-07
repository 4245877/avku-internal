import path from "node:path";
import { readFile, rm, writeFile } from "node:fs/promises";
import { assertJob } from "./files";
import { run } from "./process";
import type { RemoteReceipt } from "./store";

function quote(value: string): string {
  if (/[\r\n\0]/.test(value)) throw new Error("UNSAFE_SFTP_PATH");
  return '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"';
}
export interface BackupTransport {
  upload(id: string, artifact: string, size: number, sha256: string): Promise<void>;
  receipt(id: string): Promise<RemoteReceipt | null>;
  slots(): Promise<RemoteReceipt[]>;
}
export class SftpTransport implements BackupTransport {
  constructor(readonly scratch: string, readonly env = process.env) {}
  private async batch(commands: string): Promise<void> {
    await run("sftp", ["-q", "-b", "-", "-P", "22", "-F", "/dev/null", "-i", this.env.CERTIFICATE_BACKUP_SSH_KEY ?? "/run/secrets/ssh_key",
      "-oBatchMode=yes", "-oIdentitiesOnly=yes", "-oIdentityAgent=none", "-oPasswordAuthentication=no", "-oKbdInteractiveAuthentication=no",
      "-oStrictHostKeyChecking=yes", "-oUpdateHostKeys=no", "-oGlobalKnownHostsFile=/dev/null", "-oUserKnownHostsFile=" + (this.env.CERTIFICATE_BACKUP_KNOWN_HOSTS ?? "/run/secrets/known_hosts"),
      "-oHostKeyAlgorithms=ssh-ed25519", "-oConnectTimeout=10", "-oServerAliveInterval=15", "-oServerAliveCountMax=2", "-oClearAllForwardings=yes",
      "avku-backup@192.168.0.137"], commands, 1_800_000).catch(() => { throw new Error("SSH_TRANSFER_FAILED"); });
  }
  async upload(id: string, artifact: string, size: number, sha256: string): Promise<void> {
    assertJob(id);
    const marker = path.join(this.scratch, id + ".marker.json");
    await writeFile(marker, JSON.stringify({ jobId: id, size, sha256 }), { mode: 0o600 });
    await this.batch(`put ${quote(artifact)} /incoming/${id}.partial\nput ${quote(marker)} /incoming/${id}.marker.partial\nrename /incoming/${id}.marker.partial /incoming/${id}.ready\n`);
  }
  private async fetch(name: string): Promise<unknown | null> {
    const destination = path.join(this.scratch, name + ".download");
    await rm(destination, { force: true });
    try {
      await this.batch(`get /status/${name} ${quote(destination)}\n`);
      const content = await readFile(destination, "utf8");
      if (content.length > 65536) throw new Error("REMOTE_STATUS_TOO_LARGE");
      return JSON.parse(content);
    } catch { return null; }
    finally { await rm(destination, { force: true }); }
  }
  async receipt(id: string): Promise<RemoteReceipt | null> { assertJob(id); return await this.fetch(id + ".json") as RemoteReceipt | null; }
  async slots(): Promise<RemoteReceipt[]> {
    const result = await this.fetch("slots.json") as { slots?: RemoteReceipt[] } | null;
    if (!result || !Array.isArray(result.slots) || result.slots.length > 2) throw new Error("REMOTE_INVENTORY_UNAVAILABLE");
    return result.slots;
  }
}
