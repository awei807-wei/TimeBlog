# TimeBlog 认证、配置、恢复与设置中心施工图

> 版本：v1.2（现有模型与后端契约对齐版）
> 状态：新增恢复 API 已按当前 OpenAPI 与后端实现回填；未落地能力仍不属于本期验收项
> 文档定位：本期改造的唯一事实源（SSOT）
> 适用范围：当前单 Owner、现有 PostgreSQL、Go API、Next.js、Docker Compose 部署

本文先把目标收敛到项目已经拥有的能力。代码是当前运行时事实；本文件中的“计划”只描述尚未落地的本期增量，不把未来能力写成已存在的验收项。

## 0. 一句话结论

本期不重做认证、账号、会话或 Secret 模型，只补齐用户真正需要的恢复入口和设置中心：

1. **保留现有完整恢复**：现有恢复密钥 `/api/v1/auth/recovery/account` 仍是完整账号恢复流程；服务器本地运维脚本仍是恢复密钥丢失时的 break-glass 最后保险。
2. **增加 TOTP 自助改密**：仍持有当前 TOTP 的 Owner 可以在 Web 端重置密码；这是明确标注的降级恢复，不修改 TOTP 或恢复密钥。
3. **增加已登录安全操作**：已登录 Owner 在操作时重新提交当前密码和 TOTP 后可以修改密码、轮换恢复密钥，并管理自己的会话。
4. **建设真实能力设置中心**：普通站点设置、当前已有的图床/NAS 集成、运行状态、安全状态和会话管理集中呈现；不为不存在的服务制作空表单。
5. **保留最后保险**：密码、TOTP、恢复密钥全部丢失时，仍只能由受控服务器本地流程恢复。纯用户侧流程不能安全地解决“三种凭据全丢”。

## 1. 已冻结的项目事实

### 1.1 账号模型

- 当前只有一个 `users.username='owner'` 的账号。
- 账号表当前保存 `password_hash` 和 `totp_secret_encrypted`；没有邮箱、角色、状态、多认证器或恢复码表。
- `ADMIN_PASSWORD` 和 `ADMIN_TOTP_SECRET` 只参与首次建库引导；Owner 已存在后，修改环境变量不会覆盖数据库中的账号材料。
- 本期不新增邮箱体系、多用户、角色矩阵、Passkey/WebAuthn 或恢复码。

### 1.2 登录与会话模型

- 当前登录分为 `/api/v1/auth/login/password` 和 `/api/v1/auth/login/totp` 两步。
- 服务端 `sessions` 表保存会话哈希、CSRF 哈希、最后活动时间、30 天滑动空闲期限、90 天绝对期限和吊销时间。
- 浏览器 Cookie 当前名称为 `timeline_session`；生产环境设置 `Secure; HttpOnly; SameSite=Lax; Path=/`，不在本期改名为 `__Host-*`。
- TOTP 自助重置和已登录改密成功后吊销全部 Session；完整恢复也吊销全部 Session；这些恢复路径都不自动登录。
- 现有会话页接口为 `/api/v1/auth/sessions` 及其子路径；本期补齐前端入口和必要的安全操作，不更换会话存储模型。

### 1.3 恢复密钥模型

- 当前恢复密钥只保存 Argon2id 哈希，存于 `account_recovery_keys`，有效期为 90 天，使用后失效。
- `/api/v1/auth/recovery/account` 要求恢复密钥、新密码和浏览器生成的幂等/新凭据材料；成功后在事务内更新密码、TOTP、恢复密钥并吊销会话。
- 恢复响应只在成功时给出一次新恢复密钥和 TOTP 设置信息；浏览器负责在本地展示并提示保存。
- 恢复密钥轮换的现有运维入口是 `deploy/rotate-recovery-key.sh --confirm`，脚本调用已部署 Core 镜像的 `--rotate-recovery-key`。当前没有已经落地的 `timeblogctl` 二进制，本期文档不虚构该命令。
- TOTP 自助改密不修改恢复密钥；已登录的恢复密钥轮换是独立的高风险操作。

### 1.4 Secret 与配置模型

- TOTP Secret 使用现有 `TOTP_ENCRYPTION_KEY` 加密保存；应用配置和集成 Secret 继续使用当前环境变量与 `integration_settings.secret_encrypted` 机制。
- `DATABASE_URL`、`CONFIG_ENCRYPTION_KEY`、`TOTP_ENCRYPTION_KEY` 等运行配置在本期保持现状，不迁移到 Vault/KEK/DEK 或 `*_FILE` 体系。
- 已有图床和 NAS 集成通过现有设置接口维护；Secret 只显示是否已配置、测试状态和更新时间，不回显原文。
- 本期不建设 SMTP、OAuth、对象存储、通用 Secret Vault、通用通知 Outbox 或数据库密码轮换页面。

### 1.5 已存在的设置与运维能力

当前 API 已有：

