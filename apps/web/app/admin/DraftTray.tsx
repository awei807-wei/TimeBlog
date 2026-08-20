'use client';

import { ChevronDown, ChevronUp } from 'lucide-react';
import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { dbDelete, dbGetAll, DRAFT_STORE, type Draft } from './editor-storage';

export const MAX_DRAFTS = 20;

function draftName(draft: Draft) {
  const title = String(draft.payload.title || '').trim();
  if (title) return title.slice(0, 42);
  const text = cleanMarkdown(String(draft.payload.markdown || ''));
  return text ? text.slice(0, 34) : '未命名草稿';
}

function cleanMarkdown(value: string) {
  return value
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '[图片]')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/media:\/\/\S+/g, '[附件]')
    .replace(/[#>*_~`|-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function draftExcerpt(draft: Draft) {
  const text = cleanMarkdown(String(draft.payload.markdown || ''));
  return text ? text.slice(0, 72) : '还没有写下内容';
}

function draftKind(draft: Draft) {
  return draft.payload.kind === 'article' ? '文章' : '随记';
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
  const [expanded, setExpanded] = useState(false);
  const visibleDrafts = expanded ? drafts : drafts.slice(0, 6);
  return (
    <section className="writing-drafts">
      <header>
        <div><h2>最近草稿</h2><span>{drafts.length} 份保存在本机</span></div>
      </header>
      {drafts.length ? (
        <>
          <ul className="draft-list">
            {visibleDrafts.map(draft => (
              <li key={draft.id}>
                <button type="button" onClick={() => onLoadDraft(draft)}>
                  <span className="draft-card-meta"><b>{draftKind(draft)}</b><time>{new Date(draft.updatedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time></span>
                  <strong>{draftName(draft)}</strong>
                  <small>{draftExcerpt(draft)}</small>
                </button>
              </li>
            ))}
          </ul>
          {drafts.length > 6 && (
            <button type="button" className="draft-expand" onClick={() => setExpanded(value => !value)}>
              {expanded ? <><ChevronUp aria-hidden="true" />收起草稿</> : <><ChevronDown aria-hidden="true" />查看其余 {drafts.length - 6} 份</>}
            </button>
          )}
        </>
      ) : <p className="draft-empty">停止输入后会自动保存。你可以放心离开，再从这里继续。</p>}
    </section>
  );
}
