import Link from 'next/link';
import { getCategories } from '@/lib/api';

export default async function CategoriesPage() {
  let categories: Record<string, number> = {};
  try { categories = (await getCategories()).categories; } catch { /* render an offline-safe empty state */ }
  const slug = (name: string) => name.toLowerCase().replace(/\s+/g, '-');
  return <main id="main-content" className="shell"><div className="eyebrow">CATEGORIES</div><h1>分类</h1><section className="category-list" aria-label="公开分类">{Object.keys(categories).length ? Object.entries(categories).map(([name, count]) => <Link className="category-row" href={`/categories/${encodeURIComponent(slug(name))}`} key={name}><span>{name}</span><strong>{count}</strong></Link>) : <div className="empty">还没有公开分类。</div>}</section></main>;
}
