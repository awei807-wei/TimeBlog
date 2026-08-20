'use client';

import Link from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';
import { ArrowUpRight, ChevronDown, ChevronUp, LockKeyhole } from 'lucide-react';
import type { PublicEntry } from '@/lib/api';
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

function NoteCopy({ entry, compact }: { entry: PublicEntry; compact: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [measured, setMeasured] = useState(false);
  const [canExpand, setCanExpand] = useState(false);
  const copyRef = useRef<HTMLParagraphElement>(null);
  const copyId = `public-note-${useId()}`;
  const noteText = entryFullText(entry) || '这条记录没有公开正文。';

  useEffect(() => {
    const node = copyRef.current;
    if (!node) return;

    let active = true;
    const measure = () => {
      node.classList.add('is-measuring-full');
      const fullHeight = node.getBoundingClientRect().height;
      node.classList.remove('is-measuring-full');
      node.classList.add('is-measuring-collapsed');
      const collapsedHeight = node.getBoundingClientRect().height;
      node.classList.remove('is-measuring-collapsed');
      const overflowing = fullHeight > collapsedHeight + 1;
      if (!active) return;
      setMeasured(true);
      setCanExpand(overflowing);
      if (!overflowing && expanded) setExpanded(false);
    };

    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(node);
    window.addEventListener('resize', measure);
    return () => {
      active = false;
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [compact, expanded, noteText]);

  return <>
    <p ref={copyRef} id={copyId} className={`public-note-text${measured ? ' is-measured' : ''}${expanded ? ' is-expanded' : ' is-collapsed'}`}>{noteText}</p>
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
