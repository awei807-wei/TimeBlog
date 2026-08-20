import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';
import { getCategories } from '@/lib/api';
import SectionIntro from '../public/SectionIntro';

function categorySlug(name: string) {
  return name.toLowerCase().replace(/\s+/g, '-');
}

export default async function CategoriesPage() {
  let categories: Record<string, number> = {};
  try { categories = (await getCategories()).categories; } catch { /* offline-safe empty state */ }
  const entries = Object.entries(categories).sort((left, right) => right[1] - left[1]);

  return <main id="main-content" className="public-page">
    <SectionIntro eyebrow="CATEGORIES" title="都写了些什么" description="按主题整理公开记录。每个分类都是一条持续积累的线索。" />
    {entries.length ? <section className="public-category-grid" aria-label="公开分类">{entries.map(([name, count], index) => <Link className={`public-category-card tone-${index % 4}`} href={`/categories/${encodeURIComponent(categorySlug(name))}`} key={name}>
      <span>分类 {String(index + 1).padStart(2, '0')}</span><b>{count} 条</b>
      <h2>{name}</h2><p>查看归入“{name}”的全部公开随记与文章。</p>
      <footer><span>进入分类</span><ArrowUpRight aria-hidden="true" /></footer>
    </Link>)}</section> : <div className="public-empty">还没有公开分类。</div>}
  </main>;
}
