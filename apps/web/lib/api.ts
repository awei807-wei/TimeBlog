export type PublicEntry = {
  id?: string;
  kind?: 'note' | 'article';
  visibility: 'public' | 'private';
  title?: string;
  slug?: string;
  summary?: string;
  markdown?: string;
  renderedHtml?: string;
  journalDate: string;
  journalTime?: string | null;
  timePrecision?: 'day' | 'minute';
  placeholder?: boolean;
  text?: string;
  categories?: string[];
  tags?: string[];
  updatedAt?: string;
};

export type TimelineDay = { date: string; untimed: PublicEntry[]; timed: PublicEntry[] };
export type CalendarResponse = { month: string; days: Record<string, number> };
export type SearchResponse = { query: string; entries: PublicEntry[]; nextCursor?: string };
export type AdminEntry = Omit<PublicEntry, 'id' | 'visibility'> & { id: string; status: 'draft' | 'published' | 'trashed'; visibility: 'public' | 'private'; updatedAt: string };
export type Version = { version: number; createdAt: string; snapshot: Record<string, unknown> };
export type Media = { id: string; originalName: string; mimeType: string; sizeBytes: number; visibility: 'public' | 'private'; status: 'uploading' | 'ready' | 'failed' | 'deleting' | 'deleted'; provider?: 'local_private' | 'custom_public'; providerKey?: string; publicUrl?: string; externalPublishStatus?: 'not_requested' | 'pending' | 'publishing' | 'published' | 'failed' | 'trash_pending'; externalPublishError?: string; createdAt?: string };
export type ExportJob = { id: string; type: 'public' | 'full'; status: 'queued' | 'running' | 'ready' | 'failed'; downloadUrl?: string; sha256?: string };
export type SiteSettings = { siteTitle?: string; siteDescription?: string; timezone?: string; defaultVisibility?: 'public' | 'private'; feedEnabled?: boolean; theme?: string };
export type ExternalImageHostConfig = {
  provider: 'custom_public'; enabled: boolean; endpoint: string; workspaceId?: string; stablePublicUrls: boolean; syncDeletes: boolean; tokenConfigured: boolean; tokenMasked: '' | '********';
  protocolStatus: 'ou_image_hosting_v1'; verified: boolean; publishEnabled: boolean; status: string; statusMessage?: string; lastTestedAt?: string | null; updatedAt?: string;
};
export type NASBackupConfig = {
  enabled: boolean; sourceHost: string; sourcePath: string; destinationPath: string; retentionDays: number;
  applyStatus: 'pending_export'; status: string; statusMessage?: string; lastTestedAt?: string | null; updatedAt?: string;
};
export type RuntimeStatus = {
  updatedAt: string;
  media: { provider: 'local_private'; writable: boolean; imageUploadEnabled: boolean; nonImageUploadEnabled: boolean; maxUploadBytes: number };
  externalImageHost: { provider: 'custom_public'; configured: boolean; enabled: boolean; protocolStatus: 'ou_image_hosting_v1'; probeStatus?: string; publishEnabled?: boolean; status: string };
  security: Record<string, { configured: boolean; managedBy: string }>;
  nasBackup: { configured: boolean; enabled: boolean; applyStatus: string; status: string };
};
export type AdminCalendarDay = { public: number; private: number; draft: number; trashed: number };
export type AdminCalendarResponse = { year: string; includeDrafts: boolean; days: Record<string, AdminCalendarDay> };

// The production proxy and the local Next rewrite both expose the API under
// /api/v1. Keeping this same-origin by default makes cookies and CSRF work in
// the browser; deployments can still override it for a dedicated API host.
export const API = process.env.NEXT_PUBLIC_API_URL || (typeof window === 'undefined' ? `${process.env.API_ORIGIN || 'http://localhost:8080'}/api/v1` : '/api/v1');

/**
 * Normalize an article route identifier before it enters the API URL.
 *
 * Next normally gives dynamic route params back decoded, but callers can also
 * reach this helper with an already escaped value (for example from a
 * persisted link or a browser navigation).  Decode exactly one URI layer so
 * getArticle can encode the real identifier exactly once.  Invalid escape
 * sequences are rejected instead of being forwarded as a different slug.
 */
