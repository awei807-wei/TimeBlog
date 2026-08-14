'use client';

import {
  BlockTypeSelect,
  BoldItalicUnderlineToggles,
  CreateLink,
  DiffSourceToggleWrapper,
  InsertCodeBlock,
  InsertImage,
  InsertTable,
  ListsToggle,
  MDXEditor,
  Separator,
  UndoRedo,
  codeBlockPlugin,
  codeMirrorPlugin,
  diffSourcePlugin,
  headingsPlugin,
  imagePlugin,
  linkDialogPlugin,
  linkPlugin,
  listsPlugin,
  markdownShortcutPlugin,
  quotePlugin,
  tablePlugin,
  thematicBreakPlugin,
  toolbarPlugin,
  useCellValue,
  viewMode$,
  type ViewMode,
  type MDXEditorMethods,
} from '@mdxeditor/editor';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import type * as React from 'react';
import { API } from '@/lib/api';
import { mediaContentUrl } from '@/lib/media-resolver';
import { MEDIA_MODE_HINT, type MdxMarkdownEditorProps } from './MdxMarkdownEditor';
import { mediaLinkPlugin } from './media-link-plugin';

const TRANSLATIONS: Record<string, string> = {
  'toolbar.richText': '所见即所得',
  'toolbar.source': 'Markdown 源码',
  'toolbar.diffMode': '差异对比',
  'toolbar.undo': '撤销',
  'toolbar.redo': '重做',
  'toolbar.bold': '粗体',
  'toolbar.italic': '斜体',
  'toolbar.underline': '下划线',
  'toolbar.createLink': '插入链接',
  'toolbar.insertImage': '插入图片',
  'toolbar.insertTable': '插入表格',
  'toolbar.insertCodeBlock': '插入代码块',
};

function localize(key: string, defaultValue: string) {
  return TRANSLATIONS[key] || defaultValue;
}

function ViewModeBridge({ onChange }: { onChange: (viewMode: ViewMode) => void }) {
  const viewMode = useCellValue(viewMode$);

  useEffect(() => {
    onChange(viewMode);
  }, [onChange, viewMode]);

  return null;
}

