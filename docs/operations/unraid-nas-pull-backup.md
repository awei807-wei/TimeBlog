# Unraid 上运行 nas-pull-backup.sh 的可落地方案

> 状态：**只读研究 / 部署方案**（未改动任何项目文件、未 git push）
> 范围：把 `deploy/nas-pull-backup.sh`（ADR-010 拉取式备份）部署到底层为 **Unraid** 的 NAS 上。
> 关联：ADR-010、ADR-011、`deploy/nas-pull-backup.sh`、`deploy/systemd/timeline-nas-pull.service`、`docs/operations/backup-restore-runbook.md`。
> 标注约定：**【确定】** = Unraid 的稳定、文档化的确定行为；**【工程判断】** = 基于脚本约束与 Unraid 特性的推断/建议，需在本机验证。

---

## 0. 结论摘要（TL;DR）

Unraid 不适用现有 systemd 方案（`User=timeblog-backup` + `ReadWritePaths`），因为：

1. Unraid 底层是 Slackware，但用户管理是它自己的体系：`/etc/passwd` 等系统文件在**每次开机时重建**，`useradd` 无法产生持久系统用户；systemd 也**不是** Unraid 的标准服务管理器。
2. 因此运行身份**最稳妥的是 root**（通过 **User Scripts 插件**以 root 定时执行），或**容器化**（docker 内跑）。root 跑本脚本**是安全的**，因为脚本自身做了严格路径/时间戳白名单校验，`rm -rf` 只会删它自己创建的时间戳目录。
3. 调度用 **User Scripts 插件**（cron 表达式，脚本持久化在 `/boot/config/plugins/user-scripts/`）或 Unraid 自带 `crontab`/`/etc/cron.d`（由 `/boot/config/go` 注入以跨重启持久）。
4. SSH 私钥、`known_hosts`、`nas-backup.env` 都放 **`/boot/config` 下的持久目录**（如 `/boot/config/timeblog/`），`/root` 是 RAMFS 不持久。启动时用 `go` 脚本/User Scripts 的"At Array Start"把它们复制成 root 0600 文件。
5. `DEST_PATH` 建议放 **`/mnt/user/backups/timeline`（共享目录）** 或直接磁盘 **`/mnt/diskX/backups/timeline`**。快照是本地落盘，`mv` 原子改名在 Unraid 的 XFS 上是原子的，满足脚本假设。
6. WebDAV 按 ADR-011 只作为 **NAS 侧二次副本**：主快照在 NAS 本地，可选再 `rsync` 到 WebDAV 挂载。Unraid 没有内建 WebDAV 挂载，需用 **docker 内 davfs2/fuse** 或用户脚本 `mount.davfs`，并自行处理重挂。

---

## 1. 身份选择：root 直接跑 / User Scripts / 容器

### 1.1 为什么不能新增 `timeblog-backup` 系统用户（**确定**）

- Unraid 基于 Slackware，但把 `/etc/passwd`、`/etc/shadow`、`/etc/group`、`/etc/fstab`、`/etc/ssh/ssh_host_*` 等放在 **RAM 文件系统（rootfs）** 上，**每次开机从闪存基础镜像重建**。
- 用 `useradd timeblog-backup` 新增的用户在重启后**消失**；用 `passwd` 改的密码、`~/.ssh` 里的密钥同理不持久。
- Unraid 自己的用户管理是 `users` 共享/SMB 账号体系（存于 `/boot/config` 的 `super.dat`/`users`），与标准 POSIX `/etc/passwd` **不是一回事**，不能用来给脚本当系统用户。

> 结论：**不要**试图新增专用系统用户。ADR-010 的"root-owned 0600 环境文件"这一安全前提，在 Unraid 上由 **root 运行 + `/boot/config` 持久目录的 0600 文件**来满足。

### 1.2 三个可选运行身份及安全性分析

