import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { after, test } from 'node:test';
import { registerHooks } from 'node:module';

// Novel also exports a tweet component; its CSS is irrelevant to keyboard tests.
const cssHook = registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: 'export default {};', shortCircuit: true };
    return nextLoad(url, context);
  },
});
after(() => cssHook.deregister());
import ts from 'typescript';
import { JSDOM } from 'jsdom';

// Only layout/browser facilities missing from JSDOM are shimmed. Editor state,
// Suggestion, ReactRenderer, cmdk filtering/selection and DOM events are real.
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://blog.test/admin', pretendToBeVisual: true,
});
for (const key of ['window', 'document', 'navigator', 'Node', 'HTMLElement', 'Element', 'MutationObserver', 'DOMParser', 'KeyboardEvent', 'Event', 'MouseEvent', 'FocusEvent', 'CompositionEvent']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
}
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
dom.window.Range.prototype.getClientRects = () => [];
dom.window.Range.prototype.getBoundingClientRect = () => new dom.window.DOMRect();
after(() => dom.window.close());

// Transpile the actual production helper/components, resolving imports without
// writing generated files or changing package scripts. Node's CJS tippy entry
// needs the same default-export interop that the Next bundler supplies.
const modules = new Map();
async function moduleURL(url) {
  if (modules.has(url.href)) return modules.get(url.href);
  let source = ts.transpileModule(await fs.readFile(url, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  for (const match of [...source.matchAll(/from (["'])([^"']+)\1/g)]) {
    const specifier = match[2];
    let resolved;
    if (specifier.startsWith('.')) {
      resolved = await moduleURL(new URL(`${specifier}.tsx`, url));
    } else if (specifier === 'tippy.js') {
      resolved = `data:text/javascript,${encodeURIComponent(`import tippy from '${import.meta.resolve(specifier)}'; export default tippy.default ?? tippy;`)}`;
    } else {
      resolved = import.meta.resolve(specifier);
    }
    source = source.replace(match[0], `from ${JSON.stringify(resolved)}`);
  }
  const result = `data:text/javascript,${encodeURIComponent(source)}`;
  modules.set(url.href, result);
  return result;
}
const [{ createNovelSlashCommand }, { buildNovelSuggestions }, React, { createRoot }, { EditorProvider, useCurrentEditor }, { default: StarterKit }] = await Promise.all([
  import(await moduleURL(new URL('../app/admin/novel-slash-command.ts', import.meta.url))),
  import(await moduleURL(new URL('../app/admin/NovelEditorMenus.tsx', import.meta.url))),
  import('react'), import('react-dom/client'), import('@tiptap/react'), import('@tiptap/starter-kit'),
]);
const { act, createElement: h, useEffect } = React;
const tick = () => new Promise(resolve => setTimeout(resolve, 25));

async function fixture(t, { content = '', portal = false, extension } = {}) {
  const shell = document.createElement('section');
  const host = document.createElement('div');
  const portalElement = document.createElement('div');
  shell.append(host, portalElement);
  document.body.append(shell);
  const root = createRoot(host);
  const calls = [];
  const outer = [];
  const documentKeys = [];
  const captureKeys = [];
  const bubble = event => documentKeys.push(event.key);
  const capture = event => captureKeys.push(event.key);
  document.addEventListener('keydown', bubble);
  document.addEventListener('keydown', capture, true);
  const suggestions = buildNovelSuggestions((editor, range) => editor.commands.deleteRange(range)).map(item => ({
    ...item, command: props => { calls.push({ title: item.title, range: props.range }); item.command?.(props); },
  }));
  const slash = (extension || createNovelSlashCommand(portal ? portalElement : undefined)).configure({
    suggestion: { char: '/', items: () => suggestions },
  });
  let editor;
  function Probe() {
    const current = useCurrentEditor();
    useEffect(() => { editor = current.editor; }, [current.editor]);
    return null;
  }
  await act(async () => {
    root.render(h('div', { onKeyDown: event => outer.push(event.key) },
      h(EditorProvider, { extensions: [StarterKit, slash], content, immediatelyRender: false }, h(Probe))));
  });
  await act(tick);
  assert.ok(editor);
  let unmounted = false;
  const unmount = async () => {
    if (unmounted) return;
    unmounted = true;
    await act(async () => root.unmount());
    // useEditor intentionally destroys its instance on the next tick.
    await act(tick);
    assert.equal(editor.isDestroyed, true);
    document.removeEventListener('keydown', bubble);
    document.removeEventListener('keydown', capture, true);
    shell.remove();
  };
  t.after(unmount);
  const insert = async text => {
    await act(async () => { editor.commands.insertContent(text); });
    await act(tick);
  };
  const press = async (key, options = {}, target = editor.view.dom) => {
    const event = new KeyboardEvent('keydown', {
      key, keyCode: { Enter: 13, ArrowUp: 38, ArrowDown: 40, Escape: 27 }[key],
      bubbles: true, cancelable: true, ...options,
    });
    await act(async () => target.dispatchEvent(event));
    await act(tick);
    return event;
  };
  const menu = () => (portal ? portalElement : document).querySelector('[cmdk-root]');
  return { editor, calls, outer, documentKeys, captureKeys, shell, host, portalElement, insert, press, menu, unmount };
}

test('Enter executes the selected heading exactly once without adding a paragraph or bubbling', async t => {
  const f = await fixture(t);
  await f.insert('/heading');
  assert.equal(f.menu()?.querySelectorAll('[cmdk-item]').length, 1);
  const event = await f.press('Enter');
  assert.equal(event.defaultPrevented, true);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].title, '标题');
  assert.equal(f.editor.state.doc.childCount, 1);
  assert.equal(f.editor.state.doc.firstChild.type.name, 'heading');
  assert.equal(f.editor.getText(), '');
  assert.deepEqual(f.outer, []);
  assert.deepEqual(f.documentKeys, []);
  assert.equal(f.menu(), null);
});

test('ArrowUp/Down route through cmdk without moving the article caret; Enter selects that item', async t => {
  const f = await fixture(t);
  await f.insert('/');
  const before = f.editor.state.selection.toJSON();
  const selected = () => f.menu().querySelector('[aria-selected="true"]')?.textContent;
  assert.match(selected(), /正文/);
  assert.equal((await f.press('ArrowDown')).defaultPrevented, true);
  assert.match(selected(), /图片/);
  assert.equal((await f.press('ArrowUp')).defaultPrevented, true);
  assert.match(selected(), /正文/);
  await f.press('ArrowDown');
  assert.deepEqual(f.editor.state.selection.toJSON(), before);
  assert.equal(f.editor.getText(), '/');
  await f.press('Enter');
  assert.deepEqual(f.calls.map(call => call.title), ['图片']);
  assert.equal(f.editor.state.doc.childCount, 1);
  assert.deepEqual(f.outer, []);
  assert.deepEqual(f.documentKeys, []);
});

test('empty results consume Enter/arrows; Escape closes only the menu and normal Enter works afterward', async t => {
  const f = await fixture(t, { portal: true });
  await f.insert('/zzzz-no-match');
  assert.match(f.menu().textContent, /没有匹配的命令/);
  assert.equal(f.menu().querySelectorAll('[cmdk-item]').length, 0);
  const before = f.editor.getJSON();
  for (const key of ['Enter', 'ArrowUp', 'ArrowDown']) {
    assert.equal((await f.press(key)).defaultPrevented, true);
    assert.deepEqual(f.editor.getJSON(), before);
  }
  assert.equal(f.calls.length, 0);
  f.captureKeys.length = 0;
  assert.equal((await f.press('Escape')).defaultPrevented, true);
  assert.deepEqual(f.captureKeys, [], 'Escape must precede the dialog document-capture listener');
  assert.deepEqual(f.outer, []);
  assert.deepEqual(f.documentKeys, []);
  assert.equal(f.menu(), null);
  await f.press('Enter');
  assert.equal(f.editor.state.doc.childCount, 2);
  assert.deepEqual(f.documentKeys, ['Enter']);
  await f.press('Escape');
  assert.deepEqual(f.captureKeys, ['Enter', 'Escape']);
});

test('IME isComposing, keyCode 229 and view.composing never select or cancel commands', async t => {
  const f = await fixture(t);
  await f.insert('/');
  const before = f.editor.getJSON();
  for (const options of [{ isComposing: true }, { keyCode: 229 }]) {
    for (const key of ['Enter', 'ArrowDown', 'ArrowUp', 'Escape']) {
      assert.equal((await f.press(key, options)).defaultPrevented, false, `${key} must keep IME defaults`);
      assert.deepEqual(f.editor.getJSON(), before);
      assert.ok(f.menu());
    }
  }
  await act(async () => f.editor.view.dom.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })));
  assert.equal(f.editor.view.composing, true);
  assert.equal((await f.press('Enter', {}, f.menu())).defaultPrevented, false);
  assert.equal(f.calls.length, 0, 'a directly focused menu must also respect view.composing');
  assert.equal((await f.press('Enter')).defaultPrevented, false);
  assert.equal((await f.press('Escape')).defaultPrevented, false);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.outer, []);
  assert.deepEqual(f.documentKeys, []);
  await act(async () => f.editor.view.dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中' })));
  await act(tick);
  assert.equal(f.editor.view.composing, false);
  // JSDOM reports Apple Computer as vendor: exercise PM's real Safari guard.
  assert.match(navigator.vendor, /Apple Computer/);
  assert.equal((await f.press('Enter')).defaultPrevented, false);
  assert.equal(f.calls.length, 0, 'the trailing IME confirmation must be ignored');
  assert.deepEqual(f.editor.getJSON(), before);
  await f.press('Enter');
  assert.equal(f.calls.length, 1);
  assert.equal(f.editor.state.doc.childCount, 1);
});

test('the real popup stays in the quick-write Portal and ignores unrelated controls', async t => {
  const f = await fixture(t, { portal: true });
  await f.insert('/heading');
  assert.ok(f.portalElement.querySelector('[data-tippy-root] [cmdk-root]'));
  const input = document.createElement('input');
  f.shell.append(input);
  for (const key of ['Enter', 'ArrowDown', 'Escape']) {
    assert.equal((await f.press(key, {}, input)).defaultPrevented, false);
  }
  assert.equal(f.calls.length, 0);
  assert.equal(f.editor.getText(), '/heading');
  assert.ok(f.menu());
  f.captureKeys.length = 0;
  await f.press('Escape', {}, f.menu());
  assert.deepEqual(f.captureKeys, []);
  assert.equal(f.menu(), null);
});

test('two editors keep independent queries, ranges and command targets even with a shared extension', async t => {
  const extension = createNovelSlashCommand();
  const a = await fixture(t, { extension });
  const b = await fixture(t, { extension });
  await a.insert('/heading');
  await b.insert('prefix /quote');
  assert.equal(document.querySelectorAll('[cmdk-root]').length, 2);
  assert.deepEqual([...document.querySelectorAll('[cmdk-root]')].map(menu => menu.dataset.query).sort(), ['heading', 'quote']);
  await b.press('Enter');
  assert.deepEqual(b.calls.map(call => call.title), ['引用']);
  assert.equal(b.calls[0].range.from, 8);
  assert.equal(b.editor.state.doc.textContent, 'prefix ');
  assert.equal(b.editor.state.doc.lastChild.type.name, 'blockquote');
  assert.equal(a.editor.getText(), '/heading');
  assert.equal(a.calls.length, 0);
  await a.press('Enter');
  assert.deepEqual(a.calls.map(call => call.title), ['标题']);
  assert.equal(a.calls[0].range.from, 1);
  assert.equal(a.editor.state.doc.firstChild.type.name, 'heading');
  assert.equal(document.querySelector('[cmdk-root]'), null);
});

test('ordinary Enter and slash inside code blocks retain their normal behavior', async t => {
  const f = await fixture(t);
  await f.insert('正文');
  await f.press('Enter');
  assert.equal(f.editor.state.doc.childCount, 2);
  await act(async () => f.editor.commands.setCodeBlock());
  await f.insert('/');
  assert.equal(f.menu(), null);
  await f.press('Enter');
  assert.equal(f.editor.state.doc.lastChild.type.name, 'codeBlock');
  assert.equal(f.editor.state.doc.lastChild.textContent, '/\n');
  assert.equal(f.calls.length, 0);
});

test('pending rendering and a stale filtered menu cannot leak Enter or execute a previous result', async t => {
  const f = await fixture(t);
  await act(async () => {
    f.editor.commands.insertContent('/heading');
    const event = new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true, cancelable: true });
    f.editor.view.dom.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
    assert.equal(f.calls.length, 0);
    assert.equal(f.editor.state.doc.childCount, 1);
  });
  await act(tick);
  await act(async () => {
    f.editor.commands.insertContent('zzzz');
    const event = new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true, cancelable: true });
    f.editor.view.dom.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
    assert.equal(f.calls.length, 0);
  });
  await act(tick);
  assert.equal(f.editor.getText(), '/headingzzzz');
  assert.equal(f.menu().querySelectorAll('[cmdk-item]').length, 0);
  assert.deepEqual(f.outer, []);
});

