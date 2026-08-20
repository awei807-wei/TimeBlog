# 个人时间线博客架构总览

## 1. 范围与约束

本项目以 `Personal_Timeline_Blog_Final_Blueprint_v1.0.docx` 为需求基线，目标是单作者、长期可迁移的个人时间线博客。数据长期可读性、隐私与可恢复性优先于极限吞吐；生产拓扑是单 VPS + PostgreSQL + NAS 拉取备份，第二 VPS 只保留手动接管路径。

## 2. 当前组件

```text
浏览器
  │ 同源 HTTPS
  ▼
Caddy（TLS、HSTS、路由）
  ├── Next.js Web（SSR、SEO、PWA 外壳、编辑器）
  └── Go API（net/http、OpenAPI 合同、认证、写作、媒体、导入导出）
          ├── PostgreSQL（内容、搜索索引、任务队列）
          └── media/export 卷（私有原件、公开副本、导出包）

Go Worker ── PostgreSQL jobs（SKIP LOCKED）── 导出、媒体清理、重试
NAS ──只读 SSH/rsync 拉取── VPS 备份暂存目录
```

Go API 与 Worker 共用 `services/core` 领域代码，分别以 API/Worker 入口运行；Worker 不接受互联网请求，也不保存登录状态。数据库不映射公网端口，Web/API 只通过宿主机反向代理暴露。

## 3. 事实来源与数据边界

- `entries.markdown` 是内容唯一真源；`rendered_html` 与 `plain_text` 由 Go 渲染器生成，不能从客户端 HTML 反推 Markdown。
- 正式内容与 `entry_working_copies` 分离。自动保存只改变工作副本，正式保存才更新 `entries`、分类/标签、媒体引用与文章版本。
- 公开读取在 SQL 阶段应用 `status='published' AND visibility='public'`；私人记录只返回日期、时间和固定占位文案，不加载私人正文、标题、标签或附件元数据。
- 私有媒体只通过 API 鉴权和 Range 流式读取；归档中的原始媒体与公开副本路径分层，导出使用相对路径。

## 4. 关键请求链路

### 公开读取

Next.js 页面通过同源 API 获取公开时间线、日期页、文章、分类、标签、日历和搜索结果。后端分页使用版本化游标；时间线按整天返回，避免把同一天拆到多个页面。公开搜索在 PostgreSQL 中先过滤可见性，再使用 `tsvector`、`pg_trgm` 与公开分类/标签条件。

### 写作与自动保存

前端本地保存草稿并同步到工作副本；服务端使用 `client_draft_id`、revision 和幂等键避免重复写入。点击唯一“保存”按钮后，API 在事务中提交正式内容、媒体引用、分类标签、版本快照和异步任务。公开记录保存成功后客户端清空并重新聚焦。

### 媒体上传

API 实现 Tus-compatible 的 `HEAD`、`PATCH`、完成和范围读取合同，上传过程以临时文件流式写入，不把整文件载入内存。`MAX_UPLOAD_BYTES` 控制单文件上限（默认 200 MiB，允许 1 MiB–2 GiB）；媒体完成后才可建立正式引用。

### 异步任务

Worker 使用 PostgreSQL `jobs` 表，通过 `FOR UPDATE SKIP LOCKED` 竞争任务；任务状态、重试次数、退避时间和错误信息持久化。导出任务以临时 ZIP 写入后原子改名，完成包带 manifest 与 SHA-256 校验和。

## 5. 内容渲染与离线导出

Go 使用 Goldmark 生成 Markdown HTML，并用 bluemonday 清洗 HTML；媒体引用、受控外部嵌入和 Mermaid 代码块先规范化为惰性占位。Web 端在文章视图中按需加载 Mermaid；导出包不执行第三方 iframe，外部视频改写为安全链接卡片。

当前 Worker 不携带 Node/headless Mermaid renderer。离线导出遇到 Mermaid 时生成带源码预览的明确 fallback SVG，避免伪造真实图形；真实 Mermaid SVG 渲染保留为 P1，详见 ADR-006 和 README 的未完成验收项。

## 6. 部署、备份与恢复

- `deploy/compose.yaml` 固定 PostgreSQL 16.4、API、Worker、Web 镜像构建上下文，并为 API/Worker 提供可覆盖的 `CORE_IMAGE`、Web 提供可覆盖的 `WEB_IMAGE`；Caddy 位于独立的 `deploy/compose.proxy.yaml`，只有显式加载该文件并启用 `proxy` profile 时才解析 `SITE_HOST`。
- Compose 为 API 与 Worker 显式绑定各自的二进制入口（`/app/api`、`/app/worker`），避免共享镜像默认入口误启动错误进程；Web 通过 `HOSTNAME=0.0.0.0` 监听容器全部接口，健康检查使用容器内 `127.0.0.1:3000`。
- `deploy/backup.sh` 生成 `timeline.dump-<stamp>`、`media.tar.gz-<stamp>`、`exports.tar.gz-<stamp>`、`SHA256SUMS-<stamp>` 和 `manifest.json-<stamp>`。
- NAS 在自身运行 `deploy/nas-pull-backup.sh`，源主机只读 SSH/rsync；源端校验、本地再次校验、manifest 校验和原子快照改名均在拉取流程中完成，不执行远端删除或改名。
- API `/health/ready` 检查数据库迁移版本、任务表和媒体/导出目录可写；Worker healthcheck 检查数据库、迁移和 jobs 表。

## 7. 代码与文档入口

| 领域 | 入口 |
| --- | --- |
| API 路由与健康检查 | `services/core/server.go` |
| 领域模型与内存测试存储 | `services/core/domain.go` |
| PostgreSQL 查询与游标 | `services/core/persistence.go`、`public_handlers.go` |
| Markdown、安全清洗与嵌入 | `services/core/render.go` |
| 导入导出与冲突策略 | `services/core/admin_extra_handlers.go`、`cmd/worker/main.go` |
| 数据库迁移 | `services/core/db/migrations/` |
| Web 文章与 Mermaid | `apps/web/app/article/` |
| OpenAPI 合同 | `services/core/api/openapi.yaml` |
| 部署与备份 | `deploy/`、`docs/operations/backup-restore-runbook.md` |

## 8. 验证边界

当前仓库已验证 Go `test ./...`、`go vet ./...`、NAS 脚本 `bash -n` 与本地 mock 拉取夹具。完整 PWA 离线同步、Playwright 浏览器 E2E、真实 NAS 空环境恢复、生产数据规模压测和真实 Mermaid SVG 仍需独立验收，不在本地单元测试通过结论中冒充完成。
