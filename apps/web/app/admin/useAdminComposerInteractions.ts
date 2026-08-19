'use client';

import { useCallback, type Dispatch, type DragEvent, type SetStateAction } from 'react';

type ComposerInteractionsOptions = {
  markdownRef: { current: string };
  setMarkdown: Dispatch<SetStateAction<string>>;
  setDragActive: Dispatch<SetStateAction<boolean>>;
  mediaInputDisabled: boolean;
  handleFiles: (files: FileList | File[]) => void;
};

export function useAdminComposerInteractions({ markdownRef, setMarkdown, setDragActive, mediaInputDisabled, handleFiles }: ComposerInteractionsOptions) {
  const onMarkdownChange = useCallback((next: string) => {
    markdownRef.current = next;
    setMarkdown(next);
  }, [markdownRef, setMarkdown]);
  const onFiles = useCallback((files: File[]) => {
    if (!mediaInputDisabled) handleFiles(files);
  }, [handleFiles, mediaInputDisabled]);
  const onDragEnter = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragActive(true);
  }, [setDragActive]);
  const onDragOver = onDragEnter;
  const onDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragActive(false);
  }, [setDragActive]);
  const onDrop = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragActive(false);
    if (!mediaInputDisabled) handleFiles(event.dataTransfer.files);
  }, [handleFiles, mediaInputDisabled, setDragActive]);
  return { onMarkdownChange, onFiles, onDragEnter, onDragOver, onDragLeave, onDrop };
}
