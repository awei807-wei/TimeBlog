'use client';

import { useEffect, useRef } from 'react';
import MediaResolver from './MediaResolver';
import { decodeMermaidBase64 } from '../../lib/mermaid-utils';

export default function MermaidResolver({ html }: { html: string }) {
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    let cancelled = false;
    const placeholders = Array.from(root.querySelectorAll<HTMLElement>('[data-mermaid]'));
    if (!placeholders.length) return undefined;
    void import('mermaid').then(async ({ default: mermaid }) => {
      if (cancelled) return;
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral' });
      for (const placeholder of placeholders) {
        const encoded = placeholder.dataset.mermaid;
        if (!encoded || cancelled || !placeholder.isConnected) continue;
        try {
          const source = decodeMermaidBase64(encoded);
          const id = `mermaid-${Math.random().toString(36).slice(2)}`;
          const result = await mermaid.render(id, source);
          if (!cancelled && placeholder.isConnected) {
            const wrapper = document.createElement('div');
            wrapper.className = 'mermaid-rendered';
            wrapper.innerHTML = result.svg;
            placeholder.replaceWith(wrapper);
          }
        } catch {
          if (!cancelled && placeholder.isConnected) {
            placeholder.classList.add('mermaid-error');
            placeholder.setAttribute('role', 'status');
            placeholder.insertAdjacentText('afterbegin', '图表暂时无法渲染：');
          }
        }
      }
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [html]);

  return <div ref={rootRef}><MediaResolver html={html} /></div>;
}
