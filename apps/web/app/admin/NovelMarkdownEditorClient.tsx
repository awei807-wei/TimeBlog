'use client';

import {
  Bold,
  Code2,
  Heading2,
  ImagePlus,
  Italic,
  Link as LinkIcon,
  List,
  ListChecks,
  ListOrdered,
  Minus,
  Quote,
  Table2,
  Type,
} from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState, type MutableRefObject, type RefObject } from 'react';
import type * as React from 'react';
import {
  EditorBubble,
  EditorBubbleItem,
  EditorCommand,
  EditorCommandEmpty,
  EditorCommandItem,
  EditorCommandList,
  EditorContent,
  EditorRoot,
  useEditor,
  type EditorInstance,
  type SuggestionItem,
} from 'novel';
import type { JSONContent, Range } from '@tiptap/core';
import { API } from '@/lib/api';
import { mediaContentUrl } from '@/lib/media-resolver';
import { isSafeMediaReference, prepareMarkdownForNovel, restoreMarkdownFromNovel, type PreparedMarkdown } from './markdown-compat';
import { createNovelExtensions } from './novel-editor-extensions';
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

function EditorBubbleMenu({ editorPortalRef }: { editorPortalRef?: RefObject<Element | null> }) {
  const { editor } = useEditor();
  if (!editor) return null;
  const appendTo = () => editorPortalRef?.current || document.body;
  const run = (command: () => boolean) => { command(); };
  return (
    <EditorBubble tippyOptions={{ appendTo, placement: 'top-start' }} className="novel-bubble-menu" aria-label="选区格式">
      <EditorBubbleItem asChild onSelect={instance => run(() => instance.chain().focus().toggleBold().run())}>
        <button type="button" aria-label="粗体" title="粗体"><Bold aria-hidden="true" /></button>
      </EditorBubbleItem>
      <EditorBubbleItem asChild onSelect={instance => run(() => instance.chain().focus().toggleItalic().run())}>
        <button type="button" aria-label="斜体" title="斜体"><Italic aria-hidden="true" /></button>
      </EditorBubbleItem>
      <EditorBubbleItem asChild onSelect={instance => run(() => instance.chain().focus().toggleCode().run())}>
        <button type="button" aria-label="行内代码" title="行内代码"><Code2 aria-hidden="true" /></button>
      </EditorBubbleItem>
      <EditorBubbleItem asChild onSelect={instance => run(() => instance.chain().focus().toggleBlockquote().run())}>
        <button type="button" aria-label="引用" title="引用"><Quote aria-hidden="true" /></button>
      </EditorBubbleItem>
      <EditorBubbleItem asChild onSelect={instance => {
        const href = window.prompt('链接地址');
        if (href) instance.chain().focus().setLink({ href }).run();
      }}>
        <button type="button" aria-label="插入链接" title="插入链接"><LinkIcon aria-hidden="true" /></button>
      </EditorBubbleItem>
    </EditorBubble>
  );
}

function EditorSlashMenu({ requestImage }: { requestImage: (editor: EditorInstance, range: Range) => void }) {
  return (
    <EditorCommand className="novel-command-menu" label="格式命令">
      <EditorCommandList>
        <EditorCommandEmpty>没有匹配的命令</EditorCommandEmpty>
        <EditorCommandItem value="paragraph" keywords={['正文', 'paragraph']} onCommand={({ editor, range }) => editor.chain().focus().deleteRange(range).setParagraph().run()}>
          <Type aria-hidden="true" /><span><strong>正文</strong><small>普通段落</small></span>
        </EditorCommandItem>
        <EditorCommandItem value="image" keywords={['图片', 'image']} onCommand={({ editor, range }) => requestImage(editor, range)}>
          <ImagePlus aria-hidden="true" /><span><strong>图片</strong><small>选择并上传图片</small></span>
        </EditorCommandItem>
        <EditorCommandItem value="task" keywords={['待办', '任务', 'task']} onCommand={({ editor, range }) => editor.chain().focus().deleteRange(range).toggleTaskList().run()}>
          <ListChecks aria-hidden="true" /><span><strong>待办</strong><small>勾选清单</small></span>
        </EditorCommandItem>
        <EditorCommandItem value="bullet" keywords={['无序', '列表', 'bullet']} onCommand={({ editor, range }) => editor.chain().focus().deleteRange(range).toggleBulletList().run()}>
          <List aria-hidden="true" /><span><strong>无序列表</strong><small>整理几项内容</small></span>
        </EditorCommandItem>
        <EditorCommandItem value="ordered" keywords={['有序', '编号', 'ordered']} onCommand={({ editor, range }) => editor.chain().focus().deleteRange(range).toggleOrderedList().run()}>
          <ListOrdered aria-hidden="true" /><span><strong>有序列表</strong><small>按步骤排列</small></span>
        </EditorCommandItem>
        <EditorCommandItem value="heading" keywords={['标题', 'heading']} onCommand={({ editor, range }) => editor.chain().focus().deleteRange(range).toggleHeading({ level: 2 }).run()}>
          <Heading2 aria-hidden="true" /><span><strong>标题</strong><small>二级标题</small></span>
        </EditorCommandItem>
        <EditorCommandItem value="quote" keywords={['引用', 'quote']} onCommand={({ editor, range }) => editor.chain().focus().deleteRange(range).toggleBlockquote().run()}>
          <Quote aria-hidden="true" /><span><strong>引用</strong><small>突出一段话</small></span>
        </EditorCommandItem>
        <EditorCommandItem value="code" keywords={['代码', 'code']} onCommand={({ editor, range }) => editor.chain().focus().deleteRange(range).toggleCodeBlock().run()}>
          <Code2 aria-hidden="true" /><span><strong>代码块</strong><small>保留等宽格式</small></span>
        </EditorCommandItem>
        <EditorCommandItem value="table" keywords={['表格', 'table']} onCommand={({ editor, range }) => editor.chain().focus().deleteRange(range).insertTable({ rows: 2, cols: 2, withHeaderRow: true }).run()}>
          <Table2 aria-hidden="true" /><span><strong>表格</strong><small>插入两行两列</small></span>
        </EditorCommandItem>
        <EditorCommandItem value="rule" keywords={['分隔线', 'divider', 'rule']} onCommand={({ editor, range }) => editor.chain().focus().deleteRange(range).setHorizontalRule().run()}>
          <Minus aria-hidden="true" /><span><strong>分隔线</strong><small>分隔两个段落</small></span>
        </EditorCommandItem>
      </EditorCommandList>
    </EditorCommand>
  );
}

