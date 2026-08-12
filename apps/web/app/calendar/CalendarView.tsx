'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { getCalendar } from '@/lib/api';

function monthLabel(month: string) { return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', timeZone: 'Asia/Shanghai' }).format(new Date(`${month}-01T00:00:00+08:00`)); }
function daysInMonth(month: string) { const [year, monthNumber] = month.split('-').map(Number); return new Date(Date.UTC(year, monthNumber, 0)).getUTCDate(); }
function firstWeekday(month: string) { const [year, monthNumber] = month.split('-').map(Number); return new Date(Date.UTC(year, monthNumber - 1, 1)).getUTCDay(); }
function shiftMonth(month: string, delta: number) { const [year, monthNumber] = month.split('-').map(Number); return new Date(Date.UTC(year, monthNumber - 1 + delta, 1)).toISOString().slice(0, 7); }

export default function CalendarView({ initialMonth }: { initialMonth: string }) {
  const [month, setMonth] = useState(initialMonth);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const requestRef = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    const requestID = ++requestRef.current;
    const loadingFrame = window.setTimeout(() => { setLoading(true); setError(''); }, 0);
    void getCalendar(month, controller.signal).then(data => {
      if (controller.signal.aborted || requestID !== requestRef.current) return;
      setCounts(data.days || {});
    }).catch(caught => {
      if (controller.signal.aborted || requestID !== requestRef.current) return;
      setCounts({});
      setError(caught instanceof Error ? '日历暂时无法加载，请稍后重试。' : '日历暂时无法加载。');
    }).finally(() => {
      if (!controller.signal.aborted && requestID === requestRef.current) setLoading(false);
    });
    return () => { window.clearTimeout(loadingFrame); controller.abort(); };
  }, [month]);

  const cells = useMemo(() => {
    const totalDays = daysInMonth(month);
    const offset = firstWeekday(month);
    return [...Array(offset).fill(null), ...Array.from({ length: totalDays }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`)];
  }, [month]);

  return <>
    <div className="eyebrow">CALENDAR</div>
    <div className="calendar-heading"><div><h1>{monthLabel(month)}</h1><p className="note">记录总数；私人内容仅计占位且不显示元数据。</p></div><div className="month-nav"><button type="button" className="month-button" onClick={() => setMonth(current => shiftMonth(current, -1))} aria-label="上个月" disabled={loading}>←</button><button type="button" className="month-button" onClick={() => setMonth(current => shiftMonth(current, 1))} aria-label="下个月" disabled={loading}>→</button></div></div>
    {error ? <div className="error-panel" role="alert">{error}</div> : null}
    {loading ? <div className="empty" role="status">日历加载中…</div> : null}
    <div className="calendar-grid" aria-label={`${month} 日历`} aria-busy={loading}><div className="weekday">日</div><div className="weekday">一</div><div className="weekday">二</div><div className="weekday">三</div><div className="weekday">四</div><div className="weekday">五</div><div className="weekday">六</div>{cells.map((date, index) => date ? <a href={`/day/${date}`} className={`calendar-day${counts[date] ? ' has-entry' : ''}`} key={date}><span>{Number(date.slice(-2))}</span>{counts[date] ? <small>{counts[date]}</small> : null}</a> : <div className="calendar-day blank" key={`blank-${index}`} />)}</div>
  </>;
}
