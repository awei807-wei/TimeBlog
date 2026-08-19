'use client';

import type { Dispatch, SetStateAction } from 'react';
import { useAdminComposerMedia } from './useAdminComposerMedia';
import { useAdminEditorState } from './useAdminEditorState';
import { useAdminSession } from './useAdminSession';
import { useDraftTray } from './DraftTray';
import { useAdminWorkingCopy } from './useAdminWorkingCopy';

export function useAdminEditorInfrastructure(setMessage: Dispatch<SetStateAction<string>>) {
  const session = useAdminSession();
  const editor = useAdminEditorState();
  const media = useAdminComposerMedia({
    editorRef: editor.editorRef,
    markdownRef: editor.markdownRef,
    csrfRef: session.csrfRef,
    csrf: session.csrf,
    status: editor.status,
    refreshSessionCSRF: session.refreshSessionCSRF,
    applyMarkdown: editor.applyMarkdown,
    setMessage,
  });
  const drafts = useDraftTray(setMessage);
  const working = useAdminWorkingCopy({
    csrf: session.csrf,
    csrfRef: session.csrfRef,
    refreshSessionCSRF: session.refreshSessionCSRF,
    payload: editor.payload,
    applyMarkdown: editor.applyMarkdown,
    editorRef: editor.editorRef,
    refreshDrafts: drafts.refreshDrafts,
    setMessage,
    bindings: {
      setTitle: editor.setTitle,
      setSummary: editor.setSummary,
      setSlug: editor.setSlug,
      setCategories: editor.setCategories,
      setTags: editor.setTags,
      setStatus: editor.setStatus,
      setKind: editor.setKind,
      setDate: editor.setDate,
      setJournalTime: editor.setJournalTime,
    },
  });
  return { session, editor, media, drafts, working };
}
