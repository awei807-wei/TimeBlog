# ADR-004：SQL-first 的 PostgreSQL 持久化

- 状态：已接受
- 决策：使用 pgx database/sql 与显式 SQL；迁移文件作为数据库结构事实来源，不引入通用 ORM。
- 原因：需要 PostgreSQL tsvector、pg_trgm、部分索引、事务和 `SKIP LOCKED`。
- 后果：SQL 变更须迁移和集成测试配套；当前实现未生成 sqlc 代码，保持查询边界清晰作为可维护折中。
