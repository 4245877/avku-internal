#!/bin/bash
# Run only AFTER measuring a real complete archive.
set -euo pipefail
test "$(id -u)" = 0
test "$#" = 1
case "$1" in ''|*[!0-9]*) echo 'Expected measured artifact size in bytes' >&2; exit 1;; esac
test "$(findmnt -n -o SOURCE,FSTYPE,TARGET --target /srv/backup/avku-internal)" = 'backup/avku-internal zfs /srv/backup/avku-internal'
test "$1" -gt 0
test "$1" -le 17179869184
# Four transient artifacts at the receiver's 16 GiB limit fit with 64 GiB spare.
# A 128 GiB quota limits incoming abuse to this dataset, not the whole 825 GiB pool.
zfs set quota=128G backup/avku-internal
zfs get quota,used,available backup/avku-internal
