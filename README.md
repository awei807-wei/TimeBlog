# 个人时间线博客

依据 `Personal_Timeline_Blog_Final_Blueprint_v1.0.docx` 搭建的 monorepo 垂直切片。

架构总览见 [`docs/architecture/overview.md`](docs/architecture/overview.md)，关键取舍见 [`docs/adr/`](docs/adr/)。施工图中的原始技术名词与当前实现存在有意边界：上传采用 API 内置 Tus-compatible 合同而非独立 `tusd` 进程；Web 复用 Next.js 原生 CSS/组件而非强制引入 shadcn/ui；导出 Mermaid 当前生成明确的源码预览 fallback SVG，真实 Mermaid SVG 渲染列为 P1，不能将 fallback 当作真实图形。

## 本地运行

```bash
DATABASE_URL=postgres://timeline:password@localhost:5432/timeline ADMIN_PASSWORD=replace ADMIN_TOTP_SECRET=BASE32_SECRET TOTP_ENCRYPTION_KEY=BASE64URL_32_BYTE_KEY ACCOUNT_RECOVERY_KEY_BOOTSTRAP='一次性高熵恢复码' go run ./services/core
npm install
npm --workspace apps/web run dev
```

## 备份与恢复

在任意目录执行 `./deploy/backup.sh`（或从 `deploy/` 执行 `./backup.sh`）会以动态 Compose 卷名导出 PostgreSQL custom dump、媒体卷和导出卷，并生成带 SHA-256 校验和的 manifest。恢复是破坏性操作，必须显式提供 `BACKUP_STAMP=... ./deploy/restore.sh --confirm`；脚本会先验证 manifest/校验和，再停止 API/worker，使用事务 `pg_restore` 恢复数据库和两个文件卷，失败时自动恢复原服务状态。备份目录应放在受控 NAS/离线存储，定期执行恢复演练。

生产反向代理可按需启用 `caddy` profile：设置 `SITE_HOST=example.com` 后运行 `docker compose --profile proxy -f deploy/compose.yaml up -d`。Caddy 负责 TLS/HSTS 和路由，API 的 `APP_ORIGIN` 与前端 `SITE_URL` 必须使用同一个 HTTPS 站点；本地开发不启用该 profile。

API 健康检查：`GET /health/live`、`GET /health/ready`。

账户恢复安全：首次启动前生成并离线保存高熵恢复码，临时设置 `ACCOUNT_RECOVERY_KEY_BOOTSTRAP`。服务仅在数据库没有有效恢复码时读取该变量并保存 Argon2id 哈希；启动成功后立即从 Compose/.env 删除变量。恢复接口严格校验同源、限流并撤销全部会话，同时轮换恢复码和 TOTP，响应中的 `recoveryKey` 与 `totpSetupURI` 仅显示一次，必须通过受控渠道保存。

媒体与导入大小限制由 `MAX_UPLOAD_BYTES` 控制（字节，默认 200 MiB，允许范围 1 MiB–2 GiB）；超出范围的配置会安全回退到默认值。ZIP 导入总包上限仍为 256 MiB。

可用 `go run ./services/core --generate-recovery-key` 生成一次性高熵码（仅打印到当前终端，不写日志）；恢复完成后保存响应中的新码并清理旧 bootstrap 配置。

当前已落地：公开时间线与日期页、双因素登录和会话安全、工作草稿与冲突检测、公开/私人占位、Asia/Shanghai 日期、断点媒体上传和范围请求、PostgreSQL 持久化、公开/完整 ZIP 导入导出（SHA-256 清单校验、媒体双副本校验、冲突策略、分类/标签/关系/版本/工作副本元数据）、导出后台任务、部署与备份恢复脚本。生产部署使用 `deploy/compose.yaml`，PostgreSQL 迁移位于 `services/core/db/migrations`。

仍需独立验收的事项：完整 PWA 离线同步体验、Playwright 浏览器端 E2E、真实 NAS 恢复演练，以及针对生产数据规模的压测与容量评估。它们不影响当前 API 和部署切片的本地编译、单元测试与静态检查结论。
