'use client';

import { useCallback, useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import type { MDXEditorMethods } from '@mdxeditor/editor';
import {
  applyWorkingCopyFields,
  EMPTY_WORKING_COPY_META,
  type WorkingCopyMeta,
  type WorkingCopyResponse,
} from './editing-working-copy';
import { useEditWorkingCopyLoader } from './useEditWorkingCopyLoader';
import type { WorkingCopyEditorBindings } from './working-copy-types';

type WorkingCopyMetadataOptions = {
  csrf: string;
  payload: Record<string, unknown>;
  applyMarkdown: (next: string) => void;
  editorRef: RefObject<MDXEditorMethods | null>;
  setMessage: Dispatch<SetStateAction<string>>;
  setDraftId: (id: string) => void;
  bindings: WorkingCopyEditorBindings;
};

export function useWorkingCopyMetadata({ csrf, payload, applyMarkdown, editorRef, setMessage, setDraftId, bindings }: WorkingCopyMetadataOptions) {
  const [editingEntryID, setEditingEntryID] = useState('');
  const [editingWorkingID, setEditingWorkingID] = useState('');
  const [editingBaseRevision, setEditingBaseRevision] = useState(0);
  const [workingCopyMeta, setWorkingCopyMeta] = useState<WorkingCopyMeta>(EMPTY_WORKING_COPY_META);
  const workingCopyReady = useRef(false);
  const { setTitle, setSummary, setSlug, setCategories, setTags, setStatus, setKind, setDate, setJournalTime } = bindings;
  const applyWorkingCopy = useCallback((working: WorkingCopyResponse, fallbackEntryID: string, notice: string) => {
    workingCopyReady.current = false;
    setEditingBaseRevision(Number(working.baseRevision || 0));
    const value = working.payload || {};
    applyMarkdown(String(value.markdown || ''));
    applyWorkingCopyFields(working, fallbackEntryID, notice, {
      setEntryID: setEditingEntryID,
      setWorkingID: setEditingWorkingID,
      setDraftId,
      setTitle,
      setSummary,
      setSlug,
      setCategories,
      setTags,
      setStatus,
      setKind,
      setDate,
      setJournalTime,
      setMeta: setWorkingCopyMeta,
      setMessage,
    });
    window.setTimeout(() => {
      workingCopyReady.current = true;
      editorRef.current?.focus();
    }, 0);
  }, [applyMarkdown, editorRef, setCategories, setDate, setDraftId, setJournalTime, setKind, setMessage, setSlug, setStatus, setSummary, setTags, setTitle]);
  const { loadingEdit } = useEditWorkingCopyLoader({ csrf, setMessage, applyWorkingCopy });

  useEffect(() => {
    if (!editingEntryID || !workingCopyReady.current) return;
    setWorkingCopyMeta(current => current.hasUnpublishedChanges
      ? current
      : { ...current, hasUnpublishedChanges: true });
  }, [editingEntryID, payload]);

  return {
    editingEntryID,
    editingWorkingID,
    editingBaseRevision,
    workingCopyMeta,
    loadingEdit,
    workingCopyReady,
    applyWorkingCopy,
    setEditingEntryID,
    setEditingWorkingID,
    setEditingBaseRevision,
    setWorkingCopyMeta,
  };
}
