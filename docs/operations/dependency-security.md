# 前端依赖安全记录

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
