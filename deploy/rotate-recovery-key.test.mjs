import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const deployDir = dirname(fileURLToPath(import.meta.url));
const rotationScript = join(deployDir, 'rotate-recovery-key.sh');
const rotationLibrary = join(deployDir, 'rotate-recovery-key-lib.sh');
const coreImage = `ghcr.io/awei807-wei/timeblog-core@sha256:${'a'.repeat(64)}`;
const webImage = `ghcr.io/awei807-wei/timeblog-web@sha256:${'b'.repeat(64)}`;
const fakeSecret = 'test-only-new-recovery-key-do-not-log';

const fakeDocker = String.raw`#!/usr/bin/env bash
set -Eeuo pipefail

log="\${FAKE_DOCKER_LOG:?}"
printf '%q ' "$@" >> "$log"
printf '\n' >> "$log"

if [[ "\${1:-}" == "info" ]]; then
  exit 0
fi

if [[ "\${1:-}" == "image" && "\${2:-}" == "inspect" ]]; then
  image="\${!#}"
  case "$image" in
    "\${FAKE_CORE_IMAGE:?}") printf 'sha256:core-image-id\n' ;;
    "\${FAKE_WEB_IMAGE:?}") printf 'sha256:web-image-id\n' ;;
    *) exit 81 ;;
  esac
  exit 0
fi

if [[ "\${1:-}" == "inspect" ]]; then
  format="\${3:-}"
  container="\${4:-}"
  case "$format" in
    *'.State.Status'*) printf 'running\n' ;;
    *'.State.Health'*) printf 'healthy\n' ;;
    *'.Image'*)
      case "$container" in
        api-id|worker-id) printf 'sha256:core-image-id\n' ;;
        web-id) printf 'sha256:web-image-id\n' ;;
        *) printf 'sha256:postgres-image-id\n' ;;
      esac
      ;;
    *) exit 82 ;;
  esac
  exit 0
fi

[[ "\${1:-}" == "compose" ]] || exit 83

command=''
command_index=0
for ((i = 2; i <= $#; i++)); do
  arg="\${!i}"
  case "$arg" in
    --env-file|-f)
      i=$((i + 1))
      ;;
    config|ps|exec|run)
      command="$arg"
      command_index="$i"
      break
      ;;
  esac
done

case "$command" in
  config)
    exit 0
    ;;
  ps)
    printf '%s-id\n' "\${!#}"
    exit 0
    ;;
  exec)
    joined="\${*:command_index+1}"
    if [[ "$joined" == *'pg_dump'* ]]; then
      if [[ "\${FAKE_FAIL_BACKUP:-0}" == 1 ]]; then
        printf 'simulated pg_dump failure\n' >&2
        exit 84
      fi
      printf 'PGDMPtest-custom-dump\n'
      exit 0
    fi
    if [[ "$joined" == *'pg_restore --list'* ]]; then
      if [[ "\${FAKE_FAIL_BACKUP_VALIDATION:-0}" == 1 ]]; then
        printf 'simulated pg_restore validation failure\n' >&2
        exit 92
      fi
      printf 'simulated archive table of contents\n'
      exit 0
    fi
    if [[ "\${FAKE_FAIL_POST_QUERY:-0}" == 1 && -e "\${FAKE_ROTATED_STATE:?}" ]]; then
      printf 'simulated post-rotation query failure\n' >&2
      exit 93
    fi
    if [[ "$joined" == *'account_recovery_keys'* ]]; then
      if [[ -e "\${FAKE_ROTATED_STATE:?}" ]]; then
        printf '1\n'
      else
        printf '0\n'
      fi
      exit 0
    fi
    if [[ "$joined" == *'recovery_key_rotated'* ]]; then
      if [[ -e "\${FAKE_ROTATED_STATE:?}" ]]; then
        printf '8\n'
      else
        printf '7\n'
      fi
      exit 0
    fi
    exit 85
    ;;
  run)
    volume=''
    saw_user=0
    saw_api=0
    saw_rotate=0
    saw_output=0
    for ((i = command_index + 1; i <= $#; i++)); do
      arg="\${!i}"
      case "$arg" in
        --user)
          i=$((i + 1))
          [[ "\${!i}" == '65532:65532' ]] || exit 86
          saw_user=1
          ;;
        --volume)
          i=$((i + 1))
          volume="\${!i}"
          ;;
        api) saw_api=1 ;;
        --rotate-recovery-key) saw_rotate=1 ;;
        --output)
          i=$((i + 1))
          [[ "\${!i}" == '/run/timeblog-recovery/recovery-key.txt' ]] || exit 87
          saw_output=1
          ;;
      esac
    done
    [[ "$saw_user" == 1 && "$saw_api" == 1 && "$saw_rotate" == 1 && "$saw_output" == 1 ]] || exit 88
    host_output="\${volume%:/run/timeblog-recovery}"
    [[ "$host_output" != "$volume" ]] || exit 89
    printf 'container rotation diagnostic\n'
    printf 'container rotation diagnostic\n' >&2
    if [[ "\${FAKE_FAIL_ROTATION:-0}" == 1 ]]; then
      exit 90
    fi
    printf '%s\n' "\${FAKE_SECRET:?}" > "$host_output/recovery-key.txt"
    chmod 0600 "$host_output/recovery-key.txt"
    : > "\${FAKE_ROTATED_STATE:?}"
    if [[ "\${FAKE_AMBIGUOUS_ROTATION:-0}" == 1 ]]; then
      printf 'simulated ambiguous commit result\n' >&2
      exit 94
    fi
    exit 0
    ;;
  *)
    exit 91
    ;;
esac
`.replaceAll('\\$', '$');

