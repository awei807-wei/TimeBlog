import { getCategories, getCategory, type PublicEntry } from '@/lib/api';
import CategoryResults from './CategoryResults';
import SectionIntro from '../../public/SectionIntro';
import type { Metadata } from 'next';

const siteUrl = () => process.env.SITE_URL || 'http://localhost:3000';

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const title = decodeURIComponent(slug).replace(/-/g, ' ');
  const url = `${siteUrl()}/categories/${encodeURIComponent(slug)}`;
  return { title: `${title} · 分类`, description: `浏览“${title}”分类下的公开记录`, alternates: { canonical: url }, robots: { index: true, follow: true }, openGraph: { type: 'website', url, title: `${title} · 分类`, description: `浏览“${title}”分类下的公开记录` } };
}

export default async function CategoryPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  let categories: Record<string, number> = {};
  try { categories = (await getCategories()).categories; } catch { /* offline-safe */ }
  const category = Object.keys(categories).find(name => name.toLowerCase().replace(/\s+/g, '-') === slug) || decodeURIComponent(slug).replace(/-/g, ' ');
  let entries: PublicEntry[] = [];
  let nextCursor: string | undefined;
  try { const result = await getCategory(slug); entries = result.entries; nextCursor = result.nextCursor; } catch { /* render empty result */ }

  return <main id="main-content" className="public-page public-list-page">
    <SectionIntro eyebrow="CATEGORY" title={category} description={`共整理出 ${categories[category] || entries.length} 条公开记录。`} />
    <CategoryResults slug={slug} initialEntries={entries} initialCursor={nextCursor} />
  </main>;
}