function buildSuggestions(requestImage: (editor: EditorInstance, range: Range) => void): SuggestionItem[] {
  return [
    { title: '正文', description: '普通段落', icon: <Type aria-hidden="true" />, searchTerms: ['paragraph'], command: ({ editor, range }) => editor.chain().focus().deleteRange(range).setParagraph().run() },
    { title: '图片', description: '选择并上传图片', icon: <ImagePlus aria-hidden="true" />, searchTerms: ['image', 'picture'], command: ({ editor, range }) => requestImage(editor, range) },
    { title: '待办', description: '勾选清单', icon: <ListChecks aria-hidden="true" />, searchTerms: ['task', 'todo'], command: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleTaskList().run() },
    { title: '无序列表', description: '整理几项内容', icon: <List aria-hidden="true" />, searchTerms: ['bullet', 'list'], command: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleBulletList().run() },
    { title: '有序列表', description: '按步骤排列', icon: <ListOrdered aria-hidden="true" />, searchTerms: ['ordered', 'list'], command: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleOrderedList().run() },
    { title: '标题', description: '二级标题', icon: <Heading2 aria-hidden="true" />, searchTerms: ['heading'], command: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleHeading({ level: 2 }).run() },
    { title: '引用', description: '突出一段话', icon: <Quote aria-hidden="true" />, searchTerms: ['quote'], command: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleBlockquote().run() },
    { title: '代码块', description: '保留等宽格式', icon: <Code2 aria-hidden="true" />, searchTerms: ['code'], command: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleCodeBlock().run() },
    { title: '表格', description: '插入两行两列', icon: <Table2 aria-hidden="true" />, searchTerms: ['table'], command: ({ editor, range }) => editor.chain().focus().deleteRange(range).insertTable({ rows: 2, cols: 2, withHeaderRow: true }).run() },
    { title: '分隔线', description: '分隔两个段落', icon: <Minus aria-hidden="true" />, searchTerms: ['rule', 'divider'], command: ({ editor, range }) => editor.chain().focus().deleteRange(range).setHorizontalRule().run() },
  ];
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

export default function NovelMarkdownEditorClient({ markdown, editorRef, editorPortalRef, onChange, onFiles, onImageUpload, onError, onNotice, onReady, disabled = false }: NovelMarkdownEditorProps) {
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

  const requestImage = useCallback((editor: EditorInstance, range: Range) => {
    if (!onImageUpload) {
      onError?.('媒体存储尚未就绪，暂时无法插入图片');
      return;
    }
    editor.chain().focus().deleteRange(range).run();
    document.getElementById(imageInputID)?.click();
  }, [imageInputID, onError, onImageUpload]);
  const suggestions = useMemo(() => buildSuggestions(requestImage), [requestImage]);
  const extensions = useMemo(() => createNovelExtensions({ editorPortalRef, suggestions }), [editorPortalRef, suggestions]);

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
        if (file) void completeImageUpload(file);
      }} />
      <EditorRoot>
        <EditorContent
          className="novel-editor-content article-prose"
          extensions={extensions}
          initialContent={EMPTY_DOCUMENT}
          editorProps={EDITOR_PROPS}
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
          <EditorBubbleMenu editorPortalRef={editorPortalRef} />
          <EditorSlashMenu requestImage={requestImage} />
        </EditorContent>
      </EditorRoot>
    </div>
  );
}
