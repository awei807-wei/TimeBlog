# 管理员账户恢复与恢复密钥轮换

本文说明 TimeBlog 当前单 Owner 账号的恢复边界、已经落地的 break-glass 运维流程，以及本期新增 Web 自助改密的安全边界。

## 当前状态与凭据边界

| 材料 | 当前来源/存储 | 用途 | 是否由 Web 回显 |
|---|---|---|---|
| Owner 密码 | `users.password_hash`；首次建库由 `ADMIN_PASSWORD` 引导 | 密码登录、已登录改密 | 否 |
| Owner TOTP Secret | `users.totp_secret_encrypted`；由 `TOTP_ENCRYPTION_KEY` 解密 | TOTP 登录和本期 TOTP 自助改密证明 | 否 |
| 恢复密钥 | `account_recovery_keys.key_hash` | `/recovery` 完整恢复；有效期 90 天 | 仅在生成/恢复成功时展示新明文一次 |
| 图床/NAS Secret | `integration_settings.secret_encrypted` | 已有集成调用 | 否，仅显示配置状态和测试状态 |
| 运行配置 | `DATABASE_URL`、`CONFIG_ENCRYPTION_KEY`、`TOTP_ENCRYPTION_KEY` 等现有环境配置 | API 启动和加密 | 否 |

`ADMIN_PASSWORD`、`ADMIN_TOTP_SECRET` 只用于账号不存在时的首次建库引导。Owner 已存在后，修改它们不会覆盖数据库中的当前凭据。`ACCOUNT_RECOVERY_KEY_BOOTSTRAP` 只允许恢复密钥表从未有历史记录时的一次引导；已有历史后不能靠重新设置环境变量补发密钥。

本期保持以上模型，不引入邮箱、Passkey、恢复码、多用户、Vault/KEK、数据库 Secret 重构或通用通知系统。

## 已落地的完整恢复

浏览器入口为 `/recovery`，API 为 `POST /api/v1/auth/recovery/account`。它要求提交当前恢复密钥和新密码，并由浏览器生成操作幂等材料、新恢复密钥和新 TOTP Secret。

请求必须使用 `Content-Type: application/json`，并且只能包含一个 JSON 对象。服务端拒绝 `null`、数组、未知字段、尾随 JSON 值和超过 2 MiB 的请求体；错误响应使用 `Content-Type: application/problem+json`。

成功恢复在一个数据库事务中完成：

1. 校验仍有效且未使用的恢复密钥；
2. 写入新密码哈希和新加密 TOTP，并清理旧 TOTP Secret 对应的高风险 replay guard；
3. 吊销全部现有 Session；
4. 消费旧恢复密钥并写入新的 90 天恢复密钥哈希；
5. 记录 `account_recovery_audit`；
6. 返回本次浏览器生成的新恢复密钥和 TOTP 设置信息。

同一 `operationToken` 和完全相同的请求可以安全重试；相同 Token 搭配不同请求会冲突。成功响应使用 `Cache-Control: no-store`，页面关闭后不能再次向服务端查询明文凭据。恢复完成后不会自动建立登录会话，用户必须重新使用新密码和新 TOTP 登录；完整恢复和 TOTP-only 恢复两条恢复路径成功后均使用 `/login?recovered=1`，已登录改密仅使用 `/login?changed=1`。完整恢复失败返回 `400/401/403/405/409/429/500`，均使用 `Content-Type: application/problem+json`。

## 本期新增的 Web 能力（当前后端契约）

### 密码和恢复密钥都丢失，但 TOTP 仍在

用户可以从公开恢复页使用当前 TOTP 动态码重置密码。这是**降级恢复**，不是与“密码 + TOTP”同等的认证强度。当前接口为：

- `POST /api/v1/auth/recovery/totp/start`：提交 JSON 空对象 `{}`，要求配置的同源 `Origin`；不需要 Session 或 CSRF。成功返回 `challenge` 与 `expiresAt`，挑战有效 5 分钟，服务端只保存挑战哈希。
- `POST /api/v1/auth/recovery/totp/complete`：提交 `challenge`、六位数字 `code`、长度 12–1024 的 `newPassword` 和客户端生成的 32-byte base64url `operationToken`；同样要求同源 `Origin`，不需要 Session 或 CSRF。

两步都必须使用 `Content-Type: application/json`，响应禁止缓存。开始接口失败返回 `400/403/405/429/500`；完成接口成功返回 `{ "ok": true }`，不创建登录会话，成功后前端使用 `/login?recovered=1`；完成接口失败返回 `400/401/403/405/409/429/500`。上述失败响应均使用 `Content-Type: application/problem+json`。

生产环境的 `Origin` 必须精确匹配 `APP_ORIGIN`；`http://localhost:3000` 和 `http://127.0.0.1:3000` 只用于开发环境，不能作为生产恢复入口的信任来源。

