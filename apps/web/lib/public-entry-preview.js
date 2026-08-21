const MARKDOWN_IMAGE = /!\[[^\]\r\n]*\]\(\s*(?:<[^>\r\n]+>|[^)\r\n]+)\s*\)/;
const MEDIA_REFERENCE = /media:\/\/[A-Za-z0-9._~-]+/;
const RENDERED_MEDIA = /<(?:img|picture|video|audio)\b|data-media-id\s*=/i;

/**
 * Return whether a public entry contains media hidden by its text-only preview.
 * Legacy bare media references count so older image notes remain expandable.
 */
export function entryHasPreviewMedia(entry) {
  const markdown = String(entry?.markdown || '');
  const renderedHtml = String(entry?.renderedHtml || '');
  return MARKDOWN_IMAGE.test(markdown) || MEDIA_REFERENCE.test(markdown) || RENDERED_MEDIA.test(renderedHtml);
}
