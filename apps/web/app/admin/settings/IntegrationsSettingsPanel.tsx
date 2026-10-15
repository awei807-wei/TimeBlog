'use client';

import { useEffect, useState } from 'react';
import { Check, CloudCog, DatabaseBackup, Mail, Save, ShieldCheck, TestTube2, XCircle } from 'lucide-react';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/app/components/ui/card';
import { getExternalImageHostConfig, getNASBackupConfig, getSMTPRelayConfig, type ExternalImageHostConfig, type NASBackupConfig, type SMTPRelayConfig } from '@/lib/api';
import { runEndpointProbe, type IntegrationProbeState } from '@/lib/integration-probe';
import { mutateJSON } from './settings-api';

type ImageDraft = { enabled: boolean; endpoint: string; workspaceId: string; stablePublicUrls: boolean; syncDeletes: boolean; token: string; clearToken: boolean };
type NASDraft = { enabled: boolean; sourceHost: string; sourcePath: string; destinationPath: string; retentionDays: number };
type SMTPDraft = { enabled: boolean; host: string; port: number; username: string; password: string; clearPassword: boolean; fromEmail: string; toEmail: string; advanceDays: string };

function Configured({ ready }: { ready: boolean }) {
  return ready ? <span className="settings-status is-ready"><Check aria-hidden="true" />已配置</span> : <span className="settings-status"><XCircle aria-hidden="true" />未配置</span>;
}

function defaultImageDraft(value: ExternalImageHostConfig | null): ImageDraft {
  return { enabled: value?.enabled || false, endpoint: value?.endpoint || 'https://image.cainiao.me/api/uploads', workspaceId: value?.workspaceId || '', stablePublicUrls: value?.stablePublicUrls || false, syncDeletes: value?.syncDeletes || false, token: '', clearToken: false };
}

function defaultNASDraft(value: NASBackupConfig | null): NASDraft {
  return { enabled: value?.enabled || false, sourceHost: value?.sourceHost || '', sourcePath: value?.sourcePath || '/srv/timeblog/backup-staging', destinationPath: value?.destinationPath || '/srv/timeblog/nas-snapshots', retentionDays: value?.retentionDays || 90 };
}

function defaultSMTPDraft(value: SMTPRelayConfig | null): SMTPDraft {
  return {
    enabled: value?.enabled || false,
    host: value?.host || 'smtp.qq.com',
    port: value?.port || 465,
    username: value?.username || '',
    password: '',
    clearPassword: false,
    fromEmail: value?.fromEmail || '',
    toEmail: value?.toEmail || '',
    advanceDays: value?.advanceDays ? value.advanceDays.join(', ') : '30, 15, 7, 3, 1',
  };
}

