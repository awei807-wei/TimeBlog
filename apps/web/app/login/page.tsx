'use client';
import { FormEvent, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { API } from '@/lib/api';

type LoginResponse = { challenge?: string };

export default function LoginPage() {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [challenge, setChallenge] = useState('');
  const [step, setStep] = useState<1 | 2>(1);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (new URLSearchParams(window.location.search).get('recovered') === '1') {
        setNotice('密码已更新，请使用新密码登录；登录后仍需 TOTP 验证。');
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || (step === 1 ? !password : !code)) return;

    setError('');
    setBusy(true);
    try {
      const body = step === 1 ? { password } : { code, challenge };
      const response = await fetch(`${API}/auth/login/${step === 1 ? 'password' : 'totp'}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (response.status === 429) {
        setError('尝试次数过多，请稍后重试。');
        return;
      }
      if (!response.ok) {
        if (step === 2 && response.status === 401) {
          setCode('');
          setChallenge('');
          setStep(1);
          setError('验证码无效或登录挑战已失效，请重新输入密码。');
          return;
        }
        setError('凭据不正确');
        return;
      }

      const data = await response.json() as LoginResponse;
      if (step === 1) {
        setChallenge(data.challenge || '');
        setStep(2);
      } else {
        router.push('/admin');
      }
    } catch {
      setError('无法连接登录服务，请检查网络后重试。');
    } finally {
      setBusy(false);
    }
  }

  const submitLabel = busy ? (step === 1 ? '验证中…' : '登录中…') : (step === 1 ? '继续' : '登录');

  return <main id="main-content" className="shell">
    <div className="login">
      <Link href="/" className="brand">菜鸟手记</Link>
      <h1>作者登录</h1>
      <p className="note">需要密码与一次性验证码。不会在浏览器本地保存认证令牌。</p>
      {notice && <div className="status" role="status">{notice}</div>}
      <form onSubmit={submit} aria-busy={busy}>
        {step === 1 ? <div className="field" key="password">
          <label htmlFor="password">密码</label>
          <input id="password" name="password" type="password" autoComplete="current-password" required autoFocus disabled={busy} value={password} onChange={event => setPassword(event.target.value)} />
        </div> : <div className="field" key="totp">
          <label htmlFor="code">TOTP 验证码</label>
          <input id="code" name="code" inputMode="numeric" autoComplete="one-time-code" required autoFocus disabled={busy} value={code} onChange={event => setCode(event.target.value)} />
        </div>}
        {error && <div className="error" role="alert" aria-live="assertive">{error}</div>}
        <button className="primary" type="submit" disabled={busy || (step === 1 ? !password : !code)}>{submitLabel}</button>
      </form>
    </div>
  </main>;
}