test('rapidly starting and exiting suggestions leaves only the current popup', async t => {
  const f = await fixture(t, { portal: true });
  await act(async () => {
    f.editor.commands.insertContent('/heading');
    f.editor.commands.setContent('');
    f.editor.commands.insertContent('/quote');
  });
  await act(tick);
  assert.equal(f.portalElement.querySelectorAll('[cmdk-root]').length, 1);
  assert.equal(f.menu().dataset.query, 'quote');
  await f.press('Enter');
  assert.deepEqual(f.calls.map(call => call.title), ['引用']);
  assert.equal(f.portalElement.querySelector('[cmdk-root]'), null);
});

test('another editor retains ordinary Enter while a menu is open, and real blur dismisses the owner menu', async t => {
  const a = await fixture(t);
  const b = await fixture(t);
  await a.insert('/heading');
  await b.insert('正文');
  await b.press('Enter');
  assert.equal(b.editor.state.doc.childCount, 2);
  assert.equal(a.calls.length, 0);
  assert.equal(a.editor.getText(), '/heading');
  assert.ok(a.menu());
  await act(async () => a.editor.view.dom.focus());
  await act(async () => b.editor.view.dom.focus());
  await act(tick);
  assert.equal(document.querySelector('[cmdk-root]'), null);
  await a.press('Enter');
  assert.equal(a.editor.state.doc.childCount, 2);
  assert.equal(a.calls.length, 0);
});

test('mouse selection uses the live range and editor destruction cleans popup and Escape listener', async t => {
  const f = await fixture(t, { portal: true });
  await f.insert('/heading');
  const item = f.menu().querySelector('[cmdk-item]');
  await act(async () => item.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await act(tick);
  assert.equal(f.calls.length, 1);
  assert.equal(f.editor.state.doc.firstChild.type.name, 'heading');
  await f.insert('/');
  assert.ok(f.menu());
  const formerEditorDOM = f.editor.view.dom;
  await f.unmount();
  assert.equal(document.querySelector('[data-tippy-root]'), null);
  document.body.append(formerEditorDOM);
  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  formerEditorDOM.dispatchEvent(event);
  assert.equal(event.defaultPrevented, false);
  formerEditorDOM.remove();
});
