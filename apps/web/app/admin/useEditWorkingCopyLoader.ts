'use client';

import { useEffect, useRef, useState } from 'react';
import { API } from '@/lib/api';
import type { WorkingCopyResponse } from './editing-working-copy';

type EditWorkingCopyLoaderOptions = {
  csrf: string;
  setMessage: (message: string) => void;
  applyWorkingCopy: (working: WorkingCopyResponse, fallbackEntryID: string, notice: string) => void;
  /**
   * `undefined` keeps the admin page's URL-driven edit behavior.  An explicit
   * empty string or `null` is an intentional "new entry" target; this is used
   * by the home quick-writer so a stale `?edit=` can never leak into it.
   */
  editEntryID?: string | null;
};

async function requestWorkingCopy(entryID: string, csrf: string) {
  const response = await fetch(`${API}/admin/entries/${encodeURIComponent(entryID)}/edit`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'X-CSRF-Token': csrf,
      'Idempotency-Key': `edit-${entryID}`,
    },
  });
  if (!response.ok) throw new Error(String(response.status));
  return response.json() as Promise<WorkingCopyResponse>;
}

export function useEditWorkingCopyLoader({ csrf, setMessage, applyWorkingCopy, editEntryID }: EditWorkingCopyLoaderOptions) {
  const [requestedEditID, setRequestedEditID] = useState('');
  const [loadingEdit, setLoadingEdit] = useState(false);
  const editRequested = useRef(false);

  useEffect(() => {
    const id = editEntryID === undefined
      ? new URLSearchParams(window.location.search).get('edit') || ''
      : editEntryID?.trim() || '';
    editRequested.current = false;
    const timer = window.setTimeout(() => setRequestedEditID(id), 0);
    return () => window.clearTimeout(timer);
  }, [editEntryID]);

  useEffect(() => {
    if (!requestedEditID || !csrf || editRequested.current) return;
    editRequested.current = true;
    let cancelled = false;
    setLoadingEdit(true);
    setMessage('正在载入内容…');
    void requestWorkingCopy(requestedEditID, csrf).then(working => {
      if (cancelled) return;
      const notice = working.hasUnpublishedChanges
        ? '已载入未发布草稿，可继续编辑或恢复公开版本'
        : '已载入内容，可直接编辑后保存';
      applyWorkingCopy(working, requestedEditID, notice);
    }).catch(error => {
      if (cancelled) return;
      setMessage(error instanceof Error && error.message === '404'
        ? '内容不存在或已被删除'
        : '载入内容失败，请检查登录状态或网络');
    }).finally(() => {
      if (!cancelled) setLoadingEdit(false);
    });
    return () => {
      cancelled = true;
    };
  }, [applyWorkingCopy, csrf, requestedEditID, setMessage]);

  return { loadingEdit, requestedEditID };
}
