'use client';

import { useCallback, type RefObject, type SetStateAction, type Dispatch } from 'react';
import type { MDXEditorMethods } from '@mdxeditor/editor';
import { readTaxonomy, type EditorStatusValue } from './editing-working-copy';
import type { Draft } from './editor-storage';
import { readJournalTimeField, type JournalTimeValue } from './journal-time-payload';

type LoadDraftOptions = {
  applyMarkdown: (next: string) => void;
  editorRef: RefObject<MDXEditorMethods | null>;
  setDraftId: (id: string) => void;
  clearEntry: () => void;
  setTitle: (value: string) => void;
  setSummary: (value: string) => void;
  setSlug: (value: string) => void;
  setCategories: (value: string[]) => void;
  setTags: (value: string[]) => void;
  setStatus: Dispatch<SetStateAction<EditorStatusValue>>;
  setKind: (value: string) => void;
  setDate: (value: string) => void;
  setJournalTime: Dispatch<SetStateAction<JournalTimeValue>>;
  setMessage: (value: string) => void;
};

export function useLoadDraft({ applyMarkdown, editorRef, setDraftId, clearEntry, setTitle, setSummary, setSlug, setCategories, setTags, setStatus, setKind, setDate, setJournalTime, setMessage }: LoadDraftOptions) {
  return useCallback((draft: Draft) => {
    clearEntry();
    setDraftId(draft.clientDraftId);
    const value = draft.payload;
    applyMarkdown(String(value.markdown || ''));
    setTitle(String(value.title || ''));
    setSummary(String(value.summary || ''));
    setSlug(String(value.slug || ''));
    setCategories(readTaxonomy(value.categories, /,/));
    setTags(readTaxonomy(value.tags, /[,\s]+/, true));
    setStatus(value.visibility === 'private' || value.status === 'private' ? 'private' : value.status === 'published' ? 'public' : 'draft');
    setKind(String(value.kind || 'note'));
    setDate(String(value.journalDate || ''));
    setJournalTime(readJournalTimeField(value));
    setMessage('已载入草稿');
    editorRef.current?.focus();
  }, [applyMarkdown, clearEntry, editorRef, setCategories, setDate, setDraftId, setJournalTime, setKind, setMessage, setSlug, setStatus, setSummary, setTags, setTitle]);
}
