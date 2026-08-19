'use client';

import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { dbPut, DRAFT_STORE, type Draft } from './editor-storage';

type DraftPersistenceOptions = {
  currentDraftId: () => string;
  payload: Record<string, unknown>;
  refreshDrafts: () => Promise<void>;
  setMessage: Dispatch<SetStateAction<string>>;
  epoch: MutableRefObject<number>;
  syncDraft: (draft: Draft, epoch?: number) => Promise<void>;
};

export function useDraftPersistence({ currentDraftId, payload, refreshDrafts, setMessage, epoch, syncDraft }: DraftPersistenceOptions) {
  useEffect(() => {
    const expectedEpoch = epoch.current;
    const timer = window.setTimeout(async () => {
      if (expectedEpoch !== epoch.current) return;
      const id = currentDraftId();
      const draft: Draft = {
        id,
        clientDraftId: id,
        payload,
        updatedAt: new Date().toISOString(),
      };
      await dbPut(DRAFT_STORE, draft);
      if (expectedEpoch !== epoch.current) return;
      await refreshDrafts();
      setMessage('已本地保存');
      await syncDraft(draft, expectedEpoch);
    }, 500);
    return () => window.clearTimeout(timer);
  }, [currentDraftId, epoch, payload, refreshDrafts, setMessage, syncDraft]);
}
