export type TocItem = { level: number; title: string; id: string };
export function escapeHtml(value: string): string;
export function slugifyHeading(value: string): string;
export function renderInline(value: string): string;
export function decorateMediaReferences(html: string): string;
export function extractToc(markdown: string): TocItem[];
export function renderMarkdown(markdown: string): { html: string; toc: TocItem[] };
