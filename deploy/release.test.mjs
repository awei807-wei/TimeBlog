import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const deployDir = dirname(fileURLToPath(import.meta.url));
const releaseScript = join(deployDir, 'release.sh');

const fakeDocker = String.raw`#!/usr/bin/env bash
set -Eeuo pipefail

log="\${FAKE_DOCKER_LOG:?}"
printf '%q ' "\$@" >> "\$log"
printf '\n' >> "\$log"

case "\${1:-}" in
  info)
    exit 0
    ;;
  inspect)
    format="\${3:-}"
    if [[ "\$format" == *'.State.Status'* ]]; then
      printf 'running\n'
    elif [[ "\$format" == *'.State.Health'* ]]; then
      printf 'healthy\n'
    else
      exit 91
    fi
    exit 0
    ;;
  compose)
    ;;
  *)
    exit 92
    ;;
esac

env_files=()
command=''
command_index=0
for ((i = 2; i <= \$#; i++)); do
  arg="\${!i}"
  case "\$arg" in
    --env-file)
      i=\$((i + 1))
      env_files+=("\${!i}")
      ;;
    -f)
      i=\$((i + 1))
      ;;
    config|up|pull|ps)
      command="\$arg"
      command_index="\$i"
      break
      ;;
  esac
done

declare -A merged=()
for file in "\${env_files[@]}"; do
  while IFS= read -r line || [[ -n "\$line" ]]; do
    [[ -z "\$line" || "\$line" == \#* ]] && continue
    key="\${line%%=*}"
    value="\${line#*=}"
    case "\$key" in
      CORE_IMAGE|WEB_IMAGE|SITE_URL|POSTGRES_PASSWORD)
        merged["\$key"]="\$value"
        ;;
    esac
  done < "\$file"
done

case "\$command" in
  config)
    [[ -z "\${FAKE_EXPECT_CORE_IMAGE:-}" || "\${merged[CORE_IMAGE]:-}" == "\$FAKE_EXPECT_CORE_IMAGE" ]] || exit 93
    [[ -z "\${FAKE_EXPECT_WEB_IMAGE:-}" || "\${merged[WEB_IMAGE]:-}" == "\$FAKE_EXPECT_WEB_IMAGE" ]] || exit 94
    [[ -z "\${FAKE_EXPECT_SITE_URL:-}" || "\${merged[SITE_URL]:-}" == "\$FAKE_EXPECT_SITE_URL" ]] || exit 95
    [[ -z "\${FAKE_EXPECT_POSTGRES_PASSWORD:-}" || "\${merged[POSTGRES_PASSWORD]:-}" == "\$FAKE_EXPECT_POSTGRES_PASSWORD" ]] || exit 96
    exit 0
    ;;
  ps)
    printf '%s-id\n' "\${!#}"
    exit 0
    ;;
  pull)
    exit 0
    ;;
  up)
    app_up=0
    uses_previous=0
    for file in "\${env_files[@]}"; do
      [[ "\$file" == *'/previous.env' ]] && uses_previous=1
    done
    for ((i = command_index + 1; i <= \$#; i++)); do
      case "\${!i}" in
        api|worker|web) app_up=1 ;;
      esac
    done
    if [[ "\${FAKE_FAIL_UPDATE:-0}" == 1 && "\$app_up" == 1 && "\$uses_previous" == 0 && ! -e "\${FAKE_UPDATE_FAILED_STATE:?}" ]]; then
      : > "\$FAKE_UPDATE_FAILED_STATE"
      exit 97
    fi
    exit 0
    ;;
  *)
    exit 98
    ;;
esac
`.replaceAll('\\$', '$');

const fakeCurl = String.raw`#!/usr/bin/env bash
set -Eeuo pipefail
printf '%q ' "\$@" >> "\${FAKE_CURL_LOG:?}"
printf '\n' >> "\${FAKE_CURL_LOG:?}"
exit "\${FAKE_CURL_EXIT:-0}"
`.replaceAll('\\$', '$');

