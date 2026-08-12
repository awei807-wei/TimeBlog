#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="${COMPOSE_FILE:-$SCRIPT_DIR/compose.yaml}"
if [[ "$COMPOSE_FILE" != /* ]]; then
  COMPOSE_FILE="$(cd "$(dirname "$COMPOSE_FILE")" && pwd)/$(basename "$COMPOSE_FILE")"
fi
BACKUP_DIR="${BACKUP_DIR:-./backups}"
mkdir -p "$BACKUP_DIR"
BACKUP_DIR="$(cd "$BACKUP_DIR" && pwd)"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
tmp_dir="$(mktemp -d "$BACKUP_DIR/.timeline-$stamp.XXXXXX")"
cleanup() { rm -rf "$tmp_dir"; }
trap cleanup EXIT

: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}"
compose=(docker compose -f "$COMPOSE_FILE" --profile tools)
"${compose[@]}" config >/dev/null
"${compose[@]}" ps --status running postgres >/dev/null

# The archive is created through the Compose service so the actual project
# volume name is resolved by Compose rather than guessed from the directory.
"${compose[@]}" exec -T postgres pg_dump -U timeline -d timeline --format=custom --file=/tmp/timeline.dump
"${compose[@]}" cp postgres:/tmp/timeline.dump "$tmp_dir/timeline.dump"
"${compose[@]}" exec -T postgres rm -f /tmp/timeline.dump
"${compose[@]}" run --rm --no-deps volume-tools -c 'tar czf - -C /srv/timeline/media .' > "$tmp_dir/media.tar.gz"
"${compose[@]}" run --rm --no-deps volume-tools -c 'tar czf - -C /srv/timeline/exports .' > "$tmp_dir/exports.tar.gz"

(
  cd "$tmp_dir"
  mv timeline.dump "timeline.dump-$stamp"
  mv media.tar.gz "media.tar.gz-$stamp"
  mv exports.tar.gz "exports.tar.gz-$stamp"
  sha256sum "timeline.dump-$stamp" "media.tar.gz-$stamp" "exports.tar.gz-$stamp" > "SHA256SUMS-$stamp"
)
chmod 0600 "$tmp_dir"/*
for name in "timeline.dump-$stamp" "media.tar.gz-$stamp" "exports.tar.gz-$stamp"; do
  mv "$tmp_dir/$name" "$BACKUP_DIR/$name"
done
cat > "$tmp_dir/manifest.json" <<MANIFEST
{"schemaVersion":1,"createdAt":"$stamp","database":"timeline.dump-$stamp","media":"media.tar.gz-$stamp","exports":"exports.tar.gz-$stamp","checksums":"SHA256SUMS-$stamp"}
MANIFEST
mv "$tmp_dir/SHA256SUMS-$stamp" "$BACKUP_DIR/SHA256SUMS-$stamp"
mv "$tmp_dir/manifest.json" "$BACKUP_DIR/manifest.json-$stamp"
printf 'backup written to %s (database + media + exports)\n' "$BACKUP_DIR"
