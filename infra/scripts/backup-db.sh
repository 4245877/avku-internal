#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)

STORAGE_ROOT=${CERTIFICATES_STORAGE_ROOT:-"$REPO_ROOT/storage/certificates"}
BACKUP_ROOT=${BACKUP_ROOT:-"$REPO_ROOT/storage/backups"}
TIMESTAMP=$(date -u +"%Y%m%dT%H%M%SZ")
DESTINATION="$BACKUP_ROOT/certificates-$TIMESTAMP"
DATABASE_PATH="$STORAGE_ROOT/certificates.sqlite"

mkdir -p "$DESTINATION"

if [ -f "$DATABASE_PATH" ]; then
  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "$DATABASE_PATH" ".backup '$DESTINATION/certificates.sqlite'"
  else
    cp -p "$DATABASE_PATH" "$DESTINATION/certificates.sqlite"
    [ -f "$DATABASE_PATH-wal" ] && cp -p "$DATABASE_PATH-wal" "$DESTINATION/certificates.sqlite-wal"
    [ -f "$DATABASE_PATH-shm" ] && cp -p "$DATABASE_PATH-shm" "$DESTINATION/certificates.sqlite-shm"
  fi
fi

if [ -f "$STORAGE_ROOT/registry.json" ]; then
  cp -p "$STORAGE_ROOT/registry.json" "$DESTINATION/registry.json"
fi

for directory in photos generated; do
  if [ -d "$STORAGE_ROOT/$directory" ]; then
    tar -czf "$DESTINATION/$directory.tar.gz" -C "$STORAGE_ROOT" "$directory"
  fi
done

echo "Backup written to $DESTINATION"
