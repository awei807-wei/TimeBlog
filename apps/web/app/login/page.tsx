'use client';
import { FormEvent, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { API } from '@/lib/api';
import { useSession, type SessionSnapshot } from '../SessionContext';

type LoginResponse = { authenticated?: boolean; challenge?: string; requiresTotp?: boolean };
type SuccessfulLoginResult =
  | { kind: 'challenge'; challenge: string }
  | { kind: 'authenticated' }
  | { kind: 'session-missing' };

async function resolveSuccessfulLogin(
  step: 1 | 2,
  response: Response,
  refreshSession: () => Promise<SessionSnapshot>,
): Promise<SuccessfulLoginResult> {
  if (step === 1) {
    let data: LoginResponse = {};
    try {
      data = await response.json() as LoginResponse;
    } catch {
      // A password-only deployment may return no body. Session status remains
      // the source of truth whenever no TOTP challenge is present.
    }
    const challenge = typeof data.challenge === 'string' ? data.challenge.trim() : '';
    if (challenge && data.authenticated !== true && data.requiresTotp !== false) {
      return { kind: 'challenge', challenge };
    }
  }

  const session = await refreshSession();
  return session.authenticated ? { kind: 'authenticated' } : { kind: 'session-missing' };
}

export default function LoginPage() {
  const router = useRouter();
  const { refreshSession } = useSession();
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [challenge, setChallenge] = useState('');
  const [step, setStep] = useState<1 | 2>(1);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const mountedRef = useRef(false);
  const requestRef = useRef<AbortController | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams(window.location.search);
      if (params.get('changed') === '1') {
        setNotice('密码已更新，请使用新密码和当前 TOTP 登录。');
      } else if (params.get('recovered') === '1') {
        setNotice('密码已更新，请使用新密码登录；登录后仍需 TOTP 验证。');
      }
    }, 0);
    return () => {
      mountedRef.current = false;
      requestRef.current?.abort();
      window.clearTimeout(timer);
    };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || requestRef.current || (step === 1 ? !password : !code)) return;

    setError('');
    setBusy(true);
    const controller = new AbortController();
    requestRef.current = controller;
    try {
      const body = step === 1 ? { password } : { code, challenge };
      const response = await fetch(`${API}/auth/login/${step === 1 ? 'password' : 'totp'}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!mountedRef.current) return;
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

      let result: SuccessfulLoginResult;
      try {
        result = await resolveSuccessfulLogin(step, response, refreshSession);
      } catch {
        if (!mountedRef.current) return;
        setCode('');
        setChallenge('');
        setStep(1);
        setError('登录响应成功，但无法确认浏览器会话。请检查本站 Cookie 设置或网络后重新登录。');
        return;
      }
      if (!mountedRef.current) return;

      if (result.kind === 'challenge') {
        setChallenge(result.challenge);
        setStep(2);
        return;
      }
      if (result.kind === 'session-missing') {
        setCode('');
        setChallenge('');
        setStep(1);
        setError('登录响应成功，但浏览器未建立登录会话。请允许本站 Cookie 后重新登录。');
        return;
      }

      setNotice('登录成功，正在进入管理后台…');
      router.replace('/admin');
      router.refresh();
    } catch {
      if (controller.signal.aborted || !mountedRef.current) return;
      setError('无法连接登录服务，请检查网络后重试。');
    } finally {
      if (requestRef.current === controller) requestRef.current = null;
      if (mountedRef.current) setBusy(false);
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
