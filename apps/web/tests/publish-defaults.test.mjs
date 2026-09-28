import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

test('new composer resets publication defaults after saving an entry', async () => {
  const source = await fs.readFile(new URL('../app/admin/useAdminSaveAction.ts', import.meta.url), 'utf8');
  const newEntryBranch = source.slice(source.indexOf("if (options.editingEntryID)"));
  assert.match(newEntryBranch, /options\.setKind\('note'\);/);
  assert.match(newEntryBranch, /options\.setStatus\('draft'\);/);
});

test('legacy draft kind values load as the default note kind', async () => {
  const workingCopy = await fs.readFile(new URL('../app/admin/editing-working-copy.ts', import.meta.url), 'utf8');
  const loadDraft = await fs.readFile(new URL('../app/admin/useLoadDraft.ts', import.meta.url), 'utf8');
  const undo = await fs.readFile(new URL('../app/admin/useAdminUndoAction.ts', import.meta.url), 'utf8');
  assert.match(workingCopy, /normalizeEditorKind\(value\.kind\)/);
  assert.match(loadDraft, /setKind\(normalizeEditorKind\(value\.kind\)\)/);
  assert.match(undo, /normalizeEditorKind\(body\.entry\?\.kind\)/);
});
