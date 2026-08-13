export const MAX_MEDIA_BYTES = 200 * 1024 * 1024;
// Keep resumable blobs in IndexedDB only while they fit a conservative quota;
// larger files remain metadata-only so browser storage cannot crowd out drafts.
export const MEDIA_BLOB_MAX_BYTES = 25 * 1024 * 1024;
export const MEDIA_QUEUE_MAX_BYTES = 64 * 1024 * 1024;

/** @typedef {{id: string; fileName: string; mime: string; size: number; status: 'queued'|'uploading'|'ready'|'failed'; mediaId?: string; error?: string}} UploadItem */

export function isSupportedMedia(file, maxBytes = MAX_MEDIA_BYTES) {
  return (/^(image|video|audio)\//i.test(file.type) || file.type.toLowerCase() === 'application/pdf') && file.size <= maxBytes;
}

export function createUploadItem(file, id = crypto.randomUUID()) {
  return { id, fileName: file.name, mime: file.type, size: file.size, status: 'queued', progress: 0 };
}

export function mediaQueueStoragePlan(fileSize, persistedBytes, options = {}) {
  const perFileMaxBytes = options.perFileMaxBytes || MEDIA_BLOB_MAX_BYTES;
  const totalMaxBytes = options.totalMaxBytes || MEDIA_QUEUE_MAX_BYTES;
  const persistBlob = Number.isFinite(fileSize) && fileSize >= 0 && fileSize <= perFileMaxBytes && persistedBytes + fileSize <= totalMaxBytes;
  return { persistBlob, reason: persistBlob ? '' : fileSize > perFileMaxBytes ? 'file-too-large' : 'queue-quota' };
}

export function mediaMarkdown(mediaId) {
  return `media://${mediaId}`;
}

function markdownLabel(value, fallback = '媒体附件') {
  const label = String(value || '').trim().replace(/[\[\]\\()_*`#!<>\r\n]/g, ' ').replace(/\s+/g, ' ').trim();
  return label || fallback;
}

/**
 * Return the canonical Markdown reference used by the editor for an upload.
 * Markdown remains the source of truth while the media resolver owns the
 * authenticated `media://` URL lookup at render time.
 */
export function mediaMarkdownReference(mediaId, fileName = '', mime = '') {
  const label = markdownLabel(fileName, mediaId);
  return /^image\//i.test(String(mime || ''))
    ? `![${label}](media://${mediaId})`
    : `[${label}](media://${mediaId})`;
}

/** Remove both canonical Markdown references and legacy bare media tokens. */
export function removeMediaReferences(markdown, mediaId) {
  const escaped = String(mediaId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return String(markdown)
    .replace(new RegExp(`!\\[[^\\]]*\\]\\(media://${escaped}\\)`, 'g'), '')
    .replace(new RegExp(`\\[[^\\]]*\\]\\(media://${escaped}\\)`, 'g'), '')
    .replace(new RegExp(`media://${escaped}(?![A-Za-z0-9._~-])`, 'g'), '');
}

export function replaceMediaToken(markdown, oldToken, newToken) {
  return markdown.split(oldToken).join(newToken);
}

/** Replace only the first exact reference occurrence. */
export function replaceMediaOccurrence(markdown, oldReference, newReference) {
  const source = String(markdown);
  const index = source.indexOf(oldReference);
  if (index < 0) return source;
  return `${source.slice(0, index)}${newReference}${source.slice(index + oldReference.length)}`;
}

export function mediaUploadUrl(value, origin = '') {
  return /^https?:\/\//i.test(value) ? value : `${origin}${value}`;
}

/**
 * Upload a Blob/File through the backend's Tus-compatible HEAD/PATCH contract.
 * A dropped connection is reconciled with HEAD before retrying so a chunk that
 * was committed server-side is never appended twice.
 *
 * @param {string} uploadUrl
 * @param {Blob} file
 * @param {{fetcher?: typeof fetch; csrfToken?: string; idempotencyKey?: string; chunkSize?: number; maxRetries?: number}} [options]
 * @returns {Promise<number>}
 */
export async function uploadResumable(uploadUrl, file, options = {}) {
  const fetcher = options.fetcher || fetch;
  const csrfToken = options.csrfToken || '';
  const idempotencyKey = options.idempotencyKey || '';
  const chunkSize = options.chunkSize || 5 * 1024 * 1024;
  const maxRetries = options.maxRetries ?? 4;
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  const signal = options.signal;
  const commonHeaders = {
    'Tus-Resumable': '1.0.0',
    ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
    ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
  };

  const readOffset = async () => {
    const response = await fetcher(uploadUrl, { method: 'HEAD', credentials: 'include', headers: commonHeaders, ...(signal ? { signal } : {}) });
    if (!response.ok && response.status !== 204) throw new Error(`upload HEAD ${response.status}`);
    const raw = response.headers.get('Upload-Offset') || '0';
    const offset = Number(raw);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > file.size) throw new Error('invalid upload offset');
    return offset;
  };

  const pause = (attempt) => new Promise(resolve => setTimeout(resolve, Math.min(2000, 250 * (2 ** attempt))));
  let offset = await readOffset();
  onProgress(file.size ? offset / file.size : 0);
  while (offset < file.size) {
    const start = offset;
    const end = Math.min(start + chunkSize, file.size);
    let attempt = 0;
    while (true) {
      try {
        const response = await fetcher(uploadUrl, {
          method: 'PATCH',
          credentials: 'include',
          headers: { ...commonHeaders, 'Upload-Offset': String(start), 'Content-Type': 'application/offset+octet-stream' },
          body: file.slice(start, end),
          ...(signal ? { signal } : {}),
        });
        if (response.ok) {
          const next = Number(response.headers.get('Upload-Offset') || '');
          if (!Number.isSafeInteger(next) || next < end || next > file.size) throw new Error('invalid upload response offset');
          offset = next;
          onProgress(file.size ? offset / file.size : 1);
          break;
        }
        if (response.status !== 409 && response.status < 500 && response.status !== 408) throw new Error(`upload PATCH ${response.status}`);
        offset = await readOffset();
        break;
      } catch (error) {
        if (attempt >= maxRetries) throw error;
        await pause(attempt++);
        offset = await readOffset();
        if (offset !== start) break;
      }
    }
  }
  return offset;
}
