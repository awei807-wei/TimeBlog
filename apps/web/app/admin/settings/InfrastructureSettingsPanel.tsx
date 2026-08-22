'use client';

import { useEffect, useState } from 'react';
import { CheckCircle2, Database, HardDrive, RefreshCw, ServerCog, XCircle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/app/components/ui/card';
import { getRuntimeStatus, type RuntimeStatus } from '@/lib/api';

function StatusMark({ ready }: { ready: boolean }) {
  return ready ? <span className="settings-status is-ready"><CheckCircle2 aria-hidden="true" />正常</span> : <span className="settings-status"><XCircle aria-hidden="true" />需关注</span>;
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return '未限制';
  return `${Math.round(value / 1024 / 1024)} MB`;
}

export default function InfrastructureSettingsPanel() {
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  async function load(showSpinner = true) {
    if (showSpinner) setLoading(true); else setRefreshing(true);
    setError('');
    try { setRuntime(await getRuntimeStatus()); }
    catch { setError('运行状态暂时不可用，请确认登录状态或后台 API。'); }
    finally { setLoading(false); setRefreshing(false); }
  }

  useEffect(() => {
    let cancelled = false;
    void getRuntimeStatus().then(value => {
      if (!cancelled) setRuntime(value);
    }).catch(() => {
      if (!cancelled) setError('运行状态暂时不可用，请确认登录状态或后台 API。');
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  return <section className="settings-panel" aria-labelledby="infrastructure-settings-title">
    <div className="settings-inline-heading"><div><span className="eyebrow">READ ONLY</span><h2 id="infrastructure-settings-title">运行状态</h2><p className="settings-help">这里只读展示当前应用的运行能力；数据库密码、加密密钥和其他基础设施凭证不会从后台读取或回显。</p></div><button type="button" className="secondary" onClick={() => void load(false)} disabled={loading || refreshing}><RefreshCw aria-hidden="true" className={refreshing ? 'settings-spin' : undefined} />{refreshing ? '刷新中…' : '刷新状态'}</button></div>
    {error && <div className="error-panel" role="alert">{error}</div>}
    {loading ? <div className="settings-loading" role="status">运行状态载入中…</div> : runtime ? <div className="settings-layout settings-layout-status">
      <Card className="settings-card"><CardHeader className="settings-card-heading"><div><span className="eyebrow">MEDIA VOLUME</span><CardTitle>媒体存储</CardTitle></div><HardDrive aria-hidden="true" /></CardHeader><CardContent><div className="settings-status-list"><div><span>规范原件</span><strong>本地存储 <code>local_private</code></strong><StatusMark ready={runtime.media.writable} /></div><div><span>图片上传</span><strong>{runtime.media.imageUploadEnabled ? '已启用' : '已禁用'}</strong><StatusMark ready={runtime.media.imageUploadEnabled} /></div><div><span>附件上传</span><strong>{runtime.media.nonImageUploadEnabled ? '已启用' : '已禁用'}</strong><StatusMark ready={runtime.media.nonImageUploadEnabled} /></div><div><span>单文件上限</span><strong>{formatBytes(runtime.media.maxUploadBytes)}</strong></div></div></CardContent></Card>
      <Card className="settings-card"><CardHeader className="settings-card-heading"><div><span className="eyebrow">SERVICE LINKS</span><CardTitle>外部能力</CardTitle></div><ServerCog aria-hidden="true" /></CardHeader><CardContent><div className="settings-status-list"><div><span>外部图床</span><strong>{runtime.externalImageHost.publishEnabled ? '异步发布已启用' : '未启用'}</strong><StatusMark ready={!runtime.externalImageHost.enabled || Boolean(runtime.externalImageHost.publishEnabled)} /></div><div><span>协议</span><strong><code>{runtime.externalImageHost.protocolStatus}</code></strong></div><div><span>NAS pull</span><strong>{runtime.nasBackup.enabled ? runtime.nasBackup.applyStatus : '未启用'}</strong><StatusMark ready={!runtime.nasBackup.enabled || runtime.nasBackup.status !== 'error'} /></div></div></CardContent></Card>
      <Card className="settings-card"><CardHeader className="settings-card-heading"><div><span className="eyebrow">SECURITY BOUNDARY</span><CardTitle>安全配置状态</CardTitle></div><Database aria-hidden="true" /></CardHeader><CardContent><div className="security-list">{Object.entries(runtime.security).map(([key, item]) => <div className="security-row" key={key}><div><strong>{({ adminPassword: '管理员密码', adminTotpSecret: '管理员 TOTP', totpEncryptionKey: 'TOTP 加密密钥', databaseConnection: '数据库连接', accountRecoveryKey: '账户恢复密钥' } as Record<string, string>)[key] || key}</strong><span>{item.managedBy === 'account_recovery' ? '由账户恢复/安全设置管理' : '由运行环境管理'}</span></div><StatusMark ready={item.configured} /></div>)}</div></CardContent></Card>
    </div> : null}
    {runtime?.updatedAt && <p className="settings-updated">最近更新：{new Date(runtime.updatedAt).toLocaleString('zh-CN')}</p>}
  </section>;
}
