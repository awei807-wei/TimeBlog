import { API, formatRetryAfterMessage } from '@/lib/api';

export async function getCSRF(): Promise<string> {
  const response = await fetch(`${API}/auth/session`, { credentials: 'include', headers: { Accept: 'application/json' }, cache: 'no-store' });
  if (!response.ok) throw new Error('登录会话已失效');
  const value = await response.json() as { csrfToken?: string };
  if (!value.csrfToken) throw new Error('登录会话已失效');
  return value.csrfToken;
}

export async function mutateJSON<T>(path: string, method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', body?: unknown, idempotencyKey?: string): Promise<T> {
  const csrf = await getCSRF();
  const headers: HeadersInit = { Accept: 'application/json', 'X-CSRF-Token': csrf };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const response = await fetch(`${API}${path}`, { method, credentials: 'include', headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 429) throw new Error(formatRetryAfterMessage(response.headers.get('Retry-After')));
    const detail = payload && typeof payload === 'object' && 'detail' in payload && typeof payload.detail === 'string' ? payload.detail : `API ${response.status}`;
    throw new Error(detail);
  }
  return payload as T;
}
