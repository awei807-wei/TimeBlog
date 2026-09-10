'use client';

import { useCallback, useRef, type Dispatch, type MutableRefObject, type RefObject, type SetStateAction } from 'react';
import type { MarkdownEditorHandle } from './editor-contract';
import { useDraftAutosave } from './useDraftAutosave';
import { useWorkingCopyActions } from './useWorkingCopyActions';
import { useWorkingCopyMetadata } from './useWorkingCopyMetadata';
import type { WorkingCopyEditorBindings } from './working-copy-types';

export type { WorkingCopyEditorBindings } from './working-copy-types';

type UseAdminWorkingCopyOptions = {
  csrf: string;
  csrfRef: MutableRefObject<string>;
  refreshSessionCSRF: () => Promise<string>;
  payload: Record<string, unknown>;
  applyMarkdown: (next: string) => void;
  editorRef: RefObject<MarkdownEditorHandle | null>;
  refreshDrafts: () => Promise<void>;
  setMessage: Dispatch<SetStateAction<string>>;
  bindings: WorkingCopyEditorBindings;
  editEntryID?: string | null;
  active: boolean;
};

export function useAdminWorkingCopy({ csrf, csrfRef, refreshSessionCSRF, payload, applyMarkdown, editorRef, refreshDrafts, setMessage, bindings, editEntryID, active }: UseAdminWorkingCopyOptions) {
  const discardingRef = useRef(false);
  const readMarkdown = useCallback(() => editorRef.current?.getMarkdown(), [editorRef]);
  const autosave = useDraftAutosave({ csrf, payload, refreshDrafts, setMessage, discardingRef, readMarkdown, active });
  const metadata = useWorkingCopyMetadata({ csrf, payload, applyMarkdown, editorRef, setMessage, setDraftId: autosave.setDraftId, bindings, editEntryID });
  const actions = useWorkingCopyActions({
    csrf,
    csrfRef,
    refreshSessionCSRF,
    applyMarkdown,
    editorRef,
    setMessage,
    bindings,
    editingEntryID: metadata.editingEntryID,
    workingCopyMeta: metadata.workingCopyMeta,
    workingCopyReadyRef: metadata.workingCopyReady,
    applyWorkingCopy: metadata.applyWorkingCopy,
    setDraftId: autosave.setDraftId,
    getDraftId: autosave.getDraftId,
    abortPending: autosave.abortPending,
    finalizeSavedDraft: autosave.finalizeSavedDraft,
    discardingRef,
    setEditingEntryID: metadata.setEditingEntryID,
    setEditingWorkingID: metadata.setEditingWorkingID,
    setEditingBaseRevision: metadata.setEditingBaseRevision,
    setWorkingCopyMeta: metadata.setWorkingCopyMeta,
  });

  return {
    currentDraftId: autosave.currentDraftId,
    persistNow: autosave.persistNow,
    flushNow: autosave.flushNow,
    editingEntryID: metadata.editingEntryID,
    editingWorkingID: metadata.editingWorkingID,
    editingBaseRevision: metadata.editingBaseRevision,
    loadingEdit: metadata.loadingEdit,
    workingCopyMeta: metadata.workingCopyMeta,
    ...actions,
  };
}
