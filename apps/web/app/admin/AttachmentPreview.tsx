'use client';

import { renderMarkdown } from '@/lib/markdown';
import MediaResolver from '@/app/article/MediaResolver';
import { mediaMarkdownReference, type UploadItem } from '@/lib/media-utils';

export default function AttachmentPreview({ markdown, uploads }: { markdown: string; uploads: UploadItem[] }) {
  const metadataByID = new Map(uploads.map(item => [item.mediaId || item.id, item]));
  const references = uploads
    .filter(item => !/^image\//i.test(item.mime))
    .map(item => {
      const mediaID = item.mediaId || item.id;
      const position = markdown.indexOf(`media://${mediaID}`);
      const reference = item.markdownReference || mediaMarkdownReference(mediaID, item.fileName, item.mime);
      return { item, position: position < 0 ? Number.MAX_SAFE_INTEGER : position, reference };
    })
    .filter(value => markdown.includes(`media://${value.item.mediaId || value.item.id}`))
    .sort((left, right) => left.position - right.position)
    .map(value => value.reference)
    .join('\n\n');
  if (!references) return null;
  const rendered = renderMarkdown(references);
  const metadata = Object.fromEntries([...metadataByID.entries()].filter(([id]) => references.includes(`media://${id}`)).map(([id, item]) => [id, { fileName: item.fileName, mime: item.mime, size: item.size, status: item.status }]));
  return <section className="attachment-preview" aria-label="附件预览"><div className="attachment-preview-heading">附件预览</div><MediaResolver html={rendered.html} metadata={metadata} /></section>;
}
