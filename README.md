# 菜鸟手记


## 本地运行

```bash
DATABASE_URL=postgres://timeline:password@localhost:5432/timeline ADMIN_PASSWORD=replace ADMIN_TOTP_SECRET=BASE32_SECRET TOTP_ENCRYPTION_KEY=BASE64URL_32_BYTE_KEY ACCOUNT_RECOVERY_KEY_BOOTSTRAP='一次性高熵恢复码' go run ./services/core
npm install
npm --workspace apps/web run dev
```

## 备份与恢复

在任意目录执行 `./deploy/backup.sh`（或从 `deploy/` 执行 `./backup.sh`）会以动态 Compose 卷名导出 PostgreSQL custom dump、媒体卷和导出卷，并生成带 SHA-256 校验和的 manifest。恢复是破坏性操作，必须显式提供 `BACKUP_STAMP=... ./deploy/restore.sh --confirm`；脚本会先验证 manifest/校验和，再停止 API/worker，使用事务 `pg_restore` 恢复数据库和两个文件卷，失败时自动恢复原服务状态。备份目录应放在受控 NAS/离线存储，定期执行恢复演练。

生产反向代理可按需加载独立的 Caddy Compose 文件：设置 `SITE_HOST=example.com` 后运行 `docker compose -f deploy/compose.yaml -f deploy/compose.proxy.yaml --profile proxy up -d`。Caddy 负责 TLS/HSTS 和路由，API 的 `APP_ORIGIN` 与前端 `SITE_URL` 必须使用同一个 HTTPS 站点；核心 Compose 和本地开发不会解析 `SITE_HOST`。

API 健康检查：`GET /health/live`、`GET /health/ready`。

账户恢复安全：首次启动前生成并离线保存高熵恢复码，临时设置 `ACCOUNT_RECOVERY_KEY_BOOTSTRAP`。服务仅在数据库没有有效恢复码时读取该变量并保存 Argon2id 哈希；启动成功后立即从 Compose/.env 删除变量。恢复接口严格校验同源、限流并撤销全部会话，同时轮换恢复码和 TOTP，响应中的 `recoveryKey` 与 `totpSetupURI` 仅显示一次，必须通过受控渠道保存。

媒体与导入大小限制由 `MAX_UPLOAD_BYTES` 控制（字节，默认 200 MiB，允许范围 1 MiB–2 GiB）；超出范围的配置会安全回退到默认值。ZIP 导入总包上限仍为 256 MiB。

登录后的“内容管理 → 设置”可持久化外部图床和 NAS pull 策略。外部图床使用 `ou_image_hosting_v1` 异步适配器：规范原件始终留在本地媒体卷，Token 使用独立 `CONFIG_ENCRYPTION_KEY` 加密且不会回显。接口依据 OU Image Hosting `1.0.0` 固定提交完成[源码契约审计](docs/integrations/ou-image-hosting-api.md)；无副作用验证只读取一条列表记录，不上传探针。启用需要确认稳定公开 URL，上传需要 `images:write`，读取验证建议 `images:read`，可选的同步软回收需要 `images:delete`。外部失败会保留本地文件并在媒体库显示状态和重试入口。

NAS 设置只保存 `SOURCE_HOST`、`SOURCE_PATH`、`DEST_PATH` 和 `RETENTION_DAYS`，不保存 SSH 私钥或 `known_hosts`。保存后由运维者执行 `/app/api --export-nas-config` 将固定字段导出为 NAS 上权限 `0600` 的环境文件，再由 `deploy/nas-pull-backup.sh` 通过 `NAS_CONFIG_FILE` 消费；因此页面会明确显示“待导出应用”。

可用 `go run ./services/core --generate-recovery-key` 生成一次性高熵码（仅打印到当前终端，不写日志）；恢复完成后保存响应中的新码并清理旧 bootstrap 配置。
