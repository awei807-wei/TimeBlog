'use client';

import { useRef, useState } from 'react';
import { Monitor, RotateCcw } from 'lucide-react';
import AdminEditorView, { type AdminEditorViewProps } from '../../admin/AdminEditorView';
import type { MarkdownEditorHandle } from '../../admin/editor-contract';
import type { Draft } from '../../admin/editor-storage';
import { EMPTY_WORKING_COPY_META } from '../../admin/editing-working-copy';

const INITIAL = {
  title: '写作工作台使用说明',
  summary: '工具在上方，资源在左侧，把中间的位置留给正文。',
  slug: '',
  markdown: '在这里写下生活、技术，还有那些当时不想忘记的事。\n\n## 一个更专注的写作空间\n\n选中文字后，可以使用上方的工具调整格式，也可以输入 / 打开快捷命令。切换到 Markdown，继续编辑同一篇内容。\n\n- 左侧资源：添加附件，找回最近草稿。\n- 中央文档：编辑标题、摘要和正文。\n- 右侧属性：设置日期、分类、标签与公开范围。\n\n> 这是本地界面预览。你可以自由修改，内容不会发布到博客。',
  kind: 'article',
  status: 'draft' as AdminEditorViewProps['status'],
  date: '2026-10-03',
  categories: [] as string[],
  tags: [] as string[],
};

function usePreviewEditor() {
  const [fields, setFields] = useState(INITIAL);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [message, setMessage] = useState('本地预览 · 修改不会发布');
  const editorRef = useRef<MarkdownEditorHandle | null>(null);
  const update = <Key extends keyof typeof INITIAL>(key: Key, value: (typeof INITIAL)[Key]) => setFields(current => ({ ...current, [key]: value }));
  const unavailable = () => setMessage('本地预览不连接媒体服务，请在登录后的写作页上传附件。');
  const save = () => {
    const id = crypto.randomUUID();
    setDrafts(current => [{ id, clientDraftId: id, payload: { ...fields }, updatedAt: new Date().toISOString() }, ...current].slice(0, 20));
    setMessage('已暂存到预览内存，刷新后重置；未发布到博客。');
  };
  const props: AdminEditorViewProps = {
    ...fields, drafts, editorRef, online: true, editingEntryID: '', saving: false, loadingEdit: false,
    message, undoToken: '', uploads: [], mediaStillProcessing: false, discardingUnpublishedChanges: false,
    categorySuggestions: [], tagSuggestions: [], workingCopyMeta: EMPTY_WORKING_COPY_META,
    mediaInputDisabled: true, imageUploadDisabled: true,
    mediaAvailabilityMessage: '预览模式不上传文件', imageUploadAvailabilityMessage: '预览模式不上传文件',
    onTitleChange: value => update('title', value), onSummaryChange: value => update('summary', value),
    onSlugChange: value => update('slug', value), onMarkdownChange: value => update('markdown', value),
    onDateChange: value => update('date', value), onKindChange: value => update('kind', value),
    onStatusChange: value => update('status', value), onCategoriesChange: value => update('categories', value),
    onTagsChange: value => update('tags', value), onFiles: unavailable,
    onImageUpload: async () => { throw new Error('预览模式不上传文件'); },
    onCancelUpload: unavailable, onRetryUpload: async () => unavailable(), onRemoveUpload: unavailable,
    onEditorError: setMessage, onEditorNotice: setMessage, onEditorReady: () => undefined,
    onSave: save, onUndo: () => setMessage('预览模式没有正式保存记录'),
    onDiscardWorkingCopy: () => setFields(INITIAL),
    onLoadDraft: draft => { setFields(draft.payload as typeof INITIAL); setMessage('已打开预览草稿，未访问真实草稿库。'); },
  };
  return { props, reset: () => { setFields(INITIAL); setDrafts([]); setMessage('已恢复预览示例'); } };
}

/** 使用真实组件和内存状态预览，不调用认证、草稿或媒体业务接口。 */
export default function WritingPreview() {
  const { props, reset } = usePreviewEditor();
  return (
    <>
      <div className="writing-preview-notice">
        <span><Monitor aria-hidden="true" />本地布局预览<span className="writing-preview-detail"> · 不连接生产服务，刷新后重置</span></span>
        <button type="button" onClick={reset}><RotateCcw aria-hidden="true" />恢复示例</button>
      </div>
      <div className="app-content"><AdminEditorView {...props} /></div>
    </>
  );
}
