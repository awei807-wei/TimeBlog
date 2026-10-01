'use client';

import dynamic from 'next/dynamic';
import { Code2, Type } from 'lucide-react';
import { useId, useState, type RefObject } from 'react';
import type { MarkdownEditorHandle } from './editor-contract';
import MarkdownSourceEditor from './MarkdownSourceEditor';

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

type EditorMode = 'rich' | 'markdown';

const NovelMarkdownEditorClient = dynamic(() => import('./NovelMarkdownEditorClient'), {
  ssr: false,
  loading: () => <div className="novel-editor-loading" role="status">富文本编辑器加载中…</div>,
});

/** Offer explicit rich-text and lossless Markdown workspaces over one Markdown value. */
export default function NovelMarkdownEditor(props: NovelMarkdownEditorProps) {
  const [mode, setMode] = useState<EditorMode>('rich');
  const id = useId();
  const richTabID = `${id}-rich-tab`;
  const markdownTabID = `${id}-markdown-tab`;
  const panelID = `${id}-panel`;
  const activeTabID = mode === 'rich' ? richTabID : markdownTabID;
  const hint = mode === 'rich'
    ? '所见即所得：请使用格式工具栏排版；粘贴的 Markdown 文本会按普通文字处理。'
    : '源码模式：粘贴 Markdown、代码围栏和其他语法时会按原文保存，发布时统一渲染。';

  return (
    <section className="markdown-editor-workspace" aria-label="正文编辑工作区">
      <div className="markdown-workspace-modebar">
        <div className="markdown-workspace-tabs" role="tablist" aria-label="正文编辑模式">
          <button
            id={richTabID}
            className="markdown-workspace-tab"
            type="button"
            role="tab"
            aria-selected={mode === 'rich'}
            aria-controls={panelID}
            disabled={props.disabled}
            onClick={() => setMode('rich')}
          >
            <Type aria-hidden="true" />
            <span><strong>富文本</strong><small>所见即所得</small></span>
          </button>
          <button
            id={markdownTabID}
            className="markdown-workspace-tab"
            type="button"
            role="tab"
            aria-selected={mode === 'markdown'}
            aria-controls={panelID}
            disabled={props.disabled}
            onClick={() => setMode('markdown')}
          >
            <Code2 aria-hidden="true" />
            <span><strong>Markdown</strong><small>纯源码</small></span>
          </button>
        </div>
        <p className="markdown-workspace-hint" role="status">{hint}</p>
      </div>
      <div id={panelID} className="markdown-workspace-panel" role="tabpanel" aria-labelledby={activeTabID} data-mode={mode}>
        {mode === 'rich' ? (
          <NovelMarkdownEditorClient {...props} />
        ) : (
          <MarkdownSourceEditor
            markdown={props.markdown}
            editorRef={props.editorRef}
            onChange={props.onChange}
            onFiles={props.onFiles}
            onError={props.onError}
            onReady={props.onReady}
            disabled={props.disabled}
          />
        )}
      </div>
    </section>
  );
}
