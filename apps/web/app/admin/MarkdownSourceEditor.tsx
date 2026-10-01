'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type RefObject } from 'react';
import type { MarkdownEditorHandle } from './editor-contract';
import { captureEditorFiles } from './editor-file-input';
import { useEditorFileDrop } from './useEditorFileDrop';

type MarkdownSourceEditorProps = {
  markdown: string;
  editorRef: RefObject<MarkdownEditorHandle | null>;
  onChange: (markdown: string) => void;
  onFiles?: (files: File[]) => void;
  onError?: (message: string) => void;
  onReady?: (ready: boolean) => void;
  disabled?: boolean;
};

export default function MarkdownSourceEditor({ markdown, editorRef, onChange, onFiles, onError, onReady, disabled = false }: MarkdownSourceEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const onChangeRef = useRef(onChange);
  const onFilesRef = useRef(onFiles);
  const onErrorRef = useRef(onError);
  const onReadyRef = useRef(onReady);
  const sourceRef = useRef(markdown);
  const [source, setSource] = useState(markdown);
  const { dragActive, resetDrag, onDragEnterCapture, onDragOverCapture, onDragLeaveCapture } = useEditorFileDrop(!disabled && Boolean(onFiles));

  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);
  useEffect(() => { onFilesRef.current = onFiles; }, [onFiles]);
  useEffect(() => { onErrorRef.current = onError; }, [onError]);
  useEffect(() => { onReadyRef.current = onReady; }, [onReady]);
  useEffect(() => {
    if (markdown === sourceRef.current) return;
    sourceRef.current = markdown;
    setSource(markdown);
  }, [markdown]);

  const insertMarkdownAtSelection = useCallback((value: string) => {
    const textarea = textareaRef.current;
    const current = sourceRef.current;
    const start = textarea?.selectionStart ?? current.length;
    const end = textarea?.selectionEnd ?? start;
    const next = `${current.slice(0, start)}${value}${current.slice(end)}`;
    const caret = start + value.length;
    sourceRef.current = next;
    setSource(next);
    onChangeRef.current(next);
    window.requestAnimationFrame(() => {
      const activeTextarea = textareaRef.current;
      if (!activeTextarea) return;
      activeTextarea.focus();
      activeTextarea.setSelectionRange(caret, caret);
    });
  }, []);

  useEffect(() => {
    const readyCallback = onReadyRef.current;
    const handle: MarkdownEditorHandle = {
      focus: () => textareaRef.current?.focus(),
      getMarkdown: () => sourceRef.current,
      setMarkdown: next => {
        sourceRef.current = next;
        setSource(next);
      },
      insertMarkdown: insertMarkdownAtSelection,
    };
    editorRef.current = handle;
    readyCallback?.(true);
    return () => {
      if (editorRef.current === handle) editorRef.current = null;
      readyCallback?.(false);
    };
  }, [editorRef, insertMarkdownAtSelection]);

  const reportMediaUnavailable = useCallback(() => onErrorRef.current?.('媒体存储尚未就绪，暂时无法添加文件'), []);
  const handlePasteCapture = useCallback((event: ClipboardEvent<HTMLDivElement>) => {
    captureEditorFiles(event, onFilesRef.current, reportMediaUnavailable, disabled);
  }, [disabled, reportMediaUnavailable]);
  const handleDropCapture = useCallback((event: DragEvent<HTMLDivElement>) => {
    resetDrag();
    captureEditorFiles(event, onFilesRef.current, reportMediaUnavailable, disabled);
  }, [disabled, reportMediaUnavailable, resetDrag]);
  const stats = useMemo(() => ({ lines: source ? source.split(/\r?\n/).length : 0, characters: source.length }), [source]);

  return (
    <div
      className={`markdown-source-shell${dragActive ? ' is-file-dragging' : ''}`}
      onPasteCapture={handlePasteCapture}
      onDropCapture={handleDropCapture}
      onDragEnterCapture={onDragEnterCapture}
      onDragOverCapture={onDragOverCapture}
      onDragLeaveCapture={onDragLeaveCapture}
    >
      {dragActive && <div className="novel-file-drop-hint" role="status">松开即可上传附件</div>}
      <textarea
        ref={textareaRef}
        className="markdown-source-input"
        aria-label="Markdown 源码编辑器"
        aria-multiline="true"
        aria-readonly={disabled}
        value={source}
        readOnly={disabled}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        placeholder={'在此粘贴或输入完整 Markdown。\n\n# 标题\n\n```js\nconsole.log("hello")\n```'}
        onChange={event => {
          const next = event.currentTarget.value;
          sourceRef.current = next;
          setSource(next);
          onChangeRef.current(next);
        }}
      />
      <div className="markdown-source-status" aria-label={`Markdown 原文，共 ${stats.lines} 行、${stats.characters} 个字符`}>
        <span>Markdown 原文</span>
        <span>{stats.lines} 行 · {stats.characters} 字符</span>
      </div>
    </div>
  );
}
