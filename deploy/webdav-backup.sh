#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP_SCRIPT="${BACKUP_SCRIPT:-$SCRIPT_DIR/backup.sh}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
WEBDAV_REMOTE="${WEBDAV_REMOTE:-}"
WEBDAV_BACKUP_LOCK="${WEBDAV_BACKUP_LOCK:-/run/lock/timeblog-webdav-backup.lock}"
RCLONE_BIN="${RCLONE_BIN:-rclone}"
RCLONE_TRANSFERS="${RCLONE_TRANSFERS:-2}"
RCLONE_CHECKERS="${RCLONE_CHECKERS:-2}"
LOCAL_RETENTION_COUNT="${LOCAL_RETENTION_COUNT:-7}"
REMOTE_RETENTION_COUNT="${REMOTE_RETENTION_COUNT:-90}"
BACKUP_RETENTION_DRY_RUN="${BACKUP_RETENTION_DRY_RUN:-0}"
BACKUP_STAMP="${BACKUP_STAMP:-$(date -u +%Y%m%dT%H%M%SZ)}"

die() {
  printf 'webdav backup: %s\n' "$*" >&2
  exit 1
}

is_positive_integer() {
  [[ "$1" =~ ^[1-9][0-9]*$ ]] && ((10#$1 <= 32))
}

is_retention_count() {
  [[ "$1" =~ ^[1-9][0-9]*$ ]] && ((10#$1 >= 2 && 10#$1 <= 3650))
}

is_safe_remote() {
  local value="$1"
  [[ "$value" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*:.+ ]] || return 1
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || return 1
  [[ "/${value#*:}/" != */../* && "/${value#*:}/" != */./* ]]
}

[[ "$BACKUP_STAMP" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || die "BACKUP_STAMP must use YYYYMMDDTHHMMSSZ format"
[[ -x "$BACKUP_SCRIPT" && ! -L "$BACKUP_SCRIPT" ]] || die "BACKUP_SCRIPT must be an executable, non-symlink file"
is_safe_remote "$WEBDAV_REMOTE" || die "WEBDAV_REMOTE must use a safe rclone remote:path value"
is_positive_integer "$RCLONE_TRANSFERS" || die "RCLONE_TRANSFERS must be between 1 and 32"
is_positive_integer "$RCLONE_CHECKERS" || die "RCLONE_CHECKERS must be between 1 and 32"
is_retention_count "$LOCAL_RETENTION_COUNT" || die "LOCAL_RETENTION_COUNT must be between 2 and 3650"
is_retention_count "$REMOTE_RETENTION_COUNT" || die "REMOTE_RETENTION_COUNT must be between 2 and 3650"
LOCAL_RETENTION_COUNT=$((10#$LOCAL_RETENTION_COUNT))
REMOTE_RETENTION_COUNT=$((10#$REMOTE_RETENTION_COUNT))
((REMOTE_RETENTION_COUNT >= LOCAL_RETENTION_COUNT)) \
  || die "REMOTE_RETENTION_COUNT must be greater than or equal to LOCAL_RETENTION_COUNT"
[[ "$BACKUP_RETENTION_DRY_RUN" == 0 || "$BACKUP_RETENTION_DRY_RUN" == 1 ]] \
  || die "BACKUP_RETENTION_DRY_RUN must be 0 or 1"
command -v "$RCLONE_BIN" >/dev/null 2>&1 || die "rclone executable not found"

mkdir -p "$BACKUP_DIR"
BACKUP_DIR="$(cd "$BACKUP_DIR" && pwd)"
lock_dir="$(dirname "$WEBDAV_BACKUP_LOCK")"
mkdir -p "$lock_dir"
[[ ! -L "$WEBDAV_BACKUP_LOCK" ]] || die "lock file must not be a symlink"
exec {lock_fd}>"$WEBDAV_BACKUP_LOCK"
flock -n "$lock_fd" || die "another backup is already running"

BACKUP_DIR="$BACKUP_DIR" BACKUP_STAMP="$BACKUP_STAMP" "$BACKUP_SCRIPT"

artifacts=(
  "timeline.dump-$BACKUP_STAMP"
  "media.tar.gz-$BACKUP_STAMP"
  "exports.tar.gz-$BACKUP_STAMP"
  "SHA256SUMS-$BACKUP_STAMP"
  "manifest.json-$BACKUP_STAMP"
)
for artifact in "${artifacts[@]}"; do
  path="$BACKUP_DIR/$artifact"
  [[ -f "$path" && ! -L "$path" ]] || die "missing regular backup artifact: $artifact"
done

local_bytes=0
for artifact in "${artifacts[@]}"; do
  artifact_size="$(stat -c '%s' -- "$BACKUP_DIR/$artifact")"
  [[ "$artifact_size" =~ ^[0-9]+$ ]] || die "unable to determine artifact size: $artifact"
  ((local_bytes += artifact_size))
done

(
  cd "$BACKUP_DIR"
  sha256sum -c -- "SHA256SUMS-$BACKUP_STAMP"
)
tar -tzf "$BACKUP_DIR/media.tar.gz-$BACKUP_STAMP" >/dev/null
tar -tzf "$BACKUP_DIR/exports.tar.gz-$BACKUP_STAMP" >/dev/null
python3 - "$BACKUP_DIR/manifest.json-$BACKUP_STAMP" "$BACKUP_STAMP" <<'PY'
import json
import sys

manifest_path, stamp = sys.argv[1:]
with open(manifest_path, encoding="utf-8") as stream:
    manifest = json.load(stream)
expected = {
    "schemaVersion": 1,
    "createdAt": stamp,
    "database": f"timeline.dump-{stamp}",
    "media": f"media.tar.gz-{stamp}",
    "exports": f"exports.tar.gz-{stamp}",
    "checksums": f"SHA256SUMS-{stamp}",
}
for key, value in expected.items():
    if manifest.get(key) != value:
        raise SystemExit(f"manifest {key} does not match {stamp}")
PY

remote_root="${WEBDAV_REMOTE%/}"
remote_staging="$remote_root/.incomplete-$BACKUP_STAMP"
remote_snapshot="$remote_root/$BACKUP_STAMP"
rclone_transfer_flags=(
  --transfers "$RCLONE_TRANSFERS"
  --checkers "$RCLONE_CHECKERS"
  --retries 3
  --low-level-retries 10
  --log-level NOTICE
)

declare -a remote_successful_stamps=()
declare -A remote_successful_stamp_set=()

load_remote_successful_stamps() {
  local marker_output marker_path stamp

  marker_output="$("$RCLONE_BIN" lsf "$remote_root" \
    --recursive --files-only --max-depth 2 --include '*/_SUCCESS' \
    "${rclone_transfer_flags[@]}")"
  while IFS= read -r marker_path; do
    [[ -n "$marker_path" ]] || continue
    if [[ "$marker_path" =~ ^([0-9]{8}T[0-9]{6}Z)/_SUCCESS$ ]]; then
      remote_successful_stamps+=("${BASH_REMATCH[1]}")
    fi
  done <<< "$marker_output"

  if ((${#remote_successful_stamps[@]} > 1)); then
    mapfile -t remote_successful_stamps < <(
      printf '%s\n' "${remote_successful_stamps[@]}" | LC_ALL=C sort -u
    )
  fi
  for stamp in "${remote_successful_stamps[@]}"; do
    remote_successful_stamp_set["$stamp"]=1
  done
}

remote_snapshot_is_managed() {
  local stamp="$1"
  local actual_listing expected_listing

  expected_listing="$(printf '%s\n' \
    "SHA256SUMS-$stamp" \
    '_SUCCESS' \
    "exports.tar.gz-$stamp" \
    "manifest.json-$stamp" \
    "media.tar.gz-$stamp" \
    "timeline.dump-$stamp" | LC_ALL=C sort)"
  actual_listing="$("$RCLONE_BIN" lsf "$remote_root/$stamp" --max-depth 1 \
    "${rclone_transfer_flags[@]}" | LC_ALL=C sort)"
  [[ "$actual_listing" == "$expected_listing" ]]
}

local_snapshot_is_managed() {
  local stamp="$1" prefix path

  for prefix in timeline.dump media.tar.gz exports.tar.gz SHA256SUMS manifest.json; do
    path="$BACKUP_DIR/$prefix-$stamp"
    [[ -f "$path" && ! -L "$path" ]] || return 1
  done
}

prune_local_snapshots() {
  local manifest stamp remove_count index prefix
  local -a local_stamps=()
  local -a manifests=()

  shopt -s nullglob
  manifests=("$BACKUP_DIR"/manifest.json-*)
  shopt -u nullglob
  for manifest in "${manifests[@]}"; do
    stamp="${manifest##*/manifest.json-}"
    [[ "$stamp" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || continue
    local_snapshot_is_managed "$stamp" || continue
    local_stamps+=("$stamp")
  done
  if ((${#local_stamps[@]} > 1)); then
    mapfile -t local_stamps < <(printf '%s\n' "${local_stamps[@]}" | LC_ALL=C sort -u)
  fi

  remove_count=$((${#local_stamps[@]} - LOCAL_RETENTION_COUNT))
  ((remove_count > 0)) || return 0
  for ((index = 0; index < remove_count; index++)); do
    stamp="${local_stamps[$index]}"
    if [[ -z "${remote_successful_stamp_set[$stamp]+x}" ]] \
      || ! remote_snapshot_is_managed "$stamp"; then
      printf 'webdav backup: keeping local snapshot without a managed remote copy: %s\n' "$stamp" >&2
      continue
    fi
    if [[ "$BACKUP_RETENTION_DRY_RUN" == 1 ]]; then
      printf 'webdav backup: retention dry-run would remove local snapshot: %s\n' "$stamp"
      continue
    fi
    for prefix in timeline.dump media.tar.gz exports.tar.gz SHA256SUMS manifest.json; do
      rm -f -- "$BACKUP_DIR/$prefix-$stamp"
    done
    printf 'webdav backup: removed local snapshot beyond retention: %s\n' "$stamp"
  done
}

prune_remote_snapshots() {
  local remove_count index stamp name
  local -a remote_names=()

  remove_count=$((${#remote_successful_stamps[@]} - REMOTE_RETENTION_COUNT))
  ((remove_count > 0)) || return 0
  for ((index = 0; index < remove_count; index++)); do
    stamp="${remote_successful_stamps[$index]}"
    if ! remote_snapshot_is_managed "$stamp"; then
      printf 'webdav backup: keeping remote snapshot with unmanaged contents: %s\n' "$stamp" >&2
      continue
    fi
    if [[ "$BACKUP_RETENTION_DRY_RUN" == 1 ]]; then
      printf 'webdav backup: retention dry-run would remove remote snapshot: %s\n' "$stamp"
      continue
    fi
    remote_names=(
      '_SUCCESS'
      "timeline.dump-$stamp"
      "media.tar.gz-$stamp"
      "exports.tar.gz-$stamp"
      "SHA256SUMS-$stamp"
      "manifest.json-$stamp"
    )
    for name in "${remote_names[@]}"; do
      "$RCLONE_BIN" deletefile "$remote_root/$stamp/$name" "${rclone_transfer_flags[@]}"
    done
    "$RCLONE_BIN" rmdir "$remote_root/$stamp" "${rclone_transfer_flags[@]}"
    printf 'webdav backup: removed remote snapshot beyond retention: %s\n' "$stamp"
  done
}

printf 'webdav backup: uploading %s to %s\n' "$BACKUP_STAMP" "$remote_staging"
"$RCLONE_BIN" copy "$BACKUP_DIR" "$remote_staging" \
  --include "*-$BACKUP_STAMP" --immutable "${rclone_transfer_flags[@]}"
"$RCLONE_BIN" check "$BACKUP_DIR" "$remote_staging" \
  --include "*-$BACKUP_STAMP" --download --one-way "${rclone_transfer_flags[@]}"
"$RCLONE_BIN" moveto "$remote_staging" "$remote_snapshot" \
  --retries 3 --low-level-retries 10 --log-level NOTICE
remote_size_json="$("$RCLONE_BIN" size "$remote_snapshot" \
  --include "*-$BACKUP_STAMP" --json "${rclone_transfer_flags[@]}")"
python3 - "$remote_size_json" "$local_bytes" <<'PY'
import json
import sys

remote = json.loads(sys.argv[1])
expected_bytes = int(sys.argv[2])
if remote.get("count") != 5 or remote.get("bytes") != expected_bytes or remote.get("sizeless") != 0:
    raise SystemExit("published WebDAV snapshot size/count mismatch")
PY
"$RCLONE_BIN" touch "$remote_snapshot/_SUCCESS" \
  --retries 3 --low-level-retries 10 --log-level NOTICE

load_remote_successful_stamps
prune_local_snapshots
prune_remote_snapshots
printf 'webdav backup: retention evaluated: local_keep=%d remote_keep=%d dry_run=%s\n' \
  "$LOCAL_RETENTION_COUNT" "$REMOTE_RETENTION_COUNT" "$BACKUP_RETENTION_DRY_RUN"

printf 'webdav backup completed: stamp=%s local=%s remote=%s\n' "$BACKUP_STAMP" "$BACKUP_DIR" "$remote_snapshot"
