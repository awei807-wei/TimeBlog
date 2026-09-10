# 菜鸟手记 UI Kit 迁移说明

## 迁移来源与边界

本轮公共站点界面基于项目根目录交付的 `cainiao-blog-ui-kit.zip`。压缩包只作为视觉与信息架构参考，不作为运行时代码或数据源。

- 保留现有 Next.js 路由、Go API、Cookie 会话、CSRF、媒体上传与文章 canonical identifier 契约。
- 不复制演示数据、阅读弹层或伪写作接口。
- 文章继续使用 `/article/[slug]` 正式路由，支持独立 metadata、分享链接、前进后退与搜索引擎索引。
- `/admin` 使用现有 shadcn sidebar 与 Novel/Tiptap 写作器；公共页面使用独立 `PublicShell`，两者共享同一组颜色令牌。

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
- 桌面公共导航的“写点什么”保持进入 `/admin`；手机首页悬浮按钮会先复核 Session，已登录时原地打开快速写作 Dialog，匿名或会话失效时进入 `/login`。Dialog 复用管理端 controller，不复制草稿或发布协议。
- 深浅主题使用 `timeblog-theme` 本地偏好；未设置时跟随系统主题。
- 静态分享图位于 `apps/web/public/social-card.png`。
- 品牌原图由根目录 `logo.png` 派生为浏览器图标：`favicon.ico`、`favicon-16x16.png`、`favicon-32x32.png`、`favicon-48x48.png` 和 `apple-touch-icon.png`；PWA 图标为 `icon-192.png` 与 `icon-512.png`。
- 透明圆形头像式吉祥物位于 `apps/web/public/brand/mascot.png` 与 `mascot.webp`。它保留原图的脸部与叶冠，使用明确的柔和圆形边界避免原始画布右侧/底部出血被误读为意外裁切。公共壳导航使用小尺寸吉祥物，首页 hero 使用低透明度装饰图；图片均保持等比，不拉伸原图。

## 写作器演进

- 固定顶部格式栏已移除；选中文本时显示气泡菜单，输入 `/` 时在光标附近显示块级命令。手机首屏优先图片、待办和列表，触控目标不小于 44px。
- Markdown 仍是唯一持久化格式；Novel JSON/HTML 和媒体预览 URL 不进入 IndexedDB、working copy 或发布请求。历史 raw HTML、脚注、表格对齐、扩展 fence、项目指令与 `media://` 引用由兼容层保护。
- 快速写作正常关闭前读取编辑器最后一帧并验证 IndexedDB 写入；隐藏 controller 暂停 debounce、blur、interval 与离线 outbox，避免覆盖其他标签页的新草稿。
- Dialog 使用动态视口、安全区、焦点陷阱和显式焦点归还；编辑区只保留一个纵向滚动表面，不生成第二个 `main#main-content`。
