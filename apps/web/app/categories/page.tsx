import type { Metadata } from 'next';
import { getCategories } from '@/lib/api';
import SectionIntro from '../public/SectionIntro';
import { ColumnCards } from '../public/ColumnDirectory';
import { publicColumns } from '../public/columns';

export const metadata: Metadata = { title: '栏目', description: '以分类为线索，阅读持续积累的文章与随记。' };

export default async function CategoriesPage() {
  const columns = publicColumns((await getCategories()).categories);
  return <main id="main-content" className="public-page column-directory">
    <SectionIntro eyebrow="THE COLUMNS" title="每个主题，都是一个栏目" description="同一分类下的文章与随记，汇成一个持续更新的栏目。选一条感兴趣的线索，慢慢读。" />
    <div className="column-directory-meta"><span>{columns.length} 个公开栏目</span><span>按收录数量排列 · 同一记录可收录于多个栏目</span></div>
    {columns.length ? <ColumnCards columns={columns} /> : <div className="public-empty">还没有公开栏目。为公开文章或随记添加分类，即可建立对应栏目。</div>}
  </main>;
}
