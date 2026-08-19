'use client';

import { useCallback, useState, type Dispatch, type SetStateAction } from 'react';
import { useRouter } from 'next/navigation';
import { invalidatePublicCaches } from '@/lib/cache-invalidation';
import { AdminRequestError } from './admin-errors';
import { prepareMarkdownForMdxEditor, restoreMarkdownFromMdxEditor } from './mdx-compat';
import { persistAdminEntry } from './admin-entry-actions';
import type { EntryActionOptions } from './useAdminEntryActions';

export function useAdminSaveAction(options: EntryActionOptions, setUndoToken: Dispatch<SetStateAction<string>>) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const save = useCallback(async () => {
    const editorMarkdown = options.editorRef.current?.getMarkdown() ?? options.markdown;
    const effectiveMarkdown = restoreMarkdownFromMdxEditor(editorMarkdown, prepareMarkdownForMdxEditor(options.markdown).replacements);
    options.setMarkdownRef(effectiveMarkdown);
    const mediaBusy = options.uploads.some(item => item.status === 'queued' || item.status === 'uploading');
    const temporaryMedia = options.uploads.some(item => effectiveMarkdown.includes(`media://${item.id}`));
    if (mediaBusy || temporaryMedia) return options.setMessage('附件仍在上传，请完成后再保存');
    const savePayload = { ...options.payload, markdown: effectiveMarkdown, ...(options.editingBaseRevision > 0 ? { baseRevision: options.editingBaseRevision } : {}) };
    const sessionCsrf = options.csrfRef.current || options.csrf;
    if (!effectiveMarkdown.trim() || !sessionCsrf) return options.setMessage(effectiveMarkdown.trim() ? '登录状态未确认，请刷新后重试' : '请输入正文');
    setSaving(true);
    options.setMessage('保存中…');
    try {
      const savedDraftID = options.currentDraftId();
      const result = await persistAdminEntry({ csrf: sessionCsrf, refreshSessionCSRF: options.refreshSessionCSRF, savedDraftID, editingWorkingID: options.editingWorkingID, payload: savePayload });
      await options.finalizeSavedDraft(savedDraftID);
      await invalidatePublicCaches({ entryId: options.editingEntryID || result.entry?.id, slug: String((savePayload as { slug?: unknown }).slug || ''), reason: 'edit' });
      router.refresh();
      setUndoToken(result.undoToken || '');
      if (options.editingEntryID) {
        options.setMessage('已更新内容');
        router.push('/admin/entries');
      } else {
        options.applyMarkdown('');
        options.clearWorkingCopyState();
        options.setTitle('');
        options.setSummary('');
        options.setSlug('');
        options.setJournalTime(null);
        options.setMessage('已保存，15 秒内可撤销');
        options.editorRef.current?.focus();
      }
      await options.refreshDrafts();
    } catch (error) {
      if (error instanceof AdminRequestError && error.status === 409) options.setMessage('保存失败：内容已被其他位置修改，请重新载入后合并');
      else if (error instanceof AdminRequestError && (error.status === 401 || error.status === 403)) options.setMessage(`保存失败：${error.message}`);
      else options.setMessage(error instanceof Error ? `保存失败：${error.message}` : '保存失败：API 服务未响应');
    } finally {
      setSaving(false);
    }
  }, [options, router, setUndoToken]);
  return { saving, save };
}
