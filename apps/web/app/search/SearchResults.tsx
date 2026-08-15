'use client';

import { useState } from 'react';
import Link from 'next/link';
import { searchPublic, type PublicEntry } from '@/lib/api';

function ResultCard({ entry }: { entry: PublicEntry }) {
  if (entry.placeholder) return <article className="entry private"><span>{entry.text}</span></article>;
  const articleIdentifier = entry.slug || entry.id;
  const articleHref = entry.kind === 'article' && articleIdentifier ? `/article/${encodeURIComponent(articleIdentifier)}` : '';
  return <article className="entry"><div className="entry-meta"><span>{entry.journalDate}</span><span className="tag">{entry.kind === 'article' ? '文章' : '随记'}</span></div>{entry.title && <h2>{articleHref ? <Link href={articleHref} aria-label={`文章标题：${entry.title}`}>{entry.title}</Link> : entry.title}</h2>}<p>{entry.summary || entry.markdown}</p>{articleHref ? <Link className="entry-read-more" href={articleHref} aria-label={`阅读全文：${entry.title || '文章'}`}>阅读全文<span aria-hidden="true"> →</span></Link> : null}<div className="entry-links">{entry.tags?.map(t => <Link href={`/tag/${encodeURIComponent(t)}`} className="tag" key={t}>#{t}</Link>)}</div></article>;
}

export default function SearchResults({ query, initialEntries, initialCursor }: { query: string; initialEntries: PublicEntry[]; initialCursor?: string }) {
  const [entries, setEntries] = useState(initialEntries);
  const [cursor, setCursor] = useState(initialCursor);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  async function loadMore() {
    if (!cursor || loading) return;
    setLoading(true); setError('');
    try { const data = await searchPublic(query, cursor); setEntries(current => [...current, ...data.entries]); setCursor(data.nextCursor); }
    catch { setError('加载更多失败，请稍后重试。'); }
    finally { setLoading(false); }
  }
  return <section className="timeline search-results" aria-live="polite"><p className="result-count">“{query}”找到 {entries.length} 条公开记录</p>{entries.length ? entries.map((entry, index) => <ResultCard entry={entry} key={entry.id || index}/>) : <div className="empty">没有匹配的公开内容。</div>}{error && <div className="error-panel" role="alert">{error}</div>}{cursor && <button type="button" className="secondary load-more" onClick={() => void loadMore()} disabled={loading}>{loading ? '加载中…' : '加载更多'}</button>}</section>;
}
