# 前端依赖安全记录

## 2026-09-10

- 写作器依赖迁移为 `novel@1.0.2`、`tiptap-markdown@0.8.10`，并将直接与传递使用的 Tiptap 2 包精确锁定到 `2.27.3`；业务层通过项目自有 `MarkdownEditorHandle` 隔离具体实现，便于后续整体迁移。
- Next.js 与配套依赖更新为 `next@16.3.4`、`eslint-config-next@16.3.4`、`sharp@0.35.4`、`@eslint/eslintrc@3.3.7`，移除 MDXEditor/Lexical 及其旧 `js-yaml` override。
- `npm audit --omit=dev` 与完整 `npm audit` 均只报告 42 个同源 moderate 项，全部归因于 `GHSA-cp6q-959q-f8rh` 对 `@tiptap/core <=3.30.3` 的版本范围；未发现 critical 或 high。
- 当前锁定的官方 `@tiptap/core@2.27.3` 制品已包含同一修复：`mergeAttributes()` 对自有 `__proto__` 键使用 `Object.defineProperty` 创建普通数据属性，避免修改合并对象原型。`package-lock.json` 的制品完整性为 `sha512-a5LfRbLpfaGI3hbL/LPHUYHI0I+FQHdSHsy8L4YnVIuu3hXcm3QZgkWbpEGf8hCz8krk6zEiu0+iFOjTySU2FA==`。
- `apps/web/tests/novel-markdown-runtime.test.mjs` 使用恶意 `__proto__` 输入执行 `mergeAttributes` 与 ProseMirror `DOMSerializer` 回归：对象原型不变，DOM 不产生 `src`、`onerror` 或 `data-canary`，canary 不执行。该证据说明当前 audit 告警属于 advisory 元数据未识别 Tiptap 2 回补，而不是当前制品可复现漏洞。
- 不运行 `npm audit fix --force`：它会把核心包单独提升到 Tiptap 3，破坏 Novel 1.0.2/Tiptap 2 的兼容栈。任一 Tiptap 版本、锁文件 integrity、advisory 内容或回归测试结果变化时，必须重新评估该例外；正式迁移 Tiptap 3 时再整体解除。
- 编辑器渲染层额外关闭 Tiptap Markdown HTML 解析，raw HTML 以无碰撞保护 token 往返；链接在 render 阶段再次校验 URI，并强制 `target="_blank"` 与 `rel="noopener noreferrer nofollow"`。
- 参考链接：
  - [GHSA-cp6q-959q-f8rh](https://github.com/advisories/GHSA-cp6q-959q-f8rh)
  - [Novel 1.0.2](https://www.npmjs.com/package/novel/v/1.0.2)
  - [Tiptap 2.27.3](https://www.npmjs.com/package/@tiptap/core/v/2.27.3)

## 2026-08-14

- Web 编辑器固定在 `@mdxeditor/editor@4.2.0`。
- `next` 与 `eslint-config-next` 升级到 `16.3.1`，使 Next 传递依赖解析到 `postcss@>=8.5.23` 与 `sharp@>=0.35.3`。
- 在仓库根 `package.json` 使用最窄 npm override：仅将 `@mdxeditor/editor` 下的 `js-yaml@4.3.0` 提升到 `4.3.1`。该依赖由编辑器锁定，不能直接修改其发布包；override 只作用于该父包，不覆盖其他依赖。
- 升级用于清除 npm audit 对旧 Next/传递依赖和编辑器嵌套 `js-yaml` 的高危报告。当前 `npm audit --omit=dev` 与完整 `npm audit` 均为 0 vulnerabilities。
- 参考链接：
  - [Next.js Security Advisories](https://github.com/vercel/next.js/security/advisories)
  - [js-yaml Security Advisories](https://github.com/nodeca/js-yaml/security/advisories)
  - [NVD：js-yaml 漏洞检索](https://nvd.nist.gov/vuln/search/results?query=js-yaml)
  - [NVD：Next.js 漏洞检索](https://nvd.nist.gov/vuln/search/results?query=Next.js)

## 2026-08-15

- 日期选择器改用 Adobe React Spectrum 官方的无样式可访问组件：`react-aria-components@1.20.0` 与 `@internationalized/date@3.12.3`。
- `react-aria-components@1.20.0` 的 peer dependency 明确支持 React `^19.0.0-rc.1`，与项目 `react@19.1.1`、`react-dom@19.1.1` 兼容；`@internationalized/date@3.12.3` 无 peer dependency 限制。
- 安装后执行 `npm audit`，生产依赖审计结果为 0 vulnerabilities；锁文件记录完整版本与完整性校验。
- 组件与日期算法均来自官方包，项目只提供主题样式和 `YYYY-MM-DD` 值适配，不自定义日历计算或原生日期弹层。
- 参考链接：
  - [React Aria DatePicker](https://react-spectrum.adobe.com/react-aria/DatePicker.html)
  - [react-aria-components npm](https://www.npmjs.com/package/react-aria-components)
  - [@internationalized/date npm](https://www.npmjs.com/package/@internationalized/date)
