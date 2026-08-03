import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";

const run = promisify(execFile);

/**
 * The backup encryption helper.
 *
 * A backup of this system is one directory holding every resident's name and
 * phone number, the whole change log and the field photographs, and it is
 * written to disk precisely so it can be copied somewhere else. These tests pin
 * the two properties that make encrypting it worth anything: the ciphertext
 * really does not contain the plaintext, and a wrong or tampered file is
 * refused rather than half-restored.
 *
 * The key-file refusals are tested too, because the failure they prevent — a
 * key stored inside the backup directory, travelling with the archive it
 * protects — looks like a working setup right up until it matters.
 */

const CRYPTO = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../infra/scripts/backup-crypto.mjs",
);

let root: string;
let keyFile: string;

async function crypto(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run(
      process.execPath,
      [
        CRYPTO,
        ...args,
      ],
      {
        env: {
          ...process.env,
          BACKUP_ENCRYPTION_KEY_FILE: keyFile,
          ...env,
        },
      },
    );

    return {
      code: 0,
      stdout,
      stderr,
    };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };

    return {
      code: failure.code ?? 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
}

before(async () => {
  root = await mkdtemp(path.join(
    tmpdir(),
    "avku-backup-crypto-",
  ));
  await mkdir(
    path.join(
      root,
      "keys",
    ),
    {
      recursive: true,
    },
  );
  keyFile = path.join(
    root,
    "keys",
    "backup.key",
  );
  await writeFile(
    keyFile,
    "a-long-enough-test-passphrase-0123456789",
  );
  await chmod(
    keyFile,
    0o600,
  );
});

after(async () => {
  await rm(
    root,
    {
      recursive: true,
      force: true,
    },
  );
});

describe("backup encryption", () => {
  test("a round trip returns the file byte for byte", async () => {
    const source = path.join(
      root,
      "plain.bin",
    );
    // Includes a NUL and a phone number, so this is not just an ASCII test.
    const original = Buffer.concat([
      Buffer.from("SQLite format 3\0"),
      Buffer.from("Коваленко Олена +380671234567"),
      Buffer.alloc(
        4096,
        7,
      ),
    ]);

    await writeFile(
      source,
      original,
    );

    const encrypted = `${source}.enc`;
    const decrypted = path.join(
      root,
      "round-trip.bin",
    );

    assert.equal(
      (await crypto([
        "encrypt",
        source,
        encrypted,
      ])).code,
      0,
    );
    assert.equal(
      (await crypto([
        "decrypt",
        encrypted,
        decrypted,
      ])).code,
      0,
    );

    assert.deepEqual(
      await readFile(decrypted),
      original,
      "the decrypted file differs from the original",
    );
  });

  test("the ciphertext does not contain the plaintext", async () => {
    const source = path.join(
      root,
      "secret.bin",
    );

    await writeFile(
      source,
      "SQLite format 3\0Коваленко Олена Петрівна +380671234567",
    );

    const encrypted = `${source}.enc`;

    await crypto([
      "encrypt",
      source,
      encrypted,
    ]);

    const bytes = await readFile(encrypted);

    for (
      const secret of [
        "SQLite format 3",
        "+380671234567",
        "Коваленко",
      ]
    ) {
      assert.equal(
        bytes.includes(Buffer.from(secret)),
        false,
        `the ciphertext still contains "${secret}"`,
      );
    }
  });

  test("a wrong key is refused rather than producing rubbish", async () => {
    const source = path.join(
      root,
      "wrong-key.bin",
    );

    await writeFile(
      source,
      "confidential",
    );
    await crypto([
      "encrypt",
      source,
      `${source}.enc`,
    ]);

    const otherKey = path.join(
      root,
      "keys",
      "other.key",
    );

    await writeFile(
      otherKey,
      "a-different-passphrase-9876543210",
    );
    await chmod(
      otherKey,
      0o600,
    );

    const result = await crypto(
      [
        "decrypt",
        `${source}.enc`,
        path.join(
          root,
          "wrong-key.out",
        ),
      ],
      {
        BACKUP_ENCRYPTION_KEY_FILE: otherKey,
      },
    );

    assert.notEqual(
      result.code,
      0,
      "decryption with the wrong key must fail",
    );
    assert.match(
      result.stderr,
      /could not decrypt/,
    );
  });

  test("a tampered file is refused", async () => {
    const source = path.join(
      root,
      "tampered.bin",
    );

    await writeFile(
      source,
      "confidential payload that matters",
    );

    const encrypted = `${source}.enc`;

    await crypto([
      "encrypt",
      source,
      encrypted,
    ]);

    const bytes = await readFile(encrypted);

    // Flip one bit well past the header, in the body.
    bytes[bytes.length - 3] ^= 0x01;
    await writeFile(
      encrypted,
      bytes,
    );

    const result = await crypto([
      "decrypt",
      encrypted,
      path.join(
        root,
        "tampered.out",
      ),
    ]);

    assert.notEqual(
      result.code,
      0,
      "a modified archive must not decrypt — that is what the auth tag is for",
    );
  });

  test("a file that is not an AVKU archive is rejected by name, not by garbage", async () => {
    const notOurs = path.join(
      root,
      "foreign.enc",
    );

    await writeFile(
      notOurs,
      "this is not an encrypted backup at all",
    );

    const result = await crypto([
      "decrypt",
      notOurs,
      path.join(
        root,
        "foreign.out",
      ),
    ]);

    assert.notEqual(
      result.code,
      0,
    );
    assert.match(
      result.stderr,
      /not an AVKU encrypted backup/,
    );
  });
});

