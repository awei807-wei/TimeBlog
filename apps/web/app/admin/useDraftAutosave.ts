'use client';

import { useCallback, useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { dbDelete, DRAFT_STORE, QUEUE_STORE } from './editor-storage';
import { useDraftAutosaveSync } from './useDraftAutosaveSync';
import { useDraftFlush } from './useDraftFlush';
import { useDraftOutbox } from './useDraftOutbox';
import { useDraftPersistence } from './useDraftPersistence';

type DraftAutosaveOptions = {
  csrf: string;
  payload: Record<string, unknown>;
  refreshDrafts: () => Promise<void>;
  setMessage: Dispatch<SetStateAction<string>>;
  discardingRef: MutableRefObject<boolean>;
};

export function useDraftAutosave({ csrf, payload, refreshDrafts, setMessage, discardingRef }: DraftAutosaveOptions) {
  const draftID = useRef<string | null>(null);
  const { runtime, syncDraft, abortPending } = useDraftAutosaveSync(csrf, setMessage, discardingRef);

  const currentDraftId = useCallback(() => {
    if (!draftID.current) draftID.current = crypto.randomUUID();
    return draftID.current;
  }, []);
  const setDraftId = useCallback((id: string) => {
    draftID.current = id;
  }, []);
  const getDraftId = useCallback(() => draftID.current, []);

  useEffect(() => {
    draftID.current = crypto.randomUUID();
  }, []);
  useDraftPersistence({ currentDraftId, payload, refreshDrafts, setMessage, epoch: runtime.epoch, syncDraft });
  useDraftOutbox({ csrf, setMessage, discardingRef, runtime });
  useDraftFlush({ currentDraftId, payload, syncDraft, discardingRef, epoch: runtime.epoch });

  const finalizeSavedDraft = useCallback(async (savedDraftID: string) => {
    abortPending();
    await Promise.allSettled([
      dbDelete(DRAFT_STORE, savedDraftID),
      dbDelete(QUEUE_STORE, savedDraftID),
    ]);
    draftID.current = crypto.randomUUID();
  }, [abortPending]);

  return { currentDraftId, setDraftId, getDraftId, abortPending, finalizeSavedDraft };
}
