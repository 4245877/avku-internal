#!/bin/sh
set -e

# Make the data volume writable by the unprivileged `node` user. The bind-mounted
# host directory can be owned by root (created by Docker, or by an earlier
# root-running version of this container), so fix ownership here while we still
# have root, then drop privileges for the long-running server process.
if [ -n "${DATA_ROOT}" ] && [ -d "${DATA_ROOT}" ]; then
  chown -R node:node "${DATA_ROOT}" 2>/dev/null || true
fi

umask 027
exec gosu node "$@"
