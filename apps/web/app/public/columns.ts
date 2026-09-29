export type Column = { name: string; count: number };

/** Use the category name accepted by the API, without lossy punctuation folding. */
export function columnHref(name: string) {
  return `/categories/${encodeURIComponent(name)}`;
}

export function categorySlug(name: string) {
  // Matches services/core/render.go; only ASCII digits and Unicode letters survive.
  return name.trim().toLowerCase().replace(/[^a-z0-9\p{L}]+/gu, '-').replace(/^-+|-+$/g, '');
}

export function publicColumns(categories: Record<string, number>): Column[] {
  return Object.entries(categories)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-CN'));
}

/** Page and metadata params can differ in URI encoding in the installed Next.
 * Prefer literal names, then decode exactly once; never corrupt a real % name. */
export function findColumn(columns: Column[], identifier: string) {
  const match = (value: string) => {
    const name = value.toLowerCase();
    return columns.find(column => column.name.toLowerCase() === name)
      || columns.find(column => categorySlug(column.name) === name)
      || columns.find(column => column.name.toLowerCase().replace(/\s+/g, '-') === name);
  };
  const literal = match(identifier);
  if (literal) return literal;
  try { return match(decodeURIComponent(identifier)); }
  catch { return undefined; }
}