const fakeCurl = String.raw`#!/usr/bin/env bash
set -Eeuo pipefail
printf '%q ' "$@" >> "\${FAKE_CURL_LOG:?}"
printf '\n' >> "\${FAKE_CURL_LOG:?}"
if [[ "\${FAKE_FAIL_POST_HEALTH:-0}" == 1 && -e "\${FAKE_ROTATED_STATE:?}" ]]; then
  exit 22
fi
exit "\${FAKE_CURL_EXIT:-0}"
`.replaceAll('\\$', '$');

const fakeID = String.raw`#!/usr/bin/env bash
[[ "\${1:-}" == '-u' ]] || exit 71
printf '0\n'
`.replaceAll('\\$', '$');

const fakeChown = String.raw`#!/usr/bin/env bash
printf '%q ' "$@" >> "\${FAKE_CHOWN_LOG:?}"
printf '\n' >> "\${FAKE_CHOWN_LOG:?}"
if [[ "\${1:-}" == 'root:root' && "\${2:-}" == */container-output/recovery-key.txt ]]; then
  : > "\${FAKE_OUTPUT_CHOWNED_STATE:?}"
fi
exit 0
`.replaceAll('\\$', '$');

const fakeStat = String.raw`#!/usr/bin/env bash
set -Eeuo pipefail
if [[ ( "\${1:-}" == '-c' || "\${1:-}" == '-Lc' ) && "\${2:-}" == '%u:%g' ]]; then
  if [[ "\${FAKE_WRONG_LIBRARY_OWNER:-0}" == 1 ]]; then
    printf '1000:1000\n'
    exit 0
  fi
  target="\${!#}"
  if [[ "$target" == */container-output/recovery-key.txt && ! -e "\${FAKE_OUTPUT_CHOWNED_STATE:?}" ]]; then
    if [[ "\${FAKE_WRONG_OUTPUT_OWNER:-0}" == 1 ]]; then
      printf '1000:1000\n'
    else
      printf '65532:65532\n'
    fi
  else
    printf '0:0\n'
  fi
  exit 0
fi
exec /usr/bin/stat "$@"
`.replaceAll('\\$', '$');

