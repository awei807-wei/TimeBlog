# ADR-010：NAS 采用拉取式备份

- 状态：已接受（可选第二层）
- 决策：VPS 只生成带 SHA-256/manifest 的暂存备份；NAS 主动以只读 SSH/rsync 拉取，校验后原子创建本地时间戳快照。
- 原因：NAS 停机不影响生产，VPS 被入侵时不应持有删除 NAS 历史快照的权限。
- 后果：NAS 需要受控 `known_hosts`、只读源账号、保留策略和月度恢复演练；脚本禁止远端 rm/mv。
- 配置边界：应用数据库可保存 pull 策略的源主机 alias、源/目标路径和保留天数，并通过固定格式 CLI 导出给 NAS 脚本；SSH 私钥和 `known_hosts` 不入库，保存配置不等于已应用，只有安全导出到 NAS 的 root-owned `0600` 环境文件后才生效。
- 当前关系：NAS 暂未与 VPS 建立该链路，因此生产主备份采用 ADR-015 的 WebDAV 完整快照；本 ADR 保留为 NAS 可主动访问 VPS 后的独立第二层，不替代也不阻塞 WebDAV 任务。
