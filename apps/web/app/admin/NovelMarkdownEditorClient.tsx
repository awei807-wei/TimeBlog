'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState, type MutableRefObject, type RefObject } from 'react';
import type * as React from 'react';
import {
  EditorContent,
  EditorRoot,
  useEditor,
  type EditorInstance,
} from 'novel';
import type { JSONContent, Range } from '@tiptap/core';
import { API } from '@/lib/api';
import { mediaContentUrl } from '@/lib/media-resolver';
import { isSafeMediaReference, prepareMarkdownForNovel, restoreMarkdownFromNovel, type PreparedMarkdown } from './markdown-compat';
import { createNovelExtensions } from './novel-editor-extensions';
import NovelEditorToolbar from './NovelEditorToolbar';
import { buildNovelSuggestions, NovelEditorBubbleMenu, NovelEditorSlashMenu } from './NovelEditorMenus';
import NovelImageDialog from './NovelImageDialog';
import NovelLinkDialog from './NovelLinkDialog';
import type { MarkdownEditorHandle } from './editor-contract';
import type { NovelMarkdownEditorProps } from './NovelMarkdownEditor';

type EditorRef = RefObject<MarkdownEditorHandle | null>;

const EMPTY_DOCUMENT: JSONContent = { type: 'doc', content: [{ type: 'paragraph' }] };
const EDITOR_PROPS = {
  attributes: {
    role: 'textbox',
    'aria-label': 'Markdown 正文编辑器',
    'aria-multiline': 'true',
  },
};
const EDITOR_CONTAINER_PROPS = { className: 'novel-editor-content article-prose' };

type BridgeProps = {
  markdown: string;
  editorRef: EditorRef;
  onChangeRef: MutableRefObject<(markdown: string) => void>;
  onReadyRef: MutableRefObject<((ready: boolean) => void) | undefined>;
  onNoticeRef: MutableRefObject<((message: string) => void) | undefined>;
  sourceRef: MutableRefObject<string>;
  dirtyRef: MutableRefObject<boolean>;
  compatibilityRef: MutableRefObject<PreparedMarkdown>;
  onCompatibilityChange: (hasProtectedContent: boolean) => void;
};

function createEditorHandle(editor: EditorInstance, sourceRef: MutableRefObject<string>, dirtyRef: MutableRefObject<boolean>, compatibilityRef: MutableRefObject<PreparedMarkdown>, onChangeRef: MutableRefObject<(markdown: string) => void>, onCompatibilityChange: (hasProtectedContent: boolean) => void): MarkdownEditorHandle {
  const getMarkdown = () => {
    if (!dirtyRef.current) return sourceRef.current;
    return restoreMarkdownFromNovel(editor.storage.markdown.getMarkdown(), compatibilityRef.current.replacements);
  };
  return {
    focus: () => editor.commands.focus(),
    getMarkdown,
    setMarkdown: markdown => {
      const prepared = prepareMarkdownForNovel(markdown);
      compatibilityRef.current = prepared;
      onCompatibilityChange(prepared.replacements.length > 0);
      editor.commands.setContent(prepared.markdown, false);
      sourceRef.current = markdown;
      dirtyRef.current = false;
    },
    insertMarkdown: markdown => {
      editor.chain().focus().insertContentAt(editor.state.selection, markdown).run();
      const next = restoreMarkdownFromNovel(editor.storage.markdown.getMarkdown(), compatibilityRef.current.replacements);
      sourceRef.current = next;
      dirtyRef.current = true;
      onChangeRef.current(next);
    },
  };
}

