'use client';

import { useCallback, useRef, useState, type MutableRefObject } from 'react';
import { API } from '@/lib/api';
import { AdminRequestError, responseError } from './admin-errors';

export function useAdminSession() {
  const [csrf, setCsrf] = useState('');
  const csrfRef = useRef('');
  const sessionRequestRef = useRef<Promise<string> | null>(null);
  const setSessionCSRF = useCallback((value: string) => {
    csrfRef.current = value;
    setCsrf(value);
  }, []);
  const refreshSessionCSRF = useCallback(async () => {
    if (sessionRequestRef.current) return sessionRequestRef.current;
    const request = fetch(`${API}/auth/session`, { credentials: 'include', headers: { Accept: 'application/json' } }).then(async response => {
      if (!response.ok) throw await responseError(response, '登录会话已失效');
      const value = await response.json() as { csrfToken?: string };
      if (!value.csrfToken) throw new AdminRequestError(401, '登录会话已失效');
      setSessionCSRF(value.csrfToken);
      return value.csrfToken;
    });
    sessionRequestRef.current = request;
    try {
      return await request;
    } finally {
      if (sessionRequestRef.current === request) sessionRequestRef.current = null;
    }
  }, [setSessionCSRF]);
  return { csrf, csrfRef: csrfRef as MutableRefObject<string>, refreshSessionCSRF };
}
