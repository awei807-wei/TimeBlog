'use client';

import Link from 'next/link';
import Image from 'next/image';
import { useSyncExternalStore } from 'react';
import { usePathname } from 'next/navigation';
import { LogIn, LogOut, Moon, PenLine, Sun } from 'lucide-react';
import { useSession } from '../SessionContext';

const navItems = [
  { href: '/', label: '时间线', matches: (path: string) => path === '/' || path.startsWith('/day/') || path.startsWith('/article/') },
  { href: '/calendar', label: '日历', matches: (path: string) => path === '/calendar' },
  { href: '/categories', label: '分类', matches: (path: string) => path.startsWith('/categories') || path.startsWith('/tag/') },
  { href: '/search', label: '搜索', matches: (path: string) => path === '/search' },
] as const;

function ThemeButton() {
  const dark = useSyncExternalStore(
    listener => {
      window.addEventListener('timeblog-theme-change', listener);
      return () => window.removeEventListener('timeblog-theme-change', listener);
    },
    () => document.documentElement.classList.contains('dark'),
    () => false,
  );

  function toggleTheme() {
    const next = !dark;
    document.documentElement.classList.toggle('dark', next);
    window.localStorage.setItem('timeblog-theme', next ? 'dark' : 'light');
    window.dispatchEvent(new Event('timeblog-theme-change'));
  }

  const Icon = dark ? Sun : Moon;
  return <button type="button" className="public-icon-button" onClick={toggleTheme} aria-label={dark ? '切换到浅色主题' : '切换到深色主题'} title={dark ? '浅色主题' : '深色主题'}><Icon aria-hidden="true" /></button>;
}

function PublicNavigation() {
  const pathname = usePathname();
  return <nav className="public-nav" aria-label="主要导航">{navItems.map(item => {
    const active = item.matches(pathname);
    return <Link href={item.href} className={active ? 'is-active' : undefined} aria-current={active ? 'page' : undefined} key={item.href}>{item.label}</Link>;
  })}</nav>;
}

function AccountActions() {
  const { state, busy, logout } = useSession();
  const authenticated = state === 'authenticated';
  return <div className="public-head-actions">
    <ThemeButton />
    {authenticated ? <button type="button" className="public-icon-button" onClick={() => void logout()} disabled={busy} aria-label={busy ? '正在登出' : '登出'} title="登出"><LogOut aria-hidden="true" /></button> : <Link className="public-icon-button" href="/login" aria-label="登录" title="登录"><LogIn aria-hidden="true" /></Link>}
    <Link className="public-write-button" href={authenticated ? '/admin' : '/login'}><PenLine aria-hidden="true" /><span>{authenticated ? '写点什么' : '登录写作'}</span></Link>
  </div>;
}

export default function PublicShell({ children }: { children: React.ReactNode }) {
  return <div className="public-shell" id="top">
    <header className="public-masthead">
      <Link href="/" className="public-wordmark" aria-label="菜鸟手记首页">
        <Image className="public-brand-mark" src="/brand/mascot.webp" alt="" width={40} height={40} priority />
        <span className="public-wordmark-copy"><b>菜鸟手记</b><small>生活与技术的零碎记录</small></span>
      </Link>
      <PublicNavigation />
      <AccountActions />
    </header>
    <div className="public-content">{children}</div>
    <footer className="public-footer"><span>© 2026 菜鸟手记</span><p>写给未来，也写给那个总会忘记的自己。</p><a href="#top">回到顶部 ↑</a></footer>
  </div>;
}
