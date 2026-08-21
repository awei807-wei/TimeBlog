# 管理员账户恢复与恢复密钥轮换

本文说明管理员密码、TOTP 与恢复密钥之间的边界，以及恢复密钥遗失时的生产运维流程。恢复密钥轮换属于受控的 break-glass 操作：它只补发一个新的恢复入口，不直接修改管理员密码或 TOTP。

## 密钥边界

- `ADMIN_PASSWORD` 是首次建库时创建 `owner` 账户使用的明文引导密码。服务把它生成 Argon2id 哈希后写入数据库；账户已经存在时，修改该环境变量不会覆盖当前密码。
- `TOTP_ENCRYPTION_KEY` 只用于加密数据库中的 TOTP Secret，不是管理员密码，也不是账户恢复密钥。它不能用于 `/recovery`。
- `ACCOUNT_RECOVERY_KEY_BOOTSTRAP` 只用于恢复密钥表从未存在任何历史记录的空表首次引导。一旦写入过恢复密钥，即使记录已过期或使用且环境变量仍遗留，服务也绝不会重新启用它。数据库只保存恢复密钥的 Argon2id 哈希，任何现有密钥都无法反解。
- 恢复密钥有效期为 90 天。通过 `/recovery` 成功恢复账户后，输入的恢复密钥立即失效；响应会再次轮换并仅显示一次新的 `recoveryKey` 和 `totpSetupURI`。两者必须在离开页面前保存到受控密码库，并在到期前纳入轮换提醒。

## 适用场景

仅当有效恢复密钥的明文副本已经遗失、但仍具备生产 VPS 的 root 权限时使用 `deploy/rotate-recovery-key.sh`。不要通过修改 `ADMIN_PASSWORD`、尝试解码数据库哈希或使用 `TOTP_ENCRYPTION_KEY` 绕过恢复流程。

脚本执行以下固定流程：

1. 要求显式 `--confirm` 和 root 身份。发布状态目录只允许固定的 `root:root` (`0:0`) 模型，或当前生产发布账户 `shiyi:shiyi` (`1000:1000`) 模型；其他所有者会被拒绝。脚本以只读方式打开已存在的 `deploy/releases/.lock` 并先取得共享发布锁；锁缺失时直接失败，不会由 root 创建或改变所有权。
2. 在共享发布锁保护下，脚本验证项目目录、`deploy/`、`compose.yaml`、`.env`、`current.env`、轮换主脚本、辅助库和发布锁具有同一受信所有者，且任何 group/other 都不可写；路径祖先只能归 root 或该固定受信 UID 所有，不可写且不得为符号链接。辅助库通过已验证 inode 的文件描述符加载，防止检查与加载之间被发布替换。
3. 拒绝 `deploy/releases/source-activation.failed` 标记，避免在源码激活不完整的混合发布状态下继续；随后安全读取 `deploy/.env` 与 `deploy/releases/current.env`，不会 source 或回显环境变量，并在轮换结束前再次确认发布目录与锁的 inode、所有者和权限未变。
4. 验证 `current.env` 使用受信 GHCR 不可变 digest，并确认 PostgreSQL、API、Worker、Web 容器和 HTTP 端点健康。
5. 在 `/var/lib/timeblog/account-recovery/` 下创建 `root:root`、权限 `0700` 的独立运行目录，先保存权限 `0600` 的 PostgreSQL custom dump；轮换前使用只读的 `pg_restore --list` 验证其可解析，并生成 SHA-256 校验和。
6. 为容器 UID `65532` 创建隔离输出目录，通过当前 core digest 执行一次恢复密钥轮换；容器的 stdout 不进入终端，stderr 写入权限 `0600` 的诊断日志。
7. 无论容器命令退出码是否为零，都会先拒绝符号链接、空文件、非 `0600` 或不属于 UID `65532` 的输出，再把安全候选文件收归 `root:root`；随后结合有效恢复密钥数量和 `recovery_key_rotated` 审计增量，把结果判定为已提交、未提交或状态未知。
8. 只有已提交且数据库复核通过时才把候选文件命名为 `recovery-key.txt`；服务健康复查失败不会删除该文件，也不会自动重试或恢复数据库。

脚本只使用 `pg_restore --list` 读取备份目录，不会执行数据库恢复写入、Compose `down`、数据删除或自动回滚。失败时会保留受保护的备份、日志以及可能已经生成的密钥文件，并明确输出已提交、未提交或状态未知；在已提交或状态未知时不要重复执行。