| 方案 | 运行身份 | 持久性 | 安全性评估 |
|------|----------|--------|-----------|
| **A. root 直接跑 / User Scripts 以 root 跑**（推荐） | root | 脚本/配置放 `/boot/config` 持久 | 见 1.3，**对 `nas-pull-backup.sh` 是安全的** |
| **B. Docker 容器内跑** | 容器内非 root 用户（如 `uid 1000`） | 容器镜像/卷持久 | 隔离性最好，但需把 SSH key、env、DEST 挂载进容器，且容器内工具链（rsync/ssh/python3）需自带；复杂度高 |
| **C. 用现有 SMB 用户 + sudo** | 非 root 的 SMB 账号 | 持久 | 需 `sudo` 提权到 root 才能写 `/boot/config` 0600 文件并满足 umask 077；SMB 账号不是 POSIX 用户，`~/.ssh` 位置别扭；**不推荐** |

### 1.3 root 跑是否有问题？（**工程判断** + 脚本事实）

脚本事实（`deploy/nas-pull-backup.sh`）：

- `umask 077`：所有新建文件/目录默认 `0700/0600`，root 下同样生效。
- `NAS_CONFIG_FILE`：要求存在、非 symlink、权限 **`600` 或 `400`**。root 能读；`stat` 校验与运行用户无关。
- `mktemp -d "$DEST_PATH/.timeline-${STAMP}.XXXXXX"`：在 `DEST_PATH` 下建隐藏临时目录，root 有权限。
- `mv -- "$TMP_DIR" "$DEST"`：**原子改名**，root 下安全。
- 保留策略：只对 `DEST_PATH/*` 中**严格匹配 `^[0-9]{8}T[0-9]{6}Z$`** 的目录、且 `-mtime +RETENTION_DAYS` 才 `rm -rf`。**root 跑也不会误删**——白名单是脚本内建的，不是靠用户隔离。

**工程判断**：root 跑**没有正确性问题**。唯一要权衡的是"纵深防御"：若担心脚本被篡改或未来改动引入危险 `rm`，容器化（方案 B）能提供额外隔离。但就**当前脚本**而言，root 是安全且最简单的。**推荐方案 A（root + User Scripts）**，同时把脚本、env、密钥都放进 `/boot/config` 的独立子目录并 `chmod 600`，把暴露面压到最小。

### 1.4 DEST_PATH 该放哪

| 位置 | 说明 | 优缺点 |
|------|------|--------|
| **`/mnt/user/backups/timeline`**（推荐） | Unraid 的共享目录（FUSE 用户文件系统，跨 array/cache 盘） | 走 `shfs`，文件对 SMB/NFS 共享可见、易管理、可设 share 级保留；快照是本地 XFS 落盘，`mv` 原子。**工程判断**：对每日一次、文件量不大的备份，性能足够。 |
| **`/mnt/disk0/backups/timeline`**（磁盘直挂） | 直接写某块盘 | 绕开 shfs，吞吐更高、更可预测；但不在共享命名空间，管理略麻烦。**工程判断**：如果备份体积很大或想避开 shfs 开销可选。 |

**工程判断**：默认 `DEST_PATH=/mnt/user/backups/timeline`。注意 `/mnt/user` 是**虚拟层**，`mv` 在 shfs 上对单盘目录仍是原子的（同目录内 rename）；对跨盘的情况 shfs 会处理成 copy+delete，**理论上非原子**。为避免 `mv -- "$TMP_DIR" "$DEST"` 的原子性假设被破坏，**建议把 `DEST_PATH` 指向同一物理盘内的目录**（如 `/mnt/disk0/backups/timeline`，或确认 `/mnt/user/backups` 全部落在同一盘/cache 上）。这是**工程判断**，需在本机验证 `DEST_PATH` 所在目录确实单盘。

> 注：Unraid 有 "**Unassigned Devices**" 插件可挂额外盘，但本任务主盘用 `/mnt/user` 或 `/mnt/diskX` 即可。

---

## 2. 调度方式（不用 systemd）

### 2.1 首选：User Scripts 插件（**确定**）

- **User Scripts**（作者 Squid）是 Unraid 官方社区插件，从 **Apps（Community Applications）** 安装。
- 支持**定时执行**：提供 cron 表达式、常用预设（daily/hourly 等），也支持 **At Array Start / At First Array Start / 手动**。
- 脚本本体持久保存在闪存：`/boot/config/plugins/user-scripts/scripts/<name>/script.sh`。
- 用法：脚本里写 `#!/bin/bash` + 调用 `nas-pull-backup.sh`；把 `SOURCE_HOST` 等以环境变量或 `export` 写入脚本顶部，或让脚本读 `NAS_CONFIG_FILE=/boot/config/timeblog/nas-backup.env`。
- **以 root 运行**：User Scripts 默认以 root 执行（**确定**），满足"root 身份"。

