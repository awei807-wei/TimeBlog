#!/usr/bin/env bash
set -Eeuo pipefail

umask 077
IFS=$'\n\t'

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="${PROJECT_DIR:-$(cd -- "$SCRIPT_DIR/.." && pwd)}"
COMPOSE_FILE="${COMPOSE_FILE:-$PROJECT_DIR/deploy/compose.yaml}"
RUNTIME_ENV_FILE="${RUNTIME_ENV_FILE:-$PROJECT_DIR/deploy/.env}"
CURRENT_ENV_FILE="${CURRENT_ENV_FILE:-$PROJECT_DIR/deploy/releases/current.env}"
RECOVERY_RUN_ROOT="${RECOVERY_RUN_ROOT:-/var/lib/timeblog/account-recovery}"
LOCK_FILE="${LOCK_FILE:-$RECOVERY_RUN_ROOT/.rotate.lock}"
RELEASE_LOCK_FILE="${RELEASE_LOCK_FILE:-$(dirname -- "$CURRENT_ENV_FILE")/.lock}"
SOURCE_ACTIVATION_FAILURE_FILE="${SOURCE_ACTIVATION_FAILURE_FILE:-$(dirname -- "$CURRENT_ENV_FILE")/source-activation.failed}"

RUN_DIR=''
ROTATION_STATE='not-started'
CANDIDATE_STATUS='absent'
CANDIDATE_OUTPUT_PATH=''
CANDIDATE_ERROR=''
RECOVERY_LIBRARY_FILE="$SCRIPT_DIR/rotate-recovery-key-lib.sh"

bootstrap_fail() {
  printf '[timeblog-recovery] ERROR: %s\n' "$*" >&2
  exit 1
}

command -v stat >/dev/null 2>&1 || bootstrap_fail '缺少命令：stat'
[[ -f "$RECOVERY_LIBRARY_FILE" && ! -L "$RECOVERY_LIBRARY_FILE" && -r "$RECOVERY_LIBRARY_FILE" ]] \
  || bootstrap_fail '恢复安全辅助库缺失、不可读、不是普通文件或为符号链接'
exec 7<"$RECOVERY_LIBRARY_FILE"
[[ -f "$RECOVERY_LIBRARY_FILE" && ! -L "$RECOVERY_LIBRARY_FILE" ]] \
  || bootstrap_fail '恢复安全辅助库在打开时被替换'
LIBRARY_PATH_ID="$(stat -c '%d:%i' "$RECOVERY_LIBRARY_FILE")"
LIBRARY_FD_ID="$(stat -Lc '%d:%i' "/proc/$$/fd/7")"
[[ "$LIBRARY_PATH_ID" == "$LIBRARY_FD_ID" ]] || bootstrap_fail '恢复安全辅助库在打开时被替换'
[[ "$(stat -Lc '%u:%g' "/proc/$$/fd/7")" == '0:0' ]] \
  || bootstrap_fail '恢复安全辅助库必须归 root:root 所有'
LIBRARY_MODE="$(stat -Lc '%a' "/proc/$$/fd/7")"
[[ "$LIBRARY_MODE" =~ ^[0-7][0145][0145]$ ]] \
  || bootstrap_fail '恢复安全辅助库不能包含特殊权限，也不能由 group/other 写入'
source "/proc/$$/fd/7"
exec 7<&-
unset LIBRARY_PATH_ID LIBRARY_FD_ID LIBRARY_MODE
unset -f bootstrap_fail

usage() {
  cat <<'USAGE'
Usage: sudo ./deploy/rotate-recovery-key.sh --confirm

Creates a protected database backup and rotates the account recovery key by
running the currently deployed immutable core image. The secret is written to
a root-only file and is never printed by this script.
USAGE
}

trap on_exit EXIT

if [[ "${1:-}" == '--help' && "$#" -eq 1 ]]; then
  usage
  exit 0
fi
if [[ "$#" -ne 1 || "$1" != '--confirm' ]]; then
  printf '[timeblog-recovery] 拒绝执行：必须显式传入 --confirm。\n' >&2
  usage >&2
  exit 2