async function createHarness({
  failBackup = false,
  failBackupValidation = false,
  failRotation = false,
  failHealth = false,
  failPostHealth = false,
  failPostQuery = false,
  ambiguousRotation = false,
  wrongOutputOwner = false,
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'timeblog-recovery-rotation-test-'));
  const projectDir = join(root, 'project');
  const deployRoot = join(projectDir, 'deploy');
  const releaseDir = join(deployRoot, 'releases');
  const binDir = join(root, 'bin');
  const recoveryRoot = join(root, 'recovery-runs');
  const runtimeEnv = join(deployRoot, '.env');
  const currentEnv = join(releaseDir, 'current.env');
  const composeFile = join(deployRoot, 'compose.yaml');
  const dockerLog = join(root, 'docker.log');
  const curlLog = join(root, 'curl.log');
  const chownLog = join(root, 'chown.log');
  const rotatedState = join(root, 'rotated');
  const outputChownedState = join(root, 'output-chowned');

  await mkdir(releaseDir, { recursive: true });
  await chmod(releaseDir, 0o700);
  await mkdir(binDir, { recursive: true });
  await writeFile(composeFile, 'services:\n  postgres:\n  api:\n  worker:\n  web:\n');
  await writeFile(runtimeEnv, [
    'POSTGRES_PASSWORD=runtime-database-secret',
    'ADMIN_PASSWORD=runtime-admin-secret',
    'SITE_URL=https://blog.example.test',
    '',
  ].join('\n'), { mode: 0o600 });
  await writeFile(currentEnv, [
    `CORE_IMAGE=${coreImage}`,
    `WEB_IMAGE=${webImage}`,
    `RELEASE_SHA=${'c'.repeat(40)}`,
    `RELEASE_TAG=sha-${'c'.repeat(40)}`,
    'RELEASE_CREATED_AT=2026-08-21T00:00:00Z',
    '',
  ].join('\n'), { mode: 0o600 });
  await writeFile(dockerLog, '');
  await writeFile(curlLog, '');
  await writeFile(chownLog, '');

  for (const [name, source] of [
    ['docker', fakeDocker],
    ['curl', fakeCurl],
    ['id', fakeID],
    ['chown', fakeChown],
    ['stat', fakeStat],
  ]) {
    const target = join(binDir, name);
    await writeFile(target, source);
    await chmod(target, 0o755);
  }

  return {
    root,
    projectDir,
    deployRoot,
    releaseDir,
    recoveryRoot,
    dockerLog,
    curlLog,
    chownLog,
    rotatedState,
    runtimeEnv,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      PROJECT_DIR: projectDir,
      COMPOSE_FILE: composeFile,
      RUNTIME_ENV_FILE: runtimeEnv,
      CURRENT_ENV_FILE: currentEnv,
      RECOVERY_RUN_ROOT: recoveryRoot,
      FAKE_DOCKER_LOG: dockerLog,
      FAKE_CURL_LOG: curlLog,
      FAKE_CHOWN_LOG: chownLog,
      FAKE_ROTATED_STATE: rotatedState,
      FAKE_OUTPUT_CHOWNED_STATE: outputChownedState,
      FAKE_CORE_IMAGE: coreImage,
      FAKE_WEB_IMAGE: webImage,
      FAKE_SECRET: fakeSecret,
      ...(failBackup ? { FAKE_FAIL_BACKUP: '1' } : {}),
      ...(failBackupValidation ? { FAKE_FAIL_BACKUP_VALIDATION: '1' } : {}),
      ...(failRotation ? { FAKE_FAIL_ROTATION: '1' } : {}),
      ...(failHealth ? { FAKE_CURL_EXIT: '22' } : {}),
      ...(failPostHealth ? { FAKE_FAIL_POST_HEALTH: '1' } : {}),
      ...(failPostQuery ? { FAKE_FAIL_POST_QUERY: '1' } : {}),
      ...(ambiguousRotation ? { FAKE_AMBIGUOUS_ROTATION: '1' } : {}),
      ...(wrongOutputOwner ? { FAKE_WRONG_OUTPUT_OWNER: '1' } : {}),
    },
  };
}

function runHarness(harness, args = ['--confirm']) {
  return spawnSync('bash', [harness.rotationScript ?? rotationScript, ...args], {
    cwd: harness.projectDir,
    env: harness.env,
    encoding: 'utf8',
    timeout: 15000,
  });
}

async function installRotationScripts(harness) {
  const script = join(harness.deployRoot, 'rotate-recovery-key.sh');
  const library = join(harness.deployRoot, 'rotate-recovery-key-lib.sh');
  await writeFile(script, await readFile(rotationScript), { mode: 0o755 });
  await writeFile(library, await readFile(rotationLibrary), { mode: 0o644 });
  harness.rotationScript = script;
  return { script, library };
}

function registerCleanup(t, harness) {
  t.after(async () => rm(harness.root, { recursive: true, force: true }));
}

async function onlyRunDirectory(harness) {
  const entries = await readdir(harness.recoveryRoot, { withFileTypes: true });
  const directories = entries.filter((entry) => entry.isDirectory());
  assert.equal(directories.length, 1);
  return join(harness.recoveryRoot, directories[0].name);
}

