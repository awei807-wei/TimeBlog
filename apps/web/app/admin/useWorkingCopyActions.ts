'use client';

import { useCallback, useState, type Dispatch, type MutableRefObject, type RefObject, type SetStateAction } from 'react';
import type { MDXEditorMethods } from '@mdxeditor/editor';
import { EMPTY_WORKING_COPY_META, type WorkingCopyMeta, type WorkingCopyResponse } from './editing-working-copy';
import type { Draft } from './editor-storage';
import { useLoadDraft } from './useLoadDraft';
import { useRestorePublishedVersion } from './useRestorePublishedVersion';
import type { WorkingCopyEditorBindings } from './working-copy-types';

type WorkingCopyActionsOptions = {
  csrf: string;
  csrfRef: MutableRefObject<string>;
  refreshSessionCSRF: () => Promise<string>;
  applyMarkdown: (next: string) => void;
  editorRef: RefObject<MDXEditorMethods | null>;
  setMessage: Dispatch<SetStateAction<string>>;
  bindings: WorkingCopyEditorBindings;
  editingEntryID: string;
  workingCopyMeta: WorkingCopyMeta;
  workingCopyReadyRef: MutableRefObject<boolean>;
  applyWorkingCopy: (working: WorkingCopyResponse, fallbackEntryID: string, notice: string) => void;
  setDraftId: (id: string) => void;
  getDraftId: () => string | null;
  abortPending: () => void;
  finalizeSavedDraft: (id: string) => Promise<void>;
  discardingRef: MutableRefObject<boolean>;
  setEditingEntryID: (value: string) => void;
  setEditingWorkingID: (value: string) => void;
  setEditingBaseRevision: (value: number) => void;
  setWorkingCopyMeta: Dispatch<SetStateAction<WorkingCopyMeta>>;
};

export function useWorkingCopyActions(options: WorkingCopyActionsOptions) {
  const { csrf, csrfRef, refreshSessionCSRF, applyMarkdown, editorRef, setMessage, bindings, editingEntryID, workingCopyMeta, workingCopyReadyRef, applyWorkingCopy, setDraftId, getDraftId, abortPending, finalizeSavedDraft: finalizeAutosave, discardingRef, setEditingEntryID, setEditingWorkingID, setEditingBaseRevision, setWorkingCopyMeta } = options;
  const [discardingUnpublishedChanges, setDiscardingUnpublishedChanges] = useState(false);
  const restorePublishedVersion = useRestorePublishedVersion({
    editingEntryID,
    hasUnpublishedChanges: workingCopyMeta.hasUnpublishedChanges,
    discarding: discardingUnpublishedChanges,
    setDiscarding: setDiscardingUnpublishedChanges,
    csrf,
    csrfRef,
    refreshSessionCSRF,
    getDraftId,
    abortPending,
    discardingRef,
    applyWorkingCopy,
    setMessage,
  });
  const clearEntry = useCallback(() => {
    workingCopyReadyRef.current = false;
    setDraftId('');
    setEditingEntryID('');
    setEditingWorkingID('');
    setEditingBaseRevision(0);
    setWorkingCopyMeta(EMPTY_WORKING_COPY_META);
  }, [setDraftId, setEditingBaseRevision, setEditingEntryID, setEditingWorkingID, setWorkingCopyMeta, workingCopyReadyRef]);
  const loadDraft = useLoadDraft({ applyMarkdown, editorRef, setDraftId, clearEntry, ...bindings, setMessage });
  const finalizeSavedDraft = useCallback(async (savedDraftID: string) => {
    await finalizeAutosave(savedDraftID);
    workingCopyReadyRef.current = false;
    setWorkingCopyMeta(EMPTY_WORKING_COPY_META);
  }, [finalizeAutosave, setWorkingCopyMeta, workingCopyReadyRef]);
  const clearWorkingCopyState = useCallback(() => {
    workingCopyReadyRef.current = false;
    setWorkingCopyMeta(EMPTY_WORKING_COPY_META);
  }, [setWorkingCopyMeta, workingCopyReadyRef]);
  return { discardingUnpublishedChanges, restorePublishedVersion, finalizeSavedDraft, loadDraft, clearWorkingCopyState };
}
