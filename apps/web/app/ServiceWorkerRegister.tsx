'use client';
import { useEffect } from 'react';
export default function ServiceWorkerRegister() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    void navigator.serviceWorker.register('/sw.js').then(registration => registration.update()).catch(() => undefined);
  }, []);
  return null;
}
