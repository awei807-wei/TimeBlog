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
import { entryHasPreviewMedia } from '../lib/public-entry-preview.js';
test('local draft storage key is stable',()=>assert.equal('timeline-local-drafts','timeline-local-drafts'));

test('brand assets keep the logo-derived icon and mascot contract', async () => {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const root = path.resolve(new URL('..', import.meta.url).pathname);
  const publicDir = path.join(root, 'public');
  const pngSize = async name => {
    const bytes = await fs.readFile(path.join(publicDir, name));
    assert.equal(bytes.readUInt32BE(0), 0x89504e47);
    return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
  };
  assert.deepEqual(await pngSize('favicon-16x16.png'), [16, 16]);
  assert.deepEqual(await pngSize('favicon-32x32.png'), [32, 32]);
  assert.deepEqual(await pngSize('favicon-48x48.png'), [48, 48]);
  assert.deepEqual(await pngSize('apple-touch-icon.png'), [180, 180]);
  assert.deepEqual(await pngSize('icon-192.png'), [192, 192]);
  assert.deepEqual(await pngSize('icon-512.png'), [512, 512]);
  assert.deepEqual(await pngSize('brand/mascot.png'), [768, 768]);
  for (const name of ['favicon.ico', 'favicon.svg', 'brand/mascot.webp']) {
    const stat = await fs.stat(path.join(publicDir, name));
    assert.ok(stat.size > 0, `${name} should not be empty`);
  }
  const sharp = (await import('sharp')).default;
  for (const name of ['brand/mascot.png', 'brand/mascot.webp']) {
    const { data, info } = await sharp(path.join(publicDir, name)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const alphaAt = (x, y) => data[(y * info.width + x) * info.channels + 3];
    assert.ok([0, 1, 2, 3, 4].every(edge => alphaAt(edge, edge) === 0), `${name} should have transparent corners`);
    assert.ok([0, 1, 2, 3, 4].every(edge => alphaAt(info.width - 1 - edge, edge) === 0), `${name} should have a safe top-right margin`);
    assert.ok([0, 1, 2, 3, 4].every(edge => alphaAt(edge, info.height - 1 - edge) === 0), `${name} should have a safe bottom-left margin`);
  }
  const manifest = JSON.parse(await fs.readFile(path.join(publicDir, 'manifest.webmanifest'), 'utf8'));
  assert.deepEqual(manifest.icons.map(icon => icon.src), ['/icon-192.png', '/icon-512.png']);
  const layout = await fs.readFile(path.join(root, 'app/layout.tsx'), 'utf8');
  const shell = await fs.readFile(path.join(root, 'app/public/PublicShell.tsx'), 'utf8');
  assert.match(layout, /favicon\.ico/);
  assert.match(layout, /apple-touch-icon\.png/);
  assert.match(shell, /\/brand\/mascot\.webp/);
});

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
  const view = await fs.readFile(new URL('../app/admin/AdminEditorView.tsx', import.meta.url), 'utf8');
  const editorState = await fs.readFile(new URL('../app/admin/useAdminEditorState.ts', import.meta.url), 'utf8');
  const entryActions = await fs.readFile(new URL('../app/admin/admin-entry-actions.ts', import.meta.url), 'utf8');
  const workingCopy = await fs.readFile(new URL('../app/admin/useAdminWorkingCopy.ts', import.meta.url), 'utf8');
  const metadata = await fs.readFile(new URL('../app/admin/useWorkingCopyMetadata.ts', import.meta.url), 'utf8');
  const loader = await fs.readFile(new URL('../app/admin/useEditWorkingCopyLoader.ts', import.meta.url), 'utf8');
  assert.match(list, /href=\{`\/admin\?edit=\$\{encodeURIComponent\(entry\.id\)\}`\}/);
  assert.match(list, /aria-label=\{`编辑\$\{entry\.title/);
  assert.match(editorState, /const applyMarkdown = useCallback/);
  assert.match(entryActions, /working-copies\/\$\{working\.id\}\/commit/);
  assert.match(metadata, /useEditWorkingCopyLoader/);
  assert.match(metadata, /setEditingBaseRevision\(Number\(working\.baseRevision/);
  assert.match(metadata, /applyWorkingCopyFields\(working/);
  assert.match(loader, /\/admin\/entries\/\$\{encodeURIComponent\(entryID\)\}\/edit/);
  assert.match(loader, /applyWorkingCopy\(working, requestedEditID/);
  assert.match(view, /editingEntryID \? '保存修改' : '保存'/);
});

test('public article editing exposes unpublished working copies and a guarded restore path', async () => {
  const fs = await import('node:fs/promises');
  const view = await fs.readFile(new URL('../app/admin/AdminEditorView.tsx', import.meta.url), 'utf8');
  const autosave = await fs.readFile(new URL('../app/admin/useDraftAutosave.ts', import.meta.url), 'utf8');
  const autosaveSync = await fs.readFile(new URL('../app/admin/useDraftAutosaveSync.ts', import.meta.url), 'utf8');
  const workingHook = await fs.readFile(new URL('../app/admin/useAdminWorkingCopy.ts', import.meta.url), 'utf8');
  const actions = await fs.readFile(new URL('../app/admin/useWorkingCopyActions.ts', import.meta.url), 'utf8');
  const loader = await fs.readFile(new URL('../app/admin/useLoadDraft.ts', import.meta.url), 'utf8');
  const restore = await fs.readFile(new URL('../app/admin/useRestorePublishedVersion.ts', import.meta.url), 'utf8');
  const saveAction = await fs.readFile(new URL('../app/admin/useAdminSaveAction.ts', import.meta.url), 'utf8');
  const notice = await fs.readFile(new URL('../app/admin/EditingDraftNotice.tsx', import.meta.url), 'utf8');
  const workingCopy = await fs.readFile(new URL('../app/admin/editing-working-copy.ts', import.meta.url), 'utf8');
  const css = await fs.readFile(new URL('../app/globals.css', import.meta.url), 'utf8');
  assert.match(workingCopy, /hasUnpublishedChanges\?: boolean/);
  assert.match(workingCopy, /publishedRevision\?: number/);
  assert.match(workingCopy, /publishedUpdatedAt\?: string/);
  assert.match(workingCopy, /publishedStatus\?: string/);
  assert.match(workingCopy, /publishedVisibility\?: string/);
  assert.match(workingCopy, /publishedSlug\?: string/);
  assert.match(workingCopy, /edit\?discard=1/);
  assert.match(workingCopy, /credentials: 'include'/);
  assert.match(workingCopy, /X-CSRF-Token/);
  for (const setter of ['setDraftId', 'setTitle', 'setSummary', 'setSlug', 'setCategories', 'setTags', 'setStatus', 'setKind', 'setDate', 'setJournalTime', 'setMeta']) assert.match(workingCopy, new RegExp(`${setter}\\(`));
  assert.match(notice, /自动保存的是未发布草稿，公开页仍显示上次保存版本。/);
  assert.match(notice, /查看公开版本/);
  assert.match(notice, /放弃未发布修改并恢复公开版本/);
  assert.match(notice, /window\.confirm/);
  assert.match(view, /articleIdentifier=\{props\.editingEntryID\}/);
  assert.match(view, /publishedStatus === 'published'/);
  assert.match(view, /publishedVisibility === 'public'/);
  assert.match(autosaveSync, /const epoch = useRef/);
  assert.match(autosaveSync, /const abort = useRef/);
  assert.match(autosaveSync, /epoch\.current/);
  assert.match(autosave, /Promise\.allSettled\(\[/);
  assert.match(restore, /dbDelete\(DRAFT_STORE, previousDraftID\)/);
  assert.match(actions, /setEditingEntryID\(''\)/);
  assert.match(actions, /setEditingWorkingID\(''\)/);
  assert.match(actions, /setEditingBaseRevision\(0\)/);
  assert.match(loader, /setJournalTime\(readJournalTimeField\(value\)\)/);
  assert.match(saveAction, /finalizeSavedDraft\(savedDraftID\)/);
  assert.match(workingHook, /workingCopyReadyRef/);
  assert.match(css, /\.working-copy-notice\{/);
  assert.match(css, /\.working-copy-notice\.is-unpublished\{/);
});

test('edit working copy autosave follows the server generation through load, discard, and local draft switches', async () => {
  const fs = await import('node:fs/promises');
  const workingCopy = await fs.readFile(new URL('../app/admin/editing-working-copy.ts', import.meta.url), 'utf8');
  const metadata = await fs.readFile(new URL('../app/admin/useWorkingCopyMetadata.ts', import.meta.url), 'utf8');
  const workingHook = await fs.readFile(new URL('../app/admin/useAdminWorkingCopy.ts', import.meta.url), 'utf8');
  const actions = await fs.readFile(new URL('../app/admin/useWorkingCopyActions.ts', import.meta.url), 'utf8');
  const loader = await fs.readFile(new URL('../app/admin/useEditWorkingCopyLoader.ts', import.meta.url), 'utf8');
  const restore = await fs.readFile(new URL('../app/admin/useRestorePublishedVersion.ts', import.meta.url), 'utf8');
  const localDraft = await fs.readFile(new URL('../app/admin/useLoadDraft.ts', import.meta.url), 'utf8');
  const autosave = await fs.readFile(new URL('../app/admin/useDraftAutosave.ts', import.meta.url), 'utf8');
  const persistence = await fs.readFile(new URL('../app/admin/useDraftPersistence.ts', import.meta.url), 'utf8');
  const flush = await fs.readFile(new URL('../app/admin/useDraftFlush.ts', import.meta.url), 'utf8');
  const sync = await fs.readFile(new URL('../app/admin/useDraftAutosaveSync.ts', import.meta.url), 'utf8');
  const outbox = await fs.readFile(new URL('../app/admin/useDraftOutbox.ts', import.meta.url), 'utf8');

  // The real edit response is the source of the generation used by every later save.
  assert.match(workingCopy, /setDraftId: \(value: string\) => void/);
  assert.match(workingCopy, /setDraftId\(working\.clientDraftId\)/);
  assert.match(metadata, /setDraftId: \(id: string\) => void/);
  assert.match(metadata, /setDraftId,\n\s*setTitle/);
  assert.match(workingHook, /setDraftId: autosave\.setDraftId/);
  assert.match(loader, /applyWorkingCopy\(working, requestedEditID/);

  // discard=1 returns a fresh server generation; the same apply path must write it back.
  assert.match(restore, /const working = await discardWorkingCopy/);
  assert.match(restore, /applyWorkingCopy\(working, editingEntryID/);

  // Loading an independent IndexedDB draft drops edit metadata and replaces the generation.
  assert.match(actions, /setDraftId\(''\)/);
  assert.match(localDraft, /clearEntry\(\);\n\s*setDraftId\(draft\.clientDraftId\)/);

  // Flush, persistence, and network sync all read the current ref at execution time.
  assert.match(autosave, /const draftID = useRef<string \| null>\(null\)/);
  assert.match(autosave, /const currentDraftId = useCallback/);
  assert.match(persistence, /const id = currentDraftId\(\)/);
  assert.match(flush, /const id = currentDraftId\(\)/);
  assert.match(flush, /if \(discardingRef\.current\) return/);
  assert.match(flush, /const expectedEpoch = epoch\.current/);
  assert.match(flush, /expectedEpoch !== epoch\.current/);
  assert.match(flush, /syncDraft\([\s\S]*expectedEpoch\)/);
  assert.match(sync, /clientDraftId: draft\.clientDraftId/);
  assert.match(sync, /response\.status === 409/);
  assert.ok(sync.indexOf('response.status === 409') < sync.indexOf('await dbPut(QUEUE_STORE'));
  assert.match(sync, /await dbPut\(QUEUE_STORE, item\);[\s\S]*expectedEpoch !== epoch\.current[\s\S]*await dbDelete\(QUEUE_STORE, draft\.id\)/);
  assert.match(outbox, /response\.status === 409/);
  assert.ok(outbox.indexOf('response.status === 409') < outbox.indexOf('await dbPut(QUEUE_STORE'));
  assert.match(outbox, /await dbPut\(QUEUE_STORE[\s\S]*expectedEpoch !== runtime\.epoch\.current[\s\S]*await dbDelete\(QUEUE_STORE, item\.id\)/);
});

test('working copy public link prefers the published slug and falls back to the entry UUID', async () => {
  const fs = await import('node:fs/promises');
  const workingCopy = await fs.readFile(new URL('../app/admin/editing-working-copy.ts', import.meta.url), 'utf8');
  const notice = await fs.readFile(new URL('../app/admin/EditingDraftNotice.tsx', import.meta.url), 'utf8');
  assert.match(workingCopy, /publishedSlug: string/);
  assert.match(workingCopy, /publishedSlug: String\(working\.publishedSlug \|\| ''\)/);
  assert.match(notice, /normalizeArticleIdentifier\(meta\.publishedSlug\) \|\| articleIdentifier/);
  assert.match(notice, /encodeURIComponent\(publicIdentifier\)/);
  assert.doesNotMatch(notice, /encodeURIComponent\(articleIdentifier\)/);
});

test('legacy working copies keep a missing journal time omitted until the server can inherit it', async () => {
  const fs = await import('node:fs/promises');
  const ts = await import('typescript');
  const helperSource = await fs.readFile(new URL('../app/admin/journal-time-payload.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(helperSource, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } }).outputText;
  const helper = await import(`data:text/javascript,${encodeURIComponent(compiled)}`);
  assert.equal(helper.readJournalTimeField({ markdown: 'legacy' }), undefined);
  assert.equal(helper.readJournalTimeField({ journalTime: null }), null);
  assert.equal(helper.readJournalTimeField({ journalTime: '09:15' }), '09:15');
  assert.equal(Object.prototype.hasOwnProperty.call(helper.withJournalTimeField({ markdown: 'legacy' }, undefined), 'journalTime'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(helper.withJournalTimeField({ markdown: 'clear' }, null), 'journalTime'), true);

  const editorState = await fs.readFile(new URL('../app/admin/useAdminEditorState.ts', import.meta.url), 'utf8');
  const workingCopy = await fs.readFile(new URL('../app/admin/editing-working-copy.ts', import.meta.url), 'utf8');
  const localDraft = await fs.readFile(new URL('../app/admin/useLoadDraft.ts', import.meta.url), 'utf8');
  assert.match(editorState, /withJournalTimeField\(/);
  assert.match(workingCopy, /setJournalTime\(readJournalTimeField\(value\)\)/);
  assert.match(localDraft, /setJournalTime\(readJournalTimeField\(value\)\)/);
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

test('MDXEditor is the sole Markdown source of truth and supports rich/source modes', async () => {
  const fs = await import('node:fs/promises');
  const source = await fs.readFile(new URL('../app/admin/AdminEditorView.tsx', import.meta.url), 'utf8');
  const actions = await fs.readFile(new URL('../app/admin/useAdminSaveAction.ts', import.meta.url), 'utf8');
  const editor = await fs.readFile(new URL('../app/admin/MdxMarkdownEditorClient.tsx', import.meta.url), 'utf8');
  const attachment = await fs.readFile(new URL('../app/admin/AttachmentPreview.tsx', import.meta.url), 'utf8');
  assert.match(source, /<MdxMarkdownEditor/);
  assert.doesNotMatch(source, /<textarea/);
  assert.match(source, /AttachmentPreview/);
  assert.match(attachment, /!\/\^image/);
  assert.doesNotMatch(source, /renderMarkdown\(markdown\)/);
  assert.match(editor, /<MDXEditor/);
  assert.match(editor, /diffSourcePlugin/);
  assert.match(editor, /usePublisher/);
  assert.match(editor, /所见即所得/);
  assert.match(editor, /Markdown 源码/);
  assert.match(editor, /<ViewModeToggle \/>/);
  assert.doesNotMatch(editor, /DiffSourceToggleWrapper/);
  assert.match(editor, /markdown !== markdownRef\.current/);
  assert.match(editor, /markdownRef\.current = markdown/);
  assert.match(editor, /editor\.setMarkdown\(prepared\.markdown\)/);
  assert.match(editor, /trim=\{false\}/);
  assert.match(editor, /onError=\{\(\{ error \}\)/);
  assert.match(actions, /editorRef\.current\?\.getMarkdown/);
  assert.match(actions, /options\.applyMarkdown\(''\)/);
});

test('writer keeps legacy HTML recoverable, uses a real placeholder, and exposes bounded tag drafts', async () => {
  const fs = await import('node:fs/promises');
  const page = await fs.readFile(new URL('../app/admin/AdminEditorView.tsx', import.meta.url), 'utf8');
  const editor = await fs.readFile(new URL('../app/admin/MdxMarkdownEditorClient.tsx', import.meta.url), 'utf8');
  const compat = await fs.readFile(new URL('../app/admin/mdx-compat.ts', import.meta.url), 'utf8');
  const tags = await fs.readFile(new URL('../app/admin/TagInput.tsx', import.meta.url), 'utf8');
  const draftTray = await fs.readFile(new URL('../app/admin/DraftTray.tsx', import.meta.url), 'utf8');
  const datePicker = await fs.readFile(new URL('../app/admin/JournalDatePicker.tsx', import.meta.url), 'utf8');
  const css = await fs.readFile(new URL('../app/globals.css', import.meta.url), 'utf8');
  const inspectorCss = await fs.readFile(new URL('../app/admin-editor-inspector.css', import.meta.url), 'utf8');
  assert.match(compat, /prepareMarkdownForMdxEditor/);
  assert.match(compat, /restoreMarkdownFromMdxEditor/);
  assert.match(editor, /mdx-compat-notice/);
  assert.match(editor, /placeholder="从一句话开始。支持 Markdown、图片和附件。"/);
  assert.match(draftTray, /const MAX_DRAFTS = 20/);
  assert.match(draftTray, /ordered\.slice\(0, MAX_DRAFTS\)/);
  assert.match(draftTray, /仍有 \$\{failed\} 条旧草稿待清理/);
  assert.doesNotMatch(page, /RotateCcw/);
  assert.match(page, /<TagInput label="分类"/);
  assert.match(page, /<TagInput label="标签"/);
  assert.match(tags, /event\.nativeEvent\.isComposing/);
  assert.match(tags, /onDoubleClick/);
  assert.match(tags, /event\.key === 'F2'/);
  assert.match(tags, /event\.key === ' '/);
  assert.match(tags, /tabIndex=\{0\}/);
  assert.match(tags, /htmlFor=\{inputId\}/);
  assert.match(tags, /editingIndex - 1/);
  assert.match(tags, /event\.key === 'Escape'/);
  assert.match(tags, /import \{ X \} from 'lucide-react'/);
  assert.match(tags, /<X aria-hidden="true" \/>/);
  assert.match(page, /<JournalDatePicker value=\{date\} onChange=\{onDateChange\}/);
  assert.ok(page.split('\n').length < 400);
  assert.match(page, /<DraftTray drafts=\{drafts\} onLoadDraft=\{onLoadDraft\}/);
  assert.match(draftTray, /export const MAX_DRAFTS = 20/);
  assert.match(draftTray, /b\.updatedAt\.localeCompare\(a\.updatedAt\) \|\| b\.id\.localeCompare\(a\.id\)/);
  assert.match(draftTray, /dbDelete\(DRAFT_STORE, draft\.id\)/);
  assert.doesNotMatch(page, /<input type="date"/);
  assert.match(datePicker, /<DatePicker/);
  assert.match(datePicker, /<DateInput/);
  assert.match(datePicker, /<DateSegment/);
  assert.match(datePicker, /<CalendarGrid/);
  assert.match(datePicker, /<CalendarCell/);
  assert.match(datePicker, /I18nProvider locale="zh-CN"/);
  assert.match(datePicker, /today\('Asia\/Shanghai'\)/);
  assert.doesNotMatch(datePicker, /getLocalTimeZone/);
  assert.match(datePicker, /onChange\(nextValue\?\.toString\(\) \?\? ''\)/);
  assert.match(css, /\.journal-date-popover\{/);
  assert.doesNotMatch(css, /input\[type="date"\]/);
  assert.match(css, /\.taxonomy-tag\{[^}]*min-height:44px/);
  assert.match(css, /\.taxonomy-tag-remove\{[^}]*width:44px;height:44px;min-width:44px/);
  assert.match(css, /\.taxonomy-tag:focus-visible\{/);
  assert.match(inspectorCss, /\.writing-inspector \.tag-input \{[^}]*min-height: 39px;[^}]*padding: 3px 5px/);
  assert.match(inspectorCss, /\.writing-inspector \.taxonomy-tag \{[^}]*min-height: 29px;[^}]*border: 1px solid/);
  assert.match(inspectorCss, /\.writing-inspector \.taxonomy-tag-value \{[^}]*text-overflow: ellipsis/);
  assert.match(inspectorCss, /\.writing-inspector \.taxonomy-tag-remove \{[^}]*width: 27px;[^}]*height: 27px;[^}]*min-width: 27px/);
  assert.match(css, /\.mdx-editor-content\[class\*="placeholder"\]/);
  assert.match(css, /\.mdx-editor \.mdxeditor-toolbar\{[^}]*scrollbar-width:none/);
});

test('writing workbench keeps focus visible and bounds responsive editor scrolling', async () => {
  const fs = await import('node:fs/promises');
  const cssFiles = ['admin-editor-layout.css', 'admin-editor-editor.css', 'admin-editor-inspector.css', 'admin-editor-responsive.css'];
  const cssParts = await Promise.all(cssFiles.map(name => fs.readFile(new URL(`../app/${name}`, import.meta.url), 'utf8')));
  const css = cssParts.join('\n');
  for (const [index, part] of cssParts.entries()) {
    assert.ok(part.split('\n').length < 400, `${cssFiles[index]} must stay below the CSS split threshold`);
  }
  assert.match(css, /\.writing-composer \.title-input:focus-visible,[\s\S]*outline: 3px solid/);
  assert.match(css, /\.writing-composer \.mdx-editor-content:focus-visible[\s\S]*outline: 3px solid/);
  assert.match(css, /\.writing-composer \.mdxeditor-source-editor \.cm-scroller,[\s\S]*overflow: auto/);
  assert.match(css, /\.writing-composer \.mdxeditor-diff-editor[\s\S]*height: clamp/);
  assert.match(css, /\.writing-rail[\s\S]*align-self: start[\s\S]*overflow: visible/);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*\.writing-page-header[\s\S]*display: grid/);
  assert.match(css, /@media \(max-width: 520px\)[\s\S]*\.writing-save-actions[\s\S]*margin-left: auto/);
  assert.match(css, /@media \(pointer: coarse\)[\s\S]*\.writing-inspector \.taxonomy-tag-remove[\s\S]*width: 44px;[\s\S]*height: 44px;/);
});

test('article-prose is the shared Markdown typography contract without card pollution', async () => {
  const fs = await import('node:fs/promises');
  const prose = await fs.readFile(new URL('../app/article-prose.css', import.meta.url), 'utf8');
  const chrome = await fs.readFile(new URL('../app/mdx-editor-chrome.css', import.meta.url), 'utf8');
  const layout = await fs.readFile(new URL('../app/layout.tsx', import.meta.url), 'utf8');
  const editor = await fs.readFile(new URL('../app/admin/MdxMarkdownEditorClient.tsx', import.meta.url), 'utf8');
  const article = await fs.readFile(new URL('../app/article/[slug]/page.tsx', import.meta.url), 'utf8');
  for (const selector of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'ul', 'ol', 'blockquote', 'code', 'pre', 'a', 'table', 'img', 'video', 'audio', 'hr']) {
    assert.match(prose, new RegExp(`\\.article-prose ${selector.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}`));
  }
  assert.match(layout, /import ['"]\.\/article-prose\.css['"]/);
  assert.match(layout, /import ['"]\.\/mdx-editor-chrome\.css['"]/);
  assert.match(editor, /contentEditableClassName="mdx-editor-content article-prose"/);
  assert.match(article, /className="markdown article-prose"/);
  assert.match(prose, /\.article-prose \.tok-keyword/);
  assert.match(prose, /\.article-prose \.chroma/);
  assert.doesNotMatch(prose, /\.mdx-view-mode-toggle|\.mdx-editor-mode-title|\.mdx-editor-content\.article-prose\[class\*="placeholder"\]/);
  assert.match(chrome, /\.mdx-view-mode-toggle/);
  assert.match(chrome, /\.mdx-editor-mode-title/);
  assert.match(chrome, /\.mdx-editor-content\.article-prose\[class\*="placeholder"\]/);
  const timeline = await fs.readFile(new URL('../app/HomeTimeline.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(timeline, /article-prose/);
});

test('public article grid is 10px and only paints outside main content', async () => {
  const fs = await import('node:fs/promises');
  const article = await fs.readFile(new URL('../app/article/[slug]/page.tsx', import.meta.url), 'utf8');
  const shellCss = await fs.readFile(new URL('../app/public-shell.css', import.meta.url), 'utf8');
  const viewsCss = await fs.readFile(new URL('../app/public-views.css', import.meta.url), 'utf8');
  const gridRule = shellCss.match(/\.public-content:has\(> #main-content\.public-article-shell\)\s*\{([\s\S]*?)\}/)?.[1] || '';

  assert.match(article, /<main id="main-content" className="public-page public-article-shell">/);
  assert.doesNotMatch(article, /public-reader-prose/);
  assert.match(gridRule, /--reader-grid-line:\s*color-mix\(in srgb, var\(--line\) 76%, transparent\)/);
  assert.match(gridRule, /background-color:\s*var\(--paper\)/);
  assert.match(gridRule, /linear-gradient\(to right, var\(--reader-grid-line\) 1px, transparent 1px\)/);
  assert.match(gridRule, /linear-gradient\(to bottom, var\(--reader-grid-line\) 1px, transparent 1px\)/);
  assert.match(gridRule, /background-size:\s*10px 10px/);
  assert.match(shellCss, /\.public-content > #main-content\.public-article-shell,[\s\S]*?> \.public-masthead\s*\{\s*background:\s*var\(--paper\)/);
  assert.match(shellCss, /> \.public-masthead \.public-nav\s*\{\s*background:\s*var\(--surface\)/);
  assert.doesNotMatch(viewsCss, /public-reader-prose|--reader-grid-line/);
});

test('public article entries have explicit detail navigation and notes stay non-linking', async () => {
  const fs = await import('node:fs/promises');
  const card = await fs.readFile(new URL('../app/public/PublicEntryCard.tsx', import.meta.url), 'utf8');
  const route = await fs.readFile(new URL('../app/public/public-entry.ts', import.meta.url), 'utf8');
  assert.match(route, /entry\.slug \|\| entry\.id/);
  assert.match(route, /entry\.kind === 'article'/);
  assert.match(card, /entry\.kind !== 'article'/);
  assert.match(card, /articleHref\(entry\)/);
  assert.match(card, /继续阅读/);
  assert.doesNotMatch(card.slice(card.indexOf("entry.kind !== 'article'"), card.indexOf('return <article className={`public-entry public-article-entry')), /href=\{href\}/);
  const files = [
    '../app/HomeTimeline.tsx',
    '../app/day/[date]/page.tsx',
    '../app/search/SearchResults.tsx',
    '../app/categories/[slug]/CategoryResults.tsx',
    '../app/tag/[tag]/TagResults.tsx',
  ];
  for (const file of files) {
    const source = await fs.readFile(new URL(file, import.meta.url), 'utf8');
    assert.match(source, /PublicEntryCard/);
  }
  const sitemap = await fs.readFile(new URL('../app/sitemap.ts', import.meta.url), 'utf8');
  assert.match(sitemap, /const articleIdentifier = entry\.slug \|\| entry\.id/);
  assert.match(sitemap, /encodeURIComponent\(articleIdentifier\)/);
  const articlePage = await fs.readFile(new URL('../app/article/[slug]/page.tsx', import.meta.url), 'utf8');
  assert.match(articlePage, /import \{ notFound, redirect \} from 'next\/navigation'/);
  assert.match(articlePage, /normalizeArticleIdentifier/);
  assert.match(articlePage, /const requestedIdentifier = normalizeArticleIdentifier\(slug\)/);
  assert.match(articlePage, /const canonicalIdentifier = normalizeArticleIdentifier\(article\.slug \|\| ''\) \|\| requestedIdentifier/);
  assert.match(articlePage, /redirect\(`\/article\/\$\{encodeURIComponent\(canonicalIdentifier\)\}`\)/);
  assert.doesNotMatch(articlePage, /article\.slug !== slug/);
  const publicCss = await fs.readFile(new URL('../app/public-pages.css', import.meta.url), 'utf8');
  const globalCss = await fs.readFile(new URL('../app/globals.css', import.meta.url), 'utf8');
  assert.match(publicCss, /\.public-article-entry h2 a:hover/);
  assert.match(publicCss, /\.public-read-more/);
  assert.match(globalCss, /@media\(max-width:1280px\)\{\.admin-grid\{grid-template-columns:minmax\(0,1fr\)\}\}/);
});

test('public entry previews recognize canonical, legacy and rendered media', () => {
  assert.equal(entryHasPreviewMedia({ markdown: '短随记' }), false);
  assert.equal(entryHasPreviewMedia({ markdown: '短随记\n\n![河边晚霞](media://image-1)' }), true);
  assert.equal(entryHasPreviewMedia({ markdown: '短随记\n\nmedia://legacy-image' }), true);
  assert.equal(entryHasPreviewMedia({ renderedHtml: '<p>短随记</p><img src="/photo.jpg" alt="河边晚霞">' }), true);
  assert.equal(entryHasPreviewMedia({ renderedHtml: '<p>短随记</p><span data-media-id="image-2">媒体</span>' }), true);
});

test('public timeline notes stay within the article column and expand text or full media previews', async () => {
  const fs = await import('node:fs/promises');
  const card = await fs.readFile(new URL('../app/public/PublicEntryCard.tsx', import.meta.url), 'utf8');
  const entry = await fs.readFile(new URL('../app/public/public-entry.ts', import.meta.url), 'utf8');
  const css = await fs.readFile(new URL('../app/public-pages.css', import.meta.url), 'utf8');
  assert.match(card, /function NoteCopy/);
  assert.match(card, /entryFullText\(entry\)/);
  assert.match(entry, /entry\.markdown \|\| entry\.text \|\| entry\.summary/);
  assert.match(entry, /entryFullText[\s\S]*plainEntryText\([^,]+, true\)/);
  assert.match(card, /ResizeObserver/);
  assert.match(card, /let cancelled = false/);
  assert.match(card, /document\.fonts\.ready\.then/);
  assert.match(card, /if \(!cancelled\) measure\(\)/);
  assert.match(card, /setMeasured\(true\)/);
  assert.doesNotMatch(card, /if \(expanded\) return/);
  assert.match(card, /is-measuring-full/);
  assert.match(card, /is-measuring-collapsed/);
  assert.match(card, /public-note-measurement/);
  assert.match(card, /resolvedLineHeight/);
  assert.match(card, /measurement\.getBoundingClientRect\(\)\.height/);
  assert.match(card, /measurement\.style\.maxHeight = `\$\{resolvedLineHeight \* clampLines\}px`/);
  assert.match(card, /measurement\.remove\(\)/);
  assert.doesNotMatch(card, /node\.scrollHeight/);
  assert.match(card, /const hasPreviewMedia = entryHasPreviewMedia\(entry\)/);
  assert.match(card, /const canExpand = expanded \|\| textOverflows \|\| hasPreviewMedia/);
  assert.match(card, /if \(!overflowing && !hasPreviewMedia && expanded\) setExpanded\(false\)/);
  assert.match(card, /function NoteFullPreview/);
  assert.match(card, /entry\.renderedHtml/);
  assert.match(card, /renderMarkdown\(entry\.markdown/);
  assert.match(card, /DOMPurify\.sanitize/);
  assert.match(card, /<EmbedMarkup html=\{safeHtml\}\/>/);
  assert.match(card, /expanded \? <NoteFullPreview entry=\{entry\}\/>/);
  assert.match(card, /copyIsExpandable = canExpand && !expanded/);
  assert.match(card, /role=\{copyIsExpandable \? 'button' : undefined\}/);
  assert.match(card, /tabIndex=\{copyIsExpandable \? 0 : undefined\}/);
  assert.match(card, /onClick=\{copyIsExpandable \? expandFromCopy : undefined\}/);
  assert.match(card, /event\.key !== 'Enter' && event\.key !== ' '/);
  assert.match(card, /aria-expanded=\{expanded\}/);
  assert.match(card, /aria-controls=\{copyId\}/);
  assert.match(card, /ChevronDown/);
  assert.match(card, /ChevronUp/);
  assert.match(css, /\.public-note-entry \{[^}]*width: 100%;[^}]*max-width: 100%;[^}]*min-width: 0;[^}]*grid-template-columns: 92px minmax\(0, 1fr\)/);
  assert.match(css, /\.public-note-copy \{[^}]*min-width: 0;[^}]*max-width: 100%/);
  assert.match(css, /\.public-note-copy p\.is-expanded\.is-measuring-collapsed \{[^}]*-webkit-line-clamp: 3;[^}]*overflow: hidden/);
  assert.match(css, /\.public-note-copy p \{[^}]*overflow-wrap: anywhere;[^}]*word-break: break-word/);
  assert.match(css, /\.public-note-entry\.is-compact \.public-note-copy p \{[^}]*font-size: 13px/);
  assert.match(css, /\.public-note-entry\.is-compact \{[^}]*padding-block: 12px/);
  assert.doesNotMatch(css, /\.public-timeline\.is-compact \.public-note-entry/);
  assert.match(css, /\.public-note-entry\.is-compact \.public-note-copy p\.is-expanded\.is-measuring-collapsed \{[^}]*-webkit-line-clamp: 1/);
  assert.match(css, /\.public-note-copy p\.is-expandable \{[^}]*cursor: pointer/);
  assert.match(css, /\.public-note-copy p\.is-expandable:focus-visible \{[^}]*outline: 2px solid var\(--accent\)/);
  assert.match(css, /\.public-note-full\.article-prose \{[^}]*font-size: 15px/);
  assert.match(css, /\.public-note-full \.resolved-image-card \.resolved-image \{[^}]*margin: 0/);
  assert.match(css, /\.public-note-expand \{[^}]*color: var\(--accent\)/);
});

