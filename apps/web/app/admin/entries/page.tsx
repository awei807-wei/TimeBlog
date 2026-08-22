'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { History, MoreHorizontal, Pencil, RotateCcw, Trash2 } from 'lucide-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/app/components/ui/dropdown-menu';
import { API, getAdminCalendar, getAdminEntries, getExports, getMedia, getVersions, type AdminCalendarDay, type AdminEntry, type ExportJob, type Media, type Version } from '@/lib/api';
import { invalidatePublicCaches } from '@/lib/cache-invalidation';

type Section = 'entries' | 'versions' | 'trash' | 'media' | 'exports' | 'calendar';

export default function EntriesAdmin() {
  const router = useRouter();
  const [entries, setEntries] = useState<AdminEntry[]>([]);
  const [status, setStatus] = useState('');
  const [section, setSection] = useState<Section>('entries');
  const [versions, setVersions] = useState<Version[]>([]);
  const [media, setMedia] = useState<Media[]>([]);
  const [mediaCursor, setMediaCursor] = useState<string | undefined>();
  const [exportsList, setExportsList] = useState<ExportJob[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const returnToEntries = useCallback(() => {
    setSection('entries');
    setSelectedId('');
    setVersions([]);
    window.setTimeout(() => document.getElementById('entry-list-heading')?.focus(), 0);
  }, []);

  const loadEntries = useCallback(async (nextStatus = status) => {
    setBusy(true); setError('');
    try { const data = await getAdminEntries(nextStatus); setEntries(data.entries || []); }
    catch { setError('请登录后查看内容管理，或检查后台 API 是否可用。'); }
    finally { setBusy(false); }
  }, [status]);

  useEffect(() => { const timer = window.setTimeout(() => { void loadEntries(); }, 0); return () => window.clearTimeout(timer); }, [loadEntries]);

  async function loadSection(next: Section) {
    setSection(next); setError(''); setMessage('');
    try {
      if (next === 'media') { const data = await getMedia(); setMedia(data.media || []); setMediaCursor(data.nextCursor); }
      if (next === 'exports') setExportsList((await getExports()).exports || []);
    } catch { setError('该管理接口暂时不可用，请稍后重试。'); }
  }

  useEffect(() => {
    if (section !== 'exports') return;
    const interval = window.setInterval(() => { void getExports().then(data => setExportsList(data.exports || [])).catch(() => undefined); }, 5000);
    return () => window.clearInterval(interval);
  }, [section]);

  async function loadVersions(id: string) {
    setSelectedId(id); setSection('versions'); setError('');
    try { setVersions((await getVersions(id)).versions || []); }
    catch { setError('版本接口暂时不可用。'); }
  }

  async function mutateEntry(id: string, action: 'restore' | 'trash' | 'purge') {
    if (action === 'trash' && !window.confirm('确定将这条内容移入回收站吗？')) return;
    setBusy(true); setMessage('操作中…');
    try {
      const csrf = await fetch(`${API}/auth/session`, { cache: 'no-store', credentials: 'include' }).then(r => r.json()).then(v => v.csrfToken || '');
      const response = await fetch(`${API}/admin/entries/${id}${action === 'trash' ? '' : `/${action}`}`, { method: action === 'trash' ? 'DELETE' : 'POST', credentials: 'include', headers: { 'X-CSRF-Token': csrf, 'Idempotency-Key': crypto.randomUUID() } });
      if (!response.ok) throw new Error(String(response.status));
      setMessage(action === 'trash' ? '已移入回收站' : action === 'restore' ? '已恢复内容' : '已永久删除');
      await invalidatePublicCaches({ entryId: id, reason: action });
      router.refresh();
      await loadEntries(status);
    } catch { setError('操作失败：请确认登录状态、CSRF 或 API 是否可用。'); }
    finally { setBusy(false); }
  }

  async function restoreVersion(entryId: string, version: number) {
    setBusy(true); setMessage('恢复版本中…');
    try {
      const csrf = await fetch(`${API}/auth/session`, { cache: 'no-store', credentials: 'include' }).then(r => r.json()).then(v => v.csrfToken || '');
      const response = await fetch(`${API}/admin/entries/${entryId}/versions/${version}/restore`, { method: 'POST', credentials: 'include', headers: { 'X-CSRF-Token': csrf } });
      if (!response.ok) throw new Error(String(response.status));
      setMessage(`已从版本 ${version} 创建新版本`);
      await invalidatePublicCaches({ entryId, reason: 'edit' });
      router.refresh();
    } catch { setError('版本恢复失败，请确认登录状态或版本接口是否可用。'); }
    finally { setBusy(false); }
  }

  async function createExport(type: 'public' | 'full') {
    setBusy(true); setMessage('导出任务排队中…');
    try {
      const csrf = await fetch(`${API}/auth/session`, { cache: 'no-store', credentials: 'include' }).then(r => r.json()).then(v => v.csrfToken || '');
      const response = await fetch(`${API}/admin/exports`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ type }) });
      if (!response.ok) throw new Error(String(response.status));
      const job = await response.json() as ExportJob;
      setExportsList(current => [job, ...current.filter(item => item.id !== job.id)]); setMessage('导出任务已创建，页面会在切换到导出时刷新状态');
    } catch { setError('导出接口暂时不可用。'); }
    finally { setBusy(false); }
  }


  const shownEntries = entries.filter(entry => section === 'trash' ? entry.status === 'trashed' : section === 'entries' ? entry.status !== 'trashed' : true);
  return <main id="main-content" className="shell"><div className="eyebrow">ADMIN · CONTENT DESK</div><div className="admin-heading"><div><h1>内容管理</h1><p className="note">公开、私人、草稿、版本与回收站都从同一处管理；失败操作会保留当前界面状态。</p></div><div className="filter-row"><label htmlFor="entry-status">状态</label><select id="entry-status" value={status} onChange={e => { setStatus(e.target.value); void loadEntries(e.target.value); }}><option value="">全部</option><option value="draft">草稿</option><option value="published">已发布</option><option value="trashed">回收站</option></select></div></div><div className="admin-tabs" role="tablist" aria-label="内容管理区域">{(['entries', 'trash', 'media', 'exports', 'calendar'] as Section[]).map(value => <button key={value} type="button" className={section === value ? 'tool active' : 'tool'} onClick={() => void loadSection(value)}>{value === 'entries' ? '内容' : value === 'trash' ? '回收站' : value === 'media' ? '媒体' : value === 'exports' ? '导出' : '年度热力图'}</button>)}<Link href="/admin/settings" className="tool settings-compat-link">设置</Link></div>{message && <div className="status" aria-live="polite">{message}</div>}{error && <div className="error-panel" role="alert">{error}</div>}{busy ? <div className="empty" role="status">载入中…</div> : section === 'media' ? <MediaPanel media={media} nextCursor={mediaCursor}/> : section === 'exports' ? <ExportPanel jobs={exportsList} onCreate={createExport}/> : section === 'calendar' ? <AdminCalendarPanel/> : section === 'versions' ? <VersionPanel versions={versions} entryId={selectedId} onRestore={restoreVersion} onBack={returnToEntries}/> : <section className="entry-table" aria-live="polite"><h2 id="entry-list-heading" className="entry-list-heading" tabIndex={-1}>内容列表</h2>{shownEntries.length ? shownEntries.map(entry => <article className="management-row" key={entry.id}><div><div className="entry-meta"><span>{entry.journalDate}</span><span className="tag">{entry.status}</span><span className="tag">{entry.visibility}</span></div><h2>{entry.title || (entry.markdown || '未命名').slice(0, 56)}</h2></div><div className="management-actions"><time dateTime={entry.updatedAt}>{new Date(entry.updatedAt).toLocaleString('zh-CN')}</time><DropdownMenu><DropdownMenuTrigger asChild><button type="button" className="entry-actions-trigger" aria-label="打开内容操作菜单"><MoreHorizontal aria-hidden="true" /></button></DropdownMenuTrigger><DropdownMenuContent align="end" sideOffset={8}>{entry.status !== 'trashed' && <DropdownMenuItem asChild><Link href={`/admin?edit=${encodeURIComponent(entry.id)}`} aria-label={`编辑${entry.title || '这条内容'}`}><Pencil aria-hidden="true" />编辑</Link></DropdownMenuItem>}<DropdownMenuItem onSelect={() => void loadVersions(entry.id)}><History aria-hidden="true" />版本</DropdownMenuItem>{entry.status === 'trashed' ? <DropdownMenuItem disabled={busy} onSelect={() => void mutateEntry(entry.id, 'restore')}><RotateCcw aria-hidden="true" />恢复</DropdownMenuItem> : <DropdownMenuItem className="entry-action-destructive" disabled={busy} onSelect={() => void mutateEntry(entry.id, 'trash')}><Trash2 aria-hidden="true" />回收</DropdownMenuItem>}</DropdownMenuContent></DropdownMenu></div></article>) : <div className="empty">没有符合条件的内容。</div>}</section>}</main>;
}

