'use client';

import { useCallback, type Dispatch, type SetStateAction } from 'react';
import { useAdminComposerInteractions } from './useAdminComposerInteractions';
import { useAdminEditorInfrastructure } from './useAdminEditorInfrastructure';

type Infrastructure = ReturnType<typeof useAdminEditorInfrastructure>;

export function useAdminPageMediaState(infrastructure: Infrastructure, setMessage: Dispatch<SetStateAction<string>>) {
  const { editor, media, working } = infrastructure;
  const mediaInputDisabled = !media.editorReady || !media.mediaCapability.checked || (!media.mediaCapability.imageUploadEnabled && !media.mediaCapability.nonImageUploadEnabled);
  const imageUploadDisabled = !media.editorReady || !media.mediaCapability.checked || !media.mediaCapability.imageUploadEnabled;
  const imageStorageMessage = editor.status === 'private' ? '私人图片仅保存在本地' : media.mediaCapability.externalImageUploadEnabled ? '图片优先发布到图床 · 本地原件保留' : '本地图片存储已就绪';
  const mediaAvailabilityMessage = !media.editorReady
    ? '编辑器正在加载，请稍后再试'
    : !media.mediaCapability.checked
      ? '正在检查媒体存储…'
      : mediaInputDisabled
        ? media.mediaCapability.reason
        : media.mediaCapability.imageUploadEnabled && media.mediaCapability.nonImageUploadEnabled
          ? `${imageStorageMessage} · 附件可上传`
          : media.mediaCapability.imageUploadEnabled
            ? `${imageStorageMessage} · 附件上传暂不可用`
            : '附件存储已就绪 · 本地图片上传暂不可用';
  const imageUploadAvailabilityMessage = !media.editorReady
    ? '编辑器正在加载，请稍后再试'
    : !media.mediaCapability.checked
      ? '正在检查本地图片存储…'
      : imageUploadDisabled
        ? media.mediaCapability.reason || '本地图片上传暂不可用'
        : imageStorageMessage;
  const interactions = useAdminComposerInteractions({ markdownRef: editor.markdownRef, setMarkdown: editor.setMarkdown, mediaInputDisabled, handleFiles: media.handleFiles });
  const restorePublishedVersion = working.restorePublishedVersion;
  const onDiscardWorkingCopy = useCallback(() => { void restorePublishedVersion(); }, [restorePublishedVersion]);
  return { mediaInputDisabled, imageUploadDisabled, mediaAvailabilityMessage, imageUploadAvailabilityMessage, interactions, onDiscardWorkingCopy, setMessage };
}
