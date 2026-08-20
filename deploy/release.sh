#!/usr/bin/env bash
set -Eeuo pipefail

umask 077
IFS=$'\n\t'

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="${PROJECT_DIR:-$(cd -- "$SCRIPT_DIR/.." && pwd)}"
COMPOSE_FILE="${COMPOSE_FILE:-$PROJECT_DIR/deploy/compose.yaml}"
RUNTIME_ENV_FILE="${RUNTIME_ENV_FILE:-$PROJECT_DIR/deploy/.env}"
RELEASE_ENV_FILE="${RELEASE_ENV_FILE:-$PROJECT_DIR/deploy/.release.incoming.env}"
RELEASE_DIR="${RELEASE_DIR:-$PROJECT_DIR/deploy/releases}"
CURRENT_ENV_FILE="${CURRENT_ENV_FILE:-$RELEASE_DIR/current.env}"
PREVIOUS_ENV_FILE="${PREVIOUS_ENV_FILE:-$RELEASE_DIR/previous.env}"
LOCK_FILE="${LOCK_FILE:-$RELEASE_DIR/.lock}"
MIN_FREE_KB="${MIN_FREE_KB:-5242880}"
HEALTH_TIMEOUT_SECONDS="${HEALTH_TIMEOUT_SECONDS:-180}"

DEPLOY_STARTED=0

log() {
  printf '[timeblog-release] %s\n' "$*"
}

fail() {
  printf '[timeblog-release] ERROR: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  rm -f -- "$RELEASE_ENV_FILE"
}

atomic_copy() {
  local source="$1"
  local destination="$2"
  local temporary

  temporary="$(mktemp "${destination}.tmp.XXXXXX")"
  cp -- "$source" "$temporary"
  chmod 0600 "$temporary"
  mv -f -- "$temporary" "$destination"
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
  [[ -f "$RELEASE_ENV_FILE" ]] || fail "release env is missing: $RELEASE_ENV_FILE"
  [[ -r "$RELEASE_ENV_FILE" ]] || fail "release env is not readable"

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

mkdir -p -- "$RELEASE_DIR"
chmod 0700 "$RELEASE_DIR"
exec 9>"$LOCK_FILE"
flock -n 9 || fail "another release is already running"

[[ -f "$RUNTIME_ENV_FILE" ]] || fail "runtime env is missing: $RUNTIME_ENV_FILE"
[[ -f "$COMPOSE_FILE" ]] || fail "compose file is missing: $COMPOSE_FILE"
command -v docker >/dev/null 2>&1 || fail "docker is not installed"
command -v curl >/dev/null 2>&1 || fail "curl is not installed"
command -v flock >/dev/null 2>&1 || fail "flock is not installed"

validate_release_env
validate_runtime_limits
check_disk
docker info >/dev/null 2>&1 || fail "docker daemon is unavailable"

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
log "release $RELEASE_SHA activated"
