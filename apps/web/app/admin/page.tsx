'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { MDXEditorMethods } from '@mdxeditor/editor';
import { AlertCircle, Check, LoaderCircle, Paperclip, Trash2, X } from 'lucide-react';
import { API } from '@/lib/api';
import { invalidatePublicCaches } from '@/lib/cache-invalidation';
import { deserializeEditorStatus, nextRetryAt, serializeEditorStatus } from '@/lib/editor-utils';
import { AdminRequestError, responseError } from './admin-errors';
import MdxMarkdownEditor, { MEDIA_MODE_HINT, type MdxEditorViewMode } from './MdxMarkdownEditor';
import AttachmentPreview from './AttachmentPreview';
import UploadPanel from './UploadPanel';
import TagInput from './TagInput';
import JournalDatePicker from './JournalDatePicker';
import DraftTray, { useDraftTray } from './DraftTray';
import { dbDelete, dbGetAll, dbPut, DRAFT_STORE, QUEUE_STORE, type Draft, type QueueItem } from './editor-storage';
import { useMediaUploads, type MediaCapability } from './useMediaUploads';
import { prepareMarkdownForMdxEditor, restoreMarkdownFromMdxEditor } from './mdx-compat';

type EditorStatus = 'draft' | 'public' | 'private';
function readTaxonomy(value: unknown, separator: RegExp, stripHash = false) {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(separator) : [];
  const seen = new Set<string>();
  return raw.map(item => String(item).trim()).map(item => stripHash ? item.replace(/^#+/, '').trim() : item).filter(item => {
    if (!item) return false;
    const key = item.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export default function AdminPage() {
  const router = useRouter();
  const editorRef = useRef<MDXEditorMethods>(null);
  const markdownRef = useRef('');
  const draftID = useRef<string | null>(null);
  const lastSync = useRef(0);
  const [markdown, setMarkdown] = useState('');
  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [categories, setCategories] = useState<string[]>(['日常']);
  const [tags, setTags] = useState<string[]>([]);
  const [status, setStatus] = useState<EditorStatus>('draft');
  const [kind, setKind] = useState('note');
  const [date, setDate] = useState(new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }));
  const [slug, setSlug] = useState('');
  const [uploadPanelOpen, setUploadPanelOpen] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadingEdit, setLoadingEdit] = useState(false);
  const [editingEntryID, setEditingEntryID] = useState('');
  const [editingWorkingID, setEditingWorkingID] = useState('');
  const [editingBaseRevision, setEditingBaseRevision] = useState(0);
  const [message, setMessage] = useState('');
  const [undoToken, setUndoToken] = useState('');
  const [csrf, setCsrf] = useState('');
  const csrfRef = useRef('');
  const sessionRequestRef = useRef<Promise<string> | null>(null);
  const [online, setOnline] = useState(true);
  const [editorReady, setEditorReady] = useState(false);
  const [editorViewMode, setEditorViewMode] = useState<MdxEditorViewMode>('rich-text');
  const [mediaCapability, setMediaCapability] = useState<MediaCapability>({ checked: false, provider: '', imageUploadEnabled: false, nonImageUploadEnabled: false, reason: '正在检查媒体存储…' });
  const [requestedEditID, setRequestedEditID] = useState('');
  const editRequested = useRef(false);

  useEffect(() => {
    markdownRef.current = markdown;
  }, [markdown]);

  const handleEditorViewModeChange = useCallback((viewMode: MdxEditorViewMode) => {
    setEditorViewMode(viewMode);
    if (viewMode !== 'rich-text') setUploadPanelOpen(false);
  }, []);

  const canInsertMedia = editorViewMode === 'rich-text';

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

  const insertMediaReference = useCallback((reference: string) => {
    // MDXEditor owns the selection and inserts into the active Lexical
    // paragraph. A blank line on both sides keeps attachments on their own
    // Markdown block while preserving the user's current cursor location.
    const editor = editorRef.current;
    if (!editor) {
      const error = '编辑器正在加载，请稍后再试';
      setMessage(error);
      throw new Error(error);
    }
    editor.focus();
    editor.insertMarkdown(`\n${reference}\n`);
    return reference;
  }, []);

  const applyMarkdown = useCallback((next: string) => {
    const restored = restoreMarkdownFromMdxEditor(next, prepareMarkdownForMdxEditor(markdownRef.current).replacements);
    markdownRef.current = restored;
    setMarkdown(restored);
  }, []);

  const currentDraftId = useCallback(() => {
    if (!draftID.current) draftID.current = crypto.randomUUID();
    return draftID.current;
  }, []);

  const { uploads, mediaStillProcessing: mediaQueueProcessing, uploadImageForEditor, retryUpload, handleFiles, cancelUpload, removeUpload, recoverUploads } = useMediaUploads({
    editorRef,
    markdownRef,
    csrfRef,
    csrf,
    status,
    mediaCapability,
    refreshSessionCSRF,
    insertMediaReference,
    applyMarkdown,
    responseError,
    onMessage: setMessage,
  });

  const payload = useMemo(() => ({ markdown, title, summary, slug, categories, tags, ...serializeEditorStatus(status), kind, journalDate: date }), [markdown, title, summary, slug, categories, tags, status, kind, date]);
  const { drafts, refreshDrafts } = useDraftTray(setMessage);

  useEffect(() => {
    draftID.current = crypto.randomUUID();
    const update = () => setOnline(navigator.onLine);
    update(); window.addEventListener('online', update); window.addEventListener('offline', update);
    void refreshSessionCSRF().catch(() => undefined);
    fetch(`${API}/admin/media/capability`, { credentials: 'include', headers: { Accept: 'application/json' } }).then(async response => {
      const body = await response.json().catch(() => ({}));
      const writable = response.ok && body.writable === true;
      setMediaCapability({ checked: true, provider: String(body.provider || ''), imageUploadEnabled: writable && body.imageUploadEnabled !== false, nonImageUploadEnabled: writable && body.nonImageUploadEnabled !== false, reason: writable ? '' : String(body.reason || '媒体存储不可写，上传已禁用') });
    }).catch(() => setMediaCapability({ checked: true, provider: '', imageUploadEnabled: false, nonImageUploadEnabled: false, reason: '无法检测媒体存储状态，上传已禁用' }));
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); };
  }, [refreshSessionCSRF]);

  useEffect(() => {
    if (!mediaCapability.checked || !editorReady) return;
    const timer = window.setTimeout(() => { void recoverUploads(); }, 0);
    return () => window.clearTimeout(timer);
  // Recovery waits for capability discovery so uploadMedia does not close over
  // the initial "unchecked" media state.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorReady, mediaCapability.checked]);

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
      const nextMarkdown = String(value.markdown || '');
      applyMarkdown(nextMarkdown);
      setTitle(String(value.title || ''));
      setSummary(String(value.summary || ''));
      setSlug(String(value.slug || ''));
      setCategories(readTaxonomy(value.categories, /,/));
      setTags(readTaxonomy(value.tags, /[,\s]+/, true));
      setStatus(deserializeEditorStatus({ status: String(value.status || ''), visibility: String(value.visibility || '') }));
      setKind(String(value.kind || 'note'));
      setDate(String(value.journalDate || date));
      setMessage('已载入内容，可直接编辑后保存');
      window.setTimeout(() => editorRef.current?.focus(), 0);
    }).catch(error => {
      if (!cancelled) setMessage(error instanceof Error && error.message === '404' ? '内容不存在或已被删除' : '载入内容失败，请检查登录状态或网络');
    }).finally(() => { if (!cancelled) setLoadingEdit(false); });
    return () => { cancelled = true; };
  }, [applyMarkdown, csrf, requestedEditID, date]);

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
    const editorMarkdown = editorRef.current?.getMarkdown() ?? markdown;
    const effectiveMarkdown = restoreMarkdownFromMdxEditor(editorMarkdown, prepareMarkdownForMdxEditor(markdown).replacements);
    markdownRef.current = effectiveMarkdown;
    const mediaStillProcessing = uploads.some(item => item.status === 'queued' || item.status === 'uploading');
    const hasTemporaryMediaReference = uploads.some(item => effectiveMarkdown.includes(`media://${item.id}`));
    if (mediaStillProcessing || hasTemporaryMediaReference) {
      setMessage('附件仍在上传，请完成后再保存');
      return;
    }
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
        applyMarkdown('');
        setTitle(''); setSummary(''); setSlug(''); setMessage('已保存，15 秒内可撤销'); editorRef.current?.focus();
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
    applyMarkdown(body.entry?.markdown || '');
    setTitle(body.entry?.title || ''); setSummary(body.entry?.summary || ''); setCategories(readTaxonomy(body.entry?.categories, /,/)); setTags(readTaxonomy(body.entry?.tags, /[,\s]+/, true)); setDate(body.entry?.journalDate || date); setKind(body.entry?.kind || 'note'); setStatus('draft'); setUndoToken(''); setMessage('已撤销并回填编辑器'); editorRef.current?.focus();
  }

  function loadDraft(draft: Draft) {
    draftID.current = draft.clientDraftId;
    const value = draft.payload;
    applyMarkdown(String(value.markdown || ''));
    setTitle(String(value.title || '')); setSummary(String(value.summary || '')); setCategories(readTaxonomy(value.categories, /,/)); setTags(readTaxonomy(value.tags, /[,\s]+/, true)); setStatus(value.visibility === 'private' || value.status === 'private' ? 'private' : value.status === 'published' ? 'public' : 'draft'); setKind(String(value.kind || 'note')); setDate(String(value.journalDate || date)); setMessage('已载入草稿'); editorRef.current?.focus();
  }

  const uploadDisabled = mediaCapability.checked && !mediaCapability.imageUploadEnabled && !mediaCapability.nonImageUploadEnabled;
  const mediaInputDisabled = uploadDisabled || !canInsertMedia;
  const mediaAvailabilityMessage = !editorReady
    ? '编辑器正在加载，请稍后再试'
    : !canInsertMedia
      ? MEDIA_MODE_HINT
    : !mediaCapability.checked
      ? mediaCapability.reason
      : uploadDisabled
        ? mediaCapability.reason
        : '本地媒体存储已就绪 · 图片与附件可上传';

  const mediaStillProcessing = mediaQueueProcessing || uploads.some(item => markdown.includes(`media://${item.id}`));

  return <main id="main-content" className="shell"><div className="admin-grid"><section><div className="eyebrow">WRITE NOW · {online ? 'ONLINE' : 'OFFLINE'}</div><h1>{editingEntryID ? '编辑内容' : '此刻想写些什么？'}</h1><div className="composer">
    <div className="editor-toolbar editor-toolbar-actions" aria-label="编辑工具">
      <span className="editor-toolbar-label">Markdown 编辑器</span>
      <button type="button" className={`tool upload-control${uploadPanelOpen ? ' active' : ''}${mediaInputDisabled ? ' upload-disabled' : ''}`} aria-label="添加媒体" aria-disabled={mediaInputDisabled} aria-expanded={uploadPanelOpen} disabled={mediaInputDisabled} title={mediaInputDisabled ? mediaAvailabilityMessage : '上传图片、音频、视频或 PDF'} onClick={() => setUploadPanelOpen(open => !open)}><Paperclip aria-hidden="true" /> 添加媒体</button>
    </div>
    <div className={`media-capability${mediaInputDisabled ? ' is-unavailable' : ''}`} role="status">{mediaAvailabilityMessage}</div>
    {kind === 'article' && <><input className="title-input" value={title} onChange={e => setTitle(e.target.value)} placeholder="文章标题" aria-label="文章标题"/><input className="summary-input" value={summary} onChange={e => setSummary(e.target.value)} placeholder="摘要（可选）" aria-label="文章摘要"/><input className="summary-input" value={slug} onChange={e => setSlug(e.target.value)} placeholder="地址 slug（可选，编辑时保持原值）" aria-label="文章地址"/></>}
    <MdxMarkdownEditor
      markdown={markdown}
      editorRef={editorRef}
      onChange={next => { markdownRef.current = next; setMarkdown(next); }}
      onFiles={files => { if (!mediaInputDisabled) handleFiles(files); }}
      onImageUpload={uploadImageForEditor}
      onError={setMessage}
      onNotice={setMessage}
      onReady={setEditorReady}
      onViewModeChange={handleEditorViewModeChange}
      disabled={saving || loadingEdit}
    />
    <UploadPanel
      open={uploadPanelOpen}
      dragActive={dragActive}
      disabled={mediaInputDisabled}
      disabledMessage={mediaAvailabilityMessage}
      onDragEnter={event => { event.preventDefault(); setDragActive(true); }}
      onDragOver={event => { event.preventDefault(); setDragActive(true); }}
      onDragLeave={event => { event.preventDefault(); setDragActive(false); }}
      onDrop={event => { event.preventDefault(); setDragActive(false); if (!mediaInputDisabled) handleFiles(event.dataTransfer.files); }}
      onFiles={files => { if (!mediaInputDisabled) handleFiles(files); }}
    />
    <AttachmentPreview markdown={markdown} uploads={uploads} />
    <div className="status" aria-live="polite">{message}</div>
    {uploads.length > 0 && <ul className="upload-list" aria-label="媒体上传队列">{uploads.map(item => <li key={item.id}><div className="upload-item-main"><span className="upload-name">{item.fileName}</span>{item.status === 'uploading' && <div className="upload-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((item.progress || 0) * 100)}><span style={{ width: `${Math.round((item.progress || 0) * 100)}%` }} /></div>}</div><span className="upload-actions"><span className={`tag upload-${item.status}`}>{item.status === 'ready' ? <><Check aria-hidden="true" />已完成</> : item.status === 'uploading' ? <><LoaderCircle className="spin" aria-hidden="true" />上传中</> : item.status === 'failed' ? <><AlertCircle aria-hidden="true" />失败</> : '排队中'}</span>{item.status === 'uploading' && <button type="button" className="inline-action" onClick={() => cancelUpload(item)}><X aria-hidden="true" />取消</button>}{item.status === 'failed' && <label className="inline-action">{item.needsReselect ? '重选' : '重试'}<input type="file" accept="image/*,audio/*,video/*,application/pdf" hidden onChange={e => { const file = e.target.files?.[0]; if (file) void retryUpload(item, file); e.currentTarget.value = ''; }}/></label>}<button type="button" className="inline-action remove-media" onClick={() => removeUpload(item)} aria-label={`从当前草稿移除 ${item.fileName}`}><Trash2 aria-hidden="true" />移除附件</button></span></li>)}</ul>}
    <div className="composer-footer"><JournalDatePicker value={date} onChange={setDate} disabled={saving || loadingEdit}/><label>类型 <select value={kind} onChange={e => setKind(e.target.value)}><option value="note">随记</option><option value="article">文章</option></select></label><label>状态 <select value={status} onChange={e => setStatus(e.target.value as EditorStatus)}><option value="draft">草稿</option><option value="public">公开</option><option value="private">私人</option></select></label><TagInput label="分类" values={categories} onChange={setCategories} placeholder="输入后回车" ariaLabel="分类"/><TagInput label="标签" values={tags} onChange={setTags} placeholder="输入后回车" ariaLabel="标签" prefix="#"/><button className="primary" disabled={saving || loadingEdit || mediaStillProcessing || !markdown.trim()} onClick={save}>{saving ? '保存中…' : editingEntryID ? '保存修改' : '保存'}</button>{undoToken && <button className="secondary" onClick={undo}>撤销保存</button>}</div>
  </div></section><aside className="sidebar"><DraftTray drafts={drafts} onLoadDraft={loadDraft}/><div className="side-card"><h3>写作原则</h3><p>唯一保存按钮。先写，再决定是草稿、公开还是私人。私人内容不会出现在公开搜索和正文接口。</p></div><div className="side-card"><h3>更多工具</h3><p><Link href="/admin/entries">版本、回收站与导出入口</Link>已接入版本、回收站和导出工具。</p></div></aside></div></main>;

}
