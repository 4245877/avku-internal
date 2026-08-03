#!/usr/bin/env sh
#
# Consistent backup of the AVKU SQLite databases + certificate photos/generated.
#
# Each database is snapshotted into a single self-contained file (WAL folded in)
# via `sqlite3 .backup` or, if sqlite3 is absent, `node:sqlite` VACUUM INTO, and
# then verified with PRAGMA integrity_check. Restore is therefore just:
#
#   cp <backup>/certificates/certificates.sqlite <DATA_ROOT>/certificates/
#   cp <backup>/elections/elections.sqlite         <DATA_ROOT>/elections/
#   tar -xzf <backup>/elections/attachments.tar.gz -C <DATA_ROOT>/elections/
#   tar -xzf <backup>/certificates/photos.tar.gz    -C <DATA_ROOT>/certificates/
#   tar -xzf <backup>/certificates/generated.tar.gz -C <DATA_ROOT>/certificates/
#
# (stop the API first; the snapshot has no -wal/-shm sidecars to carry along).
#
set -eu

DATA_ROOT=${DATA_ROOT:-/var/lib/avku-internal/data}
BACKUP_ROOT=${BACKUP_ROOT:-/var/backups/avku-internal}
TIMESTAMP=$(date -u +"%Y%m%dT%H%M%SZ")
DESTINATION="$BACKUP_ROOT/$TIMESTAMP"

CERTIFICATES_STORAGE_ROOT=${CERTIFICATES_STORAGE_ROOT:-"$DATA_ROOT/certificates"}
WAREHOUSE_STORAGE_ROOT=${WAREHOUSE_STORAGE_ROOT:-"$DATA_ROOT/warehouse"}
LOGISTICS_STORAGE_ROOT=${LOGISTICS_STORAGE_ROOT:-"$DATA_ROOT/logistics"}
ELECTIONS_STORAGE_ROOT=${ELECTIONS_STORAGE_ROOT:-"$DATA_ROOT/elections"}
EMPLOYEES_STORAGE_ROOT=${EMPLOYEES_STORAGE_ROOT:-"$DATA_ROOT/employees"}

BACKED_UP=0

fail() {
  echo "backup-db.sh: $*" >&2
  exit 1
}

warn() {
  echo "backup-db.sh: $*" >&2
}

