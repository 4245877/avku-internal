#!/usr/bin/env sh
# Run the complete API suite with its fonts, immutable recovery resources and
# cross-app layout fixtures. Never mount production data or environment files.
set -eu

AVKU_CHECK_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
AVKU_CHECK_IMAGE=${AVKU_TEST_IMAGE:-avku-internal-api-tests:local}

docker build --target backup-worker --build-arg AVKU_RELEASE_ID=api-check \
  -f "$AVKU_CHECK_ROOT/apps/api/Dockerfile" -t "$AVKU_CHECK_IMAGE" "$AVKU_CHECK_ROOT"
docker run --rm --network none --entrypoint sh \
  -v "$AVKU_CHECK_ROOT/infra:/app/infra:ro" \
  -v "$AVKU_CHECK_ROOT/design:/app/design:ro" \
  -v "$AVKU_CHECK_ROOT/apps/web/src/assets:/app/apps/web/src/assets:ro" \
  "$AVKU_CHECK_IMAGE" \
  -c 'node node_modules/typescript/bin/tsc --noEmit && node --import tsx --test "src/**/*.test.ts"'
