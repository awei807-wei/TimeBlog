'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { API } from '@/lib/api';

export type AuthState = 'loading' | 'authenticated' | 'anonymous' | 'error';

export type SessionSnapshot = {
  authenticated: boolean;
  csrfToken: string;
};

export type SessionContextValue = {
  state: AuthState;
  csrfToken: string;
  busy: boolean;
  feedback: string;
  refreshSession: () => Promise<SessionSnapshot>;
  logout: () => Promise<void>;
};

const SessionContext = createContext<SessionContextValue | null>(null);

export async function requestSessionStatus(fetcher: typeof fetch = fetch): Promise<SessionSnapshot> {
  const response = await fetcher(`${API}/auth/session/status`, {
    cache: 'no-store',
    credentials: 'include',
    headers: { Accept: 'application/json' },
  });
  if (response.status === 401) return { authenticated: false, csrfToken: '' };
  if (!response.ok) throw new Error(`session ${response.status}`);

  const session = await response.json() as { authenticated?: boolean; csrfToken?: string };
  if (session.authenticated !== true) return { authenticated: false, csrfToken: '' };
  return { authenticated: true, csrfToken: session.csrfToken || '' };
}

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [state, setState] = useState<AuthState>('loading');
  const [csrfToken, setCsrfToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState('');
  const mountedRef = useRef(false);
  const refreshSequenceRef = useRef(0);

  const refreshSession = useCallback(async (): Promise<SessionSnapshot> => {
    const sequence = ++refreshSequenceRef.current;
    try {
      const session = await requestSessionStatus();
      if (mountedRef.current && sequence === refreshSequenceRef.current) {
        setCsrfToken(session.csrfToken);
        setState(session.authenticated ? 'authenticated' : 'anonymous');
        setFeedback('');
      }
      return session;
    } catch (error) {
      if (mountedRef.current && sequence === refreshSequenceRef.current) {
        setCsrfToken('');
        setState('error');
        setFeedback('登录状态暂时无法确认');
      }
      throw error;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void refreshSession().catch(() => undefined);
    return () => {
      mountedRef.current = false;
      refreshSequenceRef.current += 1;
    };
  }, [refreshSession]);

  const logout = useCallback(async () => {
    if (busy) return;
    refreshSequenceRef.current += 1;
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

  const value = useMemo(
    () => ({ state, csrfToken, busy, feedback, refreshSession, logout }),
    [state, csrfToken, busy, feedback, refreshSession, logout],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside SessionProvider');
  return value;
}
