let initialization: Promise<void> | undefined;

function isSiteWorker(worker: ServiceWorker | null) {
  return worker?.scriptURL === new URL('/sw.js', window.location.origin).href;
}

async function removeDevelopmentCache() {
  const controlled = isSiteWorker(navigator.serviceWorker.controller);
  const registrations = await navigator.serviceWorker.getRegistrations();
  const rootScope = new URL('/', window.location.origin).href;
  await Promise.all(registrations.filter(registration => (
    registration.scope === rootScope && [registration.active, registration.waiting, registration.installing].some(isSiteWorker)
  )).map(registration => registration.unregister()));
  if ('caches' in window) {
    const names = await window.caches.keys();
    await Promise.all(names.filter(name => name.startsWith('timeline-shell-')).map(name => window.caches.delete(name)));
  }
  // 注销只影响下次导航；已被旧 worker 控制的页面需要重新加载一次。
  if (controlled) window.location.reload();
}

async function registerProductionWorker() {
  const registration = await navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' });
  await registration.update();
}

/** 每个页面只初始化一次离线缓存；开发环境仅清理本站历史注册与缓存。 */
export function initializeServiceWorker(): Promise<void> {
  if (!('serviceWorker' in navigator)) return Promise.resolve();
  initialization ??= process.env.NODE_ENV === 'production' ? registerProductionWorker() : removeDevelopmentCache();
  return initialization;
}