const digest = (name, fill) => `ghcr.io/awei807-wei/${name}@sha256:${fill.repeat(64)}`;
const validCoreImage = digest('timeblog-core', 'a');
const validWebImage = digest('timeblog-web', 'b');
const releaseSha = '0123456789abcdef0123456789abcdef01234567';

async function createHarness({ current = false, failUpdate = false, coreImage = validCoreImage, webImage = validWebImage } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'timeblog-release-test-'));
  const projectDir = join(root, 'project');
  const deployRoot = join(projectDir, 'deploy');
  const binDir = join(root, 'bin');
  const releaseDir = join(deployRoot, 'releases');
  const runtimeEnvFile = join(deployRoot, '.env');
  const incomingEnvFile = join(deployRoot, '.release.incoming.env');
  const composeFile = join(deployRoot, 'compose.yaml');
  const dockerLog = join(root, 'docker.log');
  const curlLog = join(root, 'curl.log');
  const updateFailedState = join(root, 'update-failed');

  await mkdir(deployRoot, { recursive: true });
  await mkdir(binDir, { recursive: true });
  await mkdir(releaseDir, { recursive: true });
  await writeFile(composeFile, 'services:\n  postgres:\n  api:\n  worker:\n  web:\n');
  await writeFile(runtimeEnvFile, [
    'POSTGRES_PASSWORD=runtime-password',
    'SITE_URL=https://runtime.example',
    'CORE_IMAGE=runtime-core',
    'WEB_IMAGE=runtime-web',
    '',
  ].join('\n'));
  const releaseContents = [
    `CORE_IMAGE=${coreImage}`,
    `WEB_IMAGE=${webImage}`,
    `RELEASE_SHA=${releaseSha}`,
    `RELEASE_TAG=sha-${releaseSha}`,
    'RELEASE_CREATED_AT=2026-08-20T00:00:00Z',
    '',
  ].join('\n');
  await writeFile(incomingEnvFile, releaseContents);
  await writeFile(join(binDir, 'docker'), fakeDocker);
  await writeFile(join(binDir, 'curl'), fakeCurl);
  await chmod(join(binDir, 'docker'), 0o755);
  await chmod(join(binDir, 'curl'), 0o755);
  await writeFile(dockerLog, '');
  await writeFile(curlLog, '');
  if (current) {
    await writeFile(join(releaseDir, 'current.env'), 'CORE_IMAGE=old-core\nWEB_IMAGE=old-web\nRELEASE_SHA=old\n');
  }

  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    PROJECT_DIR: projectDir,
    COMPOSE_FILE: composeFile,
    RUNTIME_ENV_FILE: runtimeEnvFile,
    RELEASE_ENV_FILE: incomingEnvFile,
    RELEASE_DIR: releaseDir,
    MIN_FREE_KB: '1',
    HEALTH_TIMEOUT_SECONDS: '5',
    FAKE_DOCKER_LOG: dockerLog,
    FAKE_CURL_LOG: curlLog,
    FAKE_UPDATE_FAILED_STATE: updateFailedState,
    FAKE_EXPECT_CORE_IMAGE: coreImage,
    FAKE_EXPECT_WEB_IMAGE: webImage,
    FAKE_EXPECT_SITE_URL: 'https://runtime.example',
    FAKE_EXPECT_POSTGRES_PASSWORD: 'runtime-password',
    ...(failUpdate ? { FAKE_FAIL_UPDATE: '1' } : {}),
  };

  return {
    root,
    projectDir,
    releaseDir,
    incomingEnvFile,
    releaseContents,
    currentEnvFile: join(releaseDir, 'current.env'),
    previousEnvFile: join(releaseDir, 'previous.env'),
    dockerLog,
    env,
  };
}

function runHarness(harness) {
  return spawnSync('bash', [releaseScript], {
    cwd: harness.projectDir,
    env: harness.env,
    encoding: 'utf8',
    timeout: 15000,
  });
}

async function readIfExists(path) {
  return existsSync(path) ? readFile(path, 'utf8') : null;
}

function registerCleanup(t, harness) {
  t.after(async () => rm(harness.root, { recursive: true, force: true }));
}

