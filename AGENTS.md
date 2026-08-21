# 项目上下文

> 用途：供新的开发窗口快速恢复项目背景。代码、运行时状态和 Git 历史优先于本文；本文不保存密码、Token、私钥或完整环境变量。
>
> 最近核验：2026-08-20（Asia/Shanghai）

## 概述

TimeBlog（站点名“菜鸟手记”）是个人时间线与博客系统。公开端按日期展示随手记和长文章，并提供文章详情、日历、分类、标签、搜索和 RSS；登录后的管理端负责写作、草稿、版本、回收站、媒体、导出、集成与运行设置。

生产站点：`https://blog.cainiao.me`。项目仓库：`git@github.com:awei807-wei/TimeBlog.git`。

## 技术栈

- **前端**：Next.js 16.3.1、React 19.1.1、TypeScript 5.9、Tailwind CSS 4、React Aria Components、Radix UI、Lucide React。
- **编辑器与内容**：MDXEditor 4.2、Lexical、Markdown 持久化、Goldmark 服务端渲染、DOMPurify/BlueMonday 清洗、Mermaid。
- **后端**：Go 1.26 单模块；API 与后台 Worker 共用核心代码和同一个 Core 镜像。
- **数据层**：PostgreSQL 16；`pgx/v5`；SQL 迁移位于 `services/core/db/migrations/`。
- **认证**：管理员密码 + TOTP；HttpOnly Session Cookie；写操作使用 CSRF Token；敏感配置使用独立加密密钥。
- **媒体**：本地媒体卷保存规范原件；Markdown 使用 `media://<uuid>` 引用；可异步发布到 OU Image Hosting 外部图床。
- **交付**：Docker、Docker Compose、GitHub Actions、GHCR、本地 Kubernetes self-hosted Runner。
- **测试**：Go `go test`、Node Test Runner、ESLint、TypeScript、Next.js production build、Compose/部署契约测试。

## 架构

```text
浏览器
  ├─ Next.js Web（公开页、登录页、管理端）
  └─ 同源 /api/v1/*
        └─ Go API
             ├─ PostgreSQL
             ├─ media / exports Docker volumes
             └─ 队列任务 → Go Worker
                              ├─ 导出与清理
                              ├─ 外部图床异步发布
                              └─ 媒体删除/回收

GitHub Pull Request / tag / 非 main push
  └─ CI（GitHub-hosted）
       ├─ API/Web 质量检查与 Web production build
       └─ core/web Docker matrix build

GitHub main push
  └─ CI（GitHub-hosted，跳过重复的 production/Docker build）
       └─ Release（Kubernetes self-hosted Runner）
            ├─ 构建并推送 GHCR core/web 镜像
            └─ VPS Docker Compose 自动部署（受显式变量门控）
```

- `api` 与 `worker` 使用 `CORE_IMAGE`，入口分别为 `/app/api`、`/app/worker`。
- `web` 使用 `WEB_IMAGE`。
- `main` 的 CI 只运行单元测试、静态检查、类型检查和数据库集成测试；生产 Web 与容器镜像只在 Release 中构建一次。
- Pull Request、tag 与非 `main` push 仍在 GitHub-hosted Runner 完成 Web production build，并以 matrix 并行验证 core/web 容器。
- 核心 Compose 不包含 Caddy；生产 Caddy 已独立部署，按同源路径反代 Web 与 `/api/*`。
- 生产部署只更新应用容器，不删除 PostgreSQL、媒体卷或导出卷。

## 领域语言

- **Entry / 内容条目**：统一内容实体；`kind=note` 为随手记，`kind=article` 为有独立详情地址的文章。
- **工作草稿**：编辑中的本地 IndexedDB/服务端 working copy，不等于已发布 Entry。
- **状态**：主要包括 `draft`、`published`、`trashed`；回收站内容不应出现在公开时间线。
- **可见性**：`public` 或 `private`；私有媒体和内容需要有效 Session。
- **媒体引用**：持久化 Markdown 中的 `media://<uuid>`；实际内容由 `/api/v1/media/<id>/content` 提供。
- **规范原件**：媒体始终保留在本地卷；外部图床 URL 只是发布结果，不替代本地原件。
- **Release**：CI 成功后构建并推送不可变 GHCR 镜像；不等同于生产部署。

## 目录结构

- `apps/web/`：Next.js 前端、公开页面、管理端、MDXEditor、前端测试。
- `services/core/`：Go API、领域模型、认证、写作、媒体、集成设置与数据库访问。
- `services/core/cmd/worker/`：后台 Worker。
- `services/core/db/migrations/`：PostgreSQL 迁移。
- `deploy/compose.yaml`：PostgreSQL、API、Worker、Web 核心 Compose。
- `deploy/compose.proxy.yaml`：可选 Caddy 代理，不用于当前外置 Caddy 的常规部署。
- `deploy/release.sh`：基于不可变镜像 digest 的 VPS 发布、健康检查与回滚。
- `deploy/backup.sh`、`deploy/restore.sh`：数据库与媒体卷备份/恢复。
- `deploy/k8s/github-runner/`：Kubernetes self-hosted GitHub Actions Runner 清单。
- `.github/workflows/ci.yml`：主分支快速质量检查，以及 PR/tag/非主分支的完整构建检查。
- `.github/workflows/release.yml`：构建、推送 GHCR；生产部署受变量门控。
- `docs/operations/cicd.md`：CI/CD、Runner、GHCR、VPS 发布与回滚说明。
- `docs/integrations/ou-image-hosting-api.md`：外部图床协议审计与适配器契约。

## 模块文档

