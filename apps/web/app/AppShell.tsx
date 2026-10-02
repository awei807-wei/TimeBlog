'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { CalendarDays, FileText, Home, LogIn, LogOut, PenLine, Search, Settings2, Tags } from 'lucide-react';
import { useEffect } from 'react';
import { SessionProvider, useSession, type SessionContextValue } from './SessionContext';
import PublicShell from './public/PublicShell';
import AppMotion from './AppMotion';
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
  { href: '/categories', label: '栏目', icon: Tags },
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

type NavigationProps = {
  session?: Pick<SessionContextValue, 'state' | 'busy' | 'feedback' | 'logout'>;
  preview?: boolean;
};

function NavigationGroup({ title, items, pathname, preview, onNavigate }: {
  title: string;
  items: NavItem[];
  pathname: string;
  preview: boolean;
  onNavigate: () => void;
}) {
  return (
    <SidebarGroup>
      <SidebarGroupLabel>{title}</SidebarGroupLabel>
      <SidebarGroupContent><SidebarMenu>{items.map(item => {
        const Icon = item.icon;
        const active = isActive(pathname, item);
        const href = preview && item.href === '/admin' ? '/preview/writing.html' : item.href;
        return (
          <SidebarMenuItem key={item.href}>
            <SidebarMenuButton asChild isActive={active} tooltip={item.label} className="min-h-11">
              <Link href={href} prefetch={preview ? false : undefined} onClick={onNavigate} aria-current={active ? 'page' : undefined}>
                <Icon aria-hidden="true" /><span>{item.label}</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        );
      })}</SidebarMenu></SidebarGroupContent>
    </SidebarGroup>
  );
}

function NavigationAccount({ session, preview }: NavigationProps) {
  if (preview) return <p className="sidebar-status">本地预览，未连接账户。管理操作仍需登录。</p>;
  if (session?.state === 'loading') return <span className="sidebar-session-placeholder">登录状态</span>;
  if (session?.state === 'authenticated') {
    return (
      <SidebarMenuButton asChild className="min-h-11">
        <button type="button" onClick={() => void session.logout()} disabled={session.busy}>
          <LogOut aria-hidden="true" /><span>{session.busy ? '登出中…' : '登出'}</span>
        </button>
      </SidebarMenuButton>
    );
  }
  return <SidebarMenuButton asChild className="min-h-11"><Link href="/login"><LogIn aria-hidden="true" /><span>登录</span></Link></SidebarMenuButton>;
}

function AppNavigation({ session, preview = false }: NavigationProps) {
  const pathname = usePathname();
  const { isMobile, setOpenMobile } = useSidebar();
  const authenticated = session?.state === 'authenticated';
  const navigation = {
    pathname: preview ? '/admin' : pathname,
    preview,
    onNavigate: () => { if (isMobile) setOpenMobile(false); },
  };
  useEffect(() => {
    if (isMobile) setOpenMobile(false);
  }, [isMobile, pathname, setOpenMobile]);
  return (
    <Sidebar collapsible="offcanvas" variant="floating" className="app-sidebar">
      <SidebarHeader className="sidebar-brand-row">
        <Link href="/" prefetch={preview ? false : undefined} onClick={navigation.onNavigate} className="sidebar-brand">菜鸟手记<span aria-hidden="true">·</span></Link>
        <span className="sidebar-kicker">CONTENT DESK</span>
      </SidebarHeader>
      <SidebarContent>
        <NavigationGroup title="浏览" items={browseItems} {...navigation} />
        {(preview || authenticated) && <NavigationGroup title="管理" items={manageItems} {...navigation} />}
        <SidebarGroup className="sidebar-account">
          <SidebarGroupLabel>账户</SidebarGroupLabel>
          <SidebarGroupContent><SidebarMenu><SidebarMenuItem><NavigationAccount session={session} preview={preview} /></SidebarMenuItem></SidebarMenu></SidebarGroupContent>
          {!preview && <p className="sidebar-status" aria-live="polite">{session?.feedback}</p>}
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter />
    </Sidebar>
  );
}

function AdminWorkspaceShell({ children, ...navigation }: NavigationProps & { children: React.ReactNode }) {
  return (
    <SidebarProvider defaultOpen>
      <AppNavigation {...navigation} />
      <div className="app-main">
        <div className="mobile-shell-header">
          <SidebarTrigger className="sidebar-trigger" aria-label="打开管理导航" />
          <Link href={navigation.preview ? '/preview/writing.html' : '/admin'} prefetch={navigation.preview ? false : undefined} className="mobile-shell-brand">菜鸟手记<span aria-hidden="true">· 管理</span></Link>
        </div>
        {children}
      </div>
    </SidebarProvider>
  );
}

/** 按真实路由装配页面；开发预览只复用视图，不创建认证会话。 */
export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  if (process.env.NODE_ENV === 'development' && pathname === '/preview/writing.html') return <AdminWorkspaceShell preview>{children}</AdminWorkspaceShell>;
  return <SessionProvider><ShellRoute>{children}</ShellRoute><AppMotion /></SessionProvider>;
}

function ShellRoute({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const session = useSession();
  if (!pathname.startsWith('/admin')) return <PublicShell>{children}</PublicShell>;
  return <AdminWorkspaceShell session={session}><div className="app-content">{children}</div></AdminWorkspaceShell>;
}
