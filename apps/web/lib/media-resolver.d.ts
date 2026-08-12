export type ResolvedMediaKind = 'image' | 'audio' | 'video' | 'pdf' | 'file';
export function mediaContentUrl(mediaId: string, apiBase?: string): string;
export function mediaKind(mimeType?: string): ResolvedMediaKind;
export function probeMediaContentType(url: string, fetcher?: typeof fetch): Promise<string>;
