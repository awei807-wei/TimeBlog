# shellcheck shell=bash

# Security and state helpers for rotate-recovery-key.sh. This file is sourced
# only after the main script validates its type, ownership, mode, and inode.

log() {
  printf '[timeblog-recovery] %s\n' "$*"
}

fail() {
  printf '[timeblog-recovery] ERROR: %s\n' "$*" >&2
  exit 1
}

on_exit() {
  local status=$?
  trap - EXIT
  if (( status != 0 )); then
    printf '[timeblog-recovery] ERROR: 操作失败；不会自动回滚或恢复数据库。\n' >&2
    case "$ROTATION_STATE" in
      committed)
        printf '[timeblog-recovery] ERROR: 数据库轮换已提交；不要重复执行本脚本。\n' >&2
        if [[ -n "$CANDIDATE_OUTPUT_PATH" ]]; then
          printf '[timeblog-recovery] ERROR: 恢复密钥文件必须保留：%s\n' "$CANDIDATE_OUTPUT_PATH" >&2
        else
          printf '[timeblog-recovery] ERROR: 未获得通过安全校验的密钥文件，需人工核验数据库与受保护日志。\n' >&2
        fi
        ;;
      not-committed)
        printf '[timeblog-recovery] ERROR: 数据库核验确认本次轮换未提交；候选密钥不可用于恢复。\n' >&2
        if [[ -n "$CANDIDATE_OUTPUT_PATH" ]]; then
          printf '[timeblog-recovery] ERROR: 未激活的取证文件：%s\n' "$CANDIDATE_OUTPUT_PATH" >&2
        fi
        ;;
      unknown)
        printf '[timeblog-recovery] ERROR: 数据库提交状态未知；不要重复执行，先完成只读核验。\n' >&2
        if [[ -n "$CANDIDATE_OUTPUT_PATH" ]]; then
          printf '[timeblog-recovery] ERROR: 未确认的候选密钥文件必须保留：%s\n' "$CANDIDATE_OUTPUT_PATH" >&2
        fi
        ;;
    esac
    if [[ -n "$RUN_DIR" ]]; then
      printf '[timeblog-recovery] ERROR: 受保护的备份和诊断材料保留在 %s\n' "$RUN_DIR" >&2
    fi
  fi
  exit "$status"
}

validate_protected_directory() {
  local path="$1"
  local label="$2"

  [[ -d "$path" && ! -L "$path" ]] || fail "$label 不存在或不是安全的普通目录"
  [[ "$(stat -c '%a' "$path")" == 700 ]] || fail "$label 权限必须为 0700"
  [[ "$(stat -c '%u:%g' "$path")" == '0:0' ]] || fail "$label 必须归 root:root 所有"
}

validate_lock_target() {
  local path="$1"
  local label="$2"

  if [[ -e "$path" || -L "$path" ]]; then
    [[ -f "$path" && ! -L "$path" ]] || fail "$label 必须是普通文件且不能是符号链接"
    [[ "$(stat -c '%a' "$path")" == 600 ]] || fail "$label 权限必须为 0600"
    [[ "$(stat -c '%u:%g' "$path")" == '0:0' ]] || fail "$label 必须归 root:root 所有"
  fi
}

validate_lock_fd() {
  local fd="$1"
  local path="$2"
  local label="$3"
  local fd_identity
  local path_identity

  validate_lock_target "$path" "$label"
  fd_identity="$(stat -Lc '%d:%i' "/proc/$$/fd/$fd")"
  path_identity="$(stat -c '%d:%i' "$path")"
  [[ "$fd_identity" == "$path_identity" ]] || fail "$label 在打开时被替换"
}

validate_protected_env() {
  local path="$1"
  local label="$2"
  local mode
  local owner

  [[ -f "$path" && ! -L "$path" && -r "$path" ]] || fail "$label 不存在、不可读或不是普通文件"
  mode="$(stat -c '%a' "$path")"
  owner="$(stat -c '%u:%g' "$path")"
  [[ "$mode" == 600 ]] || fail "$label 权限必须为 0600"
  [[ "$owner" == '0:0' ]] || fail "$label 必须归 root:root 所有"
}

read_current_value() {
  local key="$1"
  local line
  local value=''
  local count=0

  while IFS= read -r line || [[ -n "$line" ]]; do
    case "$line" in
      ''|\#*) ;;
      "$key"=*)
        count=$((count + 1))
        value="${line#*=}"
        ;;
      CORE_IMAGE=*|WEB_IMAGE=*|RELEASE_SHA=*|RELEASE_TAG=*|RELEASE_CREATED_AT=*) ;;
      *) fail 'current.env 包含未识别字段' ;;
    esac
  done < "$CURRENT_ENV_FILE"

  [[ "$count" -eq 1 ]] || fail "current.env 必须且只能包含一个 $key"
  printf '%s' "$value"
}

compose() {
  docker compose \
    --env-file "$RUNTIME_ENV_FILE" \
    --env-file "$CURRENT_ENV_FILE" \
    -f "$COMPOSE_FILE" \
    "$@"
}

