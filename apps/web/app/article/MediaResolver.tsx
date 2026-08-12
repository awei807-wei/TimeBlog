'use client';

import { useEffect, useRef } from 'react';
import { API } from '@/lib/api';
import { mediaContentUrl, mediaKind, probeMediaContentType } from '@/lib/media-resolver';

function mediaLabel(node: HTMLElement, id: string) {
  return node.dataset.mediaLabel || node.textContent?.trim() || `媒体 ${id}`;
}

function unavailable(label: string) {
  const node = document.createElement('span');
  node.className = 'media-reference media-unavailable';
  node.setAttribute('role', 'status');
  node.textContent = `媒体暂不可用或需要登录：${label}`;
  return node;
}

function resolvedElement(kind: ReturnType<typeof mediaKind>, url: string, label: string) {
  if (kind === 'image') {
    const image = document.createElement('img');
    image.className = 'resolved-media resolved-image';
    image.src = url;
    image.alt = label;
    image.loading = 'lazy';
    image.decoding = 'async';
    image.crossOrigin = 'use-credentials';
    image.addEventListener('error', () => image.replaceWith(unavailable(label)), { once: true });
    return image;
  }
  if (kind === 'audio') {
    const audio = document.createElement('audio');
    audio.className = 'resolved-media resolved-audio';
    audio.controls = true;
    audio.preload = 'metadata';
    audio.src = url;
    audio.setAttribute('aria-label', label);
    audio.crossOrigin = 'use-credentials';
    audio.addEventListener('error', () => audio.replaceWith(unavailable(label)), { once: true });
    return audio;
  }
  if (kind === 'video') {
    const video = document.createElement('video');
    video.className = 'resolved-media resolved-video';
    video.controls = true;
    video.preload = 'metadata';
    video.playsInline = true;
    video.src = url;
    video.setAttribute('aria-label', label);
    video.crossOrigin = 'use-credentials';
    video.addEventListener('error', () => video.replaceWith(unavailable(label)), { once: true });
    return video;
  }
  const link = document.createElement('a');
  link.className = 'resolved-media resolved-file';
  link.href = url;
  link.target = '_blank';
  link.rel = 'noreferrer noopener';
  link.textContent = kind === 'pdf' ? `打开 PDF：${label}` : `打开媒体文件：${label}`;
  return link;
}

export default function MediaResolver({ html }: { html: string }) {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    let cancelled = false;
    const placeholders = Array.from(root.querySelectorAll<HTMLElement>('[data-media-id]'));
    for (const placeholder of placeholders) {
      const id = placeholder.dataset.mediaId;
      if (!id) continue;
      const label = mediaLabel(placeholder, id);
      const url = mediaContentUrl(id, API);
      void probeMediaContentType(url).then(mime => {
        if (cancelled || !placeholder.isConnected) return;
        placeholder.replaceWith(resolvedElement(mediaKind(mime), url, label));
      }).catch(() => {
        if (cancelled || !placeholder.isConnected) return;
        placeholder.replaceWith(unavailable(label));
      });
    }
    return () => { cancelled = true; };
  }, [html]);

  return <div ref={rootRef} dangerouslySetInnerHTML={{ __html: html }} />;
}