安全语义：

- 只验证动态码，不接收 TOTP Secret；
- 挑战短时有效、单次消费，并按实际匹配的 TOTP `step` 原子防重放；当前实现接受 30 秒当前步及相邻一步，成功后记录实际命中的时间步；
- 发起与完成都经过账号级、IP 级和账号+IP 组合限流；被限流时返回 `429` 与 `Retry-After`；
- 只更新密码，不修改 TOTP，不修改恢复密钥；
- 成功后吊销全部旧 Session，不自动登录；
- 相同 `operationToken` 搭配完全相同的载荷可在 24 小时操作记录有效期内安全重试；不同载荷返回 `409`；
- 用户重新登录后，在安全设置中单独轮换已经遗失的恢复密钥。

完成接口返回 `400/401/403/405/409/429/500`；错误响应使用 `Content-Type: application/problem+json`，错误信息保持通用，不泄露凭据或账号状态。该路径仍是 TOTP-only 降级恢复，不能被描述为与密码 + TOTP 等价。

### 已登录改密与恢复密钥轮换

已登录 Owner 可以在安全设置中调用以下接口：

`POST /api/v1/auth/password/change`：需要当前 `timeline_session`、`X-CSRF-Token`、同源 `Origin` 和 JSON 请求体 `currentPassword`、六位 `code`、长度 12–1024 的 `newPassword`。成功返回 `{ "ok": true }`，更新密码、吊销全部 Session、清除当前 Cookie，不自动登录；前端成功后跳转 `/login?changed=1`；失败按契约返回 `400/401/403/405/429/500`，错误使用 `application/problem+json`。当前接口没有 `operationToken`，也不提供提交不确定性解析，依靠实际匹配的 TOTP 时间步防重放；若响应在提交附近丢失，先重新登录确认结果，不要盲目重复提交。
- `POST /api/v1/auth/recovery/key/rotate`：需要当前 Session、CSRF、同源 Origin 和 JSON 请求体 `password`、六位 `code`、32-byte base64url `operationToken`、32-byte base64url `newRecoveryKey`。成功返回 `{ "ok": true, "recoveryKey": newRecoveryKey }`，事务内原子失效旧密钥并保存新哈希，只展示本次明文，吊销其他 Session、保留当前 Session；前端成功后刷新会话列表；响应 `Cache-Control: no-store`。相同 Token + 相同载荷 24 小时内可安全重试，不同载荷返回 `409`；提交状态不确定时，只有操作记录关联的新密钥仍 active 才可判定成功；失败按契约返回 `400/401/403/405/409/429/500`，错误使用 `application/problem+json`。

两个接口都要求 `Content-Type: application/json`，不能只凭长期 Session 完成高风险操作；错误响应使用 `application/problem+json`。新恢复密钥无法再次查询，服务端只保存哈希；不能通过不存在的命令或 URL 代替实现。

### 会话接口与设置中心显示边界

会话接口严格按当前 OpenAPI 方法使用：

- `GET /api/v1/auth/session`：仅允许 GET，读取当前 Session 的认证状态、CSRF Token 和期限信息；后端响应使用 `Cache-Control: no-store`；
- `GET /api/v1/auth/session/status`：仅允许 GET，读取当前 Session 是否仍有效和稳定 CSRF Token，后端响应使用 `Cache-Control: no-store`；
- `GET /api/v1/auth/sessions`：仅允许 GET，读取活动会话列表，字段为 `id`、`createdAt`、`lastSeen`、`current`；`current` 仅用于前端标记当前请求所用的设备会话，不是设备指纹或认证因素；前端以 `no-store` 读取；
- `DELETE /api/v1/auth/sessions/{id}`：吊销单个会话，需要 CSRF 和 Origin；
- `POST /api/v1/auth/sessions/revoke-others`：吊销其他会话，需要 CSRF 和 Origin。

设置中心只承诺会话标识、创建时间、最近活动、当前设备标记和吊销操作。不承诺密码更新时间、User-Agent、IP、设备摘要或其他未出现在 OpenAPI `Session` schema 的字段；不得把这些字段写成验收项。

三个会话读取端点的失败状态为 `401/405/500`，统一使用 `Content-Type: application/problem+json`；会话吊销端点另按资源与方法返回 `401/403/404/405/500`。不得用普通成功 JSON 媒体类型返回问题详情。

## 已落地的 break-glass：恢复密钥轮换

当有效恢复密钥的明文副本遗失，但仍有生产 VPS root/受信部署权限时，使用现有脚本：

```bash
ssh vps1
cd /home/shiyi/TimeBlog
./deploy/rotate-recovery-key.sh --confirm
```

