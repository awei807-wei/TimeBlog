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
  EditorCommand,
  EditorCommandEmpty,
  EditorCommandItem,
  EditorCommandList,
  useEditor,
  type EditorInstance,
  type SuggestionItem,
} from 'novel';
import type { Range } from '@tiptap/core';

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

export function NovelEditorSlashMenu({ onOpenImage }: { onOpenImage: ImageRequest }) {
  return (
    <EditorCommand className="novel-command-menu" label="格式命令">
      <EditorCommandList>
        <EditorCommandEmpty>没有匹配的命令</EditorCommandEmpty>
        <EditorCommandItem value="paragraph" keywords={['正文', 'paragraph']} onCommand={({ editor, range }) => editor.chain().focus().deleteRange(range).setParagraph().run()}>
          <Type aria-hidden="true" /><span><strong>正文</strong><small>普通段落</small></span>
        </EditorCommandItem>
        <EditorCommandItem value="image" keywords={['图片', '图床', '链接', '上传', 'image']} onCommand={({ editor, range }) => onOpenImage(editor, range)}>
          <ImagePlus aria-hidden="true" /><span><strong>图片</strong><small>上传图片或粘贴图床链接</small></span>
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

export function buildNovelSuggestions(onOpenImage: ImageRequest): SuggestionItem[] {
  return [
    { title: '正文', description: '普通段落', icon: <Type aria-hidden="true" />, searchTerms: ['paragraph'], command: ({ editor, range }) => editor.chain().focus().deleteRange(range).setParagraph().run() },
    { title: '图片', description: '上传图片或粘贴图床链接', icon: <ImagePlus aria-hidden="true" />, searchTerms: ['image', 'picture', 'url'], command: ({ editor, range }) => onOpenImage(editor, range) },
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
