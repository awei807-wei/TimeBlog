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
