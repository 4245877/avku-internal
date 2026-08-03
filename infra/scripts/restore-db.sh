#!/usr/bin/env sh
#
# Restores a backup produced by backup-db.sh into a directory of your choosing.
#
#   BACKUP_DIR=/var/backups/avku-internal/20260803T074028Z \
#   RESTORE_ROOT=/var/lib/avku-internal/data \
#   ./infra/scripts/restore-db.sh
#
# An encrypted backup additionally needs the key it was written with:
#
#   BACKUP_ENCRYPTION_KEY_FILE=/etc/avku/backup.key ... ./infra/scripts/restore-db.sh
#
# Stop the API first. Each database in a backup is a self-contained snapshot
# with the WAL already folded in, so there are no -wal/-shm sidecars to carry
# along — and any left over in the target from a previous run would shadow the
# file that was just restored, which is why they are removed.
#
# Nothing is written to RESTORE_ROOT until every artifact has been decrypted and
# every database has passed its integrity check: a restore that fails should
# leave the previous data alone rather than half-replace it.
set -eu

BACKUP_DIR=${BACKUP_DIR:?BACKUP_DIR must point at one timestamped backup directory}
RESTORE_ROOT=${RESTORE_ROOT:?RESTORE_ROOT must be set}
CRYPTO_SCRIPT=$(dirname "$0")/backup-crypto.mjs

fail() {
  echo "restore-db.sh: $*" >&2
  exit 1
}

case "$BACKUP_DIR" in /*) ;; *) fail "BACKUP_DIR must be an absolute path" ;; esac
case "$RESTORE_ROOT" in /*) ;; *) fail "RESTORE_ROOT must be an absolute path" ;; esac
[ -d "$BACKUP_DIR" ] || fail "no such backup directory: $BACKUP_DIR"

command -v node >/dev/null 2>&1 || fail "node is required to verify a restore"

STAGING=$(mktemp -d "${TMPDIR:-/tmp}/avku-restore-XXXXXX") ||
  fail "could not create a staging directory"
cleanup() { rm -rf "$STAGING"; }
trap cleanup EXIT INT TERM

umask 077

# 1. Copy (decrypting where needed) into staging.
find "$BACKUP_DIR" -type f -print | while IFS= read -r source; do
  relative=${source#"$BACKUP_DIR"/}
  case "$relative" in
    *.enc) target="$STAGING/${relative%.enc}" ;;
    *) target="$STAGING/$relative" ;;
  esac

  mkdir -p "$(dirname "$target")" || fail "could not create $(dirname "$target")"

  case "$source" in
    *.enc)
      [ -f "$CRYPTO_SCRIPT" ] || fail "missing decryption helper: $CRYPTO_SCRIPT"
      [ -n "${BACKUP_ENCRYPTION_KEY_FILE:-}" ] ||
        fail "this backup is encrypted; set BACKUP_ENCRYPTION_KEY_FILE"
      node "$CRYPTO_SCRIPT" decrypt "$source" "$target" ||
        fail "could not decrypt $source"
      ;;
    *)
      cp -p "$source" "$target" || fail "could not copy $source"
      ;;
  esac
done

[ -n "$(find "$STAGING" -type f -print -quit)" ] ||
  fail "the backup produced no files — decryption may have failed"

# 2. Verify every database before anything is put in place.
find "$STAGING" -type f -name '*.sqlite' -print | while IFS= read -r database; do
  result=$(VERIFY_PATH="$database" node -e '
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(process.env.VERIFY_PATH);
    try {
      console.log(Object.values(db.prepare("PRAGMA integrity_check").get())[0]);
    } finally {
      db.close();
    }
  ' 2>/dev/null) || fail "could not open $database"

  [ "$result" = "ok" ] || fail "integrity check failed for $database: $result"
  echo "Verified $(basename "$database")"
done

# 3. Put it in place.
mkdir -p "$RESTORE_ROOT" || fail "could not create $RESTORE_ROOT"

find "$STAGING" -type f -print | while IFS= read -r staged; do
  relative=${staged#"$STAGING"/}
  target="$RESTORE_ROOT/$relative"

  mkdir -p "$(dirname "$target")" || fail "could not create $(dirname "$target")"

  case "$relative" in
    *.sqlite)
      # A stale WAL beside the restored file would shadow it.
      rm -f "$target-wal" "$target-shm"
      ;;
    *.tar.gz)
      tar -xzf "$staged" -C "$(dirname "$target")" || fail "could not extract $staged"
      continue
      ;;
  esac

  cp -p "$staged" "$target" || fail "could not place $target"
  echo "Restored $relative"
done

echo "Restored $BACKUP_DIR -> $RESTORE_ROOT"
