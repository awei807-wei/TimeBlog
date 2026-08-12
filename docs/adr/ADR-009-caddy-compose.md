# ADR-009：宿主机 Caddy + Docker Compose

- 状态：已接受
- 决策：Caddy 保持宿主机 TLS、HSTS 和路径路由；Web、API、Worker、PostgreSQL 在 Compose 中运行。
- 原因：复用现有入口，避免在 2C2G 主机上引入额外 ingress 控制面。
- 后果：Caddy 配置和 Compose 健康检查共同构成部署合同；数据库不暴露公网端口。
