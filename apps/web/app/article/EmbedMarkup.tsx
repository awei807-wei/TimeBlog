'use client';

import EmbedResolver from './EmbedResolver';
import MediaResolver from './MediaResolver';
import MermaidResolver from './MermaidResolver';

const PLACEHOLDER = /<div\b[^>]*data-provider="(youtube|bilibili|vimeo)"[^>]*data-embed-url="([^"]+)"[^>]*>.*?<\/div>/gis;

export default function EmbedMarkup({ html }: { html: string }) {
  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  for (const match of html.matchAll(PLACEHOLDER)) {
    const index = match.index ?? 0;
    if (index > cursor) nodes.push(<MermaidResolver key={`html-${cursor}`} html={html.slice(cursor, index)} />);
    nodes.push(<EmbedResolver key={`embed-${index}`} embed={{ provider: match[1] as 'youtube' | 'bilibili' | 'vimeo', url: match[2] }} />);
    cursor = index + match[0].length;
  }
  if (cursor < html.length) nodes.push(<MermaidResolver key={`html-${cursor}`} html={html.slice(cursor)} />);
  return <>{nodes}</>;
}
