import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const source = await fs.readFile(new URL('../app/categories/[slug]/CategoryResults.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
async function setup(t, getCategory) {
  const dom = new JSDOM('<body><div id="root"></div></body>');
  const saved = new Map();
  for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const mod = { exports: {} };
  const imports = { '@/lib/api': { getCategory }, '../../public/PublicEntryCard': { __esModule: true, default: ({ entry }) => React.createElement('article', null, entry.title) } };
  vm.compileFunction(compiled, ['require', 'module', 'exports'])(id => Object.hasOwn(imports, id) ? imports[id] : require(id), mod, mod.exports);
  const root = createRoot(dom.window.document.getElementById('root'));
  t.after(async () => {
    await act(() => root.unmount()); dom.window.close();
    for (const [name, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; }
  });
  const render = props => act(() => root.render(React.createElement(mod.exports.default, { key: props.slug, ...props })));
  const click = () => dom.window.document.querySelector('button').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  return { document: dom.window.document, render, click };
}

test('pagination guards duplicate activation, deduplicates entries and resets for another column', async t => {
  let resolve; const calls = [];
  const ui = await setup(t, (...args) => { calls.push(args); return new Promise(done => { resolve = done; }); });
  await ui.render({ slug: '技术', initialEntries: [{ id: 'a', title: '第一篇' }], initialCursor: 'next' });
  await act(() => { ui.click(); ui.click(); });
  assert.deepEqual(calls, [['技术', 'next']]);
  assert.equal(ui.document.querySelector('section').getAttribute('aria-busy'), 'true');
  await act(async () => resolve({ entries: [{ id: 'a', title: '重复' }, { id: 'b', title: '第二篇' }, { id: 'b', title: '再次重复' }] }));
  assert.deepEqual([...ui.document.querySelectorAll('article')].map(item => item.textContent), ['第一篇', '第二篇']);
  assert.equal(ui.document.querySelector('button'), null);
  await ui.render({ slug: '生活', initialEntries: [{ id: 'c', title: '另一个栏目' }] });
  assert.equal(ui.document.querySelectorAll('article').length, 1);
  assert.equal(ui.document.querySelector('article').textContent, '另一个栏目');
});

test('failed pagination retains the cursor and content, and retry recovers', async t => {
  let attempts = 0;
  const ui = await setup(t, async (name, cursor) => {
    assert.equal(name, 'C++'); assert.equal(cursor, 'page2');
    if (++attempts === 1) throw new Error('offline');
    return { entries: [{ id: 'b', title: '恢复成功' }] };
  });
  await ui.render({ slug: 'C++', initialEntries: [{ id: 'a', title: '已有记录' }], initialCursor: 'page2' });
  await act(async () => { ui.click(); });
  assert.ok(ui.document.querySelector('[role=alert]'));
  assert.equal(ui.document.querySelector('button').textContent, '重试加载');
  assert.equal(ui.document.querySelector('article').textContent, '已有记录');
  await act(async () => { ui.click(); });
  assert.equal(ui.document.querySelector('[role=alert]'), null);
  assert.equal(ui.document.querySelectorAll('article').length, 2);
  assert.equal(attempts, 2);
});
