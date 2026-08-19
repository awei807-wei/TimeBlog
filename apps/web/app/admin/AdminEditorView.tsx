'use client';

import type { DragEvent, RefObject } from 'react';
import type { MDXEditorMethods } from '@mdxeditor/editor';
import { AlertCircle, Check, LoaderCircle, Paperclip, Trash2, X } from 'lucide-react';
import Link from 'next/link';
import type { UploadItem } from '@/lib/media-utils';
import AttachmentPreview from './AttachmentPreview';
import DraftTray from './DraftTray';
import EditingDraftNotice from './EditingDraftNotice';
import JournalDatePicker from './JournalDatePicker';
import MdxMarkdownEditor, { type MdxEditorViewMode } from './MdxMarkdownEditor';
import TagInput from './TagInput';
import UploadPanel from './UploadPanel';
import type { Draft } from './editor-storage';
import type { WorkingCopyMeta } from './editing-working-copy';

type EditorStatus = 'draft' | 'public' | 'private';

export type AdminEditorViewProps = {
  online: boolean;
  editingEntryID: string;
  title: string;
  summary: string;
  slug: string;
  kind: string;
  status: EditorStatus;
  categories: string[];
  tags: string[];
  date: string;
  markdown: string;
  message: string;
  saving: boolean;
  loadingEdit: boolean;
  undoToken: string;
  uploadPanelOpen: boolean;
  dragActive: boolean;
  mediaInputDisabled: boolean;
  mediaAvailabilityMessage: string;
  mediaStillProcessing: boolean;
  workingCopyMeta: WorkingCopyMeta;
  discardingUnpublishedChanges: boolean;
  drafts: Draft[];
  uploads: UploadItem[];
  editorRef: RefObject<MDXEditorMethods | null>;
  onToggleUploadPanel: () => void;
  onDiscardWorkingCopy: () => void;
  onTitleChange: (value: string) => void;
  onSummaryChange: (value: string) => void;
  onSlugChange: (value: string) => void;
  onMarkdownChange: (value: string) => void;
  onFiles: (files: File[]) => void;
  onImageUpload: (file: File) => Promise<string>;
  onEditorError: (message: string) => void;
  onEditorNotice: (message: string) => void;
  onEditorReady: (ready: boolean) => void;
  onViewModeChange: (mode: MdxEditorViewMode) => void;
  onDragEnter: (event: DragEvent<HTMLDivElement>) => void;
  onDragOver: (event: DragEvent<HTMLDivElement>) => void;
  onDragLeave: (event: DragEvent<HTMLDivElement>) => void;
  onDrop: (event: DragEvent<HTMLDivElement>) => void;
  onCancelUpload: (item: UploadItem) => void;
  onRetryUpload: (item: UploadItem, file: File) => Promise<void>;
  onRemoveUpload: (item: UploadItem) => void;
  onDateChange: (value: string) => void;
  onKindChange: (value: string) => void;
  onStatusChange: (value: EditorStatus) => void;
  onCategoriesChange: (value: string[]) => void;
  onTagsChange: (value: string[]) => void;
  onSave: () => void;
  onUndo: () => void;
  onLoadDraft: (draft: Draft) => void;
};

function EditorToolbar({ uploadPanelOpen, mediaInputDisabled, mediaAvailabilityMessage, onToggleUploadPanel }: AdminEditorViewProps) {
  return (
    <>
      <div className="editor-toolbar editor-toolbar-actions" aria-label="编辑工具">
        <span className="editor-toolbar-label">Markdown 编辑器</span>
        <button
          type="button"
          className={`tool upload-control${uploadPanelOpen ? ' active' : ''}${mediaInputDisabled ? ' upload-disabled' : ''}`}
          aria-label="添加媒体"
          aria-disabled={mediaInputDisabled}
          aria-expanded={uploadPanelOpen}
          disabled={mediaInputDisabled}
          title={mediaInputDisabled ? mediaAvailabilityMessage : '上传图片、音频、视频或 PDF'}
          onClick={onToggleUploadPanel}
        >
          <Paperclip aria-hidden="true" />
          添加媒体
        </button>
      </div>
      <div className={`media-capability${mediaInputDisabled ? ' is-unavailable' : ''}`} role="status">
        {mediaAvailabilityMessage}
      </div>
    </>
  );
}

