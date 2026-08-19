'use client';

import { useCallback, type Dispatch, type SetStateAction } from 'react';
import { useRouter } from 'next/navigation';
import { API } from '@/lib/api';
import { invalidatePublicCaches } from '@/lib/cache-invalidation';
import { readTaxonomy } from './editing-working-copy';
import type { EntryActionOptions } from './useAdminEntryActions';

export function useAdminUndoAction(options: EntryActionOptions, undoToken: string, setUndoToken: Dispatch<SetStateAction<string>>) {
  const router = useRouter();
  return useCallback(async () => {
    if (!undoToken || !options.csrf) return;
    const response = await fetch(`${API}/admin/undo/${undoToken}`, { method: 'POST', credentials: 'include', headers: { 'X-CSRF-Token': options.csrf, 'Idempotency-Key': undoToken } });
    if (!response.ok) return options.setMessage('撤销窗口已过期');
    const body = await response.json();
    await invalidatePublicCaches({ entryId: body.entry?.id, slug: body.entry?.slug, reason: 'undo' });
    router.refresh();
    options.applyMarkdown(body.entry?.markdown || '');
    options.setTitle(body.entry?.title || '');
    options.setSummary(body.entry?.summary || '');
    options.setCategories(readTaxonomy(body.entry?.categories, /,/));
    options.setTags(readTaxonomy(body.entry?.tags, /[,\s]+/, true));
    options.setDate(body.entry?.journalDate || options.date);
    options.setJournalTime(typeof body.entry?.journalTime === 'string' ? body.entry.journalTime : null);
    options.setKind(body.entry?.kind || 'note');
    options.setStatus('draft');
    options.clearWorkingCopyState();
    setUndoToken('');
    options.setMessage('已撤销并回填编辑器');
    options.editorRef.current?.focus();
  }, [options, router, setUndoToken, undoToken]);
}
