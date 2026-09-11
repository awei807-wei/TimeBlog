'use client';

import { useEffect, useReducer, type ReactNode } from 'react';
import {
  Bold,
  Code2,
  Heading2,
  ImagePlus,
  Italic,
  Link2,
  List,
  ListChecks,
  ListOrdered,
  Minus,
  Quote,
  Redo2,
  Table2,
  Undo2,
} from 'lucide-react';
import { useEditor, type EditorInstance } from 'novel';

type NovelEditorToolbarProps = {
  disabled?: boolean;
  imageDialogOpen: boolean;
  linkDialogOpen: boolean;
  onOpenImage: (editor: EditorInstance) => void;
  onOpenLink: (editor: EditorInstance) => void;
};

type ToolbarButtonProps = {
  label: string;
  active?: boolean;
  disabled?: boolean;
  primary?: boolean;
  expanded?: boolean;
  children: ReactNode;
  onClick: () => void;
};

function ToolbarButton({ label, active, disabled, primary, expanded, children, onClick }: ToolbarButtonProps) {
  return (
    <button
      type="button"
      className={`novel-toolbar-button${active ? ' is-active' : ''}${primary ? ' is-primary' : ''}`}
      aria-label={label}
      aria-pressed={active === undefined ? undefined : active}
      aria-haspopup={expanded === undefined ? undefined : 'dialog'}
      aria-expanded={expanded}
      title={label}
      disabled={disabled}
      onPointerDown={event => event.preventDefault()}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** A visible command surface complements slash and selection-only menus. */
export default function NovelEditorToolbar({ disabled = false, imageDialogOpen, linkDialogOpen, onOpenImage, onOpenLink }: NovelEditorToolbarProps) {
  const { editor } = useEditor();
  const [, refresh] = useReducer(value => value + 1, 0);

  useEffect(() => {
    if (!editor) return undefined;
    const update = () => refresh();
    editor.on('transaction', update);
    return () => {
      editor.off('transaction', update);
    };
  }, [editor]);

  if (!editor) return <div className="novel-toolbar" aria-hidden="true" />;

  const locked = disabled || !editor.isEditable;
  const linkActive = editor.isActive('link');
  const linkUnavailable = editor.state.selection.empty && !linkActive;
  const run = (command: () => boolean) => { command(); };

  return (
    <div className="novel-toolbar" role="toolbar" aria-label="正文编辑工具" aria-orientation="horizontal">
      <div className="novel-toolbar-scroll">
        <div className="novel-toolbar-group is-insert" role="group" aria-label="插入">
          <ToolbarButton label="插入图片" primary expanded={imageDialogOpen} disabled={locked} onClick={() => onOpenImage(editor)}>
            <ImagePlus aria-hidden="true" /><span>图片</span>
          </ToolbarButton>
        </div>
        <span className="novel-toolbar-separator" aria-hidden="true" />
        <div className="novel-toolbar-group" role="group" aria-label="历史记录">
          <ToolbarButton label="撤销" disabled={locked || !editor.can().undo()} onClick={() => run(() => editor.chain().focus().undo().run())}><Undo2 aria-hidden="true" /></ToolbarButton>
          <ToolbarButton label="重做" disabled={locked || !editor.can().redo()} onClick={() => run(() => editor.chain().focus().redo().run())}><Redo2 aria-hidden="true" /></ToolbarButton>
        </div>
        <span className="novel-toolbar-separator" aria-hidden="true" />
        <div className="novel-toolbar-group" role="group" aria-label="文字格式">
          <ToolbarButton label="二级标题" active={editor.isActive('heading', { level: 2 })} disabled={locked} onClick={() => run(() => editor.chain().focus().toggleHeading({ level: 2 }).run())}><Heading2 aria-hidden="true" /></ToolbarButton>
          <ToolbarButton label="粗体" active={editor.isActive('bold')} disabled={locked} onClick={() => run(() => editor.chain().focus().toggleBold().run())}><Bold aria-hidden="true" /></ToolbarButton>
          <ToolbarButton label="斜体" active={editor.isActive('italic')} disabled={locked} onClick={() => run(() => editor.chain().focus().toggleItalic().run())}><Italic aria-hidden="true" /></ToolbarButton>
          <ToolbarButton label={linkUnavailable ? '选择文字后添加链接' : '添加或编辑链接'} active={linkActive} expanded={linkDialogOpen} disabled={locked || linkUnavailable} onClick={() => onOpenLink(editor)}><Link2 aria-hidden="true" /></ToolbarButton>
        </div>
        <span className="novel-toolbar-separator" aria-hidden="true" />
        <div className="novel-toolbar-group" role="group" aria-label="列表与区块">
          <ToolbarButton label="无序列表" active={editor.isActive('bulletList')} disabled={locked} onClick={() => run(() => editor.chain().focus().toggleBulletList().run())}><List aria-hidden="true" /></ToolbarButton>
          <ToolbarButton label="有序列表" active={editor.isActive('orderedList')} disabled={locked} onClick={() => run(() => editor.chain().focus().toggleOrderedList().run())}><ListOrdered aria-hidden="true" /></ToolbarButton>
          <ToolbarButton label="待办清单" active={editor.isActive('taskList')} disabled={locked} onClick={() => run(() => editor.chain().focus().toggleTaskList().run())}><ListChecks aria-hidden="true" /></ToolbarButton>
          <ToolbarButton label="引用" active={editor.isActive('blockquote')} disabled={locked} onClick={() => run(() => editor.chain().focus().toggleBlockquote().run())}><Quote aria-hidden="true" /></ToolbarButton>
          <ToolbarButton label="代码块" active={editor.isActive('codeBlock')} disabled={locked} onClick={() => run(() => editor.chain().focus().toggleCodeBlock().run())}><Code2 aria-hidden="true" /></ToolbarButton>
          <ToolbarButton label="插入表格" disabled={locked} onClick={() => run(() => editor.chain().focus().insertTable({ rows: 2, cols: 2, withHeaderRow: true }).run())}><Table2 aria-hidden="true" /></ToolbarButton>
          <ToolbarButton label="插入分隔线" disabled={locked} onClick={() => run(() => editor.chain().focus().setHorizontalRule().run())}><Minus aria-hidden="true" /></ToolbarButton>
        </div>
      </div>
      <span className="novel-toolbar-scroll-hint" aria-hidden="true" />
    </div>
  );
}