test('rotation refuses to run without the explicit confirmation flag', async (t) => {
  const harness = await createHarness();
  registerCleanup(t, harness);

  const result = runHarness(harness, []);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /--confirm/);
  assert.equal(await readFile(harness.dockerLog, 'utf8'), '');
  assert.doesNotMatch(result.stdout + result.stderr, /runtime-(?:database|admin)-secret/);
});

test('rotation refuses to source a symlink helper library', async (t) => {
  const harness = await createHarness();
  registerCleanup(t, harness);
  const { library } = await installRotationScripts(harness);
  const victim = join(harness.root, 'untrusted-library');
  await writeFile(victim, 'printf untrusted\\n', { mode: 0o644 });
  await rm(library);
  await symlink(victim, library);

  const result = runHarness(harness);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /辅助库.*符号链接/);
  assert.doesNotMatch(result.stdout + result.stderr, /untrusted/);
  assert.equal(await readFile(harness.dockerLog, 'utf8'), '');
});

test('rotation refuses to source a helper library not owned by root', async (t) => {
  const harness = await createHarness();
  registerCleanup(t, harness);
  await installRotationScripts(harness);
  harness.env.FAKE_WRONG_LIBRARY_OWNER = '1';

  const result = runHarness(harness);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /辅助库必须归 root:root/);
  assert.equal(await readFile(harness.dockerLog, 'utf8'), '');
});

test('rotation refuses to source a helper library writable by non-root users', async (t) => {
  const harness = await createHarness();
  registerCleanup(t, harness);
  const { library } = await installRotationScripts(harness);
  await chmod(library, 0o664);

  const result = runHarness(harness);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /group\/other 写入/);
  assert.equal(await readFile(harness.dockerLog, 'utf8'), '');
});

test('rotation backs up the database, uses the current digest, and protects every output', async (t) => {
  const harness = await createHarness();
  registerCleanup(t, harness);

  const result = runHarness(harness);

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(fakeSecret));
  assert.doesNotMatch(result.stdout + result.stderr, /runtime-(?:database|admin)-secret/);

  const runDir = await onlyRunDirectory(harness);
  const runMode = (await stat(runDir)).mode & 0o777;
  assert.equal(runMode, 0o700);

  const recoveryKey = join(runDir, 'recovery-key.txt');
  const backup = join(runDir, 'timeline-before-rotation.dump');
  const backupChecksum = join(runDir, 'timeline-before-rotation.dump.sha256');
  const operationLog = join(runDir, 'rotation.stderr.log');
  assert.equal(await readFile(recoveryKey, 'utf8'), `${fakeSecret}\n`);
  assert.match(await readFile(backup, 'utf8'), /^PGDMP/);
  assert.match(await readFile(operationLog, 'utf8'), /container rotation diagnostic/);
  assert.equal((await stat(recoveryKey)).mode & 0o777, 0o600);
  assert.equal((await stat(backup)).mode & 0o777, 0o600);
  assert.equal((await stat(backupChecksum)).mode & 0o777, 0o600);
  assert.equal((await stat(operationLog)).mode & 0o777, 0o600);
  assert.match(await readFile(backupChecksum, 'utf8'), /^[0-9a-f]{64}  .*timeline-before-rotation\.dump\n$/);

  const dockerLog = await readFile(harness.dockerLog, 'utf8');
  const backupIndex = dockerLog.indexOf('pg_dump');
  const rotationIndex = dockerLog.indexOf('--rotate-recovery-key');
  assert.ok(backupIndex >= 0 && rotationIndex > backupIndex, dockerLog);
  assert.match(
    dockerLog,
    /run --rm --no-deps -T --user 65532:65532 --volume .*:\/run\/timeblog-recovery api --rotate-recovery-key --output \/run\/timeblog-recovery\/recovery-key\.txt/,
  );
  assert.match(dockerLog, /--format=custom/);
  assert.match(dockerLog, /pg_restore --list/);
  assert.match(dockerLog, /account_recovery_keys/);
  assert.match(dockerLog, /recovery_key_rotated/);
  assert.doesNotMatch(dockerLog, /runtime-(?:database|admin)-secret/);
  assert.doesNotMatch(dockerLog, new RegExp(fakeSecret));

  assert.doesNotMatch(await readFile(operationLog, 'utf8'), new RegExp(fakeSecret));

  const curlLog = await readFile(harness.curlLog, 'utf8');
  assert.equal(curlLog.trim().split('\n').length, 6);

  const chownLog = await readFile(harness.chownLog, 'utf8');
  assert.match(chownLog, /65532:65532 .*\/container-output/);
  assert.match(chownLog, /root:root .*\/container-output\/recovery-key\.txt/);
});

