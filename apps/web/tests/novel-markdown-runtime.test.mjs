import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
import { JSDOM } from 'jsdom';

async function loadCompat() {
  const source = await fs.readFile(new URL('../app/admin/markdown-compat.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  return import(`data:text/javascript,${encodeURIComponent(compiled)}`);
}

function installDOM() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://blog.test/admin' });
  for (const key of ['window', 'document', 'navigator', 'Node', 'HTMLElement', 'Element', 'MutationObserver', 'DOMParser']) {
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  }
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  globalThis.requestAnimationFrame = callback => setTimeout(callback, 0);
  globalThis.cancelAnimationFrame = handle => clearTimeout(handle);
  return dom;
}

async function createEditor(content) {
  const [{ Editor }, { default: StarterKit }, { default: Image }, { default: Link }, { default: TaskItem }, { default: TaskList }, { default: Table }, { default: TableCell }, { default: TableHeader }, { default: TableRow }, { Markdown }] = await Promise.all([
    import('@tiptap/core'),
    import('@tiptap/starter-kit'),
    import('@tiptap/extension-image'),
    import('@tiptap/extension-link'),
    import('@tiptap/extension-task-item'),
    import('@tiptap/extension-task-list'),
    import('@tiptap/extension-table'),
    import('@tiptap/extension-table-cell'),
    import('@tiptap/extension-table-header'),
    import('@tiptap/extension-table-row'),
    import('tiptap-markdown'),
  ]);
  const mediaReference = /^media:\/\/[A-Za-z0-9._~-]+$/;
  const MarkdownImage = Image.extend({
    addStorage() {
      return {
        markdown: {
          serialize(state, node) {
            const alt = state.esc(String(node.attrs.alt || ''));
            const source = String(node.attrs.src || '').replace(/[()]/g, '\\$&');
            state.write(`![${alt}](${source})`);
            if (node.isBlock) state.closeBlock(node);
          },
          parse: {},
        },
      };
    },
  });
  const SafeLink = Link.extend({
    addAttributes() {
      return {
        ...this.parent?.(),
        title: {
          default: null,
          parseHTML: element => element.getAttribute('title'),
          renderHTML: attributes => attributes.title ? { title: String(attributes.title) } : {},
        },
      };
    },
    renderHTML({ HTMLAttributes }) {
      const href = String(HTMLAttributes.href || '');
      const allowed = href.startsWith('media:') ? mediaReference.test(href) : /^(?:https?:|\/|#)/.test(href);
      return ['a', {
        href: allowed ? href : '',
        target: '_blank',
        rel: 'noopener noreferrer nofollow',
        ...(HTMLAttributes.title ? { title: String(HTMLAttributes.title) } : {}),
      }, 0];
    },
  });
  return new Editor({
    content,
    extensions: [
      StarterKit.configure({ link: false }),
      TaskList,
      TaskItem.configure({ nested: true }),
      MarkdownImage.configure({ allowBase64: false }),
      SafeLink.configure({
        openOnClick: false,
        autolink: false,
        linkOnPaste: false,
        protocols: ['media'],
        isAllowedUri: (url, context) => url.startsWith('media:')
          ? mediaReference.test(url.trim())
          : context.defaultValidate(url),
      }),
      Table.configure({ resizable: false }),
      TableRow,
      TableHeader,
      TableCell,
      Markdown.configure({ html: false, tightLists: true, bulletListMarker: '-', linkify: false, breaks: false, transformPastedText: false, transformCopiedText: false }),
    ],
  });
}

function findLinkHref(value) {
  if (!value || typeof value !== 'object') return '';
  for (const mark of value.marks || []) {
    if (mark.type === 'link') return String(mark.attrs?.href || '');
  }
  for (const child of value.content || []) {
    const href = findLinkHref(child);
    if (href) return href;
  }
  return '';
}

test('the installed Novel/Tiptap stack round-trips supported GFM and protected legacy syntax', async () => {
  const dom = installDOM();
  const compat = await loadCompat();
  const fixture = await fs.readFile(new URL('../../../tests/fixtures/markdown/gfm.md', import.meta.url), 'utf8');
  const prepared = compat.prepareMarkdownForNovel(fixture);
  const editor = await createEditor(prepared.markdown);

  editor.commands.insertContentAt(editor.state.doc.content.size, '\n\n\u8ffd\u52a0\u5185\u5bb9');

  const serialized = editor.storage.markdown.getMarkdown();
  const restored = compat.restoreMarkdownFromNovel(serialized, prepared.replacements);
  assert.match(restored, /\| \u540d\u79f0 \| \u72b6\u6001 \|/);
  assert.match(restored, /- \[x\] \u5df2\u5b8c\u6210/);
  assert.match(restored, /```mermaid\nflowchart LR/);
  assert.match(restored, /!\[\u672c\u5730\u5a92\u4f53\]\(media:\/\/00000000-0000-0000-0000-000000000001\)/);
  assert.match(restored, /\[\^note\]: \u8fd9\u662f\u811a\u6ce8\u5185\u5bb9\u3002/);
  assert.match(restored, /<iframe src="https:\/\/evil\.example\/embed"><\/iframe>/);
  assert.match(restored, /<script>alert\('blocked'\)<\/script>/);
  assert.match(restored, /\n\n!\[\u672c\u5730\u5a92\u4f53\]\(media:\/\/00000000-0000-0000-0000-000000000001\)\n\n<iframe/);
  assert.match(restored, /<iframe src="https:\/\/evil\.example\/embed"><\/iframe>\n<script>alert\('blocked'\)<\/script>/);

  editor.destroy();
  dom.window.close();
});

test('protected multiline HTML and project directives retain their internal boundaries after an edit', async () => {
  const dom = installDOM();
  const compat = await loadCompat();
  const source = '<details>\nplain *inner*\n</details>\n\n:::media{#id}\nproject\n:::\n';
  const prepared = compat.prepareMarkdownForNovel(source);
  const editor = await createEditor(prepared.markdown);
  editor.commands.insertContentAt(editor.state.doc.content.size, '\n\n\u65b0\u6bb5\u843d');
  const restored = compat.restoreMarkdownFromNovel(editor.storage.markdown.getMarkdown(), prepared.replacements);

  assert.match(restored, /<details>\nplain \*inner\*\n<\/details>/);
  assert.match(restored, /:::media\{#id\}\nproject\n:::/);

  editor.destroy();
  dom.window.close();
});

test('compatibility ranges preserve comments, footnote continuations, aligned tables, fence metadata and token lookalikes', async () => {
  const dom = installDOM();
  const compat = await loadCompat();
  const cases = [
    '<!--\nsecret\n-->',
    '[^n]: first\n\n    second paragraph',
    '| left | right |\n| :--- | ---: |\n| a | b |',
    '```js {1,3}\nconst x = 1;\n```',
  ];

  for (const source of cases) {
    const prepared = compat.prepareMarkdownForNovel(source);
    const editor = await createEditor(prepared.markdown);
    editor.commands.insertContentAt(editor.state.doc.content.size, '\n\n追加内容');
    const restored = compat.restoreMarkdownFromNovel(editor.storage.markdown.getMarkdown(), prepared.replacements);
    assert.ok(restored.includes(source), `compatibility source changed:\n${source}\n---\n${restored}`);
    editor.destroy();
  }

  const collisionSource = '普通文本 ⟦timeblog-protected-0-0⟧\n\n<div>legacy</div>';
  const collision = compat.prepareMarkdownForNovel(collisionSource);
  assert.notEqual(collision.replacements[0].token, '⟦timeblog-protected-0-0⟧');
  assert.equal(compat.restoreMarkdownFromNovel(collision.markdown, collision.replacements), collisionSource);

  dom.window.close();
});

test('raw HTML declarations, processing instructions and CDATA survive the editor boundary', async () => {
  const dom = installDOM();
  const compat = await loadCompat();
  const cases = [
    '<!DOCTYPE html>',
    '<?xml version="1.0"?>',
    '<![CDATA[secret]]>',
    '<!DOCTYPE\nhtml>',
    '<?xml version="1.0"\nencoding="UTF-8"?>',
    '<![CDATA[\nsecret\n]]>',
    '<![CDATA[\nsecret\n\nmore\n]]>',
    '<?xml\nversion="1.0"\n\nencoding="utf-8"?>',
    '<script>\none\n\nheading\n---\n\ntwo\n</script>',
    'paragraph\n<script>\none\n\nheading\n---\n\ntwo\n</script>',
    'paragraph\n<![CDATA[\none\n\nheading\n---\n\ntwo\n]]>',
    'paragraph\n<?xml\nversion="1.0"\n\nencoding="utf-8"?>',
  ];

  for (const source of cases) {
    const prepared = compat.prepareMarkdownForNovel(source);
    assert.equal(prepared.replacements.length, 1, `raw HTML block was not protected: ${source}`);
    assert.equal(prepared.replacements[0].source, source);
    const editor = await createEditor(prepared.markdown);
    editor.commands.insertContentAt(editor.state.doc.content.size, '\n\n追加内容');
    const restored = compat.restoreMarkdownFromNovel(editor.storage.markdown.getMarkdown(), prepared.replacements);
    assert.match(restored, new RegExp(source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(compat.restoreMarkdownFromNovel(restored, prepared.replacements), restored);
    editor.destroy();
  }

  dom.window.close();
});

test('inline-code comment lookalikes and URI/email autolinks stay editable', async () => {
  const compat = await loadCompat();
  const source = '`<!-- not a comment`\n\n<https://example.com>\n\n<user@example.com>';
  const prepared = compat.prepareMarkdownForNovel(source);

  assert.equal(prepared.replacements.length, 0);
  assert.equal(compat.restoreMarkdownFromNovel(prepared.markdown, prepared.replacements), source);

  const rawHtml = compat.prepareMarkdownForNovel('<div>real raw HTML</div>');
  assert.equal(rawHtml.replacements.length, 1);

  const multilineCode = compat.prepareMarkdownForNovel('`code\n<!-- still code\ninside code`\n\nplain text');
  assert.equal(multilineCode.replacements.length, 0);

  const scriptBetweenUnclosedSpans = '`unclosed\n\n<script>\nsecret\n\nheading\n---\n\ntwo\n</script>\n\n`later';
  const scriptPrepared = compat.prepareMarkdownForNovel(scriptBetweenUnclosedSpans);
  assert.equal(scriptPrepared.replacements.length, 1);
  assert.equal(scriptPrepared.replacements[0].source, '<script>\nsecret\n\nheading\n---\n\ntwo\n</script>');

  const commentBetweenUnclosedSpans = '`unclosed\n\n<!--\nsecret\n\nheading\n---\n\ntwo\n-->\n\n`later';
  const commentPrepared = compat.prepareMarkdownForNovel(commentBetweenUnclosedSpans);
  assert.equal(commentPrepared.replacements.length, 1);
  assert.equal(commentPrepared.replacements[0].source, '<!--\nsecret\n\nheading\n---\n\ntwo\n-->');
});

test('link titles survive serialization and unsafe pasted attributes are normalized', async () => {
  const dom = installDOM();
  const editor = await createEditor('[说明](https://example.test "标题")');
  assert.match(editor.storage.markdown.getMarkdown(), /\[说明\]\(https:\/\/example\.test "标题"\)/);

  editor.commands.setContent('click');
  editor.commands.selectAll();
  editor.commands.setLink({ href: 'https://attacker.test', target: '_blank', rel: 'opener', class: 'foreign' });
  const anchor = editor.view.dom.querySelector('a');
  assert.equal(anchor?.getAttribute('target'), '_blank');
  assert.equal(anchor?.getAttribute('rel'), 'noopener noreferrer nofollow');
  assert.equal(anchor?.getAttribute('class'), null);
  assert.equal(editor.commands.setLink({ href: 'javascript:alert(1)' }), false);

  editor.destroy();
  dom.window.close();
});

test('the locked Tiptap mergeAttributes backport rejects prototype-derived DOM attributes', async () => {
  const dom = installDOM();
  const [{ mergeAttributes }, { DOMSerializer, Schema }] = await Promise.all([
    import('@tiptap/core'),
    import('@tiptap/pm/model'),
  ]);
  delete globalThis.__timeblogTiptapCanary;
  const malicious = JSON.parse('{"__proto__":{"src":"https://attacker.test/pixel","onerror":"globalThis.__timeblogTiptapCanary=1","data-canary":"owned"}}');
  const schema = new Schema({
    nodes: {
      doc: { content: 'image+' },
      image: { group: 'block', atom: true, toDOM: () => ['img', mergeAttributes(malicious)] },
      text: { group: 'inline' },
    },
  });
  const documentNode = schema.node('doc', null, [schema.node('image')]);
  const fragment = DOMSerializer.fromSchema(schema).serializeFragment(documentNode.content, { document: dom.window.document });
  const image = fragment.firstChild;

  assert.equal(Object.getPrototypeOf(mergeAttributes(malicious)), Object.prototype);
  assert.equal(image?.getAttribute('src'), null);
  assert.equal(image?.getAttribute('onerror'), null);
  assert.equal(image?.getAttribute('data-canary'), null);
  assert.equal(globalThis.__timeblogTiptapCanary, undefined);

  dom.window.close();
});

test('canonical media links remain marks while unsafe media protocols are rejected', async () => {
  const dom = installDOM();
  const editor = await createEditor('[\u9644\u4ef6](media://abc_1)');
  assert.equal(findLinkHref(editor.getJSON()), 'media://abc_1');

  editor.commands.setContent('\u6b63\u6587');
  editor.commands.insertContentAt(editor.state.selection, '\n![\u56fe\u7247](media://image_1)\n');
  assert.match(editor.storage.markdown.getMarkdown(), /!\[\u56fe\u7247\]\(media:\/\/image_1\)/);

  editor.commands.setContent('[\u4e0d\u5b89\u5168](media://bad/id)');
  assert.equal(findLinkHref(editor.getJSON()), '');

  editor.destroy();
  dom.window.close();
});

test('external image commands serialize a public URL and accessible alternative text', async () => {
  const dom = installDOM();
  const editor = await createEditor('正文');
  editor.commands.setTextSelection(editor.state.doc.content.size);
  assert.equal(editor.commands.setImage({ src: 'https://image.cainiao.me/library/sunset.webp?width=1280', alt: '湖边日落' }), true);

  const markdown = editor.storage.markdown.getMarkdown();
  assert.match(markdown, /!\[湖边日落\]\(https:\/\/image\.cainiao\.me\/library\/sunset\.webp\?width=1280\)/);
  const image = editor.view.dom.querySelector('img');
  assert.equal(image?.getAttribute('src'), 'https://image.cainiao.me/library/sunset.webp?width=1280');
  assert.equal(image?.getAttribute('alt'), '湖边日落');

  editor.destroy();
  dom.window.close();
});