export default function MdxMarkdownEditorClient({
  markdown,
  editorRef,
  onChange,
  onFiles,
  onImageUpload,
  onError,
  onReady,
  onViewModeChange,
  disabled = false,
}: MdxMarkdownEditorProps) {
  const onChangeRef = useRef(onChange);
  const onErrorRef = useRef(onError);
  const onFilesRef = useRef(onFiles);
  const onImageUploadRef = useRef(onImageUpload);
  const onReadyRef = useRef(onReady);
  const onViewModeChangeRef = useRef(onViewModeChange);
  const viewModeRef = useRef<ViewMode>('rich-text');
  const markdownRef = useRef(markdown);

  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);
  useEffect(() => { onErrorRef.current = onError; }, [onError]);
  useEffect(() => { onFilesRef.current = onFiles; }, [onFiles]);
  useEffect(() => { onImageUploadRef.current = onImageUpload; }, [onImageUpload]);
  useEffect(() => { onReadyRef.current = onReady; }, [onReady]);
  useEffect(() => { onViewModeChangeRef.current = onViewModeChange; }, [onViewModeChange]);

  const setEditorRef = useCallback((methods: MDXEditorMethods | null) => {
    editorRef.current = methods;
    onReadyRef.current?.(methods !== null);
  }, [editorRef]);

  const handleViewModeChange = useCallback((viewMode: ViewMode) => {
    viewModeRef.current = viewMode;
    onViewModeChangeRef.current?.(viewMode);
  }, []);

  const imageUploadHandler = useCallback(async (file: File) => {
    const upload = onImageUploadRef.current;
    if (!upload) throw new Error('媒体上传未就绪');
    return upload(file);
  }, []);

  const plugins = useMemo(() => [
    headingsPlugin(),
    listsPlugin(),
    quotePlugin(),
    thematicBreakPlugin(),
    markdownShortcutPlugin(),
    linkPlugin(),
    mediaLinkPlugin(),
    linkDialogPlugin(),
    tablePlugin(),
    codeBlockPlugin(),
    codeMirrorPlugin({
      codeBlockLanguages: {
        text: '纯文本',
        markdown: 'Markdown',
        javascript: 'JavaScript',
        typescript: 'TypeScript',
        json: 'JSON',
        css: 'CSS',
        html: 'HTML',
      },
      autoLoadLanguageSupport: true,
    }),
    // The upload callback reads the latest parent handler only when the user
    // opens the image dialog; it must remain stable so the Lexical realm is
    // not recreated on every keystroke.
    // eslint-disable-next-line react-hooks/refs
    imagePlugin({
      imageUploadHandler,
      imagePreviewHandler: async (source: string) => {
        if (!source.startsWith('media://')) return source;
        return mediaContentUrl(source.slice('media://'.length), API);
      },
    }),
    diffSourcePlugin({ viewMode: 'rich-text' }),
    toolbarPlugin({
      toolbarContents: () => (
        <>
          <ViewModeBridge onChange={handleViewModeChange} />
          <DiffSourceToggleWrapper options={['rich-text', 'source']}>
            <UndoRedo />
            <Separator />
            <BlockTypeSelect />
            <BoldItalicUnderlineToggles />
            <ListsToggle options={['bullet', 'number', 'check']} />
            <CreateLink />
            <InsertImage />
            <InsertTable />
            <InsertCodeBlock />
          </DiffSourceToggleWrapper>
        </>
      ),
    }),
  ], [handleViewModeChange, imageUploadHandler]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    if (markdown !== markdownRef.current) {
      editor.setMarkdown(markdown);
      markdownRef.current = markdown;
    }
  }, [editorRef, markdown]);

  const handleChange = (next: string) => {
    markdownRef.current = next;
    onChangeRef.current(next);
  };

  const handlePasteCapture = (event: React.ClipboardEvent<HTMLDivElement>) => {
    const files = Array.from(event.clipboardData.files);
    if (!files.length) return;
    if (viewModeRef.current !== 'rich-text') {
      event.preventDefault();
      event.stopPropagation();
      onErrorRef.current?.(MEDIA_MODE_HINT);
      return;
    }
    if (!onFilesRef.current || files.every(file => file.type.startsWith('image/'))) return;
    event.preventDefault();
    event.stopPropagation();
    onFilesRef.current(files);
  };

  const handleDropCapture = (event: React.DragEvent<HTMLDivElement>) => {
    const files = Array.from(event.dataTransfer.files);
    if (!files.length) return;
    if (viewModeRef.current !== 'rich-text') {
      event.preventDefault();
      event.stopPropagation();
      onErrorRef.current?.(MEDIA_MODE_HINT);
      return;
    }
    if (!onFilesRef.current || files.every(file => file.type.startsWith('image/'))) return;
    event.preventDefault();
    event.stopPropagation();
    onFilesRef.current(files);
  };

  const handleMediaLinkClickCapture = (event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const anchor = target.closest('a');
    const source = anchor?.getAttribute('href') || '';
    if (!source.startsWith('media://')) return;
    event.preventDefault();
    window.open(mediaContentUrl(source.slice('media://'.length), API), '_blank', 'noopener,noreferrer');
  };

  return (
    <div
      className="mdx-editor-shell"
      onPasteCapture={handlePasteCapture}
      onDropCapture={handleDropCapture}
      onClickCapture={handleMediaLinkClickCapture}
      onDragOverCapture={event => {
        if (!event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
      }}
      aria-label="Markdown 正文编辑器"
    >
      <MDXEditor
        ref={setEditorRef}
        markdown={markdown}
        plugins={plugins}
        onChange={handleChange}
        onError={({ error }) => onErrorRef.current?.(`Markdown 解析失败：${error}`)}
        translation={localize}
        readOnly={disabled}
        spellCheck
        placeholder="从一句话开始。支持 Markdown、图片和附件。"
        trim={false}
        contentEditableClassName="mdx-editor-content"
        className="mdx-editor"
      />
    </div>
  );
}
