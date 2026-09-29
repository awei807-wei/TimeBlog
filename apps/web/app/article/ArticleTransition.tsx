'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import { ArrowLeft, BookOpen, CircleAlert, Clock3, RotateCw } from 'lucide-react';
import { ARTICLE_TIMEOUT_MS } from '@/lib/article-loader';

export type ArticleTransitionState = 'loading' | 'timeout' | 'failed';

const messages = {
  loading: { title: '过渡中', description: '正在加载文章，请稍候。内容准备好后会自动显示。', icon: BookOpen },
  timeout: { title: '过渡超时', description: '等待时间有些长，可能是网络较慢。你可以重新加载，或先返回时间线。', icon: Clock3 },
  failed: { title: '过渡失败', description: '暂时无法加载这篇文章，请检查网络后重试。', icon: CircleAlert },
} satisfies Record<ArticleTransitionState, { title: string; description: string; icon: typeof BookOpen }>;

export default function ArticleTransition({ state = 'loading', onRetry }: { state?: ArticleTransitionState; onRetry?: () => void }) {
  const pathname = usePathname();
  // A different article must start a fresh timeout, even if the fallback is reused.
  return <TransitionContent key={pathname} state={state} onRetry={onRetry} />;
}

function TransitionContent({ state, onRetry }: { state: ArticleTransitionState; onRetry?: () => void }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [expired, setExpired] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const waiting = state === 'loading' || isPending;

  useEffect(() => {
    if (!waiting) return;
    const timer = window.setTimeout(() => setExpired(true), ARTICLE_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [waiting, attempt]);

  const currentState = waiting ? (expired ? 'timeout' : 'loading') : state;
  const { title, description, icon: Icon } = messages[currentState];

  function retry() {
    setExpired(false);
    setAttempt(value => value + 1);
    startTransition(() => {
      if (onRetry) onRetry();
      else router.refresh();
    });
  }

  return <main id="main-content" className="public-page public-article-shell">
    <Link className="public-reader-back" href="/"><ArrowLeft aria-hidden="true" /> 返回时间线</Link>
    <section className="public-reader article-transition" data-state={currentState} aria-labelledby="article-transition-title">
      <div className="article-transition-message" role={currentState === 'failed' ? 'alert' : 'status'} aria-live={currentState === 'failed' ? 'assertive' : 'polite'} aria-atomic="true">
        <span className="article-transition-icon"><Icon aria-hidden="true" /></span>
        <span className="article-transition-kicker">ARTICLE · 阅读文章</span>
        <h1 id="article-transition-title">{title}</h1>
        <p>{description}</p>
      </div>
      <div className="article-transition-skeleton" aria-hidden="true"><span /><span /><span /></div>
      <div className="article-transition-actions">
        {currentState === 'loading' ? <span className="article-transition-hint"><span aria-hidden="true" /> 正在准备阅读内容</span> : <>
          <button type="button" className="article-transition-retry" onClick={retry}><RotateCw aria-hidden="true" />重新加载</button>
          <Link className="public-secondary-button" href="/">返回时间线</Link>
        </>}
      </div>
    </section>
  </main>;
}
