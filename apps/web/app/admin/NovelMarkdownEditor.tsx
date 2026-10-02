'use client';

import dynamic from 'next/dynamic';
import { Code2 } from 'lucide-react';
import { createPortal } from 'react-dom';
import { useId, useState, type RefObject } from 'react';
import type { MarkdownEditorHandle } from './editor-contract';
import MarkdownSourceEditor from './MarkdownSourceEditor';
import EditorModeSwitch from './EditorModeSwitch';

export const MEDIA_MODE_HINT = '图片可从工具栏或 / 菜单插入，附件支持粘贴和拖放';

export type NovelMarkdownEditorProps = {
  markdown: string;
  editorRef: RefObject<MarkdownEditorHandle | null>;
  editorPortalElement?: Element | null;
  toolbarElement?: HTMLElement | null;
  modeElement?: HTMLElement | null;
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
  loading: () => <div className="novel-editor-loading" role="status">富文本编辑器加载中…</div>,
});

/** 以同一 Markdown 值提供富文本与无损源码模式，工具可挂载到工作台顶部。 */
export default function NovelMarkdownEditor(props: NovelMarkdownEditorProps) {
  const [mode, setMode] = useState<'rich' | 'markdown'>('rich');
  const id = useId();
  const panelID = `${id}-panel`;
  const modeSwitch = <EditorModeSwitch id={id} mode={mode} onModeChange={setMode} disabled={props.disabled} />;
  const sourceTools = <div className="writing-source-tools"><Code2 aria-hidden="true" /><span>Markdown 源码<small>直接输入语法，按原文保存</small></span></div>;
  return (
    <section className="markdown-editor-workspace" aria-label="正文编辑工作区">
      {props.modeElement ? createPortal(modeSwitch, props.modeElement) : modeSwitch}
      {mode === 'markdown' && props.toolbarElement && createPortal(sourceTools, props.toolbarElement)}
      <div id={panelID} className="markdown-workspace-panel" role="tabpanel" aria-labelledby={`${id}-${mode}-tab`}>
        {mode === 'rich' ? <NovelMarkdownEditorClient {...props} /> : <MarkdownSourceEditor {...props} />}
      </div>
    </section>
  );
}
