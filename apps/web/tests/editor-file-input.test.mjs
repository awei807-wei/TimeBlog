import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
import { localMediaFallbackUrl } from '../lib/media-resolver.js';

const source = await fs.readFile(new URL('../app/admin/editor-file-input.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } }).outputText;
const { captureEditorFiles, isFileDrag } = await import(`data:text/javascript,${encodeURIComponent(compiled)}`);
function fixture(files = [], types = ['Files'], paste = false) {
  let prevented = 0, stopped = 0;
  const event = { [paste ? 'clipboardData' : 'dataTransfer']: { files, types, items: [] }, preventDefault() { prevented++; }, stopPropagation() { stopped++; } };
  return { event, counts: () => [prevented, stopped] };
}

test('protected drag hover detects file metadata without reading file content', () => {
  assert.equal(isFileDrag({ types: ['Files'], files: [] }), true);
  assert.equal(isFileDrag({ types: [], files: [], items: [{ kind: 'file' }] }), true);
  assert.equal(isFileDrag({ types: ['text/plain'], files: [], items: [{ kind: 'string' }] }), false);
});

for (const paste of [false, true]) {
  test(`${paste ? 'paste' : 'drop'} sends all files once and prevents duplicate editor insertion`, () => {
    const files = [new File(['photo'], 'a.jpg', { type: 'image/jpeg' }), new File(['pdf'], 'a.pdf', { type: 'application/pdf' })];
    const f = fixture(files, ['Files'], paste), calls = [];
    assert.equal(captureEditorFiles(f.event, files => calls.push(files), assert.fail), true);
    assert.deepEqual(calls, [files]);
    assert.deepEqual(f.counts(), [1, 1]);
  });
  test(`${paste ? 'paste' : 'drop'} cannot upload while saving or loading`, () => {
    const f = fixture([new File(['x'], 'x.png')], ['Files'], paste);
    assert.equal(captureEditorFiles(f.event, assert.fail, assert.fail, true), true);
    assert.deepEqual(f.counts(), [1, 1]);
  });
}

test('non-file text is untouched; unavailable media is reported once', () => {
  const text = fixture([], ['text/plain']);
  assert.equal(captureEditorFiles(text.event, assert.fail, assert.fail), false);
  assert.deepEqual(text.counts(), [0, 0]);
  const empty = fixture();
  assert.equal(captureEditorFiles(empty.event, assert.fail, assert.fail), true);
  let messages = 0;
  const file = fixture([new File(['x'], 'x.jpg')]);
  captureEditorFiles(file.event, undefined, () => messages++);
  assert.equal(messages, 1);
});

test('image host failure falls back only once to same-origin canonical media', () => {
  const origin = 'https://blog.test';
  assert.equal(localMediaFallbackUrl('/api/v1/media/image-id/content', origin), `${origin}/api/v1/media/image-id/content?local=1`);
  for (const source of ['https://image.test/media/x/content', '/api/v1/media/x/content?local=1', '/article/x', 'javascript:alert(1)', 'data:image/png;base64,AA']) assert.equal(localMediaFallbackUrl(source, origin), null, source);
});
