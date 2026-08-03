#!/usr/bin/env node
/**
 * Authenticated encryption for the backup artifacts.
 *
 * A backup of this system is the single most sensitive object it produces: one
 * directory holding every resident's name and phone number, the whole change
 * log, and the field photographs. It is written to disk, and from there it is
 * copied to wherever backups go — which is exactly where the deployment stops
 * controlling it. Encrypting it is the difference between losing a disk and
 * losing the district's contact list.
 *
 * Deliberate choices:
 *
 *  • AES-256-GCM, so a tampered archive fails to decrypt rather than restoring
 *    quietly-altered data. A backup that cannot detect modification is a poor
 *    input to a restore.
 *  • scrypt for key derivation, with a per-file random salt, so a weak
 *    passphrase costs an attacker real work and two files never share a key.
 *  • Streaming, so a multi-gigabyte snapshot never has to fit in memory.
 *  • The key comes from a file named by `BACKUP_ENCRYPTION_KEY_FILE` and is
 *    never written into the archive, never echoed, and never defaulted. There
 *    is no key inside the backup, because a key inside the backup is not a key.
 *
 * Encryption is opt-in: with the variable unset the backup behaves exactly as
 * it did before, so enabling this cannot break an existing deployment.
 *
 *   node backup-crypto.mjs encrypt <in> <out>
 *   node backup-crypto.mjs decrypt <in> <out>
 *   node backup-crypto.mjs check-key
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { createReadStream, createWriteStream, readFileSync, statSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import path from "node:path";

const MAGIC = Buffer.from("AVKUBK1\0", "utf8"); // 8 bytes
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const SCRYPT_COST = 1 << 15; // N=32768: ~100 ms and ~32 MB per derivation.

function fail(message) {
  console.error(`backup-crypto: ${message}`);
  process.exit(1);
}

/**
 * Reads the passphrase from the file named by `BACKUP_ENCRYPTION_KEY_FILE`.
 *
 * The refusals matter as much as the read. A key stored inside the backup
 * directory or the data directory travels with the very thing it protects — a
 * copied backup would carry its own key — so both are refused outright rather
 * than warned about. So is a world-readable key file, and so is a short one.
 */
export function readKeyMaterial() {
  const keyFile = process.env.BACKUP_ENCRYPTION_KEY_FILE?.trim();

  if (!keyFile) {
    fail("BACKUP_ENCRYPTION_KEY_FILE is not set.");
  }

  const resolved = path.resolve(keyFile);
  const forbidden = [
    ["BACKUP_ROOT", process.env.BACKUP_ROOT],
    ["DATA_ROOT", process.env.DATA_ROOT],
  ];

  for (const [name, root] of forbidden) {
    if (!root) {
      continue;
    }

    const resolvedRoot = path.resolve(root);

    if (resolved === resolvedRoot || resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
      fail(
        `the key file is inside ${name} (${resolvedRoot}). A key kept with the ` +
          "data it protects is not protection — move it elsewhere.",
      );
    }
  }

  let stats;

  try {
    stats = statSync(resolved);
  } catch {
    fail(`cannot read the key file: ${resolved}`);
  }

  // eslint-disable-next-line no-bitwise
  if ((stats.mode & 0o077) !== 0) {
    fail(
      `the key file is readable by other users: ${resolved}. ` +
        "Run: chmod 600 on it.",
    );
  }

  const material = readFileSync(resolved).toString("utf8").trim();

  if (material.length < 16) {
    fail("the key must be at least 16 characters.");
  }

  return material;
}

const deriveKey = (material, salt) =>
  scryptSync(material, salt, KEY_BYTES, { N: SCRYPT_COST, maxmem: 128 * 1024 * 1024 });

async function encrypt(source, target) {
  const material = readKeyMaterial();
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(material, salt), iv);
  const out = createWriteStream(target, { mode: 0o600 });

  /*
   * The tag is only known once the whole body has been through the cipher, so
   * its 16 bytes are reserved up front and written back afterwards. That keeps
   * the format single-pass and streamable in both directions.
   */
  out.write(Buffer.concat([MAGIC, salt, iv, Buffer.alloc(TAG_BYTES)]));
  await pipeline(createReadStream(source), cipher, out, { end: true });

  const { open } = await import("node:fs/promises");
  const handle = await open(target, "r+");

  try {
    await handle.write(
      cipher.getAuthTag(),
      0,
      TAG_BYTES,
      MAGIC.length + SALT_BYTES + IV_BYTES,
    );
  } finally {
    await handle.close();
  }
}

async function decrypt(source, target) {
  const material = readKeyMaterial();
  const headerLength = MAGIC.length + SALT_BYTES + IV_BYTES + TAG_BYTES;
  const { open } = await import("node:fs/promises");
  const handle = await open(source, "r");
  const header = Buffer.alloc(headerLength);

  try {
    await handle.read(header, 0, headerLength, 0);
  } finally {
    await handle.close();
  }

  if (!header.subarray(0, MAGIC.length).equals(MAGIC)) {
    fail(`not an AVKU encrypted backup: ${source}`);
  }

  let offset = MAGIC.length;
  const salt = header.subarray(offset, offset += SALT_BYTES);
  const iv = header.subarray(offset, offset += IV_BYTES);
  const tag = header.subarray(offset, offset += TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", deriveKey(material, salt), iv);

  decipher.setAuthTag(tag);

  try {
    await pipeline(
      createReadStream(source, { start: headerLength }),
      decipher,
      createWriteStream(target, { mode: 0o600 }),
    );
  } catch (error) {
    // GCM reports both a wrong key and a modified file the same way, and that
    // is the right answer to give: neither one may be restored.
    fail(
      `could not decrypt ${source} — wrong key, or the file has been altered ` +
        `(${error instanceof Error ? error.message : String(error)}).`,
    );
  }
}

const [command, source, target] = process.argv.slice(2);

if (command === "check-key") {
  readKeyMaterial();
  console.log("backup-crypto: key file accepted");
} else if (command === "encrypt" || command === "decrypt") {
  if (!source || !target) {
    fail(`usage: backup-crypto.mjs ${command} <in> <out>`);
  }

  await (command === "encrypt" ? encrypt : decrypt)(source, target);
} else {
  fail("usage: backup-crypto.mjs encrypt|decrypt|check-key [in] [out]");
}
