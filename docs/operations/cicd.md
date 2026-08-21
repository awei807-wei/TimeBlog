# CI/CD 发布与生产部署

本项目使用 GitHub Actions 构建并发布 `core`、`web` 两个镜像，生产 VPS 只负责拉取不可变镜像并运行 Compose。VPS 不执行源码构建，也不在发布过程中触碰 PostgreSQL、媒体卷或导出卷。

## 1. 发布拓扑

```text
main push
   │
   ▼
CI workflow（GitHub-hosted 快速测试、静态检查、Compose/PostgreSQL 集成）
   │ success
   ▼
release workflow（workflow_run）
   ├── Kubernetes 内 `timeblog-build-amd64` self-hosted runner 单次构建
   ├── ghcr.io/awei807-wei/timeblog-core
   │     └── /app/api + /app/worker
   └── ghcr.io/awei807-wei/timeblog-web
         └── Next.js standalone
   │
   └── 可选：production Environment 审批后 SSH 部署
```

发布文件是 `.github/workflows/release.yml`。它只响应名为 `CI` 的工作流，并且仅接受：

- CI 结论为 `success`
- CI 触发事件为 `push`
- CI 的目标分支为 `main`

Pull Request 不会推送 GHCR 镜像，也不会接触生产凭据。

为避免同一个 `main` commit 在两套 Runner 上重复执行生产构建，主分支 push 的 CI 会跳过 Next.js production build 和 core/web Docker image build；CI 仍执行 Go 测试与 vet、前端 lint/typecheck/test、Compose 静态检查和 PostgreSQL 集成测试。CI 成功后，Release 在 Kubernetes Runner 上对精确的当前 `main` commit 构建一次正式镜像，构建失败时不会进入部署。

Pull Request、tag 和非 `main` 分支 push 不会触发 Release，因此仍在 GitHub-hosted runner 执行 Next.js production build，并通过两个并行 matrix job 分别验证 core/web Dockerfile。这样既保留合并前的容器契约检查，也不会让不受信任代码进入持久化、特权 DIND 的 Kubernetes Runner。job 级条件被跳过时 GitHub 将其视为成功，不会阻止成功的 main CI 触发 Release。

核心 Compose 不包含 Caddy，也不解析 `SITE_HOST`。只有显式加载 `deploy/compose.proxy.yaml` 启用反向代理时，才需要在对应环境提供真实的 `SITE_HOST`；本发布流程只更新 API、Worker 和 Web。

发布前会将 `workflow_run.head_sha` 与最新的 `origin/main` HEAD 做确定性比较；重跑的历史 CI 或已过期提交会安全跳过构建、推送和部署，不会回退线上版本。

### 1.1 Kubernetes 构建 Runner

发布镜像构建可以切换到仓库级的传统 self-hosted GitHub Actions Runner；这不是 ARC、Jenkins 或生产 Kubernetes 工作负载。清单位于 `deploy/k8s/github-runner/`，包含一个单副本 Deployment：

- runner 容器固定为 `ghcr.io/actions/actions-runner:2.336.0`，注册标签为 `timeblog-build-amd64`。
- Docker-in-Docker sidecar 固定为 `docker:29.6.1-dind`；只有该 sidecar 使用 `privileged`。
- runner 注册状态、加密凭据和 runner 安装目录保存在使用 `local-path` StorageClass 的 `5Gi` PVC `/runner`；工作目录和 Docker 数据分别使用限额 `emptyDir`。
- ServiceAccount 明确关闭 token 挂载；不使用 `hostPath`、`hostNetwork` 或 `hostPID`，并通过 node affinity 排除 control-plane 节点。
- NetworkPolicy 拒绝所有入站连接，并将出站限制为 DNS 与 TCP 443；runner 只需要访问 GitHub Actions、GHCR、Docker Hub、`gcr.io` 与 Actions cache 的 HTTPS 服务。标准 NetworkPolicy 不能按域名过滤，若集群需要域名级白名单，应在 Calico 或外部防火墙继续收紧。
- runner 与 DIND 的内存上限合计约 `3.3Gi`，DIND 数据卷上限为 `20Gi`。

