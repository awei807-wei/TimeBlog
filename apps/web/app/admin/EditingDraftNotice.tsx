'use client';

import Link from 'next/link';
import { AlertCircle, LoaderCircle } from 'lucide-react';
import { normalizeArticleIdentifier } from '@/lib/api';
import type { WorkingCopyMeta } from './editing-working-copy';

type EditingDraftNoticeProps = {
  visible: boolean;
  articleIdentifier: string;
  meta: WorkingCopyMeta;
  discarding: boolean;
  onDiscard: () => void;
};

function formatPublishedAt(value: string) {
  if (!value) return '';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString('zh-CN', { dateStyle: 'medium', timeStyle: 'short' });
}

export default function EditingDraftNotice({ visible, articleIdentifier, meta, discarding, onDiscard }: EditingDraftNoticeProps) {
  if (!visible) return null;
  const publishedAt = formatPublishedAt(meta.publishedUpdatedAt);
  const publicIdentifier = normalizeArticleIdentifier(meta.publishedSlug) || articleIdentifier;
  const confirmDiscard = () => {
    if (window.confirm('确定放弃未发布修改并恢复公开版本吗？当前编辑草稿将被删除。')) onDiscard();
  };
  return <section className={`working-copy-notice${meta.hasUnpublishedChanges ? ' is-unpublished' : ''}`} role={meta.hasUnpublishedChanges ? 'alert' : 'status'} aria-live="polite">
    <div className="working-copy-notice-copy">
      <strong>{meta.hasUnpublishedChanges ? <><AlertCircle aria-hidden="true" />存在未发布修改</> : '公开文章编辑'}</strong>
      <p>{meta.hasUnpublishedChanges ? '自动保存的是未发布草稿，公开页仍显示上次保存版本。' : '自动保存的是未发布草稿；正式版本只有保存提交后才会更新。'}</p>
      {(publishedAt || meta.publishedRevision > 0) && <div className="working-copy-meta">{publishedAt && <time dateTime={meta.publishedUpdatedAt}>公开版本更新于 {publishedAt}</time>}{meta.publishedRevision > 0 && <span>正式版本 r{meta.publishedRevision}</span>}</div>}
    </div>
    {meta.hasUnpublishedChanges && <div className="working-copy-actions"><Link className="secondary" href={`/article/${encodeURIComponent(publicIdentifier)}`} target="_blank" rel="noreferrer">查看公开版本</Link><button type="button" className="secondary danger-action" disabled={discarding} onClick={confirmDiscard}>{discarding ? <><LoaderCircle className="spin" aria-hidden="true" />恢复中…</> : '放弃未发布修改并恢复公开版本'}</button></div>}
  </section>;
}
