import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const compose = await readFile(new URL('./compose.yaml', import.meta.url), 'utf8');
const service = (name) => {
  const match = compose.match(new RegExp(`^  ${name}:\\n(.*?)(?=^  \\w|^volumes:)`, 'ms'));
  assert.ok(match, `missing ${name} service`);
  return match[1];
};

test('api and worker use their own binaries as entrypoints', () => {
  assert.match(service('api'), /^    entrypoint: \["\/app\/api"\]$/m);
  assert.match(service('worker'), /^    entrypoint: \["\/app\/worker"\]$/m);
  assert.doesNotMatch(service('worker'), /^    command:/m);
});

test('web binds Next.js to all interfaces for the loopback healthcheck', () => {
  assert.match(service('web'), /^      HOSTNAME: 0\.0\.0\.0$/m);
  assert.match(service('web'), /fetch\('http:\/\/127\.0\.0\.1:3000\/'\)/);
});

test('api and worker receive the independent integration encryption key', () => {
  assert.match(service('api'), /^      CONFIG_ENCRYPTION_KEY: \$\{CONFIG_ENCRYPTION_KEY:\?set\}$/m);
  assert.match(service('worker'), /^      CONFIG_ENCRYPTION_KEY: \$\{CONFIG_ENCRYPTION_KEY:\?set\}$/m);
});
