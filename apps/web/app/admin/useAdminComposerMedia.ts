'use client';

import { useCallback, useEffect, useState, type MutableRefObject, type SetStateAction, type Dispatch, type RefObject } from 'react';
import type { MDXEditorMethods } from '@mdxeditor/editor';
import { responseError } from './admin-errors';
import { useAdminMediaCapability } from './useAdminMediaCapability';
import { useMediaUploads, type MediaCapability } from './useMediaUploads';
import type { MdxEditorViewMode } from './MdxMarkdownEditor';

type ComposerMediaOptions = {
  editorRef: RefObject<MDXEditorMethods | null>;
  markdownRef: MutableRefObject<string>;
  csrfRef: MutableRefObject<string>;
  csrf: string;
  status: 'draft' | 'public' | 'private';
  refreshSessionCSRF: () => Promise<string>;
  applyMarkdown: (next: string) => void;
  setMessage: Dispatch<SetStateAction<string>>;
};

export function useAdminComposerMedia({ editorRef, markdownRef, csrfRef, csrf, status, refreshSessionCSRF, applyMarkdown, setMessage }: ComposerMediaOptions) {
  const [uploadPanelOpen, setUploadPanelOpen] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const { online, editorReady, editorViewMode, mediaCapability, setEditorReady, setEditorViewMode } = useAdminMediaCapability(refreshSessionCSRF);
  const canInsertMedia = editorViewMode === 'rich-text';
  const handleEditorViewModeChange = useCallback((viewMode: MdxEditorViewMode) => {
    setEditorViewMode(viewMode);
    if (viewMode !== 'rich-text') setUploadPanelOpen(false);
  }, [setEditorViewMode]);
  const insertMediaReference = useCallback((reference: string) => {
    const editor = editorRef.current;
    if (!editor) {
      const error = '编辑器正在加载，请稍后再试';
      setMessage(error);
      throw new Error(error);
    }
    editor.focus();
    editor.insertMarkdown(`\n${reference}\n`);
    return reference;
  }, [editorRef, setMessage]);
  const { recoverUploads, ...uploads } = useMediaUploads({ editorRef, markdownRef, csrfRef, csrf, status, mediaCapability, refreshSessionCSRF, insertMediaReference, applyMarkdown, responseError, onMessage: setMessage });

  useEffect(() => {
    if (!mediaCapability.checked || !editorReady) return;
    const timer = window.setTimeout(() => { void recoverUploads(); }, 0);
    return () => window.clearTimeout(timer);
  }, [editorReady, mediaCapability.checked, recoverUploads]);

  return { online, editorReady, setEditorReady, editorViewMode, canInsertMedia, handleEditorViewModeChange, mediaCapability, uploadPanelOpen, setUploadPanelOpen, dragActive, setDragActive, recoverUploads, ...uploads };
}
