# ADR-002：Next.js 负责 Web，Go 负责业务 API

- 状态：已接受
- 决策：Next.js/React/TypeScript 负责 SSR、SEO、PWA 外壳和编辑器；Go 负责认证、内容、媒体、导入导出和任务。
- 原因：保留 React 生态，同时用流式 I/O、数据库事务和单一后端合同承载核心数据。
- 后果：浏览器与 Go API 同源访问；服务端渲染不绕过公开隐私过滤。
