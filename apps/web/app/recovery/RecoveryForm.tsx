'use client';

import { FormEvent, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { API } from '@/lib/api';

type ProblemBody = { detail?: string; title?: string };

export default function RecoveryForm() {
  const router = useRouter();
  const [recoveryKey, setRecoveryKey] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ recoveryKey: string; totpSetupURI: string } | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setError('');
    setResult(null);
    if (newPassword.length < 12) {
      setError('新密码至少需要 12 个字符。');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('两次输入的新密码不一致。');
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(`${API}/auth/recovery/account`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recoveryKey, newPassword }),
      });
      if (!response.ok) {
        if (response.status === 429) {
          const retryAfter = response.headers.get('Retry-After');
          setError(retryAfter ? `尝试次数过多，请在 ${retryAfter} 秒后重试。` : '尝试次数过多，请稍后重试。');
        } else {
          const body = await response.json().catch(() => ({})) as ProblemBody;
          setError(response.status >= 500 ? '恢复服务暂时不可用，请稍后重试。' : body.detail || body.title || '恢复信息无效。');
        }
        return;
      }
      const body = await response.json().catch(() => ({})) as { recoveryKey?: string; totpSetupURI?: string };
      if (body.recoveryKey || body.totpSetupURI) {
        setResult({ recoveryKey: body.recoveryKey || '', totpSetupURI: body.totpSetupURI || '' });
      } else {
        router.replace('/login?recovered=1');
      }
    } catch {
      setError('无法连接恢复服务，请检查网络后重试。');
    } finally {
      setBusy(false);
    }
  }

  if (result) return <section className="login recovery-page" aria-labelledby="recovery-result-title">
    <Link href="/" className="brand">菜鸟手记</Link>
    <h1 id="recovery-result-title">恢复已完成</h1>
    <p className="note">以下凭据只显示一次，不会保存到浏览器。请立即复制到离线密码管理器，并在重新登录后完成 TOTP 设置。</p>
    <div className="recovery-result" role="status">
      <label htmlFor="new-recovery-key">新恢复密钥</label>
      <textarea id="new-recovery-key" readOnly value={result.recoveryKey} rows={3} />
      <label htmlFor="totp-setup-uri">TOTP setup URI</label>
      <textarea id="totp-setup-uri" readOnly value={result.totpSetupURI} rows={4} />
    </div>
    <button className="primary" type="button" onClick={() => router.replace('/login?recovered=1')}>我已保存，前往登录</button>
  </section>;

  return <section className="login recovery-page" aria-labelledby="recovery-title">
    <Link href="/" className="brand">菜鸟手记</Link>
    <h1 id="recovery-title">恢复作者账户</h1>
    <p className="note">使用部署时保存的恢复密钥设置新密码。恢复成功后，当前会话会全部失效，请重新登录并完成 TOTP 验证。</p>
    <form onSubmit={submit} noValidate>
      <div className="field"><label htmlFor="recovery-key">恢复密钥</label><input id="recovery-key" name="recoveryKey" type="password" autoComplete="off" required value={recoveryKey} onChange={event => setRecoveryKey(event.target.value)} /></div>
      <div className="field"><label htmlFor="new-password">新密码（至少 12 个字符）</label><input id="new-password" name="newPassword" type="password" autoComplete="new-password" minLength={12} required value={newPassword} onChange={event => setNewPassword(event.target.value)} /></div>
      <div className="field"><label htmlFor="confirm-password">确认新密码</label><input id="confirm-password" name="confirmPassword" type="password" autoComplete="new-password" minLength={12} required value={confirmPassword} onChange={event => setConfirmPassword(event.target.value)} /></div>
      {error && <div className="error" role="alert" aria-live="assertive">{error}</div>}
      <button className="primary" type="submit" disabled={busy || !recoveryKey || !newPassword || !confirmPassword}>{busy ? '恢复中…' : '设置新密码'}</button>
    </form>
    <p className="recovery-back"><Link href="/login">返回登录</Link></p>
  </section>;
}
