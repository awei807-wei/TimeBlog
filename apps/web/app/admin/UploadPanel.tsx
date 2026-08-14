'use client';

import { AlertCircle, FileUp, UploadCloud } from 'lucide-react';
import { MAX_MEDIA_BYTES } from '@/lib/media-utils';
import type * as React from 'react';

type UploadPanelProps = {
  open: boolean;
  dragActive: boolean;
  disabled: boolean;
  disabledMessage: string;
  onDragEnter: (event: React.DragEvent<HTMLDivElement>) => void;
  onDragOver: (event: React.DragEvent<HTMLDivElement>) => void;
  onDragLeave: (event: React.DragEvent<HTMLDivElement>) => void;
  onDrop: (event: React.DragEvent<HTMLDivElement>) => void;
  onFiles: (files: FileList) => void;
};

export default function UploadPanel({ open, dragActive, disabled, disabledMessage, onDragEnter, onDragOver, onDragLeave, onDrop, onFiles }: UploadPanelProps) {
  if (!open) return null;
  return (
    <section className="upload-panel" aria-label="媒体附件上传">
      <div
        className={`upload-dropzone${dragActive ? ' is-dragging' : ''}${disabled ? ' is-disabled' : ''}`}
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        <div className="upload-dropzone-icon" aria-hidden="true"><UploadCloud /></div>
        <strong>拖放文件到这里</strong>
        <span>或浏览设备选择附件</span>
        <small>支持 PNG、JPG、GIF、WEBP、音频、视频和 PDF，单个文件不超过 {Math.round(MAX_MEDIA_BYTES / 1024 / 1024)}MB</small>
        <label className="upload-browse-button">
          <FileUp aria-hidden="true" /> 浏览文件
          <input type="file" accept="image/*,audio/*,video/*,application/pdf" multiple hidden disabled={disabled} onChange={event => { if (event.target.files) onFiles(event.target.files); event.currentTarget.value = ''; }} />
        </label>
        {disabled && <span className="upload-panel-error"><AlertCircle aria-hidden="true" />{disabledMessage}</span>}
      </div>
    </section>
  );
}
