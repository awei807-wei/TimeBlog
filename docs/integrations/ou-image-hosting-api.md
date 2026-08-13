# OU Image Hosting API 源码契约与 TimeBlog 接入说明

## 1. 结论与适用版本

本文档依据 `cshaizhihao/ou-image-hosting` 的实际源码整理，不以 README 推测接口。审计基线如下：

- 上游仓库：`https://github.com/cshaizhihao/ou-image-hosting`
- 分支：`main`
- 提交：`d68ceb36c8df2d9f25515bbab641ed4292693cb1`
- 应用版本：`1.0.0`
- 核心后端：Fastify `^5.3.0`、`@fastify/multipart ^9.0.3`、`@fastify/rate-limit ^10.2.1`、Sharp `^0.34.3`

版本和依赖来自 [`package.json:L1-L30`](https://github.com/cshaizhihao/ou-image-hosting/blob/d68ceb36c8df2d9f25515bbab641ed4292693cb1/package.json#L1-L30)、[`apps/api/package.json:L1-L25`](https://github.com/cshaizhihao/ou-image-hosting/blob/d68ceb36c8df2d9f25515bbab641ed4292693cb1/apps/api/package.json#L1-L25) 与 `VERSION`。后续上游升级时，应重新核对本文列出的路由、权限中间件、响应结构和交付链接规则。

关键结论：

1. 自动化上传应调用站点域名下的 `POST /api/uploads`，而不是公开游客上传接口。
2. 使用 `Authorization: Bearer <API Token>`；上传表单字段固定为 `file`。
3. 上传至少需要 `images:write` scope，读取元数据需要 `images:read`，移入回收站需要 `images:delete`。
4. 文件交付 URL 本身不要求 `images:read`，但可能受签名 URL 和防盗链设置约束。
5. API Token 可以把图片移入回收站，但不能永久删除；永久删除要求 `admin` capability，而源码明确禁止 API Token 使用该 capability。
6. 相同工作区内按文件 SHA-256 去重；首次上传返回 HTTP `201`，重复内容返回 HTTP `200` 且 `duplicate: true`。

## 2. API 基址与代理路径

后端 Fastify 注册的内部路由是 `/uploads`、`/files/:id/:variant` 等。Next.js 的 catch-all 代理接收站点上的 `/api/...`，保留方法、查询参数和请求体，再转发给后端：[`apps/web/app/api/[...path]/route.ts:L25-L41`](https://github.com/cshaizhihao/ou-image-hosting/blob/d68ceb36c8df2d9f25515bbab641ed4292693cb1/apps/web/app/api/%5B...path%5D/route.ts#L25-L41)、[`L44-L88`](https://github.com/cshaizhihao/ou-image-hosting/blob/d68ceb36c8df2d9f25515bbab641ed4292693cb1/apps/web/app/api/%5B...path%5D/route.ts#L44-L88)、[`L98-L104`](https://github.com/cshaizhihao/ou-image-hosting/blob/d68ceb36c8df2d9f25515bbab641ed4292693cb1/apps/web/app/api/%5B...path%5D/route.ts#L98-L104)。

因此公网合同为：

| 用途 | 方法与路径 |
| --- | --- |
| 上传单张图片 | `POST /api/uploads` |
| 查询图片列表 | `GET /api/uploads` |
| 查询单张图片 | `GET /api/uploads/{id}` |
| 批量移入回收站 | `POST /api/uploads/bulk` |
| 查询回收站 | `GET /api/trash` |
| 恢复或永久删除 | `POST /api/trash/bulk` |
| 获取原图 | `GET /api/files/{id}/original` |
| 获取缩略图 | `GET /api/files/{id}/thumbnail` |

TimeBlog 当前设置保存完整上传地址，例如 `https://image.example.com/api/uploads`。适配器若需要调用兄弟路由，只能在验证 URL 无 query/fragment 且路径严格以 `/api/uploads` 结尾后推导，不能用字符串模糊替换。

## 3. 身份认证与权限

### 3.1 Token 格式和请求头

Token 由图床后台登录会话中的管理员创建，完整值只在创建响应中返回一次。源码生成格式为 `ouh_<prefix>_<secret>`：[`apps/api/src/workspace-security.ts:L1152-L1231`](https://github.com/cshaizhihao/ou-image-hosting/blob/d68ceb36c8df2d9f25515bbab641ed4292693cb1/apps/api/src/workspace-security.ts#L1152-L1231)。

请求头：

```http
Authorization: Bearer ouh_<prefix>_<secret>
```

解析正则为 `^Bearer (ouh_([A-Za-z0-9-]+)_[A-Za-z0-9_-]+)$`。只要请求携带 `Authorization`，格式错误或 Token 不存在就直接返回 `401 INVALID_API_TOKEN`，不会回退到 Cookie 会话：[`apps/api/src/app.ts:L492-L519`](https://github.com/cshaizhihao/ou-image-hosting/blob/d68ceb36c8df2d9f25515bbab641ed4292693cb1/apps/api/src/app.ts#L492-L519)。

Token 固定绑定创建时的用户和工作区，并可带过期时间及 IP 白名单。可选请求头 `X-Workspace-ID` 只能填写 Token 所属工作区；不传时服务端直接使用 Token 绑定的工作区，传错会返回 `403 TOKEN_WORKSPACE_MISMATCH`：[`apps/api/src/app.ts:L441-L489`](https://github.com/cshaizhihao/ou-image-hosting/blob/d68ceb36c8df2d9f25515bbab641ed4292693cb1/apps/api/src/app.ts#L441-L489)。

服务端到服务端的 Bearer 请求不应携带图床 Cookie、`Origin` 或浏览器 `Sec-Fetch-*` 头。源码只在发现会话 Cookie或浏览器信号时强制校验写请求的同源 Origin：[`apps/api/src/app.ts:L316-L355`](https://github.com/cshaizhihao/ou-image-hosting/blob/d68ceb36c8df2d9f25515bbab641ed4292693cb1/apps/api/src/app.ts#L316-L355)。源码未注册 CORS 插件，因此不要从浏览器直接跨域调用，应由 TimeBlog 后端代理上传。

### 3.2 Scope 与角色双重校验

源码中的权限常量是小写冒号形式，不是 `WRITE_IMAGES` 或 `DELETE_IMAGES`：

- `images:read`
- `images:write`
- `images:delete`

定义见 [`apps/api/src/store.ts:L470-L478`](https://github.com/cshaizhihao/ou-image-hosting/blob/d68ceb36c8df2d9f25515bbab641ed4292693cb1/apps/api/src/store.ts#L470-L478)。中间件同时检查工作区角色等级和 Token scope；Token 还被禁止访问 `admin`、`owner` capability：[`apps/api/src/access.ts:L27-L66`](https://github.com/cshaizhihao/ou-image-hosting/blob/d68ceb36c8df2d9f25515bbab641ed4292693cb1/apps/api/src/access.ts#L27-L66)。

| 操作 | 最低工作区角色 | Token scope | 源码依据 |
| --- | --- | --- | --- |
| 上传图片 | `editor` | `images:write` | `POST /uploads` 调用 `requireCapability(principal, "write", ["images:write"])`，[`uploads.ts:L1210-L1242`](https://github.com/cshaizhihao/ou-image-hosting/blob/d68ceb36c8df2d9f25515bbab641ed4292693cb1/apps/api/src/uploads.ts#L1210-L1242) |
| 列表/单图元数据 | `viewer` | `images:read` | [`uploads.ts:L947-L1014`](https://github.com/cshaizhihao/ou-image-hosting/blob/d68ceb36c8df2d9f25515bbab641ed4292693cb1/apps/api/src/uploads.ts#L947-L1014)、[`image-details.ts:L370-L391`](https://github.com/cshaizhihao/ou-image-hosting/blob/d68ceb36c8df2d9f25515bbab641ed4292693cb1/apps/api/src/image-details.ts#L370-L391) |
| 回收站列表 | `viewer` | `images:read` | [`organization.ts:L809-L827`](https://github.com/cshaizhihao/ou-image-hosting/blob/d68ceb36c8df2d9f25515bbab641ed4292693cb1/apps/api/src/organization.ts#L809-L827) |
| 移入回收站 | `editor` | `images:delete` | [`uploads.ts:L1017-L1066`](https://github.com/cshaizhihao/ou-image-hosting/blob/d68ceb36c8df2d9f25515bbab641ed4292693cb1/apps/api/src/uploads.ts#L1017-L1066) |
| 从回收站恢复 | `editor` | `images:delete` | [`organization.ts:L829-L890`](https://github.com/cshaizhihao/ou-image-hosting/blob/d68ceb36c8df2d9f25515bbab641ed4292693cb1/apps/api/src/organization.ts#L829-L890) |
| 永久删除 | `admin` | `images:delete` | [`organization.ts:L850-L950`](https://github.com/cshaizhihao/ou-image-hosting/blob/d68ceb36c8df2d9f25515bbab641ed4292693cb1/apps/api/src/organization.ts#L850-L950)，但 API Token 会被 `API_TOKEN_RESTRICTED` 拒绝 |
| 获取 `originalUrl`/`thumbnailUrl` | 无 Token scope | 无 | `/files/:id/:variant` 未调用认证，仅执行交付策略，[`uploads.ts:L1684-L1733`](https://github.com/cshaizhihao/ou-image-hosting/blob/d68ceb36c8df2d9f25515bbab641ed4292693cb1/apps/api/src/uploads.ts#L1684-L1733) |

建议给 TimeBlog 独立 Token 配置 `images:write`、`images:read`、`images:delete` 三项。只做上传时理论上可仅授予 `images:write`，但这样无法用无副作用的列表请求验证 Token，也无法执行媒体生命周期对账和软删除。

## 4. 上传合同

### 4.1 请求

```http
POST /api/uploads
Authorization: Bearer <API_TOKEN>
X-Workspace-ID: <WORKSPACE_ID>  # 可选
Content-Type: multipart/form-data; boundary=...

file=<单张图片二进制>
```

服务端使用 `request.file()` 并明确要求第一个文件字段名为 `file`；缺失或字段名不符返回 `400 FILE_REQUIRED`。路由限流为每分钟 60 次：[`apps/api/src/uploads.ts:L1210-L1242`](https://github.com/cshaizhihao/ou-image-hosting/blob/d68ceb36c8df2d9f25515bbab641ed4292693cb1/apps/api/src/uploads.ts#L1210-L1242)。普通认证上传没有多文件数组合同，应逐文件请求。

限制：

- 硬上限 20 MiB，同时受工作区 `uploadMaxBytes` 的更小值约束。
- 像素上限 80,000,000。
- 支持 `jpeg`、`png`、`webp`、`gif`、`avif`、`heic`、`heif`，同时受工作区允许格式约束。
- 服务端通过 Sharp/HEIC 解码检查真实内容，不只信任客户端 MIME。
- 空文件返回 `EMPTY_FILE`，无效图像返回 `INVALID_IMAGE`。

常量和格式见 [`uploads.ts:L46-L94`](https://github.com/cshaizhihao/ou-image-hosting/blob/d68ceb36c8df2d9f25515bbab641ed4292693cb1/apps/api/src/uploads.ts#L46-L94)，有效上限和内容检查见 [`uploads.ts:L707-L776`](https://github.com/cshaizhihao/ou-image-hosting/blob/d68ceb36c8df2d9f25515bbab641ed4292693cb1/apps/api/src/uploads.ts#L707-L776)，工作区默认值见 [`store.ts:L581-L595`](https://github.com/cshaizhihao/ou-image-hosting/blob/d68ceb36c8df2d9f25515bbab641ed4292693cb1/apps/api/src/store.ts#L581-L595)。

### 4.2 成功响应

新文件返回 HTTP `201`，相同工作区内的重复内容返回 HTTP `200`。响应结构：

```json
{
  "image": {
    "id": "6b6f57f4-...",
    "name": "example.png",
    "size": 123456,
    "mime": "image/png",
    "format": "png",
    "width": 1200,
    "height": 800,
    "sha256": "<64-char-hex>",
    "thumbnailUrl": "/api/files/6b6f57f4-.../thumbnail",
    "originalUrl": "/api/files/6b6f57f4-.../original",
    "favorite": false,
    "publicVisible": false,
    "albumIds": [],
    "tagIds": [],
    "createdAt": "2026-08-13T00:00:00.000Z",
    "updatedAt": "2026-08-13T00:00:00.000Z"
  },
  "duplicate": false
}
```

`publicImage()` 的完整字段见 [`uploads.ts:L226-L260`](https://github.com/cshaizhihao/ou-image-hosting/blob/d68ceb36c8df2d9f25515bbab641ed4292693cb1/apps/api/src/uploads.ts#L226-L260)，状态码选择见 [`uploads.ts:L1234-L1242`](https://github.com/cshaizhihao/ou-image-hosting/blob/d68ceb36c8df2d9f25515bbab641ed4292693cb1/apps/api/src/uploads.ts#L1234-L1242)。

服务端以 SHA-256 在工作区内去重；若已有同内容图片在回收站，重新上传会恢复原记录并返回原 `id`、`duplicate: true`：[`uploads.ts:L778-L810`](https://github.com/cshaizhihao/ou-image-hosting/blob/d68ceb36c8df2d9f25515bbab641ed4292693cb1/apps/api/src/uploads.ts#L778-L810)。源码没有 `Idempotency-Key`，但相同字节重试具有内容级幂等性。

### 4.3 交付 URL

默认模板是 `{domain}/api/files/{id}/{variant}`，默认不启用签名 URL 和防盗链：[`store.ts:L610-L629`](https://github.com/cshaizhihao/ou-image-hosting/blob/d68ceb36c8df2d9f25515bbab641ed4292693cb1/apps/api/src/store.ts#L610-L629)。当未设置自定义域名时，`originalUrl` 和 `thumbnailUrl` 可能是 `/api/files/...` 相对路径，TimeBlog 必须以图床 Endpoint 的 origin 解析为绝对 URL后再保存。

签名 URL 会附加 `expires`、`signature` 并在 TTL 后失效；防盗链可要求 Referer 在白名单内：[`delivery.ts:L38-L64`](https://github.com/cshaizhihao/ou-image-hosting/blob/d68ceb36c8df2d9f25515bbab641ed4292693cb1/apps/api/src/delivery.ts#L38-L64)、[`L79-L124`](https://github.com/cshaizhihao/ou-image-hosting/blob/d68ceb36c8df2d9f25515bbab641ed4292693cb1/apps/api/src/delivery.ts#L79-L124)。TimeBlog 需要长期保存公开链接，因此启用外部发布前应确认：

- `signedUrls` 关闭，否则保存的 URL 会过期；
- 防盗链关闭，或博客公开站点 origin 已加入 `allowedReferers`，并根据直链场景决定是否允许空 Referer；
- `originalUrl` 为 HTTPS，解析后仍是预期图床域名，防止上游异常响应造成 URL 注入。

`publicVisible` 只控制图床公共图库可见性；认证上传默认传入 `false`。文件交付路由不检查该字段，因此不能把它理解为文件访问权限。

## 5. 查询、回收与删除

### 5.1 查询

`GET /api/uploads` 支持 `q`、`format`、`page`、`limit`、`sort`，其中 `limit` 为 1–100，返回：

```json
{
  "images": [],
  "page": 1,
  "limit": 1,
  "total": 0,
  "totalPages": 1
}
```

该接口需要 `images:read`，适合作为不上传文件的认证与协议探测：[`uploads.ts:L947-L1014`](https://github.com/cshaizhihao/ou-image-hosting/blob/d68ceb36c8df2d9f25515bbab641ed4292693cb1/apps/api/src/uploads.ts#L947-L1014)。`GET /api/uploads/{id}` 同样需要 `images:read`。

### 5.2 移入回收站

图床没有 `DELETE /uploads/{id}` 路由。软删除合同为：

```http
POST /api/uploads/bulk
Authorization: Bearer <API_TOKEN>
Content-Type: application/json

{"ids":["<IMAGE_ID>"],"action":"trash"}
```

要求 `images:delete` 和至少 `editor` 角色；单次 1–100 个不重复 id，成功响应至少包含 `updated` 数量。实现见 [`uploads.ts:L1017-L1066`](https://github.com/cshaizhihao/ou-image-hosting/blob/d68ceb36c8df2d9f25515bbab641ed4292693cb1/apps/api/src/uploads.ts#L1017-L1066)。

### 5.3 永久删除限制

永久删除合同位于 `POST /api/trash/bulk`，请求 `{"ids":[...],"action":"delete"}`。它要求 `admin` capability 与 `images:delete`：[`organization.ts:L829-L950`](https://github.com/cshaizhihao/ou-image-hosting/blob/d68ceb36c8df2d9f25515bbab641ed4292693cb1/apps/api/src/organization.ts#L829-L950)。但通用权限中间件对所有 API Token 的 `admin`/`owner` 请求都返回 `403 API_TOKEN_RESTRICTED`，所以 **TimeBlog 使用 API Token 无法永久清除文件**。

TimeBlog 的删除适配只能安全映射为“移入图床回收站”。永久清理由图床管理员登录后台执行，或等待上游提供专用于服务 Token 的最小权限清除接口；不能用保存管理员 Cookie 绕过权限模型。

## 6. 错误结构与处理策略

公开错误统一为：

```json
{
  "error": {
    "code": "TOKEN_SCOPE_DENIED",
    "message": "API Token scope 不足"
  }
}
```

Fastify 校验错误被折叠为 `400 INVALID_REQUEST`，限流为 `429 RATE_LIMITED`，未分类异常为 `500 INTERNAL_ERROR`：[`apps/api/src/app.ts:L378-L413`](https://github.com/cshaizhihao/ou-image-hosting/blob/d68ceb36c8df2d9f25515bbab641ed4292693cb1/apps/api/src/app.ts#L378-L413)。适配器应按 HTTP 状态与 `error.code` 分类，不匹配结构时只记录截断、脱敏后的摘要。

常见错误：

| HTTP | code | 含义与处理 |
| --- | --- | --- |
| 400 | `FILE_REQUIRED`、`EMPTY_FILE`、`INVALID_IMAGE`、`INVALID_REQUEST` | 请求或文件问题，不自动重试 |
| 401 | `INVALID_API_TOKEN`、`UNAUTHENTICATED` | Token 无效/过期，不重试，标记配置异常 |
| 403 | `TOKEN_SCOPE_DENIED`、`INSUFFICIENT_ROLE` | scope 或角色不足，不重试 |
| 403 | `TOKEN_IP_DENIED`、`TOKEN_WORKSPACE_MISMATCH` | IP 白名单或工作区不匹配，不重试 |
| 403 | `INVALID_ORIGIN` | 请求错误携带了浏览器/Origin 信息，修正请求 |
| 413 | `FILE_TOO_LARGE`、`QUOTA_EXCEEDED` | 大小或配额问题，不重试 |
| 415 | `UNSUPPORTED_IMAGE`、`FORMAT_NOT_ALLOWED`、`HEIC_CONVERSION_FAILED` | 格式/转换问题，不重试 |
| 429 | `RATE_LIMITED` | 有界指数退避，优先遵守 `Retry-After`（若响应提供） |
| 500/502/503/504 | `INTERNAL_ERROR` 或代理错误 | 有界重试并保留本地原件 |

网络超时或读取响应失败可能发生在图床已经写入之后。此时用相同字节重试，服务端 SHA-256 去重会返回原记录和 `duplicate: true`；TimeBlog 仍应比较 `image.sha256` 与本地哈希，不可只凭状态码认定成功。

## 7. cURL 示例

以下全部使用占位值，不包含真实 Token：

```bash
OU_UPLOAD_ENDPOINT='https://image.example.com/api/uploads'
OU_TOKEN='ouh_<prefix>_<secret>'
OU_WORKSPACE_ID='<workspace-id>'
```

上传：

```bash
curl --fail-with-body \
  --request POST "$OU_UPLOAD_ENDPOINT" \
  --header "Authorization: Bearer $OU_TOKEN" \
  --header "X-Workspace-ID: $OU_WORKSPACE_ID" \
  --form 'file=@./example.png;type=image/png'
```

不要手写 multipart 的 `Content-Type`，让 cURL 生成 boundary。`X-Workspace-ID` 不需要时可删除该行。

验证 Token 和读取合同：

```bash
curl --fail-with-body \
  --get "${OU_UPLOAD_ENDPOINT}?limit=1" \
  --header "Authorization: Bearer $OU_TOKEN" \
  --header "X-Workspace-ID: $OU_WORKSPACE_ID"
```

移入回收站：

```bash
OU_API_BASE="${OU_UPLOAD_ENDPOINT%/uploads}"
IMAGE_ID='<image-id>'

curl --fail-with-body \
  --request POST "${OU_API_BASE}/uploads/bulk" \
  --header "Authorization: Bearer $OU_TOKEN" \
  --header 'Content-Type: application/json' \
  --data "{\"ids\":[\"$IMAGE_ID\"],\"action\":\"trash\"}"
```

## 8. TimeBlog 适配映射

TimeBlog 当前实现仍有意关闭外发：`customPublicProvider.ProtocolStatus()` 固定为 `unverified`、`PublishEnabled()` 固定为 `false`，保存后状态固定写入 `configured_unverified`；测试只做不带 Token 的 HEAD 可达性探测，见 [`services/core/integration_settings.go:L68-L100`](../../services/core/integration_settings.go#L68-L100)、[`L218-L266`](../../services/core/integration_settings.go#L218-L266)、[`L292-L352`](../../services/core/integration_settings.go#L292-L352)。本文完成的是可实施的源码合同，不等于运行时代码已经启用上传。

后续实现 `ou_image_hosting_v1` 适配器时，应采用以下映射：

| TimeBlog 字段/动作 | OU Image Hosting |
| --- | --- |
| Provider 协议 | 固定标识 `ou_image_hosting_v1`，绑定本文审计版本合同 |
| Endpoint | 严格的 HTTPS `.../api/uploads`，拒绝 userinfo、非 443 端口、query、fragment 和内网地址 |
| Secret | API Token，仅加密保存；读取接口只返回 `tokenConfigured` 和掩码 |
| 可选工作区 | `X-Workspace-ID`，仅用于额外防错，不作为授权来源 |
| 上传 | `POST` multipart，字段 `file` |
| 媒体唯一键 | `image.id` 保存为远端 `provider_key` |
| 内容校验 | 本地 SHA-256 必须等于 `image.sha256` |
| 公开链接 | 将 `image.originalUrl` 按图床 origin 解析为绝对 HTTPS URL 后保存 |
| 缩略图 | 可选保存绝对化后的 `image.thumbnailUrl` |
| 删除 | `POST /api/uploads/bulk`，`action=trash`；不声称永久删除 |

### 8.1 从 `configured_unverified` 升级为可发布的门禁

只有同时满足以下条件，`PublishEnabled()` 才能返回 `true`：

1. Endpoint 通过严格校验，Token 已加密保存，协议显式选择 `ou_image_hosting_v1`。
2. 使用保存的 Token 调用 `GET /api/uploads?limit=1` 成功，并验证响应基本结构；因此推荐 Token 包含 `images:read`。
3. 图床交付设置确认不会生成短期签名 URL，并验证原图 URL 对博客展示稳定可达；防盗链启用时博客站点已在白名单。
4. 后端实际上传实现已完成超时、大小限制、响应上限、域名校验、错误映射和脱敏日志测试。
5. 至少一次受控的上传—读取—软删除端到端验证成功；测试对象必须是一次性小图，不使用生产内容。

单纯 HEAD 可达或 `401/403` 只能证明网络路径存在，不能证明 Token、scope、multipart 字段、响应结构和交付 URL 可用，不能解除 fail-closed 状态。

### 8.2 重试、超时与安全要求

- 客户端设置独立的连接、请求和响应体读取超时；上传请求总体超时建议从 30 秒起，并以部署网络实测调整。
- 仅对网络瞬断、`429` 和 `5xx` 做少量有界重试；`4xx` 配置、格式、权限和配额错误不重试。
- 限制响应 JSON 大小并严格解析字段类型；拒绝非 HTTPS 或跳转到不同 host 的响应链。
- 日志、审计事件和错误响应绝不记录 `Authorization`、Token、完整上游响应体或配置密文。上游自身也在日志中明确 redact 授权头和 secret 字段：[`apps/api/src/app.ts:L288-L304`](https://github.com/cshaizhihao/ou-image-hosting/blob/d68ceb36c8df2d9f25515bbab641ed4292693cb1/apps/api/src/app.ts#L288-L304)。
- TimeBlog 本地媒体仍是规范原件。外部上传失败、URL 失效或图床回收均不能删除本地原件。
- 轮换 Token 时采用“新 Token 验证成功后替换旧 Token”，随后在图床后台撤销旧 Token；Token 创建与撤销接口本身仅允许图床管理员会话，不应由 TimeBlog 自动管理。

## 9. 已知边界

- 当前审计版本没有供 API Token 使用的永久删除能力。
- 当前审计版本没有显式的批量多文件认证上传合同，每张图片单独请求。
- 当前审计版本没有 `Idempotency-Key`，仅有工作区内 SHA-256 内容去重。
- 当前审计版本的 `originalUrl` 可能为相对地址，也可能在启用签名后成为短期 URL。
- `publicVisible` 不代表原图访问授权，不能依赖该字段保护私人媒体。
- 本文没有向真实图床发送请求或上传文件；所有结论来自固定提交的源码。

## 10. TimeBlog 运行时实现（2026-08-13）

TimeBlog 已实现 `ou_image_hosting_v1` 异步适配器，但部署和测试过程不会向真实图床上传或删除：

- Tus finalize 始终先校验并保留 `local_private` 规范原件；符合 OU 格式和 20 MiB 上限的图片，在配置启用后排入 `publish_media` PostgreSQL job。
- 媒体状态独立记录为 `not_requested`、`pending`、`publishing`、`published`、`failed` 或 `trash_pending`，不复用本地文件的 `ready` 状态。失败时本地文件继续可读，媒体库显示脱敏错误并提供重试。
- 成功时将 `provider` 更新为 `custom_public`，保存 `image.id` 为 `provider_key`，保存同源、稳定且非签名的 `originalUrl` 为 `public_url`；本地 `storage_path` 不清除。
- 适配器拒绝包含 `Expires`、`Signature`、`token` 或任意 `X-Amz-*` 签名参数的交付链接；普通图片尺寸、格式等非鉴权 query 参数允许保留。
- `stablePublicUrls` 是强制启用确认：图床不得使用短期签名链接，防盗链必须允许博客公开域名。
- `syncDeletes` 默认关闭。关闭时，本地永久删除不会调用图床，worker 输出不含 Token 和 URL 的 `external_media_retained` 结构化日志，明确记录远端副本被策略保留；开启时需要 `images:delete`，远端软回收失败会阻止本地删除。
- 无副作用验证调用 `GET /api/uploads?limit=1`。具有 `images:read` 时状态为 `verified`；仅有 `images:write` 时返回 `scope_limited`，管理员确认稳定公开 URL 后仍可启用上传。验证不会创建探针图片。