- CI/CD：[docs/operations/cicd.md](../docs/operations/cicd.md)
- 依赖安全：[docs/operations/dependency-security.md](../docs/operations/dependency-security.md)
- 外部图床：[docs/integrations/ou-image-hosting-api.md](../docs/integrations/ou-image-hosting-api.md)
- 媒体存储 ADR：[docs/adr/ADR-008-media-storage.md](../docs/adr/ADR-008-media-storage.md)

## 可调用资源

### GitHub 与镜像仓库

- GitHub 仓库：`awei807-wei/TimeBlog`；Git SSH fetch/push 当前可用。
- `gh` CLI 已安装，但 2026-08-20 核验时默认账号 Token 无效；需要 GitHub API 操作时先执行 `gh auth login -h github.com`。
- GHCR 镜像：
  - `ghcr.io/awei807-wei/timeblog-core`
  - `ghcr.io/awei807-wei/timeblog-web`
- Repository Variable `TIMEBLOG_BUILD_RUNNER=timeblog-build-amd64` 已启用。
- Repository Variable `ENABLE_PRODUCTION_DEPLOY=true` 已启用；成功的最新 `main` Release 会继续自动部署生产环境。

### Kubernetes 构建集群

- 入口：`ssh shiyi@10.0.0.174`（免密）；该主机是 Kubernetes master。
- 当前 context：`kubernetes-admin@kubernetes`。
- 节点：
  - `k8s-master`：`10.0.0.174`
  - `k8s-works-01`：`10.0.0.167`
  - `k8s-works-02`：`10.0.0.140`
- TimeBlog Runner namespace：`timeblog-ci`。
- Deployment：`timeblog-github-runner`；Runner 标签：`timeblog-build-amd64`。
- PVC：`timeblog-github-runner-config` 为 `5Gi`，保存 Runner 注册状态；`timeblog-github-runner-docker` 为 `20Gi`，保存 Docker 与 BuildKit 构建缓存；两者均使用 `local-path`。
- Runner 使用 Docker-in-Docker，DIND 容器为 `privileged`；只允许可信 `main` 发布构建，不能承载 Pull Request 或其他仓库任务。
- 常用只读检查：

  ```bash
  ssh shiyi@10.0.0.174
  kubectl -n timeblog-ci get deployment,pod,pvc
  kubectl -n timeblog-ci logs deployment/timeblog-github-runner -c runner --tail=100
  ```

### 生产 VPS

- SSH 别名：`ssh vps1`。
- 当前 SSH 配置解析为：`root@193.111.30.194`；主机名为 `shiyi`。
- 项目目录：`/home/shiyi/TimeBlog`。
- 运行方式：Docker Compose；Docker 29.6.2 已安装。
- 生产运行配置：`/home/shiyi/TimeBlog/deploy/.env`，权限应保持 `0600`；禁止读取后粘贴到对话、日志或 Git。
- Caddy 已在 VPS 独立运行，核心 Compose 不应重新创建 Caddy。
- 健康检查：`/health/live`、`/health/ready`、站点首页。
- 默认不要在 VPS 执行源码构建、`docker compose down -v`、卷清理或无审计的 Docker prune。

### NAS 与外部服务

- NAS 备份配置入口位于管理端“内容管理 → 设置”；仓库不保存 NAS 私钥或 `known_hosts`。
- NAS 拉取备份使用 `deploy/nas-pull-backup.sh` 和独立 `0600` 配置文件。
- 外部图床服务：`https://image.cainiao.me`，适配器标识 `ou_image_hosting_v1`。
- 未经用户明确要求，不执行真实图片上传、删除或带副作用的图床调用。

## 常用验证命令

```bash
# 前端
npm --workspace apps/web test
npm --workspace apps/web run lint
npm --workspace apps/web run typecheck
npm --workspace apps/web run build -- --webpack

# Go API / Worker
cd services/core
go test ./...
go vet ./...

# 部署契约
node --test deploy/compose.test.mjs
node --test deploy/release.test.mjs
node --test deploy/github-runner.test.mjs
```

构建与 typecheck 不要并行执行，因为 Next.js 会重建 `.next/types`，并发时可能产生瞬时假失败。

## 安全与操作边界

- 不提交 `.env`、Cookie、TOTP Secret、加密密钥、图床 Token、SSH 私钥或 Runner 注册 Token。
- `deploy/.env` 是 VPS 本地真实配置，Git 中只保留示例文件。
- 数据库和卷操作属于高风险；恢复前必须校验备份并使用项目脚本。
- `main` 当前没有 Branch Protection，是已知风险；修改 Release/Runner 配置时需要额外审查。
- GitHub self-hosted Runner 是持久化单租户过渡方案；长期目标是短生命周期 Runner 或专用构建节点。
- 代码是最终事实。本文中的主机状态、版本和在线状态可能变化，执行前用只读命令重新核验。

## 新窗口接手顺序

1. 读取本文件、当前会话 `STATE.md`（若属于同一任务）和用户最新消息。
2. 执行 `git status --short --branch`、`git log -5 --oneline`，确认当前工作树与主线。
3. 按任务读取相关源码和 `docs/`，不要一次扫描整个仓库。
4. 涉及生产、数据库、Secrets 或外部图床时先做只读核验，不输出敏感值。
5. 完成代码改动后运行对应测试、同步文档，并根据本地配置创建 Git 提交；除非用户明确要求，不自动 push。

## 最近变更

仓库当前未维护 `.helloagents/CHANGELOG.md`；最近演进以 `git log --oneline`、GitHub Actions 记录和 `docs/operations/cicd.md` 为准。
