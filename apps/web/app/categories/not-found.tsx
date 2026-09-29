import Link from 'next/link';

export default function ColumnNotFound() {
  return <main id="main-content" className="public-page column-state"><h1>还没有这个公开栏目</h1><p>栏目可能已更名，或尚未收录公开内容。</p><Link className="public-secondary-button" href="/categories">浏览全部栏目</Link></main>;
}
