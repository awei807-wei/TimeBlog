'use client';

import dynamic from 'next/dynamic';
import type { RefObject } from 'react';
import type { MDXEditorMethods, ViewMode } from '@mdxeditor/editor';

export type MdxEditorViewMode = ViewMode;
export const MEDIA_MODE_HINT = '请切回所见即所得后添加媒体';

export type MdxMarkdownEditorProps = {
  markdown: string;
  editorRef: RefObject<MDXEditorMethods | null>;
  onChange: (markdown: string) => void;
  onFiles?: (files: File[]) => void;
  onImageUpload?: (file: File) => Promise<string>;
  onError?: (message: string) => void;
  onReady?: (ready: boolean) => void;
  onViewModeChange?: (viewMode: MdxEditorViewMode) => void;
  disabled?: boolean;
};

const MdxMarkdownEditorClient = dynamic(() => import('./MdxMarkdownEditorClient'), {
  ssr: false,
  loading: () => <div className="mdx-editor-loading" role="status">编辑器加载中…</div>,
});

/**
 * MDXEditor is browser-only (Lexical and CodeMirror access `window` while
 * mounting). Keep the import behind a client-only dynamic boundary so Next.js
 * never tries to hydrate a server-rendered editor tree.
 */
export default function MdxMarkdownEditor(props: MdxMarkdownEditorProps) {
  return <MdxMarkdownEditorClient {...props} />;
}
