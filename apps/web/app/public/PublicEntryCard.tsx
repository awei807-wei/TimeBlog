'use client';

import Link from 'next/link';
import { ArrowUpRight, LockKeyhole } from 'lucide-react';
import type { PublicEntry } from '@/lib/api';
import { articleHref, entryExcerpt, primaryCategory } from './public-entry';

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

export default function PublicEntryCard({ entry, showDate = false, compact = false, onTagClick }: Props) {
  if (entry.placeholder) return <article className="public-private-entry"><LockKeyhole aria-hidden="true"/><span>{entry.journalTime ? `${entry.journalTime} · ` : ''}{entry.text || '私人记录'}</span></article>;

  const href = articleHref(entry);
  const excerpt = entryExcerpt(entry, compact ? 120 : 260);
  if (entry.kind !== 'article') {
    const noteStamp = showDate ? [entry.journalDate, entry.journalTime].filter(Boolean).join(' · ') : entry.journalTime || '随记';
    return <article className={`public-entry public-note-entry${compact ? ' is-compact' : ''}`}>
      <div className="public-note-meta"><time>{noteStamp}</time><span>{primaryCategory(entry)}</span></div>
      <div className="public-note-copy"><p>{excerpt || '这条记录没有公开正文。'}</p><TagList entry={entry} onTagClick={onTagClick}/></div>
    </article>;
  }

  return <article className={`public-entry public-article-entry${compact ? ' is-compact' : ''}`}>
    <div className="public-entry-meta"><span className="public-type-pill">长文</span><span>{primaryCategory(entry)}</span>{showDate && <time>{entry.journalDate}</time>}</div>
    <h2>{href ? <Link href={href}>{entry.title || '无题'}</Link> : entry.title || '无题'}</h2>
    {!compact && <p>{excerpt || '这篇文章暂时没有摘要。'}</p>}
    <footer><TagList entry={entry} onTagClick={onTagClick}/>{href && <Link className="public-read-more" href={href}>继续阅读 <ArrowUpRight aria-hidden="true"/></Link>}</footer>
  </article>;
}
