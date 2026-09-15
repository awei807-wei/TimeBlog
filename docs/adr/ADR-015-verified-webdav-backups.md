# ADR-015：使用远端回读校验的 WebDAV 完整备份

- 状态：已接受
- 日期：2026-09-15

## 背景

生产 VPS 已配置可用的 rclone WebDAV 远端，但 NAS 与 VPS 尚未建立备份连接。只做 Markdown 导出无法恢复账户、草稿、版本、分类标签、任务和其他业务状态；直接向 FUSE 挂载写数据库 dump 也会受到目录缓存、写回和中途断连语义影响。

## 决策

- 每日先在 VPS 本地生成 PostgreSQL custom dump、media 卷、exports 卷、SHA-256 清单和 manifest。
- 数据库 dump 在离开 PostgreSQL 容器前执行 `pg_restore --list`；两个卷归档和全部 SHA-256 在上传前再次验证。
- 使用 rclone backend 上传到 `.incomplete-<stamp>`，再以 `rclone check --download` 强制从远端读取并比较五个文件。
- 校验成功后发布为时间戳目录，复核尺寸，并将最后创建的 `_SUCCESS` 作为完成判据。
- systemd 使用独立 root-owned `0600` 配置，每天 `03:30 Asia/Shanghai` 运行；凭据继续放在 rclone 配置中，不进入仓库或快照。
- 当前不自动清理本地或远端历史；容量监控和经恢复演练验证的保留策略另行制定。

## 后果

- 完成快照同时覆盖 PostgreSQL 全部业务数据及两个文件卷，不依赖 Markdown 导出。
- 远端中断或内容不一致会使任务失败，且不会创建 `_SUCCESS`；残留的隐藏临时目录可用于诊断。
- WebDAV 不是不可变存储。持有 rclone 凭据的 VPS 仍有修改远端的能力，因而不能替代离线或独立权限域备份；未来 NAS 拉取可作为第二层。
- 恢复仍是显式人工操作，并必须在隔离环境定期演练。PostgreSQL 集群角色、生产环境变量、TOTP/配置加密密钥和 rclone 凭据需独立保管。

## 放弃的方案

- 仅导出 Markdown：不能恢复完整业务状态。
- 直接写 `/mnt/mydav/Google1`：FUSE 缓存和网络写回不适合作为数据库快照的提交边界。
- 将 dump 自动导入 NAS PostgreSQL：网络方向、schema 隔离和恢复语义尚未确定，且不应与备份落盘耦合。