- `/api/v1/admin/settings`：站点设置读写；
- `/api/v1/admin/integrations/external_image_host/test`：图床无副作用测试；
- `/api/v1/admin/integrations/{name}`：已有集成配置；
- `/api/v1/admin/runtime-status`：运行与安全配置状态；
- `/api/v1/auth/sessions`、`/api/v1/auth/sessions/{id}`：会话查看与吊销。
- `/api/v1/auth/recovery/totp/start`、`/api/v1/auth/recovery/totp/complete`：TOTP-only 降级改密；
- `/api/v1/auth/password/change`：已登录改密；
- `/api/v1/auth/recovery/key/rotate`：已登录恢复密钥轮换。

前端当前通过管理端设置区域承载这些能力。本期可以提供独立的设置导航和兼容跳转，但不能改变已有 API 的语义。

## 2. 本期目标、边界与凭据状态矩阵

### 2.1 必须达成

- 不依赖 `ctl`，仅凭当前 TOTP 完成 Owner 密码自助重置。
- 已登录 Owner 可以在操作时重新提交当前密码和 TOTP 后修改密码。
- 已登录 Owner 可以在操作时重新提交当前密码和 TOTP 后轮换恢复密钥；新密钥只显示一次，旧密钥原子失效。
- 密码自助重置、密码修改和完整恢复成功后吊销旧会话，不自动登录。
- 设置中心只暴露当前真实存在的普通设置、图床、NAS、运行状态、安全状态和会话管理。
- 保留现有恢复密钥完整恢复与运维轮换流程，二者互不绕过、不互相覆盖。
- TOTP 自助重置和恢复密钥轮换具备短时、单次、幂等/并发安全的事务语义；成功验证后记录实际匹配的 TOTP 时间步，已登录改密使用同一防重放规则但当前契约不带 `operationToken`；错误、日志和响应不泄露凭据。

### 2.2 明确延期或删除

以下内容不是本期验收项，施工和文档不得把它们描述成已支持能力：

- Passkey/WebAuthn；
- 多认证器表、认证器命名/吊销体系；
- 离线恢复码；
- 邮箱、SMTP、安全通知地址；
- OAuth、对象存储、搜索、Webhook 等不存在的集成；
- 多用户、`admin/editor` 角色和权限迁移；
- Vault、KEK/DEK、数据库 Secret 脱离 `.env`；
- 通用 append-only 审计事件表和 Notification Outbox；
- 全新 `timeblogctl` 产品化命令、bootstrap URL 和 doctor 命令。

### 2.3 凭据状态矩阵

| 材料 | 当前事实源 | Web 本期能力 | 丢失时的路径 | 本期禁止 |
|---|---|---|---|---|
| Owner 密码 | `users.password_hash` | TOTP 自助重置；已登录改密 | 仍有 TOTP 时走 Web；全丢时走完整恢复/运维保险 | 明文保存、回显、改环境变量覆盖数据库 |
| Owner TOTP | `users.totp_secret_encrypted` | 登录验证；作为 TOTP-only 改密证明 | 有恢复密钥时走完整恢复；全丢时走运维保险 | TOTP-only 改密同时替换 TOTP；返回旧 Secret |
| 恢复密钥 | `account_recovery_keys.key_hash` | 已登录高风险轮换；完整恢复后按现有流程轮换 | 明文遗失且仍有 TOTP：先 Web 改密，再登录轮换；三者全丢走运维轮换 | 永久万能密码、隐藏 URL、仅凭 Session 轮换 |
| Session Cookie | `sessions.token_hash` | 查看、吊销当前/其他会话 | 会话过期或吊销后重新登录 | 改 Cookie 命名、改 30/90 天期限、localStorage JWT |
| 图床/NAS Secret | `integration_settings.secret_encrypted` | 替换、测试、清除；状态不可回显 | 重新输入；若部署密钥故障走运维恢复 | 假造 SMTP/OAuth 表单、回显原文 |
| 运行根配置 | Compose/.env 及现有环境变量 | 只读状态 | 按现有部署运维流程处理 | 本期引入 Vault/KEK 或 Web 修改宿主机文件 |

## 3. 目标架构（不做全仓架构重写）

```text
浏览器
  ├─ Next.js Web：公开页、登录页、管理端设置中心
  └─ 同源 /api/v1/*
        └─ Go API：认证、会话、恢复、普通设置、已有集成与运行状态
              └─ PostgreSQL：当前账号、会话、恢复记录、设置与集成密文

服务器运维
  └─ deploy/rotate-recovery-key.sh --confirm
       └─ 已部署 Core 镜像 --rotate-recovery-key
```

### 3.1 前端职责

- 复用现有管理端布局和 API 客户端；新增设置导航、恢复入口、密码操作和会话管理视图。
- 不直接连接数据库，不持有 TOTP 加密密钥、恢复密钥哈希或集成 Secret。
- 恢复密钥/新凭据只在需要一次性展示的响应中存在于当前页面状态；页面关闭后不可再次读取。
- 敏感页面和恢复响应使用 `Cache-Control: no-store`，不交给 Service Worker、Analytics 或错误监控。

