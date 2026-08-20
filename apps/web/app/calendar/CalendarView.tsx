'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpRight, ChevronLeft, ChevronRight } from 'lucide-react';
import { getCalendar, getDay, type PublicEntry } from '@/lib/api';
import SectionIntro from '../public/SectionIntro';
import { articleHref, entryExcerpt } from '../public/public-entry';

const monthFormatter = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', timeZone: 'Asia/Shanghai' });
const dateFormatter = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long', timeZone: 'Asia/Shanghai' });
const weekdays = ['日', '一', '二', '三', '四', '五', '六'];

function monthLabel(month: string) {
  return monthFormatter.format(new Date(`${month}-01T00:00:00+08:00`));
}

function shiftMonth(month: string, delta: number) {
  const [year, monthNumber] = month.split('-').map(Number);
  return new Date(Date.UTC(year, monthNumber - 1 + delta, 1)).toISOString().slice(0, 7);
}

function monthCells(month: string) {
  const [year, monthNumber] = month.split('-').map(Number);
  const offset = new Date(Date.UTC(year, monthNumber - 1, 1)).getUTCDay();
  return Array.from({ length: 42 }, (_, index) => {
    const value = new Date(Date.UTC(year, monthNumber - 1, index - offset + 1));
    const date = value.toISOString().slice(0, 10);
    return { date, day: value.getUTCDate(), currentMonth: date.startsWith(month) };
  });
}

function defaultSelectedDate(month: string) {
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
  return today.startsWith(month) ? today : `${month}-01`;
}

function DayPreview({ date, entries, loading }: { date: string; entries: PublicEntry[]; loading: boolean }) {
  return <aside className="public-day-preview" aria-live="polite">
    <span>选中日期</span>
    <h2>{dateFormatter.format(new Date(`${date}T00:00:00+08:00`))}</h2>
    {loading ? <p className="public-calendar-status">正在读取当天记录…</p> : entries.length ? <div className="public-preview-list">{entries.slice(0, 3).map((entry, index) => {
      const href = articleHref(entry);
      const content = <><small>{entry.journalTime || (entry.kind === 'article' ? '文章' : '当日随记')}</small><strong>{entry.title || entryExcerpt(entry, 72) || entry.text || '私人记录'}</strong><ArrowUpRight aria-hidden="true" /></>;
      return href ? <Link href={href} key={entry.id || index}>{content}</Link> : <div key={entry.id || index}>{content}</div>;
    })}</div> : <p className="public-calendar-status">这一天还没有公开记录。</p>}
    <Link className="public-day-all" href={`/day/${date}`}>查看当天全部记录 <ArrowUpRight aria-hidden="true" /></Link>
  </aside>;
}

export default function CalendarView({ initialMonth }: { initialMonth: string }) {
  const [month, setMonth] = useState(initialMonth);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [selectedDate, setSelectedDate] = useState(() => defaultSelectedDate(initialMonth));
  const [selectedEntries, setSelectedEntries] = useState<PublicEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [error, setError] = useState('');
  const requestRef = useRef(0);
  const previewRequestRef = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    const requestID = ++requestRef.current;
    void getCalendar(month, controller.signal).then(data => {
      if (controller.signal.aborted || requestID !== requestRef.current) return;
      setCounts(data.days || {});
    }).catch(() => {
      if (controller.signal.aborted || requestID !== requestRef.current) return;
      setCounts({});
      setError('日历暂时无法加载，请稍后重试。');
    }).finally(() => {
      if (!controller.signal.aborted && requestID === requestRef.current) setLoading(false);
    });
    return () => controller.abort();
  }, [month]);

  useEffect(() => {
    const controller = new AbortController();
    const requestID = ++previewRequestRef.current;
    if (!counts[selectedDate]) return () => controller.abort();
    const loadingFrame = window.setTimeout(() => setPreviewLoading(true), 0);
    void getDay(selectedDate, controller.signal).then(data => {
      if (controller.signal.aborted || requestID !== previewRequestRef.current) return;
      setSelectedEntries([...data.untimed, ...data.timed]);
    }).catch(() => {
      if (!controller.signal.aborted && requestID === previewRequestRef.current) setSelectedEntries([]);
    }).finally(() => {
      if (!controller.signal.aborted && requestID === previewRequestRef.current) setPreviewLoading(false);
    });
    return () => { window.clearTimeout(loadingFrame); controller.abort(); };
  }, [counts, selectedDate]);

  const cells = useMemo(() => monthCells(month), [month]);
  const total = useMemo(() => Object.values(counts).reduce((sum, count) => sum + count, 0), [counts]);

  function changeMonth(delta: number) {
    const next = shiftMonth(month, delta);
    setMonth(next);
    setSelectedDate(defaultSelectedDate(next));
    setSelectedEntries([]);
    setPreviewLoading(false);
    setLoading(true);
    setError('');
  }

  function selectDate(date: string) {
    setSelectedDate(date);
    setSelectedEntries([]);
    setPreviewLoading(Boolean(counts[date]));
  }

  return <>
    <SectionIntro eyebrow="CALENDAR" title="沿着日期找回当时" description="有记录的日子会留下标记。选中日期即可先看摘要，再进入当天时间线。" />
    {error && <div className="public-error" role="alert">{error}</div>}
    <section className="public-calendar-layout">
      <div className="public-calendar-card" aria-busy={loading}>
        <header>
          <button type="button" onClick={() => changeMonth(-1)} aria-label="上个月"><ChevronLeft aria-hidden="true" /></button>
          <div><b>{monthLabel(month)}</b><span>{loading ? '正在同步记录' : `本月共 ${total} 条记录`}</span></div>
          <button type="button" onClick={() => changeMonth(1)} aria-label="下个月"><ChevronRight aria-hidden="true" /></button>
        </header>
        <div className="public-week-row">{weekdays.map(day => <span key={day}>{day}</span>)}</div>
        <div className="public-calendar-grid" aria-label={`${month} 日历`}>{cells.map(cell => {
          const count = counts[cell.date] || 0;
          return <button type="button" className={`${cell.currentMonth ? '' : 'is-ghost'}${count ? ' has-entry' : ''}${selectedDate === cell.date ? ' is-selected' : ''}`} onClick={() => selectDate(cell.date)} key={cell.date} aria-label={`${cell.date}${count ? `，${count} 条记录` : ''}`}><span>{cell.day}</span>{count ? <i>{count}</i> : null}</button>;
        })}</div>
        <footer><span><i /> 无记录</span><span><i /> 有记录</span><b>{total} 条</b></footer>
      </div>
      <DayPreview date={selectedDate} entries={selectedEntries} loading={previewLoading} />
    </section>
  </>;
}