该 Runner 是持久化、单租户的过渡方案。DIND 需要 `privileged`，其信任边界等同于承载它的 worker 节点，因此只能执行本仓库受信任 `main` 的单次发布构建，严禁将 Pull Request、外部仓库、非 `main` 分支或用户可控工作流路由到该标签。建议启用 `main` 分支保护；若节点还承载其他业务，应迁移到专用构建节点或后续改为短生命周期 Runner。

`local-path` PVC 会与首次调度节点绑定，不提供跨节点高可用或备份。节点或 PVC 丢失时应删除 GitHub 中的离线 Runner 记录，重新生成一次性注册 token 并注册；不要把 PVC 当作长期凭据备份。

发布 job 的 `runs-on` 使用：

```yaml
runs-on: ${{ vars.TIMEBLOG_BUILD_RUNNER || 'ubuntu-latest' }}
```

未设置 `TIMEBLOG_BUILD_RUNNER` 时仍使用 GitHub-hosted runner；设置为 `timeblog-build-amd64` 后才切换到 Kubernetes runner。变量设置后如果 runner 不在线，job 会排队，不会自动回退；回滚时删除该变量即可。所有 CI/PR job 和 production deploy job 都保持 GitHub-hosted，只有可信 `main` 的 Release 镜像构建使用该 runner。

首次注册步骤（注册 token 只写入权限为 `0600` 的临时文件和短期 Secret；首次注册时会短暂作为 `config.sh --token` 的进程参数使用，但不会写入 Git 或 Actions 日志）：

```bash
umask 077
token_file="$(mktemp)"
trap 'rm -f "$token_file"' EXIT

gh api --method POST \
  repos/awei807-wei/TimeBlog/actions/runners/registration-token \
  --jq .token | tr -d '\r\n' > "$token_file"

kubectl apply -f deploy/k8s/github-runner/namespace.yaml
kubectl -n timeblog-ci create secret generic timeblog-github-runner-registration \
  --from-file=token="$token_file"
kubectl apply -k deploy/k8s/github-runner
```

runner 在线后立即删除注册 Secret；PVC 中的 `.runner` 配置会继续用于重启：

```bash
kubectl -n timeblog-ci delete secret timeblog-github-runner-registration
```

入口脚本仅在 PVC 没有 `.runner` 时调用一次 `config.sh`，随后 `unset RUNNER_TOKEN` 再启动 `run.sh`。如果 PVC 丢失或重建，需要重新生成 repository-level registration token。runner Pod 必须能访问 GitHub Actions、GHCR、Docker Hub、`gcr.io` 和 GitHub Actions cache 服务的 HTTPS 出站连接。

## 2. 镜像与 Compose 约定

Compose 使用两个镜像变量：

```env
CORE_IMAGE=ghcr.io/awei807-wei/timeblog-core@sha256:...
WEB_IMAGE=ghcr.io/awei807-wei/timeblog-web@sha256:...
```

`api` 和 `worker` 都使用 `CORE_IMAGE`，通过各自的 `/app/api`、`/app/worker` 入口启动。PostgreSQL、`postgres-data`、`media`、`exports` 保持现有命名和生命周期。

生产部署不会更新 Caddy；Caddy 由现有反向代理部署负责。Compose 文件中的必需环境变量仍应在 VPS 的 `deploy/.env` 中完整配置。

## 3. Tag 与 digest 策略

每次发布会推送两个 tag：

```text
sha-<完整 commit sha>
main
```

生产部署不使用 `main` 或 `latest`，而使用 `docker/build-push-action` 输出的 digest：

```text
ghcr.io/awei807-wei/timeblog-core@sha256:<64位十六进制摘要>
ghcr.io/awei807-wei/timeblog-web@sha256:<64位十六进制摘要>
```

上传到 VPS 的 `.release.incoming.env` 只包含：

```env
CORE_IMAGE=...
WEB_IMAGE=...
RELEASE_SHA=...
RELEASE_TAG=...
RELEASE_CREATED_AT=...
```

其中不包含数据库密码、管理员密码、TOTP、图床 Token、NAS 配置或任何其他应用密钥。

## 4. GitHub 权限、Secrets 与 Variables

工作流默认权限为：

```yaml
permissions:
  contents: read
```

只有 `publish` job 临时增加：

```yaml
permissions:
  contents: read
  packages: write
```

`deploy` job 只保留 `contents: read`。远程 VPS 自己负责从 GHCR 拉取镜像；GitHub Actions 不需要保存数据库或应用运行时密钥。

### Repository Variable

