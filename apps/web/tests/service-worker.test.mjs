import assert from 'node:assert/strict';
import test from 'node:test';
import { workerFixture, origin } from './service-worker-harness.mjs';

test('worker 升级只淘汰本站旧缓存', async () => {
  const fixture = workerFixture();
  await fixture.caches.open('timeline-shell-v6');
  await fixture.caches.open('another-app-cache');
  await fixture.dispatch('install');
  await fixture.dispatch('activate');
  assert.deepEqual(await fixture.caches.keys(), ['another-app-cache', 'timeline-shell-v7']);
  assert.deepEqual(fixture.actions, ['skipWaiting', 'claim']);
});

test('预览、业务接口、管理页面、RSC 与站外请求不受缓存拦截', async () => {
  const fixture = workerFixture();
  for (const path of ['/preview/writing.html', '/api/v1/me', '/admin', '/login', '/recovery', '/private-media/1', '/?_rsc=abc', 'https://other.example/app.js']) {
    assert.equal(await fixture.fetch(path), undefined, path);
  }
  for (const headers of [{ RSC: '1' }, { Accept: 'text/x-component' }, { 'Next-Router-Prefetch': '1' }]) {
    assert.equal(await fixture.fetch('/calendar', { headers: new Headers(headers) }), undefined);
  }
  assert.equal(await fixture.fetch('/article/1', { cache: 'no-store' }), undefined);
  assert.equal(fixture.network.length, 0);
  assert.equal(fixture.storage.size, 0);
});

test('可变 Next 开发脚本始终走网络，不复用或写入缓存', async () => {
  const fixture = workerFixture();
  const path = '/_next/static/chunks/app/layout.js';
  const cache = await fixture.caches.open('timeline-shell-v7');
  await cache.put(path, new Response('过期脚本'));
  fixture.respond = () => new Response('当前脚本', { headers: { 'Cache-Control': 'no-store, must-revalidate' } });
  assert.equal(await (await fixture.fetch(path)).text(), '当前脚本');
  assert.equal(await (await fixture.fetch(path)).text(), '当前脚本');
  assert.equal(fixture.network.length, 2);
  assert.equal(await (await cache.match(path)).text(), '过期脚本');
});

test('带 immutable 的正式静态资源仍可离线复用', async () => {
  const fixture = workerFixture();
  const path = '/_next/static/chunks/layout-a48e09.js';
  fixture.respond = () => new Response('版本化脚本', { headers: { 'Cache-Control': 'public, max-age=31536000, immutable' } });
  assert.equal(await (await fixture.fetch(path)).text(), '版本化脚本');
  fixture.respond = () => { throw new Error('离线'); };
  assert.equal(await (await fixture.fetch(path)).text(), '版本化脚本');
  assert.equal(fixture.network.length, 1);
});

test('搜索不缓存，普通文件网络优先，离线可回退本站缓存', async () => {
  const fixture = workerFixture();
  for (const mode of ['navigate', 'cors']) assert.equal(await (await fixture.fetch('/search?q=test', { mode })).text(), '网络内容');
  const cache = await fixture.caches.open('timeline-shell-v7');
  await cache.put('/manifest.webmanifest', new Response('旧清单'));
  assert.equal(await (await fixture.fetch('/manifest.webmanifest')).text(), '网络内容');
  fixture.respond = () => { throw new Error('离线'); };
  assert.equal(await (await fixture.fetch('/manifest.webmanifest')).text(), '网络内容');
  assert.equal(await cache.match('/search?q=test'), undefined);
});

test('页面与图片保持原有离线能力，不缓存私有或 no-store 响应', async () => {
  const fixture = workerFixture();
  await fixture.dispatch('install');
  for (const directive of ['no-store', 'private']) {
    fixture.respond = () => new Response('不可缓存', { headers: { 'Cache-Control': directive } });
    await fixture.fetch(`/article/${directive}`, { mode: 'navigate' });
    await fixture.fetch(`/image-${directive}.png`, { destination: 'image' });
    const cache = await fixture.caches.open('timeline-shell-v7');
    assert.equal(await cache.match(`/article/${directive}`), undefined);
    assert.equal(await cache.match(`/image-${directive}.png`), undefined);
  }
  fixture.respond = () => new Response('公开内容');
  await fixture.fetch('/article/public', { mode: 'navigate' });
  await fixture.fetch('/image.png', { destination: 'image' });
  fixture.respond = () => { throw new Error('离线'); };
  assert.equal(await (await fixture.fetch('/article/public', { mode: 'navigate' })).text(), '公开内容');
  assert.equal(await (await fixture.fetch('/unvisited', { mode: 'navigate' })).text(), '预缓存');
  assert.equal(await (await fixture.fetch('/image.png', { destination: 'image' })).text(), '公开内容');
  await assert.rejects(fixture.fetch('/missing.png', { destination: 'image' }), /离线/);
});

test('内容变更通知仍清理可变页面并广播确认', async () => {
  const fixture = workerFixture();
  const cache = await fixture.caches.open('timeline-shell-v7');
  await cache.put('/article/1', new Response('过期文章'));
  await cache.put('/_next/static/chunks/abc.js', new Response('脚本'));
  const messages = [];
  fixture.scope.self.clients.matchAll = async () => [{ postMessage: message => messages.push(message) }];
  await fixture.dispatch('message', { data: { type: 'CACHE_INVALIDATE', scope: 'public-content', entryId: '1' } });
  assert.equal(await cache.match('/article/1'), undefined);
  assert.ok(await cache.match('/_next/static/chunks/abc.js'));
  assert.equal(messages[0].type, 'CACHE_INVALIDATED');
  assert.equal(messages[0].entryId, '1');
  assert.ok(fixture.network.every(url => url.startsWith(origin)));
});
