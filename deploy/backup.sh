#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="${COMPOSE_FILE:-$SCRIPT_DIR/compose.yaml}"
if [[ "$COMPOSE_FILE" != /* ]]; then
  COMPOSE_FILE="$(cd "$(dirname "$COMPOSE_FILE")" && pwd)/$(basename "$COMPOSE_FILE")"
fi
COMPOSE_ENV_FILE="${COMPOSE_ENV_FILE:-}"
if [[ -n "$COMPOSE_ENV_FILE" ]]; then
  [[ -f "$COMPOSE_ENV_FILE" && ! -L "$COMPOSE_ENV_FILE" ]] || {
    printf 'COMPOSE_ENV_FILE must be a regular, non-symlink file\n' >&2
    exit 2
  }
  if [[ "$COMPOSE_ENV_FILE" != /* ]]; then
    COMPOSE_ENV_FILE="$(cd "$(dirname "$COMPOSE_ENV_FILE")" && pwd)/$(basename "$COMPOSE_ENV_FILE")"
  fi
fi
BACKUP_DIR="${BACKUP_DIR:-./backups}"
mkdir -p "$BACKUP_DIR"
BACKUP_DIR="$(cd "$BACKUP_DIR" && pwd)"
BACKUP_STAMP="${BACKUP_STAMP:-$(date -u +%Y%m%dT%H%M%SZ)}"
[[ "$BACKUP_STAMP" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || {
  printf 'BACKUP_STAMP must use YYYYMMDDTHHMMSSZ format\n' >&2
  exit 2
}
stamp="$BACKUP_STAMP"

for name in timeline.dump media.tar.gz exports.tar.gz SHA256SUMS manifest.json; do
  [[ ! -e "$BACKUP_DIR/$name-$stamp" ]] || {
    printf 'backup artifact already exists: %s\n' "$BACKUP_DIR/$name-$stamp" >&2
    exit 2
  }
done

tmp_dir="$(mktemp -d "$BACKUP_DIR/.timeline-$stamp.XXXXXX")"
container_dump=""
compose=()
cleanup() {
  status=$?
  if [[ -n "$container_dump" && ${#compose[@]} -gt 0 ]]; then
    "${compose[@]}" exec -T postgres rm -f -- "$container_dump" >/dev/null 2>&1 || true
  fi
  if [[ -n "$tmp_dir" && -d "$tmp_dir" ]]; then
    rm -rf -- "$tmp_dir"
  fi
  return "$status"
}
trap cleanup EXIT

compose=(docker compose)
if [[ -n "$COMPOSE_ENV_FILE" ]]; then
  compose+=(--env-file "$COMPOSE_ENV_FILE")
fi
compose+=(-f "$COMPOSE_FILE" --profile tools)
"${compose[@]}" config >/dev/null
"${compose[@]}" ps --status running postgres >/dev/null

# The archive is created through the Compose service so the actual project
# volume name is resolved by Compose rather than guessed from the directory.
container_dump="/tmp/timeline-$stamp.dump"
"${compose[@]}" exec -T postgres pg_dump -U timeline -d timeline --format=custom --file="$container_dump"
"${compose[@]}" exec -T postgres pg_restore --list "$container_dump" >/dev/null
"${compose[@]}" cp "postgres:$container_dump" "$tmp_dir/timeline.dump"
"${compose[@]}" exec -T postgres rm -f -- "$container_dump"
container_dump=""
"${compose[@]}" run --rm --no-deps volume-tools -c 'tar czf - -C /srv/timeline/media .' > "$tmp_dir/media.tar.gz"
"${compose[@]}" run --rm --no-deps volume-tools -c 'tar czf - -C /srv/timeline/exports .' > "$tmp_dir/exports.tar.gz"

(
  cd "$tmp_dir"
  mv timeline.dump "timeline.dump-$stamp"
  mv media.tar.gz "media.tar.gz-$stamp"
  mv exports.tar.gz "exports.tar.gz-$stamp"
)
cat > "$tmp_dir/manifest.json" <<MANIFEST
{"schemaVersion":1,"createdAt":"$stamp","database":"timeline.dump-$stamp","media":"media.tar.gz-$stamp","exports":"exports.tar.gz-$stamp","checksums":"SHA256SUMS-$stamp"}
MANIFEST
mv "$tmp_dir/manifest.json" "$tmp_dir/manifest.json-$stamp"
(
  cd "$tmp_dir"
  sha256sum "timeline.dump-$stamp" "media.tar.gz-$stamp" "exports.tar.gz-$stamp" "manifest.json-$stamp" > "SHA256SUMS-$stamp"
)
chmod 0600 "$tmp_dir"/*
for name in "timeline.dump-$stamp" "media.tar.gz-$stamp" "exports.tar.gz-$stamp" "SHA256SUMS-$stamp" "manifest.json-$stamp"; do
  mv "$tmp_dir/$name" "$BACKUP_DIR/$name"
done
rmdir "$tmp_dir"
tmp_dir=""
trap - EXIT
printf 'backup written to %s (stamp: %s; database + media + exports)\n' "$BACKUP_DIR" "$stamp"
