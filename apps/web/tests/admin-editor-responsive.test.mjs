import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

async function read(path) {
  return fs.readFile(new URL(path, import.meta.url), 'utf8');
}

test('admin writing view keeps the primary workbench reachable on narrow screens', async () => {
  const view = await read('../app/admin/AdminEditorView.tsx');
  const appShell = await read('../app/AppShell.tsx');
  const mobileHook = await read('../app/hooks/use-mobile.ts');
  const layout = await read('../app/admin-editor-layout.css');
  const editor = await read('../app/admin-editor-editor.css');
  const inspector = await read('../app/admin-editor-inspector.css');
  const responsive = await read('../app/admin-editor-responsive.css');
  const chrome = await read('../app/mdx-editor-chrome.css');
  const css = [layout, editor, inspector, responsive, chrome].join('\n');

  assert.match(view, /className="writing-layout"/);
  assert.match(view, /className="writing-main"/);
  assert.match(view, /className="writing-rail"/);
  assert.match(css, /\.writing-shell\s*\{[\s\S]*min-width:\s*0;[\s\S]*safe-area-inset-bottom/);
  assert.match(responsive, /@media \(max-width: 767px\)[\s\S]*\.writing-rail\s*\{[\s\S]*grid-template-columns:\s*1fr/);
  assert.match(responsive, /62dvh/);
  assert.match(responsive, /50dvh/);
  assert.match(css, /\.mdxeditor-toolbar[\s\S]*overflow-x:\s*auto/);
  assert.match(css, /\.writing-composer \.mdx-editor \.mdxeditor-toolbar[\s\S]*min-width:\s*44px[\s\S]*min-height:\s*44px/);
  assert.match(inspector, /\.writing-selector-row select[\s\S]*min-height:\s*44px/);
  assert.match(responsive, /\.writing-inspector \.taxonomy-tag-remove[\s\S]*width:\s*44px[\s\S]*height:\s*44px/);
  assert.match(layout, /max\(72px, calc\(72px \+ env\(safe-area-inset-bottom\)\)\)/);

  assert.match(appShell, /SidebarTrigger/);
  assert.match(appShell, /collapsible="offcanvas"/);
  assert.match(appShell, /setOpenMobile\(false\)/);
  assert.match(mobileHook, /MOBILE_BREAKPOINT = 768/);
  assert.match(await read('../app/globals.css'), /@media \(max-width: 767px\)/);
});

test('admin mobile shell delegates drawer behavior to the existing Sheet state', async () => {
  const appShell = await read('../app/AppShell.tsx');
  const css = await read('../app/globals.css');

  assert.match(appShell, /<SidebarTrigger[^>]+aria-label="打开管理导航"/);
  assert.match(appShell, /className="mobile-shell-header"/);
  assert.match(css, /\[data-sidebar="sidebar"\]\[data-mobile="true"\]\[data-state="open"\][\s\S]*translateX\(0\)/);
  assert.match(css, /\[data-sidebar="sidebar"\]\[data-mobile="true"\]\[data-state="closed"\][\s\S]*translateX\(-100%\)/);
  assert.match(css, /safe-area-inset-top/);
  assert.match(css, /@media \(min-width: 768px\)[\s\S]*\.app-main \{ padding-left: 32px; \}/);
});
