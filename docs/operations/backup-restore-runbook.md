# 备份、恢复与月度演练

## 每日备份

1. 在受控运维主机设置 `BACKUP_ROOT`，并执行 `./deploy/backup.sh`。
2. 检查输出目录中的 `SHA256SUMS-<stamp>` 与 `manifest.json-<stamp>`，在对应目录执行 `sha256sum -c SHA256SUMS-<stamp>`。
3. 将完整备份目录复制到 NAS/离线存储；复制后再次校验清单。
4. 不把 `.env`、密码或恢复码写入备份目录。

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

## NAS 拉取与快照

在 NAS 端运行 `deploy/nas-pull-backup.sh`。脚本只通过受控 SSH/rsync 账号读取源主机，不在源主机执行删除或改名：

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
