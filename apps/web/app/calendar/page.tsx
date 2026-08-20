import CalendarView from './CalendarView';

export default async function CalendarPage({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  const current = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(0, 7);
  const query = await searchParams;
  const month = /^\d{4}-\d{2}$/.test(query.month || '') ? query.month! : current;
  return <main id="main-content" className="public-page"><CalendarView initialMonth={month}/></main>;
}
