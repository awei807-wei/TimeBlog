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
import {
  EditorBubble,
  EditorBubbleItem,
  useEditor,
  type EditorInstance,
  type SuggestionItem,
} from 'novel';
import type { Range } from '@tiptap/core';
import { Command as CommandMenu } from 'cmdk';

type ImageRequest = (editor: EditorInstance, range?: Range) => void;
type LinkRequest = (editor: EditorInstance) => void;

export function NovelEditorBubbleMenu({ editorPortalElement, onOpenLink }: { editorPortalElement?: Element | null; onOpenLink: LinkRequest }) {
  const { editor } = useEditor();
  if (!editor) return null;
  const appendTo = () => editorPortalElement || document.body;
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
      <EditorBubbleItem asChild onSelect={onOpenLink}>
        <button type="button" aria-label="添加或编辑链接" title="添加或编辑链接"><LinkIcon aria-hidden="true" /></button>
      </EditorBubbleItem>
    </EditorBubble>
  );
}

export type NovelSlashMenuProps = {
  items: SuggestionItem[];
  query: string;
  onCommand: (item: SuggestionItem) => void;
  onDismiss: () => void;
  isComposing: () => boolean;
};

/** cmdk is Novel's existing menu UI; props replace its document-global atoms. */
export function NovelEditorSlashMenu({ items, query, onCommand, onDismiss, isComposing }: NovelSlashMenuProps) {
  return (
    <CommandMenu className="novel-command-menu" label="格式命令" data-query={query}
      onMouseDown={event => event.preventDefault()}
      onKeyDownCapture={event => {
        // Stop before cmdk's own handler, without cancelling native IME behavior.
        if (isComposing() || event.nativeEvent.isComposing || event.keyCode === 229) event.stopPropagation();
      }}
      onKeyDown={event => {
        event.stopPropagation();
        if (isComposing() || event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === 'Escape') {
          event.preventDefault();
          onDismiss();
        }
      }}>
      <CommandMenu.Input value={query} readOnly style={{ display: 'none' }} />
      <CommandMenu.List>
        <CommandMenu.Empty>没有匹配的命令</CommandMenu.Empty>
        {items.map(item => (
          <CommandMenu.Item key={item.title} value={item.title} keywords={item.searchTerms} onSelect={() => onCommand(item)}>
            {item.icon}<span><strong>{item.title}</strong><small>{item.description}</small></span>
          </CommandMenu.Item>
        ))}
      </CommandMenu.List>
    </CommandMenu>
  );
}

export function buildNovelSuggestions(onOpenImage: ImageRequest): SuggestionItem[] {
  return [
    { title: '正文', description: '普通段落', icon: <Type aria-hidden="true" />, searchTerms: ['paragraph'], command: ({ editor, range }) => editor.chain().focus().deleteRange(range).setParagraph().run() },
    { title: '图片', description: '上传图片或粘贴图床链接', icon: <ImagePlus aria-hidden="true" />, searchTerms: ['图床', '链接', '上传', 'image', 'picture', 'url'], command: ({ editor, range }) => onOpenImage(editor, range) },
    { title: '待办', description: '勾选清单', icon: <ListChecks aria-hidden="true" />, searchTerms: ['任务', 'task', 'todo'], command: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleTaskList().run() },
    { title: '无序列表', description: '整理几项内容', icon: <List aria-hidden="true" />, searchTerms: ['bullet', 'list'], command: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleBulletList().run() },
    { title: '有序列表', description: '按步骤排列', icon: <ListOrdered aria-hidden="true" />, searchTerms: ['编号', 'ordered', 'list'], command: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleOrderedList().run() },
    { title: '标题', description: '二级标题', icon: <Heading2 aria-hidden="true" />, searchTerms: ['heading'], command: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleHeading({ level: 2 }).run() },
    { title: '引用', description: '突出一段话', icon: <Quote aria-hidden="true" />, searchTerms: ['quote'], command: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleBlockquote().run() },
    { title: '代码块', description: '保留等宽格式', icon: <Code2 aria-hidden="true" />, searchTerms: ['code'], command: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleCodeBlock().run() },
    { title: '表格', description: '插入两行两列', icon: <Table2 aria-hidden="true" />, searchTerms: ['table'], command: ({ editor, range }) => editor.chain().focus().deleteRange(range).insertTable({ rows: 2, cols: 2, withHeaderRow: true }).run() },
    { title: '分隔线', description: '分隔两个段落', icon: <Minus aria-hidden="true" />, searchTerms: ['rule', 'divider'], command: ({ editor, range }) => editor.chain().focus().deleteRange(range).setHorizontalRule().run() },
  ];
}