function NovelEditorBridge({ markdown, editorRef, onChangeRef, onReadyRef, onNoticeRef, sourceRef, dirtyRef, compatibilityRef, onCompatibilityChange }: BridgeProps) {
  const { editor } = useEditor();
  const initializedRef = useRef(false);
  const initialMarkdownRef = useRef(markdown);

  useEffect(() => {
    if (!editor) return undefined;
    const handle = createEditorHandle(editor, sourceRef, dirtyRef, compatibilityRef, onChangeRef, onCompatibilityChange);
    const readyCallback = onReadyRef.current;
    editorRef.current = handle;
    readyCallback?.(true);
    if (!initializedRef.current) {
      handle.setMarkdown(initialMarkdownRef.current);
      initializedRef.current = true;
    }
    return () => {
      if (editorRef.current === handle) editorRef.current = null;
      readyCallback?.(false);
    };
  }, [compatibilityRef, dirtyRef, editor, editorRef, onChangeRef, onCompatibilityChange, onReadyRef, sourceRef]);

  useEffect(() => {
    if (!editor || !initializedRef.current || markdown === sourceRef.current) return;
    const prepared = prepareMarkdownForNovel(markdown);
    compatibilityRef.current = prepared;
    onCompatibilityChange(prepared.replacements.length > 0);
    editor.commands.setContent(prepared.markdown, false);
    sourceRef.current = markdown;
    dirtyRef.current = false;
    if (prepared.replacements.length) onNoticeRef.current?.('部分历史 Markdown 语法以保护标记保留，保存时会恢复原文。');
  }, [compatibilityRef, dirtyRef, editor, markdown, onCompatibilityChange, onNoticeRef, sourceRef]);

  return null;
}

function captureFiles(event: React.ClipboardEvent<HTMLDivElement> | React.DragEvent<HTMLDivElement>, onFiles: ((files: File[]) => void) | undefined, onUnavailable: () => void) {
  const files = 'clipboardData' in event ? Array.from(event.clipboardData.files) : Array.from(event.dataTransfer.files);
  if (!files.length) return false;
  event.preventDefault();
  event.stopPropagation();
  if (onFiles) onFiles(files);
  else onUnavailable();
  return true;
}

