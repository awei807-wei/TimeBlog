# ADR-011：首期不运行 Kubernetes

- 状态：已接受
- 决策：生产使用 Compose；不部署 Kubernetes、Grafana 或 Elasticsearch。
- CI 例外：允许在独立于生产的 Kubernetes 集群中运行一个仓库级 GitHub Actions Runner；该 Runner 只承载可信 `main` 发布构建，不承载生产应用、数据库或生产部署 job。
- 原因：单机个人站的资源和运维复杂度不支持这些控制面，且不改善首期 RPO/RTO。
- 后果：生产扩容与故障接管仍依赖固定镜像、备份恢复和手动 runbook；CI runner 的 PVC 保存 runner 注册配置和固定版本安装目录，工作目录和 Docker-in-Docker 数据使用临时卷，未来可独立替换为其他构建执行器。
