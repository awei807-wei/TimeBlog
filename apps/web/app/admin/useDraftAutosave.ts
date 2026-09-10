'use client';

import { useCallback, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
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
  readMarkdown?: () => string | undefined;
  active: boolean;
};

export function useDraftAutosave({ csrf, payload, refreshDrafts, setMessage, discardingRef, readMarkdown, active }: DraftAutosaveOptions) {
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

  const { persistNow, flushNow } = useDraftPersistence({ currentDraftId, getDraftId, payload, refreshDrafts, setMessage, epoch: runtime.epoch, syncDraft, readMarkdown, active });
  useDraftOutbox({ csrf, setMessage, discardingRef, runtime, active });
  useDraftFlush({ currentDraftId, payload, syncDraft, discardingRef, epoch: runtime.epoch, flushNow, active });

  const finalizeSavedDraft = useCallback(async (savedDraftID: string) => {
    abortPending();
    await Promise.allSettled([
      dbDelete(DRAFT_STORE, savedDraftID),
      dbDelete(QUEUE_STORE, savedDraftID),
    ]);
    draftID.current = crypto.randomUUID();
  }, [abortPending]);

  return { currentDraftId, setDraftId, getDraftId, abortPending, finalizeSavedDraft, persistNow, flushNow };
}
