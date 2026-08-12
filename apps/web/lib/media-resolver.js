export function mediaContentUrl(mediaId, apiBase = '/api/v1') {
  const base = apiBase.replace(/\/$/, '');
  return `${base}/media/${encodeURIComponent(mediaId)}/content`;
}

export function mediaKind(mimeType = '') {
  const mime = mimeType.toLowerCase().split(';', 1)[0].trim();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  if (mime === 'application/pdf') return 'pdf';
  return 'file';
}

export async function probeMediaContentType(url, fetcher = globalThis.fetch) {
  let response = await fetcher(url, { method: 'HEAD', credentials: 'include', cache: 'force-cache' });
  if (response.status === 405 || response.status === 501) {
    response = await fetcher(url, { credentials: 'include', headers: { Range: 'bytes=0-0' }, cache: 'force-cache' });
    response.body?.cancel();
  }
  if (!response.ok) throw new Error(`media ${response.status}`);
  return response.headers.get('content-type') || '';
}
