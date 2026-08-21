'use client';

import { FormEvent, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { QRCodeSVG } from 'qrcode.react';
import { API } from '@/lib/api';

type ProblemBody = { detail?: string; title?: string };

type RecoveryAttempt = {
  recoveryKey: string;
  newPassword: string;
  operationToken: string;
  newRecoveryKey: string;
  newTotpSecret: string;
};

function randomBytes(size: number) {
  const value = new Uint8Array(size);
  crypto.getRandomValues(value);
  return value;
}

function base64URL(value: Uint8Array) {
  let binary = '';
  value.forEach(byte => { binary += String.fromCharCode(byte); });
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function base32(value: Uint8Array) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let buffer = 0;
  let encoded = '';
  value.forEach(byte => {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      encoded += alphabet[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  });
  if (bits > 0) encoded += alphabet[(buffer << (5 - bits)) & 31];
  return encoded;
}

function newRecoveryAttempt(recoveryKey: string, newPassword: string): RecoveryAttempt {
  return {
    recoveryKey,
    newPassword,
    operationToken: base64URL(randomBytes(32)),
    newRecoveryKey: base64URL(randomBytes(32)),
    newTotpSecret: base32(randomBytes(20)),
  };
}

function recoveryTOTPSetupURI(secret: string) {
  const setup = new URL('otpauth://totp/');
  setup.pathname = '/个人时间线:owner';
  setup.searchParams.set('secret', secret);
  setup.searchParams.set('issuer', '个人时间线');
  return setup.toString();
}

async function sendRecoveryAttempt(attempt: RecoveryAttempt) {
  let lastResponse: Response | null = null;
  let lastError: unknown;
  for (let tryNumber = 0; tryNumber < 2; tryNumber += 1) {
    try {
      const response = await fetch(`${API}/auth/recovery/account`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(attempt),
      });
      lastResponse = response;
      if (response.status < 500 || tryNumber === 1) return response;
    } catch (error) {
      lastError = error;
      if (tryNumber === 1) throw error;
    }
  }
  if (lastResponse) return lastResponse;
  throw lastError instanceof Error ? lastError : new Error('account recovery request failed');
}

export default function RecoveryForm() {
  const router = useRouter();
  const [recoveryKey, setRecoveryKey] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ recoveryKey: string; totpSecret: string; totpSetupURI: string } | null>(null);
  const pendingAttempt = useRef<RecoveryAttempt | null>(null);

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
      const previous = pendingAttempt.current;
      const attempt = previous?.recoveryKey === recoveryKey && previous.newPassword === newPassword
        ? previous
        : newRecoveryAttempt(recoveryKey, newPassword);
      pendingAttempt.current = attempt;
      const response = await sendRecoveryAttempt(attempt);
      if (!response.ok) {
        if (response.status === 429) {
          const retryAfter = response.headers.get('Retry-After');
          setError(retryAfter ? `尝试次数过多，请在 ${retryAfter} 秒后重试。` : '尝试次数过多，请稍后重试。');
        } else if (response.status === 409) {
          pendingAttempt.current = null;
          setError('本次恢复操作已失效，请重新提交。');
        } else {
          const body = await response.json().catch(() => ({})) as ProblemBody;
          setError(response.status >= 500 ? '恢复服务暂时不可用，请稍后重试。' : body.detail || body.title || '恢复信息无效。');
        }
        return;
      }
      // The browser owns these plaintext credentials. Render them from the
      // exact accepted request even when a proxy loses or truncates the 200
      // response body after the database transaction has committed.
      setResult({
        recoveryKey: attempt.newRecoveryKey,
        totpSecret: attempt.newTotpSecret,
        totpSetupURI: recoveryTOTPSetupURI(attempt.newTotpSecret),
      });
    } catch {
      setError('无法连接恢复服务，请检查网络后重试。');
    } finally {
      setBusy(false);
    }
  }

  if (result) return <section className="login recovery-page" aria-labelledby="recovery-result-title">
    <Link href="/" className="brand">菜鸟手记</Link>
    <h1 id="recovery-result-title">恢复已完成</h1>
    <p className="note">这些凭据由本浏览器为本次恢复生成，服务端不会保存明文。请立即复制到离线密码管理器，并在重新登录后完成 TOTP 设置。</p>
    <div className="recovery-result" role="status">
      <label htmlFor="new-recovery-key">新恢复密钥（仅用于以后恢复账户，不是 TOTP 密钥）</label>
      <textarea id="new-recovery-key" readOnly value={result.recoveryKey} rows={3} />
      <p className="note">TOTP 二维码（推荐使用身份验证器扫描）</p>
      <QRCodeSVG
        value={result.totpSetupURI}
        size={220}
        level="M"
        marginSize={4}
        title="个人时间线 owner 账户的 TOTP 设置二维码"
        role="img"
        aria-label="个人时间线 owner 账户的 TOTP 设置二维码"
        aria-describedby="totp-qr-help"
        style={{ width: 'min(100%, 220px)', height: 'auto', justifySelf: 'center' }}
      />
      <p id="totp-qr-help" className="note">二维码只在当前浏览器中根据下方完整 URI 生成，不会发送给外部二维码服务。</p>
      <label htmlFor="totp-manual-secret">手动设置密钥（Base32，仅粘贴此值）</label>
      <textarea id="totp-manual-secret" readOnly spellCheck={false} value={result.totpSecret} rows={2} />
      <p className="note">在 Google Authenticator 中选择基于时间的密钥；不要粘贴上面的恢复密钥或下面的完整 URI。</p>
      <label htmlFor="totp-setup-uri">完整 TOTP URI（仅供支持 otpauth 导入或本地生成二维码使用）</label>
      <textarea id="totp-setup-uri" readOnly value={result.totpSetupURI} rows={4} />
      <p className="note">不得将完整 URI 粘贴进 Authenticator 的手动设置密钥框。</p>
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
