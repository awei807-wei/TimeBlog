'use client';

import Link from 'next/link';
import DOMPurify from 'isomorphic-dompurify';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowUpRight, ChevronDown, ChevronUp, LockKeyhole } from 'lucide-react';
import EmbedMarkup from '@/app/article/EmbedMarkup';
import type { PublicEntry } from '@/lib/api';
import { decorateMediaReferences, renderMarkdown } from '@/lib/markdown';
import { entryHasPreviewMedia } from '@/lib/public-entry-preview';
import { articleHref, entryExcerpt, entryFullText, primaryCategory } from './public-entry';

type Props = {
  entry: PublicEntry;
  showDate?: boolean;
  compact?: boolean;
  onTagClick?: (tag: string) => void;
};

function TagList({ entry, onTagClick }: Pick<Props, 'entry' | 'onTagClick'>) {
  if (!entry.tags?.length) return null;
  return <div className="public-entry-tags">{entry.tags.map(tag => onTagClick
    ? <button type="button" key={tag} onClick={() => onTagClick(tag)}>#{tag}</button>
    : <Link href={`/tag/${encodeURIComponent(tag)}`} key={tag}>#{tag}</Link>)}</div>;
}

function NoteFullPreview({ entry }: { entry: PublicEntry }) {
  const safeHtml = useMemo(() => {
    const rendered = entry.renderedHtml
      ? decorateMediaReferences(entry.renderedHtml)
      : renderMarkdown(entry.markdown || entry.text || entry.summary || '这条记录没有公开正文。').html;
    return DOMPurify.sanitize(rendered, {
      USE_PROFILES: { html: true },
      ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|\/|#):?)/i,
    });
  }, [entry.markdown, entry.renderedHtml, entry.summary, entry.text]);

  return <div className="public-note-full markdown article-prose"><EmbedMarkup html={safeHtml}/></div>;
}

function NoteCopy({ entry, compact }: { entry: PublicEntry; compact: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [measured, setMeasured] = useState(false);
  const [textOverflows, setTextOverflows] = useState(false);
  const copyRef = useRef<HTMLParagraphElement>(null);
  const copyId = `public-note-${useId()}`;
  const noteText = entryFullText(entry) || '这条记录没有公开正文。';
  const hasPreviewMedia = entryHasPreviewMedia(entry);

  useEffect(() => {
    const node = copyRef.current;
    const parent = node?.parentElement;
    if (!node || !parent) return;

    let cancelled = false;
    const measure = () => {
      if (cancelled) return;
      const width = node.getBoundingClientRect().width;
      if (!width) return;

      const computed = window.getComputedStyle(node);
      const lineHeight = Number.parseFloat(computed.lineHeight);
      const fontSize = Number.parseFloat(computed.fontSize);
      const resolvedLineHeight = Number.isFinite(lineHeight)
        ? lineHeight
        : (Number.isFinite(fontSize) ? fontSize * 1.5 : 24);
      const clampLines = compact ? 1 : 3;
      const measurement = node.cloneNode(false) as HTMLParagraphElement;
      measurement.removeAttribute('id');
      measurement.className = 'public-note-measurement is-measuring-full';
      measurement.textContent = noteText;
      Object.assign(measurement.style, {
        position: 'absolute',
        top: '0',
        left: '0',
        width: `${width}px`,
        height: 'auto',
        maxHeight: 'none',
        display: 'block',
        overflow: 'visible',
        visibility: 'hidden',
        pointerEvents: 'none',
        webkitLineClamp: 'unset',
        webkitBoxOrient: 'initial',
      });

      parent.appendChild(measurement);
      let fullHeight = 0;
      let collapsedHeight = 0;
      try {
        // Measure a natural-height clone first. This intentionally avoids using
        // scrollHeight from a line-clamped element, which differs across browsers.
        fullHeight = measurement.getBoundingClientRect().height;
        measurement.classList.replace('is-measuring-full', 'is-measuring-collapsed');
        measurement.style.maxHeight = `${resolvedLineHeight * clampLines}px`;
        measurement.style.overflow = 'hidden';
        collapsedHeight = measurement.getBoundingClientRect().height;
      } finally {
        measurement.remove();
      }

      const overflowing = fullHeight > collapsedHeight + 0.5;
      if (cancelled) return;
      setMeasured(true);
      setTextOverflows(overflowing);
      if (!overflowing && !hasPreviewMedia && expanded) setExpanded(false);
    };

    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(node);
    window.addEventListener('resize', measure);
    if (typeof document !== 'undefined' && document.fonts) {
      document.fonts.ready.then(() => {
        if (!cancelled) measure();
      });
    }
    return () => {
      cancelled = true;
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [compact, expanded, hasPreviewMedia, noteText]);

  // Keep the collapse control available if this entry changes while open
  // (for example after a same-ID timeline refresh removes its media).
  const canExpand = expanded || textOverflows || hasPreviewMedia;
  const copyIsExpandable = canExpand && !expanded;
  const expandFromCopy = () => {
    if (copyIsExpandable) setExpanded(true);
  };
  const handleCopyKeyDown = (event: KeyboardEvent<HTMLParagraphElement>) => {
    if (!copyIsExpandable || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    expandFromCopy();
  };

  return <>
    <div id={copyId} className="public-note-body">
      {expanded ? <NoteFullPreview entry={entry}/> : <p
        ref={copyRef}
        className={`public-note-text${measured ? ' is-measured' : ''} is-collapsed${copyIsExpandable ? ' is-expandable' : ''}`}
        role={copyIsExpandable ? 'button' : undefined}
        tabIndex={copyIsExpandable ? 0 : undefined}
        aria-label={copyIsExpandable ? '展开随手记' : undefined}
        aria-expanded={copyIsExpandable ? false : undefined}
        onClick={copyIsExpandable ? expandFromCopy : undefined}
        onKeyDown={copyIsExpandable ? handleCopyKeyDown : undefined}
      >{noteText}</p>}
    </div>
    {canExpand && <button
      type="button"
      className="public-note-expand"
      aria-expanded={expanded}
      aria-controls={copyId}
      aria-label={expanded ? '收起随手记' : '展开随手记'}
      onClick={() => setExpanded(value => !value)}
    >
      {expanded ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
      <span>{expanded ? '收起' : '展开'}</span>
    </button>}
  </>;
}

export default function PublicEntryCard({ entry, showDate = false, compact = false, onTagClick }: Props) {
  if (entry.placeholder) return <article className="public-private-entry"><LockKeyhole aria-hidden="true"/><span>{entry.journalTime ? `${entry.journalTime} · ` : ''}{entry.text || '私人记录'}</span></article>;

  const href = articleHref(entry);
  const excerpt = entryExcerpt(entry, compact ? 120 : 260);
  if (entry.kind !== 'article') {
    const noteStamp = showDate ? [entry.journalDate, entry.journalTime].filter(Boolean).join(' · ') : entry.journalTime || '随记';
    return <article className={`public-entry public-note-entry${compact ? ' is-compact' : ''}`}>
      <div className="public-note-meta"><time>{noteStamp}</time><span>{primaryCategory(entry)}</span></div>
      <div className="public-note-copy"><NoteCopy entry={entry} compact={compact}/><TagList entry={entry} onTagClick={onTagClick}/></div>
    </article>;
  }

  return <article className={`public-entry public-article-entry${compact ? ' is-compact' : ''}`}>
    <div className="public-entry-meta"><span className="public-type-pill">长文</span><span>{primaryCategory(entry)}</span>{showDate && <time>{entry.journalDate}</time>}</div>
    <h2>{href ? <Link href={href}>{entry.title || '无题'}</Link> : entry.title || '无题'}</h2>
    {!compact && <p>{excerpt || '这篇文章暂时没有摘要。'}</p>}
    <footer><TagList entry={entry} onTagClick={onTagClick}/>{href && <Link className="public-read-more" href={href}>继续阅读 <ArrowUpRight aria-hidden="true"/></Link>}</footer>
  </article>;
}
