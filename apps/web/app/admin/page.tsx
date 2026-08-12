'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { API } from '@/lib/api';
import { deserializeEditorStatus, nextRetryAt, serializeEditorStatus } from '@/lib/editor-utils';
import { renderMarkdown } from '@/lib/markdown';
import { createUploadItem, isSupportedMedia, mediaMarkdown, mediaQueueStoragePlan, mediaUploadUrl, replaceMediaToken, uploadResumable, MAX_MEDIA_BYTES, type UploadItem } from '@/lib/media-utils';

type Mode = 'simple' | 'markdown' | 'preview';
type EditorStatus = 'draft' | 'public' | 'private';
type Draft = { id: string; clientDraftId: string; payload: Record<string, unknown>; updatedAt: string };
type QueueItem = { id: string; draft: Draft; attempts: number; nextTryAt: number };

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
  const [saving, setSaving] = useState(false);
  const [loadingEdit, setLoadingEdit] = useState(false);
  const [editingEntryID, setEditingEntryID] = useState('');
  const [editingWorkingID, setEditingWorkingID] = useState('');
  const [editingBaseRevision, setEditingBaseRevision] = useState(0);
  const [message, setMessage] = useState('');
  const [undoToken, setUndoToken] = useState('');
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [csrf, setCsrf] = useState('');
  const [online, setOnline] = useState(true);
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [requestedEditID, setRequestedEditID] = useState('');
  const editRequested = useRef(false);

  const currentDraftId = useCallback(() => {
    if (!draftID.current) draftID.current = crypto.randomUUID();
    return draftID.current;
  }, []);

  async function uploadMedia(file: File, existingId?: string) {
    if (!isSupportedMedia(file)) { setMessage(`仅支持 ${Math.round(MAX_MEDIA_BYTES / 1024 / 1024)}MiB 以内的图片、音频、视频或 PDF；断点续传由后端 uploadUrl 能力决定`); return; }
    const item = createUploadItem(file, existingId);
    setUploads(current => current.some(value => value.id === item.id) ? current.map(value => value.id === item.id ? item : value) : [...current, item]);
    void persistMediaQueueItem(item, file);
    const token = mediaMarkdown(item.id);
    setMarkdown(current => current.includes(token) ? current : `${current}${current && !current.endsWith('\n') ? '\n' : ''}${token}`);
    try {
      const session = await fetch(`${API}/auth/session`, { credentials: 'include' }).then(r => r.json());
      const ticketResponse = await fetch(`${API}/admin/media/upload-ticket`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken || '', 'Idempotency-Key': item.id }, body: JSON.stringify({ name: file.name, size: file.size, mime: file.type, visibility: status === 'private' ? 'private' : 'public' }) });
      if (!ticketResponse.ok) throw new Error('ticket');
      const ticket = await ticketResponse.json() as { media: { id: string }; uploadUrl: string; finalizeUrl?: string };
      setUploads(current => current.map(value => value.id === item.id ? { ...value, status: 'uploading' } : value));
      void persistMediaQueueItem({ ...item, status: 'uploading' }, file);
      const uploadUrl = mediaUploadUrl(ticket.uploadUrl, window.location.origin);
      if (ticket.finalizeUrl) {
        await uploadResumable(uploadUrl, file, { csrfToken: session.csrfToken || '', idempotencyKey: item.id });
      }
      const finalizeUrl = ticket.finalizeUrl ? mediaUploadUrl(ticket.finalizeUrl, window.location.origin) : uploadUrl;
      const finalize = await fetch(finalizeUrl, {
        method: 'POST',
        credentials: 'include',
        headers: { 'X-CSRF-Token': session.csrfToken || '', 'Idempotency-Key': item.id },
        ...(ticket.finalizeUrl ? {} : { 'body': file, headers: { 'X-CSRF-Token': session.csrfToken || '', 'Idempotency-Key': item.id, 'Content-Type': 'application/octet-stream' } }),
      });
      if (!finalize.ok) throw new Error('finalize');
      const resolved = mediaMarkdown(ticket.media.id);
      setMarkdown(current => replaceMediaToken(current, token, resolved));
      const ready: UploadItem = { ...item, status: 'ready', mediaId: ticket.media.id };
      setUploads(current => current.map(value => value.id === item.id ? ready : value));
      void persistMediaQueueItem(ready);
      setMessage('媒体已上传并写入 Markdown');
    } catch {
      const failed: UploadItem = { ...item, status: 'failed', error: '上传失败' };
      setUploads(current => current.map(value => value.id === item.id ? failed : value));
      void persistMediaQueueItem(failed);
      setMessage('媒体上传失败，保留引用占位符，可稍后重试');
    }
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
    fetch(`${API}/auth/session`, { credentials: 'include' }).then(r => r.ok ? r.json() : null).then(v => setCsrf(v?.csrfToken || '')).catch(() => undefined);
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); };
  // Recovery runs once per editor mount; uploadMedia intentionally uses the
  // current editor/session state rather than restarting the recovery scan.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshDrafts]);

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
    if (!effectiveMarkdown.trim() || !csrf) { setMessage(csrf ? '请输入正文' : '请先登录'); return; }
    setSaving(true); setMessage('保存中…');
    const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, 'Idempotency-Key': currentDraftId() };
    try {
      // Always persist the latest local revision before asking the API to commit.
      const latestDraft: Draft = { id: currentDraftId(), clientDraftId: currentDraftId(), payload: savePayload, updatedAt: new Date().toISOString() };
      await dbPut(DRAFT_STORE, latestDraft);
      let workingID = editingWorkingID;
      if (!workingID) {
        const draftResponse = await fetch(`${API}/admin/working-copies`, { method: 'POST', credentials: 'include', headers, body: JSON.stringify({ clientDraftId: currentDraftId(), payload: savePayload }) });
        if (!draftResponse.ok) throw new Error('draft');
        const working = await draftResponse.json() as { id: string };
        workingID = working.id;
      }
      // New-entry path historically used working-copies/${working.id}/commit;
      // keep this contract explicit while edits reuse the loaded working copy.
      const commitResponse = await fetch(`${API}/admin/working-copies/${workingID}/commit`, { method: 'POST', credentials: 'include', headers, body: JSON.stringify(savePayload) });
      if (!commitResponse.ok) throw new Error('commit');
      const result = await commitResponse.json();
      setUndoToken(result.undoToken || '');
      if (editingEntryID) {
        setMessage('已更新内容');
        router.push('/admin/entries');
      } else {
        setMarkdown(''); setTitle(''); setSummary(''); setSlug(''); setMessage('已保存，15 秒内可撤销'); editorRef.current?.focus();
      }
      await dbDelete(DRAFT_STORE, currentDraftId()); await refreshDrafts();
    } catch (error) { setMessage(error instanceof Error && error.message === 'commit' ? '保存失败：内容已被其他位置修改，请重新载入后合并' : '保存失败：请检查登录状态或 API 服务'); }
    finally { setSaving(false); }
  }

  async function undo() {
    if (!undoToken || !csrf) return;
    const response = await fetch(`${API}/admin/undo/${undoToken}`, { method: 'POST', credentials: 'include', headers: { 'X-CSRF-Token': csrf, 'Idempotency-Key': undoToken } });
    if (!response.ok) { setMessage('撤销窗口已过期'); return; }
    const body = await response.json();
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
    setMessage(nextMode === 'preview' ? '实时预览已开启；请在 Markdown 编辑区输入内容' : '');
    window.setTimeout(() => editorRef.current?.focus(), 0);
  }

  return <main id="main-content" className="shell"><div className="admin-grid"><section><div className="eyebrow">WRITE NOW · {online ? 'ONLINE' : 'OFFLINE'}</div><h1>{editingEntryID ? '编辑内容' : '此刻想写些什么？'}</h1><div className="composer"><div className="editor-toolbar" role="tablist" aria-label="编辑模式">{(['simple', 'markdown', 'preview'] as Mode[]).map(value => <button id={`tab-${value}`} type="button" role="tab" aria-controls="editor-panel" aria-selected={mode === value} className={mode === value ? 'tool active' : 'tool'} key={value} onClick={() => switchMode(value)}>{value === 'simple' ? '简易' : value === 'markdown' ? 'Markdown' : '实时预览'}</button>)}<label className="tool upload-control">添加媒体<input type="file" accept="image/*,audio/*,video/*,application/pdf" multiple hidden onChange={e => e.target.files && handleFiles(e.target.files)}/></label></div>{kind === 'article' && <><input className="title-input" value={title} onChange={e => setTitle(e.target.value)} placeholder="文章标题" aria-label="文章标题"/><input className="summary-input" value={summary} onChange={e => setSummary(e.target.value)} placeholder="摘要（可选）" aria-label="文章摘要"/><input className="summary-input" value={slug} onChange={e => setSlug(e.target.value)} placeholder="地址 slug（可选，编辑时保持原值）" aria-label="文章地址"/></>}<textarea id="editor-panel" role="tabpanel" aria-labelledby={`tab-${mode}`} ref={editorRef} value={markdown} onChange={e => { if (!composingRef.current) setMarkdown(e.target.value); }} onCompositionStart={() => { composingRef.current = true; }} onCompositionEnd={e => { composingRef.current = false; setMarkdown(e.currentTarget.value); }} onPaste={e => { const files = Array.from(e.clipboardData.files); if (files.length) { e.preventDefault(); handleFiles(files); } }} onDrop={e => { e.preventDefault(); handleFiles(e.dataTransfer.files); }} onDragOver={e => e.preventDefault()} placeholder="从一句话开始。支持 Markdown，也可以直接粘贴图片。" aria-label="Markdown 正文编辑" />{(mode === 'markdown' || mode === 'preview') && <Preview markdown={markdown}/>}<div className="status" aria-live="polite">{message}</div>{uploads.length > 0 && <ul className="upload-list" aria-label="媒体上传队列">{uploads.map(item => <li key={item.id}><span>{item.fileName}</span><span className={`tag upload-${item.status}`}>{item.status === 'ready' ? '已完成' : item.status === 'uploading' ? '上传中' : item.status === 'failed' ? '失败' : '排队中'}{item.status === 'failed' && <label className="inline-action">{item.needsReselect ? '重选' : '重试'}<input type="file" accept="image/*,audio/*,video/*,application/pdf" hidden onChange={e => { const file = e.target.files?.[0]; if (file) void retryUpload(item, file); }}/></label>}</span></li>)}</ul>}<div className="composer-footer"><label>日期 <input type="date" value={date} onChange={e => setDate(e.target.value)}/></label><label>类型 <select value={kind} onChange={e => setKind(e.target.value)}><option value="note">随记</option><option value="article">文章</option></select></label><label>状态 <select value={status} onChange={e => setStatus(e.target.value as EditorStatus)}><option value="draft">草稿</option><option value="public">公开</option><option value="private">私人</option></select></label><label>分类 <input value={categories} onChange={e => setCategories(e.target.value)} placeholder="日常, 工作" aria-label="分类"/></label><label>标签 <input value={tags} onChange={e => setTags(e.target.value)} placeholder="#阅读 #想法" aria-label="标签"/></label><button className="primary" disabled={saving || loadingEdit || !markdown.trim()} onClick={save}>{saving ? '保存中…' : editingEntryID ? '保存修改' : '保存'}</button>{undoToken && <button className="secondary" onClick={undo}>撤销保存</button>}</div></div></section><aside className="sidebar"><div className="side-card"><div className="side-card-heading"><h3>草稿托盘（{drafts.length}）</h3><button className="icon-button" type="button" onClick={() => void refreshDrafts()} aria-label="刷新草稿">↻</button></div>{drafts.length ? <ul className="draft-list">{drafts.slice(0, 8).map(d => <li key={d.id}><button type="button" onClick={() => loadDraft(d)}><strong>{draftName(d)}</strong><small>{new Date(d.updatedAt).toLocaleString('zh-CN')}</small></button></li>)}</ul> : <p>停止输入后自动保存。你可以同时保留多份未命名草稿。</p>}</div><div className="side-card"><h3>写作原则</h3><p>唯一保存按钮。先写，再决定是草稿、公开还是私人。私人内容不会出现在公开搜索和正文接口。</p></div><div className="side-card"><h3>更多工具</h3><p><Link href="/admin/entries">版本、回收站与导出入口</Link>已接入版本、回收站和导出工具。</p></div></aside></div></main>;
}
