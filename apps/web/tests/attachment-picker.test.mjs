import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { after, test } from 'node:test';
import ts from 'typescript';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://blog.test/admin', pretendToBeVisual: true });
for (const key of ['window', 'document', 'navigator', 'Node', 'NodeFilter', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'Element', 'DocumentFragment', 'MutationObserver', 'CustomEvent', 'KeyboardEvent', 'Event', 'MouseEvent', 'FocusEvent']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
}
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
after(() => dom.window.close());

const read = path => fs.readFile(new URL(path, import.meta.url), 'utf8');
const dataModule = source => `data:text/javascript,${encodeURIComponent(source)}`;
const emptyComponent = dataModule('export default function UnrelatedView() { return null; }');
const modules = new Map();
async function moduleURL(url) {
  if (modules.has(url.href)) return modules.get(url.href);
  let source = ts.transpileModule(await fs.readFile(url, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
  }).outputText.replace(/import ['"][^'"]+\.css['"];?/g, '');
  for (const match of [...source.matchAll(/from (["'])([^"']+)\1/g)]) {
    const specifier = match[2];
    let resolved;
    // Keep the view, toolbar, queue and AttachmentButton real. Its unrelated
    // editor/date/taxonomy/draft children have their own independent suites.
    if ((/\/(AdminEditorView|AdminEditorResources)\.tsx$/.test(url.pathname)) && (specifier === 'next/link' || (specifier.startsWith('.') && !['./AttachmentButton', './AdminEditorResources'].includes(specifier)))) {
      resolved = emptyComponent;
    } else if (specifier.startsWith('.') || specifier.startsWith('@/')) {
      const base = specifier.startsWith('@/') ? new URL(`../${specifier.slice(2)}`, import.meta.url) : new URL(specifier, url);
      let file;
      for (const extension of ['.ts', '.tsx']) {
        const candidate = new URL(`${base.href}${extension}`);
        try { await fs.access(candidate); file = candidate; break; } catch {}
      }
      assert.ok(file, `Unresolved local import ${specifier}`);
      resolved = await moduleURL(file);
    } else {
      resolved = import.meta.resolve(specifier);
    }
    source = source.replace(match[0], `from ${JSON.stringify(resolved)}`);
  }
  const result = dataModule(source);
  modules.set(url.href, result);
  return result;
}

const [{ default: AttachmentButton }, { isMobileAttachmentDevice }, { default: AdminEditorView }, React, { createRoot }, { renderToString }, { Dialog }] = await Promise.all([
  import(await moduleURL(new URL('../app/admin/AttachmentButton.tsx', import.meta.url))),
  import(await moduleURL(new URL('../app/admin/attachment-device.ts', import.meta.url))),
  import(await moduleURL(new URL('../app/admin/AdminEditorView.tsx', import.meta.url))),
  import('react'), import('react-dom/client'), import('react-dom/server'), import('radix-ui'),
]);
const { act, createElement: h, useState } = React;
const tick = () => new Promise(resolve => setTimeout(resolve, 20));
const android = { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36', platform: 'Linux armv8l', maxTouchPoints: 5 };
const desktop = { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36', platform: 'Win32', maxTouchPoints: 0 };

async function fixture(t, { device = android, width = 1200, dialog = false, view = false, props: overrides = {} } = {}) {
  for (const [key, value] of Object.entries(device)) Object.defineProperty(navigator, key, { configurable: true, value });
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const uploads = [], picks = [], retries = [], cancellations = [], removals = [];
  let props = {
    disabled: false, imageUploadDisabled: false, disabledMessage: '暂不可用', imageUploadUnavailableMessage: '图片上传暂不可用',
    onFiles: files => uploads.push(files),
    ...(view ? { online: true, editingEntryID: '', title: '', summary: '', slug: '', kind: 'note', status: 'draft', categories: [], tags: [], categorySuggestions: [], tagSuggestions: [], date: '2026-09-29', markdown: '正文', message: '', saving: false, loadingEdit: false, undoToken: '', mediaInputDisabled: false, mediaAvailabilityMessage: '本地媒体存储已就绪', imageUploadAvailabilityMessage: '本地图片存储已就绪', mediaStillProcessing: false, workingCopyMeta: {}, discardingUnpublishedChanges: false, drafts: [], uploads: [], editorRef: { current: null }, onCancelUpload: item => cancellations.push(item), onRetryUpload: async (item, file) => { retries.push([item, file]); }, onRemoveUpload: item => removals.push(item) } : {}),
    ...overrides,
  };
  function App() {
    const [portal, setPortal] = useState(null);
    const child = h(view ? AdminEditorView : AttachmentButton, { ...props, editorPortalElement: portal, ...(dialog && view ? { presentation: 'dialog' } : {}) });
    return dialog ? h(Dialog.Root, { open: true }, h(Dialog.Content, { ref: setPortal }, h(Dialog.Title, null, '快速写作'), h(Dialog.Description, null, '测试共用附件入口'), child)) : child;
  }
  const render = async () => {
    await act(async () => root.render(h(App)));
    await act(tick);
    for (const input of host.querySelectorAll('input[type=file]')) input.click = () => picks.push(input);
  };
  await render();
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  const trigger = () => host.querySelector('button[aria-label="添加媒体"]');
  const camera = () => host.querySelector('input[capture]');
  const files = () => host.querySelector('input[multiple]');
  const menu = () => document.querySelector('[role=menu]');
  const press = async (target, key) => { await act(async () => target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))); await act(tick); };
  const open = async () => { trigger().focus(); await press(trigger(), 'ArrowDown'); assert.ok(menu()); };
  const select = async (input, selected) => {
    Object.defineProperty(input, 'files', { configurable: true, value: selected });
    Object.defineProperty(input, 'value', { configurable: true, writable: true, value: selected?.length ? 'selected-file' : '' });
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
    assert.equal(input.value, '');
  };
  const update = async next => { props = { ...props, ...next }; await render(); };
  return { host, trigger, camera, files, menu, open, press, select, update, uploads, picks, retries, cancellations, removals };
}

test('attachment UA detection supports Android, iPhone, iPad and desktop-UA iPadOS without width heuristics', () => {
  const cases = [
    [undefined, false], [{}, false], [android, true], [desktop, false],
    [{ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', platform: 'iPhone', maxTouchPoints: 5 }, true],
    [{ userAgent: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)', platform: 'iPad', maxTouchPoints: 5 }, true],
    [{ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)', platform: 'MacIntel', maxTouchPoints: 5 }, true],
    [{ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)', platform: 'MacIntel', maxTouchPoints: 0 }, false],
    [{ userAgent: 'Macintosh', platform: 'MacIntel', maxTouchPoints: 1 }, false],
    [{ ...desktop, maxTouchPoints: 10 }, false],
    [{ userAgent: 'Mozilla/5.0 (X11; Linux x86_64)', platform: 'Linux x86_64', maxTouchPoints: 10 }, false],
    [{ userAgent: 'android' }, true],
  ];
  for (const [device, expected] of cases) assert.equal(isMobileAttachmentDevice(device), expected, JSON.stringify(device));
});

test('narrow desktop opens only the general file picker, with camera capture isolated', async t => {
  const f = await fixture(t, { device: desktop, width: 360 });
  assert.equal(f.host.querySelectorAll('input[type=file]').length, 2);
  assert.equal(f.camera().accept, 'image/*');
  assert.equal(f.camera().getAttribute('capture'), 'environment');
  assert.equal(f.camera().multiple, false);
  assert.equal(f.files().multiple, true);
  assert.equal(f.files().hasAttribute('capture'), false);
  assert.equal(f.files().hasAttribute('accept'), false);
  assert.equal(f.camera().hidden, true);
  assert.equal(f.files().hidden, true);
  assert.equal(f.trigger().hasAttribute('aria-haspopup'), false);
  await act(async () => f.trigger().click());
  assert.deepEqual(f.picks, [f.files()]);
  assert.equal(f.menu(), null);
});

test('wide mobile opens an accessible menu and camera/files select different hidden inputs', async t => {
  const f = await fixture(t);
  assert.equal(f.trigger().getAttribute('aria-haspopup'), 'menu');
  await f.open();
  assert.equal(f.trigger().getAttribute('aria-expanded'), 'true');
  assert.deepEqual(f.picks, []);
  let items = f.menu().querySelectorAll('[role=menuitem]');
  assert.deepEqual([...items].map(item => item.textContent), ['拍摄照片', '选择文件']);
  await f.press(items[0], 'Enter');
  assert.deepEqual(f.picks, [f.camera()]);
  assert.equal(f.menu(), null);
  await f.open();
  items = f.menu().querySelectorAll('[role=menuitem]');
  await f.press(items[0], 'ArrowDown');
  assert.equal(document.activeElement, items[1]);
  await f.press(items[1], 'Enter');
  assert.deepEqual(f.picks, [f.camera(), f.files()]);
  const photo = new dom.window.File(['image'], 'photo.jpg', { type: 'image/jpeg' });
  const pdf = new dom.window.File(['pdf'], 'report.pdf', { type: 'application/pdf' });
  await f.select(f.camera(), [photo]);
  await f.select(f.files(), [photo, pdf]);
  assert.deepEqual(f.uploads, [[photo], [photo, pdf]]);
});

test('both inputs reset for the same file; empty changes and native cancel do not upload', async t => {
  const f = await fixture(t);
  const file = new dom.window.File(['image'], 'same.jpg', { type: 'image/jpeg' });
  for (const input of [f.camera(), f.files()]) {
    await f.select(input, [file]);
    await f.select(input, [file]);
    await f.select(input, []);
    await f.select(input, null);
    await act(async () => input.dispatchEvent(new Event('cancel', { bubbles: true })));
  }
  assert.deepEqual(f.uploads, [[file], [file], [file], [file]]);
});

test('capability disable blocks late chooser results and closes an already open menu', async t => {
  const f = await fixture(t);
  await f.open();
  await f.update({ disabled: true });
  assert.equal(f.menu(), null);
  assert.equal(f.trigger().disabled, true);
  assert.equal(f.camera().disabled, true);
  assert.equal(f.files().disabled, true);
  const file = new dom.window.File(['x'], 'blocked.pdf', { type: 'application/pdf' });
  await f.select(f.camera(), [file]);
  await f.select(f.files(), [file]);
  await act(async () => f.trigger().click());
  assert.deepEqual(f.uploads, []);
  assert.deepEqual(f.picks, []);
});

test('image permission disables only camera while file selection keeps original upload validation', async t => {
  const f = await fixture(t, { props: { imageUploadDisabled: true } });
  await f.open();
  const items = f.menu().querySelectorAll('[role=menuitem]');
  assert.equal(items[0].getAttribute('aria-disabled'), 'true');
  assert.equal(items[1].hasAttribute('data-disabled'), false);
  assert.equal(f.camera().disabled, true);
  assert.equal(f.files().disabled, false);
  await f.press(items[0], 'Enter');
  assert.deepEqual(f.picks, []);
  await f.press(items[1], 'Enter');
  assert.deepEqual(f.picks, [f.files()]);
  const file = new dom.window.File(['x'], 'report.pdf', { type: 'application/pdf' });
  await f.select(f.camera(), [file]);
  await f.select(f.files(), [file]);
  assert.deepEqual(f.uploads, [[file]]);
});

test('menu remains inside quick-write Dialog and Escape restores trigger focus without closing the dialog', async t => {
  const f = await fixture(t, { dialog: true });
  await f.open();
  const dialog = f.host.querySelector('[role=dialog]');
  assert.ok(dialog.contains(f.menu()));
  await f.press(f.menu().querySelector('[role=menuitem]'), 'Escape');
  assert.equal(f.menu(), null);
  assert.equal(f.trigger().getAttribute('aria-expanded'), 'false');
  assert.equal(document.activeElement, f.trigger());
  assert.ok(f.host.querySelector('[role=dialog]'));
  assert.deepEqual(f.picks, []);
});

test('server rendering uses the stable desktop snapshot without reading mobile-only markup', () => {
  const html = renderToString(h(AttachmentButton, { disabled: false, imageUploadDisabled: false, disabledMessage: '', imageUploadUnavailableMessage: '', onFiles() {} }));
  assert.match(html, /capture="environment"/);
  assert.doesNotMatch(html, /aria-haspopup|role="menu"/);
});

test('an interrupted menu stays closed when uploads become available again', async t => {
  const f = await fixture(t);
  await f.open();
  await f.update({ disabled: true });
  await f.update({ disabled: false });
  assert.equal(f.menu(), null);
  await f.open();
});

for (const state of ['mediaInputDisabled', 'saving', 'loadingEdit']) {
  for (const dialog of [false, true]) {
    test(`${state} blocks attachment and retry uploads in ${dialog ? 'quick-write Dialog' : 'admin page'}`, async t => {
      const failed = { id: 'failed-upload', fileName: 'failed.pdf', status: 'failed' };
      const f = await fixture(t, { view: true, dialog, props: { uploads: [failed] } });
      await f.open();
      await f.update({ [state]: true });
      assert.equal(f.menu(), null);
      assert.equal(f.trigger().disabled, true);
      const file = new dom.window.File(['x'], 'report.pdf', { type: 'application/pdf' });
      const inputs = [...f.host.querySelectorAll('input[type=file]')];
      assert.equal(inputs.length, 3);
      for (const input of inputs) {
        assert.equal(input.disabled, true);
        await f.select(input, [file]);
      }
      assert.deepEqual(f.uploads, []);
      assert.deepEqual(f.retries, []);
      assert.ok(f.host.querySelector('.upload-list'));
      assert.equal(f.host.querySelector('.upload-panel'), null);
    });
  }
}

test('queue still cancels active uploads and retries/removes failed attachments', async t => {
  const active = { id: 'active-upload', fileName: 'active.pdf', status: 'uploading', progress: .5 };
  const failed = { id: 'failed-upload', fileName: 'failed.pdf', status: 'failed', needsReselect: true };
  const f = await fixture(t, { view: true, props: { uploads: [active, failed] } });
  const rows = f.host.querySelectorAll('.upload-list li');
  assert.equal(rows.length, 2);
  const cancel = [...rows[0].querySelectorAll('button')].find(button => button.textContent.includes('取消'));
  await act(async () => cancel.click());
  assert.deepEqual(f.cancellations, [active]);
  const retry = rows[1].querySelector('input[type=file]');
  const file = new dom.window.File(['x'], 'retry.pdf', { type: 'application/pdf' });
  await f.select(retry, [file]);
  await f.select(retry, [file]);
  await f.select(retry, []);
  assert.deepEqual(f.retries, [[failed, file], [failed, file]]);
  await act(async () => rows[1].querySelector('button.remove-media').click());
  assert.deepEqual(f.removals, [failed]);
});

test('old upload panel and its exclusive state/callbacks are removed while shared wiring remains', async () => {
  await assert.rejects(fs.access(new URL('../app/admin/UploadPanel.tsx', import.meta.url)), { code: 'ENOENT' });
  const paths = ['AdminEditorView.tsx', 'useAdminComposerInteractions.ts', 'useAdminPageMediaState.ts', 'admin-editor-view-model.ts', 'useAdminComposerMedia.ts'];
  const sources = await Promise.all(paths.map(path => read(`../app/admin/${path}`)));
  for (const source of sources) assert.doesNotMatch(source, /UploadPanel|uploadPanelOpen|setUploadPanelOpen|dragActive|setDragActive|onToggleUploadPanel|onDragEnter|onDragOver|onDragLeave|onDrop/);
  const [, interactions, , model] = sources;
  const resources = await read('../app/admin/AdminEditorResources.tsx');
  assert.match(resources, /<AttachmentButton[^>]*onFiles=\{props\.onFiles\}/);
  assert.match(resources, /<AttachmentPreview markdown=\{props\.markdown\} uploads=\{props\.uploads\}/);
  assert.match(model, /onFiles: mediaState\.interactions\.onFiles/);
  assert.match(interactions, /!mediaInputDisabled && files\.length/);
  assert.match(await read('../app/admin/page.tsx'), /<AdminEditorView/);
  assert.match(await read('../app/admin/QuickWriteDialog.tsx'), /<AdminEditorView/);
  const picker = await read('../app/admin/AttachmentButton.tsx');
  assert.match(picker, /useSyncExternalStore/);
  assert.doesNotMatch(picker, /innerWidth|matchMedia|fetch\(|useMediaUploads/);
  assert.match(await read('../app/admin/attachment-button.css'), /min-height:\s*44px/);
});

const { useEditorFileDrop } = await import(await moduleURL(new URL('../app/admin/useEditorFileDrop.ts', import.meta.url)));
const { captureEditorFiles } = await import(await moduleURL(new URL('../app/admin/editor-file-input.ts', import.meta.url)));

test('editor drag hover highlights without upload, drops once, and clears on leave/cancel/disable', async t => {
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host), uploads = [];
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  let enabled = true;
  function DropTarget() {
    const { dragActive, resetDrag, ...handlers } = useEditorFileDrop(enabled);
    return h('div', { ...handlers, 'data-active': String(dragActive), onDropCapture(event) { resetDrag(); captureEditorFiles(event, files => uploads.push(files), assert.fail, !enabled); } }, h('p', null, '正文'));
  }
  const render = () => act(async () => root.render(h(DropTarget)));
  await render();
  const area = host.firstChild, child = area.firstChild;
  const active = () => area.dataset.active;
  async function fire(type, target = area, files = [], types = ['Files']) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: { files, types, items: [], dropEffect: 'none' } });
    await act(async () => target.dispatchEvent(event));
    return event;
  }
  await fire('dragenter'); await fire('dragenter', child);
  assert.equal(active(), 'true');
  const over = await fire('dragover', child);
  assert.equal(over.dataTransfer.dropEffect, 'copy'); assert.deepEqual(uploads, []);
  await fire('dragleave', child); assert.equal(active(), 'true');
  await fire('dragleave'); assert.equal(active(), 'false');
  await fire('dragenter');
  const file = new dom.window.File(['x'], 'photo.jpg', { type: 'image/jpeg' });
  const dropped = await fire('drop', child, [file]);
  assert.equal(dropped.defaultPrevented, true); assert.equal(active(), 'false');
  assert.deepEqual(uploads, [[file]]);
  for (const event of [new KeyboardEvent('keydown', { key: 'Escape' }), new Event('dragend'), new Event('blur'), new Event('drop')]) {
    await fire('dragenter'); await act(async () => window.dispatchEvent(event)); assert.equal(active(), 'false');
  }
  await fire('dragenter', area, [], ['text/plain']); assert.equal(active(), 'false');
  enabled = false; await render();
  await fire('dragenter'); const blocked = await fire('dragover');
  assert.equal(blocked.dataTransfer.dropEffect, 'none'); assert.equal(active(), 'false');
  await fire('drop', child, [file]); assert.equal(uploads.length, 1);
});