test('a backup failure stops before the recovery key command', async (t) => {
  const harness = await createHarness({ failBackup: true });
  registerCleanup(t, harness);

  const result = runHarness(harness);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /备份失败/);
  const dockerLog = await readFile(harness.dockerLog, 'utf8');
  assert.match(dockerLog, /pg_dump/);
  assert.doesNotMatch(dockerLog, /--rotate-recovery-key/);
  assert.doesNotMatch(result.stdout + result.stderr, /runtime-(?:database|admin)-secret/);
});

test('an unreadable custom dump stops before the recovery key command', async (t) => {
  const harness = await createHarness({ failBackupValidation: true });
  registerCleanup(t, harness);

  const result = runHarness(harness);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /无法被 pg_restore 解析/);
  const dockerLog = await readFile(harness.dockerLog, 'utf8');
  assert.match(dockerLog, /pg_dump/);
  assert.match(dockerLog, /pg_restore --list/);
  assert.doesNotMatch(dockerLog, /--rotate-recovery-key/);
});

test('a rotation failure keeps protected evidence and never attempts rollback', async (t) => {
  const harness = await createHarness({ failRotation: true });
  registerCleanup(t, harness);

  const result = runHarness(harness);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /数据库核验确认本次轮换未提交/);
  assert.doesNotMatch(result.stdout + result.stderr, /密钥未交付/);
  assert.match(result.stderr, /不会自动回滚/);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(fakeSecret));
  const runDir = await onlyRunDirectory(harness);
  const operationLog = join(runDir, 'rotation.stderr.log');
  assert.match(await readFile(operationLog, 'utf8'), /container rotation diagnostic/);
  assert.doesNotMatch(await readFile(operationLog, 'utf8'), new RegExp(fakeSecret));
  assert.equal((await stat(operationLog)).mode & 0o777, 0o600);
  const dockerLog = await readFile(harness.dockerLog, 'utf8');
  assert.match(dockerLog, /pg_restore --list/);
  assert.doesNotMatch(dockerLog, /pg_restore[^\n]*(?:--clean|--create)|\bdown\b|\bprune\b/);
});

test('an ambiguous CLI exit is accepted only after database state is verified', async (t) => {
  const harness = await createHarness({ ambiguousRotation: true });
  registerCleanup(t, harness);

  const result = runHarness(harness);

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout + result.stderr, /密钥未交付/);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(fakeSecret));
  const runDir = await onlyRunDirectory(harness);
  const recoveryKey = join(runDir, 'recovery-key.txt');
  assert.equal(await readFile(recoveryKey, 'utf8'), `${fakeSecret}\n`);
  assert.equal((await stat(recoveryKey)).mode & 0o777, 0o600);
});

test('a successful CLI commit with failed database post-check preserves the final key', async (t) => {
  const harness = await createHarness({ failPostQuery: true });
  registerCleanup(t, harness);

  const result = runHarness(harness);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /数据库轮换已提交/);
  assert.match(result.stderr, /只读复核失败/);
  assert.match(result.stderr, /不要重复执行/);
  assert.doesNotMatch(result.stdout + result.stderr, /密钥未交付/);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(fakeSecret));
  const runDir = await onlyRunDirectory(harness);
  const recoveryKey = join(runDir, 'recovery-key.txt');
  assert.equal(await readFile(recoveryKey, 'utf8'), `${fakeSecret}\n`);
  assert.equal((await stat(recoveryKey)).mode & 0o777, 0o600);
});

test('an unverifiable ambiguous commit preserves a root-only candidate and forbids retry', async (t) => {
  const harness = await createHarness({ ambiguousRotation: true, failPostQuery: true });
  registerCleanup(t, harness);

  const result = runHarness(harness);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /提交状态未知/);
  assert.match(result.stderr, /不要重复执行/);
  assert.doesNotMatch(result.stdout + result.stderr, /密钥未交付/);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(fakeSecret));
  const runDir = await onlyRunDirectory(harness);
  const candidate = join(runDir, 'recovery-key.candidate.txt');
  assert.equal(await readFile(candidate, 'utf8'), `${fakeSecret}\n`);
  assert.equal((await stat(candidate)).mode & 0o777, 0o600);
});

