'use client';

import type { DragEvent, RefObject } from 'react';
import type { MDXEditorMethods } from '@mdxeditor/editor';
import { AlertCircle, Check, Cloud, CloudOff, FileText, LoaderCircle, Paperclip, Settings2, Trash2, X } from 'lucide-react';
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
    <div className="writing-editor-heading">
      <div>
        <span className="writing-section-label">正文</span>
        <small className={mediaInputDisabled ? 'is-unavailable' : ''}>{mediaAvailabilityMessage}</small>
      </div>
      <div className="editor-toolbar editor-toolbar-actions" aria-label="编辑工具">
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
          附件
        </button>
      </div>
    </div>
  );
}

function ArticleMetadataFields({ kind, title, summary, slug, onTitleChange, onSummaryChange, onSlugChange }: AdminEditorViewProps) {
  if (kind !== 'article') return null;
  return (
    <div className="article-fields">
      <input className="title-input" value={title} onChange={event => onTitleChange(event.target.value)} placeholder="文章标题" aria-label="文章标题" />
      <input className="summary-input" value={summary} onChange={event => onSummaryChange(event.target.value)} placeholder="摘要（可选）" aria-label="文章摘要" />
      <input className="summary-input slug-input" value={slug} onChange={event => onSlugChange(event.target.value)} placeholder="文章地址 slug（可选）" aria-label="文章地址" />
    </div>
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
    <div className="writing-inspector-fields">
      <JournalDatePicker value={date} onChange={onDateChange} disabled={saving || loadingEdit} />
      <div className="writing-selector-row">
        <label>类型 <select value={kind} onChange={event => onKindChange(event.target.value)}><option value="note">随记</option><option value="article">文章</option></select></label>
        <label>状态 <select value={status} onChange={event => onStatusChange(event.target.value as EditorStatus)}><option value="draft">草稿</option><option value="public">公开</option><option value="private">私人</option></select></label>
      </div>
      <TagInput label="分类" values={categories} onChange={onCategoriesChange} placeholder="输入后回车" ariaLabel="分类" />
      <TagInput label="标签" values={tags} onChange={onTagsChange} placeholder="输入后回车" ariaLabel="标签" prefix="#" />
    </div>
  );
}

function SaveActions({ markdown, saving, loadingEdit, mediaStillProcessing, editingEntryID, undoToken, onSave, onUndo }: Pick<AdminEditorViewProps, 'markdown' | 'saving' | 'loadingEdit' | 'mediaStillProcessing' | 'editingEntryID' | 'undoToken' | 'onSave' | 'onUndo'>) {
  return (
    <div className="writing-save-actions">
      {undoToken && <button type="button" className="writing-undo-button" onClick={onUndo}>撤销保存</button>}
      <button type="button" className="writing-save-button" disabled={saving || loadingEdit || mediaStillProcessing || !markdown.trim()} onClick={onSave}>
        {saving ? '保存中…' : editingEntryID ? '保存修改' : '保存'}
      </button>
    </div>
  );
}

function AdminSidebar({ drafts, onLoadDraft }: Pick<AdminEditorViewProps, 'drafts' | 'onLoadDraft'>) {
  return (
    <aside className="writing-sidebar" aria-label="写作辅助">
      <DraftTray drafts={drafts} onLoadDraft={onLoadDraft} />
      <Link className="writing-manage-link" href="/admin/entries"><FileText aria-hidden="true" />管理全部内容</Link>
    </aside>
  );
}

export default function AdminEditorView(props: AdminEditorViewProps) {
  const showNotice = Boolean(props.editingEntryID && props.kind === 'article' && props.workingCopyMeta.publishedStatus === 'published' && props.workingCopyMeta.publishedVisibility === 'public');
  const pageTitle = props.editingEntryID ? '编辑内容' : props.kind === 'article' ? '新建文章' : '写一条随记';
  return (
    <main id="main-content" className="writing-shell">
      <header className="writing-page-header">
        <div className="writing-page-title">
          <span className={`writing-connection ${props.online ? 'is-online' : 'is-offline'}`}>
            {props.online ? <Cloud aria-hidden="true" /> : <CloudOff aria-hidden="true" />}
            {props.online ? '在线' : '离线'}
          </span>
          <h1>{pageTitle}</h1>
          <p>内容会自动保存在本机草稿中，准备好后再决定是否公开。</p>
        </div>
        <div className="writing-header-actions">
          <div className="writing-status" aria-live="polite">{props.message || (props.loadingEdit ? '正在载入内容…' : '所有更改会自动暂存')}</div>
          <SaveActions {...props} />
        </div>
      </header>

      <div className="writing-layout">
        <section className="writing-main" aria-label="内容编辑区">
          <div className="writing-composer">
            <EditingDraftNotice visible={showNotice} articleIdentifier={props.editingEntryID} meta={props.workingCopyMeta} discarding={props.discardingUnpublishedChanges} onDiscard={props.onDiscardWorkingCopy} />
            <ArticleMetadataFields {...props} />
            <EditorToolbar {...props} />
            <MdxMarkdownEditor markdown={props.markdown} editorRef={props.editorRef} onChange={props.onMarkdownChange} onFiles={props.onFiles} onImageUpload={props.onImageUpload} onError={props.onEditorError} onNotice={props.onEditorNotice} onReady={props.onEditorReady} onViewModeChange={props.onViewModeChange} disabled={props.saving || props.loadingEdit} />
            <UploadPanel open={props.uploadPanelOpen} dragActive={props.dragActive} disabled={props.mediaInputDisabled} disabledMessage={props.mediaAvailabilityMessage} onDragEnter={props.onDragEnter} onDragOver={props.onDragOver} onDragLeave={props.onDragLeave} onDrop={props.onDrop} onFiles={files => props.onFiles(Array.from(files))} />
            <AttachmentPreview markdown={props.markdown} uploads={props.uploads} />
            <UploadQueue uploads={props.uploads} onCancelUpload={props.onCancelUpload} onRetryUpload={props.onRetryUpload} onRemoveUpload={props.onRemoveUpload} />
          </div>
        </section>

        <div className="writing-rail">
          <details className="writing-inspector" open>
            <summary><span><Settings2 aria-hidden="true" />发布设置</span><small>{props.status === 'public' ? '公开' : props.status === 'private' ? '私人' : '草稿'}</small></summary>
            <EntrySelectors {...props} />
            <p className="writing-inspector-note">私人内容不会出现在公开时间线、搜索和正文接口中。</p>
          </details>
          <AdminSidebar drafts={props.drafts} onLoadDraft={props.onLoadDraft} />
        </div>
      </div>
    </main>
  );
}
