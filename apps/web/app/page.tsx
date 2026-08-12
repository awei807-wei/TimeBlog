import Link from 'next/link';
import { getTimeline } from '@/lib/api';
import HomeTimeline from './HomeTimeline';

export default async function HomePage() {
  const { days, nextCursor } = await getTimeline();
  return <main id="main-content" className="shell"><section className="hero"><div><div className="eyebrow">A living archive</div><h1>把今天留给<br/>未来的自己。</h1></div></section><HomeTimeline initialDays={days} initialCursor={nextCursor}/></main>;
}