**最小示例（User Scripts 脚本内容）**：

```bash
#!/bin/bash
export NAS_CONFIG_FILE=/boot/config/timeblog/nas-backup.env
exec /boot/config/timeblog/nas-pull-backup.sh
```

在 User Scripts 界面里设置 cron（如 `0 3 * * *`，每天 03:00）。

### 2.2 备选 B：Unraid 自带 crond（**确定**）

- Unraid 用 Slackware 的 **crond**，支持 `/etc/crontab`、`/etc/cron.d/` 和用户 `crontab`。
- **关键**：`/etc` 是 RAM 文件系统，开机重建，所以 cron 条目**不持久**。要跨重启，需在 **`/boot/config/go`**（每次开机会执行的脚本）里追加 cron 条目。

```bash
# /boot/config/go 追加
echo '0 3 * * * root /boot/config/timeblog/nas-pull-backup.sh' >> /etc/crontab
```

**工程判断**：User Scripts 更省事且自带 web 管理界面，推荐 A；B 作为无插件/极简环境备选。

---

## 3. SSH 只读身份 + known_hosts 在 Unraid 落地

### 3.1 文件放哪、怎么持久（**确定**）

- **`/root` 是 RAMFS，不持久**——私钥/known_hosts **不能**放 `/root/.ssh/`，重启即丢。
- 持久区是 **`/boot`（闪存）**，配置统一放 **`/boot/config/`**。
- 因此建议统一放到 `**/boot/config/timeblog/**`：

```
/boot/config/timeblog/
  nas-backup.env        # 0600
  id_ed25519            # 私钥 0600
  known_hosts           # 0600
  nas-pull-backup.sh    # 副本（或软链到别处）
```

### 3.2 脚本如何引用（**工程判断**）

`nas-pull-backup.sh` 里 `ssh`/`rsync` 用 `-e 'ssh -o BatchMode=yes -o StrictHostKeyChecking=yes'`，**默认读 `~/.ssh` 下的 identity 和 known_hosts**。root 的 `~/.ssh` 是 `/root/.ssh`（RAMFS，不持久）。

要让脚本用 `/boot/config/timeblog/` 里的密钥，最干净的做法是给脚本一个 `HOME=/boot/config/timeblog` 的环境前缀，或用 `-i`/`-o UserKnownHostsFile` 注入：

**工程判断（推荐）**：在调用脚本时设置环境变量让 SSH 指向持久目录：

```bash
#!/bin/bash
# User Scripts 或 /boot/config/go 里的 wrapper
export NAS_CONFIG_FILE=/boot/config/timeblog/nas-backup.env
export HOME=/boot/config/timeblog        # 让 ssh/rsync 找 ~/.ssh
export SSH_PRIVATE_KEY=/boot/config/timeblog/id_ed25519
# 若脚本/rsync 支持 -i，可追加；否则用 ~/.ssh
exec /boot/config/timeblog/nas-pull-backup.sh
```

> 若不想动脚本，也可在 `/boot/config/timeblog/.ssh/` 下放 `config` + `id_ed25519` + `known_hosts`，并把 `HOME` 指到 `/boot/config/timeblog`。

**工程判断**：脚本当前直接调用 `ssh`/`rsync` 不带 `-i`，会走 `$HOME/.ssh`。**最小改动**是设 `HOME=/boot/config/timeblog`，并在该目录建 `.ssh`。若担心改环境变量影响其他，可**在脚本外层 wrapper** 里 `export HOME=...` 后调用脚本（不改项目文件）。

### 3.3 known_hosts 指纹校验（**确定 + 工程判断**）

- 脚本已强制 `StrictHostKeyChecking=yes` + `BatchMode=yes`，**首次连接必须已预置指纹**。
- 首次接入时在**受控终端**（非 NAS 生产）执行 `ssh-keyscan -t ed25519 backup-source`，**人工核对指纹**后写入 `/boot/config/timeblog/.ssh/known_hosts`（0600）。
- **工程判断**：由于脚本用 `$HOME` 解析 known_hosts，确保把 known_hosts 放进 `$HOME/.ssh/known_hosts`（即 `/boot/config/timeblog/.ssh/known_hosts`），并 `chmod 600`。

