import { notFound } from 'next/navigation';
import WritingPreview from './WritingPreview';
import './writing-preview.css';

export const dynamic = 'force-dynamic';
export const metadata = { title: '写作工作台 · 本地预览', robots: { index: false, follow: false } };

/** 只在本地开发时展示真实写作组件，不绕过管理端的认证。 */
export default function WritingPreviewPage() {
  if (process.env.NODE_ENV !== 'development') notFound();
  return <WritingPreview />;
}
