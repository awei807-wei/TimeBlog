import Link from 'next/link';
import { getTimeline } from '@/lib/api';
import HomeTimeline from './HomeTimeline';

export default async function HomePage() {
  const { days, nextCursor } = await getTimeline();
  return <main id="main-content" className="shell"><header className="topbar"><Link href="/" className="brand">个人时间线</Link><nav className="nav"><Link href="/" aria-current="page">时间线</Link><Link href="/calendar">日历</Link><Link href="/categories">分类</Link><Link href="/search">搜索</Link><Link href="/admin">写作</Link></nav></header><section className="hero"><div><div className="eyebrow">A living archive</div><h1>把今天留给<br/>未来的自己。</h1><p>以天为单位记录正在发生的事。短记录直接回到时间线，完整文章保留自己的地址与上下文。</p></div><div className="note">公开内容可读，私人记录只留下时间和一枚锁。数据以 Markdown 为真源，随时可以完整导出。</div></section><HomeTimeline initialDays={days} initialCursor={nextCursor}/></main>;
}