function ArticleMetadataFields({ kind, title, summary, slug, onTitleChange, onSummaryChange, onSlugChange }: AdminEditorViewProps) {
  if (kind !== 'article') return null;
  return (
    <>
      <input className="title-input" value={title} onChange={event => onTitleChange(event.target.value)} placeholder="文章标题" aria-label="文章标题" />
      <input className="summary-input" value={summary} onChange={event => onSummaryChange(event.target.value)} placeholder="摘要（可选）" aria-label="文章摘要" />
      <input className="summary-input" value={slug} onChange={event => onSlugChange(event.target.value)} placeholder="地址 slug（可选，编辑时保持原值）" aria-label="文章地址" />
    </>
  );
}

function UploadStatus({ item }: { item: UploadItem }) {
  if (item.status === 'ready') return <><Check aria-hidden="true" />已完成</>;
  if (item.status === 'uploading') return <><LoaderCircle className="spin" aria-hidden="true" />上传中</>;
  if (item.status === 'failed') return <><AlertCircle aria-hidden="true" />失败</>;
  return <>排队中</>;
}

function UploadActions({ item, onCancelUpload, onRetryUpload, onRemoveUpload }: Pick<AdminEditorViewProps, 'onCancelUpload' | 'onRetryUpload' | 'onRemoveUpload'> & { item: UploadItem }) {
  return (
    <span className="upload-actions">
      <span className={`tag upload-${item.status}`}><UploadStatus item={item} /></span>
      {item.status === 'uploading' && <button type="button" className="inline-action" onClick={() => onCancelUpload(item)}><X aria-hidden="true" />取消</button>}
      {item.status === 'failed' && (
        <label className="inline-action">
          {item.needsReselect ? '重选' : '重试'}
          <input type="file" accept="image/*,audio/*,video/*,application/pdf" hidden onChange={event => {
            const file = event.target.files?.[0];
            if (file) void onRetryUpload(item, file);
            event.currentTarget.value = '';
          }} />
        </label>
      )}
      <button type="button" className="inline-action remove-media" onClick={() => onRemoveUpload(item)} aria-label={`从当前草稿移除 ${item.fileName}`}>
        <Trash2 aria-hidden="true" />移除附件
      </button>
    </span>
  );
}