fi

[[ "$(id -u)" == 0 ]] || fail '必须以 root 身份运行'

for command_name in docker curl flock stat mktemp head chown sha256sum; do
  command -v "$command_name" >/dev/null 2>&1 || fail "缺少命令：$command_name"
done

[[ -f "$COMPOSE_FILE" ]] || fail 'Compose 文件不存在'
RELEASE_STATE_DIR="$(dirname -- "$CURRENT_ENV_FILE")"
validate_protected_directory "$RELEASE_STATE_DIR" '发布状态目录'
validate_protected_env "$RUNTIME_ENV_FILE" 'deploy/.env'
validate_protected_env "$CURRENT_ENV_FILE" 'deploy/releases/current.env'

[[ "$RECOVERY_RUN_ROOT" == /* && "$RECOVERY_RUN_ROOT" != / ]] || fail '恢复运行根目录必须是绝对路径且不能为根目录'
if [[ ! -e "$RECOVERY_RUN_ROOT" && ! -L "$RECOVERY_RUN_ROOT" ]]; then
  mkdir -p -- "$RECOVERY_RUN_ROOT"
  chmod 0700 "$RECOVERY_RUN_ROOT"
  chown root:root "$RECOVERY_RUN_ROOT"
fi
validate_protected_directory "$RECOVERY_RUN_ROOT" '恢复运行根目录'
[[ "$(dirname -- "$LOCK_FILE")" == "$RECOVERY_RUN_ROOT" ]] || fail '恢复锁文件必须直接位于恢复运行根目录'

validate_lock_target "$LOCK_FILE" '恢复锁文件'
exec 9>>"$LOCK_FILE"
chmod 0600 "$LOCK_FILE"
validate_lock_fd 9 "$LOCK_FILE" '恢复锁文件'
flock -n 9 || fail '已有恢复密钥轮换正在运行'
[[ "$(dirname -- "$RELEASE_LOCK_FILE")" == "$RELEASE_STATE_DIR" ]] || fail '发布锁文件必须直接位于发布状态目录'
validate_lock_target "$RELEASE_LOCK_FILE" '发布锁文件'
exec 8>>"$RELEASE_LOCK_FILE"
chmod 0600 "$RELEASE_LOCK_FILE"
validate_lock_fd 8 "$RELEASE_LOCK_FILE" '发布锁文件'
flock -n 8 || fail '当前有发布任务正在运行'
[[ "$(dirname -- "$SOURCE_ACTIVATION_FAILURE_FILE")" == "$RELEASE_STATE_DIR" ]] \
  || fail '源码激活失败标记必须直接位于发布状态目录'
if [[ -e "$SOURCE_ACTIVATION_FAILURE_FILE" || -L "$SOURCE_ACTIVATION_FAILURE_FILE" ]]; then
  fail '检测到未完成的源码激活标记，拒绝在混合发布状态下轮换'
fi

CORE_IMAGE="$(read_current_value CORE_IMAGE)"
WEB_IMAGE="$(read_current_value WEB_IMAGE)"
[[ "$CORE_IMAGE" =~ ^ghcr\.io/awei807-wei/timeblog-core@sha256:[0-9a-f]{64}$ ]] \
  || fail 'current.env 的 CORE_IMAGE 不是受信的不可变 digest'
[[ "$WEB_IMAGE" =~ ^ghcr\.io/awei807-wei/timeblog-web@sha256:[0-9a-f]{64}$ ]] \
  || fail 'current.env 的 WEB_IMAGE 不是受信的不可变 digest'

docker info >/dev/null 2>&1 || fail 'Docker daemon 不可用'
compose config --quiet >/dev/null 2>&1 || fail 'Compose 配置校验失败'

CORE_IMAGE_ID="$(docker image inspect --format '{{.Id}}' "$CORE_IMAGE" 2>/dev/null)" \
  || fail '当前 core digest 镜像在本机不存在'
WEB_IMAGE_ID="$(docker image inspect --format '{{.Id}}' "$WEB_IMAGE" 2>/dev/null)" \
  || fail '当前 web digest 镜像在本机不存在'

verify_health
log '当前不可变发布和健康状态预检通过'

RUN_DIR="$(mktemp -d "$RECOVERY_RUN_ROOT/run-$(date -u +%Y%m%dT%H%M%SZ).XXXXXX")"
chmod 0700 "$RUN_DIR"
chown root:root "$RUN_DIR"
[[ "$(stat -c '%a' "$RUN_DIR")" == 700 ]] || fail '运行目录权限必须为 0700'
[[ "$(stat -c '%u:%g' "$RUN_DIR")" == '0:0' ]] || fail '运行目录必须归 root:root 所有'

OPERATION_LOG="$RUN_DIR/rotation.stderr.log"
BACKUP_FILE="$RUN_DIR/timeline-before-rotation.dump"
BACKUP_CHECKSUM_FILE="$RUN_DIR/timeline-before-rotation.dump.sha256"
CONTAINER_OUTPUT_DIR="$RUN_DIR/container-output"
CONTAINER_OUTPUT_FILE="$CONTAINER_OUTPUT_DIR/recovery-key.txt"
CANDIDATE_OUTPUT_FILE="$RUN_DIR/recovery-key.candidate.txt"
INACTIVE_OUTPUT_FILE="$RUN_DIR/recovery-key.inactive.txt"
FINAL_OUTPUT_FILE="$RUN_DIR/recovery-key.txt"

: > "$OPERATION_LOG"
: > "$BACKUP_FILE"
chmod 0600 "$OPERATION_LOG" "$BACKUP_FILE"
chown root:root "$OPERATION_LOG" "$BACKUP_FILE"

if ! compose exec -T postgres \
  pg_dump --username timeline --dbname timeline --format=custom --no-owner --no-privileges \
  > "$BACKUP_FILE" 2>> "$OPERATION_LOG"; then
  fail 'PostgreSQL custom 备份失败，密钥轮换未开始'
fi
[[ -f "$BACKUP_FILE" && ! -L "$BACKUP_FILE" && -s "$BACKUP_FILE" ]] \
  || fail 'PostgreSQL 备份文件无效，密钥轮换未开始'
[[ "$(head -c 5 "$BACKUP_FILE")" == PGDMP ]] \
  || fail 'PostgreSQL 备份不是 custom 格式，密钥轮换未开始'
[[ "$(stat -c '%a' "$BACKUP_FILE")" == 600 ]] || fail 'PostgreSQL 备份权限不是 0600'
if ! compose exec -T postgres pg_restore --list \
  < "$BACKUP_FILE" >/dev/null 2>> "$OPERATION_LOG"; then
  fail 'PostgreSQL custom 备份无法被 pg_restore 解析，密钥轮换未开始'
fi
sha256sum "$BACKUP_FILE" > "$BACKUP_CHECKSUM_FILE"
chmod 0600 "$BACKUP_CHECKSUM_FILE"
chown root:root "$BACKUP_CHECKSUM_FILE"
[[ "$(stat -c '%a' "$BACKUP_CHECKSUM_FILE")" == 600 ]] || fail 'PostgreSQL 备份校验和权限不是 0600'
sha256sum --check "$BACKUP_CHECKSUM_FILE" >/dev/null 2>> "$OPERATION_LOG" \
  || fail 'PostgreSQL 备份校验和验证失败，密钥轮换未开始'
log '轮换前 PostgreSQL custom 备份已创建、解析并记录 SHA-256 校验和'

ACTIVE_BEFORE="$(require_query_count "SELECT count(*) FROM account_recovery_keys WHERE used_at IS NULL AND expires_at>now()")"
AUDIT_BEFORE="$(require_query_count "SELECT count(*) FROM account_recovery_audit WHERE success=true AND event='recovery_key_rotated'")"
(( ACTIVE_BEFORE <= 1 )) || fail '数据库中存在多个有效恢复密钥，拒绝继续'

mkdir -- "$CONTAINER_OUTPUT_DIR"
chmod 0700 "$CONTAINER_OUTPUT_DIR"
chown 65532:65532 "$CONTAINER_OUTPUT_DIR"

ROTATION_STATE='unknown'
if compose run --rm --no-deps -T \
  --user 65532:65532 \
  --volume "$CONTAINER_OUTPUT_DIR:/run/timeblog-recovery" \
  api --rotate-recovery-key --output /run/timeblog-recovery/recovery-key.txt \
  >/dev/null 2>> "$OPERATION_LOG"; then
  ROTATION_COMMAND_STATUS=0
else
  ROTATION_COMMAND_STATUS=$?
fi

if collect_candidate_output; then
  CANDIDATE_PROBE_STATUS=0
else
  CANDIDATE_PROBE_STATUS=$?
fi

POSTCHECK_QUERIES_OK=0
ACTIVE_AFTER=''
AUDIT_AFTER=''
if ACTIVE_AFTER="$(query_count "SELECT count(*) FROM account_recovery_keys WHERE used_at IS NULL AND expires_at>now()")" \
  && AUDIT_AFTER="$(query_count "SELECT count(*) FROM account_recovery_audit WHERE success=true AND event='recovery_key_rotated'")"; then
  POSTCHECK_QUERIES_OK=1
fi

if (( POSTCHECK_QUERIES_OK == 1 )) \
  && [[ "$ACTIVE_AFTER" == 1 ]] \
  && (( AUDIT_AFTER == AUDIT_BEFORE + 1 )); then
  ROTATION_STATE='committed'
  DATABASE_STATE_VERIFIED=1
elif (( POSTCHECK_QUERIES_OK == 1 && ROTATION_COMMAND_STATUS != 0 )) \
  && [[ "$ACTIVE_AFTER" == "$ACTIVE_BEFORE" ]] \
  && [[ "$AUDIT_AFTER" == "$AUDIT_BEFORE" ]]; then
  ROTATION_STATE='not-committed'
  DATABASE_STATE_VERIFIED=1
elif (( POSTCHECK_QUERIES_OK == 0 && ROTATION_COMMAND_STATUS == 0 )); then
  # The CLI reports success only after commit succeeds or it verifies the new
  # key as active. Preserve that fact while still failing the external check.
  ROTATION_STATE='committed'
  DATABASE_STATE_VERIFIED=0
else
  ROTATION_STATE='unknown'
  DATABASE_STATE_VERIFIED=0
fi

if (( CANDIDATE_PROBE_STATUS == 2 )); then
  fail "候选密钥未通过安全校验：$CANDIDATE_ERROR"
fi

case "$ROTATION_STATE" in
  committed)
    [[ "$CANDIDATE_STATUS" == adopted ]] || fail '数据库轮换已提交，但没有可安全交付的候选密钥文件'
    move_candidate_to "$FINAL_OUTPUT_FILE" || fail '无法将已提交的恢复密钥保存到最终文件'
    (( DATABASE_STATE_VERIFIED == 1 )) \
      || fail '数据库轮换已提交，但轮换后的只读复核失败'
    if (( ROTATION_COMMAND_STATUS != 0 )); then
      log '轮换命令返回非零，但数据库状态和审计增量已确认提交'
    fi
    ;;
  not-committed)
    if [[ "$CANDIDATE_STATUS" == adopted ]]; then
      move_candidate_to "$INACTIVE_OUTPUT_FILE" || fail '无法隔离未激活的候选密钥文件'
    fi
    fail '恢复密钥轮换命令失败，数据库确认本次轮换未提交'
    ;;
  unknown)
    fail '无法确认恢复密钥轮换是否提交，候选材料已按现状保留'
    ;;
esac

verify_health
log '轮换后的数据库状态、审计事件和服务健康检查通过'
log "新恢复密钥已写入 root:root 0600 文件：$FINAL_OUTPUT_FILE"
log "轮换前数据库备份：$BACKUP_FILE"
log "轮换前数据库备份校验和：$BACKUP_CHECKSUM_FILE"
log "受保护的操作日志：$OPERATION_LOG"
