'use client';

import { useState, type Dispatch, type MutableRefObject, type RefObject, type SetStateAction } from 'react';
import type { MDXEditorMethods } from '@mdxeditor/editor';
import type { UploadItem } from '@/lib/media-utils';
import type { JournalTimeValue } from './journal-time-payload';
import { useAdminSaveAction } from './useAdminSaveAction';
import { useAdminUndoAction } from './useAdminUndoAction';

export type EntryActionOptions = {
  editorRef: RefObject<MDXEditorMethods | null>;
  setMarkdownRef: (value: string) => void;
  markdown: string;
  payload: Record<string, unknown>;
  uploads: UploadItem[];
  csrf: string;
  csrfRef: MutableRefObject<string>;
  refreshSessionCSRF: () => Promise<string>;
  currentDraftId: () => string;
  finalizeSavedDraft: (id: string) => Promise<void>;
  refreshDrafts: () => Promise<void>;
  applyMarkdown: (next: string) => void;
  clearWorkingCopyState: () => void;
  editingEntryID: string;
  editingWorkingID: string;
  editingBaseRevision: number;
  date: string;
  setTitle: Dispatch<SetStateAction<string>>;
  setSummary: Dispatch<SetStateAction<string>>;
  setSlug: Dispatch<SetStateAction<string>>;
  setCategories: Dispatch<SetStateAction<string[]>>;
  setTags: Dispatch<SetStateAction<string[]>>;
  setKind: Dispatch<SetStateAction<string>>;
  setStatus: Dispatch<SetStateAction<'draft' | 'public' | 'private'>>;
  setDate: Dispatch<SetStateAction<string>>;
  setJournalTime: Dispatch<SetStateAction<JournalTimeValue>>;
  setMessage: Dispatch<SetStateAction<string>>;
};

export function useAdminEntryActions(options: EntryActionOptions) {
  const [undoToken, setUndoToken] = useState('');
  const { saving, save } = useAdminSaveAction(options, setUndoToken);
  const undo = useAdminUndoAction(options, undoToken, setUndoToken);
  return { saving, undoToken, save, undo };
}
