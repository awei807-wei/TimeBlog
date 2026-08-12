# ADR-005：PostgreSQL 同时承担搜索和任务队列

- 状态：已接受
- 决策：公开搜索使用 PostgreSQL `tsvector`/`pg_trgm`，异步任务使用 `jobs` 表和 `FOR UPDATE SKIP LOCKED`；首期不引入 Redis 或 Elasticsearch。
- 原因：个人数据量有限，减少运行依赖和恢复对象。
- 后果：中文搜索精度与队列吞吐有上限；可通过后续 Provider 接口迁移，不改变可见性过滤事实源。
