import type { MetadataRoute } from 'next';
import { getTimeline, getCategories } from '@/lib/api';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = process.env.SITE_URL || 'http://localhost:3000';
  const urls: MetadataRoute.Sitemap = [{ url: base }, { url: `${base}/calendar` }, { url: `${base}/categories` }];
  try {
    const tagSlugs = new Set<string>();
    let cursor = '';
    for (let page = 0; page < 100; page += 1) {
      const timeline = await getTimeline(100, cursor);
      for (const day of timeline.days) {
      const entries = [...day.untimed, ...day.timed];
      const lastModified = entries.map(entry => entry.updatedAt).filter(Boolean).sort().at(-1);
      urls.push({ url: `${base}/day/${day.date}`, ...(lastModified ? { lastModified } : {}) });
        for (const entry of entries) {
          for (const tag of entry.tags || []) tagSlugs.add(tag);
          const articleIdentifier = entry.slug || entry.id;
          if (articleIdentifier && entry.kind === 'article') urls.push({ url: `${base}/article/${encodeURIComponent(articleIdentifier)}`, ...(entry.updatedAt ? { lastModified: entry.updatedAt } : {}) });
        }
      }
      if (!timeline.nextCursor || timeline.nextCursor === cursor) break;
      cursor = timeline.nextCursor;
    }
    const categories = await getCategories();
    for (const name of Object.keys(categories.categories)) urls.push({ url: `${base}/categories/${encodeURIComponent(name.toLowerCase().replace(/\s+/g, '-'))}` });
    for (const tag of tagSlugs) urls.push({ url: `${base}/tag/${encodeURIComponent(tag)}` });
  } catch { /* keep a valid minimal sitemap during API downtime */ }
  return urls;
}
