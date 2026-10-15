'use client';

import { useEffect, useRef } from 'react';
import DOMPurify from 'isomorphic-dompurify';
import MediaResolver from './MediaResolver';
import { decodeLatexBase64 } from '../../lib/latex-utils';

export default function LatexResolver({ html }: { html: string }) {
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    let cancelled = false;
    const placeholders = Array.from(root.querySelectorAll<HTMLElement>('[data-latex]'));
    if (!placeholders.length) return undefined;

    void import('katex').then(({ default: katex }) => {
      if (cancelled) return;
      for (const placeholder of placeholders) {
        const encoded = placeholder.dataset.latex;
        const isDisplay = placeholder.dataset.display === 'true';
        if (!encoded || cancelled || !placeholder.isConnected) continue;
        try {
          const source = decodeLatexBase64(encoded);
          const renderedMath = katex.renderToString(source, {
            displayMode: isDisplay,
            throwOnError: false,
            output: 'htmlAndMathml',
          });
          if (!cancelled && placeholder.isConnected) {
            const wrapper = document.createElement(isDisplay ? 'div' : 'span');
            wrapper.className = isDisplay ? 'latex-rendered latex-display' : 'latex-rendered latex-inline';
            const safeHtml = DOMPurify.sanitize(renderedMath, {
              USE_PROFILES: { html: true, mathMl: true, svg: true },
              ADD_TAGS: ['semantics', 'annotation'],
              ADD_ATTR: ['encoding'],
            });
            wrapper.innerHTML = safeHtml;
            placeholder.replaceWith(wrapper);
          }
        } catch {
          if (!cancelled && placeholder.isConnected) {
            placeholder.classList.add('latex-error');
            placeholder.setAttribute('role', 'status');
          }
        }
      }
    }).catch(() => undefined);

    return () => { cancelled = true; };
  }, [html]);

  return <div ref={rootRef}><MediaResolver html={html} /></div>;
}