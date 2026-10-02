'use client';

import { useState, type RefObject } from 'react';
import { Cloud, CloudOff, FileText, Settings2, SlidersHorizontal } from 'lucide-react';
import type { UploadItem } from '@/lib/media-utils';
import AdminEditorResources from './AdminEditorResources';
import EditingDraftNotice from './EditingDraftNotice';
import JournalDatePicker from './JournalDatePicker';
import NovelMarkdownEditor from './NovelMarkdownEditor';
import type { MarkdownEditorHandle } from './editor-contract';
import TagInput from './TagInput';
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
  categorySuggestions: string[];
  tagSuggestions: string[];
  date: string;
  markdown: string;
  message: string;
  saving: boolean;
  loadingEdit: boolean;
  undoToken: string;
  mediaInputDisabled: boolean;
  imageUploadDisabled: boolean;
  mediaAvailabilityMessage: string;
  imageUploadAvailabilityMessage: string;
  mediaStillProcessing: boolean;
  workingCopyMeta: WorkingCopyMeta;
  discardingUnpublishedChanges: boolean;
  drafts: Draft[];
  uploads: UploadItem[];
  editorRef: RefObject<MarkdownEditorHandle | null>;
  presentation?: 'page' | 'dialog';
  editorPortalElement?: Element | null;
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

function EntrySelectors({ date, kind, status, categories, tags, categorySuggestions, tagSuggestions, saving, loadingEdit, onDateChange, onKindChange, onStatusChange, onCategoriesChange, onTagsChange }: AdminEditorViewProps) {
  return (
    <div className="writing-inspector-fields">
      <JournalDatePicker value={date} onChange={onDateChange} disabled={saving || loadingEdit} />
      <div className="writing-selector-row">
        <label>类型 <select value={kind} onChange={event => onKindChange(event.target.value)}><option value="note">随记</option><option value="article">文章</option></select></label>
        <label>状态 <select value={status} onChange={event => onStatusChange(event.target.value as EditorStatus)}><option value="draft">草稿</option><option value="public">公开</option><option value="private">私人</option></select></label>
      </div>
      <TagInput label="分类" values={categories} suggestions={categorySuggestions} onChange={onCategoriesChange} placeholder="输入后回车" ariaLabel="分类" />
      <TagInput label="标签" values={tags} suggestions={tagSuggestions} onChange={onTagsChange} placeholder="输入后回车" ariaLabel="标签" prefix="#" />
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


function WritingHeader(props: AdminEditorViewProps) {
  const pageTitle = props.editingEntryID ? '编辑内容' : props.kind === 'article' ? '新建文章' : '写一条随记';
  return (
    <header className={`writing-page-header${props.presentation === 'dialog' ? ' is-dialog' : ''}`}>
      {props.presentation !== 'dialog' && <div className="writing-page-title">
        <span className="writing-eyebrow">菜鸟手记 / 写作工作台</span>
        <h1>{pageTitle}</h1>
      </div>}
      <div className="writing-header-actions">
        <span className={`writing-connection ${props.online ? 'is-online' : 'is-offline'}`}>
          {props.online ? <Cloud aria-hidden="true" /> : <CloudOff aria-hidden="true" />}
          {props.online ? '在线' : '离线'}
        </span>
        <div className="writing-status" role="status">{props.message || (props.loadingEdit ? '正在载入内容…' : '所有更改会自动暂存')}</div>
        <SaveActions {...props} />
      </div>
    </header>
  );
}

function WritingDocument({ toolbarElement, modeElement, ...props }: AdminEditorViewProps & { toolbarElement: HTMLElement | null; modeElement: HTMLElement | null }) {
  const mediaInputDisabled = props.mediaInputDisabled || props.saving || props.loadingEdit;
  const imageUploadDisabled = props.imageUploadDisabled || props.saving || props.loadingEdit;
  const showNotice = Boolean(props.editingEntryID && props.kind === 'article' && props.workingCopyMeta.publishedStatus === 'published' && props.workingCopyMeta.publishedVisibility === 'public');
  return (
    <section className="writing-main" aria-label="内容编辑区">
      <div className="writing-composer">
        <div className="writing-document-heading"><span><FileText aria-hidden="true" />文档</span><small>{props.kind === 'article' ? '文章' : '随记'}</small></div>
        <EditingDraftNotice visible={showNotice} articleIdentifier={props.editingEntryID} meta={props.workingCopyMeta} discarding={props.discardingUnpublishedChanges} onDiscard={props.onDiscardWorkingCopy} />
        <ArticleMetadataFields {...props} />
        <NovelMarkdownEditor
          markdown={props.markdown} editorRef={props.editorRef} editorPortalElement={props.editorPortalElement}
          toolbarElement={toolbarElement} modeElement={modeElement}
          onChange={props.onMarkdownChange} onFiles={mediaInputDisabled ? undefined : props.onFiles}
          onImageUpload={imageUploadDisabled ? undefined : props.onImageUpload}
          imageUploadUnavailableMessage={props.imageUploadAvailabilityMessage}
          onError={props.onEditorError} onNotice={props.onEditorNotice} onReady={props.onEditorReady}
          disabled={props.saving || props.loadingEdit}
        />
      </div>
    </section>
  );
}

function WritingInspector(props: AdminEditorViewProps) {
  return (
    <aside className="writing-rail" aria-label="文章属性">
      <details className="writing-inspector" open>
        <summary><span><Settings2 aria-hidden="true" />属性</span><small>{props.status === 'public' ? '公开' : props.status === 'private' ? '私人' : '草稿'}</small></summary>
        <EntrySelectors {...props} />
        <p className="writing-inspector-note">私人内容仅自己可见，不会出现在公开时间线和搜索中。</p>
      </details>
    </aside>
  );
}

/** 复用同一写作数据链，组合顶部工具和资源、文档、属性工作区。 */
export default function AdminEditorView(props: AdminEditorViewProps) {
  const [toolbarElement, setToolbarElement] = useState<HTMLDivElement | null>(null);
  const [modeElement, setModeElement] = useState<HTMLDivElement | null>(null);
  const content = (
    <>
      <WritingHeader {...props} />
      <div className="writing-workbench">
        <div className="writing-workbench-tools" aria-label="编辑工具">
          <span className="writing-tools-label"><SlidersHorizontal aria-hidden="true" />编辑工具</span>
          <div className="writing-format-tools" ref={setToolbarElement} />
          <div className="writing-mode-tools" ref={setModeElement} />
        </div>
        <div className="writing-layout">
          <WritingDocument {...props} toolbarElement={toolbarElement} modeElement={modeElement} />
          <WritingInspector {...props} />
          <AdminEditorResources {...props} />
        </div>
      </div>
    </>
  );
  if (props.presentation === 'dialog') return <div className="writing-shell writing-dialog-shell">{content}</div>;
  return <main id="main-content" className="writing-shell writing-page-shell">{content}</main>;
}
