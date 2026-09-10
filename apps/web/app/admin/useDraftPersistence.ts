'use client';

import { useCallback, useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { dbDelete, dbPut, DRAFT_STORE, type Draft } from './editor-storage';

type DraftPersistenceOptions = {
  currentDraftId: () => string;
  getDraftId: () => string | null;
  payload: Record<string, unknown>;
  refreshDrafts: () => Promise<void>;
  setMessage: Dispatch<SetStateAction<string>>;
  epoch: MutableRefObject<number>;
  syncDraft: (draft: Draft, epoch?: number, force?: boolean) => Promise<void>;
  readMarkdown?: () => string | undefined;
  active: boolean;
};

/**
 * Persist a draft through one path for debounce, blur/interval flushes, and
 * modal close.  Keeping the IndexedDB result authoritative prevents an
 * unavailable/private-mode database from being reported as "已本地保存".
 */
export function useDraftPersistence({ currentDraftId, getDraftId, payload, refreshDrafts, setMessage, epoch, syncDraft, readMarkdown, active }: DraftPersistenceOptions) {
  const persistNow = useCallback(async (): Promise<boolean> => {
    // A newly opened writer should not create an empty card in the shared
    // draft tray merely because its debounce timer fired or the dialog closed.
    const currentMarkdown = readMarkdown?.();
    const currentPayload = typeof currentMarkdown === 'string' && currentMarkdown !== payload.markdown
      ? { ...payload, markdown: currentMarkdown }
      : payload;
    const categories = Array.isArray(currentPayload.categories) ? currentPayload.categories : [];
    const hasAuthoredContent = [currentPayload.markdown, currentPayload.title, currentPayload.summary, currentPayload.slug]
      .some(value => String(value || '').trim())
      || (Array.isArray(currentPayload.tags) && currentPayload.tags.length > 0)
      || categories.length !== 1
      || categories[0] !== '日常';
    if (!hasAuthoredContent) {
      const existingID = getDraftId();
      if (!existingID) return true;
      const expectedEpoch = epoch.current;
      const deleted = await dbDelete(DRAFT_STORE, existingID);
      if (!deleted) {
        setMessage('空草稿清理失败，旧内容仍在浏览器中；请不要关闭此窗口');
        return false;
      }
      const clearedDraft: Draft = { id: existingID, clientDraftId: existingID, payload: currentPayload, updatedAt: new Date().toISOString() };
      setMessage('空草稿已移除');
      void refreshDrafts().catch(() => setMessage('空草稿已移除，但列表刷新失败'));
      void syncDraft(clearedDraft, expectedEpoch, true).catch(() => setMessage('空草稿已在本机移除，工作草稿将稍后同步'));
      return true;
    }

    const expectedEpoch = epoch.current;
    const id = currentDraftId();
    const draft: Draft = {
      id,
      clientDraftId: id,
      payload: currentPayload,
      updatedAt: new Date().toISOString(),
    };
    const stored = await dbPut(DRAFT_STORE, draft);
    if (!stored) {
      setMessage('本地保存失败，浏览器存储不可用；请不要关闭此窗口');
      return false;
    }
    if (expectedEpoch !== epoch.current) return false;
    setMessage('已本地保存');
    void refreshDrafts().catch(() => setMessage('草稿已保存，但列表刷新失败'));
    void syncDraft(draft, expectedEpoch).catch(() => setMessage('已本地保存，工作草稿将稍后同步'));
    return true;
  }, [currentDraftId, epoch, getDraftId, payload, readMarkdown, refreshDrafts, setMessage, syncDraft]);

  // Keep a named close/visibility flush API even though it currently shares
  // the exact persistence implementation with the normal debounce path.
  const flushNow = useCallback(() => persistNow(), [persistNow]);

  useEffect(() => {
    if (!active) return undefined;
    const timer = window.setTimeout(() => { void persistNow(); }, 500);
    return () => window.clearTimeout(timer);
  }, [active, persistNow]);

  return { persistNow, flushNow };
}
