# 备份、恢复与月度演练

## 备份内容

每个时间戳是一份完整应用数据快照，不是 Markdown-only 导出：

- `timeline.dump-<stamp>`：PostgreSQL custom dump，包含 `timeline` 数据库的 schema、迁移记录及全部业务表数据，包括内容、草稿、工作副本、版本、回收站状态、分类、标签、用户、任务和集成设置。
- `media.tar.gz-<stamp>`：media Docker 卷中的本地媒体规范原件。
- `exports.tar.gz-<stamp>`：exports Docker 卷中的导出文件。
- `SHA256SUMS-<stamp>`：上述文件和 manifest 的 SHA-256。
- `manifest.json-<stamp>`：快照版本和文件对应关系。

快照不包含 PostgreSQL 集群角色、生产 `deploy/.env`、TOTP/配置加密密钥、账户恢复码或 rclone/WebDAV 凭据。这些项目必须通过独立且离线的凭据备份恢复。

## 每日 WebDAV 备份

`deploy/webdav-backup.sh` 执行以下固定流程：

1. 通过 `flock` 拒绝同一主机上的并发任务。
2. 调用 `deploy/backup.sh` 在本地生成五件套；数据库 dump 在离开 PostgreSQL 容器前先通过 `pg_restore --list`。
3. 复核 SHA-256、manifest、两个 tar 归档，再上传到 `.incomplete-<stamp>`。
4. 使用 `rclone check --download` 从 WebDAV 回读并逐文件比较。
5. 发布为 `<stamp>` 目录，复核尺寸后创建空文件 `_SUCCESS`。只有含该标记的目录才是完成快照。

生产配置保存在 root-owned 的 `/etc/timeblog/webdav-backup.env`，权限必须为 `0600`；rclone 凭据仍保存在单独的 `RCLONE_CONFIG` 中。可从 `deploy/webdav-backup.env.example` 创建配置，然后安装 systemd 单元：

```sh
install -d -o root -g root -m 0700 /etc/timeblog
install -o root -g root -m 0600 deploy/webdav-backup.env.example /etc/timeblog/webdav-backup.env
install -o root -g root -m 0644 deploy/systemd/timeline-webdav-backup.service /etc/systemd/system/
install -o root -g root -m 0644 deploy/systemd/timeline-webdav-backup.timer /etc/systemd/system/
systemctl daemon-reload
systemd-analyze verify timeline-webdav-backup.service timeline-webdav-backup.timer
systemctl start timeline-webdav-backup.service
systemctl enable --now timeline-webdav-backup.timer
```

示例值必须按实际部署路径修改。当前生产目标为 `webdav:Google1/TimeBlog/backups`；`/mnt/mydav/Google1` 只是带目录缓存的人工浏览视图，自动任务直接使用 rclone remote，不向 FUSE 挂载写入。

验收时检查：

```sh
systemctl status timeline-webdav-backup.service --no-pager
systemctl list-timers timeline-webdav-backup.timer --no-pager
journalctl -u timeline-webdav-backup.service -n 100 --no-pager
rclone lsf webdav:Google1/TimeBlog/backups --dirs-only
```

timer 固定按 `03:30 Asia/Shanghai` 每日运行，即使 VPS 使用其他系统时区也不会偏移。

### 自动淘汰

每次新快照完成远端回读、发布并写入 `_SUCCESS` 后，脚本才执行计数淘汰：

- `LOCAL_RETENTION_COUNT=7`：VPS 本地默认保留最近 7 份完整五件套。
- `REMOTE_RETENTION_COUNT=90`：WebDAV 默认保留最近 90 份成功快照，且不得小于本地保留数。
- `BACKUP_RETENTION_DRY_RUN=0`：设为 `1` 时只记录候选，不执行删除。

两项保留数允许范围为 2–3650。排序只使用严格的 UTC 时间戳名称，不依赖 WebDAV mtime。本地旧快照只有在远端存在完全受管的对应成功快照时才能删除；远端目录必须恰好包含该时间戳的五件套和 `_SUCCESS` 才能淘汰。远端只逐个删除这六个固定文件，最后用只能删除空目录的 `rclone rmdir` 收尾，不执行宽泛 purge。未知目录、`.incomplete-*`、无成功标记、缺件、符号链接或含额外内容的快照一律保留并写入 journal。淘汰不会触碰在线 PostgreSQL、media 或 exports 卷。

