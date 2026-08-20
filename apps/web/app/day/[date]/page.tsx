import { getDay } from '@/lib/api';
import PublicEntryCard from '../../public/PublicEntryCard';
import SectionIntro from '../../public/SectionIntro';
import type { Metadata } from 'next';

const siteUrl = () => process.env.SITE_URL || 'http://localhost:3000';

export async function generateMetadata({ params }: { params: Promise<{ date: string }> }): Promise<Metadata> {
  const { date } = await params;
  const url = `${siteUrl()}/day/${encodeURIComponent(date)}`;
  return { title: date, description: `${date} 的公开时间线记录`, alternates: { canonical: url }, robots: { index: true, follow: true }, openGraph: { type: 'website', url, title: date, description: `${date} 的公开时间线记录` } };
}

export default async function DayPage({ params }: { params: Promise<{ date: string }> }) {
  const { date } = await params;
  let data;
  try { data = await getDay(date); } catch { data = { date, untimed: [], timed: [] }; }
  const entries = [...data.untimed, ...data.timed];

  return <main id="main-content" className="public-page public-list-page">
    <SectionIntro eyebrow="DAY ARCHIVE" title={date} description={`这一天共有 ${entries.length} 条公开记录。`} />
    {entries.length ? <section className="public-result-list">
      {data.untimed.map((entry, index) => <PublicEntryCard entry={entry} key={entry.id || `untimed-${index}`} />)}
      {data.timed.map((entry, index) => <PublicEntryCard entry={entry} key={entry.id || `timed-${index}`} />)}
    </section> : <div className="public-empty">这一天还没有公开记录。</div>}
  </main>;
}
