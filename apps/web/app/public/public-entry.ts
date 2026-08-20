import type { PublicEntry } from '@/lib/api';

export function articleHref(entry: PublicEntry) {
  const identifier = entry.slug || entry.id;
  return entry.kind === 'article' && identifier ? `/article/${encodeURIComponent(identifier)}` : '';
}

function plainEntryText(source: string, preserveCode = false) {
  return source
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/```[^\n]*\n?([\s\S]*?)```/g, preserveCode ? '$1' : ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^[#>*+-]+\s*/gm, '')
    .replace(/[`*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function entryFullText(entry: PublicEntry) {
  return plainEntryText(entry.markdown || entry.text || entry.summary || '', true);
}

export function entryExcerpt(entry: PublicEntry, limit = 240) {
  const plain = plainEntryText(entry.summary || entry.markdown || entry.text || '');
  return plain.length > limit ? `${plain.slice(0, limit).trimEnd()}…` : plain;
}

export function primaryCategory(entry: PublicEntry) {
  return entry.categories?.[0] || (entry.kind === 'article' ? '文章' : '日常');
}
