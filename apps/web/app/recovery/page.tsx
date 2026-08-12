import type { Metadata } from 'next';
import RecoveryForm from './RecoveryForm';

export const metadata: Metadata = {
  title: '账户恢复 · 个人时间线',
  robots: { index: false, follow: false, nocache: true },
};

export default function RecoveryPage() {
  return <main id="main-content" className="shell"><RecoveryForm /></main>;
}
