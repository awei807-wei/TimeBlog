'use client';

import { useEffect, useState } from 'react';
import { Check, CloudCog, DatabaseBackup, Save, ShieldCheck, TestTube2, XCircle } from 'lucide-react';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/app/components/ui/card';
import { getExternalImageHostConfig, getNASBackupConfig, type ExternalImageHostConfig, type NASBackupConfig } from '@/lib/api';
import { runEndpointProbe, type IntegrationProbeState } from '@/lib/integration-probe';
import { mutateJSON } from './settings-api';

type ImageDraft = { enabled: boolean; endpoint: string; workspaceId: string; stablePublicUrls: boolean; syncDeletes: boolean; token: string; clearToken: boolean };
type NASDraft = { enabled: boolean; sourceHost: string; sourcePath: string; destinationPath: string; retentionDays: number };

function Configured({ ready }: { ready: boolean }) {
  return ready ? <span className="settings-status is-ready"><Check aria-hidden="true" />已配置</span> : <span className="settings-status"><XCircle aria-hidden="true" />未配置</span>;
}

function defaultImageDraft(value: ExternalImageHostConfig | null): ImageDraft {
  return { enabled: value?.enabled || false, endpoint: value?.endpoint || 'https://image.cainiao.me/api/uploads', workspaceId: value?.workspaceId || '', stablePublicUrls: value?.stablePublicUrls || false, syncDeletes: value?.syncDeletes || false, token: '', clearToken: false };
}

function defaultNASDraft(value: NASBackupConfig | null): NASDraft {
  return { enabled: value?.enabled || false, sourceHost: value?.sourceHost || '', sourcePath: value?.sourcePath || '/srv/timeblog/backup-staging', destinationPath: value?.destinationPath || '/srv/timeblog/nas-snapshots', retentionDays: value?.retentionDays || 90 };
}

