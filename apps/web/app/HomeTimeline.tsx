'use client';

import { useState } from 'react';
import Link from 'next/link';
import { getTimeline, type PublicEntry, type TimelineDay } from '@/lib/api';
import { mergeTimelineDays } from '@/lib/timeline';

function EntryCard({ entry }: { entry: PublicEntry }) {
  if (entry.placeholder) return <article className="entry private"><span aria-hidden="true">◌</span><span>{entry.journalTime ? `${entry.journalTime} · ` : ''}{entry.text}</span></article>;
  const body = entry.summary || entry.markdown || '';
  return <article className="entry"><div className="entry-meta"><span>{entry.journalTime || '当日随记'}</span><span className="tag">{entry.kind === 'article' ? '文章' : '随记'}</span>{entry.tags?.slice(0, 2).map(tag => <span className="tag" key={tag}>#{tag}</span>)}</div>{entry.title ? <h2>{entry.slug ? <Link href={`/article/${entry.slug}`}>{entry.title}</Link> : entry.title}</h2> : null}<p>{body}</p></article>;
}

function Day({ day }: { day: TimelineDay }) {
  return <div className="day"><div className="day-date"><Link href={`/day/${day.date}`}>{day.date}</Link></div><div className="day-items">{[...day.untimed, ...day.timed].map((entry, index) => <EntryCard entry={entry} key={entry.id || `${day.date}-${index}`} />)}</div></div>;
}

export default function HomeTimeline({ initialDays, initialCursor }: { initialDays: TimelineDay[]; initialCursor?: string }) {
  const [days, setDays] = useState(initialDays);
  const [cursor, setCursor] = useState(initialCursor);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

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