export default function NovelMarkdownEditorClient({ markdown, editorRef, editorPortalElement, onChange, onFiles, onImageUpload, imageUploadUnavailableMessage, onError, onNotice, onReady, disabled = false }: NovelMarkdownEditorProps) {
  const onChangeRef = useRef(onChange);
  const onErrorRef = useRef(onError);
  const onNoticeRef = useRef(onNotice);
  const onReadyRef = useRef(onReady);
  const onFilesRef = useRef(onFiles);
  const onImageUploadRef = useRef(onImageUpload);
  const sourceRef = useRef(markdown);
  const dirtyRef = useRef(false);
  const [initialCompatibility] = useState(() => prepareMarkdownForNovel(markdown));
  const compatibilityRef = useRef<PreparedMarkdown>(initialCompatibility);
  const [hasProtectedContent, setHasProtectedContent] = useState(initialCompatibility.replacements.length > 0);
  const [imageDialogOpen, setImageDialogOpen] = useState(false);
  const [linkDialogOpen, setLinkDialogOpen] = useState(false);
  const imageInputID = useId();

  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);
  useEffect(() => { onErrorRef.current = onError; }, [onError]);
  useEffect(() => { onNoticeRef.current = onNotice; }, [onNotice]);
  useEffect(() => { onReadyRef.current = onReady; }, [onReady]);
  useEffect(() => { onFilesRef.current = onFiles; }, [onFiles]);
  useEffect(() => { onImageUploadRef.current = onImageUpload; }, [onImageUpload]);
  useEffect(() => {
    if (compatibilityRef.current.replacements.length) onNoticeRef.current?.('部分历史 Markdown 语法以保护标记保留，保存时会恢复原文。');
  }, []);

  const openImageDialog = useCallback((editor: EditorInstance, range?: Range) => {
    if (range) editor.chain().focus().deleteRange(range).run();
    setImageDialogOpen(true);
  }, []);
  const openLinkDialog = useCallback(() => setLinkDialogOpen(true), []);
  const chooseImageFile = useCallback(() => document.getElementById(imageInputID)?.click(), [imageInputID]);
  const suggestions = useMemo(() => buildNovelSuggestions(openImageDialog), [openImageDialog]);
  const extensions = useMemo(() => createNovelExtensions({ editorPortalElement, suggestions }), [editorPortalElement, suggestions]);

  const completeImageUpload = useCallback(async (file: File) => {
    const upload = onImageUploadRef.current;
    if (!upload) {
      onErrorRef.current?.('媒体存储尚未就绪，暂时无法插入图片');
      return;
    }
    try {
      // The shared upload pipeline inserts a temporary media:// reference
      // before the network request and replaces that mapped placeholder later.
      await upload(file);
    } catch (error) {
      onErrorRef.current?.(error instanceof Error ? error.message : '图片上传失败');
    }
  }, []);

  const handleMediaLinkClickCapture = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const anchor = (event.target as HTMLElement).closest('a');
    const source = anchor?.dataset.mediaSource || anchor?.getAttribute('href') || '';
    if (!anchor || !isSafeMediaReference(source)) return;
    event.preventDefault();
    event.stopPropagation();
    window.open(mediaContentUrl(source.slice('media://'.length), API), '_blank', 'noopener,noreferrer');
  }, []);

  const reportMediaUnavailable = useCallback(() => onErrorRef.current?.('媒体存储尚未就绪，暂时无法添加文件'), []);
  const handlePasteCapture = useCallback((event: React.ClipboardEvent<HTMLDivElement>) => { captureFiles(event, onFilesRef.current, reportMediaUnavailable); }, [reportMediaUnavailable]);
  const handleDropCapture = useCallback((event: React.DragEvent<HTMLDivElement>) => { captureFiles(event, onFilesRef.current, reportMediaUnavailable); }, [reportMediaUnavailable]);

  return (
    <div className="novel-editor-shell" onPasteCapture={handlePasteCapture} onDropCapture={handleDropCapture} onClickCapture={handleMediaLinkClickCapture} onDragOverCapture={event => {
      if (event.dataTransfer.types.includes('Files')) event.preventDefault();
    }}>
      {hasProtectedContent && <div className="novel-compat-notice" role="status">历史 HTML、脚注或项目指令已安全保留，保存时会恢复原始 Markdown。</div>}
      <input id={imageInputID} type="file" accept="image/*" hidden onChange={event => {
        const file = event.currentTarget.files?.[0];
        event.currentTarget.value = '';
        if (file) {
          setImageDialogOpen(false);
          void completeImageUpload(file);
        }
      }} />
      <EditorRoot>
        <EditorContent
          className="novel-editor-provider"
          extensions={extensions}
          initialContent={EMPTY_DOCUMENT}
          editorProps={EDITOR_PROPS}
          editorContainerProps={EDITOR_CONTAINER_PROPS}
          slotBefore={<NovelEditorToolbar disabled={disabled} imageDialogOpen={imageDialogOpen} linkDialogOpen={linkDialogOpen} onOpenImage={openImageDialog} onOpenLink={openLinkDialog} />}
          immediatelyRender={false}
          editable={!disabled}
          onUpdate={({ editor }) => {
            const next = restoreMarkdownFromNovel(editor.storage.markdown.getMarkdown(), compatibilityRef.current.replacements);
            dirtyRef.current = true;
            sourceRef.current = next;
            onChangeRef.current(next);
          }}
        >
          <NovelEditorBridge markdown={markdown} editorRef={editorRef} onChangeRef={onChangeRef} onReadyRef={onReadyRef} onNoticeRef={onNoticeRef} sourceRef={sourceRef} dirtyRef={dirtyRef} compatibilityRef={compatibilityRef} onCompatibilityChange={setHasProtectedContent} />
          <NovelEditorBubbleMenu editorPortalElement={editorPortalElement} onOpenLink={openLinkDialog} />
          <NovelEditorSlashMenu onOpenImage={openImageDialog} />
          {imageDialogOpen && <NovelImageDialog open uploadEnabled={Boolean(onImageUpload)} uploadMessage={`${imageUploadUnavailableMessage || '本地媒体存储暂不可用'}，仍可使用公开图片链接。`} editorPortalElement={editorPortalElement} onOpenChange={setImageDialogOpen} onChooseFile={chooseImageFile} />}
          {linkDialogOpen && <NovelLinkDialog open editorPortalElement={editorPortalElement} onOpenChange={setLinkDialogOpen} />}
        </EditorContent>
      </EditorRoot>
    </div>
  );
}
