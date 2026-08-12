#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# Run this script on the NAS. The NAS account only reads the backup source
# through SSH/rsync; snapshot creation, verification, rename and retention
# all happen locally on the NAS.

# The settings page persists only non-secret pull policy. An operator exports
# that policy with `/app/api --export-nas-config` to a root-owned 0600 file;
# this script consumes the resulting fixed variables but never stores an SSH
# private key or evaluates arbitrary shell from the database.
if [[ -n "${NAS_CONFIG_FILE:-}" ]]; then
  [[ -f "$NAS_CONFIG_FILE" ]] || { printf 'nas backup pull: NAS_CONFIG_FILE not found\n' >&2; exit 1; }
  [[ ! -L "$NAS_CONFIG_FILE" ]] || { printf 'nas backup pull: NAS_CONFIG_FILE must not be a symlink\n' >&2; exit 1; }
  mode="$(stat -c '%a' -- "$NAS_CONFIG_FILE")"
  [[ "$mode" == "600" || "$mode" == "400" ]] || { printf 'nas backup pull: NAS_CONFIG_FILE permissions must be 0600 or 0400\n' >&2; exit 1; }
  declare -A loaded_config_keys=()
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" == \#* ]] && continue
    [[ "$line" == *=* ]] || { printf 'nas backup pull: malformed NAS_CONFIG_FILE line\n' >&2; exit 1; }
    key="${line%%=*}"
    value="${line#*=}"
    case "$key" in
      SOURCE_HOST|SOURCE_PATH|DEST_PATH|RETENTION_DAYS) ;;
      *) printf 'nas backup pull: unsupported NAS_CONFIG_FILE key\n' >&2; exit 1 ;;
    esac
    [[ -z "${loaded_config_keys[$key]+x}" ]] || { printf 'nas backup pull: duplicate NAS_CONFIG_FILE key\n' >&2; exit 1; }
    loaded_config_keys["$key"]=1
    printf -v "$key" '%s' "$value"
    export "$key"
  done < "$NAS_CONFIG_FILE"
fi

: "${SOURCE_HOST:?set SOURCE_HOST to the read-only backup host}"
: "${SOURCE_PATH:?set SOURCE_PATH to the source backup directory}"
: "${DEST_PATH:?set DEST_PATH to the NAS snapshot directory}"

RETENTION_DAYS="${RETENTION_DAYS:-90}"
STAMP="${STAMP:-}"

die() {
  printf 'nas backup pull: %s\n' "$*" >&2
  exit 1
}

is_safe_host() {
  [[ "$1" =~ ^[A-Za-z0-9._@:-]+$ ]]
}

is_safe_absolute_path() {
  local value="$1"
  [[ "$value" == /* ]] || return 1
  [[ "$value" =~ ^/[A-Za-z0-9._/-]+$ ]] || return 1
  [[ "$value" != *..* ]]
  case "$value" in
    */./*|*/.|/./*) return 1 ;;
  esac
}

is_safe_stamp() {
  [[ "$1" =~ ^[0-9]{8}T[0-9]{6}Z$ ]]
}

is_positive_integer() {
  [[ "$1" =~ ^[1-9][0-9]*$ ]] && ((10#$1 <= 3650))
}

is_safe_host "$SOURCE_HOST" || die "SOURCE_HOST contains unsupported characters"
is_safe_absolute_path "$SOURCE_PATH" || die "SOURCE_PATH must be an absolute path without shell metacharacters or '..'"
is_safe_absolute_path "$DEST_PATH" || die "DEST_PATH must be an absolute path without shell metacharacters or '..'"
is_positive_integer "$RETENTION_DAYS" || die "RETENTION_DAYS must be an integer from 1 through 3650"

SOURCE_PATH="${SOURCE_PATH%/}"
DEST_PATH="${DEST_PATH%/}"
[[ -n "$SOURCE_PATH" && -n "$DEST_PATH" ]] || die "source and destination paths cannot be filesystem root"

if [[ -n "$STAMP" ]]; then
  is_safe_stamp "$STAMP" || die "STAMP must use YYYYMMDDTHHMMSSZ format"
else
  # The source is queried read-only. Only the fixed checksum filename pattern
  # is considered; no source-provided command or path is evaluated.
  latest_checksum="$(ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -- "$SOURCE_HOST" "find -- '$SOURCE_PATH' -maxdepth 1 -type f -name 'SHA256SUMS-????????T??????Z' -printf '%f\\n' | sort | tail -n 1")"
  [[ "$latest_checksum" =~ ^SHA256SUMS-([0-9]{8}T[0-9]{6}Z)$ ]] || die "no timestamped SHA256SUMS file found on source"
  STAMP="${BASH_REMATCH[1]}"
fi

source_verify_command="cd -- '$SOURCE_PATH' && test -f 'SHA256SUMS-$STAMP' && test -f 'manifest.json-$STAMP' && sha256sum -c -- 'SHA256SUMS-$STAMP'"
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -- "$SOURCE_HOST" "$source_verify_command" || die "source checksum/manifest preflight failed for $STAMP"

mkdir -p -- "$DEST_PATH"
TMP_DIR=""
cleanup() {
  if [[ -n "$TMP_DIR" && -d "$TMP_DIR" ]]; then
    rm -rf -- "$TMP_DIR"
  fi
}
trap cleanup EXIT

DEST="$DEST_PATH/$STAMP"
[[ ! -e "$DEST" ]] || die "destination snapshot already exists: $DEST"
TMP_DIR="$(mktemp -d "$DEST_PATH/.timeline-${STAMP}.XXXXXX")"

for prefix in timeline.dump media.tar.gz exports.tar.gz SHA256SUMS manifest.json; do
  name="$prefix-$STAMP"
  rsync -aH --protect-args -e 'ssh -o BatchMode=yes -o StrictHostKeyChecking=yes' -- "$SOURCE_HOST:${SOURCE_PATH}/${name}" "$TMP_DIR/$name"
done

(
  cd -- "$TMP_DIR"
  sha256sum -c -- "SHA256SUMS-$STAMP"
)

python3 - "$TMP_DIR/manifest.json-$STAMP" "$STAMP" <<'PY'
import json
import sys

manifest_path, stamp = sys.argv[1:]
with open(manifest_path, encoding="utf-8") as stream:
    manifest = json.load(stream)
if manifest.get("schemaVersion") != 1:
    raise SystemExit("manifest schemaVersion must be 1")
expected = {
    "database": f"timeline.dump-{stamp}",
    "media": f"media.tar.gz-{stamp}",
    "exports": f"exports.tar.gz-{stamp}",
    "checksums": f"SHA256SUMS-{stamp}",
}
for key, value in expected.items():
    if manifest.get(key) != value:
        raise SystemExit(f"manifest {key} does not match {stamp}")
PY

for prefix in timeline.dump media.tar.gz exports.tar.gz SHA256SUMS manifest.json; do
  chmod 0600 -- "$TMP_DIR/$prefix-$STAMP"
done

mv -- "$TMP_DIR" "$DEST"
TMP_DIR=""

# Retain only directories created by this script. The strict timestamp check
# prevents an operator-created directory from being removed by retention.
for candidate in "$DEST_PATH"/*; do
  [[ -d "$candidate" ]] || continue
  snapshot="${candidate##*/}"
  [[ "$snapshot" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || continue
  if [[ -n "$(find -- "$candidate" -maxdepth 0 -type d -mtime +"$RETENTION_DAYS" -print -quit)" ]]; then
    rm -rf -- "$candidate"
  fi
done

printf 'NAS backup snapshot: %s\n' "$DEST"
