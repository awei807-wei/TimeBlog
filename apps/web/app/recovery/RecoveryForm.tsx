'use client';

import { FormEvent, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { QRCodeSVG } from 'qrcode.react';
import { API, formatRetryAfterMessage } from '@/lib/api';

type ProblemBody = { detail?: string; title?: string };

type RecoveryAttempt = {
  recoveryKey: string;
  newPassword: string;
  operationToken: string;
  newRecoveryKey: string;
  newTotpSecret: string;
};

type TOTPRecoveryAttempt = {
  challenge: string;
  code: string;
  newPassword: string;
  operationToken: string;
};

const TOTP_RECOVERY_START = `${API}/auth/recovery/totp/start`;
const TOTP_RECOVERY_COMPLETE = `${API}/auth/recovery/totp/complete`;

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

async function startTOTPRecovery() {
  const response = await fetch(TOTP_RECOVERY_START, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: '{}',
  });
  return response;
}

async function sendTOTPRecoveryAttempt(attempt: TOTPRecoveryAttempt) {
  let lastResponse: Response | null = null;
  let lastError: unknown;
  for (let tryNumber = 0; tryNumber < 2; tryNumber += 1) {
    try {
      const response = await fetch(TOTP_RECOVERY_COMPLETE, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
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
  throw lastError instanceof Error ? lastError : new Error('TOTP password recovery request failed');
}

export default function RecoveryForm() {
  const router = useRouter();
  const [mode, setMode] = useState<'key' | 'totp'>('key');
  const [recoveryKey, setRecoveryKey] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [totpChallenge, setTotpChallenge] = useState('');
  const [totpExpiresAt, setTOTExpiresAt] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ recoveryKey: string; totpSecret: string; totpSetupURI: string } | null>(null);
  const [totpDone, setTOTPDone] = useState(false);
  const pendingAttempt = useRef<RecoveryAttempt | null>(null);
  const pendingTOTPAttempt = useRef<TOTPRecoveryAttempt | null>(null);

  function chooseMode(next: 'key' | 'totp') {
    if (busy) return;
    setMode(next);
    setError('');
    setRecoveryKey('');
    setNewPassword('');
    setConfirmPassword('');
    setTotpCode('');
    setTotpChallenge('');
    setTOTExpiresAt('');
    pendingAttempt.current = null;
    pendingTOTPAttempt.current = null;
  }

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

  async function beginTOTPRecovery() {
    if (busy) return;
    setError(''); setBusy(true);
    try {
      const response = await startTOTPRecovery();
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as ProblemBody;
        setError(response.status === 429 ? formatRetryAfterMessage(response.headers.get('Retry-After')) : body.detail || body.title || '恢复请求无效。');
        return;
      }
      const body = await response.json().catch(() => ({})) as { challenge?: string; expiresAt?: string };
      if (!body.challenge) { setError('恢复挑战无效，请重新开始。'); return; }
      setTotpChallenge(body.challenge);
      setTOTExpiresAt(body.expiresAt || '');
      setTotpCode('');
    } catch { setError('无法连接恢复服务，请检查网络后重试。'); }
    finally { setBusy(false); }
  }

  async function completeTOTPRecovery(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !totpChallenge) return;
    setError('');
    if (newPassword.length < 12) { setError('新密码至少需要 12 个字符。'); return; }
    if (newPassword !== confirmPassword) { setError('两次输入的新密码不一致。'); return; }
    if (!/^\d{6}$/.test(totpCode.trim())) { setError('请输入当前 6 位 TOTP 验证码。'); return; }
    setBusy(true);
    try {
      const previous = pendingTOTPAttempt.current;
      const attempt = previous?.challenge === totpChallenge && previous.newPassword === newPassword && previous.code === totpCode.trim()
        ? previous
        : { challenge: totpChallenge, code: totpCode.trim(), newPassword, operationToken: base64URL(randomBytes(32)) };
      pendingTOTPAttempt.current = attempt;
      const response = await sendTOTPRecoveryAttempt(attempt);
      if (!response.ok) {
        if (response.status === 429) setError(formatRetryAfterMessage(response.headers.get('Retry-After')));
        else if (response.status === 409) { pendingTOTPAttempt.current = null; setError('本次恢复操作已失效，请重新获取挑战。'); }
        else { const body = await response.json().catch(() => ({})) as ProblemBody; setError(response.status >= 500 ? '恢复服务暂时不可用，请稍后重试。' : body.detail || body.title || '恢复信息无效。'); }
        return;
      }
      setTOTPDone(true);
    } catch { setError('无法连接恢复服务，请检查网络后重试。'); }
    finally { setBusy(false); }
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

  if (totpDone) return <section className="login recovery-page" aria-labelledby="totp-recovery-result-title">
    <Link href="/" className="brand">菜鸟手记</Link>
    <div className="recovery-success-mark" aria-hidden="true">✓</div>
    <h1 id="totp-recovery-result-title">密码已更新</h1>
    <p className="note">当前 TOTP 认证器保持不变，所有旧会话已失效。请使用新密码和原 TOTP 登录；登录后前往安全设置轮换恢复密钥。</p>
    <button className="primary" type="button" onClick={() => router.replace('/login?recovered=1')}>前往登录</button>
  </section>;

  return <section className="login recovery-page" aria-labelledby="recovery-title">
    <Link href="/" className="brand">菜鸟手记</Link>
    <h1 id="recovery-title">恢复作者账户</h1>
    <p className="note">你不需要在用户侧记住数据库或部署配置。仍有恢复密钥时可完整恢复；仍有 TOTP 时可只重置密码。</p>
    <div className="recovery-mode-switch" role="tablist" aria-label="选择恢复方式">
      <button type="button" role="tab" aria-selected={mode === 'key'} className={mode === 'key' ? 'recovery-mode is-active' : 'recovery-mode'} onClick={() => chooseMode('key')}>我有恢复密钥<span>重置密码和 TOTP</span></button>
      <button type="button" role="tab" aria-selected={mode === 'totp'} className={mode === 'totp' ? 'recovery-mode is-active' : 'recovery-mode'} onClick={() => chooseMode('totp')}>我仍有 TOTP<span>只重置密码</span></button>
    </div>
    {mode === 'key' ? <form onSubmit={submit} noValidate>
      <div className="field"><label htmlFor="recovery-key">恢复密钥</label><input id="recovery-key" name="recoveryKey" type="password" autoComplete="off" required value={recoveryKey} onChange={event => setRecoveryKey(event.target.value)} /></div>
      <div className="field"><label htmlFor="new-password">新密码（至少 12 个字符）</label><input id="new-password" name="newPassword" type="password" autoComplete="new-password" minLength={12} required value={newPassword} onChange={event => setNewPassword(event.target.value)} /></div>
      <div className="field"><label htmlFor="confirm-password">确认新密码</label><input id="confirm-password" name="confirmPassword" type="password" autoComplete="new-password" minLength={12} required value={confirmPassword} onChange={event => setConfirmPassword(event.target.value)} /></div>
      {error && <div className="error" role="alert" aria-live="assertive">{error}</div>}
      <button className="primary" type="submit" disabled={busy || !recoveryKey || !newPassword || !confirmPassword}>{busy ? '恢复中…' : '设置新密码'}</button>
    </form> : <div className="recovery-totp-flow">
      {!totpChallenge ? <><p className="settings-help">服务端会发出一个短期一次性挑战。接下来输入身份验证器中当前 6 位验证码和新密码；TOTP 认证器不会被替换。</p><button className="primary" type="button" disabled={busy} onClick={() => void beginTOTPRecovery()}>{busy ? '准备中…' : '开始 TOTP 恢复'}</button></> : <form onSubmit={completeTOTPRecovery} noValidate>
        <div className="recovery-challenge-status" role="status">恢复挑战已准备{totpExpiresAt ? `，有效期至 ${new Date(totpExpiresAt).toLocaleTimeString('zh-CN')}` : '，有效期 5 分钟'}。</div>
        <div className="field"><label htmlFor="recovery-totp-code">当前 TOTP 验证码</label><input id="recovery-totp-code" name="totpCode" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required autoFocus value={totpCode} onChange={event => setTotpCode(event.target.value.replace(/\D/g, '').slice(0, 6))} /></div>
        <div className="field"><label htmlFor="totp-new-password">新密码（至少 12 个字符）</label><input id="totp-new-password" name="newPassword" type="password" autoComplete="new-password" minLength={12} required value={newPassword} onChange={event => setNewPassword(event.target.value)} /></div>
        <div className="field"><label htmlFor="totp-confirm-password">确认新密码</label><input id="totp-confirm-password" name="confirmPassword" type="password" autoComplete="new-password" minLength={12} required value={confirmPassword} onChange={event => setConfirmPassword(event.target.value)} /></div>
        {error && <div className="error" role="alert" aria-live="assertive">{error}</div>}
        <div className="recovery-form-actions"><button className="primary" type="submit" disabled={busy || totpCode.length !== 6 || !newPassword || !confirmPassword}>{busy ? '验证中…' : '重置密码'}</button><button className="secondary" type="button" disabled={busy} onClick={() => { setTotpChallenge(''); setTotpCode(''); setError(''); pendingTOTPAttempt.current = null; }}>重新获取挑战</button></div>
      </form>}
    </div>}
    <p className="recovery-back"><Link href="/login">返回登录</Link></p>
  </section>;
}