test('a post-commit health failure reports committed state and preserves the final key', async (t) => {
  const harness = await createHarness({ failPostHealth: true });
  registerCleanup(t, harness);

  const result = runHarness(harness);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /数据库轮换已提交/);
  assert.match(result.stderr, /不要重复执行/);
  assert.match(result.stderr, /recovery-key\.txt/);
  assert.doesNotMatch(result.stdout + result.stderr, /密钥未交付/);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(fakeSecret));
  const runDir = await onlyRunDirectory(harness);
  const recoveryKey = join(runDir, 'recovery-key.txt');
  assert.equal(await readFile(recoveryKey, 'utf8'), `${fakeSecret}\n`);
  assert.equal((await stat(recoveryKey)).mode & 0o777, 0o600);
});

test('rotation refuses to adopt output not owned by container UID 65532', async (t) => {
  const harness = await createHarness({ wrongOutputOwner: true });
  registerCleanup(t, harness);

  const result = runHarness(harness);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /容器 UID 65532/);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(fakeSecret));
  const runDir = await onlyRunDirectory(harness);
  const operationLog = join(runDir, 'rotation.stderr.log');
  assert.doesNotMatch(await readFile(operationLog, 'utf8'), new RegExp(fakeSecret));
  const chownLog = await readFile(harness.chownLog, 'utf8');
  assert.doesNotMatch(chownLog, /root:root .*\/container-output\/recovery-key\.txt/);
});

test('an unhealthy deployment stops before creating a database backup', async (t) => {
  const harness = await createHarness({ failHealth: true });
  registerCleanup(t, harness);

  const result = runHarness(harness);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /健康检查失败/);
  const dockerLog = await readFile(harness.dockerLog, 'utf8');
  assert.doesNotMatch(dockerLog, /pg_dump|--rotate-recovery-key/);
});

test('rotation rejects a symlink recovery lock without touching its target', async (t) => {
  const harness = await createHarness();
  registerCleanup(t, harness);
  await mkdir(harness.recoveryRoot, { mode: 0o700 });
  const victim = join(harness.root, 'lock-victim');
  await writeFile(victim, 'must-not-change\n', { mode: 0o600 });
  await symlink(victim, join(harness.recoveryRoot, '.rotate.lock'));

  const result = runHarness(harness);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /恢复锁文件.*符号链接/);
  assert.equal(await readFile(victim, 'utf8'), 'must-not-change\n');
  assert.equal(await readFile(harness.dockerLog, 'utf8'), '');
});

test('rotation rejects an abnormal recovery lock type', async (t) => {
  const harness = await createHarness();
  registerCleanup(t, harness);
  await mkdir(harness.recoveryRoot, { mode: 0o700 });
  await mkdir(join(harness.recoveryRoot, '.rotate.lock'), { mode: 0o700 });

  const result = runHarness(harness);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /恢复锁文件 必须是普通文件/);
  assert.equal(await readFile(harness.dockerLog, 'utf8'), '');
});

test('rotation refuses to repair an existing recovery directory with unsafe permissions', async (t) => {
  const harness = await createHarness();
  registerCleanup(t, harness);
  await mkdir(harness.recoveryRoot, { mode: 0o755 });
  await chmod(harness.recoveryRoot, 0o755);

  const result = runHarness(harness);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /恢复运行根目录 权限必须为 0700/);
  assert.equal((await stat(harness.recoveryRoot)).mode & 0o777, 0o755);
  assert.equal(await readFile(harness.dockerLog, 'utf8'), '');
});

test('rotation refuses a failed source activation marker after taking the release lock', async (t) => {
  const harness = await createHarness();
  registerCleanup(t, harness);
  await writeFile(join(harness.releaseDir, 'source-activation.failed'), 'failed\n', { mode: 0o600 });

  const result = runHarness(harness);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /未完成的源码激活标记/);
  assert.equal(await readFile(harness.dockerLog, 'utf8'), '');
});

test('rotation script contains no destructive rollback path', async () => {
  const source = `${await readFile(rotationScript, 'utf8')}\n${await readFile(rotationLibrary, 'utf8')}`;
  assert.doesNotMatch(source, /pg_restore[^\n]*(?:--clean|--create)|docker\s+(?:system|volume)\s+prune|compose[^\n]+\bdown\b/);
});
