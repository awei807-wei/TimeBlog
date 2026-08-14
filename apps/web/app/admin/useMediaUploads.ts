'use client';

import { useCallback, useMemo, useRef, useState, type MutableRefObject, type RefObject } from 'react';
import type { MDXEditorMethods } from '@mdxeditor/editor';
import { API } from '@/lib/api';
import { createUploadItem, isSupportedMedia, mediaMarkdownReference, mediaUploadUrl, removeMediaReferences, replaceMediaOccurrence, uploadResumable, MAX_MEDIA_BYTES, type UploadItem } from '@/lib/media-utils';
import { dbDelete, dbGetAll, MEDIA_QUEUE_STORE, persistMediaQueueItem } from './editor-storage';

export type MediaCapability = {
  checked: boolean;
  provider: string;
  imageUploadEnabled: boolean;
  nonImageUploadEnabled: boolean;
  reason: string;
};

type EditorStatus = 'draft' | 'public' | 'private';
type ResponseError = (response: Response, fallback: string) => Promise<Error>;

type UseMediaUploadsOptions = {
  editorRef: RefObject<MDXEditorMethods | null>;
  markdownRef: MutableRefObject<string>;
  csrfRef: MutableRefObject<string>;
  csrf: string;
  status: EditorStatus;
  mediaCapability: MediaCapability;
  refreshSessionCSRF: () => Promise<string>;
  insertMediaReference: (reference: string) => string;
  applyMarkdown: (next: string) => void;
  responseError: ResponseError;
  onMessage: (message: string) => void;
};

type UploadOptions = { insertReference?: boolean; rejectOnError?: boolean };

type UploadTicket = { media: { id: string }; uploadUrl: string; finalizeUrl?: string };

type UploadExecution = {
  file: File;
  item: UploadItem;
  sessionCsrf: string;
  visibility: 'public' | 'private';
  responseError: ResponseError;
  controller: AbortController;
  onTicket: (mediaId: string) => void;
  onProgress: (progress: number) => void;
};

