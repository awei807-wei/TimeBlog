'use client';

import type { Dispatch, SetStateAction } from 'react';
import { useAdminEditorInfrastructure } from './useAdminEditorInfrastructure';
import { useAdminEntryActions } from './useAdminEntryActions';

type Infrastructure = ReturnType<typeof useAdminEditorInfrastructure>;

export function useAdminPageEntryActions(infrastructure: Infrastructure, setMessage: Dispatch<SetStateAction<string>>) {
  const { session, editor, media, drafts, working } = infrastructure;
  return useAdminEntryActions({
    editorRef: editor.editorRef,
    setMarkdownRef: editor.setMarkdownRef,
    markdown: editor.markdown,
    payload: editor.payload,
    uploads: media.uploads,
    csrf: session.csrf,
    csrfRef: session.csrfRef,
    refreshSessionCSRF: session.refreshSessionCSRF,
    currentDraftId: working.currentDraftId,
    finalizeSavedDraft: working.finalizeSavedDraft,
    refreshDrafts: drafts.refreshDrafts,
    applyMarkdown: editor.applyMarkdown,
    clearWorkingCopyState: working.clearWorkingCopyState,
    editingEntryID: working.editingEntryID,
    editingWorkingID: working.editingWorkingID,
    editingBaseRevision: working.editingBaseRevision,
    date: editor.date,
    setTitle: editor.setTitle,
    setSummary: editor.setSummary,
    setSlug: editor.setSlug,
    setCategories: editor.setCategories,
    setTags: editor.setTags,
    setKind: editor.setKind,
    setStatus: editor.setStatus,
    setDate: editor.setDate,
    setJournalTime: editor.setJournalTime,
    setMessage,
  });
}
