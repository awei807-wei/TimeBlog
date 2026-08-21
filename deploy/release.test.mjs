import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, copyFile, mkdtemp, readFile, rename, rm, writeFile, mkdir, symlink } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { once } from 'node:events';

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

const fakeSync = String.raw`#!/usr/bin/env bash
set -Eeuo pipefail
marker_state=absent
if [[ -n "\${SOURCE_ACTIVATION_MARKER:-}" && -e "\$SOURCE_ACTIVATION_MARKER" ]]; then
  marker_state=present
fi
printf '%s\t%s\t%s\n' "\$marker_state" "\${1:-}" "\${2:-}" >> "\${FAKE_SYNC_LOG:?}"
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
  const syncLog = join(root, 'sync.log');
  const updateFailedState = join(root, 'update-failed');
  const sourceActivationMarker = join(releaseDir, 'source-activation.failed');

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
  ].join('\n'), { mode: 0o600 });
  const releaseContents = [
    `CORE_IMAGE=${coreImage}`,
    `WEB_IMAGE=${webImage}`,
    `RELEASE_SHA=${releaseSha}`,
    `RELEASE_TAG=sha-${releaseSha}`,
    'RELEASE_CREATED_AT=2026-08-20T00:00:00Z',
    '',
  ].join('\n');
  await writeFile(incomingEnvFile, releaseContents, { mode: 0o600 });
  await writeFile(join(binDir, 'docker'), fakeDocker);
  await writeFile(join(binDir, 'curl'), fakeCurl);
  await writeFile(join(binDir, 'sync'), fakeSync);
  await chmod(join(binDir, 'docker'), 0o755);
  await chmod(join(binDir, 'curl'), 0o755);
  await chmod(join(binDir, 'sync'), 0o755);
  await writeFile(dockerLog, '');
  await writeFile(curlLog, '');
  await writeFile(syncLog, '');
  if (current) {
    await writeFile(join(releaseDir, 'current.env'), 'CORE_IMAGE=old-core\nWEB_IMAGE=old-web\nRELEASE_SHA=old\n', { mode: 0o600 });
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
    FAKE_SYNC_LOG: syncLog,
    FAKE_UPDATE_FAILED_STATE: updateFailedState,
    FAKE_EXPECT_CORE_IMAGE: coreImage,
    FAKE_EXPECT_WEB_IMAGE: webImage,
    FAKE_EXPECT_SITE_URL: 'https://runtime.example',
    FAKE_EXPECT_POSTGRES_PASSWORD: 'runtime-password',
    SOURCE_ACTIVATION_MARKER: sourceActivationMarker,
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
    sourceActivationMarker,
    lockFile: join(releaseDir, '.lock'),
    composeFile,
    dockerLog,
    syncLog,
    runScript: releaseScript,
    env,
  };
}

async function attachSourceArchive(harness, version = 'new-source') {
  const sourceRoot = join(harness.root, 'source');
  const sourceDeploy = join(sourceRoot, 'deploy');
  const stagingDir = join(harness.releaseDir, `incoming-${releaseSha}-1-1`);
  const archive = join(stagingDir, 'source.tar');
  const stagedEnv = join(stagingDir, 'release.env');
  const stagedScript = join(stagingDir, 'release.sh');
  await mkdir(sourceDeploy, { recursive: true });
  await mkdir(stagingDir, { mode: 0o700 });
  await writeFile(join(sourceDeploy, 'compose.yaml'), 'services:\n  postgres:\n  api:\n  worker:\n  web:\n');
  await writeFile(join(sourceDeploy, 'release.sh'), '#!/usr/bin/env bash\n');
  await writeFile(join(sourceRoot, 'source-version.txt'), `${version}\n`);
  const result = spawnSync('tar', [
    '--create',
    '--file', archive,
    '--directory', sourceRoot,
    'deploy',
    'source-version.txt',
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  await rename(harness.incomingEnvFile, stagedEnv);
  await copyFile(releaseScript, stagedScript);
  await chmod(stagingDir, 0o700);
  await chmod(archive, 0o600);
  await chmod(stagedEnv, 0o600);
  await chmod(stagedScript, 0o600);
  const archiveDigest = createHash('sha256').update(await readFile(archive)).digest('hex');
  const envDigest = createHash('sha256').update(await readFile(stagedEnv)).digest('hex');
  const scriptDigest = createHash('sha256').update(await readFile(stagedScript)).digest('hex');
  harness.incomingEnvFile = stagedEnv;
  harness.runScript = stagedScript;
  harness.env.RELEASE_ENV_FILE = stagedEnv;
  harness.env.RELEASE_ENV_SHA256 = envDigest;
  harness.env.SOURCE_ARCHIVE_FILE = archive;
  harness.env.SOURCE_ARCHIVE_SHA256 = archiveDigest;
  harness.env.RELEASE_SCRIPT_SHA256 = scriptDigest;
  return {
    archive,
    stagedEnv,
    stagedScript,
    stagingDir,
    liveVersionFile: join(harness.projectDir, 'source-version.txt'),
  };
}

function runHarness(harness) {
  return spawnSync('bash', [harness.runScript], {
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

test('source activation and deployment stay inside one shared lock descriptor', async () => {
  const source = await readFile(releaseScript, 'utf8');
  const lockOpen = source.indexOf('exec 9>>"$LOCK_FILE"');
  const lockAcquire = source.indexOf('flock -n 9');
  const markerCreate = source.indexOf(': > "$SOURCE_ACTIVATION_MARKER"');
  const markerFileSync = source.indexOf('sync -f "$SOURCE_ACTIVATION_MARKER"', markerCreate);
  const markerDirectorySync = source.indexOf('sync -f "$RELEASE_DIR"', markerFileSync);
  const archiveExtract = source.indexOf('tar --extract --file "$SOURCE_ARCHIVE_FILE"');
  const activationCall = source.lastIndexOf('\nactivate_source_archive\n');
  const appDeploy = source.indexOf('compose_run "$RELEASE_ENV_FILE" up -d --no-build');
  const markerRemove = source.indexOf('rm -f -- "$SOURCE_ACTIVATION_MARKER"');
  const removedMarkerDirectorySync = source.indexOf('sync -f "$RELEASE_DIR"', markerRemove);
  const atomicCopyStart = source.indexOf('atomic_copy()');
  const atomicCopyEnd = source.indexOf('\n}\n\nread_release_value()', atomicCopyStart);
  const atomicCopySource = source.slice(atomicCopyStart, atomicCopyEnd);

  assert.ok(lockOpen >= 0 && lockOpen < lockAcquire);
  assert.ok(markerCreate >= 0 && markerCreate < markerFileSync);
  assert.ok(markerFileSync < markerDirectorySync && markerDirectorySync < archiveExtract);
  assert.ok(lockAcquire < activationCall && activationCall < appDeploy && appDeploy < markerRemove);
  assert.ok(markerRemove < removedMarkerDirectorySync);
  assert.match(atomicCopySource, /sync -f "\$temporary"\n  mv -f -- "\$temporary" "\$destination"\n  sync -f "\$RELEASE_DIR"/);
  assert.equal((source.match(/flock -n 9/g) ?? []).length, 1);
  assert.doesNotMatch(source, /bash\s+"?\$PROJECT_DIR\/deploy\/release\.sh/);
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

test('a verified staged archive is activated while the release lock remains held', async (t) => {
  const harness = await createHarness({ current: true });
  registerCleanup(t, harness);
  const source = await attachSourceArchive(harness);

  const result = runHarness(harness);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(source.liveVersionFile, 'utf8'), 'new-source\n');
  assert.equal(await readIfExists(harness.sourceActivationMarker), null);
  assert.equal(existsSync(source.stagingDir), false);
  assert.match(result.stdout, /exact release source activated under the shared release lock/);
  const syncEntries = (await readFile(harness.syncLog, 'utf8')).trim().split('\n');
  assert.ok(syncEntries.includes(`present\t-f\t${harness.releaseDir}`));
  assert.ok(syncEntries.includes(`absent\t-f\t${harness.releaseDir}`));
  assert.ok(syncEntries.some((entry) => entry.startsWith(`present\t-f\t${harness.previousEnvFile}.tmp.`)));
  assert.ok(syncEntries.some((entry) => entry.startsWith(`present\t-f\t${harness.currentEnvFile}.tmp.`)));
});

test('real lock contention leaves the live source tree completely unchanged', async (t) => {
  const harness = await createHarness({ current: true });
  registerCleanup(t, harness);
  const source = await attachSourceArchive(harness);
  await writeFile(source.liveVersionFile, 'old-source\n');

  await writeFile(harness.lockFile, '', { mode: 0o600 });
  await chmod(harness.lockFile, 0o600);
  const holder = spawn('flock', ['-n', harness.lockFile, 'bash', '-c', 'printf "ready\\n"; IFS= read -r _'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let readyTimer;
  let ready;
  try {
    ready = await Promise.race([
      once(holder.stdout, 'data'),
      new Promise((_, reject) => {
        readyTimer = setTimeout(() => reject(new Error('lock holder did not become ready')), 3000);
      }),
    ]).finally(() => clearTimeout(readyTimer));
  } catch (error) {
    holder.stdin.end('\n');
    holder.kill('SIGTERM');
    throw error;
  }
  assert.match(String(ready[0]), /ready/);

  let result;
  try {
    result = runHarness(harness);
  } finally {
    holder.stdin.end('\n');
    if (holder.exitCode === null) {
      await once(holder, 'exit');
    }
  }

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /another release is already running/);
  assert.equal(await readFile(source.liveVersionFile, 'utf8'), 'old-source\n');
  assert.equal(await readIfExists(harness.sourceActivationMarker), null);
  assert.equal(await readIfExists(harness.incomingEnvFile), null);
  assert.equal(await readFile(harness.dockerLog, 'utf8'), '');
});

test('bad staged bundle checksums cannot mutate the live source tree', async (t) => {
  for (const [field, message] of [
    ['SOURCE_ARCHIVE_SHA256', /source archive checksum does not match/],
    ['RELEASE_ENV_SHA256', /release env checksum does not match/],
    ['RELEASE_SCRIPT_SHA256', /release script checksum does not match/],
  ]) {
    const harness = await createHarness({ current: true });
    registerCleanup(t, harness);
    const source = await attachSourceArchive(harness);
    await writeFile(source.liveVersionFile, 'old-source\n');
    harness.env[field] = 'c'.repeat(64);

    const result = runHarness(harness);

    assert.notEqual(result.status, 0, `${field} must be checked`);
    assert.match(result.stderr, message);
    assert.equal(await readFile(source.liveVersionFile, 'utf8'), 'old-source\n');
    assert.equal(await readIfExists(harness.sourceActivationMarker), null);
    assert.equal(await readFile(harness.dockerLog, 'utf8'), '');
  }
});

test('staged archive, env, and script symbolic links are rejected before activation', async (t) => {
  for (const [property, message] of [
    ['archive', /source archive is missing, unreadable, or not a regular file/],
    ['stagedEnv', /release env is missing, unreadable, or not a regular file/],
    ['stagedScript', /release script is missing, unreadable, or not a regular file/],
  ]) {
    const harness = await createHarness({ current: true });
    registerCleanup(t, harness);
    const source = await attachSourceArchive(harness);
    await writeFile(source.liveVersionFile, 'old-source\n');
    const protectedPath = source[property];
    const actualPath = `${protectedPath}.actual`;
    await rename(protectedPath, actualPath);
    await symlink(actualPath, protectedPath);

    const result = runHarness(harness);

    assert.notEqual(result.status, 0, `${property} symlink must be rejected`);
    assert.match(result.stderr, message);
    assert.equal(await readFile(source.liveVersionFile, 'utf8'), 'old-source\n');
    assert.equal(await readIfExists(harness.sourceActivationMarker), null);
    assert.equal(await readFile(harness.dockerLog, 'utf8'), '');
  }
});

test('a failed deployment keeps a source-activation marker and rolls images back', async (t) => {
  const harness = await createHarness({ current: true, failUpdate: true });
  registerCleanup(t, harness);
  const source = await attachSourceArchive(harness);

  const result = runHarness(harness);

  assert.notEqual(result.status, 0);
  assert.equal(await readFile(source.liveVersionFile, 'utf8'), 'new-source\n');
  assert.equal(statSync(harness.sourceActivationMarker).mode & 0o777, 0o600);
  assert.equal(existsSync(source.stagingDir), true);
  assert.match(result.stdout, /rolling back to previous release/);
});

test('release refuses a symbolic-link lock before touching Docker or source', async (t) => {
  const harness = await createHarness({ current: true });
  registerCleanup(t, harness);
  const source = await attachSourceArchive(harness);
  await writeFile(source.liveVersionFile, 'old-source\n');
  const target = join(harness.root, 'lock-target');
  await writeFile(target, 'must-not-change\n');
  await symlink(target, harness.lockFile);

  const result = runHarness(harness);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /lock file must not be a symbolic link/);
  assert.equal(await readFile(target, 'utf8'), 'must-not-change\n');
  assert.equal(await readFile(source.liveVersionFile, 'utf8'), 'old-source\n');
  assert.equal(await readFile(harness.dockerLog, 'utf8'), '');
});
