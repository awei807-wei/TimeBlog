import type { PublicEntry } from '@/lib/api';

export function articleHref(entry: PublicEntry) {
  const identifier = entry.slug || entry.id;
  return entry.kind === 'article' && identifier ? `/article/${encodeURIComponent(identifier)}` : '';
}

export function entryExcerpt(entry: PublicEntry, limit = 240) {
  const source = entry.summary || entry.markdown || entry.text || '';
  const plain = source
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^[#>*+-]+\s*/gm, '')
    .replace(/[`*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > limit ? `${plain.slice(0, limit).trimEnd()}…` : plain;
}

export function primaryCategory(entry: PublicEntry) {
  return entry.categories?.[0] || (entry.kind === 'article' ? '文章' : '日常');
}
