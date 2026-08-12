#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="${COMPOSE_FILE:-$SCRIPT_DIR/compose.yaml}"
if [[ "$COMPOSE_FILE" != /* ]]; then
  COMPOSE_FILE="$(cd "$(dirname "$COMPOSE_FILE")" && pwd)/$(basename "$COMPOSE_FILE")"
fi
BACKUP_DIR="${BACKUP_DIR:-./backups}"
BACKUP_STAMP="${BACKUP_STAMP:-}"
if [[ "${1:-}" != "--confirm" ]]; then
  echo "Restore is destructive. Re-run with --confirm and BACKUP_STAMP=..." >&2
  exit 2
fi
: "${BACKUP_STAMP:?BACKUP_STAMP is required}"
BACKUP_DIR="$(cd "$BACKUP_DIR" && pwd)"
for name in timeline.dump media.tar.gz exports.tar.gz SHA256SUMS manifest.json; do
  test -f "$BACKUP_DIR/$name-$BACKUP_STAMP"
done
(
  cd "$BACKUP_DIR"
  sha256sum -c "SHA256SUMS-$BACKUP_STAMP"
)
python3 - "$BACKUP_DIR/manifest.json-$BACKUP_STAMP" <<'PY'
import json, sys
m=json.load(open(sys.argv[1]))
assert m.get('schemaVersion') == 1
stamp=sys.argv[1].rsplit('manifest.json-', 1)[-1]
assert m.get('database') == f'timeline.dump-{stamp}'
assert m.get('media') == f'media.tar.gz-{stamp}'
assert m.get('exports') == f'exports.tar.gz-{stamp}'
assert m.get('checksums') == f'SHA256SUMS-{stamp}'
PY
compose=(docker compose -f "$COMPOSE_FILE" --profile tools)
"${compose[@]}" config >/dev/null
was_running=0
if "${compose[@]}" ps --status running api worker >/dev/null 2>&1; then was_running=1; fi
restart() { if [[ "$was_running" == 1 ]]; then "${compose[@]}" up -d api worker >/dev/null; fi; }
trap restart EXIT
"${compose[@]}" stop api worker
"${compose[@]}" up -d --wait postgres
cat "$BACKUP_DIR/timeline.dump-$BACKUP_STAMP" | "${compose[@]}" exec -T postgres pg_restore -U timeline -d timeline --clean --if-exists --exit-on-error --single-transaction
cat "$BACKUP_DIR/media.tar.gz-$BACKUP_STAMP" | "${compose[@]}" run --rm --no-deps -T volume-tools -c 'find /srv/timeline/media -mindepth 1 -delete && tar xzf - -C /srv/timeline/media'
cat "$BACKUP_DIR/exports.tar.gz-$BACKUP_STAMP" | "${compose[@]}" run --rm --no-deps -T volume-tools -c 'find /srv/timeline/exports -mindepth 1 -delete && tar xzf - -C /srv/timeline/exports'
"${compose[@]}" up -d --wait api worker
trap - EXIT
printf 'restore completed from %s\n' "$BACKUP_STAMP"
