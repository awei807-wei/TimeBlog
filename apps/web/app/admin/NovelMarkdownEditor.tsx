'use client';

import dynamic from 'next/dynamic';
import type { RefObject } from 'react';
import type { MarkdownEditorHandle } from './editor-contract';

export const MEDIA_MODE_HINT = '图片可从工具栏或 / 菜单插入，附件支持粘贴和拖放';

export type NovelMarkdownEditorProps = {
  markdown: string;
  editorRef: RefObject<MarkdownEditorHandle | null>;
  editorPortalElement?: Element | null;
  onChange: (markdown: string) => void;
  onFiles?: (files: File[]) => void;
  onImageUpload?: (file: File) => Promise<string>;
  imageUploadUnavailableMessage?: string;
  onError?: (message: string) => void;
  onNotice?: (message: string) => void;
  onReady?: (ready: boolean) => void;
  disabled?: boolean;
};

const NovelMarkdownEditorClient = dynamic(() => import('./NovelMarkdownEditorClient'), {
  ssr: false,
  loading: () => <div className="novel-editor-loading" role="status">编辑器加载中…</div>,
});

/** Novel/Tiptap accesses browser globals while mounting; keep that boundary explicit. */
export default function NovelMarkdownEditor(props: NovelMarkdownEditorProps) {
  return <NovelMarkdownEditorClient {...props} />;
}