describe("the key is never allowed to travel with the backup", () => {
  test("a key inside BACKUP_ROOT is refused", async () => {
    const backupRoot = path.join(
      root,
      "backups",
    );

    await mkdir(
      backupRoot,
      {
        recursive: true,
      },
    );

    const inside = path.join(
      backupRoot,
      "backup.key",
    );

    await writeFile(
      inside,
      "a-long-enough-test-passphrase-0123456789",
    );
    await chmod(
      inside,
      0o600,
    );

    const result = await crypto(
      ["check-key"],
      {
        BACKUP_ENCRYPTION_KEY_FILE: inside,
        BACKUP_ROOT: backupRoot,
      },
    );

    assert.notEqual(
      result.code,
      0,
      "a key stored in the backup directory would be copied along with it",
    );
    assert.match(
      result.stderr,
      /inside BACKUP_ROOT/,
    );
  });

  test("a key inside DATA_ROOT is refused", async () => {
    const dataRoot = path.join(
      root,
      "data",
    );

    await mkdir(
      dataRoot,
      {
        recursive: true,
      },
    );

    const inside = path.join(
      dataRoot,
      "backup.key",
    );

    await writeFile(
      inside,
      "a-long-enough-test-passphrase-0123456789",
    );
    await chmod(
      inside,
      0o600,
    );

    const result = await crypto(
      ["check-key"],
      {
        BACKUP_ENCRYPTION_KEY_FILE: inside,
        DATA_ROOT: dataRoot,
      },
    );

    assert.notEqual(
      result.code,
      0,
    );
    assert.match(
      result.stderr,
      /inside DATA_ROOT/,
    );
  });

  test("a world-readable key file is refused", async () => {
    const open = path.join(
      root,
      "keys",
      "open.key",
    );

    await writeFile(
      open,
      "a-long-enough-test-passphrase-0123456789",
    );
    await chmod(
      open,
      0o644,
    );

    const result = await crypto(
      ["check-key"],
      {
        BACKUP_ENCRYPTION_KEY_FILE: open,
      },
    );

    assert.notEqual(
      result.code,
      0,
    );
    assert.match(
      result.stderr,
      /readable by other users/,
    );
  });

  test("a short key is refused", async () => {
    const short = path.join(
      root,
      "keys",
      "short.key",
    );

    await writeFile(
      short,
      "tiny",
    );
    await chmod(
      short,
      0o600,
    );

    const result = await crypto(
      ["check-key"],
      {
        BACKUP_ENCRYPTION_KEY_FILE: short,
      },
    );

    assert.notEqual(
      result.code,
      0,
    );
    assert.match(
      result.stderr,
      /at least 16 characters/,
    );
  });
});
