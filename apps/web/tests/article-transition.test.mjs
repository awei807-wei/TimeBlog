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
const sourceURL = new URL('../app/article/ArticleTransition.tsx', import.meta.url);
const source = await fs.readFile(sourceURL, 'utf8');
const compiled = ts.transpileModule(source, {
  fileName: sourceURL.pathname,
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  reportDiagnostics: true,
});
assert.deepEqual(compiled.diagnostics.filter(item => item.category === ts.DiagnosticCategory.Error), []);
const evaluate = vm.compileFunction(compiled.outputText, ['require', 'module', 'exports'], { filename: sourceURL.pathname });

async function setup(t) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/article/example' });
  const saved = new Map();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const timers = new Map();
  let timerID = 0;
  dom.window.setTimeout = (callback, delay) => { timers.set(++timerID, { callback, delay }); return timerID; };
  dom.window.clearTimeout = id => timers.delete(id);
  let pathname = '/article/example';
  let refreshCount = 0;
  const imports = {
    'next/link': { __esModule: true, default: ({ children, ...props }) => React.createElement('a', props, children) },
    'next/navigation': { usePathname: () => pathname, useRouter: () => ({ refresh: () => { refreshCount += 1; } }) },
    '@/lib/article-loader': { ARTICLE_TIMEOUT_MS: 10_000 },
  };
  const loadedModule = { exports: {} };
  evaluate(id => Object.hasOwn(imports, id) ? imports[id] : require(id), loadedModule, loadedModule.exports);
  const Component = loadedModule.exports.default;
  const root = createRoot(dom.window.document.getElementById('root'));
  t.after(async () => {
    await act(() => root.unmount());
    assert.equal(timers.size, 0, 'unmount clears the timeout');
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  return {
    document: dom.window.document, timers,
    get refreshCount() { return refreshCount; },
    setPath: value => { pathname = value; },
    render: props => act(() => root.render(React.createElement(Component, props))),
    expire: () => act(() => {
      for (const [id, { callback }] of [...timers]) { timers.delete(id); callback(); }
    }),
    click: () => act(() => dom.window.document.querySelector('button').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))),
  };
}

test('loading keeps the reader shell, announces progress and times out at ten seconds', async t => {
  const ui = await setup(t);
  await ui.render({});
  assert.ok(ui.document.querySelector('main#main-content.public-page.public-article-shell'));
  assert.equal(ui.document.querySelector('h1').textContent, '过渡中');
  assert.equal(ui.document.querySelector('[role=status]').getAttribute('aria-live'), 'polite');
  assert.equal(ui.document.querySelectorAll('.article-transition-skeleton[aria-hidden=true] > span').length, 3);
  assert.equal(ui.document.querySelector('button'), null);
  assert.deepEqual([...ui.timers.values()].map(timer => timer.delay), [10_000]);
  await ui.expire();
  assert.equal(ui.document.querySelector('[data-state]').dataset.state, 'timeout');
  assert.equal(ui.document.querySelector('h1').textContent, '过渡超时');
  assert.equal(ui.document.querySelector('button').textContent, '重新加载');
});

test('retry from a pending timeout refreshes in place and starts a fresh wait', async t => {
  const ui = await setup(t);
  await ui.render({});
  await ui.expire();
  await ui.click();
  assert.equal(ui.refreshCount, 1);
  assert.equal(ui.document.querySelector('[data-state]').dataset.state, 'loading');
  assert.equal(ui.timers.size, 1);
  await ui.expire();
  assert.equal(ui.document.querySelector('[data-state]').dataset.state, 'timeout');
});

test('failed and timed-out requests offer recovery without exposing internal errors', async t => {
  const ui = await setup(t);
  await ui.render({ state: 'failed' });
  assert.equal(ui.document.querySelector('[role=alert] h1').textContent, '过渡失败');
  assert.equal(ui.document.querySelectorAll('a[href="/"]').length, 2);
  assert.equal(ui.timers.size, 0);
  await ui.click();
  assert.equal(ui.refreshCount, 1);
  // With a synchronous test router the request has already settled.
  assert.equal(ui.document.querySelector('[data-state]').dataset.state, 'failed');
  await ui.render({ state: 'timeout' });
  assert.equal(ui.document.querySelector('h1').textContent, '过渡超时');
  assert.equal(ui.document.querySelector('[role=status]').getAttribute('aria-atomic'), 'true');
  assert.equal(ui.timers.size, 0);
});

test('error boundary recovery calls retry rather than refreshing a stale error tree', async t => {
  const ui = await setup(t);
  let retries = 0;
  await ui.render({ state: 'failed', onRetry: () => { retries += 1; } });
  await ui.click();
  assert.equal(retries, 1);
  assert.equal(ui.refreshCount, 0);
});

test('changing article resets an expired timer and does not retain the previous mode', async t => {
  const ui = await setup(t);
  await ui.render({});
  await ui.expire();
  ui.setPath('/article/another');
  await ui.render({});
  assert.equal(ui.document.querySelector('[data-state]').dataset.state, 'loading');
  assert.equal(ui.timers.size, 1);
});

test('route wiring uses native loading and retry boundaries with reduced-motion support', async () => {
  const read = file => fs.readFile(new URL(file, import.meta.url), 'utf8');
  const [loading, error, page, css, layout] = await Promise.all([
    read('../app/article/[slug]/loading.tsx'), read('../app/article/[slug]/error.tsx'),
    read('../app/article/[slug]/page.tsx'), read('../app/article-transition.css'), read('../app/layout.tsx'),
  ]);
  assert.match(loading, /<ArticleTransition/);
  assert.match(error, /onRetry=\{retry\}/);
  assert.match(page, /cache\(fetchArticle\)/);
  assert.match(page, /result.status === 'not-found'\) notFound\(\)/);
  assert.match(page, /<ArticleTransition state=\{result.status\}/);
  assert.doesNotMatch(page, /catch\s*\{\s*return null/);
  assert.match(layout, /import '.\/article-transition.css'/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /animation: none/);
  assert.doesNotMatch(source, /location\.(reload|assign)|setInterval/);
});
