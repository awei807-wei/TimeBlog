import { mediaQueueStoragePlan, type UploadItem } from '@/lib/media-utils';

export type Draft = { id: string; clientDraftId: string; payload: Record<string, unknown>; updatedAt: string };
export type QueueItem = { id: string; draft: Draft; attempts: number; nextTryAt: number };

export const DRAFT_STORE = 'drafts';
export const QUEUE_STORE = 'outbox';
export const MEDIA_QUEUE_STORE = 'media-queue';

const DB_NAME = 'timeline-editor';
const DB_VERSION = 2;
const PREF_STORE = 'preferences';

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DRAFT_STORE)) db.createObjectStore(DRAFT_STORE, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(QUEUE_STORE)) db.createObjectStore(QUEUE_STORE, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(PREF_STORE)) db.createObjectStore(PREF_STORE, { keyPath: 'key' });
      if (!db.objectStoreNames.contains(MEDIA_QUEUE_STORE)) db.createObjectStore(MEDIA_QUEUE_STORE, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function dbPut(store: string, value: unknown): Promise<boolean> {
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const request = db.transaction(store, 'readwrite').objectStore(store).put(value);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
    db.close();
    return true;
  } catch {
    // Offline/private browsing: keep the editor usable when IndexedDB is unavailable.
    return false;
  }
}

export async function dbGetAll<T>(store: string): Promise<T[]> {
  try {
    const db = await openDB();
    return await new Promise<T[]>((resolve, reject) => {
      const request = db.transaction(store, 'readonly').objectStore(store).getAll();
      request.onsuccess = () => { db.close(); resolve(request.result || []); };
      request.onerror = () => reject(request.error);
    });
  } catch {
    return [];
  }
}

export async function dbDelete(store: string, id: string): Promise<boolean> {
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const request = db.transaction(store, 'readwrite').objectStore(store).delete(id);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
    db.close();
    return true;
  } catch {
    // Ignore offline cleanup errors.
    return false;
  }
}

export async function persistMediaQueueItem(item: UploadItem, file?: Blob): Promise<UploadItem> {
  const existing = await dbGetAll<UploadItem>(MEDIA_QUEUE_STORE);
  const existingBytes = existing.reduce((sum, value) => sum + (value.file && value.hasBlob ? value.file.size : 0), 0);
  const previousBytes = existing.find(value => value.id === item.id)?.file?.size || 0;
  const plan = file ? mediaQueueStoragePlan(file.size, Math.max(0, existingBytes - previousBytes)) : { persistBlob: false, reason: 'queue-quota' as const };
  const value: UploadItem = { ...item, file: plan.persistBlob ? file : undefined, hasBlob: plan.persistBlob, needsReselect: !plan.persistBlob && item.status !== 'ready' };
  const stored = await dbPut(MEDIA_QUEUE_STORE, value);
  if (!stored && plan.persistBlob) {
    const fallback: UploadItem = { ...value, file: undefined, hasBlob: false, needsReselect: item.status !== 'ready', error: '浏览器存储空间不足，需重新选择文件' };
    await dbPut(MEDIA_QUEUE_STORE, fallback);
    return fallback;
  }
  return value;
}
