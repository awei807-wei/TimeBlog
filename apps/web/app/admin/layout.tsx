import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

type SessionStatus = { authenticated?: boolean };

function sessionStatusURL() {
  const origin = (process.env.API_ORIGIN || 'http://localhost:8080').replace(/\/+$/, '');
  return `${origin}/api/v1/auth/session/status`;
}

async function hasValidSession(cookieHeader: string) {
  try {
    const response = await fetch(sessionStatusURL(), {
      cache: 'no-store',
      headers: { Accept: 'application/json', Cookie: cookieHeader },
    });
    if (!response.ok) return false;
    const session = await response.json() as SessionStatus;
    return session.authenticated === true;
  } catch {
    return false;
  }
}

export default async function AdminLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const cookieHeader = (await cookies()).toString();
  if (!cookieHeader || !(await hasValidSession(cookieHeader))) redirect('/login');
  return <>{children}</>;
}
