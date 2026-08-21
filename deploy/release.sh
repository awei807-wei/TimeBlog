#!/usr/bin/env bash
set -Eeuo pipefail

umask 077
IFS=$'\n\t'

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_FILE="$SCRIPT_DIR/$(basename -- "${BASH_SOURCE[0]}")"
PROJECT_DIR="${PROJECT_DIR:-$(cd -- "$SCRIPT_DIR/.." && pwd)}"
COMPOSE_FILE="${COMPOSE_FILE:-$PROJECT_DIR/deploy/compose.yaml}"
RUNTIME_ENV_FILE="${RUNTIME_ENV_FILE:-$PROJECT_DIR/deploy/.env}"
RELEASE_ENV_FILE="${RELEASE_ENV_FILE:-$PROJECT_DIR/deploy/.release.incoming.env}"
RELEASE_ENV_SHA256="${RELEASE_ENV_SHA256:-}"
SOURCE_ARCHIVE_FILE="${SOURCE_ARCHIVE_FILE:-}"
SOURCE_ARCHIVE_SHA256="${SOURCE_ARCHIVE_SHA256:-}"
RELEASE_SCRIPT_SHA256="${RELEASE_SCRIPT_SHA256:-}"
RELEASE_DIR="${RELEASE_DIR:-$PROJECT_DIR/deploy/releases}"
CURRENT_ENV_FILE="${CURRENT_ENV_FILE:-$RELEASE_DIR/current.env}"
PREVIOUS_ENV_FILE="${PREVIOUS_ENV_FILE:-$RELEASE_DIR/previous.env}"
LOCK_FILE="${LOCK_FILE:-$RELEASE_DIR/.lock}"
SOURCE_ACTIVATION_MARKER="${SOURCE_ACTIVATION_MARKER:-$RELEASE_DIR/source-activation.failed}"
MIN_FREE_KB="${MIN_FREE_KB:-5242880}"
HEALTH_TIMEOUT_SECONDS="${HEALTH_TIMEOUT_SECONDS:-180}"

DEPLOY_STARTED=0
RELEASE_SUCCEEDED=0
STAGING_DIR=''

log() {
  printf '[timeblog-release] %s\n' "$*"
}

fail() {
  printf '[timeblog-release] ERROR: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  rm -f -- "$RELEASE_ENV_FILE"
  if (( RELEASE_SUCCEEDED == 1 )) && [[ -n "$STAGING_DIR" ]]; then
    if ! rm -f -- "$SOURCE_ARCHIVE_FILE" "$SCRIPT_FILE" || ! rmdir -- "$STAGING_DIR"; then
      printf '[timeblog-release] WARNING: unable to remove completed staging directory %s\n' "$STAGING_DIR" >&2
    fi
  fi
}

validate_protected_directory() {
  local path="$1"
  local label="$2"

  [[ -d "$path" && ! -L "$path" ]] || fail "$label is missing or is not a safe directory"
  [[ "$(stat -c '%a' "$path")" == 700 ]] || fail "$label permissions must be 0700"
  [[ "$(stat -c '%u' "$path")" == "$(id -u)" ]] || fail "$label must be owned by the release user"
}

validate_protected_input() {
  local path="$1"
  local label="$2"
  local expected_sha256="${3:-}"
  local actual_sha256

  [[ -f "$path" && ! -L "$path" && -r "$path" ]] || fail "$label is missing, unreadable, or not a regular file"
  [[ "$(stat -c '%a' "$path")" == 600 ]] || fail "$label permissions must be 0600"
  [[ "$(stat -c '%u' "$path")" == "$(id -u)" ]] || fail "$label must be owned by the release user"
  if [[ -n "$expected_sha256" ]]; then
    [[ "$expected_sha256" =~ ^[0-9a-f]{64}$ ]] || fail "$label checksum is invalid"
    actual_sha256="$(sha256sum "$path" | awk '{print $1}')"
    [[ "$actual_sha256" == "$expected_sha256" ]] || fail "$label checksum does not match"
  fi
}

validate_lock_target() {
  local path="$1"

  [[ ! -L "$path" ]] || fail "release lock file must not be a symbolic link"
  if [[ -e "$path" || -L "$path" ]]; then
    [[ -f "$path" ]] || fail "release lock file must be a regular file"
    [[ "$(stat -c '%a' "$path")" == 600 ]] || fail "release lock file permissions must be 0600"
    [[ "$(stat -c '%u' "$path")" == "$(id -u)" ]] || fail "release lock file must be owned by the release user"
  fi
}

validate_lock_fd() {
  local fd_identity
  local path_identity

  validate_lock_target "$LOCK_FILE"
  fd_identity="$(stat -Lc '%d:%i' "/proc/$$/fd/9")"
  path_identity="$(stat -c '%d:%i' "$LOCK_FILE")"
  [[ "$fd_identity" == "$path_identity" ]] || fail "release lock file was replaced while opening"
}

