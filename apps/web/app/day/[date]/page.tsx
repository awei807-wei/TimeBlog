import Link from 'next/link';
import { getDay, type PublicEntry } from '@/lib/api';
import type { Metadata } from 'next';

import AuthNav from '../../AuthNav';
const siteUrl = () => process.env.SITE_URL || 'http://localhost:3000';

export async function generateMetadata({ params }: { params: Promise<{ date: string }> }): Promise<Metadata> {
  const { date } = await params;
  const url = `${siteUrl()}/day/${encodeURIComponent(date)}`;
  return { title: `${date} · 个人时间线`, description: `${date} 的公开时间线记录`, alternates: { canonical: url }, robots: { index: true, follow: true }, openGraph: { type: 'website', url, title: `${date} · 个人时间线`, description: `${date} 的公开时间线记录` } };
}
function DayEntry({ entry, index }: { entry: PublicEntry; index: number }) {
  return entry.placeholder
    ? <article className="entry private" key={entry.id || index}>{entry.journalTime ? `${entry.journalTime} · ` : ''}{entry.text}</article>
    : <article className="entry" key={entry.id || index}><div className="entry-meta">{entry.journalTime || '当日随记'} <span className="tag">{entry.kind === 'article' ? '文章' : '随记'}</span></div>{entry.title && <h2>{entry.slug ? <Link href={`/article/${entry.slug}`}>{entry.title}</Link> : entry.title}</h2>}<p>{entry.summary || entry.markdown}</p></article>;
}

export default async function DayPage({ params }: { params: Promise<{ date: string }> }) {
  const { date } = await params;
  let data;
  try { data = await getDay(date); } catch { data = { date, untimed: [], timed: [] }; }
  const entries = [...data.untimed, ...data.timed];
  return <main id="main-content" className="shell"><header className="topbar"><Link href="/" className="brand">个人时间线</Link><nav className="nav"><Link href="/calendar">日历</Link><Link href="/search">搜索</Link><Link href="/">返回时间线</Link><AuthNav /></nav></header><div className="eyebrow">DAY</div><h1>{date}</h1><section className="timeline">{entries.length ? <>{data.untimed.length ? <section aria-labelledby="untimed-heading"><h2 id="untimed-heading">全天</h2>{data.untimed.map((entry, index) => <DayEntry entry={entry} index={index} key={entry.id || index} />)}</section> : null}{data.timed.length ? <section aria-labelledby="timed-heading"><h2 id="timed-heading">按时间</h2>{data.timed.map((entry, index) => <DayEntry entry={entry} index={index} key={entry.id || index} />)}</section> : null}</> : <div className="empty">这一天还没有公开记录。</div>}</section></main>;
}
