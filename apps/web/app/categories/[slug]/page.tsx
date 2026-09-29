import Link from 'next/link';
import { cache } from 'react';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { getCategories, getCategory } from '@/lib/api';
import CategoryResults from './CategoryResults';
import SectionIntro from '../../public/SectionIntro';
import { columnHref, findColumn, publicColumns } from '../../public/columns';
import type { Metadata } from 'next';

const loadColumns = cache(async () => publicColumns((await getCategories()).categories));
const siteUrl = () => process.env.SITE_URL || 'http://localhost:3000';

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  let columns;
  try { columns = await loadColumns(); }
  catch { return { title: '栏目暂时无法加载', robots: { index: false, follow: false } }; }
  const column = findColumn(columns, slug);
  if (!column) return { title: '栏目不存在', robots: { index: false, follow: false } };
  const title = `${column.name} · 栏目`;
  const description = `阅读“${column.name}”栏目的文章与随记，共 ${column.count} 条公开记录。`;
  const url = `${siteUrl()}${columnHref(column.name)}`;
  return { title, description, alternates: { canonical: url }, openGraph: { type: 'website', url, title, description } };
}

export default async function CategoryPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const columns = await loadColumns();
  const column = findColumn(columns, slug);
  if (!column) notFound();
  // Resolve legacy slugs, then ask the API for the original category name.
  const { entries, nextCursor } = await getCategory(column.name);
  return <main id="main-content" className="public-page public-list-page column-detail">
    <Link className="column-back" href="/categories"><ArrowLeft aria-hidden="true" /> 全部栏目</Link>
    <div className="column-cover">
      <SectionIntro eyebrow="A CONTINUING COLUMN" title={column.name} description={`收录 ${column.count} 条公开记录。同一主题的文章与随记，在这里持续积累。`} />
      <span className="column-cover-label">分类即栏目 · 按时间阅读</span>
    </div>
    <nav className="column-pills column-switcher" aria-label="切换栏目">{columns.map(item => <Link href={columnHref(item.name)} aria-current={item.name === column.name ? 'page' : undefined} key={item.name}>{item.name}<small>{item.count}</small></Link>)}</nav>
    <header className="column-content-heading"><h2>栏目内容</h2><span>文章与随记 · 按记录日期倒序</span></header>
    <CategoryResults key={column.name} slug={column.name} initialEntries={entries} initialCursor={nextCursor} />
  </main>;
}
