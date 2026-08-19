'use client';

import { useEffect, useState } from 'react';
import { API } from '@/lib/api';
import type { MdxEditorViewMode } from './MdxMarkdownEditor';
import type { MediaCapability } from './useMediaUploads';

const INITIAL_MEDIA_CAPABILITY: MediaCapability = {
  checked: false,
  provider: '',
  imageUploadEnabled: false,
  nonImageUploadEnabled: false,
  reason: '正在检查媒体存储…',
};

export function useAdminMediaCapability(refreshSessionCSRF: () => Promise<string>) {
  const [online, setOnline] = useState(true);
  const [editorReady, setEditorReady] = useState(false);
  const [editorViewMode, setEditorViewMode] = useState<MdxEditorViewMode>('rich-text');
  const [mediaCapability, setMediaCapability] = useState<MediaCapability>(INITIAL_MEDIA_CAPABILITY);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);

    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    void refreshSessionCSRF().catch(() => undefined);

    fetch(`${API}/admin/media/capability`, {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    }).then(async response => {
      const body = await response.json().catch(() => ({}));
      const writable = response.ok && body.writable === true;
      setMediaCapability({
        checked: true,
        provider: String(body.provider || ''),
        imageUploadEnabled: writable && body.imageUploadEnabled !== false,
        nonImageUploadEnabled: writable && body.nonImageUploadEnabled !== false,
        reason: writable ? '' : String(body.reason || '媒体存储不可写，上传已禁用'),
      });
    }).catch(() => setMediaCapability({
      checked: true,
      provider: '',
      imageUploadEnabled: false,
      nonImageUploadEnabled: false,
      reason: '无法检测媒体存储状态，上传已禁用',
    }));

    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, [refreshSessionCSRF]);

  return {
    online,
    editorReady,
    editorViewMode,
    mediaCapability,
    setEditorReady,
    setEditorViewMode,
  };
}
