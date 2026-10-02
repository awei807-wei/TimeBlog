'use client';

import { AlertCircle, Check, FileText, Layers3, LoaderCircle, Paperclip, Trash2, X } from 'lucide-react';
import Link from 'next/link';
import type { UploadItem } from '@/lib/media-utils';
import type { AdminEditorViewProps } from './AdminEditorView';
import AttachmentButton from './AttachmentButton';
import AttachmentPreview from './AttachmentPreview';
import DraftTray from './DraftTray';

function UploadStatus({ item }: { item: UploadItem }) {
  if (item.status === 'ready') return <><Check aria-hidden="true" />已完成</>;
  if (item.status === 'uploading') return <><LoaderCircle className="spin" aria-hidden="true" />上传中</>;
  if (item.status === 'failed') return <><AlertCircle aria-hidden="true" />失败</>;
  return <>排队中</>;
}

function UploadActions({ item, disabled, onCancelUpload, onRetryUpload, onRemoveUpload }: Pick<AdminEditorViewProps, 'onCancelUpload' | 'onRetryUpload' | 'onRemoveUpload'> & { item: UploadItem; disabled: boolean }) {
  return (
    <span className="upload-actions">
      <span className={`tag upload-${item.status}`}><UploadStatus item={item} /></span>
      {item.status === 'uploading' && <button type="button" className="inline-action" onClick={() => onCancelUpload(item)}><X aria-hidden="true" />取消</button>}
      {item.status === 'failed' && (
        <label className="inline-action" aria-disabled={disabled}>
          {item.needsReselect ? '重选' : '重试'}
          <input type="file" accept="image/*,audio/*,video/*,application/pdf" hidden disabled={disabled} onChange={event => {
            const file = event.target.files?.[0];
            event.currentTarget.value = '';
            if (!disabled && file) void onRetryUpload(item, file);
          }} />
        </label>
      )}
      <button type="button" className="inline-action remove-media" onClick={() => onRemoveUpload(item)} aria-label={`从当前草稿移除 ${item.fileName}`}>
        <Trash2 aria-hidden="true" />移除附件
      </button>
    </span>
  );
}

function UploadQueueItem({ item, disabled, onCancelUpload, onRetryUpload, onRemoveUpload }: Pick<AdminEditorViewProps, 'onCancelUpload' | 'onRetryUpload' | 'onRemoveUpload'> & { item: UploadItem; disabled: boolean }) {
  const progress = Math.round((item.progress || 0) * 100);
  return (
    <li>
      <div className="upload-item-main">
        <span className="upload-name">{item.fileName}</span>
        {item.status === 'uploading' && <div className="upload-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}><span style={{ width: `${progress}%` }} /></div>}
      </div>
      <UploadActions item={item} disabled={disabled} onCancelUpload={onCancelUpload} onRetryUpload={onRetryUpload} onRemoveUpload={onRemoveUpload} />
    </li>
  );
}

function UploadQueue({ uploads, disabled, onCancelUpload, onRetryUpload, onRemoveUpload }: Pick<AdminEditorViewProps, 'uploads' | 'onCancelUpload' | 'onRetryUpload' | 'onRemoveUpload'> & { disabled: boolean }) {
  if (!uploads.length) return null;
  return <ul className="upload-list" aria-label="媒体上传队列">{uploads.map(item => <UploadQueueItem key={item.id} item={item} disabled={disabled} onCancelUpload={onCancelUpload} onRetryUpload={onRetryUpload} onRemoveUpload={onRemoveUpload} />)}</ul>;
}


/** 汇集当前附件及本机草稿，不引入独立的上传或持久化状态。 */
export default function AdminEditorResources(props: AdminEditorViewProps) {
  const navigationDisabled = props.saving || props.loadingEdit || props.mediaStillProcessing;
  const disabled = props.mediaInputDisabled || props.saving || props.loadingEdit;
  const navigationReason = props.saving ? '保存完成后可切换草稿' : props.loadingEdit ? '内容载入完成后可切换草稿' : '附件上传完成后可切换草稿';
  const disabledMessage = props.saving ? '正在保存，请稍后再试' : props.loadingEdit ? '正在载入内容，请稍后再试' : props.mediaAvailabilityMessage;
  const manageLinkContent = <><FileText aria-hidden="true" />管理全部内容</>;
  return (
    <aside className="writing-resources" aria-label="写作资源">
      <h2 className="writing-panel-heading"><Layers3 aria-hidden="true" />资源</h2>
      <div className="writing-resource-scroll">
        <section className="writing-resource-media" aria-label="当前附件">
          <div className="writing-resource-title"><h3>当前附件</h3><span>{props.uploads.length}</span></div>
          <AttachmentButton disabled={disabled} imageUploadDisabled={props.imageUploadDisabled}
            disabledMessage={disabledMessage} imageUploadUnavailableMessage={props.imageUploadAvailabilityMessage}
            editorPortalElement={props.editorPortalElement} onFiles={props.onFiles} />
          {props.imageUploadDisabled && <p className="writing-resource-hint">图片仍可使用 HTTPS 链接</p>}
          {!props.uploads.length && <div className="writing-resource-empty">
            <Paperclip aria-hidden="true" />
            <p>还没有附件</p>
            <small>{disabled ? disabledMessage : '拖入正文或点击添加，图片与文件会在这里显示。'}</small>
          </div>}
          <UploadQueue uploads={props.uploads} disabled={disabled} onCancelUpload={props.onCancelUpload} onRetryUpload={props.onRetryUpload} onRemoveUpload={props.onRemoveUpload} />
          <AttachmentPreview markdown={props.markdown} uploads={props.uploads} />
        </section>
        <DraftTray drafts={props.drafts} onLoadDraft={props.onLoadDraft} disabled={navigationDisabled} disabledReason={navigationReason} />
      </div>
      {navigationDisabled
        ? <span className="writing-manage-link" aria-disabled="true">{manageLinkContent}</span>
        : <Link className="writing-manage-link" href="/admin/entries" prefetch={false}>{manageLinkContent}</Link>}
    </aside>
  );
}
