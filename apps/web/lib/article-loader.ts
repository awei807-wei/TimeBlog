import { APIError, getArticle, normalizeArticleIdentifier, type PublicEntry } from './api';

export const ARTICLE_TIMEOUT_MS = 10_000;

export type ArticleLoadResult =
  | { status: 'ready'; article: PublicEntry }
  | { status: 'not-found' | 'timeout' | 'failed' };

export async function loadArticle(slug: string): Promise<ArticleLoadResult> {
  if (!normalizeArticleIdentifier(slug)) return { status: 'not-found' };

  // Pass the original slug so getArticle still decodes exactly one URI layer.
  // The signal remains active through getArticle's response.json() read.
  const signal = AbortSignal.timeout(ARTICLE_TIMEOUT_MS);
  try {
    const article = await getArticle(slug, signal);
    return article.placeholder ? { status: 'not-found' } : { status: 'ready', article };
  } catch (error) {
    if (signal.aborted || (error instanceof Error && error.name === 'TimeoutError')) {
      return { status: 'timeout' };
    }
    if (error instanceof APIError && (error.status === 404 || error.status === 410)) {
      return { status: 'not-found' };
    }
    return { status: 'failed' };
  }
}
