'use client';

import { useCallback, useMemo, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { API } from '@/lib/api';
import { dbDelete, dbPut, QUEUE_STORE, type Draft, type QueueItem } from './editor-storage';

export type DraftAutosaveRuntime = {
  epoch: MutableRefObject<number>;
  abort: MutableRefObject<AbortController | null>;
};

export function useDraftAutosaveSync(csrf: string, setMessage: Dispatch<SetStateAction<string>>, discardingRef: MutableRefObject<boolean>) {
  const lastSync = useRef(0);
  const epoch = useRef(0);
  const abort = useRef<AbortController | null>(null);

  const syncDraft = useCallback(async (draft: Draft, expectedEpoch = epoch.current) => {
    if (discardingRef.current || expectedEpoch !== epoch.current || !csrf || !navigator.onLine || Date.now() - lastSync.current < 2000) return;
    lastSync.current = Date.now();
    const controller = new AbortController();
    abort.current?.abort();
    abort.current = controller;
    try {
      const response = await fetch(`${API}/admin/working-copies`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrf,
          'Idempotency-Key': draft.clientDraftId,
        },
        body: JSON.stringify({ clientDraftId: draft.clientDraftId, payload: draft.payload }),
        signal: controller.signal,
      });
      if (expectedEpoch !== epoch.current || controller.signal.aborted) return;
      if (response.status === 409) {
        await dbDelete(QUEUE_STORE, draft.id);
        setMessage('旧版编辑草稿已失效，请重新载入');
        return;
      }
      if (!response.ok) throw new Error('sync');
      setMessage('已同步工作草稿');
    } catch {
      if (discardingRef.current || controller.signal.aborted || expectedEpoch !== epoch.current) return;
      const item: QueueItem = { id: draft.id, draft, attempts: 0, nextTryAt: Date.now() + 1000 };
      await dbPut(QUEUE_STORE, item);
      if (discardingRef.current || controller.signal.aborted || expectedEpoch !== epoch.current) {
        await dbDelete(QUEUE_STORE, draft.id);
        return;
      }
      setMessage('暂存离线队列，联网后重试');
    } finally {
      if (abort.current === controller) abort.current = null;
    }
  }, [csrf, discardingRef, setMessage]);

  const abortPending = useCallback(() => {
    abort.current?.abort();
    abort.current = null;
    epoch.current += 1;
    lastSync.current = 0;
  }, []);

  const runtime = useMemo(() => ({ epoch, abort }), [abort, epoch]);
  return { runtime, syncDraft, abortPending };
}
