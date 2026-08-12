# ADR-010：NAS 采用拉取式备份

- 状态：已接受
- 决策：VPS 只生成带 SHA-256/manifest 的暂存备份；NAS 主动以只读 SSH/rsync 拉取，校验后原子创建本地时间戳快照。
- 原因：NAS 停机不影响生产，VPS 被入侵时不应持有删除 NAS 历史快照的权限。
- 后果：NAS 需要受控 `known_hosts`、只读源账号、保留策略和月度恢复演练；脚本禁止远端 rm/mv。