### 3.4 VPS 侧只读账号（**确定，沿用 ADR-010**）

- 保留 VPS 上**只读 rsync/SSH 账号**（只能 `find`/`rsync` 读备份目录，无写/删/执行远端命令权限）。
- 私钥、known_hosts **不入库**，只存在于 NAS 持久目录（ADR-010 边界）。

---

## 4. WebDAV 关联（NAS 侧二次副本）

### 4.1 结论（**确定**，来自 ADR-011）

- WebDAV **不作为主备份**；主快照留在 NAS 本地（`DEST_PATH`）。
- WebDAV 只作 **NAS 侧二次/异地副本**：NAS 用现有 `nas-pull-backup.sh` 落盘后，再 `rsync -a "$DEST" /mnt/webdav/`（NAS 侧执行）。
- 注意：davfs2 上 `mv` 非原子、`0600` 不保留、无端到端校验，因此 WebDAV 副本写入后应再 `sha256sum -c`，且只增不删或独立 TTL。

### 4.2 Unraid 是否原生支持 WebDAV 挂载（**确定**）

- Unraid **内建没有** WebDAV/davfs2 挂载功能；`/etc/fstab` 开机重建，普通 fstab 项**不持久**。
- 需要额外手段：**docker 容器内 davfs2/fuse**，或用户态 `mount.davfs`（需安装 davfs2 包，Unraid 默认没有）。
- 没有官方"Unassigned Devices"这类插件直接管 WebDAV（它管磁盘/SMB/NFS）。

### 4.3 推荐做法（**工程判断**）

**方案一（推荐）：docker 容器内挂载 + 二次同步**

- 用一个简单容器（如 `ghcr.io/dperson/davfs` 或自建 `davfs2` 镜像），把 WebDAV 挂到容器内 `/mnt/webdav`，并把 NAS 的 `DEST_PATH` 目录 bind 挂载进容器。
- 容器内定时把 `DEST_PATH/<stamp>` 同步到 `/mnt/webdav/`（`rsync -a` + 落盘后 `sha256sum -c`）。
- 容器由 Unraid 的 docker 体系管理，**重启自动拉起、自动重挂**（**确定**：Unraid 会在启动时按 docker 模板恢复容器）。
- 优点：不依赖宿主 fstab、不污染宿主、可持久。

**方案二：宿主用户态 davfs（备选）**

- 需先安装 davfs2（Unraid 无包管理器，需从 slackware 包或插件装），在 `/boot/config/go` 里 `mount.davfs` 并 `umount`（配 `delay_upload`）。
- **工程判断**：维护成本高、重启重挂麻烦，不推荐作为首选。

**WebDAV 二次同步脚本（NAS 侧，可选，追加到 User Scripts）**：

```bash
#!/bin/bash
# 在 nas-pull-backup.sh 成功后运行
DEST=/mnt/user/backups/timeline
WEB=/mnt/webdav/timeline
mkdir -p "$WEB"
# 仅同步最新快照或全部；这里示例只增量同步
rsync -a --partial "$DEST/" "$WEB/"
# 落盘后从 WebDAV 重读校验（避免读到 davfs 缓存）
for f in "$WEB"/SHA256SUMS-*; do (cd "$WEB" && sha256sum -c "$f"); done
```

> **工程判断**：WebDAV 只作二次副本，异常/校验失败只记日志告警，**不**影响 NAS 本地主快照。

---

## 5. 最小可落地方案（从零开始）

以下步骤在 **Unraid Web UI（GUI）或 SSH** 上执行。均标注 **确定** / **工程判断**。

### 阶段 0：准备 VPS 侧（沿用 ADR-010，**确定**）

1. VPS 上已有只读 SSH/rsync 备份账号 + `backup.sh` 产物（`SHA256SUMS-<stamp>`、`manifest.json-<stamp>`、`timeline.dump-<stamp>` 等）。
2. 确认 VPS 只读账号**无**删除/改名权限。

