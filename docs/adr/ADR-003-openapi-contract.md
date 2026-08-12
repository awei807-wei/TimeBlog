# ADR-003：OpenAPI 作为接口合同

- 状态：已接受
- 决策：`services/core/api/openapi.yaml` 是 API 路由、请求、响应和错误语义的合同。
- 原因：前后端独立演进时可审计，避免手写类型和隐私行为漂移。
- 后果：新增或修改公开 API 时必须同步 OpenAPI 与测试；当前仓库仍保留部分手写 TypeScript 数据映射，后续可接生成客户端。
