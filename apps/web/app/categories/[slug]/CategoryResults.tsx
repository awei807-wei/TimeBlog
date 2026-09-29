'use client';

import { useRef, useState } from 'react';
import { getCategory, type PublicEntry } from '@/lib/api';
import PublicEntryCard from '../../public/PublicEntryCard';

export default function CategoryResults({ slug, initialEntries, initialCursor }: { slug: string; initialEntries: PublicEntry[]; initialCursor?: string }) {
  const [entries, setEntries] = useState(initialEntries);
  const [cursor, setCursor] = useState(initialCursor);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);

  async function loadMore() {
    if (!cursor || pending.current) return;
    pending.current = true;
    setLoading(true);
    setError('');
    try {
      const data = await getCategory(slug, cursor);
      setEntries(current => {
        const ids = new Set(current.map(entry => entry.id).filter(Boolean));
        return [...current, ...data.entries.filter(entry => {
          if (!entry.id) return true;
          if (ids.has(entry.id)) return false;
          ids.add(entry.id);
          return true;
        })];
      });
      setCursor(data.nextCursor);
    } catch {
      setError('加载更多失败，请稍后重试。');
    } finally {
      pending.current = false;
      setLoading(false);
    }
  }

  return <section className="public-result-list" aria-label="栏目记录" aria-busy={loading} aria-live="polite">
    {entries.length ? entries.map((entry, index) => <PublicEntryCard entry={entry} showDate key={entry.id || index} />) : <div className="public-empty">这个栏目还没有公开内容。</div>}
    {error && <div className="public-error" role="alert">{error}</div>}
    {cursor && <button type="button" className="public-secondary-button public-load-more" onClick={() => void loadMore()} disabled={loading}>{loading ? '加载中…' : error ? '重试加载' : '加载更多'}</button>}
  </section>;
}
