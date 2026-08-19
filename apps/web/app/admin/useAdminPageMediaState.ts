'use client';

import { useCallback, type Dispatch, type SetStateAction } from 'react';
import { useAdminComposerInteractions } from './useAdminComposerInteractions';
import { useAdminEditorInfrastructure } from './useAdminEditorInfrastructure';

type Infrastructure = ReturnType<typeof useAdminEditorInfrastructure>;

export function useAdminPageMediaState(infrastructure: Infrastructure, setMessage: Dispatch<SetStateAction<string>>) {
  const { editor, media, working } = infrastructure;
  const mediaInputDisabled = (media.mediaCapability.checked && !media.mediaCapability.imageUploadEnabled && !media.mediaCapability.nonImageUploadEnabled) || !media.canInsertMedia;
  const mediaAvailabilityMessage = !media.editorReady
    ? '编辑器正在加载，请稍后再试'
    : !media.canInsertMedia
      ? '请切回所见即所得后添加媒体'
      : !media.mediaCapability.checked || mediaInputDisabled
        ? media.mediaCapability.reason
        : '本地媒体存储已就绪 · 图片与附件可上传';
  const interactions = useAdminComposerInteractions({ markdownRef: editor.markdownRef, setMarkdown: editor.setMarkdown, setDragActive: media.setDragActive, mediaInputDisabled, handleFiles: media.handleFiles });
  const setUploadPanelOpen = media.setUploadPanelOpen;
  const onToggleUploadPanel = useCallback(() => setUploadPanelOpen(open => !open), [setUploadPanelOpen]);
  const restorePublishedVersion = working.restorePublishedVersion;
  const onDiscardWorkingCopy = useCallback(() => { void restorePublishedVersion(); }, [restorePublishedVersion]);
  return { mediaInputDisabled, mediaAvailabilityMessage, interactions, onToggleUploadPanel, onDiscardWorkingCopy, setMessage };
}
