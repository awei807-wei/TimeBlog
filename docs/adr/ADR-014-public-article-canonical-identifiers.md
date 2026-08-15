# ADR-014：公开文章使用稳定 canonical slug，历史数据允许 UUID 回退

## 状态

已接受

## 背景

旧导入数据可能没有 `slug`，但公开列表仍然会返回文章 `id`。如果前端仅把非空 slug 当作详情入口，这些文章会失去可读链接；如果公开接口接受任意 ID，则会扩大可枚举的资源标识面。

## 决策

- 新建或提交的 `article` 在 slug 为空时从标题生成稳定 slug；标题为空时使用 entry UUID 生成 `article-<id>` 基础值。
- slug 冲突通过 entry UUID 后缀和递增序号稳定消解；内存和 PostgreSQL 提交路径保持同一规则。
- `GET /api/v1/public/articles/{slug}` 先按 canonical slug 匹配；仅当路径值是合法 UUID 且 slug 未命中时，才按文章 UUID 回退。只返回 `status=published` 且 `visibility=public` 的文章，note 不可通过此端点读取。
- 公开文章列表、站点地图和 Atom feed 中的 article 使用 `slug`，历史空 slug 使用 UUID；note 保留在时间线和 feed 中，但不生成文章详情链接。
- Next 详情页以 UUID 打开且响应包含 canonical slug 时重定向到 slug，metadata 和结构化数据使用 canonical URL。

## 结果与约束

该兼容路径只覆盖合法 UUID，避免将任意数据库键暴露为公开查询入口。历史文章仍可被修订后获得 canonical slug；在修订前，UUID URL 是其稳定回退地址。

## 集成测试门禁

PostgreSQL 集成测试只允许在专用测试库运行，必须同时设置 `DATABASE_URL` 和 `TIMEBLOG_RUN_DATABASE_INTEGRATION=1`。测试启动前会检查双门禁，随后才调用可能执行迁移和 owner 初始化的数据库打开逻辑；普通开发环境或生产数据库不会因仅配置 URL 而被测试触碰。
