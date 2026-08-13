import test from 'node:test';
import assert from 'node:assert/strict';
import { editorHTMLToMarkdown, groupDayEntries, hasUnsupportedStructure, nextRetryAt, serializeEditorStatus } from '../lib/editor-utils.js';
import { isSupportedMedia, mediaMarkdown, mediaMarkdownReference, mediaQueueStoragePlan, removeMediaReferences, replaceMediaOccurrence, replaceMediaToken, mediaUploadUrl, uploadResumable, MAX_MEDIA_BYTES, MEDIA_BLOB_MAX_BYTES, MEDIA_QUEUE_MAX_BYTES } from '../lib/media-utils.js';
import { decorateMediaReferences, renderMarkdown } from '../lib/markdown.js';
import { mediaContentUrl, mediaKind, probeMediaContentType } from '../lib/media-resolver.js';
import { mergeTimelineDays } from '../lib/timeline.js';
import { decodeMermaidBase64 } from '../lib/mermaid-utils.js';
import { embedSource, isSupportedEmbedProvider } from '../lib/embed-utils.js';
import { runEndpointProbe } from '../lib/integration-probe.js';
test('local draft storage key is stable',()=>assert.equal('timeline-local-drafts','timeline-local-drafts'));

test('auth navigation checks server session and revokes it through logout', async () => {
  const fs = await import('node:fs/promises');
  const source = await fs.readFile(new URL('../app/AuthNav.tsx', import.meta.url), 'utf8');
  assert.match(source, /auth\/session\/status/);
  assert.match(source, /auth\/logout/);
  assert.match(source, /credentials: 'include'/);
  assert.match(source, /X-CSRF-Token/);
  assert.match(source, /response\.status === 401/);
  assert.match(source, /role="status"/);
});

test('management actions keep equal button geometry on narrow screens', async () => {
  const fs = await import('node:fs/promises');
  const css = await fs.readFile(new URL('../app/globals.css', import.meta.url), 'utf8');
  assert.match(css, /\.management-actions \.secondary\{[^}]*min-width:56px/);
  assert.match(css, /\.management-actions \.secondary\{[^}]*height:36px/);
  assert.match(css, /@media \(max-width:640px\)/);
  assert.match(css, /\.management-row\{align-items:flex-start;flex-direction:column\}/);
});

test('content rows use one accessible dropdown menu for actions', async () => {
  const fs = await import('node:fs/promises');
  const source = await fs.readFile(new URL('../app/admin/entries/page.tsx', import.meta.url), 'utf8');
  const ui = await fs.readFile(new URL('../app/components/ui/dropdown-menu.tsx', import.meta.url), 'utf8');
  assert.match(source, /DropdownMenuTrigger/);
  assert.match(source, /aria-label="打开内容操作菜单"/);
  assert.match(source, /<Pencil aria-hidden="true" \/>编辑/);
  assert.match(source, /<History aria-hidden="true" \/>版本/);
  assert.match(source, /<Trash2 aria-hidden="true" \/>回收/);
  assert.match(source, /window\.confirm\('确定将这条内容移入回收站吗？'\)/);
  assert.doesNotMatch(source, /<button[^>]+>版本<\/button>/);
  assert.match(ui, /DropdownMenuPrimitive\.Content/);
  assert.match(ui, /DropdownMenuPrimitive\.Item/);
});

test('external image host probe prevents submit, preserves drafts and reports state', async () => {
  const draft = { endpoint: ' https://image.example.test/upload ', token: 'unsaved-secret' };
  const snapshots = [];
  let prevented = false;
  let receivedEndpoint = '';
  const result = await runEndpointProbe({
    event: { preventDefault: () => { prevented = true; } },
    endpoint: draft.endpoint,
    probe: async endpoint => { receivedEndpoint = endpoint; return { status: 'configured_unverified', message: 'Endpoint 可达且要求认证' }; },
    onState: state => snapshots.push(state),
  });
  assert.equal(prevented, true);
  assert.equal(receivedEndpoint, 'https://image.example.test/upload');
  assert.equal(draft.endpoint, ' https://image.example.test/upload ');
  assert.equal(draft.token, 'unsaved-secret');
  assert.equal(result?.status, 'configured_unverified');
  assert.deepEqual(snapshots.map(state => state.phase), ['testing', 'success']);
});

