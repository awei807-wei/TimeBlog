'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { Rows3, StretchHorizontal, X } from 'lucide-react';
import { getTimeline, type TimelineDay } from '@/lib/api';
import { mergeTimelineDays } from '@/lib/timeline';
import { PUBLIC_CACHE_INVALIDATED_EVENT } from '@/lib/cache-invalidation';
import PublicEntryCard from './public/PublicEntryCard';

const dateFormatter = new Intl.DateTimeFormat('zh-CN', { month: 'long', weekday: 'short', timeZone: 'Asia/Shanghai' });

function DateRail({ date }: { date: string }) {
  const parsed = new Date(`${date}T00:00:00+08:00`);
  const parts = dateFormatter.formatToParts(parsed);
  const month = parts.find(part => part.type === 'month')?.value || '';
  const weekday = parts.find(part => part.type === 'weekday')?.value || '';
  return <aside className="public-date-rail"><b>{date.slice(-2)}</b><span>{month}<br/>{weekday}</span><small>{date.slice(0, 4)}</small></aside>;
}

export default function HomeTimeline({ initialDays, initialCursor }: { initialDays: TimelineDay[]; initialCursor?: string }) {
  const [days, setDays] = useState(initialDays);
  const [cursor, setCursor] = useState(initialCursor);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [compact, setCompact] = useState(false);

  useEffect(() => {
    const refresh = () => {
      void getTimeline().then(result => {
        setDays(result.days || []);
        setCursor(result.nextCursor);
      }).catch(() => setError('时间线刷新失败，请重新加载页面。'));
    };
    window.addEventListener(PUBLIC_CACHE_INVALIDATED_EVENT, refresh);
    return () => window.removeEventListener(PUBLIC_CACHE_INVALIDATED_EVENT, refresh);
  }, []);

  const filteredDays = useMemo(() => selectedTag ? days.map(day => ({
    ...day,
    untimed: day.untimed.filter(entry => entry.tags?.includes(selectedTag) || entry.categories?.includes(selectedTag)),
    timed: day.timed.filter(entry => entry.tags?.includes(selectedTag) || entry.categories?.includes(selectedTag)),
  })).filter(day => day.untimed.length || day.timed.length) : days, [days, selectedTag]);
  const loadedCount = useMemo(() => days.reduce((total, day) => total + day.untimed.length + day.timed.length, 0), [days]);

  async function loadMore() {
    if (!cursor || loading) return;
    setLoading(true);
    setError('');
    try {
      const result = await getTimeline(20, cursor);
      setDays(current => mergeTimelineDays(current, result.days));
      setCursor(result.nextCursor);
    } catch {
      setError('加载更多失败，请稍后重试。');
    } finally {
      setLoading(false);
    }
  }

  return <>
    <section className="public-timeline-toolbar">
      <div><b>{selectedTag ? `筛选 / ${selectedTag}` : '最近记录'}</b><span>已加载 {loadedCount} 条 · 按发生时间倒序</span></div>
      {selectedTag && <button type="button" className="public-clear-filter" onClick={() => setSelectedTag(null)}>清除筛选 <X aria-hidden="true"/></button>}
      <button type="button" className="public-view-switch" onClick={() => setCompact(value => !value)} aria-pressed={compact}>{compact ? <StretchHorizontal aria-hidden="true"/> : <Rows3 aria-hidden="true"/>}{compact ? '舒展显示' : '紧凑显示'}</button>
    </section>
    <section className={`public-timeline${compact ? ' is-compact' : ''}`} aria-label="最近动态">
      {filteredDays.map(day => <section className="public-day-group" key={day.date}>
        <DateRail date={day.date}/><div className="public-day-line" aria-hidden="true"><i /></div>
        <div className="public-day-entries">{[...day.untimed, ...day.timed].map((entry, index) => <PublicEntryCard entry={entry} compact={compact} onTagClick={setSelectedTag} key={entry.id || `${day.date}-${index}`}/>)}</div>
      </section>)}
      {!filteredDays.length && <div className="public-empty">{selectedTag ? '这个标签下暂时没有已加载的公开记录。' : '还没有公开记录。'}</div>}
      {error && <div className="public-error" role="alert">{error}</div>}
      {cursor && !selectedTag && <button type="button" className="public-secondary-button public-load-more" onClick={() => void loadMore()} disabled={loading}>{loading ? '加载中…' : '加载更多'}</button>}
      {selectedTag && <Link className="public-secondary-button public-load-more" href={`/tag/${encodeURIComponent(selectedTag)}`}>查看此标签的全部记录</Link>}
    </section>
  </>;
}
