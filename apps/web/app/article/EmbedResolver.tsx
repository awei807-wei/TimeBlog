'use client';

import { useEffect, useState } from 'react';
import { embedSource } from '../../lib/embed-utils';

type Provider = 'youtube' | 'bilibili' | 'vimeo';
type Embed = { provider: Provider; url: string; title?: string };

export default function EmbedResolver({ embed }: { embed: Embed }) {
  const [visible, setVisible] = useState(() => typeof window === 'undefined' || !('IntersectionObserver' in window));
  useEffect(() => {
    const node = document.querySelector(`[data-embed-url="${CSS.escape(embed.url)}"]`);
    if (!node || !('IntersectionObserver' in window)) return;
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); } }, { rootMargin: '240px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [embed.url]);
  const src = embedSource(embed.provider, embed.url);
  if (!src) return <span className="embed-unavailable">嵌入地址不可用</span>;
  return <span className="embed-frame" data-embed-url={embed.url}><iframe title={embed.title || `${embed.provider} 嵌入`} src={visible ? src : undefined} loading="lazy" sandbox="allow-scripts allow-same-origin allow-presentation" referrerPolicy="strict-origin-when-cross-origin" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" /></span>;
}
