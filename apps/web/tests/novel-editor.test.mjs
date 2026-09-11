import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

async function read(path) {
  return fs.readFile(new URL(path, import.meta.url), 'utf8');
}

async function loadCompat() {
  const source = await read('../app/admin/markdown-compat.ts');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } }).outputText;
  return import(`data:text/javascript,${encodeURIComponent(compiled)}`);
}

async function loadURLValidation() {
  const source = await read('../app/admin/novel-url.ts');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } }).outputText;
  return import(`data:text/javascript,${encodeURIComponent(compiled)}`);
}

test('shared GFM fixture keeps unsupported project syntax lossless', async () => {
  const compat = await loadCompat();
  const fixture = await fs.readFile(new URL('../../../tests/fixtures/markdown/gfm.md', import.meta.url), 'utf8');
  const prepared = compat.prepareMarkdownForNovel(fixture);
  assert.ok(prepared.markdown.includes('mermaid'));
  assert.ok(prepared.replacements.length >= 2, 'raw HTML and the footnote must be protected');
  assert.equal(compat.restoreMarkdownFromNovel(prepared.markdown, prepared.replacements), fixture.replaceAll('\r\n', '\n'));
});

test('unmodified editor content returns the loaded Markdown verbatim', async () => {
  const compat = await loadCompat();
  const markdown = '# 标题\n\n- [x] 已完成\n\n```mermaid\nflowchart LR\n```\n';
  const prepared = compat.prepareMarkdownForNovel(markdown);
  assert.equal(compat.restoreMarkdownFromNovel(prepared.markdown, prepared.replacements), markdown);
  assert.match(await read('../app/admin/NovelMarkdownEditorClient.tsx'), /if \(!dirtyRef\.current\) return sourceRef\.current/);
});

test('Novel editor keeps menus inside a supplied dialog portal and captures media files', async () => {
  const editor = await read('../app/admin/NovelMarkdownEditorClient.tsx');
  const menus = await read('../app/admin/NovelEditorMenus.tsx');
  const imageDialog = await read('../app/admin/NovelImageDialog.tsx');
  const extensions = await read('../app/admin/novel-editor-extensions.ts');
  const view = await read('../app/admin/AdminEditorView.tsx');
  assert.match(menus, /EditorCommand/);
  assert.match(menus, /appendTo/);
  assert.match(editor, /onPasteCapture/);
  assert.match(editor, /onDropCapture/);
  assert.match(editor, /immediatelyRender=\{false\}/);
  assert.match(imageDialog, /Dialog\.Portal container=\{/);
  assert.match(imageDialog, /editorPortalElement/);
  assert.match(extensions, /renderItems\(editorPortalElement \? \{ current: editorPortalElement \} : null\)/);
  assert.match(view, /presentation\?: 'page' \| 'dialog'/);
  assert.match(view, /editorPortalElement\?: Element \| null/);
  assert.match(view, /if \(props\.presentation === 'dialog'\) return <div/);
  const dialogBranch = view.slice(view.indexOf("if (props.presentation === 'dialog')")).split('\n')[0];
  assert.doesNotMatch(dialogBranch, /<main id="main-content"/);
});

test('visible toolbar and image dialog expose touch-safe local and external insertion paths', async () => {
  const editor = await read('../app/admin/NovelMarkdownEditorClient.tsx');
  const toolbar = await read('../app/admin/NovelEditorToolbar.tsx');
  const menus = await read('../app/admin/NovelEditorMenus.tsx');
  const imageDialog = await read('../app/admin/NovelImageDialog.tsx');
  const linkDialog = await read('../app/admin/NovelLinkDialog.tsx');
  const toolsCSS = await read('../app/admin-editor-tools.css');
  const dialogsCSS = await read('../app/admin-editor-dialogs.css');

  assert.match(editor, /slotBefore=\{<NovelEditorToolbar/);
  assert.match(editor, /<NovelImageDialog/);
  assert.match(toolbar, /role="toolbar"/);
  assert.match(toolbar, /onPointerDown=\{event => event\.preventDefault\(\)\}/);
  assert.match(toolbar, /aria-pressed/);
  assert.match(toolbar, /aria-expanded/);
  assert.match(menus, /上传图片或粘贴图床链接/);
  assert.match(imageDialog, /onChooseFile/);
  assert.match(imageDialog, /setImage\(\{ src: result\.value, alt: alt\.trim\(\) \}\)/);
  assert.doesNotMatch(imageDialog, /chain\(\)\.focus\(\)\.setImage/);
  assert.match(linkDialog, /validateEditorLinkURL/);
  assert.match(toolsCSS, /\.novel-toolbar[\s\S]*position:\s*sticky/);
  assert.match(toolsCSS, /\.novel-toolbar-button[\s\S]*min-width:\s*44px[\s\S]*min-height:\s*44px/);
  assert.match(toolsCSS, /overflow-x:\s*auto/);
  assert.match(dialogsCSS, /@media \(max-width: 520px\)[\s\S]*bottom:\s*0/);
  assert.match(dialogsCSS, /safe-area-inset-bottom/);
  assert.match(dialogsCSS, /\.novel-insert-dialog-header > div \{[\s\S]*min-width:\s*0/);
  assert.match(dialogsCSS, /\.novel-image-upload-option > div \{[\s\S]*min-width:\s*0/);
  assert.match(dialogsCSS, /\.novel-insert-dialog-actions button\.primary \{[\s\S]*margin:\s*0/);
});

test('external image and editor link validation rejects active or credential-bearing URLs', async () => {
  const validation = await loadURLValidation();
  const image = validation.validateExternalImageURL('  https://image.cainiao.me/library/photo.webp?width=1280  ');
  assert.equal(image.ok, true);
  assert.equal(image.value, 'https://image.cainiao.me/library/photo.webp?width=1280');

  for (const value of ['', '/local/image.png', 'http://image.example.com/photo.png', 'data:image/png;base64,abc', 'javascript:alert(1)', 'https://user:secret@example.com/image.png']) {
    assert.equal(validation.validateExternalImageURL(value).ok, false, value);
  }
  assert.deepEqual(validation.validateEditorLinkURL('/article/hello'), { ok: true, value: '/article/hello' });
  assert.equal(validation.validateEditorLinkURL('javascript:alert(1)').ok, false);
});

test('media image rendering preserves empty alt text while allowlisting attributes', async () => {
  const extensions = await read('../app/admin/novel-editor-extensions.ts');

  assert.match(extensions, /HTMLAttributes\.alt !== null && HTMLAttributes\.alt !== undefined/);
  assert.match(extensions, /const attributes: Record<string, string>/);
  assert.doesNotMatch(extensions, /\.\.\.HTMLAttributes/);
});

test('Novel exposes an accessible multiline textbox and routes slash images through the shared upload pipeline', async () => {
  const editor = await read('../app/admin/NovelMarkdownEditorClient.tsx');
  const uploads = await read('../app/admin/useMediaUploads.ts');

  assert.match(editor, /role: 'textbox'/);
  assert.match(editor, /'aria-label': 'Markdown 正文编辑器'/);
  assert.match(editor, /'aria-multiline': 'true'/);
  assert.match(editor, /await upload\(file\)/);
  assert.doesNotMatch(editor, /setImage\(/);
  assert.match(uploads, /insertMediaReference\(reference\)/);
  assert.match(uploads, /replaceMediaOccurrence\(markdownRef\.current, token, result\.reference\)/);
});
