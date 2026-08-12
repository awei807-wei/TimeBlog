import Link from 'next/link';
import type { Metadata } from 'next';
import { searchPublic, type PublicEntry } from '@/lib/api';
import SearchResults from './SearchResults';

export const metadata: Metadata = { robots: { index: false, follow: false } };

export default async function SearchPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const params = await searchParams;
  const query = (params.q || '').trim();
  let entries: PublicEntry[] = [];
  let nextCursor: string | undefined;
  let failed = false;
  if (query) {
    try { const result = await searchPublic(query); entries = result.entries; nextCursor = result.nextCursor; } catch { failed = true; }
  }
  return <main id="main-content" className="shell"><div className="eyebrow">SEARCH</div><h1>搜索公开内容</h1><form action="/search" method="get" className="search-form"><label htmlFor="query">关键词</label><div className="search-row"><input id="query" name="q" defaultValue={query} placeholder="正文、文章标题、分类或标签" autoComplete="off"/><button className="primary" type="submit">搜索</button></div></form>{failed ? <div className="error-panel" role="alert">搜索暂时不可用，请稍后重试。</div> : query ? <SearchResults query={query} initialEntries={entries} initialCursor={nextCursor}/> : <div className="empty">输入关键词搜索公开正文、文章标题、分类或标签。</div>}</main>;
}
