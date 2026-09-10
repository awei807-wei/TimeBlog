import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

async function read(path) {
  return fs.readFile(new URL(path, import.meta.url), 'utf8');
}

test('quick writing uses an explicit null edit target and does not inherit home query state', async () => {
  const controller = await read('../app/admin/useAdminPageController.ts');
  const dialog = await read('../app/admin/QuickWriteDialog.tsx');
  const infrastructure = await read('../app/admin/useAdminEditorInfrastructure.ts');
  const working = await read('../app/admin/useAdminWorkingCopy.ts');
  const metadata = await read('../app/admin/useWorkingCopyMetadata.ts');
  const loader = await read('../app/admin/useEditWorkingCopyLoader.ts');

  assert.match(controller, /editEntryID\?: string \| null/);
  assert.match(dialog, /useAdminPageController\(\{ editEntryID: null, active: open \}\)/);
  assert.match(infrastructure, /editEntryID/);
  assert.match(working, /editEntryID/);
  assert.match(metadata, /editEntryID/);
  assert.match(loader, /editEntryID\?: string \| null/);
  assert.match(loader, /editEntryID === undefined/);
  assert.match(loader, /editEntryID\?\.trim\(\) \|\| ''/);
  assert.match(loader, /if \(!requestedEditID \|\| !csrf/);
});

test('draft persistence exposes immediate persistence and validates IndexedDB writes', async () => {
  const autosave = await read('../app/admin/useDraftAutosave.ts');
  const persistence = await read('../app/admin/useDraftPersistence.ts');
  const flush = await read('../app/admin/useDraftFlush.ts');
  const working = await read('../app/admin/useAdminWorkingCopy.ts');

  assert.match(autosave, /persistNow/);
  assert.match(autosave, /flushNow/);
  assert.match(persistence, /dbPut\(DRAFT_STORE/);
  assert.match(persistence, /dbDelete\(DRAFT_STORE, existingID\)/);
  assert.match(persistence, /getDraftId\(\)/);
  assert.match(persistence, /syncDraft\(clearedDraft, expectedEpoch, true\)/);
  assert.match(persistence, /if \(!stored\)/);
  assert.match(persistence, /本地保存失败/);
  assert.match(persistence, /markdown/);
  assert.match(persistence, /title/);
  assert.match(persistence, /summary/);
  assert.match(persistence, /categories/);
  assert.match(persistence, /trim\(\)/);
  assert.match(persistence, /refreshDrafts\(\)/);
  assert.match(persistence, /void syncDraft\(draft, expectedEpoch\)/);
  assert.doesNotMatch(persistence, /await syncDraft\(draft/);
  assert.match(persistence, /const currentMarkdown = readMarkdown\?\.\(\)/);
  assert.match(working, /editorRef\.current\?\.getMarkdown\(\)/);
  assert.match(working, /useDraftAutosave\(\{[^}]*readMarkdown/s);
  assert.match(flush, /flushNow/);
  assert.match(flush, /discardingRef\.current/);
});

test('session loss keeps authored text mounted until local persistence succeeds', async () => {
  const dialog = await read('../app/admin/QuickWriteDialog.tsx');
  const failureGuard = dialog.indexOf('if (!persisted && hasAuthoredContent(controller))');
  const invalidation = dialog.indexOf('onSessionInvalid?.()', failureGuard);

  assert.ok(failureGuard >= 0);
  assert.ok(invalidation > failureGuard);
  assert.match(dialog.slice(failureGuard, invalidation), /if \(sessionInvalid\)[\s\S]*return;/);
  assert.match(dialog, /内容仍保留在窗口中/);
});

test('uploading media disables both dialog dismissal and local draft switches', async () => {
  const dialog = await read('../app/admin/QuickWriteDialog.tsx');
  const view = await read('../app/admin/AdminEditorView.tsx');
  const tray = await read('../app/admin/DraftTray.tsx');

  assert.match(dialog, /blockOutsideClose = controller\.mediaStillProcessing \|\| controller\.saving \|\| closing/);
  assert.match(dialog, /onEscapeKeyDown/);
  assert.match(dialog, /onPointerDownOutside/);
  assert.match(view, /disabled=\{mediaStillProcessing\}/);
  assert.match(tray, /disabled=\{disabled\}/);
});

test('a completed close keeps the quick writer mounted, pauses hidden persistence, and image placeholders precede CSRF waits', async () => {
  const home = await read('../app/HomeTimeline.tsx');
  const dialog = await read('../app/admin/QuickWriteDialog.tsx');
  const infrastructure = await read('../app/admin/useAdminEditorInfrastructure.ts');
  const autosave = await read('../app/admin/useDraftAutosave.ts');
  const persistence = await read('../app/admin/useDraftPersistence.ts');
  const flush = await read('../app/admin/useDraftFlush.ts');
  const outbox = await read('../app/admin/useDraftOutbox.ts');
  const uploads = await read('../app/admin/useMediaUploads.ts');
  const view = await read('../app/admin/AdminEditorView.tsx');

  assert.doesNotMatch(home, /if \(!nextOpen\) setQuickWriteMounted\(false\)/);
  assert.match(home, /onOpenChange=\{setQuickWriteOpen\}/);
  assert.match(home, /onSessionInvalid=\{handleSessionInvalid\}/);
  assert.match(home, /setQuickWriteMounted\(false\)/);
  assert.match(dialog, /useAdminPageController\(\{ editEntryID: null, active: open \}\)/);
  assert.match(infrastructure, /active/);
  assert.match(autosave, /active/);
  assert.match(persistence, /if \(!active\) return undefined/);
  assert.match(flush, /if \(!active\) return undefined/);
  assert.match(outbox, /if \(!active\) return undefined/);
  assert.match(dialog, /if \(sessionInvalid\) \{\s*onSessionInvalid\?\.\(\);\s*\} else \{\s*setCloseMessage\('\'\);\s*onOpenChange\(false\);\s*\}/);
  assert.match(dialog, /<AdminEditorView \{\.\.\.controller\} saving=\{controller\.saving \|\| closing\}/);
  assert.match(dialog, /className="quick-write-dialog-scroll" inert=\{closing \|\| undefined\} aria-busy=\{closing \|\| undefined\}/);
  assert.match(view, /navigationDisabled = mediaStillProcessing \|\| saving/);
  assert.match(view, /aria-disabled="true"/);
  assert.doesNotMatch(view, /<Link className="writing-manage-link" href="\/admin\/entries">[\s\S]*navigationDisabled/);
  assert.match(uploads, /useEffect\(\(\) => \{\s*unmountedRef\.current = false;[\s\S]*return \(\) => \{\s*unmountedRef\.current = true;[\s\S]*controller\.abort\(\)/);
  assert.match(uploads, /if \(unmountedRef\.current\) return ''/);
  assert.match(uploads, /if \(uploadControllers\.current\.has\(item\.id\) \|\| mediaQueueDeleteChains\.has\(item\.id\)\) return ''/);
  assert.match(uploads, /if \(uploadControllers\.current\.has\(value\.id\)\) continue;/);
  assert.match(uploads, /if \(item\.status !== 'failed'\) return;/);
  assert.match(uploads, /const mediaQueuePersistenceChains = new Map<string, Promise<void>>\(\)/);
  assert.match(uploads, /const mediaQueueDeleteChains = new Map<string, Promise<void>>\(\)/);
  assert.match(uploads, /function enqueueMediaQueuePersistence\(itemID: string, operation: MediaQueuePersistence\)/);
  assert.match(uploads, /function enqueueMediaQueueDelete\(itemID: string\)/);
  assert.match(uploads, /async function waitForMediaQueuePersistenceChains\(\)/);
  assert.match(uploads, /const pending = \[\.\.\.mediaQueuePersistenceChains\.values\(\)\]/);
  assert.match(uploads, /if \(unmountedRef\.current \|\| uploadControllers\.current\.size\) return;/);
  assert.match(uploads, /await waitForMediaQueuePersistenceChains\(\)/);
  assert.match(uploads, /enqueueMediaQueuePersistence\(item\.id, \(\) => persistMediaQueueItem\(uploading, file\)\)/);
  assert.match(uploads, /enqueueMediaQueuePersistence\(item\.id, \(\) => persistMediaQueueItem\(ready\)\)/);
  assert.match(uploads, /void enqueueMediaQueueDelete\(item\.id\)/);
  assert.match(uploads, /values\.filter\(value => !mediaQueueDeleteChains\.has\(value\.id\)\)/);
  assert.doesNotMatch(uploads, /uploadControllers\.current\.get\(item\.id\)\?\.abort\(\);\s*uploadControllers\.current\.delete\(item\.id\)/);
  assert.match(uploads, /const uploading: UploadItem = \{ \.\.\.itemWithReference, status: 'uploading', mediaId, progress: 0 \}/);
  assert.match(uploads, /value\.status === 'ready' && value\.mediaId/);
  assert.match(uploads, /replaceMediaOccurrence\(markdownRef\.current, temporaryReference, finalReference\)/);

  const insertAt = uploads.indexOf('insertMediaReference(reference)');
  const csrfAt = uploads.indexOf('await refreshSessionCSRF()', insertAt);
  assert.ok(insertAt >= 0);
  assert.ok(csrfAt > insertAt);
});

test('quick writing uses the project editor handle contract instead of MDXEditor methods', async () => {
  const files = [
    '../app/admin/useAdminPageController.ts',
    '../app/admin/useAdminEditorInfrastructure.ts',
    '../app/admin/useAdminWorkingCopy.ts',
    '../app/admin/useWorkingCopyMetadata.ts',
    '../app/admin/useWorkingCopyActions.ts',
    '../app/admin/useLoadDraft.ts',
    '../app/admin/useAdminEntryActions.ts',
  ];
  for (const file of files) {
    const source = await read(file);
    assert.doesNotMatch(source, /MDXEditorMethods/);
  }
});

test('quick writing moves initial focus into Novel when the editor becomes ready', async () => {
  const dialog = await read('../app/admin/QuickWriteDialog.tsx');
  assert.match(dialog, /const handleEditorReady = useCallback/);
  assert.match(dialog, /requestAnimationFrame\(\(\) => controller\.editorRef\.current\?\.focus\(\)\)/);
  assert.match(dialog, /onEditorReady=\{handleEditorReady\}/);
});
