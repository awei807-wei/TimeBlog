import type { RefObject } from 'react';

/** The only editor surface business state and persistence code may depend on. */
export type MarkdownEditorHandle = {
  focus: () => void;
  getMarkdown: () => string;
  setMarkdown: (markdown: string) => void;
  insertMarkdown: (markdown: string) => void;
};

export type MarkdownEditorRef = RefObject<MarkdownEditorHandle | null>;