## 执行步骤

前置条件：生产环境已经部署包含 `--rotate-recovery-key` 命令的不可变 core 镜像。当前生产模型下，项目目录、`deploy/`、`compose.yaml`、`.env`、`releases/`、`current.env`、`.lock`、轮换主脚本和辅助库均必须归 `shiyi:shiyi` (`1000:1000`) 所有；项目与代码路径不可被 group/other 写入，`releases/` 必须为 `0700`，`.env`、`current.env` 和预先存在的 `.lock` 必须为 `0600`。不要为了让预检通过而对这些路径执行 `chown root:root`，否则后续以 `shiyi` 运行的发布会被拒绝。当前服务还必须健康，并有足够空间保存数据库备份。

`shiyi` 已拥有 Docker daemon 访问权，安全上等价于可取得 root，因此脚本才允许 root 加载该固定 UID 所有的辅助库。这不是“任意项目所有者都可信”的通用放宽；若生产 UID/GID 或任何路径所有权与上述模型不符，应先停止轮换并核查发布账户，不要手工放宽权限。

```bash
ssh vps1
cd /home/shiyi/TimeBlog
./deploy/rotate-recovery-key.sh --confirm
```

脚本成功时只打印以下文件路径，不打印密钥内容：

- `recovery-key.txt`：临时 break-glass 恢复密钥，`root:root`、权限 `0600`。
- `timeline-before-rotation.dump`：轮换前 PostgreSQL custom dump，`root:root`、权限 `0600`。
- `timeline-before-rotation.dump.sha256`：备份的 SHA-256 校验和，`root:root`、权限 `0600`。
- `rotation.stderr.log`：容器命令与数据库工具的 stderr，`root:root`、权限 `0600`。

在不录屏、不共享终端、不写入 shell history 的受控会话中读取 `recovery-key.txt`，随后访问 `https://blog.cainiao.me/recovery`：

1. 输入该临时恢复密钥和新的管理员密码。新密码至少 12 个字符。
2. 恢复成功后立即把页面仅显示一次的“新恢复密钥”保存到密码库；此时脚本生成的临时密钥已经失效。新恢复密钥只用于下一次账户恢复，不是 TOTP 手动设置密钥，不得输入 Google Authenticator。
3. 在 Google Authenticator 中选择“输入设置密钥”时，只复制页面独立显示的“手动设置密钥”：它是仅含 `A-Z` 和 `2-7` 的 32 字符 Base32 文本。将类型选为“基于时间”，账户名可记为“菜鸟手记 / owner”。
4. 页面显示的完整 `otpauth://` URI 只供支持该协议的本地应用直接导入，或在本机生成二维码后扫描。它包含 `:/?=&%` 等 URI 字符，不能粘贴到 Google Authenticator 的手动密钥框；也不得提交给外部网站或第三方二维码服务，否则会泄露 TOTP Secret。
5. 在离开恢复结果页前，确认新恢复密钥和 TOTP 手动设置密钥均已保存到受控密码库，不要将其复制到普通笔记、工单或聊天记录。
6. 重新登录，完成新密码与 Google Authenticator 当前 TOTP 验证码的验证，确认旧会话均已撤销。
7. 确认新恢复材料可用后，按备份保留策略处理运行目录；不要把其中任何文件复制到 Git、普通工单或聊天记录。

## 失败处理

- 健康预检或数据库备份失败：轮换命令尚未执行，先修复健康状态或存储问题。
- 已确认未提交：脚本会明确输出“数据库核验确认本次轮换未提交”。若容器曾生成候选材料，会将其保存为 `recovery-key.inactive.txt`，该文件不能用于账户恢复。
- 已确认提交但后置复核失败：受保护目录中的 `recovery-key.txt` 是本次已激活密钥，必须保留且不得重跑脚本；先修复复核或服务健康问题，不要恢复轮换前 dump 覆盖新状态。
- 提交状态未知：安全候选材料保存在 `recovery-key.candidate.txt`。不要用它直接恢复，也不要重跑脚本；先根据 `rotation.stderr.log`、有效密钥数量和 `recovery_key_rotated` 审计事件完成只读核验。
- 候选输出未通过类型、权限或所有权校验：脚本不会接管或读取其内容。结合终端给出的提交状态处理，不要手工放宽权限后继续执行。
- `recovery-key.txt` 再次遗失：重新执行前先确认没有另一轮操作正在进行，并保留上一轮证据目录以便审计。