### 3.2 Go API 职责

- 服务端执行账号、TOTP、Session、CSRF、Origin、限流和事务校验。
- 高风险操作由服务端验证当前 Session、CSRF/Origin 和请求体中的当前密码 + TOTP，不接受前端隐藏按钮作为权限控制。
- 完整恢复继续复用现有 `account_recovery_*` 逻辑；TOTP 自助改密和已登录改密不得复制一套恢复密钥逻辑。
- 不新增数据库超级用户、Secret Provider 或宿主机写权限。

### 3.3 PostgreSQL 职责

继续使用当前表及已落地的最小增量：`users`、`sessions`、`mfa_challenges`、`login_attempts`、`account_recovery_keys`、`account_recovery_operations`、`account_recovery_audit`、`site_settings`、`integration_settings`、`totp_replay_guards`、`auth_operation_idempotency`。`mfa_challenges.purpose` 区分 `login` 与 `password_reset`；新增表只服务高风险恢复操作，不改变账号、会话或 Secret 模型。

## 4. 认证、会话与 Secret 约束

### 4.1 密码

- 密码继续只保存现有 Argon2id 哈希，最少 12 个字符；服务端限制最大输入长度，防止资源消耗型请求。
- 已登录改密和 TOTP 自助改密使用同一密码校验规则，不强制无理由周期换密。
- 任一改密成功都必须在数据库事务中更新密码并吊销旧会话；响应不建立完整登录 Session。

### 4.2 TOTP

- TOTP Secret 仍由现有加密机制保存；本期不迁移存储格式。
- TOTP-only 改密只接收动态码，不接收或回显 Secret；按 30 秒时间步接受当前步及相邻一步，成功后把实际匹配的 TOTP `step` 写入高风险操作防重放表，不把服务端当前步冒充为匹配步。
- 新流程必须有短时挑战、单次消费、原子防重放和账号/IP/账号+IP 三个维度限流；当前实现使用 5 分钟挑战、`password_reset` purpose、挑战哈希存储和 TOTP 时间步防重放。
- TOTP 是降级恢复凭据，不具备与密码+TOTP相同的保证，也不能宣称符合 AAL2 恢复要求。

### 4.3 会话

- Cookie 名称、属性、30 天滑动空闲期限和 90 天绝对期限保持现状。
- 密码改动或完整恢复成功后，吊销所有旧 Session；用户必须重新走密码 + TOTP 登录。恢复密钥轮换只吊销其他 Session，保留执行轮换的当前 Session。
- 会话页只展示 API 返回的会话标识、创建时间、最近活动和 `current`；`current` 仅用于前端标记当前请求所用的设备会话，不是设备指纹或额外认证因素。页面支持吊销单个会话或其他全部会话；当前模型不承诺密码更新时间、User-Agent、IP、设备摘要或原始 Token。
- 会话 API 方法与缓存边界固定为：仅允许 `GET /api/v1/auth/session` 读取当前 Session 与 CSRF/期限、仅允许 `GET /api/v1/auth/session/status` 读取当前 Session 是否有效、`GET /api/v1/auth/sessions` 读取会话列表、`DELETE /api/v1/auth/sessions/{id}` 吊销单个会话、`POST /api/v1/auth/sessions/revoke-others` 吊销其他会话。三个读取端点的敏感响应均由后端设置 `Cache-Control: no-store`，前端读取也使用 `no-store`；不得把未在 OpenAPI 暴露的字段或方法写入验收项。
- 已登录高风险操作要求当前 Session、CSRF/Origin 以及当前密码和 TOTP；当前会话本身不能作为唯一恢复证明。

### 4.4 Secret

- 继续使用当前 `integration_settings.secret_encrypted`、`TOTP_ENCRYPTION_KEY`、`CONFIG_ENCRYPTION_KEY` 等机制。
- Web 只提供状态、替换、测试和清除；输入留空表示保留，不把掩码值当作新 Secret。
- 本期不把数据库密码、加密根密钥或部署文件变成 Web 可改内容。

## 5. 恢复与改密流程

### 5.1 流程 A：已登录改密（推荐日常路径）

1. Owner 在安全设置中调用 `POST /api/v1/auth/password/change`。
2. 请求必须带当前 `timeline_session`、`X-CSRF-Token`、配置的同源 `Origin` 和 `Content-Type: application/json`；请求体为 `currentPassword`、六位 `code`、长度 12–1024 的 `newPassword`。
3. 服务端在事务内验证当前密码和 TOTP，写入新密码哈希、更新高风险 TOTP 时间步并吊销全部 Session。
4. `200` 只返回 `{ "ok": true }`，并清除当前 `timeline_session` Cookie；不自动登录，前端成功后立即跳转登录页（当前页面使用 `/login?changed=1`）。失败返回 `400/401/403/405/429/500`，统一使用 `application/problem+json`，不返回凭据。
5. 该接口当前不带 `operationToken`，也不提供提交不确定性解析；动态码时间步防重放和数据库事务保证一次性，不把重复 HTTP 请求误称为可重放幂等。若响应在提交附近丢失，先重新登录确认结果，不要盲目重复提交。

