import { getTimeline } from '@/lib/api';
import HomeTimeline from './HomeTimeline';

export default async function HomePage() {
  const { days, nextCursor } = await getTimeline();
  return <main id="main-content" className="public-page public-home"><section className="public-hero"><span>A LIVING ARCHIVE</span><h1>最近写下的东西</h1><p>生活、技术，还有一些当时不想忘记的事。</p></section><HomeTimeline initialDays={days} initialCursor={nextCursor}/></main>;
}
