export type PreviewMediaEntry = {
  markdown?: string;
  renderedHtml?: string;
};

export function entryHasPreviewMedia(entry: PreviewMediaEntry): boolean;