### 5.2 流程 B：仍有 TOTP 的 Web 自助改密

这是本期为“密码和恢复密钥丢失，但 TOTP 仍可用”新增的能力。

1. 用户从公开恢复页调用 `POST /api/v1/auth/recovery/totp/start`，必须提交 JSON 空对象 `{}` 和配置的同源 `Origin`；该接口不需要 Session 或 CSRF。失败返回 `400/403/405/429/500`，统一使用 `application/problem+json`。
2. 服务端返回 `challenge` 与 `expiresAt`；挑战有效期 5 分钟，服务端只保存挑战哈希。发起挑战本身进入 `owner-recovery` 限流桶，避免未完成挑战无限堆积。生产环境的 `Origin` 必须精确匹配 `APP_ORIGIN`；`localhost`/`127.0.0.1` 仅用于开发环境。
3. 用户调用 `POST /api/v1/auth/recovery/totp/complete`，提交 `challenge`、当前六位 TOTP `code`、长度 12–1024 的 `newPassword` 和客户端生成的 32-byte base64url `operationToken`；不要求恢复密钥，不允许提交新 TOTP 或新恢复密钥。
4. 服务端验证 Owner 当前 TOTP、短时挑战、单次消费、账号/IP/账号+IP 限流和请求完整性。`operationToken` 相同且完整载荷相同可在 24 小时操作记录有效期内安全重试；相同 Token 搭配不同载荷返回 `409`。
5. 成功事务只更新密码、更新 TOTP 高风险操作时间步、删除挑战并吊销全部 Session；原 TOTP 和恢复密钥保持不变。`200` 只返回 `{ "ok": true }`，不创建 Session；失败按契约返回 `400/401/403/405/409/429/500`，统一使用 `application/problem+json`，不得枚举账号状态。
6. 用户必须用新密码和同一 TOTP 重新登录，再在安全设置中单独轮换已经遗失的恢复密钥；TOTP-only 路径永远不能修改 TOTP 或恢复密钥。

该流程是**明确的降级恢复**：TOTP 属于单一持有因素，不能抵抗钓鱼，也不能证明 TOTP Secret 没有被复制。若未来要求严格 AAL2，应改为恢复码/独立通知或其他第二恢复因素，而不是继续扩大 TOTP-only 权限。

### 5.3 流程 C：已登录恢复密钥轮换

1. Owner 在安全设置中调用 `POST /api/v1/auth/recovery/key/rotate`。
2. 请求必须带当前 `timeline_session`、`X-CSRF-Token`、配置的同源 `Origin` 和 `Content-Type: application/json`；请求体为当前 `password`、六位 `code`、客户端生成的 32-byte base64url `operationToken` 与 32-byte base64url `newRecoveryKey`。活动 Session 不能单独满足条件。
3. 事务内验证当前密码和 TOTP，原子消费旧的未使用恢复密钥并写入新哈希；`operationToken` 相同且载荷相同可在 24 小时操作记录有效期内安全重试，载荷不同时返回 `409`。若提交响应状态不确定，只有操作记录关联的新恢复密钥仍 active 时才可判定本次提交成功；已被后续轮换替代时不得确认旧结果。
4. `200` 返回 `{ "ok": true, "recoveryKey": newRecoveryKey }`；仅本次响应展示新密钥，服务端只保存哈希并设置 `Cache-Control: no-store`。失败按契约返回 `400/401/403/405/409/429/500`，统一使用 `application/problem+json`。
5. 成功后吊销其他 Session，保留执行轮换的当前 Session；前端成功后刷新会话列表。不创建新的 Session。页面关闭或响应丢失后不得再次查询明文，不能通过数据库哈希反解。

如果用户没有保存新密钥，不能通过数据库哈希反解；必须重新走已登录轮换或现有运维轮换流程。

### 5.4 流程 D：现有恢复密钥完整恢复（保持现状）

- 入口继续为 `/recovery` 页面和 `/api/v1/auth/recovery/account`。
- 请求必须是 `Content-Type: application/json` 的单一 JSON 对象；服务端拒绝 `null`、数组、未知字段、尾随 JSON 值和超过 2 MiB 的请求体。
- 恢复密钥验证成功后，服务端在同一事务内更新密码、TOTP 和新恢复密钥，清理旧 TOTP Secret 对应的高风险 replay guard，并吊销全部旧会话。
- 操作 Token 必须单次、短时、绑定完整请求；重复提交同一请求可安全重试，改变 payload 必须冲突。
- 成功响应仅展示本次新恢复材料并使用 `Cache-Control: no-store`；不得把已有 Secret 从服务端读取后返回。完整恢复与 TOTP-only 恢复成功后，前端均使用 `/login?recovered=1`，该参数仅属于两条恢复路径；已登录改密使用 `/login?changed=1`。完整恢复失败返回 `400/401/403/405/409/429/500`，统一使用 `application/problem+json`。
- 该流程是“拥有恢复密钥”的完整恢复，不因新增 TOTP-only 路径而改变语义。