function getYearDays(year: number) {
  const days: string[] = [];
  const start = new Date(Date.UTC(year, 0, 1));
  const end = new Date(Date.UTC(year + 1, 0, 1));
  for (const cursor = new Date(start); cursor < end; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    days.push(cursor.toISOString().slice(0, 10));
  }
  return days;
}

function heatLevel(day: AdminCalendarDay | undefined) {
  if (!day) return 0;
  const total = day.public + day.private + day.draft + day.trashed;
  return total >= 6 ? 4 : total >= 3 ? 3 : total >= 1 ? 2 : 1;
}

function AdminCalendarPanel() {
  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState(thisYear);
  const [includeDrafts, setIncludeDrafts] = useState(false);
  const [days, setDays] = useState<Record<string, AdminCalendarDay>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    void getAdminCalendar(String(year), includeDrafts).then(data => {
      if (!cancelled) { setDays(data.days || {}); setError(''); setLoading(false); }
    }).catch(() => {
      if (!cancelled) { setDays({}); setError('年度统计暂时不可用，请确认登录状态或后台 API。'); setLoading(false); }
    });
    return () => { cancelled = true; };
  }, [year, includeDrafts]);

  const allDays = getYearDays(year);
  const total = Object.values(days).reduce((sum, day) => sum + day.public + day.private + day.draft + day.trashed, 0);
  const previous = () => { setLoading(true); setYear(current => current - 1); };
  const next = () => { setLoading(true); setYear(current => current + 1); };
  return <section className="entry-table admin-calendar-panel" aria-labelledby="admin-calendar-title">
    <div className="admin-heading"><div><h2 id="admin-calendar-title">年度热力图</h2><p className="note">数字和文字同时表达数量；颜色只用于辅助区分密度，不作为唯一信息来源。</p></div><div className="management-actions"><button type="button" className="secondary" onClick={previous} aria-label="上一年">←</button><strong aria-live="polite">{year}</strong><button type="button" className="secondary" onClick={next} aria-label="下一年">→</button></div></div>
    <label className="calendar-draft-toggle"><input type="checkbox" checked={includeDrafts} onChange={event => { setLoading(true); setIncludeDrafts(event.target.checked); }}/> 纳入草稿统计</label>
    {loading ? <div className="empty" role="status">年度统计载入中…</div> : error ? <div className="error-panel" role="alert">{error}</div> : <>
      {!total && <div className="empty">{includeDrafts ? '该年度没有记录。' : '该年度没有已发布、私人或回收站记录。'}</div>}
      <div className="heatmap-legend" aria-label="热力图图例"><span><i className="heat-level level-0"/>无记录</span><span><i className="heat-level level-2"/>1–2</span><span><i className="heat-level level-3"/>3–5</span><span><i className="heat-level level-4"/>6+</span></div>
      <div className="admin-heatmap" role="grid" aria-label={`${year} 年每日记录数量`}>
        {allDays.map(date => { const day = days[date]; const count = day ? day.public + day.private + day.draft + day.trashed : 0; return <div role="gridcell" className={`heat-day level-${heatLevel(day)}`} key={date} title={`${date}：${count} 条记录`} aria-label={`${date}，${count} 条记录，公开 ${day?.public || 0}，私人 ${day?.private || 0}，草稿 ${day?.draft || 0}，回收站 ${day?.trashed || 0}`}><span>{count || '·'}</span></div>; })}
      </div>
    </>}
  </section>;
}