### 阶段 1：安装 User Scripts（**确定**）

3. 在 Unraid **Community Applications** 搜索并安装 **User Scripts** 插件。

### 阶段 2：准备持久配置目录（**确定 + 工程判断**）

4. 在 NAS 建持久目录：
   ```bash
   mkdir -p /boot/config/timeblog/.ssh
   chmod 700 /boot/config/timeblog/.ssh
   ```
5. 把 `deploy/nas-pull-backup.sh` 复制到 `/boot/config/timeblog/nas-pull-backup.sh`（或软链），`chmod 700`。
6. 生成/导入 SSH 私钥到 `/boot/config/timeblog/.ssh/id_ed25519`，`chmod 600`。
7. 首次接入：受控终端执行 `ssh-keyscan -T ed25519 <backup-host>`，**人工核对指纹**后写入 `/boot/config/timeblog/.ssh/known_hosts`，`chmod 600`。
8. 生成 `NAS_CONFIG_FILE`：`/boot/config/timeblog/nas-backup.env`，`chmod 600`，内容：
   ```
   SOURCE_HOST=<host-alias>
   SOURCE_PATH=/srv/timeblog/backups
   DEST_PATH=/mnt/user/backups/timeline
   RETENTION_DAYS=90
   ```
   （或从 API 用 `--export-nas-config` 导出后原子写入并 0600；**工程判断**：导出命令需在 VPS 容器内跑，把 stdout 写到 NAS 持久目录。）

### 阶段 3：写 User Scripts 脚本（**工程判断**）

9. User Scripts 新建脚本 `timeline-nas-pull`，内容：
   ```bash
   #!/bin/bash
   export HOME=/boot/config/timeblog
   export NAS_CONFIG_FILE=/boot/config/timeblog/nas-backup.env
   /boot/config/timeblog/nas-pull-backup.sh
   ```
   保存后**先手动 Run 一次**，确认输出、快照目录、校验通过。

### 阶段 4：设置定时（**确定**）

10. 在 User Scripts 里把该脚本调度设为每天（如 `0 3 * * *`，03:00）。

### 阶段 5（可选）：WebDAV 二次副本（**工程判断**）

11. 用 docker 容器把 WebDAV 挂载到 `/mnt/webdav/timeline`（容器自动重挂）。
12. 在 User Scripts 加第二个脚本 `timeline-webdav-sync`，在 `timeline-nas-pull` 之后运行，把最新快照 `rsync` 到 WebDAV 并复核 SHA-256。

### 阶段 6：校验与演练（**确定**）

13. 手动触发后检查 `/mnt/user/backups/timeline/` 出现 `<stamp>` 目录，`sha256sum -c SHA256SUMS-<stamp>` 通过，manifest 字段匹配。
14. 重启 Unraid 一次，确认 `/boot/config/timeblog/*` 仍在、User Scripts 下次自动执行（**确定**：`/boot/config` 持久）。
15. 纳入**月度恢复演练**（沿用 runbook）。

---

## 6. 风险与注意事项

- **RAMFS 不持久**是 Unraid 核心约束：所有配置/密钥/脚本必须放 `/boot/config`（**确定**）。放 `/root`、`/etc`、`/opt` 都会重启丢失。
- **`mv` 原子性**依赖单盘：`DEST_PATH` 指向单一物理盘/cache 内的目录，避免 shfs 跨盘 copy+delete 破坏原子改名假设（**工程判断**）。
- **known_hosts 预置**：脚本强制严格主机校验，首次必须人工核对指纹，否则 `BatchMode` 下直接失败（**确定**）。
- **WebDAV 0600 假象**：远端不保留 POSIX 权限，WebDAV 副本用 ACL/目录权限 + NAS 侧 0600 双保险（ADR-011，**确定**）。
- **保留策略**：只在 NAS 本地执行；WebDAV 副本只增不删或独立 TTL（ADR-011，**确定**）。
- **root 纵深防御**：虽然 root 对当前脚本安全，仍建议把脚本/密钥/配置权限压到 600/700，并考虑容器化做纵深隔离（**工程判断**）。

---

*本报告为只读研究，未修改任何项目文件，未执行 git push。标注了 Unraid 确定行为与工程判断。*