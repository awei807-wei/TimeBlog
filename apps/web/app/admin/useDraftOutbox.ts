'use client';

import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { API } from '@/lib/api';
import { nextRetryAt } from '@/lib/editor-utils';
import { dbDelete, dbGetAll, dbPut, QUEUE_STORE, type QueueItem } from './editor-storage';
import type { DraftAutosaveRuntime } from './useDraftAutosaveSync';

type DraftOutboxOptions = {
  csrf: string;
  setMessage: Dispatch<SetStateAction<string>>;
  discardingRef: MutableRefObject<boolean>;
  runtime: DraftAutosaveRuntime;
};

async function retryQueueItem(item: QueueItem, csrf: string, expectedEpoch: number, runtime: DraftAutosaveRuntime, discardingRef: MutableRefObject<boolean>, setMessage: DraftOutboxOptions['setMessage']) {
  const controller = new AbortController();
  runtime.abort.current?.abort();
  runtime.abort.current = controller;
  try {
    const response = await fetch(`${API}/admin/working-copies`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrf,
        'Idempotency-Key': item.draft.clientDraftId,
      },
      body: JSON.stringify({ clientDraftId: item.draft.clientDraftId, payload: item.draft.payload }),
      signal: controller.signal,
    });
    if (discardingRef.current || controller.signal.aborted || expectedEpoch !== runtime.epoch.current) return false;
    if (response.status === 409) {
      await dbDelete(QUEUE_STORE, item.id);
      setMessage('旧版编辑草稿已失效，已停止重试');
      return false;
    }
    if (!response.ok) throw new Error('outbox');
    await dbDelete(QUEUE_STORE, item.id);
    setMessage('离线草稿已重试同步');
    return true;
  } catch {
    if (discardingRef.current || controller.signal.aborted || expectedEpoch !== runtime.epoch.current) return false;
    const attempts = item.attempts + 1;
    await dbPut(QUEUE_STORE, { ...item, attempts, nextTryAt: nextRetryAt(attempts) });
    if (discardingRef.current || controller.signal.aborted || expectedEpoch !== runtime.epoch.current) {
      await dbDelete(QUEUE_STORE, item.id);
    }
    return false;
  } finally {
    if (runtime.abort.current === controller) runtime.abort.current = null;
  }
}

export function useDraftOutbox({ csrf, setMessage, discardingRef, runtime }: DraftOutboxOptions) {
  useEffect(() => {
    const consumeOutbox = async () => {
      if (discardingRef.current || !navigator.onLine || !csrf) return;
      const expectedEpoch = runtime.epoch.current;
      const items = await dbGetAll<QueueItem>(QUEUE_STORE);
      for (const item of items) {
        if (discardingRef.current || item.nextTryAt > Date.now() || expectedEpoch !== runtime.epoch.current) return;
        await retryQueueItem(item, csrf, expectedEpoch, runtime, discardingRef, setMessage);
      }
    };
    void consumeOutbox();
    window.addEventListener('online', consumeOutbox);
    window.addEventListener('focus', consumeOutbox);
    const interval = window.setInterval(consumeOutbox, 10_000);
    return () => {
      window.removeEventListener('online', consumeOutbox);
      window.removeEventListener('focus', consumeOutbox);
      window.clearInterval(interval);
    };
  }, [csrf, discardingRef, runtime, setMessage]);
}
