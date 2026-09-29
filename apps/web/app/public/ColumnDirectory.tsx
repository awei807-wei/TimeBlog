import Link from 'next/link';
import { ArrowUpRight, Library } from 'lucide-react';
import { getCategories } from '@/lib/api';
import { columnHref, publicColumns, type Column } from './columns';

export function ColumnCards({ columns }: { columns: Column[] }) {
  return <section className="column-grid" aria-label="公开栏目">{columns.map((column, index) =>
    <Link className="column-card" href={columnHref(column.name)} key={column.name}>
      <div className="column-card-top"><span>栏目 {String(index + 1).padStart(2, '0')}</span><Library aria-hidden="true" /></div>
      <h2>{column.name}</h2>
      <p>关于{column.name}的文章与随记，沿着同一条线索持续积累。</p>
      <footer><span><b>{column.count}</b> 条公开记录</span><span>阅读栏目 <ArrowUpRight aria-hidden="true" /></span></footer>
    </Link>
  )}</section>;
}

export default async function HomeColumns() {
  let columns: Column[];
  try { columns = publicColumns((await getCategories()).categories); }
  catch { return <section className="home-columns" aria-label="栏目导览"><p className="column-notice">栏目暂时无法加载。<Link href="/categories">前往栏目重试 →</Link></p></section>; }
  return <section className="home-columns" aria-labelledby="home-columns-title">
    <header><div><span className="column-kicker">EXPLORE BY TOPIC</span><h2 id="home-columns-title">沿着栏目阅读</h2></div><Link href="/categories">全部栏目 <ArrowUpRight aria-hidden="true" /></Link></header>
    {columns.length ? <nav className="column-pills" aria-label="按栏目阅读">{columns.slice(0, 6).map(column => <Link href={columnHref(column.name)} key={column.name}><span>{column.name}</span><small>{column.count}</small></Link>)}</nav> : <p className="column-notice">还没有公开栏目。为文章或随记添加分类后，会自动归入对应栏目。</p>}
  </section>;
}
