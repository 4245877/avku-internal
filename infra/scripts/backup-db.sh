#!/usr/bin/env sh
set -eu

DATA_ROOT=${DATA_ROOT:-/var/lib/avku-internal/data}
BACKUP_ROOT=${BACKUP_ROOT:-/var/backups/avku-internal}
TIMESTAMP=$(date -u +"%Y%m%dT%H%M%SZ")
DESTINATION="$BACKUP_ROOT/$TIMESTAMP"

CERTIFICATES_STORAGE_ROOT=${CERTIFICATES_STORAGE_ROOT:-"$DATA_ROOT/certificates"}
WAREHOUSE_STORAGE_ROOT=${WAREHOUSE_STORAGE_ROOT:-"$DATA_ROOT/warehouse"}
LOGISTICS_STORAGE_ROOT=${LOGISTICS_STORAGE_ROOT:-"$DATA_ROOT/logistics"}

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

  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "$database_path" ".backup '$target_path'" ||
      fail "sqlite3 backup failed for $database_path"
  else
    warn "sqlite3 is not installed; copying $database_path with WAL/SHM sidecars. Stop the API first for a consistent backup."
    copy_file "$database_path" "$target_path"
    [ -f "$database_path-wal" ] && copy_file "$database_path-wal" "$target_path-wal"
    [ -f "$database_path-shm" ] && copy_file "$database_path-shm" "$target_path-shm"
  fi

  BACKED_UP=1
  echo "Backed up $database_path"
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

if [ -d "$CERTIFICATES_STORAGE_ROOT" ]; then
  ensure_readable_directory "$CERTIFICATES_STORAGE_ROOT" "certificates storage directory"
  backup_certificates_file "registry.json"
  backup_certificates_directory "photos"
  backup_certificates_directory "generated"
fi

if [ "$BACKED_UP" -eq 0 ]; then
  rmdir "$DESTINATION" 2>/dev/null || true
  fail "no runtime data was found under DATA_ROOT=$DATA_ROOT"
fi

echo "Backup written to $DESTINATION"
