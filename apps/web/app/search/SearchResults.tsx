'use client';

import { useState } from 'react';
import { searchPublic, type PublicEntry } from '@/lib/api';
import PublicEntryCard from '../public/PublicEntryCard';

export default function SearchResults({ query, initialEntries, initialCursor }: { query: string; initialEntries: PublicEntry[]; initialCursor?: string }) {
  const [entries, setEntries] = useState(initialEntries);
  const [cursor, setCursor] = useState(initialCursor);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function loadMore() {
    if (!cursor || loading) return;
    setLoading(true);
    setError('');
    try {
      const data = await searchPublic(query, cursor);
      setEntries(current => [...current, ...data.entries]);
      setCursor(data.nextCursor);
    } catch {
      setError('加载更多失败，请稍后重试。');
    } finally {
      setLoading(false);
    }
  }

  return <section className="public-search-results" aria-live="polite">
    <header><span>搜索结果</span><b>{entries.length}</b><p>与“{query}”相关的公开记录</p></header>
    <div className="public-result-list">{entries.length ? entries.map((entry, index) => <PublicEntryCard entry={entry} showDate compact key={entry.id || index} />) : <div className="public-empty">没有匹配的公开内容。</div>}</div>
    {error && <div className="public-error" role="alert">{error}</div>}
    {cursor && <button type="button" className="public-secondary-button public-load-more" onClick={() => void loadMore()} disabled={loading}>{loading ? '加载中…' : '加载更多'}</button>}
  </section>;
}