validate_source_archive_entries() {
  local entry
  local saw_compose=0
  local saw_release=0

  while IFS= read -r entry || [[ -n "$entry" ]]; do
    [[ -n "$entry" ]] || fail "source archive contains an empty path"
    [[ "$entry" != '.' && "$entry" != '..' && "$entry" != /* && "$entry" != ../* \
      && "$entry" != */../* && "$entry" != *'/..' ]] \
      || fail "source archive contains an unsafe path"
    case "$entry" in
      deploy/.env|deploy/.env/*|deploy/releases|deploy/releases/*)
        fail "source archive contains protected runtime state"
        ;;
    esac
    [[ "$entry" == 'deploy/compose.yaml' ]] && saw_compose=1
    [[ "$entry" == 'deploy/release.sh' ]] && saw_release=1
  done < <(tar --list --file "$SOURCE_ARCHIVE_FILE")

  (( saw_compose == 1 )) || fail "source archive is missing deploy/compose.yaml"
  (( saw_release == 1 )) || fail "source archive is missing deploy/release.sh"
}

activate_source_archive() {
  [[ -n "$SOURCE_ARCHIVE_FILE" ]] || return 0

  if [[ -e "$SOURCE_ACTIVATION_MARKER" || -L "$SOURCE_ACTIVATION_MARKER" ]]; then
    validate_protected_input "$SOURCE_ACTIVATION_MARKER" "source activation marker"
  fi
  : > "$SOURCE_ACTIVATION_MARKER"
  chmod 0600 "$SOURCE_ACTIVATION_MARKER"
  sync -f "$SOURCE_ACTIVATION_MARKER"
  sync -f "$RELEASE_DIR"
  if ! tar --extract --file "$SOURCE_ARCHIVE_FILE" --directory "$PROJECT_DIR" --no-same-owner --no-overwrite-dir; then
    fail "source archive activation failed; recovery operations remain blocked by $SOURCE_ACTIVATION_MARKER"
  fi
  [[ -f "$COMPOSE_FILE" && ! -L "$COMPOSE_FILE" ]] || fail "activated compose file is invalid"
  [[ -f "$PROJECT_DIR/deploy/release.sh" && ! -L "$PROJECT_DIR/deploy/release.sh" ]] \
    || fail "activated release script is invalid"
  log "exact release source activated under the shared release lock"
}

atomic_copy() {
  local source="$1"
  local destination="$2"
  local temporary

  temporary="$(mktemp "${destination}.tmp.XXXXXX")"
  cp -- "$source" "$temporary"
  chmod 0600 "$temporary"
  sync -f "$temporary"
  mv -f -- "$temporary" "$destination"
  sync -f "$RELEASE_DIR"
}

read_release_value() {
  local key="$1"
  local value=''
  local count=0
  local line

  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" ]] && continue
    case "$line" in
      "$key"=*)
        count=$((count + 1))
        value="${line#*=}"
        ;;
      CORE_IMAGE=*|WEB_IMAGE=*|RELEASE_SHA=*|RELEASE_TAG=*|RELEASE_CREATED_AT=*)
        ;;
      \#*)
        ;;
      *)
        fail "release env contains an unexpected key"
        ;;
    esac
  done < "$RELEASE_ENV_FILE"

  if [[ "$count" -ne 1 ]]; then
    fail "release env must contain exactly one $key entry"
  fi
  printf '%s' "$value"
}

validate_release_env() {
  validate_protected_input "$RELEASE_ENV_FILE" "release env" "$RELEASE_ENV_SHA256"

  CORE_IMAGE="$(read_release_value CORE_IMAGE)"
  WEB_IMAGE="$(read_release_value WEB_IMAGE)"
  RELEASE_SHA="$(read_release_value RELEASE_SHA)"
  RELEASE_TAG="$(read_release_value RELEASE_TAG)"
  RELEASE_CREATED_AT="$(read_release_value RELEASE_CREATED_AT)"

  [[ "$CORE_IMAGE" =~ ^ghcr\.io/awei807-wei/timeblog-core@sha256:[0-9a-f]{64}$ ]] \
    || fail "CORE_IMAGE must be an immutable core image digest"
  [[ "$WEB_IMAGE" =~ ^ghcr\.io/awei807-wei/timeblog-web@sha256:[0-9a-f]{64}$ ]] \
    || fail "WEB_IMAGE must be an immutable web image digest"
  [[ "$RELEASE_SHA" =~ ^[0-9a-f]{40}$ ]] || fail "RELEASE_SHA is invalid"
  [[ "$RELEASE_TAG" =~ ^sha-[0-9a-f]{40}$ ]] || fail "RELEASE_TAG is invalid"
  [[ "$RELEASE_CREATED_AT" =~ ^[0-9TZ:+.-]+$ ]] || fail "RELEASE_CREATED_AT is invalid"
}

validate_staged_release_bundle() {
  local staging_name

  validate_release_env
  [[ -n "$SOURCE_ARCHIVE_FILE" ]] || return 0
  [[ -n "$SOURCE_ARCHIVE_SHA256" ]] || fail "source archive checksum is required"
  [[ -n "$RELEASE_ENV_SHA256" ]] || fail "release env checksum is required for a staged release"
  [[ -n "$RELEASE_SCRIPT_SHA256" ]] || fail "release script checksum is required for a staged release"
  [[ "$SOURCE_ARCHIVE_FILE" == /* && "$RELEASE_ENV_FILE" == /* && "$SCRIPT_FILE" == /* ]] \
    || fail "staged release inputs must use absolute paths"

  STAGING_DIR="$(dirname -- "$SOURCE_ARCHIVE_FILE")"
  staging_name="$(basename -- "$STAGING_DIR")"
  [[ "$(dirname -- "$STAGING_DIR")" == "$RELEASE_DIR" ]] \
    || fail "staging directory must be directly inside the release directory"
  [[ "$staging_name" =~ ^incoming-[0-9a-f]{40}-[0-9]+-[0-9]+$ ]] \
    || fail "staging directory name is invalid"
  [[ "$(dirname -- "$RELEASE_ENV_FILE")" == "$STAGING_DIR" && "$(dirname -- "$SCRIPT_FILE")" == "$STAGING_DIR" ]] \
    || fail "source archive, release env, and release script must share one staging directory"
  [[ "$(basename -- "$SOURCE_ARCHIVE_FILE")" == source.tar ]] || fail "staged source archive name is invalid"
  [[ "$(basename -- "$RELEASE_ENV_FILE")" == release.env ]] || fail "staged release env name is invalid"
  [[ "$(basename -- "$SCRIPT_FILE")" == release.sh ]] || fail "staged release script name is invalid"

  validate_protected_directory "$STAGING_DIR" "staging directory"
  validate_protected_input "$SOURCE_ARCHIVE_FILE" "source archive" "$SOURCE_ARCHIVE_SHA256"
  validate_protected_input "$RELEASE_ENV_FILE" "release env" "$RELEASE_ENV_SHA256"
  validate_protected_input "$SCRIPT_FILE" "release script" "$RELEASE_SCRIPT_SHA256"
  validate_source_archive_entries
}

validate_runtime_limits() {
  [[ "$MIN_FREE_KB" =~ ^[0-9]+$ ]] || fail "MIN_FREE_KB is invalid"
  [[ "$HEALTH_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]] || fail "HEALTH_TIMEOUT_SECONDS is invalid"
}

check_disk() {
  local free_kb
  free_kb="$(df -Pk "$PROJECT_DIR" | awk 'NR == 2 {print $4}')"
  [[ "$free_kb" =~ ^[0-9]+$ ]] || fail "unable to determine free disk space"
  (( free_kb >= MIN_FREE_KB )) || fail "insufficient disk space: ${free_kb} KiB free, ${MIN_FREE_KB} KiB required"
  log "disk preflight passed (${free_kb} KiB free)"
}

ACTIVE_RELEASE_ENV="$RELEASE_ENV_FILE"

compose_run() {
  local release_env="$1"
  shift
  docker compose --env-file "$RUNTIME_ENV_FILE" --env-file "$release_env" -f "$COMPOSE_FILE" "$@"
}

check_service_health() {
  local service="$1"
  local container_id
  local state
  local health

  container_id="$(compose_run "$ACTIVE_RELEASE_ENV" ps -q "$service")"
  [[ -n "$container_id" ]] || fail "$service container is not present"
  state="$(docker inspect --format '{{.State.Status}}' "$container_id")"
  health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container_id")"
  [[ "$state" == running ]] || fail "$service container state is $state"
  [[ "$health" == healthy ]] || fail "$service container health is $health"
}

check_http() {
  local url="$1"
  curl --fail --silent --show-error --max-time 10 "$url" >/dev/null \
    || fail "HTTP health check failed: $url"
}

verify_health() {
  check_service_health postgres
  check_service_health api
  check_service_health worker
  check_service_health web
  check_http http://127.0.0.1:8080/health/live
  check_http http://127.0.0.1:8080/health/ready
  check_http http://127.0.0.1:3000/
  log "container and HTTP health checks passed"
}

rollback() {
  local rollback_status=0

  if [[ ! -f "$PREVIOUS_ENV_FILE" ]]; then
    printf '[timeblog-release] rollback unavailable: previous.env is missing\n' >&2
    return 1
  fi

  log "rolling back to previous release"
  ACTIVE_RELEASE_ENV="$PREVIOUS_ENV_FILE"
  if ! compose_run "$PREVIOUS_ENV_FILE" up -d --no-build --wait --wait-timeout "$HEALTH_TIMEOUT_SECONDS" api worker web; then
    rollback_status=1
  fi

  if (( rollback_status == 0 )); then
    if ! (
      check_service_health postgres &&
      check_service_health api &&
      check_service_health worker &&
      check_service_health web &&
      check_http http://127.0.0.1:8080/health/live &&
      check_http http://127.0.0.1:8080/health/ready &&
      check_http http://127.0.0.1:3000/
    ); then
      rollback_status=1
    fi
  fi

  if (( rollback_status == 0 )); then
    log "rollback health checks passed"
  else
    printf '[timeblog-release] ERROR: rollback health checks failed\n' >&2
  fi
  return "$rollback_status"
}

on_exit() {
  local status=$?
  local rollback_status=0

  trap - EXIT
  if (( status != 0 && DEPLOY_STARTED == 1 )); then
    rollback || rollback_status=$?
    if (( rollback_status != 0 )); then
      printf '[timeblog-release] ERROR: deployment and rollback both failed\n' >&2
    fi
  fi
  cleanup
  exit "$status"
}

trap on_exit EXIT

for command_name in docker curl flock sha256sum stat tar awk sync; do
  command -v "$command_name" >/dev/null 2>&1 || fail "$command_name is not installed"
done

if [[ -e "$RELEASE_DIR" && ( ! -d "$RELEASE_DIR" || -L "$RELEASE_DIR" ) ]]; then
  fail "release directory is not a safe directory"
fi
mkdir -p -- "$RELEASE_DIR"
chmod 0700 "$RELEASE_DIR"
validate_protected_directory "$RELEASE_DIR" "release directory"
[[ "$(dirname -- "$CURRENT_ENV_FILE")" == "$RELEASE_DIR" ]] || fail "current release env must be inside the release directory"
[[ "$(dirname -- "$PREVIOUS_ENV_FILE")" == "$RELEASE_DIR" ]] || fail "previous release env must be inside the release directory"
[[ "$LOCK_FILE" == "$RELEASE_DIR/.lock" ]] || fail "release lock must use the shared release lock path"
[[ "$SOURCE_ACTIVATION_MARKER" == "$RELEASE_DIR/source-activation.failed" ]] \
  || fail "source activation marker must use the shared release marker path"
validate_lock_target "$LOCK_FILE"
exec 9>>"$LOCK_FILE"
chmod 0600 "/proc/$$/fd/9"
validate_lock_fd
flock -n 9 || fail "another release is already running"

validate_protected_input "$RUNTIME_ENV_FILE" "runtime env"
[[ ! -e "$CURRENT_ENV_FILE" && ! -L "$CURRENT_ENV_FILE" ]] \
  || validate_protected_input "$CURRENT_ENV_FILE" "current release env"
[[ ! -e "$PREVIOUS_ENV_FILE" && ! -L "$PREVIOUS_ENV_FILE" ]] \
  || validate_protected_input "$PREVIOUS_ENV_FILE" "previous release env"
validate_staged_release_bundle
validate_runtime_limits
check_disk
docker info >/dev/null 2>&1 || fail "docker daemon is unavailable"

activate_source_archive
[[ -f "$COMPOSE_FILE" && ! -L "$COMPOSE_FILE" ]] || fail "compose file is missing or unsafe: $COMPOSE_FILE"

if ! compose_run "$RELEASE_ENV_FILE" config --quiet; then
  fail "compose configuration validation failed"
fi
log "compose configuration passed"

compose_run "$RELEASE_ENV_FILE" up -d --wait --wait-timeout "$HEALTH_TIMEOUT_SECONDS" postgres
check_service_health postgres

compose_run "$RELEASE_ENV_FILE" pull api worker web
log "target images pulled"

if [[ -f "$CURRENT_ENV_FILE" ]]; then
  atomic_copy "$CURRENT_ENV_FILE" "$PREVIOUS_ENV_FILE"
  log "previous release recorded"
fi

DEPLOY_STARTED=1
compose_run "$RELEASE_ENV_FILE" up -d --no-build --wait --wait-timeout "$HEALTH_TIMEOUT_SECONDS" api worker web
verify_health

atomic_copy "$RELEASE_ENV_FILE" "$CURRENT_ENV_FILE"
rm -f -- "$SOURCE_ACTIVATION_MARKER"
sync -f "$RELEASE_DIR"
RELEASE_SUCCEEDED=1
log "release $RELEASE_SHA activated"
