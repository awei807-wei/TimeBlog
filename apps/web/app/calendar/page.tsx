import Link from 'next/link';
import AuthNav from '../AuthNav';
import CalendarView from './CalendarView';

export default async function CalendarPage({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  const current = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(0, 7);
  const query = await searchParams;
  const month = /^\d{4}-\d{2}$/.test(query.month || '') ? query.month! : current;
  return <main id="main-content" className="shell"><header className="topbar"><Link href="/" className="brand">个人时间线</Link><nav className="nav"><Link href="/categories">分类</Link><Link href="/search">搜索</Link><Link href="/admin">写作</Link><AuthNav /></nav></header><CalendarView initialMonth={month}/></main>;
}
