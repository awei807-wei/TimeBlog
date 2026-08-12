import Link from 'next/link';
import { getTimeline } from '@/lib/api';
import HomeTimeline from './HomeTimeline';

import AuthNav from './AuthNav';
export default async function HomePage() {
  const { days, nextCursor } = await getTimeline();
  return <main id="main-content" className="shell"><header className="topbar"><Link href="/" className="brand">个人时间线</Link><nav className="nav"><Link href="/" aria-current="page">时间线</Link><Link href="/calendar">日历</Link><Link href="/categories">分类</Link><Link href="/search">搜索</Link><Link href="/admin">写作</Link><AuthNav /></nav></header><section className="hero"><div><div className="eyebrow">A living archive</div><h1>把今天留给<br/>未来的自己。</h1></div></section><HomeTimeline initialDays={days} initialCursor={nextCursor}/></main>;
}
