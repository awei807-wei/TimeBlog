import { API } from '@/lib/api';
import { AdminRequestError, responseError } from './admin-errors';
import { dbPut, DRAFT_STORE, type Draft } from './editor-storage';

type PersistEntryOptions = {
  csrf: string;
  refreshSessionCSRF: () => Promise<string>;
  savedDraftID: string;
  editingWorkingID: string;
  payload: Record<string, unknown>;
};

async function submitEntry({ requestCsrf, savedDraftID, editingWorkingID, payload }: PersistEntryOptions & { requestCsrf: string }) {
  const headers = {
    'Content-Type': 'application/json',
    'X-CSRF-Token': requestCsrf,
    'Idempotency-Key': savedDraftID,
  };
  let working: { id: string } | null = editingWorkingID ? { id: editingWorkingID } : null;
  if (!working) {
    const draftResponse = await fetch(`${API}/admin/working-copies`, {
      method: 'POST',
      credentials: 'include',
      headers,
      body: JSON.stringify({ clientDraftId: savedDraftID, payload }),
    });
    if (!draftResponse.ok) throw await responseError(draftResponse, '保存工作草稿失败');
    working = await draftResponse.json() as { id: string };
  }
  const commitResponse = await fetch(`${API}/admin/working-copies/${working.id}/commit`, {
    method: 'POST',
    credentials: 'include',
    headers,
    body: JSON.stringify(payload),
  });
  if (!commitResponse.ok) throw await responseError(commitResponse, '提交内容失败');
  return commitResponse.json();
}

export async function persistAdminEntry(options: PersistEntryOptions) {
  const draft: Draft = {
    id: options.savedDraftID,
    clientDraftId: options.savedDraftID,
    payload: options.payload,
    updatedAt: new Date().toISOString(),
  };
  await dbPut(DRAFT_STORE, draft);
  try {
    return await submitEntry({ ...options, requestCsrf: options.csrf });
  } catch (error) {
    if (!(error instanceof AdminRequestError) || (error.status !== 401 && error.status !== 403)) throw error;
    return submitEntry({ ...options, requestCsrf: await options.refreshSessionCSRF() });
  }
}
