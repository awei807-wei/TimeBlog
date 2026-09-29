'use client';

import { useCallback, type Dispatch, type SetStateAction } from 'react';

type ComposerInteractionsOptions = {
  markdownRef: { current: string };
  setMarkdown: Dispatch<SetStateAction<string>>;
  mediaInputDisabled: boolean;
  handleFiles: (files: FileList | File[]) => void;
};

export function useAdminComposerInteractions({ markdownRef, setMarkdown, mediaInputDisabled, handleFiles }: ComposerInteractionsOptions) {
  const onMarkdownChange = useCallback((next: string) => {
    markdownRef.current = next;
    setMarkdown(next);
  }, [markdownRef, setMarkdown]);
  const onFiles = useCallback((files: File[]) => {
    if (!mediaInputDisabled && files.length) handleFiles(files);
  }, [handleFiles, mediaInputDisabled]);
  return { onMarkdownChange, onFiles };
}