### 5.5 流程 E：密码、TOTP、恢复密钥全部丢失

- 继续使用受控服务器本地 break-glass：`deploy/rotate-recovery-key.sh --confirm` 先轮换出临时恢复密钥，再使用 `/recovery` 完整恢复。
- 现有脚本会做发布目录、锁、权限、备份、镜像和数据库提交状态核验；失败或状态未知时不得自动重跑。
- 本期不新增或宣称已经存在 `timeblogctl auth recover`、bootstrap URL 或其他公网后门。
- “完全不使用服务器运维入口也能恢复三种凭据全丢”不是本期目标，也不属于安全可接受的承诺。

### 5.6 凭据状态与动作矩阵

| 密码 | TOTP | 恢复密钥 | 用户可用路径 |
|---|---|---|---|
| 有 | 有 | 有/无 | 正常登录；已登录改密；恢复密钥丢失时单独轮换 |
| 丢失 | 有 | 有 | TOTP 自助改密，之后正常登录 |
| 丢失 | 有 | 丢失 | TOTP 自助改密，登录后轮换恢复密钥 |
| 有 | 丢失 | 有 | 现有恢复密钥完整恢复并重新设置 TOTP |
| 有 | 丢失 | 丢失 | 无 Web 自助路径，走服务器本地 break-glass |
| 丢失 | 丢失 | 丢失 | 无 Web 自助路径，走服务器本地 break-glass |

## 6. 真实能力设置中心

### 6.1 页面分区

前端可以用独立设置导航，也必须保留现有管理端设置入口的兼容跳转：

- **概览**：TOTP 已配置状态、恢复密钥有效状态、活动会话数量、图床/NAS 状态。
- **安全**：已登录改密、TOTP 自助恢复说明、恢复密钥轮换、恢复入口说明。
- **会话**：会话标识、创建时间、最近活动、`current` 当前设备标记、单个吊销、退出其他全部会话；`current` 仅用于前端标记当前请求所用的设备会话，不是设备指纹或认证因素；不展示 User-Agent、IP、设备摘要或密码更新时间。
- **常规设置**：现有 `site_settings` 的站点名称、简介、时区及当前已支持字段。
- **集成**：现有 `external_image_host` 与 `nas_backup`；只提供真实字段、状态和无副作用测试。
- **运行状态**：复用现有 `/api/v1/admin/runtime-status`，只读展示数据库、TOTP、加密配置和恢复密钥状态。

### 6.2 不放入设置中心的内容

- 不展示数据库密码、TOTP Secret、恢复密钥哈希、`CONFIG_ENCRYPTION_KEY` 或其他运行时明文。
- 不提供 SMTP、OAuth、Passkey、恢复码、对象存储、通用 Secret 名称输入框。
- 不用静态卡片声称“邮箱已验证”“Vault 已解密”“通知已发送”等当前没有真实消费者的状态。

## 7. API 契约边界

### 7.1 当前已落地路径（不得改名或改语义）

```text
POST /api/v1/auth/login/password
POST /api/v1/auth/login/totp
POST /api/v1/auth/recovery/account
POST /api/v1/auth/recovery/totp/start
POST /api/v1/auth/recovery/totp/complete
POST /api/v1/auth/password/change
POST /api/v1/auth/recovery/key/rotate
POST /api/v1/auth/logout
GET  /api/v1/auth/session
GET  /api/v1/auth/session/status
GET  /api/v1/auth/sessions
DELETE /api/v1/auth/sessions/{id}
POST  /api/v1/auth/sessions/revoke-others

GET/PATCH /api/v1/admin/settings
GET       /api/v1/admin/runtime-status
GET/PATCH /api/v1/admin/integrations/{name}
POST      /api/v1/admin/integrations/external_image_host/test
```

### 7.2 新增恢复 API 契约（以当前 OpenAPI 和实现为准）

