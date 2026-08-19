import type { AdminEditorViewProps } from './AdminEditorView';
import type { useAdminEditorInfrastructure } from './useAdminEditorInfrastructure';
import type { useAdminEntryActions } from './useAdminEntryActions';
import type { useAdminPageMediaState } from './useAdminPageMediaState';

type Infrastructure = ReturnType<typeof useAdminEditorInfrastructure>;
type EntryActions = ReturnType<typeof useAdminEntryActions>;
type MediaState = ReturnType<typeof useAdminPageMediaState>;

export function buildAdminEditorViewProps(message: string, infrastructure: Infrastructure, mediaState: MediaState, actions: EntryActions): AdminEditorViewProps {
  const { editor, media, drafts, working } = infrastructure;
  const mediaStillProcessing = media.mediaStillProcessing || media.uploads.some(item => editor.markdown.includes(`media://${item.id}`));
  return {
    online: media.online,
    editingEntryID: working.editingEntryID,
    title: editor.title,
    summary: editor.summary,
    slug: editor.slug,
    kind: editor.kind,
    status: editor.status,
    categories: editor.categories,
    tags: editor.tags,
    date: editor.date,
    markdown: editor.markdown,
    message,
    saving: actions.saving,
    loadingEdit: working.loadingEdit,
    undoToken: actions.undoToken,
    uploadPanelOpen: media.uploadPanelOpen,
    dragActive: media.dragActive,
    mediaInputDisabled: mediaState.mediaInputDisabled,
    mediaAvailabilityMessage: mediaState.mediaAvailabilityMessage,
    mediaStillProcessing,
    workingCopyMeta: working.workingCopyMeta,
    discardingUnpublishedChanges: working.discardingUnpublishedChanges,
    drafts: drafts.drafts,
    uploads: media.uploads,
    editorRef: editor.editorRef,
    onToggleUploadPanel: mediaState.onToggleUploadPanel,
    onDiscardWorkingCopy: mediaState.onDiscardWorkingCopy,
    onTitleChange: editor.setTitle,
    onSummaryChange: editor.setSummary,
    onSlugChange: editor.setSlug,
    onMarkdownChange: mediaState.interactions.onMarkdownChange,
    onFiles: mediaState.interactions.onFiles,
    onImageUpload: media.uploadImageForEditor,
    onEditorError: mediaState.setMessage,
    onEditorNotice: mediaState.setMessage,
    onEditorReady: media.setEditorReady,
    onViewModeChange: media.handleEditorViewModeChange,
    onDragEnter: mediaState.interactions.onDragEnter,
    onDragOver: mediaState.interactions.onDragOver,
    onDragLeave: mediaState.interactions.onDragLeave,
    onDrop: mediaState.interactions.onDrop,
    onCancelUpload: media.cancelUpload,
    onRetryUpload: media.retryUpload,
    onRemoveUpload: media.removeUpload,
    onDateChange: editor.setDate,
    onKindChange: editor.setKind,
    onStatusChange: editor.setStatus,
    onCategoriesChange: editor.setCategories,
    onTagsChange: editor.setTags,
    onSave: actions.save,
    onUndo: actions.undo,
    onLoadDraft: working.loadDraft,
  };
}