export default function IntegrationsSettingsPanel() {
  const [image, setImage] = useState<ExternalImageHostConfig | null>(null);
  const [nas, setNAS] = useState<NASBackupConfig | null>(null);
  const [imageDraft, setImageDraft] = useState<ImageDraft>(defaultImageDraft(null));
  const [nasDraft, setNASDraft] = useState<NASDraft>(defaultNASDraft(null));
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<'image' | 'nas' | ''>('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [probeState, setProbeState] = useState<IntegrationProbeState>({ phase: 'idle', message: '' });

  async function load() {
    setLoading(true); setError('');
    try {
      const [imageValue, nasValue] = await Promise.all([getExternalImageHostConfig(), getNASBackupConfig()]);
      setImage(imageValue); setNAS(nasValue); setImageDraft(defaultImageDraft(imageValue)); setNASDraft(defaultNASDraft(nasValue));
    } catch { setError('集成配置暂时不可用，请稍后重试。'); }
    finally { setLoading(false); }
  }
  useEffect(() => {
    let cancelled = false;
    void Promise.all([getExternalImageHostConfig(), getNASBackupConfig()]).then(([imageValue, nasValue]) => {
      if (cancelled) return;
      setImage(imageValue);
      setNAS(nasValue);
      setImageDraft(defaultImageDraft(imageValue));
      setNASDraft(defaultNASDraft(nasValue));
    }).catch(() => {
      if (!cancelled) setError('集成配置暂时不可用，请稍后重试。');
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  async function saveImage() {
    if (saving) return;
    setSaving('image'); setError(''); setMessage('');
    try {
      const value = await mutateJSON<ExternalImageHostConfig>('/admin/integrations/external_image_host', 'PATCH', { enabled: imageDraft.enabled, endpoint: imageDraft.endpoint, workspaceId: imageDraft.workspaceId, stablePublicUrls: imageDraft.stablePublicUrls, syncDeletes: imageDraft.syncDeletes, token: imageDraft.clearToken ? { action: 'clear' } : imageDraft.token ? { action: 'replace', value: imageDraft.token } : { action: 'keep' } });
      setImage(value); setImageDraft(defaultImageDraft(value)); setMessage('图床配置已安全入库；页面不会回显 Token。');
    } catch (cause) { setError(cause instanceof Error ? cause.message : '图床配置保存失败。'); }
    finally { setSaving(''); }
  }

  async function saveNAS() {
    if (saving) return;
    setSaving('nas'); setError(''); setMessage('');
    try {
      const value = await mutateJSON<NASBackupConfig>('/admin/integrations/nas_backup', 'PATCH', nasDraft);
      setNAS(value); setNASDraft(defaultNASDraft(value)); setMessage('NAS pull 策略已入库，等待运维环境导出。');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'NAS 配置保存失败。'); }
    finally { setSaving(''); }
  }

  async function probe(event: React.MouseEvent<HTMLButtonElement>) {
    if (probeState.phase === 'testing') return;
    const result = await runEndpointProbe({ event, endpoint: imageDraft.endpoint, probe: endpoint => mutateJSON<{ status: string; message: string }>('/admin/integrations/external_image_host/test', 'POST', { endpoint, workspaceId: imageDraft.workspaceId, token: imageDraft.token }), onState: setProbeState });
    if (result) setMessage(result.message);
  }

  return <section className="settings-panel" aria-labelledby="integrations-settings-title">
    <div className="settings-inline-heading"><div><span className="eyebrow">REAL CAPABILITIES</span><h2 id="integrations-settings-title">集成</h2><p className="settings-help">这里只管理项目已经接入的图床和 NAS pull 策略。第三方凭证只写入并加密保存，永远不在页面回显。</p></div></div>
    {error && <div className="error-panel" role="alert">{error}</div>}
    {message && <div className="status settings-feedback" role="status"><Check aria-hidden="true" />{message}</div>}
    {loading ? <div className="settings-loading" role="status">集成配置载入中…</div> : <div className="settings-layout">
      <Card className="settings-card integration-card"><CardHeader className="settings-card-heading"><div><span className="eyebrow">CUSTOM PUBLIC</span><CardTitle>外部图床</CardTitle></div><CloudCog aria-hidden="true" /></CardHeader><CardContent className="settings-form">
        <p className="settings-help">本地规范原件始终保留。验证只调用只读接口，不上传或删除文件。</p>
        <label htmlFor="image-endpoint">上传 API<input id="image-endpoint" type="url" value={imageDraft.endpoint} onChange={event => setImageDraft(current => ({ ...current, endpoint: event.target.value }))} /></label>
        <label htmlFor="image-workspace">工作区 ID（可选）<input id="image-workspace" value={imageDraft.workspaceId} onChange={event => setImageDraft(current => ({ ...current, workspaceId: event.target.value }))} /></label>
        <label htmlFor="image-token">Token<input id="image-token" type="password" autoComplete="new-password" value={imageDraft.token} placeholder={image?.tokenConfigured ? '********（留空保持不变）' : '输入 OU API Token'} onChange={event => setImageDraft(current => ({ ...current, token: event.target.value, clearToken: false }))} /></label>
        <div className="integration-options">
          <label><input type="checkbox" checked={imageDraft.stablePublicUrls} onChange={event => setImageDraft(current => ({ ...current, stablePublicUrls: event.target.checked }))} /> 已确认使用稳定公开 URL</label>
          <label><input type="checkbox" checked={imageDraft.syncDeletes} onChange={event => setImageDraft(current => ({ ...current, syncDeletes: event.target.checked }))} /> 同步删除到图床回收站</label>
          <label><input type="checkbox" checked={imageDraft.enabled} onChange={event => setImageDraft(current => ({ ...current, enabled: event.target.checked }))} /> 启用异步外部发布</label>
          <label><input type="checkbox" checked={imageDraft.clearToken} onChange={event => setImageDraft(current => ({ ...current, clearToken: event.target.checked, token: '' }))} /> 清除已保存 Token</label>
        </div>
        <div className="integration-state" aria-live="polite"><strong>{probeState.phase === 'testing' ? '正在验证认证与只读合同' : image?.tokenConfigured ? 'Token 已加密保存' : 'Token 未配置'}</strong><span>{probeState.message || image?.statusMessage || '等待保存配置'}</span></div>
      </CardContent><CardFooter className="integration-actions"><button type="button" className="primary" disabled={saving !== '' || probeState.phase === 'testing'} onClick={() => void saveImage()}><Save aria-hidden="true" />{saving === 'image' ? '保存中…' : '保存图床配置'}</button><button type="button" className="secondary" disabled={!imageDraft.endpoint.trim() || saving !== '' || probeState.phase === 'testing'} onClick={probe}><TestTube2 aria-hidden="true" />{probeState.phase === 'testing' ? '验证中…' : '无副作用验证'}</button></CardFooter></Card>
      <Card className="settings-card integration-card"><CardHeader className="settings-card-heading"><div><span className="eyebrow">PULL BACKUP</span><CardTitle>NAS 备份</CardTitle></div><DatabaseBackup aria-hidden="true" /></CardHeader><CardContent className="settings-form">
        <p className="settings-help">NAS 通过只读 SSH/rsync 主动拉取。SSH 私钥和 `known_hosts` 由 NAS 系统账户管理，不会入库。</p>
        <label htmlFor="nas-source-host">源主机 / SSH alias<input id="nas-source-host" value={nasDraft.sourceHost} placeholder="backup-source" onChange={event => setNASDraft(current => ({ ...current, sourceHost: event.target.value }))} /></label>
        <div className="settings-fields"><label htmlFor="nas-source-path">VPS 暂存目录<input id="nas-source-path" value={nasDraft.sourcePath} onChange={event => setNASDraft(current => ({ ...current, sourcePath: event.target.value }))} /></label><label htmlFor="nas-destination-path">NAS 快照目录<input id="nas-destination-path" value={nasDraft.destinationPath} onChange={event => setNASDraft(current => ({ ...current, destinationPath: event.target.value }))} /></label><label htmlFor="nas-retention">保留天数<input id="nas-retention" type="number" min={1} max={3650} value={nasDraft.retentionDays} onChange={event => setNASDraft(current => ({ ...current, retentionDays: Number(event.target.value) }))} /></label><label className="integration-checkbox"><input type="checkbox" checked={nasDraft.enabled} onChange={event => setNASDraft(current => ({ ...current, enabled: event.target.checked }))} /> 启用 pull 策略</label></div>
        <div className="integration-state"><strong>{nas?.statusMessage || '尚未入库'}</strong><span>保存后由运维 CLI 生成 0600 环境文件后生效。</span></div>
      </CardContent><CardFooter><button type="button" className="primary" disabled={saving !== ''} onClick={() => void saveNAS()}><Save aria-hidden="true" />{saving === 'nas' ? '保存中…' : '保存 NAS 配置'}</button></CardFooter></Card>
    </div>}
  </section>;
}
