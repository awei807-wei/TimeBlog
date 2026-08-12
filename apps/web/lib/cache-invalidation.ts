export type PublicMutation = {
  entryId?: string;
  slug?: string;
  reason?: 'trash' | 'restore' | 'publish' | 'edit' | 'undo' | 'purge';
};

export const PUBLIC_CACHE_INVALIDATED_EVENT = 'timeline:public-cache-invalidated';

/**
 * Tell the service worker to evict mutable public documents after a confirmed
 * server mutation.  API responses are intentionally not service-worker
 * cached, but navigations may still be cached for offline reading.
 */
export async function invalidatePublicCaches(mutation: PublicMutation = {}): Promise<void> {
  if (typeof window === 'undefined') return;
  // Notify the current React tree synchronously.  The page must revalidate
  // even when the worker is not installed, still installing, or offline.
  window.dispatchEvent(new CustomEvent(PUBLIC_CACHE_INVALIDATED_EVENT, { detail: mutation }));
  if (!('serviceWorker' in navigator)) return;
  const message = { type: 'CACHE_INVALIDATE', scope: 'public-content', ...mutation };
  try {
    const registration = await navigator.serviceWorker.ready;
    const target = navigator.serviceWorker.controller || registration.active;
    target?.postMessage(message);
  } catch {
    // Cache eviction is best effort. The subsequent router refresh still
    // requests no-store public data; a failed SW handshake must not hide a
    // mutation that the API has already confirmed.
  }
}
