import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const script = await readFile(new URL('./nas-pull-backup.sh', import.meta.url), 'utf8');
const example = await readFile(new URL('./nas-backup.env.example', import.meta.url), 'utf8');

test('NAS pull script consumes only the exported fixed policy keys', () => {
  for (const key of ['SOURCE_HOST', 'SOURCE_PATH', 'DEST_PATH', 'RETENTION_DAYS']) {
    assert.match(script, new RegExp(`\\$\\{${key}`));
    assert.match(example, new RegExp(`^${key}=`, 'm'));
  }
  for (const forbidden of ['SSH_PRIVATE_KEY', 'PASSWORD=', 'TOKEN=']) {
    assert.doesNotMatch(example, new RegExp(forbidden));
  }
});

test('database-exported env files require restrictive mode and cannot be symlinks', () => {
  assert.match(script, /NAS_CONFIG_FILE must not be a symlink/);
  assert.match(script, /permissions must be 0600 or 0400/);
  assert.doesNotMatch(script, /source "\$NAS_CONFIG_FILE"/);
  assert.match(script, /unsupported NAS_CONFIG_FILE key/);
});
