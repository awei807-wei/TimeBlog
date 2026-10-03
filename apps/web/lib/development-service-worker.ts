/** 供仍执行旧注册代码的开发客户端升级退出，不接管任何请求。 */
export const DEVELOPMENT_SERVICE_WORKER = `
self.addEventListener('install', event => {
  event.waitUntil(self.skipWaiting());
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith('timeline-shell-')).map(name => caches.delete(name)));
    await self.clients.claim();
    const clients = await self.clients.matchAll({ type: 'window' });
    await self.registration.unregister();
    // 只恢复无持久化业务数据的预览，不打断其他标签页中尚未保存的写作。
    await Promise.all(clients.filter(client => new URL(client.url).pathname === '/preview/writing.html')
      .map(client => client.navigate(client.url)));
  })());
});
`;