function VersionPanel({ versions, entryId, onRestore, onBack }: { versions: Version[]; entryId: string; onRestore: (entryId: string, version: number) => void; onBack: () => void }) {
  return <section className="entry-table"><div className="admin-heading"><h2>版本历史</h2><button type="button" className="secondary" onClick={onBack} aria-label="返回内容列表">返回列表</button></div>{versions.length ? versions.map(version => <article className="management-row" key={version.version}><div><strong>版本 {version.version}</strong><p>{String(version.snapshot.title || version.snapshot.markdown || '无标题')}</p></div><div className="management-actions"><time>{new Date(version.createdAt).toLocaleString('zh-CN')}</time><button className="secondary" type="button" onClick={() => onRestore(entryId, version.version)}>恢复此版本</button></div></article>) : <div className="empty">{entryId ? '没有历史版本。' : '请选择一条内容查看版本。'}</div>}</section>;
}

function MediaPanel({ media: initialMedia, nextCursor: initialCursor }: { media: Media[]; nextCursor?: string }) {
  const [media, setMedia] = useState(initialMedia);
  const [cursor, setCursor] = useState(initialCursor);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function loadMore() {
    if (!cursor || loading) return;
    setLoading(true);
    setError('');
    try {
      const data = await getMedia(cursor);
      setMedia(current => {
        const byId = new Map(current.map(item => [item.id, item]));
        for (const item of data.media || []) byId.set(item.id, item);
        return Array.from(byId.values());
      });
      setCursor(data.nextCursor);
    } catch {
      setError('加载更多媒体失败，请稍后重试。');
    } finally {
      setLoading(false);
    }
  }

  async function retryPublish(id: string) {
    setError('');
    try {
      const csrf = await fetch(`${API}/auth/session`, { cache: 'no-store', credentials: 'include' }).then(response => response.json()).then(value => value.csrfToken || '');
      const response = await fetch(`${API}/admin/media/${encodeURIComponent(id)}/retry-publish`, { method: 'POST', credentials: 'include', headers: { 'X-CSRF-Token': csrf } });
      if (!response.ok) { const detail = await response.json().catch(() => ({})) as { detail?: string }; throw new Error(detail.detail || '重试外部发布失败'); }
      setMedia(current => current.map(item => item.id === id ? { ...item, externalPublishStatus: 'pending', externalPublishError: '' } : item));
    } catch (cause) { setError(cause instanceof Error ? cause.message : '重试外部发布失败'); }
  }
  const publishLabel = (item: Media) => ({ pending: '等待外部发布', publishing: '正在外部发布', published: '外部发布成功', failed: '外部发布失败', trash_pending: '远端已回收', not_requested: '仅本地保存' }[item.externalPublishStatus || 'not_requested']);
  return <section className="entry-table"><div className="admin-heading"><h2>媒体库</h2><p className="note">本地原件始终保留；外部发布异步执行，失败不会丢失附件。</p></div>{media.length ? media.map(item => <article className="management-row" key={item.id}><div><strong>{item.originalName}</strong><div className="entry-meta"><span>{item.mimeType}</span><span>{item.sizeBytes} bytes</span><span className="tag">{item.status}</span><span className="tag">{publishLabel(item)}</span></div>{item.externalPublishError && <p className="note">{item.externalPublishError}</p>}</div><div className="management-actions"><time>{item.createdAt ? new Date(item.createdAt).toLocaleString('zh-CN') : '—'}</time>{item.externalPublishStatus === 'failed' && <button type="button" className="secondary" onClick={() => void retryPublish(item.id)}>重试发布</button>}</div></article>) : <div className="empty">没有媒体，或媒体接口尚未启用。</div>}{error && <div className="error-panel" role="alert">{error}</div>}{cursor && <button type="button" className="secondary load-more" onClick={() => void loadMore()} disabled={loading}>{loading ? '加载中…' : '加载更多媒体'}</button>}</section>;
}

function ExportPanel({ jobs, onCreate }: { jobs: ExportJob[]; onCreate: (type: 'public' | 'full') => void }) {
  return <section className="entry-table"><div className="admin-heading"><div><h2>导出任务</h2><p className="note">导出任务状态由服务器决定；下载链接仅在 ready 后出现。</p></div><div className="management-actions"><button type="button" className="secondary" onClick={() => onCreate('public')}>排队公开导出</button><button type="button" className="primary" onClick={() => onCreate('full')}>排队完整导出</button></div></div>{jobs.length ? jobs.map(job => <article className="management-row" key={job.id}><div><strong>{job.type === 'full' ? '完整导出' : '公开导出'}</strong><div className="entry-meta"><span className="tag">{job.status}</span>{job.sha256 && <span>{job.sha256.slice(0, 12)}…</span>}</div></div>{job.downloadUrl && job.status === 'ready' ? <a className="secondary" href={job.downloadUrl}>下载</a> : <span className="status">等待处理</span>}</article>) : <div className="empty">没有导出任务，或导出接口尚未启用。</div>}</section>;
}
