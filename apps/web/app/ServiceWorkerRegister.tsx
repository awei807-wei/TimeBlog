'use client';

import { useEffect } from 'react';
import { initializeServiceWorker } from '../lib/service-worker-registration';

/** 渲染完成后初始化离线能力，开发模式不安装缓存 worker。 */
export default function ServiceWorkerRegister() {
  useEffect(() => {
    let active = true;
    void initializeServiceWorker().catch(error => {
      if (active) console.error('离线缓存初始化失败，请刷新页面后重试。', error);
    });
    return () => { active = false; };
  }, []);
  return null;
}