check_service() {
  local service="$1"
  local expected_image_id="${2:-}"
  local container_id
  local state
  local health
  local image_id

  container_id="$(compose ps -q "$service")"
  [[ -n "$container_id" ]] || fail "$service 容器不存在"
  state="$(docker inspect --format '{{.State.Status}}' "$container_id")"
  health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container_id")"
  [[ "$state" == running && "$health" == healthy ]] || fail "$service 容器未处于 healthy 运行状态"

  if [[ -n "$expected_image_id" ]]; then
    image_id="$(docker inspect --format '{{.Image}}' "$container_id")"
    [[ "$image_id" == "$expected_image_id" ]] || fail "$service 容器不是 current.env 指定的不可变镜像"
  fi
}

check_http() {
  local url="$1"
  curl --fail --silent --show-error --max-time 10 "$url" >/dev/null 2>&1 \
    || fail "HTTP 健康检查失败：$url"
}

verify_health() {
  check_service postgres
  check_service api "$CORE_IMAGE_ID"
  check_service worker "$CORE_IMAGE_ID"
  check_service web "$WEB_IMAGE_ID"
  check_http 'http://127.0.0.1:8080/health/live'
  check_http 'http://127.0.0.1:8080/health/ready'
  check_http 'http://127.0.0.1:3000/'
}

query_count() {
  local sql="$1"
  local value

  if ! value="$(compose exec -T postgres \
    psql -X --set ON_ERROR_STOP=1 --username timeline --dbname timeline \
    --tuples-only --no-align --command "$sql" 2>> "$OPERATION_LOG")"; then
    return 1
  fi
  [[ "$value" =~ ^[0-9]+$ ]] || return 1
  printf '%s' "$value"
}

require_query_count() {
  local sql="$1"
  local value

  if ! value="$(query_count "$sql")"; then
    fail '数据库只读核验失败或返回了非计数结果'
  fi
  printf '%s' "$value"
}

collect_candidate_output() {
  if [[ ! -e "$CONTAINER_OUTPUT_FILE" && ! -L "$CONTAINER_OUTPUT_FILE" ]]; then
    CANDIDATE_STATUS='absent'
    return 1
  fi
  if [[ -L "$CONTAINER_OUTPUT_FILE" || ! -f "$CONTAINER_OUTPUT_FILE" || ! -s "$CONTAINER_OUTPUT_FILE" ]]; then
    CANDIDATE_STATUS='unsafe'
    CANDIDATE_ERROR='轮换输出不是安全的非空普通文件'
    return 2
  fi
  if [[ "$(stat -c '%a' "$CONTAINER_OUTPUT_FILE")" != 600 ]]; then
    CANDIDATE_STATUS='unsafe'
    CANDIDATE_ERROR='轮换输出权限不是 0600'
    return 2
  fi
  if [[ "$(stat -c '%u:%g' "$CONTAINER_OUTPUT_FILE")" != '65532:65532' ]]; then
    CANDIDATE_STATUS='unsafe'
    CANDIDATE_ERROR='轮换输出不属于预期的容器 UID 65532'
    return 2
  fi
  if ! chown root:root "$CONTAINER_OUTPUT_FILE" || ! chmod 0600 "$CONTAINER_OUTPUT_FILE"; then
    CANDIDATE_STATUS='unsafe'
    CANDIDATE_ERROR='无法将轮换输出收归 root:root'
    return 2
  fi
  if [[ "$(stat -c '%u:%g' "$CONTAINER_OUTPUT_FILE")" != '0:0' ]]; then
    CANDIDATE_STATUS='unsafe'
    CANDIDATE_ERROR='轮换输出收归 root 后所有权校验失败'
    return 2
  fi
  if [[ -e "$CANDIDATE_OUTPUT_FILE" || -L "$CANDIDATE_OUTPUT_FILE" ]]; then
    CANDIDATE_STATUS='unsafe'
    CANDIDATE_ERROR='候选密钥目标路径已存在'
    return 2
  fi
  if ! mv -- "$CONTAINER_OUTPUT_FILE" "$CANDIDATE_OUTPUT_FILE"; then
    CANDIDATE_STATUS='unsafe'
    CANDIDATE_ERROR='无法收归候选密钥文件'
    return 2
  fi
  CANDIDATE_STATUS='adopted'
  CANDIDATE_OUTPUT_PATH="$CANDIDATE_OUTPUT_FILE"
  if ! rmdir -- "$CONTAINER_OUTPUT_DIR"; then
    CANDIDATE_ERROR='容器输出目录包含未识别材料'
    return 2
  fi
  return 0
}

move_candidate_to() {
  local destination="$1"

  [[ "$CANDIDATE_STATUS" == adopted && -f "$CANDIDATE_OUTPUT_PATH" && ! -L "$CANDIDATE_OUTPUT_PATH" ]] \
    || return 1
  [[ ! -e "$destination" && ! -L "$destination" ]] || return 1
  mv -- "$CANDIDATE_OUTPUT_PATH" "$destination" || return 1
  CANDIDATE_OUTPUT_PATH="$destination"
  [[ "$(stat -c '%a' "$destination")" == 600 ]] || return 1
  [[ "$(stat -c '%u:%g' "$destination")" == '0:0' ]] || return 1
}
