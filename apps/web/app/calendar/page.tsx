import Link from 'next/link';
import { getCalendar } from '@/lib/api';

function monthLabel(month: string) { return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', timeZone: 'Asia/Shanghai' }).format(new Date(`${month}-01T00:00:00+08:00`)); }
function daysInMonth(month: string) { const [year, monthNumber] = month.split('-').map(Number); return new Date(Date.UTC(year, monthNumber, 0)).getUTCDate(); }
function firstWeekday(month: string) { const [year, monthNumber] = month.split('-').map(Number); return new Date(Date.UTC(year, monthNumber - 1, 1)).getUTCDay(); }

export default async function CalendarPage({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  const current = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(0, 7);
  const query = await searchParams;
  const month = /^\d{4}-\d{2}$/.test(query.month || '') ? query.month! : current;
  let counts: Record<string, number> = {};
  try { counts = (await getCalendar(month)).days; } catch { /* keep an offline-safe calendar shell */ }
  const totalDays = daysInMonth(month);
  const offset = firstWeekday(month);
  const cells = [...Array(offset).fill(null), ...Array.from({ length: totalDays }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`)];
  const [year, monthNumber] = month.split('-').map(Number);
  const previous = new Date(Date.UTC(year, monthNumber - 2, 1)).toISOString().slice(0, 7);
  const next = new Date(Date.UTC(year, monthNumber, 1)).toISOString().slice(0, 7);
  return <main id="main-content" className="shell"><header className="topbar"><Link href="/" className="brand">个人时间线</Link><nav className="nav"><Link href="/categories">分类</Link><Link href="/search">搜索</Link><Link href="/admin">写作</Link></nav></header><div className="eyebrow">CALENDAR</div><div className="calendar-heading"><div><h1>{monthLabel(month)}</h1><p className="note">记录总数；私人内容仅计占位且不显示元数据。</p></div><div className="month-nav"><Link href={`/calendar?month=${previous}`} aria-label="上个月">←</Link><Link href={`/calendar?month=${next}`} aria-label="下个月">→</Link></div></div><div className="calendar-grid" aria-label={`${month} 日历`}><div className="weekday">日</div><div className="weekday">一</div><div className="weekday">二</div><div className="weekday">三</div><div className="weekday">四</div><div className="weekday">五</div><div className="weekday">六</div>{cells.map((date, index) => date ? <Link href={`/day/${date}`} className={`calendar-day${counts[date] ? ' has-entry' : ''}`} key={date}><span>{Number(date.slice(-2))}</span>{counts[date] ? <small>{counts[date]}</small> : null}</Link> : <div className="calendar-day blank" key={`blank-${index}`} />)}</div></main>;
}
