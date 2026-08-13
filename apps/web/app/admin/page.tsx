'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AlertCircle, Check, FileUp, LoaderCircle, Paperclip, RotateCcw, Trash2, UploadCloud, X } from 'lucide-react';
import { API } from '@/lib/api';
import { invalidatePublicCaches } from '@/lib/cache-invalidation';
import { deserializeEditorStatus, nextRetryAt, serializeEditorStatus } from '@/lib/editor-utils';
import { renderMarkdown } from '@/lib/markdown';
import { createUploadItem, isSupportedMedia, mediaMarkdown, mediaQueueStoragePlan, mediaUploadUrl, replaceMediaToken, uploadResumable, MAX_MEDIA_BYTES, type UploadItem } from '@/lib/media-utils';

type Mode = 'simple' | 'markdown';
// “实时预览”不再是独立标签；Markdown 模式直接同页展示预览。
type EditorStatus = 'draft' | 'public' | 'private';
type Draft = { id: string; clientDraftId: string; payload: Record<string, unknown>; updatedAt: string };
type QueueItem = { id: string; draft: Draft; attempts: number; nextTryAt: number };
type MediaCapability = {
  checked: boolean;
  provider: string;
  imageUploadEnabled: boolean;
  nonImageUploadEnabled: boolean;
  reason: string;
};

class AdminRequestError extends Error {
  status: number;

  constructor(status: number, detail: string) {
    super(detail);
    this.name = 'AdminRequestError';
    this.status = status;
  }
}

async function responseError(response: Response, fallback: string): Promise<AdminRequestError> {
  const body = await response.json().catch(() => ({})) as { detail?: string; title?: string };
  const detail = typeof body.detail === 'string' && body.detail.trim() ? body.detail.trim() : fallback;
  return new AdminRequestError(response.status, detail);
}

const DB_NAME = 'timeline-editor';
const DB_VERSION = 2;
const DRAFT_STORE = 'drafts';
const QUEUE_STORE = 'outbox';
const PREF_STORE = 'preferences';
const MEDIA_QUEUE_STORE = 'media-queue';

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DRAFT_STORE)) db.createObjectStore(DRAFT_STORE, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(QUEUE_STORE)) db.createObjectStore(QUEUE_STORE, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(PREF_STORE)) db.createObjectStore(PREF_STORE, { keyPath: 'key' });
      if (!db.objectStoreNames.contains(MEDIA_QUEUE_STORE)) db.createObjectStore(MEDIA_QUEUE_STORE, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function dbPut(store: string, value: unknown): Promise<boolean> {
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const request = db.transaction(store, 'readwrite').objectStore(store).put(value);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
    db.close();
    return true;
  } catch { /* offline/private browsing: the editor remains usable */ return false; }
}

async function dbGetAll<T>(store: string): Promise<T[]> {
  try {
    const db = await openDB();
    return await new Promise<T[]>((resolve, reject) => {
      const request = db.transaction(store, 'readonly').objectStore(store).getAll();
      request.onsuccess = () => { db.close(); resolve(request.result || []); };
      request.onerror = () => reject(request.error);
    });
  } catch { return []; }
}

async function dbDelete(store: string, id: string) {
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const request = db.transaction(store, 'readwrite').objectStore(store).delete(id);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
    db.close();
  } catch { /* ignore offline cleanup errors */ }
}

async function persistMediaQueueItem(item: UploadItem, file?: Blob): Promise<UploadItem> {
  const existing = await dbGetAll<UploadItem>(MEDIA_QUEUE_STORE);
  const existingBytes = existing.reduce((sum, value) => sum + (value.file && value.hasBlob ? value.file.size : 0), 0);
  const previousBytes = existing.find(value => value.id === item.id)?.file?.size || 0;
  const plan = file ? mediaQueueStoragePlan(file.size, Math.max(0, existingBytes - previousBytes)) : { persistBlob: false, reason: 'queue-quota' as const };
  const value: UploadItem = { ...item, file: plan.persistBlob ? file : undefined, hasBlob: plan.persistBlob, needsReselect: !plan.persistBlob && item.status !== 'ready' };
  const stored = await dbPut(MEDIA_QUEUE_STORE, value);
  if (!stored && plan.persistBlob) {
    const fallback: UploadItem = { ...value, file: undefined, hasBlob: false, needsReselect: item.status !== 'ready', error: '浏览器存储空间不足，需重新选择文件' };
    await dbPut(MEDIA_QUEUE_STORE, fallback);
    return fallback;
  }
  return value;
}

