'use client';

import { useEffect, type MutableRefObject } from 'react';
import type { Draft } from './editor-storage';

type DraftFlushOptions = {
  currentDraftId: () => string;
  payload: Record<string, unknown>;
  syncDraft: (draft: Draft, expectedEpoch?: number) => Promise<void>;
  discardingRef: MutableRefObject<boolean>;
  epoch: MutableRefObject<number>;
};

export function useDraftFlush({ currentDraftId, payload, syncDraft, discardingRef, epoch }: DraftFlushOptions) {
  useEffect(() => {
    const flush = () => {
      if (discardingRef.current) return;
      const expectedEpoch = epoch.current;
      const id = currentDraftId();
      if (discardingRef.current || expectedEpoch !== epoch.current) return;
      void syncDraft({
        id,
        clientDraftId: id,
        payload,
        updatedAt: new Date().toISOString(),
      }, expectedEpoch);
    };
    window.addEventListener('blur', flush);
    const interval = window.setInterval(flush, 10_000);
    return () => {
      window.removeEventListener('blur', flush);
      window.clearInterval(interval);
    };
  }, [currentDraftId, discardingRef, epoch, payload, syncDraft]);
}