function UploadQueueItem({ item, onCancelUpload, onRetryUpload, onRemoveUpload }: Pick<AdminEditorViewProps, 'onCancelUpload' | 'onRetryUpload' | 'onRemoveUpload'> & { item: UploadItem }) {
  const progress = Math.round((item.progress || 0) * 100);
  return (
    <li>
      <div className="upload-item-main">
        <span className="upload-name">{item.fileName}</span>
        {item.status === 'uploading' && <div className="upload-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}><span style={{ width: `${progress}%` }} /></div>}
      </div>
      <UploadActions item={item} onCancelUpload={onCancelUpload} onRetryUpload={onRetryUpload} onRemoveUpload={onRemoveUpload} />
    </li>
  );
}

function UploadQueue({ uploads, onCancelUpload, onRetryUpload, onRemoveUpload }: Pick<AdminEditorViewProps, 'uploads' | 'onCancelUpload' | 'onRetryUpload' | 'onRemoveUpload'>) {
  if (!uploads.length) return null;
  return <ul className="upload-list" aria-label="媒体上传队列">{uploads.map(item => <UploadQueueItem key={item.id} item={item} onCancelUpload={onCancelUpload} onRetryUpload={onRetryUpload} onRemoveUpload={onRemoveUpload} />)}</ul>;
}

function EntrySelectors({ date, kind, status, categories, tags, saving, loadingEdit, onDateChange, onKindChange, onStatusChange, onCategoriesChange, onTagsChange }: AdminEditorViewProps) {
  return (
    <>
      <JournalDatePicker value={date} onChange={onDateChange} disabled={saving || loadingEdit} />
      <label>类型 <select value={kind} onChange={event => onKindChange(event.target.value)}><option value="note">随记</option><option value="article">文章</option></select></label>
      <label>状态 <select value={status} onChange={event => onStatusChange(event.target.value as EditorStatus)}><option value="draft">草稿</option><option value="public">公开</option><option value="private">私人</option></select></label>
      <TagInput label="分类" values={categories} onChange={onCategoriesChange} placeholder="输入后回车" ariaLabel="分类" />
      <TagInput label="标签" values={tags} onChange={onTagsChange} placeholder="输入后回车" ariaLabel="标签" prefix="#" />
    </>
  );
}

function SaveActions({ markdown, saving, loadingEdit, mediaStillProcessing, editingEntryID, undoToken, onSave, onUndo }: Pick<AdminEditorViewProps, 'markdown' | 'saving' | 'loadingEdit' | 'mediaStillProcessing' | 'editingEntryID' | 'undoToken' | 'onSave' | 'onUndo'>) {
  return (
    <>
      <button className="primary" disabled={saving || loadingEdit || mediaStillProcessing || !markdown.trim()} onClick={onSave}>
        {saving ? '保存中…' : editingEntryID ? '保存修改' : '保存'}
      </button>
      {undoToken && <button className="secondary" onClick={onUndo}>撤销保存</button>}
    </>
  );
}

function ComposerFooter(props: AdminEditorViewProps) {
  return <div className="composer-footer"><EntrySelectors {...props} /><SaveActions {...props} /></div>;
}

function AdminSidebar({ drafts, onLoadDraft }: Pick<AdminEditorViewProps, 'drafts' | 'onLoadDraft'>) {
  return (
    <aside className="sidebar">
      <DraftTray drafts={drafts} onLoadDraft={onLoadDraft} />
      <div className="side-card"><h3>写作原则</h3><p>唯一保存按钮。先写，再决定是草稿、公开还是私人。私人内容不会出现在公开搜索和正文接口。</p></div>
      <div className="side-card"><h3>更多工具</h3><p><Link href="/admin/entries">版本、回收站与导出入口</Link>已接入版本、回收站和导出工具。</p></div>
    </aside>
  );
}

export default function AdminEditorView(props: AdminEditorViewProps) {
  const showNotice = Boolean(props.editingEntryID && props.kind === 'article' && props.workingCopyMeta.publishedStatus === 'published' && props.workingCopyMeta.publishedVisibility === 'public');
  return (
    <main id="main-content" className="shell">
      <div className="admin-grid">
        <section>
          <div className="eyebrow">WRITE NOW · {props.online ? 'ONLINE' : 'OFFLINE'}</div>
          <h1>{props.editingEntryID ? '编辑内容' : '此刻想写些什么？'}</h1>
          <div className="composer">
            <EditorToolbar {...props} />
            <EditingDraftNotice visible={showNotice} articleIdentifier={props.editingEntryID} meta={props.workingCopyMeta} discarding={props.discardingUnpublishedChanges} onDiscard={props.onDiscardWorkingCopy} />
            <ArticleMetadataFields {...props} />
            <MdxMarkdownEditor markdown={props.markdown} editorRef={props.editorRef} onChange={props.onMarkdownChange} onFiles={props.onFiles} onImageUpload={props.onImageUpload} onError={props.onEditorError} onNotice={props.onEditorNotice} onReady={props.onEditorReady} onViewModeChange={props.onViewModeChange} disabled={props.saving || props.loadingEdit} />
            <UploadPanel open={props.uploadPanelOpen} dragActive={props.dragActive} disabled={props.mediaInputDisabled} disabledMessage={props.mediaAvailabilityMessage} onDragEnter={props.onDragEnter} onDragOver={props.onDragOver} onDragLeave={props.onDragLeave} onDrop={props.onDrop} onFiles={files => props.onFiles(Array.from(files))} />
            <AttachmentPreview markdown={props.markdown} uploads={props.uploads} />
            <div className="status" aria-live="polite">{props.message}</div>
            <UploadQueue uploads={props.uploads} onCancelUpload={props.onCancelUpload} onRetryUpload={props.onRetryUpload} onRemoveUpload={props.onRemoveUpload} />
            <ComposerFooter {...props} />
          </div>
        </section>
        <AdminSidebar drafts={props.drafts} onLoadDraft={props.onLoadDraft} />
      </div>
    </main>
  );
}