| API | 请求体与认证 | 成功结果 | 失败与安全语义 |
|---|---|---|---|
| `POST /api/v1/auth/recovery/totp/start` | 必须为 JSON 空对象 `{}`；要求配置的同源 `Origin`，不需要 Session/CSRF | `200 {challenge, expiresAt}`；挑战 5 分钟有效 | `400/403/405/429/500`，错误使用 `application/problem+json`；挑战只保存哈希，发起也计入 `owner-recovery` 账号/IP/账号+IP 限流 |
| `POST /api/v1/auth/recovery/totp/complete` | `challenge`、六位 `code`、12–1024 字符 `newPassword`、32-byte base64url `operationToken`；要求同源 `Origin`，不需要 Session/CSRF | `200 {ok:true}`；只改密码、更新 TOTP 操作时间步、删除挑战、吊销全部 Session，不创建 Session；前端跳转 `/login?recovered=1` | `400/401/403/405/409/429/500`，错误使用 `application/problem+json`；相同 Token + 相同载荷 24 小时内可安全重试，载荷冲突 `409`；不改 TOTP/恢复密钥 |
| `POST /api/v1/auth/password/change` | `currentPassword`、六位 `code`、12–1024 字符 `newPassword`；需要 Session、CSRF、同源 `Origin` | `200 {ok:true}`；改密码、吊销全部 Session、清除当前 Cookie，不自动登录；前端跳转 `/login?changed=1` | `400/401/403/405/429/500`，错误使用 `application/problem+json`；当前契约无 `operationToken`，也不提供提交不确定性解析，按实际匹配的 TOTP 时间步防重放 |
| `POST /api/v1/auth/recovery/key/rotate` | `password`、六位 `code`、32-byte base64url `operationToken`、32-byte base64url `newRecoveryKey`；需要 Session、CSRF、同源 `Origin` | `200 {ok:true,recoveryKey}`；旧密钥原子失效、新哈希写入，只展示本次新密钥，吊销其他 Session、保留当前 Session，前端刷新会话列表 | `400/401/403/405/409/429/500`，错误使用 `application/problem+json`；相同 Token + 相同载荷 24 小时内可安全重试，载荷冲突 `409`；提交状态不确定时仅关联新密钥仍 active 才可判成功；响应 `no-store` |

五个敏感恢复/改密接口（包括现有完整恢复）都要求 `Content-Type: application/json`，请求体必须是单一严格 JSON 对象并拒绝 `null`、未知字段、尾随 JSON 值和超过 2 MiB 的请求体；服务端统一设置 `Cache-Control: no-store`（改密还发送清除当前 Session Cookie），错误响应使用 `Content-Type: application/problem+json` 并通过通用问题详情避免凭据或账号状态枚举。生产环境的 `RequiredOrigin` 必须精确匹配 `APP_ORIGIN`；本地 `localhost`/`127.0.0.1` Origin 仅允许开发环境使用。无 Cookie 的 TOTP 恢复路径不把 Origin 当作身份凭据。

### 7.3 统一接口约束

- Cookie 写接口继续校验 CSRF Token、Required Origin 和 Content-Type；无 Cookie 的公开 TOTP 恢复接口只要求 Required Origin + JSON，不把 Origin 当作身份凭据。敏感读取接口 `GET /api/v1/auth/session`、`GET /api/v1/auth/session/status` 和 `GET /api/v1/auth/sessions` 仅允许 GET，并设置 `Cache-Control: no-store`；读取失败按运行时契约返回 `401/405/500`，统一使用 `application/problem+json`。
- 恢复/改密请求使用 HTTPS、`Cache-Control: no-store`、有限请求体和通用错误信息。
- 恢复/改密失败响应使用 `application/problem+json`，不得以普通成功 JSON 媒体类型伪装错误。
- TOTP 挑战 5 分钟有效且单次消费；TOTP 与恢复密钥轮换的操作记录按当前实现保留 24 小时、以 payload MAC 绑定请求，重复并发提交必须原子裁决；成功后记录实际匹配的 TOTP 时间步。已登录改密使用同一防重放规则但不带操作 Token；恢复密钥轮换提交状态不确定时，只有关联新密钥仍 active 才可判定成功。
- 日志、错误监控和审计元数据不得包含密码、TOTP Secret、动态码、恢复密钥、Session Token 或集成 Secret。
- 任何失败不得部分更新账号材料；提交状态不确定时先只读确认，不自动重试。

## 8. 数据模型与迁移边界

### 8.1 保持的表

本期以现有迁移为准，不建立施工图中的未来表：

- `users`：单 Owner 密码哈希和加密 TOTP；
- `sessions`：服务端会话、CSRF 哈希、空闲/绝对期限、吊销；
- `mfa_challenges`：登录 TOTP 挑战和 `password_reset` TOTP 自助恢复挑战；新增 `purpose` 约束与用途/过期索引；
- `login_attempts`：当前密码/TOTP/恢复阶段限流；
- `account_recovery_keys`、`account_recovery_operations`、`account_recovery_audit`：恢复密钥和现有完整恢复事务；
- `totp_replay_guards`：按 Owner 保存高风险操作最后接受的服务端 TOTP 时间步；不改变 `users` 模型或登录挑战语义；
- `auth_operation_idempotency`：保存 TOTP 自助恢复和恢复密钥轮换的操作哈希、payload MAC、可选恢复密钥 ID 与过期时间；不保存明文密码、动态码或恢复密钥；
- `site_settings`：普通站点设置；
- `integration_settings`：当前图床/NAS 配置和加密 Secret。

### 8.2 允许的最小增量

- 已按当前后端迁移增加 `mfa_challenges.purpose`、`totp_replay_guards` 和 `auth_operation_idempotency`；这些增量只覆盖挑战过期、TOTP 时间步防重放与高风险操作幂等。
- 已登录密码修改和恢复密钥轮换继续写入现有 `account_recovery_audit`（恢复密钥轮换带旧密钥 ID）；不借此引入通用审计/通知系统。
- 不回填邮箱、角色、`auth_generation`、多认证器、恢复码、Vault 版本等未来字段。