调整策略时，先设置 `BACKUP_RETENTION_DRY_RUN=1` 手动运行 service 并审查 journal，再恢复为 `0`。即使已有淘汰保护，仍应监控 VPS 与 WebDAV 容量。

如只需手动生成本地快照，可设置 `COMPOSE_FILE`、`COMPOSE_ENV_FILE` 和 `BACKUP_DIR` 后执行 `./deploy/backup.sh`，并在输出目录运行 `sha256sum -c SHA256SUMS-<stamp>`。

## 恢复

1. 先确认备份时间点、目标 Compose 项目和维护窗口。
2. 仅使用显式 `BACKUP_STAMP=... ./deploy/restore.sh --confirm` 执行恢复；脚本会校验清单并暂停 API/worker。
3. 恢复后检查 `/health/live` 与 `/health/ready`、公开时间线、登录、媒体内容和导出目录。
4. 保留恢复前日志，确认服务恢复后再清理临时卷。

## 月度恢复演练

在隔离项目/临时数据库执行一次完整恢复，不接入生产域名：

- [ ] 选择最近完整备份并校验 `SHA256SUMS-<stamp>` 及 `manifest.json-<stamp>`
- [ ] 恢复 PostgreSQL、media、exports 卷
- [ ] 检查迁移版本、readiness、任务队列与媒体可写性
- [ ] 验证公开/私人占位、登录、媒体 Range、导出 ZIP 校验和
- [ ] 记录耗时、失败点、数据时间点和改进项

## 可选的 NAS 拉取与快照

NAS 能主动访问 VPS 时，仍可在 NAS 端运行 `deploy/nas-pull-backup.sh` 形成第二份独立快照。它不是当前 WebDAV 定时任务的前置条件；脚本只通过受控 SSH/rsync 账号读取源主机，不在源主机执行删除或改名：

可从 [`deploy/nas-backup.env.example`](../../deploy/nas-backup.env.example) 创建 `/etc/timeblog/nas-backup.env`，权限设为 `0600`。

也可以先在“内容管理 → 设置”保存 pull 策略，再由受控运维终端从 API 容器执行 `--export-nas-config`，把标准输出原子写入 NAS 的 `/etc/timeblog/nas-backup.env` 并设置为 `0600`。导出内容仅包含脚本消费的四个非敏感字段；SSH identity 与 `known_hosts` 仍需在 NAS 的 `timeblog-backup` 系统账户中单独配置。不要把命令输出写入日志或 Git。

```sh
SOURCE_HOST=backup-source \
SOURCE_PATH=/srv/timeblog/backups \
DEST_PATH=/srv/timeblog/nas-snapshots \
RETENTION_DAYS=90 \
./deploy/nas-pull-backup.sh
```

脚本会先在源端校验 `SHA256SUMS-<stamp>`，再把 `timeline.dump-<stamp>`、`media.tar.gz-<stamp>`、`exports.tar.gz-<stamp>`、校验和及 `manifest.json-<stamp>` 拉到 NAS 本地隐藏临时目录；本地再次校验并验证 manifest 后原子改名为时间戳快照。保留策略只匹配脚本创建的时间戳目录。禁止在脚本中保存凭据；使用主机密钥、短时令牌或外部密钥代理。

systemd 示例以 `timeblog-backup` 用户运行，需提前为该用户配置源主机的 `known_hosts` 与只读 SSH 身份（建议使用 `~/.ssh/config` 和 `IdentityFile`），并确保 `DEST_PATH` 位于 service 的 `ReadWritePaths` 中。首次接入时在受控终端执行 `ssh-keyscan -t ed25519 backup-source`，人工核对指纹后再写入该用户的 `known_hosts`；脚本和 service 均启用 `BatchMode` 与严格主机密钥校验。
