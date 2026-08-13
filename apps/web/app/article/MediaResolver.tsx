'use client';

import { useEffect, useRef } from 'react';
import { API } from '@/lib/api';
import { mediaContentUrl, mediaKind, probeMediaContentType } from '@/lib/media-resolver';

export type MediaPreviewMetadata = {
  fileName?: string;
  mime?: string;
  size?: number;
  status?: 'queued' | 'uploading' | 'ready' | 'failed';
};

function mediaLabel(node: HTMLElement, id: string) {
  return node.dataset.mediaLabel || node.textContent?.trim() || `媒体 ${id}`;
}

function formatBytes(value?: number) {
  if (!Number.isFinite(value) || value === undefined) return '';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function unavailable(label: string) {
  const node = document.createElement('span');
  node.className = 'media-reference media-unavailable';
  node.setAttribute('role', 'status');
  node.textContent = `媒体暂不可用或需要登录：${label}`;
  return node;
}

function pending(label: string) {
  const node = document.createElement('span');
  node.className = 'media-reference media-pending';
  node.setAttribute('role', 'status');
  node.textContent = `正在准备媒体：${label}`;
  return node;
}

function resolvedElement(kind: ReturnType<typeof mediaKind>, url: string, label: string, metadata?: MediaPreviewMetadata) {
  if (kind === 'image') {
    const figure = document.createElement('figure');
    figure.className = 'resolved-image-card';
    const image = document.createElement('img');
    image.className = 'resolved-media resolved-image';
    image.crossOrigin = 'use-credentials';
    image.src = url;
    image.alt = label;
    image.loading = 'lazy';
    image.decoding = 'async';
    image.addEventListener('error', () => figure.replaceWith(unavailable(label)), { once: true });
    figure.append(image);
    if (label) {
      const caption = document.createElement('figcaption');
      caption.textContent = label;
      figure.append(caption);
    }
    return figure;
  }
  if (kind === 'audio') {
    const audio = document.createElement('audio');
    audio.className = 'resolved-media resolved-audio';
    audio.controls = true;
    audio.preload = 'metadata';
    audio.crossOrigin = 'use-credentials';
    audio.src = url;
    audio.setAttribute('aria-label', label);
    audio.addEventListener('error', () => audio.replaceWith(unavailable(label)), { once: true });
    return audio;
  }
  if (kind === 'video') {
    const video = document.createElement('video');
    video.className = 'resolved-media resolved-video';
    video.controls = true;
    video.preload = 'metadata';
    video.playsInline = true;
    video.crossOrigin = 'use-credentials';
    video.src = url;
    video.setAttribute('aria-label', label);
    video.addEventListener('error', () => video.replaceWith(unavailable(label)), { once: true });
    return video;
  }
  const card = document.createElement('div');
  card.className = 'resolved-file-card';
  const info = document.createElement('div');
  info.className = 'resolved-file-info';
  const name = document.createElement('strong');
  name.textContent = label;
  const details = document.createElement('span');
  details.textContent = [metadata?.mime || (kind === 'pdf' ? 'application/pdf' : '媒体附件'), formatBytes(metadata?.size)].filter(Boolean).join(' · ');
  info.append(name, details);
  const link = document.createElement('a');
  link.className = 'resolved-file-link';
  link.href = url;
  link.target = '_blank';
  link.rel = 'noreferrer noopener';
  link.download = label;
  link.textContent = kind === 'pdf' ? '打开 / 下载 PDF' : '打开 / 下载';
  card.append(info, link);
  return card;
}

export default function MediaResolver({ html, metadata = {} }: { html: string; metadata?: Record<string, MediaPreviewMetadata> }) {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    const controller = new AbortController();
    let cancelled = false;
    const placeholders = Array.from(root.querySelectorAll<HTMLElement>('[data-media-id]'));
    for (const placeholder of placeholders) {
      const id = placeholder.dataset.mediaId;
      if (!id) continue;
      const itemMetadata = metadata[id];
      const label = mediaLabel(placeholder, id);
      if (itemMetadata?.status === 'queued' || itemMetadata?.status === 'uploading') {
        placeholder.replaceWith(pending(label));
        continue;
      }
      if (itemMetadata?.status === 'failed') {
        placeholder.replaceWith(unavailable(label));
        continue;
      }
      const url = mediaContentUrl(id, API);
      const mimePromise = itemMetadata?.mime ? Promise.resolve(itemMetadata.mime) : probeMediaContentType(url, (input, init = {}) => fetch(input, { ...init, signal: controller.signal }));
      void mimePromise.then(mime => {
        if (cancelled || !placeholder.isConnected) return;
        placeholder.replaceWith(resolvedElement(mediaKind(mime || itemMetadata?.mime || placeholder.dataset.mediaKind || ''), url, label, itemMetadata));
      }).catch(() => {
        if (cancelled || !placeholder.isConnected) return;
        placeholder.replaceWith(unavailable(label));
      });
    }
    return () => { cancelled = true; controller.abort(); };
  }, [html, metadata]);

  return <div ref={rootRef} dangerouslySetInnerHTML={{ __html: html }} />;
}
