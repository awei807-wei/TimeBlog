'use client';

import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { dbDelete, dbGetAll, DRAFT_STORE, type Draft } from './editor-storage';

export const MAX_DRAFTS = 20;

function draftName(draft: Draft) {
  const text = String(draft.payload.markdown || '').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, 34) : '未命名草稿';
}

export function useDraftTray(onMessage: Dispatch<SetStateAction<string>>) {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const refreshDrafts = useCallback(async () => {
    const values = await dbGetAll<Draft>(DRAFT_STORE);
    const ordered = values.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id));
    const stale = ordered.slice(MAX_DRAFTS);
    setDrafts(ordered.slice(0, MAX_DRAFTS));
    if (stale.length > 0) {
      void Promise.all(stale.map(async draft => ({ draft, deleted: await dbDelete(DRAFT_STORE, draft.id) }))).then(results => {
        const failed = results.filter(result => !result.deleted).length;
        if (failed > 0) onMessage(`草稿托盘已限制为 ${MAX_DRAFTS} 条，仍有 ${failed} 条旧草稿待清理`);
      });
    }
  }, [onMessage]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void refreshDrafts(); }, 0);
    return () => window.clearTimeout(timer);
  }, [refreshDrafts]);

  return { drafts, refreshDrafts };
}

interface DraftTrayProps {
  drafts: Draft[];
  onLoadDraft: (draft: Draft) => void;
}

export default function DraftTray({ drafts, onLoadDraft }: DraftTrayProps) {
  return <div className="side-card"><div className="side-card-heading"><h3>草稿托盘（{drafts.length}）</h3></div>{drafts.length ? <ul className="draft-list">{drafts.map(d => <li key={d.id}><button type="button" onClick={() => onLoadDraft(d)}><strong>{draftName(d)}</strong><small>{new Date(d.updatedAt).toLocaleString('zh-CN')}</small></button></li>)}</ul> : <p>停止输入后自动保存。你可以同时保留多份未命名草稿。</p>}</div>;
}
