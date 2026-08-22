'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Activity, Cable, LockKeyhole, Settings2 } from 'lucide-react';

export type SettingsSection = 'general' | 'security' | 'integrations' | 'infrastructure';

const items: Array<{ id: SettingsSection; href: string; label: string; description: string; icon: typeof Settings2 }> = [
  { id: 'general', href: '/admin/settings/general', label: '常规', description: '站点偏好', icon: Settings2 },
  { id: 'security', href: '/admin/settings/security', label: '安全', description: '凭据与会话', icon: LockKeyhole },
  { id: 'integrations', href: '/admin/settings/integrations', label: '集成', description: '图床与 NAS', icon: Cable },
  { id: 'infrastructure', href: '/admin/settings/infrastructure', label: '运行状态', description: '只读诊断', icon: Activity },
];

export function SettingsNav({ section }: { section: SettingsSection }) {
  const pathname = usePathname();
  return <nav className="settings-nav" aria-label="设置区域">
    {items.map(item => {
      const Icon = item.icon;
      const active = section === item.id || pathname === item.href;
      return <Link key={item.id} href={item.href} className={`settings-nav-item${active ? ' is-active' : ''}`} aria-current={active ? 'page' : undefined}>
        <Icon aria-hidden="true" />
        <span><strong>{item.label}</strong><small>{item.description}</small></span>
      </Link>;
    })}
  </nav>;
}
export function SettingsHeader({ section, title, description }: { section: SettingsSection; title: string; description: string }) {
  return <>
    <div className="settings-center-heading">
      <div><span className="eyebrow">ADMIN · SETTINGS</span><h1>{title}</h1><p className="note">{description}</p></div>
      <Link className="secondary settings-back-link" href="/admin/entries">返回内容管理</Link>
    </div>
    <SettingsNav section={section} />
  </>;
}