export function normalizeArticleIdentifier(value: string): string | null {
  const input = value.trim();
  if (!input) return null;
  try {
    const normalized = decodeURIComponent(input).trim();
    return normalized || null;
  } catch {
    return null;
  }
}

async function getJSON<T>(path: string, init?: RequestInit & { next?: { revalidate?: number } }): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { Accept: 'application/json', ...(init?.headers || {}) },
  });
  if (!response.ok) throw new Error(`API ${response.status}`);
  return response.json() as Promise<T>;
}

export async function getTimeline(limit = 20, cursor = ''): Promise<{ days: TimelineDay[]; actualCount: number; nextCursor?: string }> {
  try {
    return await getJSON(`/public/timeline?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { cache: 'no-store' });
  } catch {
    return { days: [], actualCount: 0 };
  }
}

export async function getDay(date: string, signal?: AbortSignal): Promise<{ date: string; untimed: PublicEntry[]; timed: PublicEntry[] }> {
  return getJSON(`/public/days/${encodeURIComponent(date)}`, { cache: 'no-store', signal });
}

export async function getArticle(slug: string): Promise<PublicEntry> {
  const identifier = normalizeArticleIdentifier(slug);
  if (!identifier) throw new Error('Invalid article identifier');
  return getJSON(`/public/articles/${encodeURIComponent(identifier)}`, { cache: 'no-store' });
}

export async function getCalendar(month: string, signal?: AbortSignal): Promise<CalendarResponse> {
  return getJSON(`/public/calendar?month=${encodeURIComponent(month)}`, { cache: 'no-store', signal });
}

export async function getCategories(): Promise<{ categories: Record<string, number> }> {
  return getJSON('/public/categories', { cache: 'no-store' });
}

export async function getTag(tag: string, cursor = ''): Promise<{ tag: string; entries: PublicEntry[]; nextCursor?: string }> {
  const data = await getJSON<{ entries: PublicEntry[]; nextCursor?: string }>(`/public/tags/${encodeURIComponent(tag)}/entries${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, { cache: 'no-store' });
  return { tag, entries: data.entries, nextCursor: data.nextCursor };
}

export async function getCategory(slug: string, cursor = ''): Promise<{ entries: PublicEntry[]; nextCursor?: string }> {
  return getJSON(`/public/categories/${encodeURIComponent(slug)}/entries${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, { cache: 'no-store' });
}

export async function searchPublic(query: string, cursor = ''): Promise<SearchResponse> {
  return getJSON(`/public/search?q=${encodeURIComponent(query)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { cache: 'no-store' });
}

export async function getAdminEntries(status = ''): Promise<{ entries: AdminEntry[]; nextCursor?: string }> {
  return getJSON(`/admin/entries${status ? `?status=${encodeURIComponent(status)}` : ''}`);
}

export async function getVersions(id: string): Promise<{ versions: Version[] }> {
  return getJSON(`/admin/entries/${encodeURIComponent(id)}/versions`);
}

export async function getMedia(cursor = ''): Promise<{ media: Media[]; nextCursor?: string }> {
  return getJSON(`/admin/media${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
}

export async function getExports(): Promise<{ exports: ExportJob[] }> {
  return getJSON('/admin/exports');
}

export async function getSettings(): Promise<SiteSettings> {
  return getJSON('/admin/settings', { cache: 'no-store' });
}

export async function getRuntimeStatus(): Promise<RuntimeStatus> {
  return getJSON('/admin/runtime-status', { cache: 'no-store' });
}

export async function getExternalImageHostConfig(): Promise<ExternalImageHostConfig> {
  return getJSON('/admin/integrations/external_image_host', { cache: 'no-store' });
}

export async function getNASBackupConfig(): Promise<NASBackupConfig> {
  return getJSON('/admin/integrations/nas_backup', { cache: 'no-store' });
}

export async function getAdminCalendar(year: string, includeDrafts = false): Promise<AdminCalendarResponse> {
  const query = new URLSearchParams({ year, includeDrafts: String(includeDrafts) });
  return getJSON(`/admin/calendar?${query.toString()}`);
}