### 8.3 迁移原则

- 不删除或重命名现有账号、会话、Secret 和恢复密钥列。
- 不把现有密文重新解释为另一种密钥体系。
- 不在未完成备份和回滚核验前执行破坏性迁移。
- 新功能失败时，旧登录、现有 `/recovery` 和运维轮换必须继续可用。

## 9. 安全基线与威胁边界

### 9.1 TOTP-only 的明确定位

TOTP-only 是单 Owner 个人部署下的可用性与安全性的折中：它解决“密码/恢复密钥丢失但 TOTP 仍在”，但不等同于密码 + TOTP。TOTP 可被钓鱼、转发或从受感染设备复制；因此不能让它顺便替换 TOTP、恢复密钥或保留旧会话。

严格要求双因素恢复、AAL2 或高价值系统时，必须改用恢复码 + 另一因素、独立验证信道或其他更强方案；本期不伪造这些能力。

### 9.2 必须防护

- 账号级和 IP 级独立限流，避免分布式猜测六位码；
- 动态码时间窗口明确、成功后单次消费、防并发重放；
- 成功后全部会话吊销、重新登录、不自动登录；
- 恢复页面不回显或重新生成原 TOTP；
- 错误模糊、无账号枚举、敏感响应禁止缓存；
- 高风险已登录动作需要在请求中重新提交当前密码和 TOTP，不能只凭长时间 Session；
- 安全事件写入当前可用审计/日志，不写凭据；独立邮件通知属于延期能力。

### 9.3 禁止实现

- 永久万能恢复密码、隐藏公网 URL、硬编码后门；
- 只凭活动 Session、IP、User-Agent、安全问题或公开信息改密；
- TOTP-only 同时修改 TOTP 或恢复密钥；
- 把 Secret、Token、Cookie、验证码或密码写入日志、前端公共变量或 URL；
- 为本期目标引入 Passkey、恢复码、SMTP/OAuth、角色、Vault/KEK/数据库 Secret 重构的伪接口。

## 10. 实施顺序

### 阶段 0：冻结并回归现有恢复

1. 备份数据库、部署配置和当前镜像。
2. 回归现有 `/recovery`、恢复操作幂等性、会话吊销和 `deploy/rotate-recovery-key.sh --confirm`。
3. 确认 TOTP-only 只作为降级恢复写入文档和界面提示。

### 阶段 1：TOTP 自助改密与已登录改密

1. 按 `POST /api/v1/auth/recovery/totp/start`、`POST /api/v1/auth/recovery/totp/complete` 和 `POST /api/v1/auth/password/change` 的当前契约实现前端调用与错误处理。
2. 回归 TOTP 验证、5 分钟挑战、限流、防重放、密码事务和全部会话吊销。
3. 实现公开 TOTP 降级恢复和已登录密码改密页面；改密成功后清除当前 Cookie 并返回登录页。
4. 不加入 TOTP/恢复密钥替换。

### 阶段 2：已登录恢复密钥轮换

1. 按 `POST /api/v1/auth/recovery/key/rotate` 的当前契约实现只显示一次的新恢复密钥响应和幂等重试。
2. 原子失效旧密钥、写入新哈希、记录操作并吊销其他 Session，保留当前 Session。
3. 回归现有运维轮换，确保 Web 轮换不会破坏最后保险。

### 阶段 3：真实能力设置中心与会话页

1. 拆分现有设置视图，保持现有 API 和字段。
2. 增加安全概览、密码/恢复入口、恢复密钥轮换和会话管理。
3. 只接入图床、NAS、普通设置和运行状态。
4. 保留旧管理端设置入口跳转。

### 阶段 4：验收与延期项清理

1. 更新 OpenAPI、前后端测试和本操作文档。
2. 扫描页面、日志、错误监控和构建产物，确认没有 Secret 泄露。
3. 明确延期 Passkey、恢复码、邮箱通知、Vault/KEK、角色和通用审计，不把它们留成半成品入口。

## 11. 测试矩阵

### 11.1 现有能力回归

- 密码 + TOTP 登录成功/失败；
- 现有恢复密钥恢复成功、错误密钥、过期密钥、并发和幂等重试；
- 恢复成功后旧会话全部失效；
- 恢复密钥轮换脚本的备份、权限、锁和提交状态判断；
- 图床/NAS Secret 替换、测试、清除和不回显；
- 普通设置读写与管理端 CSRF/Origin。

### 11.2 新增恢复能力

