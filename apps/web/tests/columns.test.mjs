import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import postcss from 'postcss';

const require = createRequire(import.meta.url);
const link = { __esModule: true, default: ({ children, ...props }) => React.createElement('a', props, children) };
async function load(file, imports = {}) {
  const source = await fs.readFile(new URL(file, import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
  const mod = { exports: {} };
  const stubs = { 'next/link': link, ...imports };
  vm.compileFunction(code, ['require', 'module', 'exports'])(id => Object.hasOwn(stubs, id) ? stubs[id] : require(id), mod, mod.exports);
  return mod.exports;
}
const columns = await load('../app/public/columns.ts');
const intro = await load('../app/public/SectionIntro.tsx');

test('column links retain punctuation, Chinese, slashes and literal percent names', () => {
  for (const name of ['C++', 'C#', '100% 实践', '研发/运维', '生活随记']) {
    assert.equal(decodeURIComponent(columns.columnHref(name).slice('/categories/'.length)), name);
    assert.equal(columns.findColumn([{ name, count: 3 }], name).name, name);
    assert.equal(columns.findColumn([{ name, count: 3 }], encodeURIComponent(name)).name, name);
  }
  assert.notEqual(columns.columnHref('C++'), columns.columnHref('C#'));
});

test('legacy slugs resolve to original names and counts remain authoritative', () => {
  const list = columns.publicColumns({ 'Web Dev': 31, '日常': 5, 'Go / Rust': 2 });
  assert.deepEqual(list.map(item => item.count), [31, 5, 2]);
  assert.equal(columns.findColumn(list, 'web-dev').name, 'Web Dev');
  assert.equal(columns.findColumn(list, 'go-rust').name, 'Go / Rust');
  assert.equal(columns.findColumn(list, 'go-/-rust').name, 'Go / Rust');
  assert.equal(columns.findColumn(list, 'missing'), undefined);
});

async function detail(api) {
  return load('../app/categories/[slug]/page.tsx', {
    '@/lib/api': api, '../../public/columns': columns, '../../public/SectionIntro': intro,
    './CategoryResults': { __esModule: true, default: props => React.createElement('div', { 'data-category': props.slug }, props.initialEntries.map(entry => React.createElement('span', { key: entry.id }, entry.title))) },
    'next/navigation': { notFound: () => { throw new Error('NOT_FOUND'); } },
  });
}

test('column page requests original category and shows full count, not page size', async () => {
  const calls = [];
  const page = await detail({ getCategories: async () => ({ categories: { 'Web Dev': 31 } }), getCategory: async name => { calls.push(name); return { entries: [{ id: 'one', title: '本页文章' }], nextCursor: 'next' }; } });
  const params = Promise.resolve({ slug: 'Web%20Dev' });
  const html = renderToStaticMarkup(await page.default({ params }));
  assert.deepEqual(calls, ['Web Dev']);
  assert.ok(html.includes('收录 31 条公开记录'));
  assert.ok(html.includes('本页文章'));
  assert.ok(html.includes('aria-current="page"'));
  const metadata = await page.generateMetadata({ params });
  assert.ok(metadata.alternates.canonical.endsWith('/categories/Web%20Dev'));
});

test('unknown columns are not-found, while request failures remain retryable errors', async () => {
  const missing = await detail({ getCategories: async () => ({ categories: {} }), getCategory: async () => { throw new Error('should not fetch'); } });
  await assert.rejects(missing.default({ params: Promise.resolve({ slug: 'unknown' }) }), /NOT_FOUND/);
  const failed = await detail({ getCategories: async () => { throw new Error('offline'); } });
  await assert.rejects(failed.default({ params: Promise.resolve({ slug: 'unknown' }) }), /offline/);
  const metadata = await failed.generateMetadata({ params: Promise.resolve({ slug: 'unknown' }) });
  assert.equal(metadata.robots.index, false);
});

test('home columns distinguish empty taxonomy from failed data', async () => {
  const get = api => load('../app/public/ColumnDirectory.tsx', { '@/lib/api': api, './columns': columns });
  const empty = await get({ getCategories: async () => ({ categories: {} }) });
  assert.ok(renderToStaticMarkup(await empty.default()).includes('还没有公开栏目'));
  const failed = await get({ getCategories: async () => { throw new Error('offline'); } });
  assert.ok(renderToStaticMarkup(await failed.default()).includes('栏目暂时无法加载'));
  const populated = await get({ getCategories: async () => ({ categories: { 'C++': 7 } }) });
  const html = renderToStaticMarkup(await populated.default());
  assert.ok(html.includes('/categories/C%2B%2B'));
  assert.ok(html.includes('<small>7</small>'));
});

test('column stylesheet parses with mobile and reduced-motion support', async () => {
  const css = await fs.readFile(new URL('../app/columns.css', import.meta.url), 'utf8');
  assert.doesNotThrow(() => postcss.parse(css));
  assert.ok(css.includes('max-width: 600px'));
  assert.ok(css.includes('prefers-reduced-motion: reduce'));
});
