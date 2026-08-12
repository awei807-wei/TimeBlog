# ADR-006：Markdown 是真源，Mermaid 分层渲染

- 状态：已接受（Mermaid 导出部分为 P1）
- 决策：数据库只把 Markdown 作为内容真源；Go Goldmark + bluemonday 生成权威 HTML。Web 端按需用 Mermaid 渲染占位块，导出不执行第三方脚本。
- 原因：保证 WYSIWYG、预览、导出和恢复都能回到 Markdown；导出必须支持 `file://` 离线打开。
- 后果：当前 Worker 只生成带源码预览的明确 fallback SVG，不是真实 Mermaid 图形；引入 Node/headless renderer 前不得宣称 SVG 语义等价，真实渲染列入 P1。
