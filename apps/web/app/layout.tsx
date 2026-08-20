import './globals.css';
import './article-prose.css';
import './mdx-editor-chrome.css';
import './public-shell.css';
import './public-pages.css';
import './public-views.css';
import type { Metadata } from 'next';
import ServiceWorkerRegister from './ServiceWorkerRegister';
import AppShell from './AppShell';

export const metadata: Metadata = {
  metadataBase: new URL(process.env.SITE_URL || 'http://localhost:3000'),
  title: { default: '菜鸟手记', template: '%s · 菜鸟手记' },
  description: '生活、技术，还有一些当时不想忘记的事。',
  manifest: '/manifest.webmanifest',
  alternates: { types: { 'application/atom+xml': '/feed.xml' } },
  icons: { icon: '/favicon.svg' },
  openGraph: { type: 'website', siteName: '菜鸟手记', title: '菜鸟手记', description: '生活、技术，还有一些当时不想忘记的事。', images: ['/social-card.png'] },
  twitter: { card: 'summary_large_image', title: '菜鸟手记', description: '生活、技术，还有一些当时不想忘记的事。', images: ['/social-card.png'] },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const themeScript = `(function(){try{var saved=localStorage.getItem('timeblog-theme');var dark=saved?saved==='dark':matchMedia('(prefers-color-scheme: dark)').matches;document.documentElement.classList.toggle('dark',dark)}catch(e){}})()`;
  return <html lang="zh-CN" suppressHydrationWarning><head><script dangerouslySetInnerHTML={{ __html: themeScript }} /></head><body><a className="skip-link" href="#main-content">跳到主要内容</a><AppShell>{children}</AppShell><ServiceWorkerRegister /></body></html>;
}
