# ADR-011：首期不运行 Kubernetes

- 状态：已接受
- 决策：生产使用 Compose；不部署 Kubernetes、Grafana 或 Elasticsearch。
- 原因：单机个人站的资源和运维复杂度不支持这些控制面，且不改善首期 RPO/RTO。
- 后果：扩容与故障接管依赖固定镜像、备份恢复和手动 runbook；未来实验环境可独立建立。
