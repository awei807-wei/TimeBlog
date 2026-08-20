import type { Metadata } from 'next';
import { Search } from 'lucide-react';
import { searchPublic, type PublicEntry } from '@/lib/api';
import SearchResults from './SearchResults';
import SectionIntro from '../public/SectionIntro';

export const metadata: Metadata = { title: '搜索', robots: { index: false, follow: false } };

export default async function SearchPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const params = await searchParams;
  const query = (params.q || '').trim();
  let entries: PublicEntry[] = [];
  let nextCursor: string | undefined;
  let failed = false;
  if (query) {
    try { const result = await searchPublic(query); entries = result.entries; nextCursor = result.nextCursor; } catch { failed = true; }
  }

  return <main id="main-content" className="public-page">
    <SectionIntro eyebrow="SEARCH" title="找回某句话" description="搜索公开正文、文章标题、分类或标签。" />
    <form action="/search" method="get" className="public-big-search"><Search aria-hidden="true" /><label className="sr-only" htmlFor="query">搜索关键词</label><input id="query" name="q" defaultValue={query} placeholder="输入关键词…" autoComplete="off" /><button type="submit">搜索</button></form>
    {failed ? <div className="public-error" role="alert">搜索暂时不可用，请稍后重试。</div> : query ? <SearchResults query={query} initialEntries={entries} initialCursor={nextCursor} /> : <div className="public-search-hint">按下搜索后，只会返回公开内容。</div>}
  </main>;
}
