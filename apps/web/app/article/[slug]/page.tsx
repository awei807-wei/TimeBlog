import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getArticle, normalizeArticleIdentifier, type PublicEntry } from '@/lib/api';
import DOMPurify from 'isomorphic-dompurify';
import { decorateMediaReferences, renderMarkdown } from '@/lib/markdown';
import EmbedMarkup from '../EmbedMarkup';
import type { Metadata } from 'next';
import { ArrowLeft } from 'lucide-react';

const siteUrl = () => process.env.SITE_URL || 'http://localhost:3000';

async function loadArticle(slug: string): Promise<PublicEntry | null> {
  try { return await getArticle(slug); } catch { return null; }
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const requestedIdentifier = normalizeArticleIdentifier(slug);
  const article = requestedIdentifier ? await loadArticle(slug) : null;
  if (!requestedIdentifier || !article || article.placeholder) return { title: '文章不存在', robots: { index: false, follow: false } };
  const title = article.title || '无题';
  const description = article.summary || article.markdown?.replace(/\s+/g, ' ').slice(0, 160) || '菜鸟手记文章';
  const canonicalIdentifier = normalizeArticleIdentifier(article.slug || '') || requestedIdentifier;
  const url = `${siteUrl()}/article/${encodeURIComponent(canonicalIdentifier)}`;
  return {
    title,
    description,
    alternates: { canonical: url },
    robots: { index: true, follow: true },
    openGraph: { type: 'article', url, title, description, publishedTime: article.journalDate, modifiedTime: article.updatedAt, section: '菜鸟手记', tags: article.tags },
  };
}

export default async function ArticlePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const requestedIdentifier = normalizeArticleIdentifier(slug);
  if (!requestedIdentifier) notFound();
  const article = await loadArticle(slug);
  if (!article || article.placeholder) notFound();
  const canonicalIdentifier = normalizeArticleIdentifier(article.slug || '') || requestedIdentifier;
  if (canonicalIdentifier !== requestedIdentifier) redirect(`/article/${encodeURIComponent(canonicalIdentifier)}`);
  const structuredData = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: article.title || '无题',
    description: article.summary || undefined,
    datePublished: article.journalDate,
    dateModified: article.updatedAt || article.journalDate,
    mainEntityOfPage: `${siteUrl()}/article/${encodeURIComponent(canonicalIdentifier)}`,
    author: { '@type': 'Person', name: '菜鸟手记作者' },
  };
  return (
    <main id="main-content" className="public-page public-article-shell">
      <Link className="public-reader-back" href="/"><ArrowLeft aria-hidden="true" /> 返回时间线</Link>
      <article className="public-reader">
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData).replace(/</g, '\\u003c') }} />
        <header>
          <div className="public-reader-kicker"><span>ARTICLE</span><time>{article.journalDate}</time></div>
          <h1>{article.title || '无题'}</h1>
          {article.summary && <p>{article.summary}</p>}
          <div className="public-reader-taxonomy"><span>{article.journalTime || '当日随记'}</span>{article.categories?.map(c => <Link href={`/categories/${encodeURIComponent(c.toLowerCase().replace(/\s+/g, '-'))}`} key={c}>{c}</Link>)}{article.tags?.map(t => <Link href={`/tag/${encodeURIComponent(t)}`} key={t}>#{t}</Link>)}</div>
        </header>
        <section className="public-reader-body">{(() => {
          const rendered = article.renderedHtml ? { html: decorateMediaReferences(article.renderedHtml), toc: [] } : renderMarkdown(article.markdown || '');
          const safeHtml = DOMPurify.sanitize(rendered.html, { USE_PROFILES: { html: true }, ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|\/|#):?)/i });
          return <>{rendered.toc.length > 0 && <nav className="article-toc" aria-label="文章目录"><strong>目录</strong><ol>{rendered.toc.map(item => <li key={item.id} className={`toc-level-${item.level}`}><a href={`#${item.id}`}>{item.title}</a></li>)}</ol></nav>}<div className="markdown article-prose public-reader-prose"><EmbedMarkup html={safeHtml} /></div>{article.markdown?.includes('media://') && <p className="status media-note">媒体按权限加载，未授权时会显示不可用提示。</p>}</>;
        })()}</section>
        <footer><Link href={`/day/${article.journalDate}`}>{article.journalDate} 的其他记录</Link><Link href="/">继续浏览时间线</Link></footer>
      </article>
    </main>
  );
}