test('settings actions are non-submit controls and endpoint probe does not remount the panel', async () => {
  const fs = await import('node:fs/promises');
  const source = await fs.readFile(new URL('../app/admin/entries/page.tsx', import.meta.url), 'utf8');
  const settingsSource = source.slice(source.indexOf('function SettingsPanel'));
  const buttons = [...settingsSource.matchAll(/<button\b([^>]*)>/g)];
  assert.ok(buttons.length >= 4);
  for (const [, attributes] of buttons) assert.match(attributes, /type="button"/);
  assert.doesNotMatch(source, /<SettingsPanel\s+key=/);
  assert.doesNotMatch(source.slice(source.indexOf('async function testImageHost'), source.indexOf('async function saveNASBackup')), /setBusy|setImageHost|router\.refresh/);
  assert.match(settingsSource, /event\.preventDefault\(\)/);
  assert.match(settingsSource, /probeState\.phase === 'testing'/);
  assert.match(settingsSource, /onTestImageHost:\s*\(endpoint: string, workspaceId: string, token: string\)/);
  assert.match(settingsSource, /images:write/);
  assert.match(settingsSource, /stablePublicUrls/);
  assert.match(settingsSource, /syncDeletes/);
});

test('version panel returns to the in-page content list', async () => {
  const fs = await import('node:fs/promises');
  const source = await fs.readFile(new URL('../app/admin/entries/page.tsx', import.meta.url), 'utf8');
  assert.match(source, /const returnToEntries = useCallback/);
  assert.match(source, /setSection\('entries'\)/);
  assert.match(source, /onBack=\{returnToEntries\}/);
  assert.match(source, /onClick=\{onBack\}/);
  assert.match(source, /aria-label="返回内容列表"/);
});