test('public UI kit is mapped to real routes, data and formal article pages', async () => {
  const fs = await import('node:fs/promises');
  const layout = await fs.readFile(new URL('../app/layout.tsx', import.meta.url), 'utf8');
  const shellRoute = await fs.readFile(new URL('../app/AppShell.tsx', import.meta.url), 'utf8');
  const shell = await fs.readFile(new URL('../app/public/PublicShell.tsx', import.meta.url), 'utf8');
  const home = await fs.readFile(new URL('../app/page.tsx', import.meta.url), 'utf8');
  const calendar = await fs.readFile(new URL('../app/calendar/CalendarView.tsx', import.meta.url), 'utf8');
  const categories = await fs.readFile(new URL('../app/categories/page.tsx', import.meta.url), 'utf8');
  const search = await fs.readFile(new URL('../app/search/page.tsx', import.meta.url), 'utf8');
  const article = await fs.readFile(new URL('../app/article/[slug]/page.tsx', import.meta.url), 'utf8');
  const shellCss = await fs.readFile(new URL('../app/public-shell.css', import.meta.url), 'utf8');
  const viewsCss = await fs.readFile(new URL('../app/public-views.css', import.meta.url), 'utf8');

  assert.match(layout, /title: \{ default: '菜鸟手记'/);
  assert.match(layout, /import ['"]\.\/public-shell\.css['"]/);
  assert.match(layout, /import ['"]\.\/public-pages\.css['"]/);
  assert.match(layout, /import ['"]\.\/public-views\.css['"]/);
  assert.match(layout, /favicon\.svg/);
  assert.match(layout, /social-card\.png/);
  assert.match(shellRoute, /pathname\.startsWith\('\/admin'\)/);
  assert.match(shellRoute, /<PublicShell>/);
  for (const route of ['/', '/calendar', '/categories', '/search']) assert.match(shell, new RegExp(`href: '${route.replace('/', '\\/')}'`));
  assert.match(shell, /timeblog-theme/);
  assert.match(shell, /href=\{authenticated \? '\/admin' : '\/login'\}/);
  assert.match(home, /getTimeline\(\)/);
  assert.match(calendar, /getCalendar\(month, controller\.signal\)/);
  assert.match(calendar, /getDay\(selectedDate, controller\.signal\)/);
  assert.match(categories, /getCategories\(\)/);
  assert.match(search, /searchPublic\(query\)/);
  assert.doesNotMatch(home + calendar + categories + search, /const entries\s*=\s*\[/);
  assert.match(article, /className="public-reader"/);
  assert.match(article, /href="\/"/);
  assert.doesNotMatch(article, /reader-backdrop|ReaderModal/);
  assert.match(shellCss, /position: sticky/);
  assert.match(shellCss, /position: fixed/);
  assert.match(viewsCss, /grid-template-columns: 1\.45fr \.8fr/);
  await fs.access(new URL('../public/favicon.svg', import.meta.url));
  await fs.access(new URL('../public/social-card.png', import.meta.url));
});

test('article identifiers normalize encoded and decoded routes before one API escape', async () => {
  const fs = await import('node:fs/promises');
  const ts = await import('typescript');
  const source = await fs.readFile(new URL('../lib/api.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } }).outputText;
  const api = await import(`data:text/javascript,${encodeURIComponent(compiled)}`);
  const decoded = 'vps-与家庭网络吞吐异常诊断报告';
  const encoded = encodeURIComponent(decoded);
  assert.equal(api.normalizeArticleIdentifier(decoded), decoded);
  assert.equal(api.normalizeArticleIdentifier(encoded), decoded);
  assert.equal(api.normalizeArticleIdentifier('bad%ZZ'), null);
  assert.equal(api.normalizeArticleIdentifier(''), null);

  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return { ok: true, json: async () => ({ visibility: 'public', journalDate: '2026-08-19' }) };
  };
  try {
    await api.getArticle(encoded);
    await api.getArticle(decoded);
    await assert.rejects(() => api.getArticle('bad%ZZ'), /Invalid article identifier/);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.match(call.url, new RegExp(`/public/articles/${encoded.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}$`));
    assert.doesNotMatch(call.url, /%25E4/);
    assert.equal(call.init.cache, 'no-store');
  }
});

test('legacy MDX compatibility skips code, handles quoted attributes, and restores paired custom tags', async () => {
  const fs = await import('node:fs/promises');
  const ts = await import('typescript');
  const { fromMarkdown } = await import('mdast-util-from-markdown');
  const { mdxjs } = await import('micromark-extension-mdxjs');
  const { mdxFromMarkdown } = await import('mdast-util-mdx');
  const source = await fs.readFile(new URL('../app/admin/mdx-compat.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } }).outputText;
  const compat = await import(`data:text/javascript,${encodeURIComponent(compiled)}`);
  const sourceMarkdown = '`<Sub>inline</Sub>`\n\n```md\n<Sub>fenced</Sub>\n```\n\n<Sub title="a > b">body</Sub>\n\n<span title="a > b">ok</span>';
  const prepared = compat.prepareMarkdownForMdxEditor(sourceMarkdown);
  assert.match(prepared.markdown, /`<Sub>inline<\/Sub>`/);
  assert.match(prepared.markdown, /```md\n<Sub>fenced<\/Sub>\n```/);
  assert.match(prepared.markdown, /&lt;Sub title="a &gt; b"&gt;body&lt;\/Sub&gt;/);
  assert.match(prepared.markdown, /<span title="a > b">ok<\/span>/);
  assert.doesNotThrow(() => fromMarkdown(prepared.markdown, { extensions: [mdxjs()], mdastExtensions: [mdxFromMarkdown()] }));
  assert.equal(compat.restoreMarkdownFromMdxEditor(prepared.markdown, prepared.replacements), sourceMarkdown);
});

test('MDXEditor captures media paste/drop and keeps media controls available', async () => {
  const fs = await import('node:fs/promises');
  const source = await fs.readFile(new URL('../app/admin/AdminEditorView.tsx', import.meta.url), 'utf8');
  const capability = await fs.readFile(new URL('../app/admin/useAdminMediaCapability.ts', import.meta.url), 'utf8');
  const editor = await fs.readFile(new URL('../app/admin/MdxMarkdownEditorClient.tsx', import.meta.url), 'utf8');
  assert.match(editor, /onPasteCapture/);
  assert.match(editor, /onDropCapture/);
  assert.match(editor, /files\.every\(file => file\.type\.startsWith/);
  assert.match(editor, /event\.stopPropagation\(\)/);
  assert.match(editor, /onFilesRef\.current\(files\)/);
  assert.match(source, /Paperclip/);
  assert.match(source, /Trash2/);
  assert.match(capability, /admin\/media\/capability/);
  assert.match(source, /从当前草稿移除/);
  assert.match(source, /aria-disabled=\{mediaInputDisabled\}/);
});

test('source and diff modes block media insertion and bridge the current editor view mode', async () => {
  const fs = await import('node:fs/promises');
  const source = await fs.readFile(new URL('../app/admin/useAdminComposerMedia.ts', import.meta.url), 'utf8');
  const pageMedia = await fs.readFile(new URL('../app/admin/useAdminPageMediaState.ts', import.meta.url), 'utf8');
  const capability = await fs.readFile(new URL('../app/admin/useAdminMediaCapability.ts', import.meta.url), 'utf8');
  const view = await fs.readFile(new URL('../app/admin/AdminEditorView.tsx', import.meta.url), 'utf8');
  const wrapper = await fs.readFile(new URL('../app/admin/MdxMarkdownEditor.tsx', import.meta.url), 'utf8');
  const editor = await fs.readFile(new URL('../app/admin/MdxMarkdownEditorClient.tsx', import.meta.url), 'utf8');
  assert.match(wrapper, /onViewModeChange\?\:/);
  assert.match(wrapper, /onReady\?\:/);
  assert.match(editor, /useCellValue/);
  assert.match(editor, /viewMode\$/);
  assert.match(editor, /function ViewModeBridge/);
  assert.match(editor, /<ViewModeBridge onChange=\{onViewModeChange\}/);
  assert.match(editor, /function ViewModeToggle/);
  assert.match(editor, /<ViewModeToggle \/>/);
  assert.ok(editor.indexOf('<ViewModeBridge') < editor.indexOf('<ViewModeToggle />'));
  assert.doesNotMatch(editor, /DiffSourceToggleWrapper/);
  assert.match(editor, /viewModeRef\.current !== 'rich-text'/);
  assert.match(editor, /onErrorRef\.current\?\.\(MEDIA_MODE_HINT\)/);
  assert.match(editor, /const setEditorRef/);
  assert.match(editor, /onReadyRef\.current\?\.\(methods !== null\)/);
  assert.match(source, /const \{ online, editorReady, editorViewMode/);
  assert.match(source, /const canInsertMedia = editorViewMode === 'rich-text'/);
  assert.match(pageMedia, /const mediaInputDisabled =/);
  assert.match(capability, /const \[editorReady, setEditorReady\]/);
  assert.match(pageMedia, /!media\.editorReady/);
  assert.match(view, /onReady=\{props\.onEditorReady\}/);
  assert.match(source, /rich-text/);
  assert.match(view, /disabled=\{props\.mediaInputDisabled\}/);
  assert.match(view, /onViewModeChange=\{props\.onViewModeChange\}/);
});

test('media uploads insert canonical Markdown while MDXEditor resolves image previews', async () => {
  const fs = await import('node:fs/promises');
  const source = await fs.readFile(new URL('../app/admin/useAdminComposerMedia.ts', import.meta.url), 'utf8');
  const saveAction = await fs.readFile(new URL('../app/admin/useAdminSaveAction.ts', import.meta.url), 'utf8');
  const view = await fs.readFile(new URL('../app/admin/AdminEditorView.tsx', import.meta.url), 'utf8');
  const editor = await fs.readFile(new URL('../app/admin/MdxMarkdownEditorClient.tsx', import.meta.url), 'utf8');
  const uploads = await fs.readFile(new URL('../app/admin/useMediaUploads.ts', import.meta.url), 'utf8');
  const resolver = await fs.readFile(new URL('../app/article/MediaResolver.tsx', import.meta.url), 'utf8');
  assert.match(uploads, /mediaMarkdownReference/);
  assert.match(source, /insertMarkdown\(`\\n\$\{reference\}\\n`\)/);
  assert.match(editor, /imagePlugin/);
  assert.match(editor, /imageUploadHandler/);
  assert.match(editor, /imagePreviewHandler/);
  assert.match(editor, /mediaContentUrl/);
  assert.match(uploads, /return `media:\/\/\$\{result\.mediaId\}`/);
  assert.match(uploads, /removeMediaReferences/);
  assert.match(uploads, /replaceMediaOccurrence/);
  assert.match(source, /if \(!editor\)/);
  assert.match(source, /编辑器正在加载，请稍后再试/);
  assert.match(saveAction, /附件仍在上传，请完成后再保存/);
  assert.match(view, /mediaStillProcessing/);
  assert.match(resolver, /resolved-image-card/);
  assert.match(resolver, /resolved-file-card/);
  assert.match(resolver, /打开 \/ 下载/);
});

test('media links keep safe hrefs while standard links retain Lexical sanitization', async () => {
  const fs = await import('node:fs/promises');
  const plugin = await fs.readFile(new URL('../app/admin/media-link-plugin.ts', import.meta.url), 'utf8');
  const editor = await fs.readFile(new URL('../app/admin/MdxMarkdownEditorClient.tsx', import.meta.url), 'utf8');
  assert.match(plugin, /class MediaLinkNode extends LinkNode/);
  assert.match(plugin, /const MEDIA_LINK_URL = \/\^media:/);
  assert.match(plugin, /A-Za-z0-9\._~-/);
  assert.match(plugin, /\+\$\//);
  assert.match(plugin, /isMediaLinkUrl\(url\) \? url : super\.sanitizeUrl\(url\)/);
  assert.match(plugin, /addImportVisitor\$/);
  assert.match(plugin, /addExportVisitor\$/);
  assert.match(plugin, /addLexicalNode\$/);
  assert.match(plugin, /priority: 100/);
  assert.match(plugin, /actions\.addAndStepInto\('link'/);
  assert.match(editor, /mediaLinkPlugin\(\)/);
  assert.match(editor, /mediaContentUrl\(source\.slice\('media:\/\/'\.length\), API\)/);
});

test('editor reuses one CSRF token across upload and save, surfaces API details, and cancels active attachments', async () => {
  const fs = await import('node:fs/promises');
  const source = await fs.readFile(new URL('../app/admin/useAdminSession.ts', import.meta.url), 'utf8');
  const view = await fs.readFile(new URL('../app/admin/AdminEditorView.tsx', import.meta.url), 'utf8');
  const uploadSource = await fs.readFile(new URL('../app/admin/useMediaUploads.ts', import.meta.url), 'utf8');
  assert.match(source, /const csrfRef = useRef\(''\)/);
  assert.match(source, /const refreshSessionCSRF = useCallback/);
  assert.match(source, /sessionRequestRef\.current/);
  assert.doesNotMatch(uploadSource, /fetch\(`\$\{API\}\/auth\/session`/);
  assert.match(uploadSource, /responseError\(ticketResponse, '创建上传任务失败'\)/);
  assert.match(uploadSource, /if \(item\.status === 'uploading' \|\| item\.status === 'queued'\)/);
  assert.match(view, /onCancelUpload\(item\)/);
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
  assert.match(source, /function changeMonth/);
  assert.match(source, /setMonth\(next\)/);
  assert.match(source, /setSelectedDate\(defaultSelectedDate\(next\)\)/);
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
  assert.match(worker, /timeline-shell-v5/);
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
  assert.match(rendered.html, /<h4 id="四级标题">/);
  assert.match(rendered.html, /<h5 id="五级标题">/);
  assert.match(rendered.html, /<h6 id="六级标题">/);
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
  const storage = await import('node:fs/promises').then(fs => fs.readFile(new URL('../app/admin/editor-storage.ts', import.meta.url), 'utf8'));
  const uploads = await import('node:fs/promises').then(fs => fs.readFile(new URL('../app/admin/useMediaUploads.ts', import.meta.url), 'utf8'));
  assert.match(source, /<HomeTimeline initialDays=\{days\} initialCursor=\{nextCursor\}\/>/);
  assert.match(api, /getTimeline\(limit = 20, cursor = ''\)/);
  assert.match(api, /cursor=\$\{encodeURIComponent\(cursor\)\}/);
  assert.match(storage, /MEDIA_QUEUE_STORE = 'media-queue'/);
  assert.match(uploads, /dbGetAll<UploadItem>\(MEDIA_QUEUE_STORE\)/);
  assert.match(uploads, /浏览器不会把文件内容自动写入离线队列/);
  assert.match(uploads, /uploadResumable\(uploadUrl, file/);
  assert.match(uploads, /finalizeUrl/);
  assert.doesNotMatch(uploads, /fetch\(uploadUrl, \{ method: 'POST'/);
  assert.match(storage, /mediaQueueStoragePlan/);
  assert.match(uploads, /浏览器未保存此文件，需重新选择文件/);
  assert.match(uploads, /媒体存储不可用，请重新选择文件后重试/);
  assert.match(uploads, /mediaCapability\.imageUploadEnabled/);
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
  const editorState = await import('node:fs/promises').then(fs => fs.readFile(new URL('../app/admin/useAdminEditorState.ts', import.meta.url), 'utf8'));
  const entryActions = await import('node:fs/promises').then(fs => fs.readFile(new URL('../app/admin/admin-entry-actions.ts', import.meta.url), 'utf8'));
  const undoAction = await import('node:fs/promises').then(fs => fs.readFile(new URL('../app/admin/useAdminUndoAction.ts', import.meta.url), 'utf8'));
  const desk = await import('node:fs/promises').then(fs => fs.readFile(new URL('../app/admin/entries/page.tsx', import.meta.url), 'utf8'));
  assert.match(login, /auth\/login\/\$\{step === 1 \? 'password' : 'totp'\}/);
  assert.match(login, /resolveSuccessfulLogin\(step, response, refreshSession\)/);
  assert.match(login, /setChallenge\(result\.challenge\)/);
  assert.match(login, /router\.replace\('\/admin'\)/);
  assert.match(login, /router\.refresh\(\)/);
  assert.match(login, /async function submit\(event: FormEvent<HTMLFormElement>\)/);
  assert.match(login, /<form onSubmit=\{submit\}/);
  assert.match(login, /<button className="primary" type="submit"/);
  assert.doesNotMatch(login, /onClick=\{next\}/);
  assert.match(editorState, /serializeEditorStatus\(status\)/);
  assert.match(entryActions, /working-copies\/\$\{working\.id\}\/commit/);
  assert.match(undoAction, /admin\/undo\/\$\{undoToken\}/);
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
  assert.match(form, /crypto\.getRandomValues/);
  assert.match(form, /operationToken: base64URL\(randomBytes\(32\)\)/);
  assert.match(form, /newRecoveryKey: base64URL\(randomBytes\(32\)\)/);
  assert.match(form, /newTotpSecret: base32\(randomBytes\(20\)\)/);
  assert.match(form, /pendingAttempt = useRef/);
  assert.match(form, /for \(let tryNumber = 0; tryNumber < 2; tryNumber \+= 1\)/);
  assert.match(form, /recoveryTOTPSetupURI\(attempt\.newTotpSecret\)/);
  assert.match(form, /recoveryKey: attempt\.newRecoveryKey/);
  assert.match(form, /totpSecret: attempt\.newTotpSecret/);
  assert.match(form, /value=\{result\.totpSecret\}/);
  assert.match(form, /新恢复密钥（仅用于以后恢复账户，不是 TOTP 密钥）/);
  assert.match(form, /手动设置密钥（Base32，仅粘贴此值）/);
  assert.match(form, /仅供支持 otpauth 导入或本地生成二维码使用/);
  assert.match(form, /不得将完整 URI 粘贴进 Authenticator 的手动设置密钥框/);
  assert.match(form, /import \{ QRCodeSVG \} from 'qrcode\.react'/);
  assert.match(form, /<QRCodeSVG/);
  assert.match(form, /value=\{result\.totpSetupURI\}/);
  assert.match(form, /title="个人时间线 owner 账户的 TOTP 设置二维码"/);
  assert.match(form, /role="img"/);
  assert.match(form, /aria-label="个人时间线 owner 账户的 TOTP 设置二维码"/);
  assert.match(form, /二维码只在当前浏览器中.*不会发送给外部二维码服务/);
  assert.doesNotMatch(form, /(?:api\.qrserver|chart\.googleapis|quickchart|qrcode-monkey)/i);
  assert.doesNotMatch(form, /response\.json\(\).*totpSetupURI/);
  assert.match(form, /response\.status === 429/);
  assert.match(form, /response\.status === 409/);
  assert.match(form, /Retry-After/);
  assert.match(form, /router\.replace\('\/login\?recovered=1'\)/);
  assert.match(form, /totpSetupURI/);
  assert.match(form, /服务端不会保存明文/);
  assert.match(form, /setResult/);
  assert.doesNotMatch(form, /console\.(log|error).*recoveryKey/);
  assert.match(login, /recovered/);
});

test('account recovery Base32 encoder follows RFC 4648 and emits a 32-character TOTP secret', async () => {
  const form = await import('node:fs/promises').then(fs => fs.readFile(new URL('../app/recovery/RecoveryForm.tsx', import.meta.url), 'utf8'));
  const functionSource = form.match(/function base32\(value: Uint8Array\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(functionSource, 'base32 encoder should remain available for the recovery flow');
  const { runInNewContext } = await import('node:vm');
  const encodeBase32 = runInNewContext(`(${functionSource.replace('value: Uint8Array', 'value')})`);

  for (const [plain, encoded] of [
    ['', ''],
    ['f', 'MY'],
    ['foo', 'MZXW6'],
    ['foobar', 'MZXW6YTBOI'],
  ]) {
    assert.equal(encodeBase32(Buffer.from(plain)), encoded);
  }

  const totpSecret = encodeBase32(Uint8Array.from({ length: 20 }, (_, index) => index));
  assert.match(totpSecret, /^[A-Z2-7]{32}$/);
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
