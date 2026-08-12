import './globals.css';
import type { Metadata } from 'next';
import ServiceWorkerRegister from './ServiceWorkerRegister';
import AppShell from './AppShell';

export const metadata: Metadata = {
  title: '个人时间线',
  description: '以天为最小公开单元的个人长期记忆系统',
  alternates: { types: { 'application/atom+xml': '/feed.xml' } },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body><a className="skip-link" href="#main-content">跳到主要内容</a><AppShell>{children}</AppShell><ServiceWorkerRegister /></body></html>;
}