- `POST /api/v1/auth/recovery/totp/start` 只接受 JSON 空对象并返回 5 分钟挑战；生产 Origin 仅匹配 `APP_ORIGIN`，本地 Origin 仅用于开发；
- `POST /api/v1/auth/recovery/totp/complete` 使用六位码、一次性挑战和 32-byte `operationToken` 完成自助改密；
- 同一动态码/挑战不能并发或重复消费；
- 发起和提交错误都受到账号级、IP 级及组合桶限流；
- TOTP-only 不能修改 TOTP 或恢复密钥；
- 成功后所有旧会话失效且没有自动登录；
- 密码和恢复密钥丢失但 TOTP 仍在时可先改密，再登录轮换恢复密钥；
- 已登录改密和恢复密钥轮换要求当前 Session、CSRF、同源 Origin、当前密码和当前 TOTP；
- 已登录改密成功清除当前 Cookie 并跳转登录页；恢复密钥轮换保留当前 Session、吊销其他 Session，成功后刷新会话列表；
- 丢失 TOTP 时，TOTP-only 被拒绝，恢复密钥完整恢复仍可用；
- 三种凭据全丢时，Web 端不假装可恢复，运维 break-glass 仍可执行。

### 11.3 安全与文档一致性

- 不同账号/状态的错误信息不产生枚举差异；
- 恢复响应、页面缓存、Service Worker、日志和错误监控不保存敏感值；
- 最终后端 API 路径、字段、状态码和文档完全一致；
- 延期功能不存在可点击但无消费者的页面或 API。

## 12. 验收标准

- [ ] 现有单 Owner、`users`、`sessions`、TOTP 加密和集成 Secret 机制未被重构。
- [ ] 现有恢复密钥完整恢复和运维轮换继续可用。
- [ ] 仍有 TOTP 时可以从 Web 自助改密；该路径明确标注为降级恢复。
- [ ] TOTP-only 不修改 TOTP、不修改恢复密钥、不自动登录。
- [ ] 自助改密、已登录改密和完整恢复成功后吊销旧会话。
- [ ] 已登录密码修改和恢复密钥轮换要求当前 Session、CSRF/Origin 及当前密码和 TOTP 重新认证。
- [ ] 恢复密钥可以在已登录安全设置中轮换，明文仅显示一次且旧密钥原子失效。
- [ ] 会话 API 按 OpenAPI 的方法提供当前 Session、会话列表、单个吊销和退出其他会话；读取端点仅允许 GET，列表展示 `id`、`createdAt`、`lastSeen`、仅用于标记当前设备的 `current`，读取使用 `no-store`，Cookie 与 30/90 天策略保持现状。
- [ ] 设置中心只展示站点设置、图床、NAS、运行状态、安全状态和会话等真实能力。
- [ ] Secret 不回显、不进 URL、日志、前端公共变量或错误监控。
- [ ] TOTP 恢复具备一次性、防重放、账号/IP 限流、模糊错误和 `no-store`。
- [ ] 密码、TOTP、恢复密钥全丢时仍有受控本地 break-glass；不声称 Web 可独立解决。
- [ ] Passkey、恢复码、SMTP/OAuth、邮箱通知、多角色、Vault/KEK/数据库 Secret 重构等延期内容不进入本期验收。
- [ ] 当前 API 契约已回填；验收时核对文档、OpenAPI、前端和后端路径、字段、状态码与 Cookie/会话副作用一致。
- [ ] 完整恢复与新增敏感端点均拒绝 `null`、未知字段、尾随 JSON 和超限请求体；失败响应媒体类型为 `application/problem+json`。

## 13. 明确禁止与止损规则

### 13.1 禁止

- 把 TOTP-only 说成与密码 + TOTP 同等安全；
- 把当前恢复密钥哈希反解、打印或从 Web 返回；
- 用 `ADMIN_PASSWORD`、环境变量变化或隐藏公网参数绕过数据库账号状态；
- 让 Web 进程修改部署 Secret 文件、数据库超级用户或宿主机权限；
- 为“看起来完整”而添加没有真实消费者的 SMTP、OAuth、Passkey、恢复码、通知或 Vault 页面。

### 13.2 止损

- 发现 TOTP 泄露、数据库/加密密钥泄露或恢复端点异常尝试时，立即停用 TOTP-only，改走现有 break-glass 并轮换 TOTP/恢复密钥。
- 任何事务提交状态不确定时，先只读核验；不得重复提交、删除备份或覆盖已激活凭据。
- 新增 API 不能通过安全测试、并发测试或文档契约校对时，保留现有恢复路径，暂不开放新增入口。
- 用户丢失全部三类凭据时，明确提示服务器本地恢复，不以弱问题、活动 Session 或永久 Token 代替。

## 14. 设计依据

- [OWASP Forgot Password Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html)
- [OWASP Multifactor Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Multifactor_Authentication_Cheat_Sheet.html)
- [OWASP Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)
- [NIST SP 800-63B-4：Single-Factor OTP](https://pages.nist.gov/800-63-4/sp800-63b.html#single-factor-otp)
- [NIST SP 800-63B-4：Account Recovery](https://pages.nist.gov/800-63-4/sp800-63b.html#account-recovery)
- 项目现有实现与运维说明：`services/core/`、`deploy/rotate-recovery-key.sh`、`docs/operations/account-recovery.md`。
