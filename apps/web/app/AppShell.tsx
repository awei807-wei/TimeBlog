'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect } from 'react';
import { CalendarDays, FileText, Home, LogIn, LogOut, Menu, PenLine, Search, Tags, X } from 'lucide-react';
import { SessionProvider, useSession } from './SessionContext';
import { SidebarProvider, SidebarTrigger, useSidebar } from './components/ui/sidebar';

type NavItem = { href: string; label: string; icon: typeof Home; exact?: boolean };

const browseItems: NavItem[] = [
  { href: '/', label: '时间线', icon: Home, exact: true },
  { href: '/calendar', label: '日历', icon: CalendarDays },
  { href: '/categories', label: '分类', icon: Tags },
  { href: '/search', label: '搜索', icon: Search },
];

const manageItems: NavItem[] = [
  { href: '/admin', label: '写作', icon: PenLine, exact: true },
  { href: '/admin/entries', label: '内容管理', icon: FileText },
];

function activePath(pathname: string, item: NavItem) {
  return item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(`${item.href}/`);
}

function SidebarContent() {
  const pathname = usePathname();
  const { open, setOpen } = useSidebar();
  const { state, busy, feedback, logout } = useSession();
  const authenticated = state === 'authenticated';

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, setOpen]);

  function closeOnMobile() {
    setOpen(false);
  }

  return <>
    <aside id="primary-sidebar" className={`app-sidebar ${open ? 'is-open' : ''}`} aria-label="主导航" aria-modal={open ? true : undefined} role={open ? 'dialog' : undefined}>
      <div className="sidebar-brand-row">
        <Link href="/" className="sidebar-brand" onClick={closeOnMobile}>个人时间线<span aria-hidden="true">·</span></Link>
        <button type="button" className="sidebar-close" aria-label="关闭导航菜单" onClick={closeOnMobile}><X size={20} strokeWidth={1.8}/></button>
      </div>
      <p className="sidebar-kicker">A living archive</p>
      <nav className="sidebar-nav">
        <div className="sidebar-group" aria-labelledby="browse-heading">
          <h2 id="browse-heading">浏览</h2>
          {browseItems.map(item => <SidebarLink key={item.href} item={item} pathname={pathname} onNavigate={closeOnMobile}/>)}
        </div>
        {authenticated && <div className="sidebar-group" aria-labelledby="manage-heading">
          <h2 id="manage-heading">管理</h2>
          {manageItems.map(item => <SidebarLink key={item.href} item={item} pathname={pathname} onNavigate={closeOnMobile}/>)}
        </div>}
        <div className="sidebar-group sidebar-account" aria-labelledby="account-heading">
          <h2 id="account-heading">账户</h2>
          {state === 'loading' ? <span className="sidebar-session-placeholder" aria-hidden="true">登录状态</span> : authenticated ? <button type="button" className="sidebar-link sidebar-action" onClick={() => void logout()} disabled={busy}><LogOut size={19} aria-hidden="true"/><span>{busy ? '登出中…' : '登出'}</span></button> : <Link href="/login" className="sidebar-link" onClick={closeOnMobile}><LogIn size={19} aria-hidden="true"/><span>登录</span></Link>}
        </div>
      </nav>
      <p className="sidebar-status" aria-live="polite">{feedback}</p>
    </aside>
    {open && <button type="button" className="sidebar-overlay" aria-label="关闭导航菜单" onClick={closeOnMobile}/>} 
  </>;
}

function SidebarLink({ item, pathname, onNavigate }: { item: NavItem; pathname: string; onNavigate: () => void }) {
  const Icon = item.icon;
  const active = activePath(pathname, item);
  return <Link href={item.href} className={`sidebar-link ${active ? 'is-active' : ''}`} aria-current={active ? 'page' : undefined} onClick={onNavigate}><Icon size={19} strokeWidth={1.8} aria-hidden="true"/><span>{item.label}</span></Link>;
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  return <SessionProvider><SidebarProvider><div className="app-shell"><SidebarContent/><div className="app-main"><header className="mobile-shell-header"><Link href="/" className="sidebar-brand">个人时间线</Link><SidebarTrigger><Menu size={22} aria-hidden="true"/></SidebarTrigger></header><div className="app-content">{children}</div></div></div></SidebarProvider></SessionProvider>;
}
