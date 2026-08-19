'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MDXEditorMethods } from '@mdxeditor/editor';
import { serializeEditorStatus } from '@/lib/editor-utils';
import { withJournalTimeField, type JournalTimeValue } from './journal-time-payload';
import { prepareMarkdownForMdxEditor, restoreMarkdownFromMdxEditor } from './mdx-compat';

export type EditorStatus = 'draft' | 'public' | 'private';

export function useAdminEditorState() {
  const editorRef = useRef<MDXEditorMethods>(null);
  const markdownRef = useRef('');
  const [markdown, setMarkdown] = useState('');
  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [categories, setCategories] = useState<string[]>(['日常']);
  const [tags, setTags] = useState<string[]>([]);
  const [status, setStatus] = useState<EditorStatus>('draft');
  const [kind, setKind] = useState('note');
  const [date, setDate] = useState(new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }));
  const [journalTime, setJournalTime] = useState<JournalTimeValue>(null);
  const [slug, setSlug] = useState('');

  useEffect(() => {
    markdownRef.current = markdown;
  }, [markdown]);

  const payload = useMemo(() => withJournalTimeField({ markdown, title, summary, slug, categories, tags, ...serializeEditorStatus(status), kind, journalDate: date }, journalTime), [markdown, title, summary, slug, categories, tags, status, kind, date, journalTime]);
  const applyMarkdown = useCallback((next: string) => {
    const restored = restoreMarkdownFromMdxEditor(next, prepareMarkdownForMdxEditor(markdownRef.current).replacements);
    markdownRef.current = restored;
    setMarkdown(restored);
  }, []);
  const setMarkdownRef = useCallback((next: string) => {
    markdownRef.current = next;
  }, []);
  return { editorRef, markdownRef, setMarkdownRef, markdown, setMarkdown, title, setTitle, summary, setSummary, categories, setCategories, tags, setTags, status, setStatus, kind, setKind, date, setDate, journalTime, setJournalTime, slug, setSlug, payload, applyMarkdown };
}
