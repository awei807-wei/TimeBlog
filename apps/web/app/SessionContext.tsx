'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { API } from '@/lib/api';

export type AuthState = 'loading' | 'authenticated' | 'anonymous' | 'error';

type SessionContextValue = {
  state: AuthState;
  csrfToken: string;
  busy: boolean;
  feedback: string;
  logout: () => Promise<void>;
};

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
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

  const logout = useCallback(async () => {
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
  }, [busy, csrfToken, router]);

  const value = useMemo(() => ({ state, csrfToken, busy, feedback, logout }), [state, csrfToken, busy, feedback, logout]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside SessionProvider');
  return value;
}
