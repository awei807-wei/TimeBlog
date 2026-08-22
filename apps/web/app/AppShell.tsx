'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { CalendarDays, FileText, Home, LogIn, LogOut, PenLine, Search, Settings2, Tags } from 'lucide-react';
import { useEffect } from 'react';
import { SessionProvider, useSession } from './SessionContext';
import PublicShell from './public/PublicShell';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from './components/ui/sidebar';

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
  { href: '/admin/settings', label: '设置', icon: Settings2 },
];

function isActive(pathname: string, item: NavItem) {
  return item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(`${item.href}/`);
}

function NavigationGroup({ title, items, pathname }: { title: string; items: NavItem[]; pathname: string }) {
  return <SidebarGroup><SidebarGroupLabel>{title}</SidebarGroupLabel><SidebarGroupContent><SidebarMenu>{items.map(item => { const Icon = item.icon; return <SidebarMenuItem key={item.href}><SidebarMenuButton asChild isActive={isActive(pathname, item)} tooltip={item.label}><Link href={item.href} aria-current={isActive(pathname, item) ? 'page' : undefined}><Icon aria-hidden="true"/><span>{item.label}</span></Link></SidebarMenuButton></SidebarMenuItem>; })}</SidebarMenu></SidebarGroupContent></SidebarGroup>;
}

function AppNavigation() {
  const pathname = usePathname();
  const { state, busy, feedback, logout } = useSession();
  const { isMobile, setOpenMobile } = useSidebar();
  const authenticated = state === 'authenticated';
  useEffect(() => {
    if (isMobile) setOpenMobile(false);
  }, [isMobile, pathname, setOpenMobile]);
  return <Sidebar collapsible="offcanvas" variant="floating" className="app-sidebar"><SidebarHeader className="sidebar-brand-row"><Link href="/" className="sidebar-brand">菜鸟手记<span aria-hidden="true">·</span></Link><span className="sidebar-kicker">CONTENT DESK</span></SidebarHeader><SidebarContent><NavigationGroup title="浏览" items={browseItems} pathname={pathname}/>{authenticated && <NavigationGroup title="管理" items={manageItems} pathname={pathname}/>}<SidebarGroup className="sidebar-account"><SidebarGroupLabel>账户</SidebarGroupLabel><SidebarGroupContent><SidebarMenu><SidebarMenuItem>{state === 'loading' ? <span className="sidebar-session-placeholder">登录状态</span> : authenticated ? <SidebarMenuButton asChild><button type="button" onClick={() => void logout()} disabled={busy}><LogOut aria-hidden="true"/><span>{busy ? '登出中…' : '登出'}</span></button></SidebarMenuButton> : <SidebarMenuButton asChild><Link href="/login"><LogIn aria-hidden="true"/><span>登录</span></Link></SidebarMenuButton>}</SidebarMenuItem></SidebarMenu></SidebarGroupContent><p className="sidebar-status" aria-live="polite">{feedback}</p></SidebarGroup></SidebarContent><SidebarFooter /></Sidebar>;
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  return <SessionProvider><ShellRoute>{children}</ShellRoute></SessionProvider>;
}

function ShellRoute({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  if (!pathname.startsWith('/admin')) return <PublicShell>{children}</PublicShell>;
  return <SidebarProvider defaultOpen><AppNavigation/><div className="app-main"><div className="mobile-shell-header"><SidebarTrigger className="sidebar-trigger" aria-label="打开管理导航"/><Link href="/admin" className="mobile-shell-brand">菜鸟手记<span aria-hidden="true">· 管理</span></Link></div><div className="app-content">{children}</div></div></SidebarProvider>;
}
