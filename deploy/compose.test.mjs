import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const compose = await readFile(new URL('./compose.yaml', import.meta.url), 'utf8');
const proxy = await readFile(new URL('./compose.proxy.yaml', import.meta.url), 'utf8');
const ci = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
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

test('core compose keeps proxy configuration out of the default stack', () => {
  assert.doesNotMatch(compose, /^  caddy:/m);
  assert.doesNotMatch(compose, /SITE_HOST/);
  assert.doesNotMatch(compose, /caddy-(?:data|config)/);
  assert.match(proxy, /^  caddy:/m);
  assert.match(proxy, /^      SITE_HOST: \$\{SITE_HOST:\?set\}$/m);
});

test('CI supplies the proxy placeholder and opts into database integration tests', () => {
  assert.match(ci, /^  SITE_HOST: localhost$/m);
  assert.match(ci, /^  TIMEBLOG_RUN_DATABASE_INTEGRATION: ['"]?1['"]?$/m);
});

test('api and worker share an overridable core image while retaining a build fallback', () => {
  for (const name of ['api', 'worker']) {
    assert.match(service(name), /^    image: \$\{CORE_IMAGE:-timeblog-core:local\}$/m);
    assert.match(service(name), /^    build:$/m);
  }
});

test('web exposes an overridable image while retaining a build fallback', () => {
  assert.match(service('web'), /^    image: \$\{WEB_IMAGE:-timeblog-web:local\}$/m);
  assert.match(service('web'), /^    build:$/m);
});

test('web binds Next.js to all interfaces for the loopback healthcheck', () => {
  assert.match(service('web'), /^      HOSTNAME: 0\.0\.0\.0$/m);
  assert.match(service('web'), /fetch\('http:\/\/127\.0\.0\.1:3000\/'\)/);
});

test('api and worker receive the independent integration encryption key', () => {
  assert.match(service('api'), /^      CONFIG_ENCRYPTION_KEY: \$\{CONFIG_ENCRYPTION_KEY:\?set\}$/m);
  assert.match(service('worker'), /^      CONFIG_ENCRYPTION_KEY: \$\{CONFIG_ENCRYPTION_KEY:\?set\}$/m);
});