require_absolute_path() {
  name=$1
  value=$2

  case "$value" in
    /*) ;;
    *) fail "$name must be an absolute path, got: $value" ;;
  esac
}

ensure_directory() {
  directory=$1
  description=$2

  if [ ! -d "$directory" ]; then
    fail "$description does not exist: $directory"
  fi
}

ensure_readable_directory() {
  directory=$1
  description=$2

  if [ ! -r "$directory" ] || [ ! -x "$directory" ]; then
    fail "$description is not readable/searchable: $directory"
  fi
}

copy_file() {
  copy_source_path=$1
  copy_target_path=$2

  cp -p "$copy_source_path" "$copy_target_path" ||
    fail "failed to copy $copy_source_path to $copy_target_path"
  BACKED_UP=1
}

# Produce a single, consistent snapshot of a (possibly live, WAL-mode) SQLite
# database. Prefers `sqlite3 .backup`; falls back to node's built-in `node:sqlite`
# VACUUM INTO. Both fold the WAL into one self-contained file, so a restore never
# depends on -wal/-shm sidecars being copied alongside it.
snapshot_database() {
  snapshot_source=$1
  snapshot_target=$2

  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "$snapshot_source" ".backup '$snapshot_target'"
    return $?
  fi

  if command -v node >/dev/null 2>&1; then
    SNAPSHOT_SRC="$snapshot_source" SNAPSHOT_DST="$snapshot_target" node -e '
      const { DatabaseSync } = require("node:sqlite");
      const q = String.fromCharCode(39);
      const db = new DatabaseSync(process.env.SNAPSHOT_SRC);
      try {
        db.exec("PRAGMA busy_timeout = 5000");
        db.exec("VACUUM INTO " + q + process.env.SNAPSHOT_DST.split(q).join(q + q) + q);
      } finally {
        db.close();
      }
    '
    return $?
  fi

  return 2
}

# Fail the backup unless the produced snapshot passes PRAGMA integrity_check.
verify_snapshot() {
  verify_path=$1
  verify_label=$2
  verify_result=""

  if command -v sqlite3 >/dev/null 2>&1; then
    verify_result=$(sqlite3 "$verify_path" "PRAGMA integrity_check;" 2>/dev/null | head -n1)
  elif command -v node >/dev/null 2>&1; then
    verify_result=$(VERIFY_PATH="$verify_path" node -e '
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(process.env.VERIFY_PATH);
      try {
        const row = db.prepare("PRAGMA integrity_check").get();
        console.log(Object.values(row)[0]);
      } finally {
        db.close();
      }
    ' 2>/dev/null)
  else
    warn "cannot verify $verify_label backup: no sqlite3/node available"
    return 0
  fi

  if [ "$verify_result" != "ok" ]; then
    fail "integrity check failed for $verify_label backup ($verify_path): ${verify_result:-unknown}"
  fi
}

backup_database() {
  storage_root=$1
  file_name=$2
  label=$3
  database_path="$storage_root/$file_name"
  target_directory="$DESTINATION/$label"
  target_path="$target_directory/$file_name"

  if [ ! -d "$storage_root" ]; then
    warn "skipping missing $label storage directory: $storage_root"
    return 0
  fi

  ensure_readable_directory "$storage_root" "$label storage directory"

  if [ ! -f "$database_path" ]; then
    warn "skipping missing $label database: $database_path"
    return 0
  fi

  mkdir -p "$target_directory" ||
    fail "failed to create backup directory: $target_directory"

  snapshot_database "$database_path" "$target_path"
  snapshot_status=$?

  if [ "$snapshot_status" -eq 0 ]; then
    verify_snapshot "$target_path" "$label"
  elif [ "$snapshot_status" -eq 2 ]; then
    # No consistent-snapshot tool available. A raw copy of a live WAL database is
    # only restorable if ALL of .sqlite/-wal/-shm are kept together, and can be
    # torn if the API writes mid-copy — restoring the bare .sqlite silently
    # yields an EMPTY database. Refuse rather than create a misleading backup.
    fail "neither sqlite3 nor node is available to take a consistent snapshot of $database_path. Install sqlite3 (or run where node is available), or stop the API and copy .sqlite + -wal + -shm together."
  else
    fail "consistent snapshot failed for $database_path"
  fi

  BACKED_UP=1
  echo "Backed up $database_path -> $target_path (verified)"
}

backup_certificates_file() {
  file_name=$1
  source_path="$CERTIFICATES_STORAGE_ROOT/$file_name"
  target_directory="$DESTINATION/certificates"

  if [ ! -f "$source_path" ]; then
    return 0
  fi

  mkdir -p "$target_directory" ||
    fail "failed to create backup directory: $target_directory"
  copy_file "$source_path" "$target_directory/$file_name"
  echo "Backed up $source_path"
}

backup_certificates_directory() {
  directory=$1
  source_path="$CERTIFICATES_STORAGE_ROOT/$directory"
  target_directory="$DESTINATION/certificates"

  if [ ! -d "$source_path" ]; then
    return 0
  fi

  command -v tar >/dev/null 2>&1 ||
    fail "tar is required to back up $source_path"

  mkdir -p "$target_directory" ||
    fail "failed to create backup directory: $target_directory"
  tar -czf "$target_directory/$directory.tar.gz" -C "$CERTIFICATES_STORAGE_ROOT" "$directory" ||
    fail "failed to archive $source_path"
  BACKED_UP=1
  echo "Backed up $source_path"
}

# The elections module keeps the traced boundary as a plain file beside its
# database, and field photographs in a directory. Both are runtime data with no
# copy anywhere else, so a backup that took only the SQLite file would restore a
# campaign with no territory and no evidence.
backup_elections_file() {
  file_name=$1
  source_path="$ELECTIONS_STORAGE_ROOT/$file_name"
  target_directory="$DESTINATION/elections"

  if [ ! -f "$source_path" ]; then
    return 0
  fi

  mkdir -p "$target_directory" ||
    fail "failed to create backup directory: $target_directory"
  copy_file "$source_path" "$target_directory/$file_name"
  echo "Backed up $source_path"
}

backup_elections_directory() {
  directory=$1
  source_path="$ELECTIONS_STORAGE_ROOT/$directory"
  target_directory="$DESTINATION/elections"

  if [ ! -d "$source_path" ]; then
    return 0
  fi

  command -v tar >/dev/null 2>&1 ||
    fail "tar is required to back up $source_path"

  mkdir -p "$target_directory" ||
    fail "failed to create backup directory: $target_directory"
  tar -czf "$target_directory/$directory.tar.gz" -C "$ELECTIONS_STORAGE_ROOT" "$directory" ||
    fail "failed to archive $source_path"
  BACKED_UP=1
  echo "Backed up $source_path"
}

require_absolute_path DATA_ROOT "$DATA_ROOT"
require_absolute_path BACKUP_ROOT "$BACKUP_ROOT"
ensure_directory "$DATA_ROOT" DATA_ROOT
ensure_readable_directory "$DATA_ROOT" DATA_ROOT

umask 077
mkdir -p "$DESTINATION" ||
  fail "failed to create backup destination: $DESTINATION"

backup_database "$CERTIFICATES_STORAGE_ROOT" "certificates.sqlite" "certificates"
backup_database "$WAREHOUSE_STORAGE_ROOT" "warehouse.sqlite" "warehouse"
backup_database "$LOGISTICS_STORAGE_ROOT" "logistics.sqlite" "logistics"
backup_database "$ELECTIONS_STORAGE_ROOT" "elections.sqlite" "elections"
# Holds who may do what in the elections module. Restoring a campaign without it
# would come back with nobody able to write to it.
backup_database "$EMPLOYEES_STORAGE_ROOT" "employees.sqlite" "employees"

if [ -d "$CERTIFICATES_STORAGE_ROOT" ]; then
  ensure_readable_directory "$CERTIFICATES_STORAGE_ROOT" "certificates storage directory"
  backup_certificates_file "registry.json"
  backup_certificates_directory "photos"
  backup_certificates_directory "generated"
fi

if [ -d "$ELECTIONS_STORAGE_ROOT" ]; then
  ensure_readable_directory "$ELECTIONS_STORAGE_ROOT" "elections storage directory"
  backup_elections_file "workspace-area.geo.json"
  backup_elections_directory "attachments"
fi

if [ "$BACKED_UP" -eq 0 ]; then
  rmdir "$DESTINATION" 2>/dev/null || true
  fail "no runtime data was found under DATA_ROOT=$DATA_ROOT"
fi

# Encryption is opt-in and happens last, after every snapshot has already passed
# its integrity check: a corrupt backup must be caught as a corrupt backup, not
# as a decryption failure months later. With BACKUP_ENCRYPTION_KEY_FILE unset
# this whole block is skipped and the script behaves exactly as before, so
# turning it on cannot break an existing deployment.
if [ -n "${BACKUP_ENCRYPTION_KEY_FILE:-}" ]; then
  command -v node >/dev/null 2>&1 ||
    fail "BACKUP_ENCRYPTION_KEY_FILE is set but node is not available to encrypt with."

  CRYPTO_SCRIPT=$(dirname "$0")/backup-crypto.mjs

  [ -f "$CRYPTO_SCRIPT" ] ||
    fail "missing encryption helper: $CRYPTO_SCRIPT"

  # Validate the key before touching anything, so a bad key fails the run rather
  # than leaving half the directory encrypted.
  BACKUP_ROOT="$BACKUP_ROOT" DATA_ROOT="$DATA_ROOT" node "$CRYPTO_SCRIPT" check-key ||
    fail "the backup encryption key was rejected"

  find "$DESTINATION" -type f ! -name '*.enc' -print | while IFS= read -r plaintext; do
    BACKUP_ROOT="$BACKUP_ROOT" DATA_ROOT="$DATA_ROOT" \
      node "$CRYPTO_SCRIPT" encrypt "$plaintext" "$plaintext.enc" ||
      fail "failed to encrypt $plaintext"
    rm -f "$plaintext" || fail "failed to remove plaintext $plaintext"
    echo "Encrypted $(basename "$plaintext")"
  done

  # `find | while` runs the loop in a subshell, so a failure inside it cannot be
  # seen through $?. Check the result instead: any surviving plaintext means the
  # loop did not finish, and a backup that is half in the clear must not be
  # reported as a success.
  REMAINING=$(find "$DESTINATION" -type f ! -name '*.enc' | wc -l)

  [ "$REMAINING" -eq 0 ] ||
    fail "encryption did not complete: $REMAINING file(s) are still unencrypted in $DESTINATION"

  echo "Backup written to $DESTINATION (encrypted; restore with restore-db.sh)"
  exit 0
fi

echo "Backup written to $DESTINATION"
