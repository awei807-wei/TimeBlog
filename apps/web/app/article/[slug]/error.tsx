'use client';

import ArticleTransition from '../ArticleTransition';

export default function ArticleError({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <ArticleTransition state="failed" onRetry={retry} />;
}
