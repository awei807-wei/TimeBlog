'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { getTimeline, type PublicEntry, type TimelineDay } from '@/lib/api';
import { mergeTimelineDays } from '@/lib/timeline';
import { PUBLIC_CACHE_INVALIDATED_EVENT } from '@/lib/cache-invalidation';

function EntryCard({ entry }: { entry: PublicEntry }) {
  if (entry.placeholder) return <article className="entry private"><span aria-hidden="true">◌</span><span>{entry.journalTime ? `${entry.journalTime} · ` : ''}{entry.text}</span></article>;
  const body = entry.summary || entry.markdown || '';
  const articleIdentifier = entry.slug || entry.id;
  const articleHref = entry.kind === 'article' && articleIdentifier ? `/article/${encodeURIComponent(articleIdentifier)}` : '';
  return <article className="entry"><div className="entry-meta"><span>{entry.journalTime || '当日随记'}</span><span className="tag">{entry.kind === 'article' ? '文章' : '随记'}</span>{entry.tags?.slice(0, 2).map(tag => <span className="tag" key={tag}>#{tag}</span>)}</div>{entry.title ? <h2>{articleHref ? <Link href={articleHref} aria-label={`文章标题：${entry.title}`}>{entry.title}</Link> : entry.title}</h2> : null}<p>{body}</p>{articleHref ? <Link className="entry-read-more" href={articleHref} aria-label={`阅读全文：${entry.title || '文章'}`}>阅读全文<span aria-hidden="true"> →</span></Link> : null}</article>;
}

function Day({ day }: { day: TimelineDay }) {
  return <div className="day"><div className="day-date"><Link href={`/day/${day.date}`}>{day.date}</Link></div><div className="day-items">{[...day.untimed, ...day.timed].map((entry, index) => <EntryCard entry={entry} key={entry.id || `${day.date}-${index}`} />)}</div></div>;
}

export default function HomeTimeline({ initialDays, initialCursor }: { initialDays: TimelineDay[]; initialCursor?: string }) {
  const [days, setDays] = useState(initialDays);
  const [cursor, setCursor] = useState(initialCursor);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const refresh = () => {
      void getTimeline().then(result => {
        setDays(result.days || []);
        setCursor(result.nextCursor);
      }).catch(() => setError('时间线刷新失败，请重新加载页面。'));
    };
    const onEvent = () => refresh();
    window.addEventListener(PUBLIC_CACHE_INVALIDATED_EVENT, onEvent);
    return () => window.removeEventListener(PUBLIC_CACHE_INVALIDATED_EVENT, onEvent);
  }, []);

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

  return <section className="timeline" aria-label="最近动态">{days.length ? days.map(day => <Day day={day} key={day.date} />) : <div className="empty">还没有公开记录。</div>}{error && <div className="error-panel" role="alert">{error}</div>}{cursor && <button type="button" className="secondary load-more" onClick={() => void loadMore()} disabled={loading}>{loading ? '加载中…' : '加载更多'}</button>}</section>;
}
