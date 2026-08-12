'use client';

import { createContext, useContext, useMemo, useState } from 'react';

type SidebarContextValue = { open: boolean; setOpen: (open: boolean) => void; toggle: () => void };
const SidebarContext = createContext<SidebarContextValue | null>(null);

export function SidebarProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const value = useMemo(() => ({ open, setOpen, toggle: () => setOpen(value => !value) }), [open]);
  return <SidebarContext.Provider value={value}>{children}</SidebarContext.Provider>;
}

export function useSidebar() {
  const value = useContext(SidebarContext);
  if (!value) throw new Error('useSidebar must be used inside SidebarProvider');
  return value;
}

export function SidebarTrigger({ className = '', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const { open, toggle } = useSidebar();
  return <button type="button" className={`sidebar-trigger ${className}`} onClick={toggle} aria-label="打开导航菜单" aria-controls="primary-sidebar" aria-expanded={open} {...props} />;
}