async function executeUpload({ file, item, sessionCsrf, visibility, responseError, controller, onTicket, onProgress }: UploadExecution): Promise<{ mediaId: string; reference: string }> {
  const ticketResponse = await fetch(`${API}/admin/media/upload-ticket`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': sessionCsrf, 'Idempotency-Key': item.id }, body: JSON.stringify({ name: file.name, size: file.size, mime: file.type, visibility }), signal: controller.signal });
  if (!ticketResponse.ok) throw await responseError(ticketResponse, '创建上传任务失败');
  const ticket = await ticketResponse.json() as UploadTicket;
  onTicket(ticket.media.id);
  const uploadUrl = mediaUploadUrl(ticket.uploadUrl, window.location.origin);
  if (ticket.finalizeUrl) await uploadResumable(uploadUrl, file, { csrfToken: sessionCsrf, idempotencyKey: item.id, signal: controller.signal, onProgress });
  const finalizeUrl = ticket.finalizeUrl ? mediaUploadUrl(ticket.finalizeUrl, window.location.origin) : uploadUrl;
  const finalize = await fetch(finalizeUrl, { method: 'POST', credentials: 'include', headers: { 'X-CSRF-Token': sessionCsrf, 'Idempotency-Key': item.id }, ...(ticket.finalizeUrl ? {} : { body: file, headers: { 'X-CSRF-Token': sessionCsrf, 'Idempotency-Key': item.id, 'Content-Type': 'application/octet-stream' } }), signal: controller.signal });
  if (!finalize.ok) throw await responseError(finalize, '完成上传失败');
  return { mediaId: ticket.media.id, reference: mediaMarkdownReference(ticket.media.id, file.name, file.type) };
}

type UseMediaUploadsResult = {
  uploads: UploadItem[];
  mediaStillProcessing: boolean;
  uploadMedia: (file: File, existingId?: string, existingReference?: string, options?: UploadOptions) => Promise<string>;
  uploadImageForEditor: (file: File) => Promise<string>;
  retryUpload: (item: UploadItem, file?: File) => Promise<void>;
  handleFiles: (files: FileList | File[]) => void;
  cancelUpload: (item: UploadItem) => void;
  removeUpload: (item: UploadItem) => void;
  recoverUploads: () => Promise<void>;
};

/** Owns the media queue, resumable upload lifecycle, and editor media actions. */
export function useMediaUploads({ editorRef, markdownRef, csrfRef, csrf, status, mediaCapability, refreshSessionCSRF, insertMediaReference, applyMarkdown, responseError, onMessage }: UseMediaUploadsOptions): UseMediaUploadsResult {
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const cancelledUploads = useRef<Set<string>>(new Set());
  const uploadControllers = useRef<Map<string, AbortController>>(new Map());

  const removeMediaToken = useCallback((source: string, item: UploadItem) => {
    let next = removeMediaReferences(source, item.id);
    if (item.mediaId) next = removeMediaReferences(next, item.mediaId);
    return next.replace(/\n{3,}/g, '\n\n').trimStart();
  }, []);

  const deleteServerMedia = useCallback(async (mediaId: string) => {
    const requestCsrf = csrfRef.current || csrf;
    if (!requestCsrf || !mediaId) return;
    try {
      const response = await fetch(`${API}/admin/media/${encodeURIComponent(mediaId)}`, { method: 'DELETE', credentials: 'include', headers: { 'X-CSRF-Token': requestCsrf } });
      if (!response.ok && response.status !== 404 && response.status !== 409) onMessage('附件已从草稿移除，但服务器清理未完成');
    } catch {
      onMessage('附件已从草稿移除，但服务器清理未完成');
    }
  }, [csrf, csrfRef, onMessage]);

  const uploadMedia = useCallback(async (file: File, existingId?: string, existingReference?: string, options: UploadOptions = {}): Promise<string> => {
    const insertReference = options.insertReference !== false;
    const rejectOnError = options.rejectOnError === true;
    const reject = (message: string) => {
      onMessage(message);
      if (rejectOnError) throw new Error(message);
      return '';
    };
    if (!isSupportedMedia(file)) return reject(`仅支持 ${Math.round(MAX_MEDIA_BYTES / 1024 / 1024)}MiB 以内的图片、音频、视频或 PDF；断点续传由后端 uploadUrl 能力决定`);
    if (!mediaCapability.checked) return reject('正在检查媒体存储，请稍后再试');
    if (file.type.startsWith('image/') && !mediaCapability.imageUploadEnabled) return reject(mediaCapability.reason || '图片上传暂不可用，请先配置可写的媒体存储');
    if (!file.type.startsWith('image/') && !mediaCapability.nonImageUploadEnabled) return reject(mediaCapability.reason || '媒体上传暂不可用，请先配置可写的媒体存储');

    const item = createUploadItem(file, existingId);
    const reference = existingId && existingReference ? existingReference : mediaMarkdownReference(item.id, file.name, file.type);
    const itemWithReference: UploadItem = { ...item, markdownReference: reference };
    cancelledUploads.current.delete(item.id);
    const controller = new AbortController();
    let serverMediaId = '';
    uploadControllers.current.set(item.id, controller);
    setUploads(current => current.some(value => value.id === item.id) ? current.map(value => value.id === item.id ? itemWithReference : value) : [...current, itemWithReference]);
    void persistMediaQueueItem(itemWithReference, file);
    let token = '';

    try {
      const sessionCsrf = csrfRef.current || csrf || await refreshSessionCSRF();
      token = insertReference && existingId && markdownRef.current.includes(reference)
        ? reference
        : insertReference ? insertMediaReference(reference) : '';
      const result = await executeUpload({
        file,
        item,
        sessionCsrf,
        visibility: status === 'private' ? 'private' : 'public',
        responseError,
        controller,
        onTicket: mediaId => {
          serverMediaId = mediaId;
          setUploads(current => current.map(value => value.id === item.id ? { ...value, status: 'uploading', progress: 0 } : value));
          void persistMediaQueueItem({ ...itemWithReference, status: 'uploading' }, file);
        },
        onProgress: progress => setUploads(current => current.map(value => value.id === item.id ? { ...value, progress } : value)),
      });
      if (cancelledUploads.current.has(item.id)) throw new Error('cancelled');
      if (token) applyMarkdown(replaceMediaOccurrence(markdownRef.current, token, result.reference));
      const ready: UploadItem = { ...itemWithReference, status: 'ready', mediaId: result.mediaId, markdownReference: result.reference };
      setUploads(current => current.map(value => value.id === item.id ? ready : value));
      void persistMediaQueueItem(ready);
      onMessage('媒体已上传并写入 Markdown');
      return `media://${result.mediaId}`;
    } catch (error) {
      if (cancelledUploads.current.has(item.id) || (error instanceof Error && error.message === 'cancelled')) {
        setUploads(current => current.filter(value => value.id !== item.id));
        return '';
      }
      const failed: UploadItem = { ...itemWithReference, status: 'failed', mediaId: serverMediaId || undefined, error: '上传失败', progress: 0 };
      setUploads(current => current.map(value => value.id === item.id ? failed : value));
      void persistMediaQueueItem(failed);
      onMessage(error instanceof Error && error.message ? `媒体上传失败：${error.message}` : '媒体上传失败，保留引用占位符，可稍后重试');
      if (rejectOnError) throw error instanceof Error ? error : new Error('媒体上传失败');
      return '';
    } finally {
      uploadControllers.current.delete(item.id);
    }
  }, [applyMarkdown, csrf, csrfRef, insertMediaReference, markdownRef, mediaCapability, onMessage, refreshSessionCSRF, responseError, status]);

  const retryUpload = useCallback(async (item: UploadItem, file?: File) => {
    if (item.status !== 'failed') return;
    if (!file && !item.file) {
      onMessage(`请重新选择 ${item.fileName} 后再重试；浏览器不会把文件内容自动写入离线队列`);
      return;
    }
    await uploadMedia(file || new File([item.file as Blob], item.fileName, { type: item.mime }), item.id, item.markdownReference);
  }, [onMessage, uploadMedia]);

  const handleFiles = useCallback((files: FileList | File[]) => {
    for (const file of Array.from(files)) void uploadMedia(file);
  }, [uploadMedia]);

  const cancelUpload = useCallback((item: UploadItem) => {
    cancelledUploads.current.add(item.id);
    uploadControllers.current.get(item.id)?.abort();
    uploadControllers.current.delete(item.id);
    setUploads(current => current.filter(value => value.id !== item.id));
    applyMarkdown(removeMediaToken(editorRef.current?.getMarkdown() ?? markdownRef.current, item));
    void dbDelete(MEDIA_QUEUE_STORE, item.id);
    if (item.mediaId) void deleteServerMedia(item.mediaId);
    onMessage(`已取消上传 ${item.fileName}`);
  }, [applyMarkdown, deleteServerMedia, editorRef, markdownRef, onMessage, removeMediaToken]);

  const removeUpload = useCallback((item: UploadItem) => {
    if (item.status === 'uploading' || item.status === 'queued') {
      cancelUpload(item);
      return;
    }
    applyMarkdown(removeMediaToken(editorRef.current?.getMarkdown() ?? markdownRef.current, item));
    setUploads(current => current.filter(value => value.id !== item.id));
    void dbDelete(MEDIA_QUEUE_STORE, item.id);
    if (item.status === 'failed' && item.mediaId) void deleteServerMedia(item.mediaId);
    onMessage('已从当前草稿移除附件；媒体文件仍保留在媒体库中');
  }, [applyMarkdown, cancelUpload, deleteServerMedia, editorRef, markdownRef, onMessage, removeMediaToken]);

  const recoverUploads = useCallback(async () => {
    const values = await dbGetAll<UploadItem>(MEDIA_QUEUE_STORE);
    const recovered = values.map(value => {
      if (value.status !== 'queued' && value.status !== 'uploading') return value;
      if (!value.file) return { ...value, status: 'failed' as const, needsReselect: true, error: '浏览器未保存此文件，需重新选择文件' };
      const mime = value.file.type || value.mime;
      const enabled = mime.startsWith('image/') ? mediaCapability.imageUploadEnabled : mediaCapability.nonImageUploadEnabled;
      if (!enabled) return { ...value, status: 'failed' as const, progress: 0, error: mediaCapability.reason || '媒体存储不可用，请重新选择文件后重试' };
      return value;
    });
    setUploads(recovered);
    for (const value of recovered) {
      void persistMediaQueueItem(value, value.file);
      if ((value.status === 'queued' || value.status === 'uploading') && value.file) void uploadMedia(new File([value.file], value.fileName, { type: value.mime }), value.id);
    }
  }, [mediaCapability, uploadMedia]);

  const mediaStillProcessing = useMemo(() => uploads.some(item => item.status === 'queued' || item.status === 'uploading'), [uploads]);
  const uploadImageForEditor = useCallback((file: File) => uploadMedia(file, undefined, undefined, { insertReference: false, rejectOnError: true }), [uploadMedia]);

  return { uploads, mediaStillProcessing, uploadMedia, uploadImageForEditor, retryUpload, handleFiles, cancelUpload, removeUpload, recoverUploads };
}
