#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)

DATA_ROOT=${DATA_ROOT:-"$REPO_ROOT/storage"}
BACKUP_ROOT=${BACKUP_ROOT:-"$REPO_ROOT/storage/backups"}
TIMESTAMP=$(date -u +"%Y%m%dT%H%M%SZ")
DESTINATION="$BACKUP_ROOT/$TIMESTAMP"

CERTIFICATES_STORAGE_ROOT=${CERTIFICATES_STORAGE_ROOT:-"$DATA_ROOT/certificates"}
WAREHOUSE_STORAGE_ROOT=${WAREHOUSE_STORAGE_ROOT:-"$DATA_ROOT/warehouse"}
LOGISTICS_STORAGE_ROOT=${LOGISTICS_STORAGE_ROOT:-"$DATA_ROOT/logistics"}

mkdir -p "$DESTINATION"

backup_database() {
  storage_root=$1
  file_name=$2
  database_path="$storage_root/$file_name"

  if [ ! -f "$database_path" ]; then
    return 0
  fi

  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "$database_path" ".backup '$DESTINATION/$file_name'"
  else
    cp -p "$database_path" "$DESTINATION/$file_name"
    [ -f "$database_path-wal" ] && cp -p "$database_path-wal" "$DESTINATION/$file_name-wal"
    [ -f "$database_path-shm" ] && cp -p "$database_path-shm" "$DESTINATION/$file_name-shm"
  fi

  echo "Backed up $database_path"
}

backup_database "$CERTIFICATES_STORAGE_ROOT" "certificates.sqlite"
backup_database "$WAREHOUSE_STORAGE_ROOT" "warehouse.sqlite"
backup_database "$LOGISTICS_STORAGE_ROOT" "logistics.sqlite"

# Certificate assets and legacy registry.
if [ -f "$CERTIFICATES_STORAGE_ROOT/registry.json" ]; then
  cp -p "$CERTIFICATES_STORAGE_ROOT/registry.json" "$DESTINATION/registry.json"
fi

for directory in photos generated; do
  if [ -d "$CERTIFICATES_STORAGE_ROOT/$directory" ]; then
    tar -czf "$DESTINATION/$directory.tar.gz" -C "$CERTIFICATES_STORAGE_ROOT" "$directory"
  fi
done

echo "Backup written to $DESTINATION"
