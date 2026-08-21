import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const workflow = await readFile(
  new URL('../.github/workflows/production-ssh-preflight.yml', import.meta.url),
  'utf8',
);

test('production SSH preflight is manual and uses the production environment', () => {
  assert.match(workflow, /^\s{2}workflow_dispatch:\s*$/m);
  assert.doesNotMatch(workflow, /^\s{2}(push|pull_request|workflow_run):/m);
  assert.match(workflow, /environment:\s*\n\s+name: production/);
  assert.match(workflow, /permissions: \{\}/);
});

test('production SSH preflight consumes all four environment secrets', () => {
  for (const name of ['VPS_HOST', 'VPS_USER', 'VPS_SSH_PRIVATE_KEY', 'VPS_KNOWN_HOSTS']) {
    assert.match(workflow, new RegExp(`${name}: \\$\\{\\{ secrets\\.${name} \\}\\}`));
  }
  assert.match(workflow, /ssh-keygen -y -f "\$key_file"/);
  assert.match(workflow, /ssh-keygen -F "\$VPS_HOST" -f "\$known_hosts_file"/);
});

test('production SSH preflight enforces trust and remains read-only', () => {
  assert.match(workflow, /BatchMode=yes/);
  assert.match(workflow, /IdentitiesOnly=yes/);
  assert.match(workflow, /StrictHostKeyChecking=yes/);
  assert.match(workflow, /UserKnownHostsFile="\$known_hosts_file"/);
  assert.match(workflow, /docker info > \/dev\/null/);
  assert.match(workflow, /docker compose version > \/dev\/null/);

  for (const mutation of [
    /\bscp\b/,
    /\brsync\b/,
    /git archive/,
    /docker (?:compose )?(?:pull|push|up|down|restart)/,
    /deploy\/release\.sh(?:'|")?\s*$/m,
  ]) {
    assert.doesNotMatch(workflow, mutation);
  }
});
