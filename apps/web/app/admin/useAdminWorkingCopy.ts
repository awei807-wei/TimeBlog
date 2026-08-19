'use client';

import { useRef, type Dispatch, type MutableRefObject, type RefObject, type SetStateAction } from 'react';
import type { MDXEditorMethods } from '@mdxeditor/editor';
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
  editorRef: RefObject<MDXEditorMethods | null>;
  refreshDrafts: () => Promise<void>;
  setMessage: Dispatch<SetStateAction<string>>;
  bindings: WorkingCopyEditorBindings;
};

export function useAdminWorkingCopy({ csrf, csrfRef, refreshSessionCSRF, payload, applyMarkdown, editorRef, refreshDrafts, setMessage, bindings }: UseAdminWorkingCopyOptions) {
  const discardingRef = useRef(false);
  const autosave = useDraftAutosave({ csrf, payload, refreshDrafts, setMessage, discardingRef });
  const metadata = useWorkingCopyMetadata({ csrf, payload, applyMarkdown, editorRef, setMessage, setDraftId: autosave.setDraftId, bindings });
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
    editingEntryID: metadata.editingEntryID,
    editingWorkingID: metadata.editingWorkingID,
    editingBaseRevision: metadata.editingBaseRevision,
    loadingEdit: metadata.loadingEdit,
    workingCopyMeta: metadata.workingCopyMeta,
    ...actions,
  };
}
