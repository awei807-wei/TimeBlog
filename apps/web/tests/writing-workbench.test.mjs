import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const read = path => fs.readFile(new URL(path, import.meta.url), 'utf8');

test('writing workbench separates top tools, resources, document and properties', async () => {
  const view = await read('../app/admin/AdminEditorView.tsx');
  const resources = await read('../app/admin/AdminEditorResources.tsx');
  const layout = await read('../app/admin-editor-layout.css');
  assert.match(view, /className="writing-workbench-tools"/);
  assert.match(view, /toolbarElement=\{toolbarElement\}/);
  assert.match(view, /modeElement=\{modeElement\}/);
  assert.match(view, /<AdminEditorResources/);
  assert.match(resources, /aria-label="写作资源"/);
  assert.match(resources, /<AttachmentPreview/);
  assert.match(resources, /<DraftTray/);
  assert.match(resources, /saving \|\| props.loadingEdit \|\| props.mediaStillProcessing/);
  assert.match(layout, /grid-template-areas:\s*"resources document properties"/);
});

test('toolbar portals stay inside the existing editor context', async () => {
  const editor = await read('../app/admin/NovelMarkdownEditor.tsx');
  const client = await read('../app/admin/NovelMarkdownEditorClient.tsx');
  assert.match(editor, /createPortal\(modeSwitch, props.modeElement\)/);
  assert.match(client, /createPortal\(toolbar, toolbarElement\)/);
  assert.match(client, /slotBefore=\{toolbarElement \? createPortal/);
  assert.match(editor, /mode === 'rich'/);
});

test('local HTML preview is development-only and does not mount business hooks', async () => {
  const page = await read('../app/preview/writing.html/page.tsx');
  const preview = await read('../app/preview/writing.html/WritingPreview.tsx');
  const proxy = await read('../proxy.ts');
  assert.match(page, /process.env.NODE_ENV !== 'development'\) notFound\(\)/);
  assert.match(preview, /<AdminEditorView/);
  assert.doesNotMatch(preview, /fetch\(|useAdminPageController|useDraftAutosave|useSession|dbPut/);
  assert.match(preview, /刷新后重置/);
  assert.match(proxy, /process.env.NODE_ENV !== 'development'/);
  assert.match(proxy, /status: 404/);
  assert.match(proxy, /matcher: '\/preview\/writing.html'/);
});

test('preview keeps the real administration navigation without simulating a session', async () => {
  const shell = await read('../app/AppShell.tsx');
  const preview = await read('../app/preview/writing.html/WritingPreview.tsx');
  for (const [href, label] of [
    ['/', '时间线'], ['/calendar', '日历'], ['/categories', '栏目'], ['/search', '搜索'],
    ['/admin', '写作'], ['/admin/entries', '内容管理'], ['/admin/settings', '设置'],
  ]) {
    assert.ok(shell.includes(`href: '${href}', label: '${label}'`));
  }
  assert.match(shell, /return <AdminWorkspaceShell preview>\{children\}<\/AdminWorkspaceShell>/);
  assert.match(shell, /<AdminWorkspaceShell session=\{session\}>/);
  assert.match(shell, /preview \|\| authenticated/);
  assert.match(shell, /prefetch=\{preview \? false : undefined\}/);
  assert.match(shell, /本地预览，未连接账户/);
  assert.doesNotMatch(shell, /pathname === '\/preview\/writing.html'\) return <>/);
  assert.doesNotMatch(preview, /className="app-main/);
});

test('Next.js debugging eval is allowed only in development, never production', async () => {
  const { default: config } = await import('../next.config.mjs');
  const original = process.env.NODE_ENV;
  try {
    for (const mode of ['development', 'production']) {
      process.env.NODE_ENV = mode;
      const [{ headers }] = await config.headers();
      const policy = headers.find(header => header.key === 'Content-Security-Policy').value;
      assert.equal(policy.includes("'unsafe-eval'"), mode === 'development');
      assert.match(policy, /connect-src 'self'/);
    }
  } finally {
    if (original === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = original;
  }
});