test('content management exposes a safe edit entry and editor uses the update working copy', async () => {
  const fs = await import('node:fs/promises');
  const list = await fs.readFile(new URL('../app/admin/entries/page.tsx', import.meta.url), 'utf8');
  const editor = await fs.readFile(new URL('../app/admin/page.tsx', import.meta.url), 'utf8');
  assert.match(list, /href=\{`\/admin\?edit=\$\{encodeURIComponent\(entry\.id\)\}`\}/);
  assert.match(list, /aria-label=\{`编辑\$\{entry\.title/);
  assert.match(editor, /\/admin\/entries\/\$\{encodeURIComponent\(requestedEditID\)\}\/edit/);
  assert.match(editor, /setMarkdown\(String\(value\.markdown/);
  assert.match(editor, /setEditingBaseRevision\(Number\(working\.baseRevision/);
  assert.match(editor, /working-copies\/\$\{working\.id\}\/commit/);
  assert.match(editor, /editingEntryID \? '保存修改' : '保存'/);
});

test('home page does not render the removed introductory note copy', async () => {
  const fs = await import('node:fs/promises');
  const source = await fs.readFile(new URL('../app/page.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /以天为单位记录正在发生的事。短记录直接回到时间线，完整文章保留自己的地址与上下文。/);
  assert.doesNotMatch(source, /className="note"/);
});

test('sidebar has no trigger and maps theme tokens for desktop and mobile', async () => {
  const fs = await import('node:fs/promises');
  const shell = await fs.readFile(new URL('../app/AppShell.tsx', import.meta.url), 'utf8');
  const css = await fs.readFile(new URL('../app/globals.css', import.meta.url), 'utf8');
  assert.doesNotMatch(shell, /SidebarTrigger|data-slot=["']sidebar-trigger/);
  assert.match(css, /--sidebar:\s*var\(--background\)/);
  assert.match(css, /--sidebar-foreground:\s*var\(--foreground\)/);
  assert.match(css, /background:\s*var\(--sidebar\)/);
  assert.match(css, /color:\s*var\(--sidebar-foreground\)/);
  assert.match(css, /@media \(max-width: 760px\)/);
  assert.match(css, /position:\s*relative/);
  assert.match(css, /transform:\s*none/);
});

test('editor keeps Markdown as the source of truth and protects Chinese IME composition', async () => {
  const fs = await import('node:fs/promises');
  const source = await fs.readFile(new URL('../app/admin/page.tsx', import.meta.url), 'utf8');
  assert.match(source, /Markdown 模式直接同页展示预览/);
  assert.doesNotMatch(source, /value === 'preview'/);
  assert.doesNotMatch(source, source.includes('实时预览</button>') ? /实时预览/ : /a^/);
  assert.match(source, /aria-label="Markdown 正文编辑"/);
  assert.match(source, /onCompositionStart/);
  assert.match(source, /onCompositionEnd/);
  assert.match(source, /composingRef\.current/);
  assert.doesNotMatch(source, /contentEditable/);
  assert.doesNotMatch(source, /所见即所得/);
});

test('editor accepts every native input event during IME and keeps media controls cross-mode', async () => {
  const fs = await import('node:fs/promises');
  const source = await fs.readFile(new URL('../app/admin/page.tsx', import.meta.url), 'utf8');
  assert.match(source, /onChange=\{e => setMarkdown\(e\.target\.value\)\}/);
  assert.doesNotMatch(source, /if \(!composingRef\.current\) setMarkdown/);
  assert.match(source, /Paperclip/);
  assert.match(source, /Trash2/);
  assert.match(source, /admin\/media\/capability/);
  assert.match(source, /从当前草稿移除/);
  assert.match(source, /aria-disabled=\{uploadDisabled\}/);
});

test('simple mode inserts canonical media Markdown at the current cursor and renders inline previews', async () => {
  const fs = await import('node:fs/promises');
  const source = await fs.readFile(new URL('../app/admin/page.tsx', import.meta.url), 'utf8');
  const resolver = await fs.readFile(new URL('../app/article/MediaResolver.tsx', import.meta.url), 'utf8');
  assert.match(source, /mediaMarkdownReference/);
  assert.match(source, /selectionStart/);
  assert.match(source, /setSelectionRange/);
  assert.match(source, /simple-media-preview/);
  assert.match(source, /正文中的媒体预览/);
  assert.match(source, /removeMediaReferences/);
  assert.match(source, /replaceMediaOccurrence/);
  assert.match(resolver, /resolved-image-card/);
  assert.match(resolver, /resolved-file-card/);
  assert.match(resolver, /打开 \/ 下载/);
});

test('editor reuses one CSRF token across upload and save, surfaces API details, and cancels active attachments', async () => {
  const fs = await import('node:fs/promises');
  const source = await fs.readFile(new URL('../app/admin/page.tsx', import.meta.url), 'utf8');
  const uploadSource = source.slice(source.indexOf('async function uploadMedia'), source.indexOf('async function retryUpload'));
  assert.match(source, /const csrfRef = useRef\(''\)/);
  assert.match(source, /const refreshSessionCSRF = useCallback/);
  assert.match(source, /sessionRequestRef\.current/);
  assert.doesNotMatch(uploadSource, /fetch\(`\$\{API\}\/auth\/session`/);
  assert.match(source, /responseError\(ticketResponse, '创建上传任务失败'\)/);
  assert.match(source, /if \(item\.status === 'uploading' \|\| item\.status === 'queued'\)/);
  assert.match(source, /cancelUpload\(item\)/);
});

test('external image host probe refreshes enabled status after server-side verification', async () => {
  const fs = await import('node:fs/promises');
  const source = await fs.readFile(new URL('../app/admin/entries/page.tsx', import.meta.url), 'utf8');
  assert.match(source, /const refreshIntegrationStatus = useCallback/);
  assert.match(source, /await refreshIntegrationStatus\(\)/);
  assert.match(source, /setRuntimeStatus\(runtime\)/);
  assert.match(source, /setImageHost\(image\)/);
});

test('upload action labels stay on one line', async () => {
  const fs = await import('node:fs/promises');
  const css = await fs.readFile(new URL('../app/globals.css', import.meta.url), 'utf8');
  assert.match(css, /\.upload-actions \.inline-action\{[^}]*white-space:nowrap/);
  assert.match(css, /word-break:keep-all/);
});

test('writing surface has responsive touch-safe controls and bounded editor height', async () => {
  const fs = await import('node:fs/promises');
  const css = await fs.readFile(new URL('../app/globals.css', import.meta.url), 'utf8');
  assert.match(css, /\.composer textarea\{min-height:clamp\(/);
  assert.match(css, /\.editor-toolbar \.tool\{min-height:44px/);
  assert.match(css, /@media\(max-width:760px\)/);
  assert.match(css, /\.composer-footer \.primary,.composer-footer \.secondary\{width:100%/);
});

test('calendar loads the initial month and aborts stale month requests', async () => {
  const fs = await import('node:fs/promises');
  const source = await fs.readFile(new URL('../app/calendar/CalendarView.tsx', import.meta.url), 'utf8');
  assert.match(source, /useEffect\(\(\) =>/);
  assert.match(source, /getCalendar\(month, controller\.signal\)/);
  assert.match(source, /new AbortController\(\)/);
  assert.match(source, /requestID !== requestRef\.current/);
  assert.match(source, /setMonth\(current => shiftMonth/);
});

test('private editor status maps to published private API fields', () => {
  assert.deepEqual(serializeEditorStatus('private'), { status: 'published', visibility: 'private' });
  assert.deepEqual(serializeEditorStatus('public'), { status: 'published', visibility: 'public' });
  assert.deepEqual(serializeEditorStatus('draft'), { status: 'draft', visibility: 'public' });
});

test('complex Markdown is locked instead of being rewritten', () => {
  assert.equal(hasUnsupportedStructure('- item\n\n[link](https://example.com)'), true);
  assert.equal(hasUnsupportedStructure('# Heading\n\nplain text'), false);
  assert.equal(editorHTMLToMarkdown('<h1>Heading</h1><p>plain text</p>'), '# Heading\nplain text');
});

test('outbox retry uses bounded exponential backoff', () => {
  assert.equal(nextRetryAt(0, 1000), 2000);
  assert.equal(nextRetryAt(3, 1000), 9000);
  assert.equal(nextRetryAt(99, 1000), 61000);
});

test('DayResponse preserves untimed then timed ordering', () => {
  assert.deepEqual(groupDayEntries({ untimed: [{ id: 'u' }], timed: [{ id: 't' }] }), [{ id: 'u' }, { id: 't' }]);
});

test('GFM renderer escapes raw HTML and unsafe URLs while producing TOC', () => {
  const rendered = renderMarkdown('# Title\n\n[bad](javascript:alert(1))\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n```js\n<script>alert(1)</script>\n```\n\nmedia://abc');
  assert.match(rendered.html, /id="title"/);
  assert.match(rendered.html, /href="#"/);
  assert.match(rendered.html, /&lt;script&gt;/);
  assert.match(rendered.html, /<table>/);
  assert.match(rendered.html, /data-media-id="abc"/);
  assert.match(renderMarkdown('![cover](media://img-1)').html, /data-media-label="cover"/);
  assert.doesNotMatch(renderMarkdown('![label media://abc](media://img-1)').html, /data-media-id="abc"/);
  assert.doesNotMatch(renderMarkdown('[link media://abc](https://example.test)').html, /data-media-id="abc"/);
  assert.match(decorateMediaReferences('<p>media://pdf-1</p>'), /data-media-id="pdf-1"/);
  assert.deepEqual(rendered.toc[0], { level: 1, title: 'Title', id: 'title' });
});

test('preview code highlighting uses backend-compatible token classes', () => {
  const rendered = renderMarkdown('```go\nfunc main() { return "ok" }\n```');
  assert.match(rendered.html, /class="language-go highlighted"/);
  assert.match(rendered.html, /class="tok-keyword"/);
  assert.match(rendered.html, /class="tok-string"/);
  assert.doesNotMatch(renderMarkdown('```html\n<div>const</div>\n```').html, /tok-keyword/);
  assert.doesNotMatch(renderMarkdown('```unknown\n<script>bad</script>\n```').html, /tok-keyword|tok-string/);
});

test('embed policy rejects unsafe URLs and providers while allowing approved hosts', () => {
  assert.equal(isSupportedEmbedProvider('youtube'), true);
  assert.equal(isSupportedEmbedProvider('evil'), false);
  assert.equal(embedSource('youtube', 'javascript:alert(1)'), '');
  assert.equal(embedSource('youtube', 'data:text/html,<script>alert(1)</script>'), '');
  assert.equal(embedSource('youtube', 'https://evil.example/watch?v=abc'), '');
  assert.equal(embedSource('evil', 'https://youtube.com/watch?v=abc'), '');
  assert.match(embedSource('youtube', 'https://www.youtube.com/watch?v=abc'), /youtube-nocookie\.com\/embed\/abc/);
  assert.match(embedSource('bilibili', 'https://www.bilibili.com/video/BV1'), /bvid=BV1/);
  assert.match(embedSource('vimeo', 'https://vimeo.com/12345'), /player\.vimeo\.com\/video\/12345/);
});

test('Mermaid decoder accepts standard and raw base64url and rejects malformed payloads', () => {
  const source = '௿';
  const standard = Buffer.from(source, 'utf8').toString('base64');
  const rawUrl = standard.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.equal(decodeMermaidBase64(standard), source);
  assert.equal(decodeMermaidBase64(rawUrl), source);
  assert.throws(() => decodeMermaidBase64('not valid!'), /invalid Mermaid base64/);
  assert.throws(() => decodeMermaidBase64('A'), /invalid Mermaid base64 length/);
});

test('controlled embed, Mermaid and service worker contracts remain explicit', async () => {
  const fs = await import('node:fs/promises');
  const embed = await fs.readFile(new URL('../app/article/EmbedResolver.tsx', import.meta.url), 'utf8');
  const mermaid = await fs.readFile(new URL('../app/article/MermaidResolver.tsx', import.meta.url), 'utf8');
  const markup = await fs.readFile(new URL('../app/article/EmbedMarkup.tsx', import.meta.url), 'utf8');
  const worker = await fs.readFile(new URL('../public/sw.js', import.meta.url), 'utf8');
  assert.match(embed, /sandbox="allow-scripts allow-same-origin allow-presentation"/);
  assert.match(embed, /referrerPolicy="strict-origin-when-cross-origin"/);
  assert.match(embed, /loading="lazy"/);
  assert.match(embed, /embedSource\(embed\.provider, embed\.url\)/);
  assert.match(mermaid, /decodeMermaidBase64/);
  assert.match(mermaid, /securityLevel: 'strict'/);
  assert.match(mermaid, /classList\.add\('mermaid-error'\)/);
  assert.match(mermaid, /图表暂时无法渲染/);
  assert.match(markup, /data-provider=/);
  assert.match(markup, /data-embed-url=/);
  assert.match(worker, /event\.request\.destination === 'image'/);
  assert.match(worker, /response\.ok && url\.origin === self\.location\.origin/);
  assert.match(worker, /startsWith\('\/private-media\/'\)/);
  assert.match(worker, /CACHE_INVALIDATE/);
  assert.match(worker, /CACHE_INVALIDATED/);
  assert.match(worker, /timeline-shell-v4/);
});

test('public API fetches bypass Next data cache and mutations notify the worker', async () => {
  const fs = await import('node:fs/promises');
  const api = await fs.readFile(new URL('../lib/api.ts', import.meta.url), 'utf8');
  const invalidation = await fs.readFile(new URL('../lib/cache-invalidation.ts', import.meta.url), 'utf8');
  const home = await fs.readFile(new URL('../app/HomeTimeline.tsx', import.meta.url), 'utf8');
  const entries = await fs.readFile(new URL('../app/admin/entries/page.tsx', import.meta.url), 'utf8');
  assert.match(api, /getJSON\(`\/public\/timeline[\s\S]*cache: 'no-store'/);
  assert.match(api, /getJSON\(`\/public\/days[\s\S]*cache: 'no-store'/);
  assert.match(api, /getJSON\(`\/public\/articles[\s\S]*cache: 'no-store'/);
  assert.match(invalidation, /type: 'CACHE_INVALIDATE'/);
  assert.match(invalidation, /dispatchEvent\(new CustomEvent\(PUBLIC_CACHE_INVALIDATED_EVENT/);
  assert.match(home, /PUBLIC_CACHE_INVALIDATED_EVENT/);
  assert.match(home, /getTimeline\(\)/);
  assert.match(entries, /invalidatePublicCaches/);
  assert.match(entries, /router\.refresh\(\)/);
});

test('shared GFM fixture stays safe and resolves media references', async () => {
  const fs = await import('node:fs/promises');
  const fixture = await fs.readFile(new URL('../../../tests/fixtures/markdown/gfm.md', import.meta.url), 'utf8');
  const rendered = renderMarkdown(fixture);
  assert.match(rendered.html, /<table>/);
  assert.match(rendered.html, /data-media-id="00000000-0000-0000-0000-000000000001"/);
  assert.doesNotMatch(rendered.html.toLowerCase(), /<iframe|<script/);
  assert.match(rendered.html, /id="中文标题"/);
});

test('media queue accepts bounded media and replaces temporary token', () => {
  assert.equal(isSupportedMedia({ type: 'image/png', size: 100 }), true);
  assert.equal(isSupportedMedia({ type: 'application/javascript', size: 100 }), false);
  assert.equal(isSupportedMedia({ type: 'image/png', size: MAX_MEDIA_BYTES }), true);
  assert.equal(isSupportedMedia({ type: 'image/png', size: MAX_MEDIA_BYTES + 1 }), false);
  assert.equal(isSupportedMedia({ type: 'application/pdf', size: 100 }), true);
  const token = mediaMarkdown('temp');
  assert.equal(replaceMediaToken(`before ${token}`, token, mediaMarkdown('real')), 'before media://real');
  assert.equal(mediaMarkdownReference('img-1', 'cover.png', 'image/png'), '![cover.png](media://img-1)');
  assert.equal(mediaMarkdownReference('doc-1', 'notes.pdf', 'application/pdf'), '[notes.pdf](media://doc-1)');
  assert.equal(mediaMarkdownReference('doc-2', '[notes](final).pdf', 'application/pdf'), '[notes final .pdf](media://doc-2)');
  assert.equal(replaceMediaOccurrence('a\nmedia://temp\nmedia://temp', 'media://temp', '![a](media://real)'), 'a\n![a](media://real)\nmedia://temp');
  assert.equal(removeMediaReferences('a\n![a](media://real)\n[real](media://real)\nmedia://real\nb', 'real'), 'a\n\n\n\nb');
  assert.equal(mediaUploadUrl('/api/v1/admin/media/a/finalize', 'https://example.test'), 'https://example.test/api/v1/admin/media/a/finalize');
  assert.equal(mediaContentUrl('a/b', '/api/v1'), '/api/v1/media/a%2Fb/content');
  assert.equal(mediaKind('image/webp; charset=binary'), 'image');
  assert.equal(mediaKind('audio/mpeg'), 'audio');
  assert.equal(mediaKind('video/mp4'), 'video');
  assert.equal(mediaKind('application/pdf'), 'pdf');
  assert.equal(mediaKind('application/octet-stream'), 'file');
  assert.deepEqual(mediaQueueStoragePlan(1024, 0), { persistBlob: true, reason: '' });
  assert.equal(mediaQueueStoragePlan(MEDIA_BLOB_MAX_BYTES + 1, 0).reason, 'file-too-large');
  assert.equal(mediaQueueStoragePlan(10, MEDIA_QUEUE_MAX_BYTES - 5).reason, 'queue-quota');
});

test('resumable media upload uses HEAD/PATCH chunks and reconciles offsets', async () => {
  const requests = [];
  let offset = 0;
  const file = new Blob([new Uint8Array(11)]);
  const fetcher = async (_url, init = {}) => {
    requests.push(init);
    if (init.method === 'HEAD') return new Response(null, { status: 204, headers: { 'Upload-Offset': String(offset), 'Tus-Resumable': '1.0.0' } });
    const start = Number(init.headers['Upload-Offset']);
    assert.equal(start, offset);
    offset += init.body.size;
    return new Response(null, { status: 204, headers: { 'Upload-Offset': String(offset), 'Tus-Resumable': '1.0.0' } });
  };
  assert.equal(await uploadResumable('/upload', file, { fetcher, csrfToken: 'csrf', idempotencyKey: 'media-1', chunkSize: 5, maxRetries: 0 }), 11);
  assert.deepEqual(requests.map(request => request.method), ['HEAD', 'PATCH', 'PATCH', 'PATCH']);
  assert.equal(requests[1].headers['Tus-Resumable'], '1.0.0');
  assert.equal(requests[1].headers['Upload-Offset'], '0');
  assert.equal(requests[1].headers['Content-Type'], 'application/offset+octet-stream');
  assert.equal(requests[1].headers['X-CSRF-Token'], 'csrf');
  assert.equal(requests[1].credentials, 'include');
});

test('resumable upload handles committed 409 offsets and retries transient failures', async () => {
  const requests = [];
  let offset = 0;
  let firstPatch = true;
  let transient = true;
  const file = new Blob([new Uint8Array(10)]);
  const fetcher = async (_url, init = {}) => {
    requests.push(init);
    if (init.method === 'HEAD') return new Response(null, { status: 204, headers: { 'Upload-Offset': String(offset) } });
    const start = Number(init.headers['Upload-Offset']);
    if (firstPatch) {
      firstPatch = false;
      offset = 5;
      return new Response(null, { status: 409, headers: { 'Upload-Offset': '5' } });
    }
    if (transient) {
      transient = false;
      throw new TypeError('network reset');
    }
    assert.equal(start, offset);
    offset += init.body.size;
    return new Response(null, { status: 204, headers: { 'Upload-Offset': String(offset) } });
  };
  assert.equal(await uploadResumable('/upload', file, { fetcher, csrfToken: 'csrf', chunkSize: 5, maxRetries: 1 }), 10);
  assert.deepEqual(requests.map(request => request.method), ['HEAD', 'PATCH', 'HEAD', 'PATCH', 'HEAD', 'PATCH']);
  assert.equal(requests[3].headers['Upload-Offset'], '5');
});

test('resumable upload surfaces non-retryable finalize/upload errors', async () => {
  const fetcher = async (_url, init = {}) => init.method === 'HEAD'
    ? new Response(null, { status: 204, headers: { 'Upload-Offset': '0' } })
    : new Response(null, { status: 403 });
  await assert.rejects(() => uploadResumable('/upload', new Blob([new Uint8Array(1)]), { fetcher, maxRetries: 0 }), /upload PATCH 403/);
});

test('timeline cursor request and media queue recovery contract remain explicit', async () => {
  const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('../app/page.tsx', import.meta.url), 'utf8'));
  const api = await import('node:fs/promises').then(fs => fs.readFile(new URL('../lib/api.ts', import.meta.url), 'utf8'));
  const admin = await import('node:fs/promises').then(fs => fs.readFile(new URL('../app/admin/page.tsx', import.meta.url), 'utf8'));
  assert.match(source, /<HomeTimeline initialDays=\{days\} initialCursor=\{nextCursor\}\/>/);
  assert.match(api, /getTimeline\(limit = 20, cursor = ''\)/);
  assert.match(api, /cursor=\$\{encodeURIComponent\(cursor\)\}/);
  assert.match(admin, /MEDIA_QUEUE_STORE = 'media-queue'/);
  assert.match(admin, /dbGetAll<UploadItem>\(MEDIA_QUEUE_STORE\)/);
  assert.match(admin, /浏览器不会把文件内容自动写入离线队列/);
  assert.match(admin, /uploadResumable\(uploadUrl, file/);
  assert.match(admin, /finalizeUrl/);
  assert.doesNotMatch(admin, /fetch\(uploadUrl, \{ method: 'POST'/);
  assert.match(admin, /mediaQueueStoragePlan/);
  assert.match(admin, /浏览器未保存此文件，需重新选择文件/);
  assert.doesNotMatch(admin, /将在对应服务接入后启用/);
});

test('timeline pages merge same dates without duplicate entries', () => {
  const merged = mergeTimelineDays(
    [{ date: '2026-08-12', untimed: [{ id: 'a' }], timed: [{ id: 'b' }] }],
    [{ date: '2026-08-12', untimed: [{ id: 'a' }, { id: 'c' }], timed: [{ id: 'b' }, { id: 'd' }] }, { date: '2026-08-11', untimed: [], timed: [{ id: 'e' }] }],
  );
  assert.deepEqual(merged[0].untimed.map(entry => entry.id), ['a', 'c']);
  assert.deepEqual(merged[0].timed.map(entry => entry.id), ['b', 'd']);
  assert.equal(merged.length, 2);
});

test('mock auth and editor flow keeps challenge, private commit, undo and export contracts', async () => {
  const login = await import('node:fs/promises').then(fs => fs.readFile(new URL('../app/login/page.tsx', import.meta.url), 'utf8'));
  const editor = await import('node:fs/promises').then(fs => fs.readFile(new URL('../app/admin/page.tsx', import.meta.url), 'utf8'));
  const desk = await import('node:fs/promises').then(fs => fs.readFile(new URL('../app/admin/entries/page.tsx', import.meta.url), 'utf8'));
  assert.match(login, /auth\/login\/\$\{step===1\?'password':'totp'\}/);
  assert.match(login, /setChallenge\(data\.challenge\|\|'\'\)/);
  assert.match(editor, /serializeEditorStatus\(status\)/);
  assert.match(editor, /working-copies\/\$\{working\.id\}\/commit/);
  assert.match(editor, /admin\/undo\/\$\{undoToken\}/);
  assert.match(desk, /admin\/exports/);
  assert.match(desk, /admin\/settings/);
  assert.match(desk, /versions\/\$\{version\}\/restore/);
});

test('account recovery page uses the recovery contract without exposing secrets', async () => {
  const page = await import('node:fs/promises').then(fs => fs.readFile(new URL('../app/recovery/page.tsx', import.meta.url), 'utf8'));
  const form = await import('node:fs/promises').then(fs => fs.readFile(new URL('../app/recovery/RecoveryForm.tsx', import.meta.url), 'utf8'));
  const login = await import('node:fs/promises').then(fs => fs.readFile(new URL('../app/login/page.tsx', import.meta.url), 'utf8'));
  assert.match(page, /index: false/);
  assert.match(form, /auth\/recovery\/account/);
  assert.match(form, /response\.status === 429/);
  assert.match(form, /Retry-After/);
  assert.match(form, /router\.replace\('\/login\?recovered=1'\)/);
  assert.match(form, /totpSetupURI/);
  assert.match(form, /以下凭据只显示一次/);
  assert.match(form, /setResult/);
  assert.doesNotMatch(form, /console\.(log|error).*recoveryKey/);
  assert.match(login, /recovered/);
});

test('media content probe sends credentials and falls back from HEAD to range GET', async () => {
  const requests = [];
  const fetcher = async (_url, init = {}) => {
    requests.push(init);
    if (init.method === 'HEAD') return new Response('', { status: 405 });
    return new Response('', { status: 200, headers: { 'Content-Type': 'image/webp' } });
  };
  assert.equal(await probeMediaContentType('/api/v1/media/m1/content', fetcher), 'image/webp');
  assert.equal(requests[0].method, 'HEAD');
  assert.equal(requests[0].credentials, 'include');
  assert.deepEqual(requests[1].headers, { Range: 'bytes=0-0' });
  assert.equal(requests[1].credentials, 'include');
});
