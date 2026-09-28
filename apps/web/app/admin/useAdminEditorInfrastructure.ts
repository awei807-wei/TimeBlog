'use client';

import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { getAdminTaxonomy } from '@/lib/api';
import { useAdminComposerMedia } from './useAdminComposerMedia';
import { useAdminEditorState } from './useAdminEditorState';
import { useAdminSession } from './useAdminSession';
import { useDraftTray } from './DraftTray';
import { useAdminWorkingCopy } from './useAdminWorkingCopy';

export type AdminEditorInfrastructureOptions = {
  /** See useEditWorkingCopyLoader: undefined is URL-driven, null is new content. */
  editEntryID?: string | null;
  active?: boolean;
};

export function useAdminEditorInfrastructure(setMessage: Dispatch<SetStateAction<string>>, { editEntryID, active = true }: AdminEditorInfrastructureOptions = {}) {
  const session = useAdminSession();
  const editor = useAdminEditorState();
  const [taxonomySuggestions, setTaxonomySuggestions] = useState<{ categories: string[]; tags: string[] }>({ categories: [], tags: [] });
  useEffect(() => {
    if (!active) return undefined;
    let disposed = false;
    void getAdminTaxonomy().then(({ categories, tags }) => {
      if (disposed) return;
      setTaxonomySuggestions({
        categories: categories.map(category => category.name),
        tags: tags.map(tag => tag.displayName),
      });
    }).catch(() => {
      // 历史值加载失败时保留自由输入，离线或会话失效不应阻断写作。
    });
    return () => {
      disposed = true;
    };
  }, [active]);
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
    editEntryID,
    active,
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
  return { session, editor, media, drafts, working, taxonomySuggestions };
}
