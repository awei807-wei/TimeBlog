'use client';

import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { API } from '@/lib/api';
import { AdminRequestError } from './admin-errors';
import { discardWorkingCopy, type WorkingCopyResponse } from './editing-working-copy';
import { dbDelete, DRAFT_STORE, QUEUE_STORE } from './editor-storage';

type RestorePublishedVersionOptions = {
  editingEntryID: string;
  hasUnpublishedChanges: boolean;
  discarding: boolean;
  setDiscarding: Dispatch<SetStateAction<boolean>>;
  csrf: string;
  csrfRef: MutableRefObject<string>;
  refreshSessionCSRF: () => Promise<string>;
  getDraftId: () => string | null;
  abortPending: () => void;
  discardingRef: MutableRefObject<boolean>;
  applyWorkingCopy: (working: WorkingCopyResponse, fallbackEntryID: string, notice: string) => void;
  setMessage: Dispatch<SetStateAction<string>>;
};

export function useRestorePublishedVersion({ editingEntryID, hasUnpublishedChanges, discarding, setDiscarding, csrf, csrfRef, refreshSessionCSRF, getDraftId, abortPending, discardingRef, applyWorkingCopy, setMessage }: RestorePublishedVersionOptions) {
  return useCallback(async () => {
    if (!editingEntryID || !hasUnpublishedChanges || discarding) return;
    const previousDraftID = getDraftId();
    discardingRef.current = true;
    abortPending();
    setDiscarding(true);
    setMessage('正在恢复公开版本…');
    try {
      const working = await discardWorkingCopy({ api: API, entryID: editingEntryID, csrf: csrfRef.current || csrf, refreshCSRF: refreshSessionCSRF });
      if (previousDraftID) await Promise.allSettled([dbDelete(DRAFT_STORE, previousDraftID), dbDelete(QUEUE_STORE, previousDraftID)]);
      applyWorkingCopy(working, editingEntryID, '已放弃未发布修改，已恢复公开版本');
    } catch (error) {
      if (error instanceof AdminRequestError && (error.status === 401 || error.status === 403)) {
        setMessage(`恢复失败：${error.message}`);
      } else {
        setMessage(error instanceof Error ? `恢复失败：${error.message}` : '恢复失败：API 服务未响应');
      }
    } finally {
      discardingRef.current = false;
      setDiscarding(false);
    }
  }, [abortPending, applyWorkingCopy, csrf, csrfRef, discarding, discardingRef, editingEntryID, getDraftId, hasUnpublishedChanges, refreshSessionCSRF, setDiscarding, setMessage]);
}
