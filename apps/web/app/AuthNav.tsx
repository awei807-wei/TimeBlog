'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { API } from '@/lib/api';

type AuthState = 'loading' | 'authenticated' | 'anonymous' | 'error';

/**
 * Same-origin session status and logout control shared by every topbar.
 * The server session remains the source of truth; deleting a browser cookie
 * alone is intentionally not used as a logout mechanism.
 */
export default function AuthNav() {
  const router = useRouter();
  const [state, setState] = useState<AuthState>('loading');
  const [csrfToken, setCsrfToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState('');

  useEffect(() => {
    let cancelled = false;
    fetch(`${API}/auth/session/status`, { credentials: 'include', headers: { Accept: 'application/json' } })
      .then(async response => {
        if (response.status === 401) return { authenticated: false };
        if (!response.ok) throw new Error(`session ${response.status}`);
        return response.json() as Promise<{ authenticated?: boolean; csrfToken?: string }>;
      })
      .then(session => {
        if (cancelled) return;
        if (session.authenticated) {
          setCsrfToken(session.csrfToken || '');
          setState('authenticated');
        } else {
          setState('anonymous');
        }
      })
      .catch(() => {
        if (!cancelled) {
          setState('error');
          setFeedback('登录状态暂时无法确认');
        }
      });
    return () => { cancelled = true; };
  }, []);

  async function logout() {
    if (busy) return;
    setBusy(true);
    setFeedback('正在退出登录');
    try {
      const response = await fetch(`${API}/auth/logout`, {
        method: 'POST',
        credentials: 'include',
        headers: { Accept: 'application/json', 'X-CSRF-Token': csrfToken },
      });
      if (response.status === 401) {
        setState('anonymous');
        setCsrfToken('');
        setFeedback('当前登录已失效');
        router.push('/');
        return;
      }
      if (!response.ok) throw new Error(`logout ${response.status}`);
      setState('anonymous');
      setCsrfToken('');
      setFeedback('已退出登录');
      router.push('/');
    } catch {
      setFeedback('退出登录失败，请检查网络后重试');
    } finally {
      setBusy(false);
    }
  }

  return <>
    <span className="auth-nav" aria-live="polite">
      {state === 'loading' ? <span className="auth-nav-placeholder" aria-hidden="true">登录</span> : state === 'authenticated' ? <button type="button" className="auth-button" onClick={() => void logout()} disabled={busy}>{busy ? '登出中…' : '登出'}</button> : <Link href="/login" aria-label={state === 'error' ? '登录（状态检查失败）' : '登录'} title={state === 'error' ? '登录状态暂时无法确认' : undefined}>登录</Link>}
    </span>
    {feedback && <span className="sr-only" role="status">{feedback}</span>}
  </>;
}
