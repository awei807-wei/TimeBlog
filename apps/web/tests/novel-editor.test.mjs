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
  const extensions = await read('../app/admin/novel-editor-extensions.ts');
  const view = await read('../app/admin/AdminEditorView.tsx');
  assert.match(editor, /renderItems|EditorCommand/);
  assert.match(editor, /appendTo/);
  assert.match(editor, /onPasteCapture/);
  assert.match(editor, /onDropCapture/);
  assert.match(editor, /immediatelyRender=\{false\}/);
  assert.match(extensions, /renderItems\(\(editorPortalRef \|\| null\)/);
  assert.match(view, /presentation\?: 'page' \| 'dialog'/);
  assert.match(view, /editorPortalRef\?: RefObject<Element \| null>/);
  assert.match(view, /if \(props\.presentation === 'dialog'\) return <div/);
  const dialogBranch = view.slice(view.indexOf("if (props.presentation === 'dialog')")).split('\n')[0];
  assert.doesNotMatch(dialogBranch, /<main id="main-content"/);
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
