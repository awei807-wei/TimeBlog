'use client';

import { useState } from 'react';
import { getCategory, type PublicEntry } from '@/lib/api';
import PublicEntryCard from '../../public/PublicEntryCard';

export default function CategoryResults({ slug, initialEntries, initialCursor }: { slug: string; initialEntries: PublicEntry[]; initialCursor?: string }) {
  const [entries, setEntries] = useState(initialEntries);
  const [cursor, setCursor] = useState(initialCursor);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function loadMore() {
    if (!cursor || loading) return;
    setLoading(true);
    setError('');
    try {
      const data = await getCategory(slug, cursor);
      setEntries(current => [...current, ...data.entries]);
      setCursor(data.nextCursor);
    } catch {
      setError('加载更多失败，请稍后重试。');
    } finally {
      setLoading(false);
    }
  }

  return <section className="public-result-list" aria-live="polite">
    {entries.length ? entries.map((entry, index) => <PublicEntryCard entry={entry} showDate key={entry.id || index} />) : <div className="public-empty">这个分类还没有公开内容。</div>}
    {error && <div className="public-error" role="alert">{error}</div>}
    {cursor && <button type="button" className="public-secondary-button public-load-more" onClick={() => void loadMore()} disabled={loading}>{loading ? '加载中…' : '加载更多'}</button>}
  </section>;
}