function draftName(draft: Draft) {
  const text = String(draft.payload.markdown || '').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, 34) : '未命名草稿';
}

function Preview({ markdown }: { markdown: string }) {
  const rendered = renderMarkdown(markdown);
  return <div className="markdown-preview" aria-label="Markdown 预览"><div className="preview-toc">{rendered.toc.length > 0 && <ol>{rendered.toc.map(item => <li key={item.id} className={`toc-level-${item.level}`}><a href={`#${item.id}`}>{item.title}</a></li>)}</ol>}</div><div dangerouslySetInnerHTML={{ __html: rendered.html }} /></div>;
}

export default function AdminPage() {
  const router = useRouter();
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const draftID = useRef<string | null>(null);
  const lastSync = useRef(0);
  const [markdown, setMarkdown] = useState('');
  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [categories, setCategories] = useState('日常');
  const [tags, setTags] = useState('');
  const [status, setStatus] = useState<EditorStatus>('draft');
  const [kind, setKind] = useState('note');
  const [date, setDate] = useState(new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }));
  const [slug, setSlug] = useState('');
  const [mode, setMode] = useState<Mode>('simple');
  const [uploadPanelOpen, setUploadPanelOpen] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const cancelledUploads = useRef<Set<string>>(new Set());
  const uploadControllers = useRef<Map<string, AbortController>>(new Map());
  const [saving, setSaving] = useState(false);
  const [loadingEdit, setLoadingEdit] = useState(false);
  const [editingEntryID, setEditingEntryID] = useState('');
  const [editingWorkingID, setEditingWorkingID] = useState('');
  const [editingBaseRevision, setEditingBaseRevision] = useState(0);
  const [message, setMessage] = useState('');
  const [undoToken, setUndoToken] = useState('');
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [csrf, setCsrf] = useState('');
  const csrfRef = useRef('');
  const sessionRequestRef = useRef<Promise<string> | null>(null);
  const [online, setOnline] = useState(true);
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [mediaCapability, setMediaCapability] = useState<MediaCapability>({ checked: false, provider: '', imageUploadEnabled: false, nonImageUploadEnabled: false, reason: '正在检查媒体存储…' });
  const [requestedEditID, setRequestedEditID] = useState('');
  const editRequested = useRef(false);

  const setSessionCSRF = useCallback((value: string) => {
    csrfRef.current = value;
    setCsrf(value);
  }, []);

  const refreshSessionCSRF = useCallback(async () => {
    if (sessionRequestRef.current) return sessionRequestRef.current;
    const request = (async () => {
      const response = await fetch(`${API}/auth/session`, { credentials: 'include', headers: { Accept: 'application/json' } });
      if (!response.ok) throw await responseError(response, '登录会话已失效');
      const value = await response.json() as { csrfToken?: string };
      if (!value.csrfToken) throw new AdminRequestError(401, '登录会话已失效');
      setSessionCSRF(value.csrfToken);
      return value.csrfToken;
    })();
    sessionRequestRef.current = request;
    try {
      return await request;
    } finally {
      if (sessionRequestRef.current === request) sessionRequestRef.current = null;
    }
  }, [setSessionCSRF]);

  const removeMediaToken = useCallback((source: string, item: UploadItem) => {
    let next = source;
    next = replaceMediaToken(next, mediaMarkdown(item.id), '');
    if (item.mediaId) next = replaceMediaToken(next, mediaMarkdown(item.mediaId), '');
    return next.replace(/\n{3,}/g, '\n\n').trimStart();
  }, []);

  const currentDraftId = useCallback(() => {
    if (!draftID.current) draftID.current = crypto.randomUUID();
    return draftID.current;
  }, []);

  async function uploadMedia(file: File, existingId?: string) {
    if (!isSupportedMedia(file)) { setMessage(`仅支持 ${Math.round(MAX_MEDIA_BYTES / 1024 / 1024)}MiB 以内的图片、音频、视频或 PDF；断点续传由后端 uploadUrl 能力决定`); return; }
    if (!mediaCapability.checked) { setMessage('正在检查媒体存储，请稍后再试'); return; }
    if (file.type.startsWith('image/') && !mediaCapability.imageUploadEnabled) { setMessage(mediaCapability.reason || '图片上传暂不可用，请先配置可写的媒体存储'); return; }
    if (!file.type.startsWith('image/') && !mediaCapability.nonImageUploadEnabled) { setMessage(mediaCapability.reason || '媒体上传暂不可用，请先配置可写的媒体存储'); return; }
    const item = createUploadItem(file, existingId);
    cancelledUploads.current.delete(item.id);
    const controller = new AbortController();
    uploadControllers.current.set(item.id, controller);
    setUploads(current => current.some(value => value.id === item.id) ? current.map(value => value.id === item.id ? item : value) : [...current, item]);
    void persistMediaQueueItem(item, file);
    const token = mediaMarkdown(item.id);
    setMarkdown(current => current.includes(token) ? current : `${current}${current && !current.endsWith('\n') ? '\n' : ''}${token}`);
    try {
      const sessionCsrf = csrfRef.current || csrf || await refreshSessionCSRF();
      const ticketResponse = await fetch(`${API}/admin/media/upload-ticket`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': sessionCsrf, 'Idempotency-Key': item.id }, body: JSON.stringify({ name: file.name, size: file.size, mime: file.type, visibility: status === 'private' ? 'private' : 'public' }), signal: controller.signal });
      if (!ticketResponse.ok) throw await responseError(ticketResponse, '创建上传任务失败');
      const ticket = await ticketResponse.json() as { media: { id: string }; uploadUrl: string; finalizeUrl?: string };
      setUploads(current => current.map(value => value.id === item.id ? { ...value, status: 'uploading', progress: 0 } : value));
      void persistMediaQueueItem({ ...item, status: 'uploading' }, file);
      const uploadUrl = mediaUploadUrl(ticket.uploadUrl, window.location.origin);
      if (ticket.finalizeUrl) {
        await uploadResumable(uploadUrl, file, { csrfToken: sessionCsrf, idempotencyKey: item.id, signal: controller.signal, onProgress: (progress: number) => setUploads(current => current.map(value => value.id === item.id ? { ...value, progress } : value)) });
      }
      if (cancelledUploads.current.has(item.id)) throw new Error('cancelled');
      const finalizeUrl = ticket.finalizeUrl ? mediaUploadUrl(ticket.finalizeUrl, window.location.origin) : uploadUrl;
      const finalize = await fetch(finalizeUrl, {
        method: 'POST',
        credentials: 'include',
        headers: { 'X-CSRF-Token': sessionCsrf, 'Idempotency-Key': item.id },
        ...(ticket.finalizeUrl ? {} : { 'body': file, headers: { 'X-CSRF-Token': sessionCsrf, 'Idempotency-Key': item.id, 'Content-Type': 'application/octet-stream' } }),
        signal: controller.signal,
      });
      if (!finalize.ok) throw await responseError(finalize, '完成上传失败');
      const resolved = mediaMarkdown(ticket.media.id);
      setMarkdown(current => replaceMediaToken(current, token, resolved));
      const ready: UploadItem = { ...item, status: 'ready', mediaId: ticket.media.id };
      setUploads(current => current.map(value => value.id === item.id ? ready : value));
      void persistMediaQueueItem(ready);
      setMessage('媒体已上传并写入 Markdown');
    } catch (error) {
      if (cancelledUploads.current.has(item.id) || (error instanceof Error && error.message === 'cancelled')) {
        setUploads(current => current.filter(value => value.id !== item.id));
        return;
      }
      const failed: UploadItem = { ...item, status: 'failed', error: '上传失败', progress: 0 };
      setUploads(current => current.map(value => value.id === item.id ? failed : value));
      void persistMediaQueueItem(failed);
      setMessage(error instanceof AdminRequestError ? `媒体上传失败：${error.message}` : '媒体上传失败，保留引用占位符，可稍后重试');
    } finally { uploadControllers.current.delete(item.id); }
  }

  async function retryUpload(item: UploadItem, file?: File) {
    if (item.status !== 'failed') return;
    if (!file && !item.file) {
      setMessage(`请重新选择 ${item.fileName} 后再重试；浏览器不会把文件内容自动写入离线队列`);
      return;
    }
    await uploadMedia(file || new File([item.file as Blob], item.fileName, { type: item.mime }), item.id);
  }

  function handleFiles(files: FileList | File[]) { for (const file of Array.from(files)) void uploadMedia(file); }

  function cancelUpload(item: UploadItem) {
    cancelledUploads.current.add(item.id);
    uploadControllers.current.get(item.id)?.abort();
    uploadControllers.current.delete(item.id);
    setUploads(current => current.filter(value => value.id !== item.id));
    setMarkdown(current => removeMediaToken(current, item));
    void dbDelete(MEDIA_QUEUE_STORE, item.id);
    setMessage(`已取消上传 ${item.fileName}`);
  }

  function removeUpload(item: UploadItem) {
    if (item.status === 'uploading' || item.status === 'queued') {
      cancelUpload(item);
      return;
    }
    setMarkdown(current => removeMediaToken(current, item));
    setUploads(current => current.filter(value => value.id !== item.id));
    void dbDelete(MEDIA_QUEUE_STORE, item.id);
    setMessage('已从当前草稿移除附件；媒体文件仍保留在媒体库中');
  }

  const payload = useMemo(() => ({ markdown, title, summary, slug, categories: categories.split(',').map(x => x.trim()).filter(Boolean), tags: tags.split(/[,\s]+/).map(x => x.replace(/^#/, '')).filter(Boolean), ...serializeEditorStatus(status), kind, journalDate: date }), [markdown, title, summary, slug, categories, tags, status, kind, date]);

  const refreshDrafts = useCallback(async () => {
    const values = await dbGetAll<Draft>(DRAFT_STORE);
    setDrafts(values.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
  }, []);

  useEffect(() => {
    draftID.current = crypto.randomUUID();
    editorRef.current?.focus();
    window.setTimeout(() => {
      void refreshDrafts();
      void dbGetAll<UploadItem>(MEDIA_QUEUE_STORE).then(values => {
        const recovered = values.map(value => value.status === 'queued' || value.status === 'uploading'
          ? value.file
            ? value
            : { ...value, status: 'failed' as const, needsReselect: true, error: '浏览器未保存此文件，需重新选择文件' }
          : value);
        setUploads(recovered);
        for (const value of recovered) {
          void persistMediaQueueItem(value, value.file);
          if ((value.status === 'queued' || value.status === 'uploading') && value.file) void uploadMedia(new File([value.file], value.fileName, { type: value.mime }), value.id);
        }
      });
    }, 0);
    const update = () => setOnline(navigator.onLine);
    update(); window.addEventListener('online', update); window.addEventListener('offline', update);
    void refreshSessionCSRF().catch(() => undefined);
    fetch(`${API}/admin/media/capability`, { credentials: 'include', headers: { Accept: 'application/json' } }).then(async response => {
      const body = await response.json().catch(() => ({}));
      const writable = response.ok && body.writable === true;
      setMediaCapability({ checked: true, provider: String(body.provider || ''), imageUploadEnabled: writable && body.imageUploadEnabled !== false, nonImageUploadEnabled: writable && body.nonImageUploadEnabled !== false, reason: writable ? '' : String(body.reason || '媒体存储不可写，上传已禁用') });
    }).catch(() => setMediaCapability({ checked: true, provider: '', imageUploadEnabled: false, nonImageUploadEnabled: false, reason: '无法检测媒体存储状态，上传已禁用' }));
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); };
  // Recovery runs once per editor mount; uploadMedia intentionally uses the
  // current editor/session state rather than restarting the recovery scan.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshDrafts, refreshSessionCSRF]);

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('edit') || '';
    if (!id) return;
    const timer = window.setTimeout(() => { setRequestedEditID(id); editRequested.current = true; }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!requestedEditID || !csrf || editRequested.current === false) return;
    editRequested.current = false;
    let cancelled = false;
    setLoadingEdit(true);
    setMessage('正在载入内容…');
    void fetch(`${API}/admin/entries/${encodeURIComponent(requestedEditID)}/edit`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'X-CSRF-Token': csrf, 'Idempotency-Key': `edit-${requestedEditID}` },
    }).then(async response => {
      if (!response.ok) throw new Error(String(response.status));
      return response.json() as Promise<{ id: string; entryId: string; baseRevision: number; clientDraftId: string; payload: Record<string, unknown> }>;
    }).then(working => {
      if (cancelled) return;
      const value = working.payload || {};
      draftID.current = working.clientDraftId;
      setEditingEntryID(working.entryId || requestedEditID);
      setEditingWorkingID(working.id);
      setEditingBaseRevision(Number(working.baseRevision || 0));
      setMarkdown(String(value.markdown || ''));
      setTitle(String(value.title || ''));
      setSummary(String(value.summary || ''));
      setSlug(String(value.slug || ''));
      setCategories(Array.isArray(value.categories) ? value.categories.join(', ') : '');
      setTags(Array.isArray(value.tags) ? value.tags.join(' ') : '');
      setStatus(deserializeEditorStatus({ status: String(value.status || ''), visibility: String(value.visibility || '') }));
      setKind(String(value.kind || 'note'));
      setDate(String(value.journalDate || date));
      setMessage('已载入内容，可直接编辑后保存');
      window.setTimeout(() => editorRef.current?.focus(), 0);
    }).catch(error => {
      if (!cancelled) setMessage(error instanceof Error && error.message === '404' ? '内容不存在或已被删除' : '载入内容失败，请检查登录状态或网络');
    }).finally(() => { if (!cancelled) setLoadingEdit(false); });
    return () => { cancelled = true; };
  }, [csrf, requestedEditID, date]);

  const syncDraft = useCallback(async (draft: Draft) => {
    if (!csrf || !navigator.onLine || Date.now() - lastSync.current < 2000) return;
    lastSync.current = Date.now();
    const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, 'Idempotency-Key': draft.clientDraftId };
    try {
      const response = await fetch(`${API}/admin/working-copies`, { method: 'POST', credentials: 'include', headers, body: JSON.stringify({ clientDraftId: draft.clientDraftId, payload: draft.payload }) });
      if (!response.ok) throw new Error('sync');
      setMessage('已同步工作草稿');
    } catch {
      const item: QueueItem = { id: draft.id, draft, attempts: 0, nextTryAt: Date.now() + 1000 };
      await dbPut(QUEUE_STORE, item);
      setMessage('暂存离线队列，联网后重试');
    }
  }, [csrf]);

  useEffect(() => {
    const timer = window.setTimeout(async () => {
      const draft: Draft = { id: currentDraftId(), clientDraftId: currentDraftId(), payload, updatedAt: new Date().toISOString() };
      await dbPut(DRAFT_STORE, draft);
      await refreshDrafts();
      setMessage('已本地保存');
      await syncDraft(draft);
    }, 500);
    return () => window.clearTimeout(timer);
  }, [payload, currentDraftId, refreshDrafts, syncDraft]);

  useEffect(() => {
    const consumeOutbox = async () => {
      if (!navigator.onLine || !csrf) return;
      const items = await dbGetAll<QueueItem>(QUEUE_STORE);
      for (const item of items) {
        if (item.nextTryAt > Date.now()) continue;
        try {
          const response = await fetch(`${API}/admin/working-copies`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, 'Idempotency-Key': item.draft.clientDraftId }, body: JSON.stringify({ clientDraftId: item.draft.clientDraftId, payload: item.draft.payload }) });
          if (!response.ok) throw new Error('outbox');
          await dbDelete(QUEUE_STORE, item.id);
          setMessage('离线草稿已重试同步');
        } catch {
          const attempts = item.attempts + 1;
          await dbPut(QUEUE_STORE, { ...item, attempts, nextTryAt: nextRetryAt(attempts) });
        }
      }
    };
    void consumeOutbox();
    window.addEventListener('online', consumeOutbox);
    window.addEventListener('focus', consumeOutbox);
    const interval = window.setInterval(consumeOutbox, 10_000);
    return () => { window.removeEventListener('online', consumeOutbox); window.removeEventListener('focus', consumeOutbox); window.clearInterval(interval); };
  }, [csrf]);

  useEffect(() => {
    const flush = () => { void syncDraft({ id: currentDraftId(), clientDraftId: currentDraftId(), payload, updatedAt: new Date().toISOString() }); };
    window.addEventListener('blur', flush);
    const interval = window.setInterval(flush, 10000);
    return () => { window.removeEventListener('blur', flush); window.clearInterval(interval); };
  }, [payload, currentDraftId, syncDraft]);

  async function save() {
    const effectiveMarkdown = markdown;
    const savePayload = { ...payload, markdown: effectiveMarkdown, ...(editingBaseRevision > 0 ? { baseRevision: editingBaseRevision } : {}) };
    const initialCsrf = csrfRef.current || csrf;
    if (!effectiveMarkdown.trim() || !initialCsrf) { setMessage(effectiveMarkdown.trim() ? '登录状态未确认，请刷新后重试' : '请输入正文'); return; }
    setSaving(true); setMessage('保存中…');
    const idempotencyKey = currentDraftId();
    const latestDraft: Draft = { id: currentDraftId(), clientDraftId: currentDraftId(), payload: savePayload, updatedAt: new Date().toISOString() };
    const submit = async (requestCsrf: string) => {
      const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': requestCsrf, 'Idempotency-Key': idempotencyKey };
      let working: { id: string } | null = editingWorkingID ? { id: editingWorkingID } : null;
      if (!working) {
        const draftResponse = await fetch(`${API}/admin/working-copies`, { method: 'POST', credentials: 'include', headers, body: JSON.stringify({ clientDraftId: currentDraftId(), payload: savePayload }) });
        if (!draftResponse.ok) throw await responseError(draftResponse, '保存工作草稿失败');
        working = await draftResponse.json() as { id: string };
      }
      // Keep the explicit working.id interpolation in this request contract;
      // it also makes the update path easy to audit in browser/network tests.
      const workingCommitPath = `/admin/working-copies/${working.id}/commit`;
      const commitResponse = await fetch(`${API}${workingCommitPath}`, { method: 'POST', credentials: 'include', headers, body: JSON.stringify(savePayload) });
      if (!commitResponse.ok) throw await responseError(commitResponse, '提交内容失败');
      return commitResponse.json();
    };
    try {
      // Always persist the latest local revision before asking the API to commit.
      await dbPut(DRAFT_STORE, latestDraft);
      let result;
      try {
        result = await submit(initialCsrf);
      } catch (cause) {
        if (!(cause instanceof AdminRequestError) || (cause.status !== 401 && cause.status !== 403)) throw cause;
        result = await submit(await refreshSessionCSRF());
      }
      await invalidatePublicCaches({ entryId: editingEntryID || result.entry?.id, slug: String(savePayload.slug || ''), reason: 'edit' });
      router.refresh();
      setUndoToken(result.undoToken || '');
      if (editingEntryID) {
        setMessage('已更新内容');
        router.push('/admin/entries');
      } else {
        setMarkdown(''); setTitle(''); setSummary(''); setSlug(''); setMessage('已保存，15 秒内可撤销'); editorRef.current?.focus();
      }
      await dbDelete(DRAFT_STORE, currentDraftId()); await refreshDrafts();
    } catch (error) {
      if (error instanceof AdminRequestError && error.status === 409) setMessage('保存失败：内容已被其他位置修改，请重新载入后合并');
      else if (error instanceof AdminRequestError && (error.status === 401 || error.status === 403)) setMessage(`保存失败：${error.message}`);
      else setMessage(error instanceof Error ? `保存失败：${error.message}` : '保存失败：API 服务未响应');
    }
    finally { setSaving(false); }
  }

  async function undo() {
    if (!undoToken || !csrf) return;
    const response = await fetch(`${API}/admin/undo/${undoToken}`, { method: 'POST', credentials: 'include', headers: { 'X-CSRF-Token': csrf, 'Idempotency-Key': undoToken } });
    if (!response.ok) { setMessage('撤销窗口已过期'); return; }
    const body = await response.json();
    await invalidatePublicCaches({ entryId: body.entry?.id, slug: body.entry?.slug, reason: 'undo' });
    router.refresh();
    setMarkdown(body.entry?.markdown || ''); setTitle(body.entry?.title || ''); setSummary(body.entry?.summary || ''); setCategories((body.entry?.categories || []).join(', ')); setTags((body.entry?.tags || []).join(' ')); setDate(body.entry?.journalDate || date); setKind(body.entry?.kind || 'note'); setStatus('draft'); setUndoToken(''); setMessage('已撤销并回填编辑器'); editorRef.current?.focus();
  }

  function loadDraft(draft: Draft) {
    draftID.current = draft.clientDraftId;
    const value = draft.payload;
    setMarkdown(String(value.markdown || '')); setTitle(String(value.title || '')); setSummary(String(value.summary || '')); setCategories(Array.isArray(value.categories) ? value.categories.join(', ') : ''); setTags(Array.isArray(value.tags) ? value.tags.join(' ') : ''); setStatus(value.visibility === 'private' || value.status === 'private' ? 'private' : value.status === 'published' ? 'public' : 'draft'); setKind(String(value.kind || 'note')); setDate(String(value.journalDate || date)); setMessage('已载入草稿'); editorRef.current?.focus();
  }

  function switchMode(nextMode: Mode) {
    if (nextMode === mode) return;
    setMode(nextMode);
    setMessage('');
    window.setTimeout(() => editorRef.current?.focus(), 0);
  }

  const uploadDisabled = mediaCapability.checked && !mediaCapability.imageUploadEnabled && !mediaCapability.nonImageUploadEnabled;
  const openUploadPicker = () => {
    if (!uploadDisabled) setUploadPanelOpen(true);
  };

  const uploadPanel = uploadPanelOpen ? <section className="upload-panel" aria-label="媒体附件上传">
    <div
      className={`upload-dropzone${dragActive ? ' is-dragging' : ''}${uploadDisabled ? ' is-disabled' : ''}`}
      onDragEnter={event => { event.preventDefault(); setDragActive(true); }}
      onDragOver={event => { event.preventDefault(); setDragActive(true); }}
      onDragLeave={event => { event.preventDefault(); setDragActive(false); }}
      onDrop={event => { event.preventDefault(); setDragActive(false); if (!uploadDisabled) handleFiles(event.dataTransfer.files); }}
    >
      <div className="upload-dropzone-icon" aria-hidden="true"><UploadCloud /></div>
      <strong>拖放文件到这里</strong>
      <span>或浏览设备选择附件</span>
      <small>支持 PNG、JPG、GIF、WEBP、音频、视频和 PDF，单个文件不超过 {Math.round(MAX_MEDIA_BYTES / 1024 / 1024)}MB</small>
      <label className="upload-browse-button">
        <FileUp aria-hidden="true" /> 浏览文件
        <input type="file" accept="image/*,audio/*,video/*,application/pdf" multiple hidden disabled={uploadDisabled} onChange={event => { if (event.target.files) handleFiles(event.target.files); event.currentTarget.value = ''; }} />
      </label>
      {uploadDisabled && <span className="upload-panel-error"><AlertCircle aria-hidden="true" />{mediaCapability.reason}</span>}
    </div>
  </section> : null;

  return <main id="main-content" className="shell"><div className="admin-grid"><section><div className="eyebrow">WRITE NOW · {online ? 'ONLINE' : 'OFFLINE'}</div><h1>{editingEntryID ? '编辑内容' : '此刻想写些什么？'}</h1><div className="composer">
    <div className="editor-toolbar" role="tablist" aria-label="编辑模式">
      {(['simple', 'markdown'] as Mode[]).map(value => <button id={`tab-${value}`} type="button" role="tab" aria-controls="editor-panel" aria-selected={mode === value} className={mode === value ? 'tool active' : 'tool'} key={value} onClick={() => switchMode(value)}>{value === 'simple' ? '简易' : 'Markdown'}</button>)}
      <button type="button" className={`tool upload-control${uploadPanelOpen ? ' active' : ''}${uploadDisabled ? ' upload-disabled' : ''}`} aria-label="添加媒体" aria-disabled={uploadDisabled} aria-expanded={uploadPanelOpen} disabled={uploadDisabled} title={uploadDisabled ? mediaCapability.reason : '上传图片、音频、视频或 PDF'} onClick={() => setUploadPanelOpen(open => !open)}><Paperclip aria-hidden="true" /> 添加媒体</button>
    </div>
    <div className={`media-capability${uploadDisabled ? ' is-unavailable' : ''}`} role="status">{!mediaCapability.checked ? mediaCapability.reason : uploadDisabled ? mediaCapability.reason : '本地媒体存储已就绪 · 图片与附件可上传'}</div>
    {kind === 'article' && <><input className="title-input" value={title} onChange={e => setTitle(e.target.value)} placeholder="文章标题" aria-label="文章标题"/><input className="summary-input" value={summary} onChange={e => setSummary(e.target.value)} placeholder="摘要（可选）" aria-label="文章摘要"/><input className="summary-input" value={slug} onChange={e => setSlug(e.target.value)} placeholder="地址 slug（可选，编辑时保持原值）" aria-label="文章地址"/></>}
    <textarea id="editor-panel" role="tabpanel" aria-labelledby={`tab-${mode}`} ref={editorRef} value={markdown} onChange={e => setMarkdown(e.target.value)} onCompositionStart={() => { composingRef.current = true; }} onCompositionEnd={e => { composingRef.current = false; setMarkdown(e.currentTarget.value); }} onPaste={e => { const files = Array.from(e.clipboardData.files); if (files.length) { e.preventDefault(); handleFiles(files); } }} onDrop={e => { e.preventDefault(); handleFiles(e.dataTransfer.files); }} onDragOver={e => e.preventDefault()} placeholder={mode === 'simple' ? '从一句话开始。可直接粘贴图片或添加媒体附件。' : '使用 Markdown 写作；右侧或下方会同步显示预览。'} aria-label="Markdown 正文编辑" />
    {mode === 'simple' && uploadPanel}
    {mode === 'markdown' && <Preview markdown={markdown}/>} {mode === 'markdown' && uploadPanel}
    <div className="status" aria-live="polite">{message}</div>
    {uploads.length > 0 && <ul className="upload-list" aria-label="媒体上传队列">{uploads.map(item => <li key={item.id}><div className="upload-item-main"><span className="upload-name">{item.fileName}</span>{item.status === 'uploading' && <div className="upload-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((item.progress || 0) * 100)}><span style={{ width: `${Math.round((item.progress || 0) * 100)}%` }} /></div>}</div><span className="upload-actions"><span className={`tag upload-${item.status}`}>{item.status === 'ready' ? <><Check aria-hidden="true" />已完成</> : item.status === 'uploading' ? <><LoaderCircle className="spin" aria-hidden="true" />上传中</> : item.status === 'failed' ? <><AlertCircle aria-hidden="true" />失败</> : '排队中'}</span>{item.status === 'uploading' && <button type="button" className="inline-action" onClick={() => cancelUpload(item)}><X aria-hidden="true" />取消</button>}{item.status === 'failed' && <label className="inline-action">{item.needsReselect ? '重选' : '重试'}<input type="file" accept="image/*,audio/*,video/*,application/pdf" hidden onChange={e => { const file = e.target.files?.[0]; if (file) void retryUpload(item, file); e.currentTarget.value = ''; }}/></label>}<button type="button" className="inline-action remove-media" onClick={() => removeUpload(item)} aria-label={`从当前草稿移除 ${item.fileName}`}><Trash2 aria-hidden="true" />移除附件</button></span></li>)}</ul>}
    <div className="composer-footer"><label>日期 <input type="date" value={date} onChange={e => setDate(e.target.value)}/></label><label>类型 <select value={kind} onChange={e => setKind(e.target.value)}><option value="note">随记</option><option value="article">文章</option></select></label><label>状态 <select value={status} onChange={e => setStatus(e.target.value as EditorStatus)}><option value="draft">草稿</option><option value="public">公开</option><option value="private">私人</option></select></label><label>分类 <input value={categories} onChange={e => setCategories(e.target.value)} placeholder="日常, 工作" aria-label="分类"/></label><label>标签 <input value={tags} onChange={e => setTags(e.target.value)} placeholder="#阅读 #想法" aria-label="标签"/></label><button className="primary" disabled={saving || loadingEdit || !markdown.trim()} onClick={save}>{saving ? '保存中…' : editingEntryID ? '保存修改' : '保存'}</button>{undoToken && <button className="secondary" onClick={undo}>撤销保存</button>}</div>
  </div></section><aside className="sidebar"><div className="side-card"><div className="side-card-heading"><h3>草稿托盘（{drafts.length}）</h3><button className="icon-button" type="button" onClick={() => void refreshDrafts()} aria-label="刷新草稿"><RotateCcw aria-hidden="true" /></button></div>{drafts.length ? <ul className="draft-list">{drafts.slice(0, 8).map(d => <li key={d.id}><button type="button" onClick={() => loadDraft(d)}><strong>{draftName(d)}</strong><small>{new Date(d.updatedAt).toLocaleString('zh-CN')}</small></button></li>)}</ul> : <p>停止输入后自动保存。你可以同时保留多份未命名草稿。</p>}</div><div className="side-card"><h3>写作原则</h3><p>唯一保存按钮。先写，再决定是草稿、公开还是私人。私人内容不会出现在公开搜索和正文接口。</p></div><div className="side-card"><h3>更多工具</h3><p><Link href="/admin/entries">版本、回收站与导出入口</Link>已接入版本、回收站和导出工具。</p></div></aside></div></main>;

}
/* Markdown mode keeps the live preview inline; the old standalone tab is intentionally removed. */
