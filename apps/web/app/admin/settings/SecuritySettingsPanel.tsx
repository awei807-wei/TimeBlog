'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, Copy, KeyRound, LogOut, RefreshCw, ShieldCheck, Smartphone, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/app/components/ui/card';
import { getAuthSessions, getRuntimeStatus, type AuthSession, type RuntimeStatus } from '@/lib/api';
import { mutateJSON } from './settings-api';

function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let value = '';
  bytes.forEach(byte => { value += String.fromCharCode(byte); });
  return btoa(value).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function formatDate(value?: string | null) {
  return value ? new Date(value).toLocaleString('zh-CN') : '未知';
}

export default function SecuritySettingsPanel() {
  const router = useRouter();
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const [sessions, setSessions] = useState<AuthSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [sessionsError, setSessionsError] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [password, setPassword] = useState({ current: '', next: '', confirm: '', totp: '' });
  const [key, setKey] = useState('');
  const [operationToken, setOperationToken] = useState('');
  const [keySaved, setKeySaved] = useState(false);
  const [keyFactors, setKeyFactors] = useState({ password: '', code: '' });
  const [keyBusy, setKeyBusy] = useState(false);
  const [reloadingSessions, setReloadingSessions] = useState(false);
  const keyOutputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    void Promise.allSettled([getRuntimeStatus(), getAuthSessions()]).then(([runtimeResult, sessionResult]) => {
      if (cancelled) return;
      if (runtimeResult.status === 'fulfilled') setRuntime(runtimeResult.value);
      if (sessionResult.status === 'fulfilled') {
        setSessions(sessionResult.value.sessions);
        setSessionsError('');
      } else {
        setSessionsError('会话列表暂时不可用。');
      }
      if (runtimeResult.status === 'rejected') setError('安全状态暂时不可用，请稍后重试。');
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  async function reloadSessions() {
    setReloadingSessions(true); setSessionsError('');
    try { setSessions((await getAuthSessions()).sessions); }
    catch { setSessionsError('会话列表暂时不可用。'); }
    finally { setReloadingSessions(false); }
  }

  async function revokeSession(id: string) {
    setError(''); setMessage('');
    try { await mutateJSON(`/auth/sessions/${encodeURIComponent(id)}`, 'DELETE'); setSessions(current => current.filter(session => session.id !== id)); setMessage('设备会话已下线。'); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '会话下线失败。'); }
  }

  async function revokeOthers() {
    setError(''); setMessage('');
    try { await mutateJSON('/auth/sessions/revoke-others', 'POST', undefined, randomToken()); await reloadSessions(); setMessage('其他设备已退出。'); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '退出其他设备失败。'); }
  }

  async function changePassword() {
    if (passwordBusy || password.next.length < 12 || password.next !== password.confirm) return;
    setPasswordBusy(true); setError(''); setMessage('');
    try {
      await mutateJSON('/auth/password/change', 'POST', {
        currentPassword: password.current,
        newPassword: password.next,
        code: password.totp,
      });
      setPassword({ current: '', next: '', confirm: '', totp: '' });
      router.replace('/login?changed=1');
      router.refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : '密码修改失败。'); }
    finally { setPasswordBusy(false); }
  }

  function prepareKey() {
    setError(''); setMessage('');
    setKey(randomToken()); setOperationToken(randomToken()); setKeySaved(false);
    window.setTimeout(() => keyOutputRef.current?.focus(), 0);
  }

  async function copyKey() {
    try {
      if (!navigator.clipboard) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(key);
      setError(''); setMessage('恢复密钥已复制；仍请确认已保存到离线密码管理器。');
    } catch {
      setError('浏览器未允许自动复制，请手动选择并复制恢复密钥。');
    }
  }

  async function rotateKey() {
    if (keyBusy || !key || !keySaved) return;
    setKeyBusy(true); setError(''); setMessage('');
    try {
      await mutateJSON('/auth/recovery/key/rotate', 'POST', { password: keyFactors.password, code: keyFactors.code, operationToken, newRecoveryKey: key }, operationToken);
      await reloadSessions();
      setMessage('恢复密钥已轮换。请将下方密钥保存在离线密码管理器中。');
      setRuntime(current => current ? {
        ...current,
        security: {
          ...current.security,
          accountRecoveryKey: { configured: true, managedBy: current.security.accountRecoveryKey?.managedBy || 'account_recovery' },
        },
      } : current);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '恢复密钥轮换失败，旧密钥仍应保持有效。'); }
    finally { setKeyBusy(false); }
  }

  const currentRecovery = runtime?.security?.accountRecoveryKey;
  const passwordReady = password.current.length > 0 && password.next.length >= 12 && password.next === password.confirm && /^\d{6}$/.test(password.totp.trim());
  const keyReady = keySaved && keyFactors.password.trim().length > 0 && /^\d{6}$/.test(keyFactors.code.trim());
  return <section className="settings-panel" aria-labelledby="security-settings-title">
    <div className="settings-inline-heading"><div><span className="eyebrow">ACCOUNT SAFETY</span><h2 id="security-settings-title">安全</h2><p className="settings-help">敏感操作不会回显密码、TOTP 或恢复密钥。改密和恢复密钥轮换完成后，按服务端策略吊销旧会话。</p></div></div>
    {error && <div className="error-panel" role="alert">{error}</div>}
    {message && <div className="status settings-feedback" role="status"><Check aria-hidden="true" />{message}</div>}
    {loading ? <div className="settings-loading" role="status">安全状态载入中…</div> : <div className="settings-layout">
      <Card className="settings-card"><CardHeader className="settings-card-heading"><div><span className="eyebrow">PASSWORD</span><CardTitle>修改密码</CardTitle></div><ShieldCheck aria-hidden="true" /></CardHeader><CardContent className="settings-form"><p className="settings-help">需要当前密码和现有 TOTP 验证。新密码至少 12 个字符。</p><label htmlFor="current-password">当前密码<input id="current-password" type="password" autoComplete="current-password" value={password.current} onChange={event => setPassword(current => ({ ...current, current: event.target.value }))} /></label><label htmlFor="new-password">新密码<input id="new-password" type="password" autoComplete="new-password" minLength={12} value={password.next} onChange={event => setPassword(current => ({ ...current, next: event.target.value }))} /></label><label htmlFor="confirm-password">确认新密码<input id="confirm-password" type="password" autoComplete="new-password" minLength={12} value={password.confirm} onChange={event => setPassword(current => ({ ...current, confirm: event.target.value }))} /></label><label htmlFor="password-totp">TOTP 验证码<input id="password-totp" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={password.totp} onChange={event => setPassword(current => ({ ...current, totp: event.target.value.replace(/\D/g, '').slice(0, 6) }))} /></label>{password.next && password.next !== password.confirm && <p className="form-hint error" role="alert">两次输入的新密码不一致。</p>}</CardContent><CardFooter><button type="button" className="primary" disabled={!passwordReady || passwordBusy} onClick={() => void changePassword()}>{passwordBusy ? '保存中…' : '更新密码'}</button></CardFooter></Card>
      <Card className="settings-card"><CardHeader className="settings-card-heading"><div><span className="eyebrow">BREAK-GLASS KEY</span><CardTitle>恢复密钥</CardTitle></div><KeyRound aria-hidden="true" /></CardHeader><CardContent className="settings-form"><p className="settings-help">恢复密钥只在生成后显示一次，服务端只保存哈希。丢失密码但仍有 TOTP 时，也可从公开恢复页完成密码恢复，再回到这里轮换密钥。</p><div className="settings-key-status"><span>当前状态</span><strong>{currentRecovery?.configured ? '已配置' : '未配置'}</strong></div>{!key ? <button type="button" className="secondary settings-key-action" onClick={prepareKey}><KeyRound aria-hidden="true" />生成新的恢复密钥</button> : <><label htmlFor="new-recovery-key">新的恢复密钥（仅显示一次）<textarea id="new-recovery-key" ref={keyOutputRef} readOnly value={key} rows={3} /></label><div className="settings-key-actions"><button type="button" className="secondary" onClick={() => void copyKey()}><Copy aria-hidden="true" />复制</button><label className="settings-confirm"><input type="checkbox" checked={keySaved} onChange={event => setKeySaved(event.target.checked)} /> 我已保存到离线密码管理器</label></div><label htmlFor="rotation-password">当前密码<input id="rotation-password" type="password" autoComplete="current-password" value={keyFactors.password} onChange={event => setKeyFactors(current => ({ ...current, password: event.target.value }))} /></label><label htmlFor="rotation-code">当前 TOTP 验证码<input id="rotation-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={keyFactors.code} onChange={event => setKeyFactors(current => ({ ...current, code: event.target.value.replace(/\D/g, '').slice(0, 6) }))} /></label><button type="button" className="primary" disabled={!keyReady || keyBusy} onClick={() => void rotateKey()}>{keyBusy ? '轮换中…' : '确认轮换恢复密钥'}</button></>}</CardContent></Card>
      <Card className="settings-card settings-card-wide"><CardHeader className="settings-card-heading"><div><span className="eyebrow">ACTIVE DEVICES</span><CardTitle>当前会话</CardTitle></div><Smartphone aria-hidden="true" /></CardHeader><CardContent>{sessionsError && <div className="error-panel" role="alert">{sessionsError}</div>}<div className="session-toolbar"><p className="settings-help">可单独下线其他设备；退出当前设备会立即结束本次登录，也可以退出除当前设备外的全部会话。</p><button type="button" className="secondary" disabled={reloadingSessions} onClick={() => void reloadSessions()}><RefreshCw aria-hidden="true" />{reloadingSessions ? '刷新中…' : '刷新'}</button><button type="button" className="secondary danger-outline" disabled={!sessions.some(session => !session.current)} onClick={() => void revokeOthers()}><LogOut aria-hidden="true" />退出其他设备</button></div>{sessions.length ? <div className="session-list">{sessions.map(session => <div className="session-row" key={session.id}><div><strong>{session.current ? '当前设备' : '其他设备'}</strong><span>创建于 {formatDate(session.createdAt)} · 最近活动 {formatDate(session.lastSeen)}</span></div><button type="button" className="icon-text-button danger-outline" aria-label={session.current ? '退出当前设备' : '下线其他设备'} onClick={() => void revokeSession(session.id)}><Trash2 aria-hidden="true" />{session.current ? '退出当前设备' : '下线设备'}</button></div>)}</div> : <div className="settings-empty">暂无可显示的活动会话。</div>}</CardContent></Card>
    </div>}
  </section>;
}
