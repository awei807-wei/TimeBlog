# 菜鸟手记 UI Kit 迁移说明

## 迁移来源与边界

本轮公共站点界面基于项目根目录交付的 `cainiao-blog-ui-kit.zip`。压缩包只作为视觉与信息架构参考，不作为运行时代码或数据源。

- 保留现有 Next.js 路由、Go API、Cookie 会话、CSRF、媒体上传与文章 canonical identifier 契约。
- 不复制演示数据、阅读弹层或伪写作接口。
- 文章继续使用 `/article/[slug]` 正式路由，支持独立 metadata、分享链接、前进后退与搜索引擎索引。
- `/admin` 继续使用现有 shadcn sidebar 与 MDXEditor；公共页面使用独立 `PublicShell`，两者共享同一组颜色令牌。

## 页面映射

| UI Kit 视图 | TimeBlog 正式路由 | 数据来源 |
| --- | --- | --- |
| 时间线 | `/` | `GET /api/v1/public/timeline` |
| 日历归档 | `/calendar` | `GET /api/v1/public/calendar`、`GET /api/v1/public/days/{date}` |
| 分类 | `/categories` | `GET /api/v1/public/categories` |
| 分类详情 | `/categories/[slug]` | `GET /api/v1/public/categories/{slug}/entries` |
| 标签详情 | `/tag/[tag]` | `GET /api/v1/public/tags/{tag}/entries` |
| 搜索 | `/search` | `GET /api/v1/public/search` |
| 日期归档 | `/day/[date]` | `GET /api/v1/public/days/{date}` |
| 正式文章 | `/article/[slug]` | `GET /api/v1/public/articles/{identifier}` |

## 视觉契约

- 纸张背景：`#f8f8f6`
- 内容表面：`#ffffff`
- 正文：`#292b2d`
- 弱化文字：`#73777a`
- 强调色：`#526d82`
- 强调浅色：`#edf2f5`
- 分隔线：`#e4e5e2`
- 桌面公共内容宽度：`860px`
- 移动端主导航固定在底部，交互目标不小于 `40px`，关键动作不小于 `44px`

公共样式按职责拆分：

- `apps/web/app/public-shell.css`：公共导航、主题切换、页脚与移动端底栏。
- `apps/web/app/public-pages.css`：时间线与共享内容卡片。
- `apps/web/app/public-views.css`：日历、分类、搜索和正式文章阅读页。

## 运行约束

- 公共页面只展示 API 返回的公开数据；私人内容仍由后端决定是否返回占位。
- “写点什么”在已登录时进入 `/admin`，未登录时进入 `/login`，不在公共页面复制一套写作器。
- 深浅主题使用 `timeblog-theme` 本地偏好；未设置时跟随系统主题。
- 静态分享图与站点图标位于 `apps/web/public/social-card.png` 和 `apps/web/public/favicon.svg`。
