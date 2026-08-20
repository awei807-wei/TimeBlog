import { notFound } from 'next/navigation';
import { getTag } from '@/lib/api';
import TagResults from './TagResults';
import SectionIntro from '../../public/SectionIntro';
import type { Metadata } from 'next';

const siteUrl = () => process.env.SITE_URL || 'http://localhost:3000';

export async function generateMetadata({ params }: { params: Promise<{ tag: string }> }): Promise<Metadata> {
  const { tag } = await params;
  const label = decodeURIComponent(tag);
  const url = `${siteUrl()}/tag/${encodeURIComponent(tag)}`;
  return { title: `#${label}`, description: `浏览标签“${label}”下的公开记录`, alternates: { canonical: url }, robots: { index: true, follow: true }, openGraph: { type: 'website', url, title: `#${label}`, description: `浏览标签“${label}”下的公开记录` } };
}

export default async function TagPage({ params }: { params: Promise<{ tag: string }> }) {
  const { tag } = await params;
  let data;
  try { data = await getTag(tag); } catch { notFound(); }
  return <main id="main-content" className="public-page public-list-page">
    <SectionIntro eyebrow="TAG" title={`#${data.tag}`} description={`当前已载入 ${data.entries.length} 条带有此标签的公开记录。`} />
    <TagResults tag={tag} initialEntries={data.entries} initialCursor={data.nextCursor} />
  </main>;
}