| 名称 | 值 | 作用 |
| --- | --- | --- |
| `ENABLE_PRODUCTION_DEPLOY` | `true` / 其他 | 只有精确为 `true` 时才执行生产部署 |
| `TIMEBLOG_BUILD_RUNNER` | 未设置 / `timeblog-build-amd64` | 选择发布镜像构建使用 GitHub-hosted 或 Kubernetes self-hosted runner |

默认建议保持 `ENABLE_PRODUCTION_DEPLOY` 未设置或设置为 `false`，并保持 `TIMEBLOG_BUILD_RUNNER` 未设置。这样可以先使用 GitHub-hosted runner 验证镜像发布，不会因为没有生产 SSH Secrets 或 Kubernetes runner 而失败。

### `production` Environment Secrets

只有准备启用 VPS 自动部署时，才在 GitHub 的 `production` Environment 中配置：

| 名称 | 内容 |
| --- | --- |
| `VPS_HOST` | VPS 主机名或 IP |
| `VPS_USER` | 受限部署用户 |
| `VPS_SSH_PRIVATE_KEY` | 仅用于部署的 SSH 私钥 |
| `VPS_KNOWN_HOSTS` | 固定的 SSH 主机公钥，允许多行 |

`production` Environment 应设置 Required reviewers，并限制只允许受保护的 `main` 分支进入。工作流始终使用：

```text
StrictHostKeyChecking=yes
UserKnownHostsFile=<固定 known_hosts 文件>
IdentitiesOnly=yes
```

禁止使用 `StrictHostKeyChecking=no`。

### 4.1 只读 SSH 预检

`.github/workflows/production-ssh-preflight.yml` 提供手动触发的生产 SSH 预检。它绑定 `production` Environment，并验证四个 SSH Secret 均可用、私钥可解析、`known_hosts` 包含目标主机、严格主机指纹校验能够完成 SSH 登录，以及部署目录、权限、`deploy/.env` 和 Docker/Compose 满足发布前置条件。

预检不会检出或上传源码，不会读出 `deploy/.env` 内容，不会拉取镜像、修改容器或调用 `deploy/release.sh`。可在 Actions 页面选择 `Production SSH preflight` 后运行，或使用：

```bash
gh workflow run production-ssh-preflight.yml --ref main
```

只有预检通过后，才重跑或触发实际 Release。

如果 GHCR 包是私有的，首发前必须先在 VPS 上使用部署用户完成 GHCR 登录，或将包改为公开：

```bash
printf '%s' '<read-only-token>' | docker login ghcr.io \
  --username '<package-reader>' \
  --password-stdin
```

Token 只授予 `read:packages`，不要把写入或删除权限交给部署账号。登录完成后再开启自动部署；不能把该 Token 写入 Git、GitHub Actions 日志或应用 `deploy/.env`。应用密钥继续只放在 VPS 的 `deploy/.env`，权限应为 `0600`。

## 5. 首次启用步骤

### 5.1 先只发布镜像

1. 确认 `CI` 在 `main` push 上成功。
2. 不设置 `ENABLE_PRODUCTION_DEPLOY`，或显式设置为 `false`。
3. 检查 `Release` workflow 是否成功推送两个镜像。
4. 在 GHCR 中确认 `sha-<commit>` tag 存在。

### 5.2 配置 VPS

确认 VPS 满足：

- `/home/shiyi/TimeBlog` 已存在。
- `/home/shiyi/TimeBlog/deploy/.env` 已存在，且只包含生产运行时配置。
- Docker daemon 正常运行。
- Docker Compose 支持 `up --wait`、`config --quiet`。
- 部署用户可以运行 Docker Compose，但不使用 root SSH。
- 若 GHCR 包为私有，部署用户已配置只读 GHCR 登录凭据。
- 当前 PostgreSQL、API、Worker、Web 健康正常。

首发自动部署没有 `previous.env` 回滚基线。必须先保持 `ENABLE_PRODUCTION_DEPLOY=false`，手工使用一个已验证的 digest 执行首发，确认容器、API、Web 和外部访问均正常，并建立首个 `deploy/releases/current.env`。在此之前不要依赖自动回滚。

### 5.3 开启自动部署

