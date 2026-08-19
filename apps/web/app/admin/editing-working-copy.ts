import { deserializeEditorStatus } from '@/lib/editor-utils';
import { AdminRequestError, responseError } from './admin-errors';
import { readJournalTimeField, type JournalTimeValue } from './journal-time-payload';

export type WorkingCopyResponse = {
  id: string;
  entryId: string;
  baseRevision: number;
  clientDraftId: string;
  payload: Record<string, unknown>;
  resumed?: boolean;
  hasUnpublishedChanges?: boolean;
  publishedRevision?: number;
  publishedUpdatedAt?: string;
  publishedStatus?: string;
  publishedVisibility?: string;
  publishedSlug?: string;
};

export type WorkingCopyMeta = {
  resumed: boolean;
  hasUnpublishedChanges: boolean;
  publishedRevision: number;
  publishedUpdatedAt: string;
  publishedStatus: string;
  publishedVisibility: string;
  publishedSlug: string;
};

export type EditorStatusValue = 'draft' | 'public' | 'private';
export type WorkingCopyEditorSetters = {
  setEntryID: (value: string) => void;
  setWorkingID: (value: string) => void;
  setDraftId: (value: string) => void;
  setTitle: (value: string) => void;
  setSummary: (value: string) => void;
  setSlug: (value: string) => void;
  setCategories: (value: string[]) => void;
  setTags: (value: string[]) => void;
  setStatus: (value: EditorStatusValue) => void;
  setKind: (value: string) => void;
  setDate: (value: string) => void;
  setJournalTime: (value: JournalTimeValue) => void;
  setMeta: (value: WorkingCopyMeta) => void;
  setMessage: (value: string) => void;
};

export const EMPTY_WORKING_COPY_META: WorkingCopyMeta = {
  resumed: false,
  hasUnpublishedChanges: false,
  publishedRevision: 0,
  publishedUpdatedAt: '',
  publishedStatus: '',
  publishedVisibility: '',
  publishedSlug: '',
};

export function workingCopyMetaFromResponse(working: WorkingCopyResponse): WorkingCopyMeta {
  return {
    resumed: working.resumed === true,
    hasUnpublishedChanges: working.hasUnpublishedChanges === true,
    publishedRevision: Number(working.publishedRevision || 0),
    publishedUpdatedAt: String(working.publishedUpdatedAt || ''),
    publishedStatus: String(working.publishedStatus || ''),
    publishedVisibility: String(working.publishedVisibility || ''),
    publishedSlug: String(working.publishedSlug || ''),
  };
}

export function readTaxonomy(value: unknown, separator: RegExp, stripHash = false) {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(separator) : [];
  const seen = new Set<string>();
  return raw.map(item => String(item).trim()).map(item => stripHash ? item.replace(/^#+/, '').trim() : item).filter(item => {
    if (!item) return false;
    const key = item.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function deserializeWorkingCopyStatus(value: Record<string, unknown>) {
  return deserializeEditorStatus({ status: String(value.status || ''), visibility: String(value.visibility || '') });
}

export function applyWorkingCopyFields(working: WorkingCopyResponse, fallbackEntryID: string, notice: string, setters: WorkingCopyEditorSetters) {
  const value = working.payload || {};
  setters.setEntryID(working.entryId || fallbackEntryID);
  setters.setWorkingID(working.id);
  setters.setDraftId(working.clientDraftId);
  setters.setTitle(String(value.title || '')); setters.setSummary(String(value.summary || '')); setters.setSlug(String(value.slug || ''));
  setters.setCategories(readTaxonomy(value.categories, /,/)); setters.setTags(readTaxonomy(value.tags, /[,\s]+/, true)); setters.setStatus(deserializeWorkingCopyStatus(value)); setters.setKind(String(value.kind || 'note')); setters.setDate(String(value.journalDate || ''));
  setters.setJournalTime(readJournalTimeField(value));
  setters.setMeta(workingCopyMetaFromResponse(working)); setters.setMessage(notice);
}

export async function discardWorkingCopy({ api, entryID, csrf, refreshCSRF }: { api: string; entryID: string; csrf: string; refreshCSRF: () => Promise<string> }) {
  const request = async (requestCsrf: string) => {
    const response = await fetch(`${api}/admin/entries/${encodeURIComponent(entryID)}/edit?discard=1`, { method: 'POST', credentials: 'include', headers: { 'X-CSRF-Token': requestCsrf, 'Idempotency-Key': `discard-edit-${entryID}-${Date.now()}` } });
    if (!response.ok) throw await responseError(response, '恢复公开版本失败');
    return response.json() as Promise<WorkingCopyResponse>;
  };
  try {
    return await request(csrf);
  } catch (error) {
    if (!(error instanceof AdminRequestError) || (error.status !== 401 && error.status !== 403)) throw error;
    return request(await refreshCSRF());
  }
}