export default function IntegrationsSettingsPanel() {
  const [image, setImage] = useState<ExternalImageHostConfig | null>(null);
  const [nas, setNAS] = useState<NASBackupConfig | null>(null);
  const [smtp, setSmtp] = useState<SMTPRelayConfig | null>(null);
  const [imageDraft, setImageDraft] = useState<ImageDraft>(defaultImageDraft(null));
  const [nasDraft, setNASDraft] = useState<NASDraft>(defaultNASDraft(null));
  const [smtpDraft, setSmtpDraft] = useState<SMTPDraft>(defaultSMTPDraft(null));
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<'image' | 'nas' | 'smtp' | ''>('');
  const [smtpTesting, setSmtpTesting] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [probeState, setProbeState] = useState<IntegrationProbeState>({ phase: 'idle', message: '' });

  useEffect(() => {
    let cancelled = false;
    void Promise.all([getExternalImageHostConfig(), getNASBackupConfig(), getSMTPRelayConfig()]).then(([imageValue, nasValue, smtpValue]) => {
      if (cancelled) return;
      setImage(imageValue);
      setNAS(nasValue);
      setSmtp(smtpValue);
      setImageDraft(defaultImageDraft(imageValue));
      setNASDraft(defaultNASDraft(nasValue));
      setSmtpDraft(defaultSMTPDraft(smtpValue));
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

  async function saveSMTP() {
    if (saving) return;
    setSaving('smtp'); setError(''); setMessage('');
    try {
      const days = smtpDraft.advanceDays
        .split(',')
        .map(s => Number(s.trim()))
        .filter(n => Number.isInteger(n) && n > 0 && n <= 365);
      const value = await mutateJSON<SMTPRelayConfig>('/admin/integrations/smtp_relay', 'PATCH', {
        enabled: smtpDraft.enabled,
        host: smtpDraft.host.trim(),
        port: Number(smtpDraft.port) || 465,
        username: smtpDraft.username.trim(),
        fromEmail: smtpDraft.fromEmail.trim(),
        toEmail: smtpDraft.toEmail.trim(),
        advanceDays: days.length > 0 ? days : [30, 15, 7, 3, 1],
        password: smtpDraft.clearPassword
          ? { action: 'clear' }
          : smtpDraft.password
            ? { action: 'replace', value: smtpDraft.password }
            : { action: 'keep' },
      });
      setSmtp(value); setSmtpDraft(defaultSMTPDraft(value)); setMessage('SMTP 邮件提醒配置已入库；密码已加密保存。');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'SMTP 配置保存失败。'); }
    finally { setSaving(''); }
  }

  async function probe(event: React.MouseEvent<HTMLButtonElement>) {
    if (probeState.phase === 'testing') return;
    const result = await runEndpointProbe({ event, endpoint: imageDraft.endpoint, probe: endpoint => mutateJSON<{ status: string; message: string }>('/admin/integrations/external_image_host/test', 'POST', { endpoint, workspaceId: imageDraft.workspaceId, token: imageDraft.token }), onState: setProbeState });
    if (result) setMessage(result.message);
  }

  async function probeSMTP() {
    if (smtpTesting) return;
    setSmtpTesting(true); setError(''); setMessage('');
    try {
      const result = await mutateJSON<{ status: string; message: string }>('/admin/integrations/smtp_relay/test', 'POST', {
        host: smtpDraft.host.trim(),
        port: Number(smtpDraft.port) || 465,
        username: smtpDraft.username.trim(),
        fromEmail: smtpDraft.fromEmail.trim(),
        toEmail: smtpDraft.toEmail.trim(),
        password: smtpDraft.password || undefined,
      });
      if (result.status === 'verified') {
        setMessage(result.message || '测试邮件已成功发送！');
      } else {
        setError(result.message || '测试邮件发送失败');
      }
      const updated = await getSMTPRelayConfig().catch(() => null);
      if (updated) setSmtp(updated);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '发送测试邮件失败。');
    } finally {
      setSmtpTesting(false);
    }
  }

  return <section className="settings-panel" aria-labelledby="integrations-settings-title">
    <div className="settings-inline-heading"><div><span className="eyebrow">REAL CAPABILITIES</span><h2 id="integrations-settings-title">集成</h2><p className="settings-help">这里管理外部图床、NAS 备份与数字资产到期邮件提醒。第三方凭证只写入并加密保存，永远不在页面回显。</p></div></div>
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
      
      <Card className="settings-card integration-card"><CardHeader className="settings-card-heading"><div><span className="eyebrow">NOTIFICATION</span><CardTitle>邮件提醒 (SMTP 中继)</CardTitle></div><Mail aria-hidden="true" /></CardHeader><CardContent className="settings-form">
        <p className="settings-help">在数字资产即将到期前通过指定 SMTP 发送邮件提醒（推荐 QQ 邮箱、163、企业邮）。密码将加密存储。</p>
        <div className="settings-fields"><label htmlFor="smtp-host">SMTP 服务器<input id="smtp-host" value={smtpDraft.host} placeholder="smtp.qq.com" onChange={event => setSmtpDraft(current => ({ ...current, host: event.target.value }))} /></label><label htmlFor="smtp-port">端口 (465/587)<input id="smtp-port" type="number" min={1} max={65535} value={smtpDraft.port} onChange={event => setSmtpDraft(current => ({ ...current, port: Number(event.target.value) }))} /></label></div>
        <div className="settings-fields"><label htmlFor="smtp-username">SMTP 账号<input id="smtp-username" value={smtpDraft.username} placeholder="xxx@qq.com" onChange={event => setSmtpDraft(current => ({ ...current, username: event.target.value }))} /></label><label htmlFor="smtp-password">授权码 / 密码<input id="smtp-password" type="password" autoComplete="new-password" value={smtpDraft.password} placeholder={smtp?.passwordConfigured ? '********（留空保持不变）' : '输入 SMTP 授权码'} onChange={event => setSmtpDraft(current => ({ ...current, password: event.target.value, clearPassword: false }))} /></label></div>
        <div className="settings-fields"><label htmlFor="smtp-from">发件人地址<input id="smtp-from" type="email" value={smtpDraft.fromEmail} placeholder="xxx@qq.com" onChange={event => setSmtpDraft(current => ({ ...current, fromEmail: event.target.value }))} /></label><label htmlFor="smtp-to">收件人地址<input id="smtp-to" type="email" value={smtpDraft.toEmail} placeholder="xxx@qq.com" onChange={event => setSmtpDraft(current => ({ ...current, toEmail: event.target.value }))} /></label></div>
        <label htmlFor="smtp-advance-days">提前预警天数（逗号隔开）<input id="smtp-advance-days" value={smtpDraft.advanceDays} placeholder="30, 15, 7, 3, 1" onChange={event => setSmtpDraft(current => ({ ...current, advanceDays: event.target.value }))} /></label>
        <div className="integration-options">
          <label><input type="checkbox" checked={smtpDraft.enabled} onChange={event => setSmtpDraft(current => ({ ...current, enabled: event.target.checked }))} /> 启用数字资产到期邮件提醒</label>
          <label><input type="checkbox" checked={smtpDraft.clearPassword} onChange={event => setSmtpDraft(current => ({ ...current, clearPassword: event.target.checked, password: '' }))} /> 清除已保存授权码</label>
        </div>
        <div className="integration-state" aria-live="polite"><strong>{smtp?.passwordConfigured ? '密码已加密保存' : '密码未配置'}</strong><span>{smtp?.statusMessage || '等待保存配置'}</span></div>
      </CardContent><CardFooter className="integration-actions"><button type="button" className="primary" disabled={saving !== '' || smtpTesting} onClick={() => void saveSMTP()}><Save aria-hidden="true" />{saving === 'smtp' ? '保存中…' : '保存邮件配置'}</button><button type="button" className="secondary" disabled={!smtpDraft.host.trim() || !smtpDraft.toEmail.trim() || saving !== '' || smtpTesting} onClick={() => void probeSMTP()}><TestTube2 aria-hidden="true" />{smtpTesting ? '发送中…' : '发送测试邮件'}</button></CardFooter></Card>

      <Card className="settings-card integration-card"><CardHeader className="settings-card-heading"><div><span className="eyebrow">PULL BACKUP</span><CardTitle>NAS 备份</CardTitle></div><DatabaseBackup aria-hidden="true" /></CardHeader><CardContent className="settings-form">
        <p className="settings-help">NAS 通过只读 SSH/rsync 主动拉取。SSH 私钥和 `known_hosts` 由 NAS 系统账户管理，不会入库。</p>
        <label htmlFor="nas-source-host">源主机 / SSH alias<input id="nas-source-host" value={nasDraft.sourceHost} placeholder="backup-source" onChange={event => setNASDraft(current => ({ ...current, sourceHost: event.target.value }))} /></label>
        <div className="settings-fields"><label htmlFor="nas-source-path">VPS 暂存目录<input id="nas-source-path" value={nasDraft.sourcePath} onChange={event => setNASDraft(current => ({ ...current, sourcePath: event.target.value }))} /></label><label htmlFor="nas-destination-path">NAS 快照目录<input id="nas-destination-path" value={nasDraft.destinationPath} onChange={event => setNASDraft(current => ({ ...current, destinationPath: event.target.value }))} /></label><label htmlFor="nas-retention">保留天数<input id="nas-retention" type="number" min={1} max={3650} value={nasDraft.retentionDays} onChange={event => setNASDraft(current => ({ ...current, retentionDays: Number(event.target.value) }))} /></label><label className="integration-checkbox"><input type="checkbox" checked={nasDraft.enabled} onChange={event => setNASDraft(current => ({ ...current, enabled: event.target.checked }))} /> 启用 pull 策略</label></div>
        <div className="integration-state"><strong>{nas?.statusMessage || '尚未入库'}</strong><span>保存后由运维 CLI 生成 0600 环境文件后生效。</span></div>
      </CardContent><CardFooter><button type="button" className="primary" disabled={saving !== ''} onClick={() => void saveNAS()}><Save aria-hidden="true" />{saving === 'nas' ? '保存中…' : '保存 NAS 配置'}</button></CardFooter></Card>
    </div>}
  </section>;
}