1. 确认首发手工验证已完成且 `current.env` 已建立。
2. 在 GitHub Repository Variables 设置 `ENABLE_PRODUCTION_DEPLOY=true`。
3. 在 `production` Environment 配置四个 SSH Secrets。
4. 添加 Required reviewer。
5. 再次推送到 `main`，等待 CI 成功。
6. 审批 `production` 部署。

发布脚本会通过 `git archive` 将精确 commit 的已跟踪源码流式写入 `/home/shiyi/TimeBlog`。它不执行 `git pull`、`git reset` 或 `git clean`，也不会覆盖 VPS 的 `deploy/.env`。

## 6. 远程发布流程

`deploy/release.sh` 的顺序如下：

1. 创建发布目录并通过 `flock` 加锁。
2. 检查 `deploy/.env`、Compose 文件、Docker daemon、`curl`、`flock`。
3. 检查磁盘剩余空间，默认至少保留 5 GiB。
4. 校验 Compose 配置，不输出包含 Secret 的完整配置。
5. 启动或等待 PostgreSQL 健康。
6. 拉取 API、Worker、Web 所需镜像。
7. 将当前 release env 原子复制为 `previous.env`。
8. 执行：

   ```bash
   docker compose ... up -d --no-build --wait --wait-timeout 180 api worker web
   ```

9. 检查 PostgreSQL、API、Worker、Web 容器状态和 healthcheck。
10. 请求 API live、API ready、Web 首页。
11. 所有检查成功后，原子更新 `current.env`。

生产 release 目录只保留状态文件：

```text
deploy/releases/current.env
deploy/releases/previous.env
deploy/releases/.lock
```

这些文件不放入 Git，也不包含应用 Secret。

## 7. 失败与回滚

拉取失败、Compose 配置失败、容器未健康或 HTTP 检查失败时：

- 新版本不会被标记为 `current`。
- 如果已经开始更新容器，脚本会自动使用 `previous.env` 执行应用回滚。
- 回滚同样要求 API、Worker、Web 和 HTTP 检查全部通过。
- 如果没有 `previous.env`，脚本会报告无法自动回滚，不会删除数据。

数据库回滚不属于镜像回滚的一部分。数据库迁移必须采用向前兼容的 expand/contract 策略；如果迁移已经造成旧版本无法启动，应暂停自动处理，依据现有备份恢复手册人工操作。

生产部署不会执行破坏性 Compose 操作，不会删除 PostgreSQL、媒体或导出卷。

## 8. 并发与磁盘策略

生产部署使用：

```yaml
concurrency:
  group: timeblog-production
  cancel-in-progress: false
```

同一时间只允许一个生产发布，已开始的发布不会被新工作流取消。

构建缓存只保存在 GitHub Actions：

- `timeblog-core` 使用独立 BuildKit GHA cache scope。
- `timeblog-web` 使用独立 BuildKit GHA cache scope。
- `main` 的正式镜像只在 Release 构建一次；CI 不再先生成一套不会发布的重复镜像。
- Pull Request 与非 `main` 分支的容器契约构建使用 GitHub-hosted 临时 Docker cache，且不会推送镜像。
- Kubernetes runner 的 Pod 和本地 Docker 数据可随时重建，不能依赖本地层缓存；GHA cache 需要允许 runner 访问 GitHub Actions cache 服务。
- VPS 不执行 Docker build，因此不会再次累积 BuildKit 构建缓存。

VPS 清理应遵守：

- 当前版本和上一个版本保持可回滚。
- 只清理明确不再需要的旧镜像。
- 不清理 `postgres-data`、`media`、`exports`。
- 不使用会触及卷的全局清理命令。

启用自动部署前，建议先人工清理一次历史构建缓存，并确认 `df -h`、`docker system df` 和备份空间都正常。

## 9. 安全边界

- GitHub Actions 不读取生产 `deploy/.env`。
- Kubernetes self-hosted runner 只承载可信 `main` 发布构建，不承载 Pull Request 构建，也不接收 production Environment 的 SSH Secrets。
- Release env 只包含镜像 digest 和公开发布元数据。
- 生产部署只通过固定 SSH 主机指纹连接。
- 镜像按 digest 运行，tag 漂移不会改变已部署版本。
- 生产环境审批由 GitHub Environment 控制。
- 部署脚本不会删除卷、数据库或媒体数据。
- Caddy 不由本发布流程更新。
- 远程日志不得打印 Compose 完整配置或应用 Secret。