test('release script never performs destructive Compose or Docker cleanup', async () => {
  const source = await readFile(releaseScript, 'utf8');
  assert.doesNotMatch(source, /\\bdown\\b/);
  assert.doesNotMatch(source, /\\b(?:docker\\s+)?(?:system\\s+)?prune\\b/);
  assert.doesNotMatch(source, /\\bvolume\\s+prune\\b/);
});

test('release accepts only fixed GHCR digest image references', async (t) => {
  for (const [field, value] of [
    ['CORE_IMAGE', 'ghcr.io/awei807-wei/timeblog-core:main'],
    ['WEB_IMAGE', 'ghcr.io/awei807-wei/timeblog-web:main'],
  ]) {
    const harness = await createHarness({
      coreImage: field === 'CORE_IMAGE' ? value : validCoreImage,
      webImage: field === 'WEB_IMAGE' ? value : validWebImage,
    });
    registerCleanup(t, harness);
    const result = runHarness(harness);
    assert.notEqual(result.status, 0, `${field} must reject a mutable tag`);
    assert.match(result.stderr, new RegExp(`${field} must be an immutable .* image digest`));
    const log = await readFile(harness.dockerLog, 'utf8');
    assert.doesNotMatch(log, /compose/);
  }
});

test('release env overrides runtime image values while retaining runtime settings', async (t) => {
  const harness = await createHarness();
  registerCleanup(t, harness);
  const result = runHarness(harness);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(harness.currentEnvFile, 'utf8'), harness.releaseContents);
  const log = await readFile(harness.dockerLog, 'utf8');
  assert.match(log, /--env-file .*\/\.env .*--env-file .*\/\.release\.incoming\.env/);
});

test('successful release atomically promotes current and preserves previous', async (t) => {
  const harness = await createHarness({ current: true });
  registerCleanup(t, harness);
  const oldCurrent = 'CORE_IMAGE=old-core\nWEB_IMAGE=old-web\nRELEASE_SHA=old\n';
  const result = runHarness(harness);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(harness.previousEnvFile, 'utf8'), oldCurrent);
  assert.equal(await readFile(harness.currentEnvFile, 'utf8'), harness.releaseContents);
  assert.equal(statSync(harness.currentEnvFile).mode & 0o777, 0o600);
  assert.equal(await readIfExists(harness.incomingEnvFile), null);
});

test('failed update rolls back through previous and removes incoming metadata', async (t) => {
  const harness = await createHarness({ current: true, failUpdate: true });
  registerCleanup(t, harness);
  const oldCurrent = 'CORE_IMAGE=old-core\nWEB_IMAGE=old-web\nRELEASE_SHA=old\n';
  const result = runHarness(harness);
  assert.notEqual(result.status, 0, `expected update failure; stdout=${result.stdout}; stderr=${result.stderr}; docker=${await readFile(harness.dockerLog, 'utf8')}`);
  assert.match(result.stdout, /rolling back to previous release/);
  assert.equal(await readFile(harness.currentEnvFile, 'utf8'), oldCurrent);
  assert.equal(await readFile(harness.previousEnvFile, 'utf8'), oldCurrent);
  assert.equal(await readIfExists(harness.incomingEnvFile), null);
  const log = await readFile(harness.dockerLog, 'utf8');
  assert.match(log, /--env-file .*\/previous\.env .* up /);
  assert.doesNotMatch(log, /down|prune/);
});

test('first release failure reports missing rollback and never deletes volumes', async (t) => {
  const harness = await createHarness({ failUpdate: true });
  registerCleanup(t, harness);
  const result = runHarness(harness);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /rollback unavailable: previous\.env is missing/);
  assert.equal(await readIfExists(harness.currentEnvFile), null);
  assert.equal(await readIfExists(harness.previousEnvFile), null);
  assert.equal(await readIfExists(harness.incomingEnvFile), null);
  const log = await readFile(harness.dockerLog, 'utf8');
  assert.doesNotMatch(log, /down|prune|volume/);
});
