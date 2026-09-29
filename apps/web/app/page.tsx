import { getTimeline } from '@/lib/api';
import HomeTimeline from './HomeTimeline';
import { Suspense } from 'react';
import HomeColumns from './public/ColumnDirectory';

export default async function HomePage() {
  const { days, nextCursor } = await getTimeline();
  return <main id="main-content" className="public-page public-home"><section className="public-hero"><span>A LIVING ARCHIVE</span><h1>最近写下的东西</h1><p>生活、技术，还有一些当时不想忘记的事。</p></section><Suspense fallback={<section className="home-columns column-loading" role="status">正在整理栏目…</section>}><HomeColumns /></Suspense><HomeTimeline initialDays={days} initialCursor={nextCursor}/></main>;
}
