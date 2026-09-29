'use client';

import Link from 'next/link';

export default function ColumnsError({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <main id="main-content" className="public-page column-state">
    <div className="public-error" role="alert"><h1>栏目暂时无法加载</h1><p>数据请求未完成，你的内容没有丢失。请重试，或先返回时间线。</p></div>
    <div className="column-state-actions"><button className="public-secondary-button" type="button" onClick={retry}>重新加载</button><Link href="/">返回时间线 →</Link></div>
  </main>;
}
