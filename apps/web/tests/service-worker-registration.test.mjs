import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { workerFixture, origin } from './service-worker-harness.mjs';

const read = path => fs.readFile(new URL(path, import.meta.url), 'utf8');
const registrationSource = await read('../lib/service-worker-registration.ts');
const developmentSource = await read('../lib/development-service-worker.ts');
const proxySource = await read('../proxy.ts');

function load(source, scope = {}) {
  const exports = {};
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  vm.runInNewContext(compiled, { exports, URL, Promise, ...scope });
  return exports;
}

function registrationFixture(mode, { controlled = false, unsupported = false } = {}) {
  const calls = [];
  const cacheNames = new Set(['timeline-shell-v6', 'timeline-shell-v5', 'another-app-cache']);
  const siteWorker = { scriptURL: `${origin}/sw.js` };
  const own = { scope: `${origin}/`, active: siteWorker, waiting: null, installing: null, unregister: async () => { calls.push('unregister-own'); } };
  const foreign = { scope: `${origin}/other/`, active: { scriptURL: `${origin}/other/sw.js` }, waiting: null, installing: null, unregister: async () => { calls.push('unregister-foreign'); } };
  const navigator = unsupported ? {} : { serviceWorker: {
    controller: controlled ? siteWorker : null,
    getRegistrations: async () => { calls.push('registrations'); return [own, foreign]; },
    register: async (path, options) => { calls.push(['register', path, options.updateViaCache]); return { update: async () => { calls.push('update'); } }; },
  } };
  const { initializeServiceWorker } = load(registrationSource, {
    navigator, process: { env: { NODE_ENV: mode } },
    window: { location: { origin, reload: () => calls.push('reload') }, caches: {
      keys: async () => [...cacheNames], delete: async name => cacheNames.delete(name),
    } },
  });
  return { initializeServiceWorker, calls, cacheNames, navigator };
}

test('开发首次打开只清理本站历史缓存，不注册、不刷新', async () => {
  const fixture = registrationFixture('development');
  await fixture.initializeServiceWorker();
  assert.deepEqual(fixture.calls, ['registrations', 'unregister-own']);
  assert.deepEqual([...fixture.cacheNames], ['another-app-cache']);
});

test('开发旧控制器仅恢复一次，StrictMode 重复初始化不会循环刷新', async () => {
  const fixture = registrationFixture('development', { controlled: true });
  await Promise.all([fixture.initializeServiceWorker(), fixture.initializeServiceWorker()]);
  await fixture.initializeServiceWorker();
  assert.deepEqual(fixture.calls, ['registrations', 'unregister-own', 'reload']);
  assert.deepEqual([...fixture.cacheNames], ['another-app-cache']);
});

test('不刷新其他应用的 worker 控制页面', async () => {
  const fixture = registrationFixture('development');
  fixture.navigator.serviceWorker.controller = { scriptURL: `${origin}/another/sw.js` };
  await fixture.initializeServiceWorker();
  assert.ok(!fixture.calls.includes('reload'));
  assert.ok(!fixture.calls.includes('unregister-foreign'));
});

test('正式环境注册一次并绕过脚本 HTTP 缓存更新，不清空离线数据', async () => {
  const fixture = registrationFixture('production');
  await Promise.all([fixture.initializeServiceWorker(), fixture.initializeServiceWorker()]);
  assert.deepEqual(fixture.calls, [['register', '/sw.js', 'none'], 'update']);
  assert.equal(fixture.cacheNames.size, 3);
});

test('不支持 worker 的浏览器不抛错，真实注册失败会向调用层上报', async () => {
  await registrationFixture('development', { unsupported: true }).initializeServiceWorker();
  const fixture = registrationFixture('production');
  fixture.navigator.serviceWorker.register = async () => { throw new Error('注册被拒绝'); };
  await assert.rejects(fixture.initializeServiceWorker(), /注册被拒绝/);
  const component = await read('../app/ServiceWorkerRegister.tsx');
  assert.match(component, /console\.error\('离线缓存初始化失败/);
});

test('开发升级 worker 不接管请求、注销自身，只恢复预览标签页', async () => {
  const { DEVELOPMENT_SERVICE_WORKER } = load(developmentSource);
  const fixture = workerFixture(DEVELOPMENT_SERVICE_WORKER);
  assert.doesNotMatch(DEVELOPMENT_SERVICE_WORKER, /addEventListener\('fetch'/);
  await fixture.caches.open('timeline-shell-v6');
  await fixture.caches.open('another-app-cache');
  const navigations = [];
  fixture.scope.self.clients.matchAll = async () => ['/preview/writing.html', '/admin', '/calendar'].map(path => ({
    url: origin + path, navigate: async url => navigations.push(url),
  }));
  await fixture.dispatch('install');
  await fixture.dispatch('activate');
  assert.deepEqual(fixture.actions, ['skipWaiting', 'claim', 'unregister']);
  assert.deepEqual(await fixture.caches.keys(), ['another-app-cache']);
  assert.deepEqual(navigations, [origin + '/preview/writing.html']);
});

test('原 sw.js 地址仅开发返回退出脚本，正式 worker 与预览 404 隔离', async () => {
  const { DEVELOPMENT_SERVICE_WORKER } = load(developmentSource);
  class NextResponse extends Response { static next() { return 'next'; } }
  for (const mode of ['development', 'production']) {
    const { proxy, config } = load(proxySource, {
      process: { env: { NODE_ENV: mode } },
      require: name => name === 'next/server' ? { NextResponse } : { DEVELOPMENT_SERVICE_WORKER },
    });
    assert.deepEqual([...config.matcher], ['/preview/writing.html', '/sw.js']);
    const worker = proxy({ nextUrl: { pathname: '/sw.js' } });
    const preview = proxy({ nextUrl: { pathname: '/preview/writing.html' } });
    if (mode === 'development') {
      assert.equal(await worker.text(), DEVELOPMENT_SERVICE_WORKER);
      assert.match(worker.headers.get('Content-Type'), /application\/javascript/);
      assert.equal(worker.headers.get('Cache-Control'), 'no-store');
      assert.equal(preview, 'next');
    } else {
      assert.equal(worker, 'next');
      assert.equal(preview.status, 404);
    }
  }
});