当前脚本实际调用已部署 Core 镜像的 `--rotate-recovery-key --output ...`，不是 `timeblogctl`。仓库目前没有已落地的 `timeblogctl auth recover` 命令；本文件不把它写成可执行步骤。

脚本执行前后会检查：

1. 必须显式传入 `--confirm` 且以 root 运行；
2. 项目、`deploy/`、Compose、运行环境、当前发布文件、发布锁和轮换辅助脚本的所有者、权限、路径祖先和符号链接状态；
3. 发布锁和独立恢复运行目录，避免与发布并发；
4. 当前不可变镜像、PostgreSQL、API、Worker、Web 和 HTTP 健康状态；
5. 轮换前 PostgreSQL custom dump、`pg_restore --list` 可解析性和 SHA-256 校验；
6. 容器输出文件的普通文件类型、非空、0600 权限和 UID 65532 所有权；
7. 数据库有效恢复密钥数量和 `recovery_key_rotated` 审计增量，以区分已提交、未提交和状态未知。

脚本不会执行数据库恢复写入、Compose `down`、卷删除或自动回滚。提交状态已提交或未知时，必须保留受保护的候选恢复密钥和诊断材料，先只读核验，不要重复运行。

## 轮换成功后的操作

脚本只打印受保护文件路径，不打印密钥内容。成功时运行目录包含：

- `recovery-key.txt`：当前已激活的临时恢复密钥，root-only、0600；
- `timeline-before-rotation.dump`：轮换前数据库备份，root-only、0600；
- `timeline-before-rotation.dump.sha256`：备份校验和；
- `rotation.stderr.log`：权限受保护的诊断日志。

在不录屏、不共享终端、不写入 shell history 的受控会话中读取 `recovery-key.txt`，访问生产 `/recovery`：

1. 输入临时恢复密钥和新密码；
2. 恢复成功后立即把页面只展示一次的新恢复密钥保存到受控密码库；
3. 使用同一页面生成的 TOTP 二维码或独立 Base32 设置密钥配置本地 Authenticator；
4. 重新登录，确认新密码 + TOTP 可用且旧会话均已吊销；
5. 确认新恢复材料可用后，按备份保留策略处理受保护运行目录；不得复制到 Git、聊天、工单或普通笔记。

恢复密钥不是 TOTP 设置密钥；完整 `otpauth://` URI 也不能粘贴到 Authenticator 的手动密钥输入框。不要把任何恢复材料提交给外部二维码或在线转换服务。

## 凭据丢失决策表

| 密码 | TOTP | 恢复密钥 | 处理 |
|---|---|---|---|
| 丢失 | 保留 | 丢失或保留 | `POST /api/v1/auth/recovery/totp/start` → `complete` 自助改密；登录后单独轮换恢复密钥 |
| 丢失 | 保留 | 保留 | Web TOTP 自助改密，或继续使用现有完整恢复 |
| 保留 | 丢失 | 保留 | 使用 `/recovery` 完整恢复并重新设置 TOTP |
| 保留 | 丢失 | 丢失 | 使用服务器本地 break-glass 轮换恢复密钥，再走 `/recovery` |
| 丢失 | 丢失 | 丢失 | 使用服务器本地 break-glass；不存在安全的纯用户侧自救路径 |

TOTP-only 路径不能修改 TOTP 或恢复密钥。否则一个被钓鱼的动态码就能同时替换全部恢复材料，直接扩大接管和拒绝服务影响。

## 失败处理与止损

- 健康检查、备份或权限预检失败：轮换尚未执行，先修复前置条件。
- 数据库核验确认未提交：候选密钥不能用于恢复；保留材料供审计后再处理。
- 提交已确认但后置健康检查失败：保留已激活 `recovery-key.txt`，不要用旧备份覆盖数据库，也不要重跑轮换。
- 提交状态未知：保留候选文件和日志，只读核验数据库有效密钥数量与审计事件，不要重复执行。
- 怀疑 TOTP、加密密钥或数据库泄露：立即关闭 TOTP-only 自助路径，使用 break-glass 轮换 TOTP/恢复密钥并核查所有会话。
- 任何新增 Web 恢复 API 在一次性、防重放、账号/IP 限流、全会话吊销或文档契约校对上不通过时，保留现有 `/recovery` 和 break-glass，不开放新增入口。

## 安全依据

- [OWASP Forgot Password Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html)
- [OWASP Multifactor Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Multifactor_Authentication_Cheat_Sheet.html)
- [NIST SP 800-63B-4：Single-Factor OTP](https://pages.nist.gov/800-63-4/sp800-63b.html#single-factor-otp)
- [NIST SP 800-63B-4：Account Recovery](https://pages.nist.gov/800-63-4/sp800-63b.html#account-recovery)
