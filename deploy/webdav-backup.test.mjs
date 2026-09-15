import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const deployDir = dirname(fileURLToPath(import.meta.url));
const backupScript = join(deployDir, 'backup.sh');
const restoreScript = join(deployDir, 'restore.sh');
const webdavScript = join(deployDir, 'webdav-backup.sh');

const fakeDocker = `#!/usr/bin/env bash
set -Eeuo pipefail
printf '%q ' "$@" >> "$FAKE_DOCKER_LOG"
printf '\n' >> "$FAKE_DOCKER_LOG"
joined=" $* "
case "$joined" in
  *" config "*|*" ps --status running postgres "*) exit 0 ;;
  *" exec -T postgres pg_dump "*)
    dump=""
    for arg in "$@"; do
      case "$arg" in --file=*) dump="\${arg#--file=}" ;; esac
    done
    [[ -n "$dump" ]]
    printf 'PGDMP-test-data\n' > "$dump"
    ;;
  *" exec -T postgres pg_restore --list "*)
    dump="\${!#}"
    [[ "$(head -c 5 "$dump")" == PGDMP ]]
    ;;
  *" cp postgres:"*)
    source_path=""
    for arg in "$@"; do
      case "$arg" in postgres:*) source_path="\${arg#postgres:}" ;; esac
    done
    [[ -n "$source_path" ]]
    cp -- "$source_path" "\${!#}"
    ;;
  *" exec -T postgres rm -f -- "*)
    rm -f -- "\${!#}"
    ;;
  *" run --rm --no-deps volume-tools "*)
    tar -czf - --files-from /dev/null
    ;;
  *)
    printf 'unexpected fake docker invocation: %s\n' "$joined" >&2
    exit 90
    ;;
esac
`;

const fakeRclone = `#!/usr/bin/env bash
set -Eeuo pipefail
command_name="$1"
shift
printf '%s' "$command_name" >> "$FAKE_RCLONE_LOG"
printf ' %q' "$@" >> "$FAKE_RCLONE_LOG"
printf '\n' >> "$FAKE_RCLONE_LOG"
map_remote() {
  value="$1"
  printf '%s/%s' "$FAKE_REMOTE_ROOT" "\${value#*:}"
}
case "$command_name" in
  copy)
    source_dir="$1"
    destination="$(map_remote "$2")"
    mkdir -p "$destination"
    shopt -s nullglob
    files=("$source_dir"/*-"$BACKUP_STAMP")
    [[ "\${#files[@]}" == 5 ]]
    for file in "\${files[@]}"; do cp -- "$file" "$destination/"; done
    ;;
  check)
    source_dir="$1"
    destination="$(map_remote "$2")"
    if [[ "\${FAKE_RCLONE_FAIL_DOWNLOAD:-0}" == 1 && " $* " == *" --download "* ]]; then
      exit 9
    fi
    shopt -s nullglob
    files=("$source_dir"/*-"$BACKUP_STAMP")
    [[ "\${#files[@]}" == 5 ]]
    for file in "\${files[@]}"; do cmp -- "$file" "$destination/$(basename "$file")"; done
    ;;
  moveto)
    source_path="$(map_remote "$1")"
    destination="$(map_remote "$2")"
    mkdir -p "$(dirname "$destination")"
    [[ ! -e "$destination" ]]
    mv -- "$source_path" "$destination"
    ;;
  size)
    source_path="$(map_remote "$1")"
    shopt -s nullglob
    files=("$source_path"/*-"$BACKUP_STAMP")
    bytes=0
    for file in "\${files[@]}"; do
      file_size="$(stat -c '%s' -- "$file")"
      ((bytes += file_size))
    done
    if [[ "\${FAKE_RCLONE_WRONG_SIZE:-0}" == 1 ]]; then ((bytes += 1)); fi
    printf '{"count":%d,"bytes":%d,"sizeless":0}\n' "\${#files[@]}" "$bytes"
    ;;
  lsf)
    source_path="$(map_remote "$1")"
    if [[ " $* " == *" --recursive "* ]]; then
      find "$source_path" -mindepth 2 -maxdepth 2 -type f -name _SUCCESS -printf '%P\n'
    else
      find "$source_path" -mindepth 1 -maxdepth 1 -type f -printf '%f\n'
      find "$source_path" -mindepth 1 -maxdepth 1 -type d -printf '%f/\n'
    fi
    ;;
  deletefile)
    source_path="$(map_remote "$1")"
    rm -f -- "$source_path"
    ;;
  rmdir)
    source_path="$(map_remote "$1")"
    rmdir "$source_path"
    ;;
  touch)
    destination="$(map_remote "$1")"
    mkdir -p "$(dirname "$destination")"
    touch -- "$destination"
    ;;
  *)
    printf 'unexpected fake rclone command: %s\n' "$command_name" >&2
    exit 91
    ;;
esac
`;

const fakeFlock = `#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "\${FAKE_FLOCK_BUSY:-0}" == 1 ]]; then
  exit 1
fi
exec /usr/bin/flock "$@"
`;

async function createHarness(t, stamp) {
  const root = await mkdtemp(join(tmpdir(), 'timeblog-webdav-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binDir = join(root, 'bin');
  const backups = join(root, 'backups');
  const remote = join(root, 'remote');
  await mkdir(binDir);
  await mkdir(remote);
  const dockerPath = join(binDir, 'docker');
  const rclonePath = join(binDir, 'rclone');
  const flockPath = join(binDir, 'flock');
  const composeFile = join(root, 'compose.yaml');
  const composeEnv = join(root, 'compose.env');
  const dockerLog = join(root, 'docker.log');
  const rcloneLog = join(root, 'rclone.log');
  await writeFile(dockerPath, fakeDocker);
  await writeFile(rclonePath, fakeRclone);
  await writeFile(flockPath, fakeFlock);
  await writeFile(composeFile, 'services: {}\n');
  await writeFile(composeEnv, 'POSTGRES_PASSWORD=test-only\n');
  await writeFile(dockerLog, '');
  await writeFile(rcloneLog, '');
  await chmod(dockerPath, 0o700);
  await chmod(rclonePath, 0o700);
  await chmod(flockPath, 0o700);
  return {
    root,
    backups,
    remote,
    dockerLog,
    rcloneLog,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      BACKUP_DIR: backups,
      BACKUP_STAMP: stamp,
      COMPOSE_FILE: composeFile,
      COMPOSE_ENV_FILE: composeEnv,
      FAKE_DOCKER_LOG: dockerLog,
      FAKE_RCLONE_LOG: rcloneLog,
      FAKE_REMOTE_ROOT: remote,
      RCLONE_BIN: rclonePath,
      WEBDAV_REMOTE: 'webdav:Google1/TimeBlog/backups',
      WEBDAV_BACKUP_LOCK: join(root, 'webdav-backup.lock'),
    },
  };
}

test('backup.sh creates a validated five-file snapshot with an explicit Compose env', async (t) => {
  const stamp = '20400101T010203Z';
  const harness = await createHarness(t, stamp);
  const result = spawnSync(backupScript, [], { env: harness.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const files = (await readdir(harness.backups)).sort();
  assert.deepEqual(files, [
    `SHA256SUMS-${stamp}`,
    `exports.tar.gz-${stamp}`,
    `manifest.json-${stamp}`,
    `media.tar.gz-${stamp}`,
    `timeline.dump-${stamp}`,
  ]);
  for (const name of files) {
    assert.equal((await stat(join(harness.backups, name))).mode & 0o777, 0o600);
  }
  const checksums = await readFile(join(harness.backups, `SHA256SUMS-${stamp}`), 'utf8');
  assert.match(checksums, new RegExp(`manifest\\.json-${stamp}`));
  const manifest = JSON.parse(await readFile(join(harness.backups, `manifest.json-${stamp}`), 'utf8'));
  assert.equal(manifest.database, `timeline.dump-${stamp}`);
  const dockerLog = await readFile(harness.dockerLog, 'utf8');
  assert.match(dockerLog, /--env-file/);
  assert.match(dockerLog, new RegExp(`pg_restore .*--list /tmp/timeline-${stamp}\\.dump`));
});

test('backup.sh rejects unsafe timestamps before invoking Docker', async (t) => {
  const harness = await createHarness(t, '../../escape');
  const result = spawnSync(backupScript, [], { env: harness.env, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /BACKUP_STAMP must use/);
  assert.equal(await readFile(harness.dockerLog, 'utf8'), '');
});

test('restore.sh rejects unsafe timestamps before invoking Docker', async (t) => {
  const harness = await createHarness(t, '../../escape');
  const result = spawnSync(restoreScript, ['--confirm'], { env: harness.env, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /BACKUP_STAMP must use/);
  assert.equal(await readFile(harness.dockerLog, 'utf8'), '');
});

test('WebDAV backup rejects a missing remote before invoking Docker', async (t) => {
  const stamp = '20400101T020304Z';
  const harness = await createHarness(t, stamp);
  const result = spawnSync(webdavScript, [], {
    env: { ...harness.env, BACKUP_SCRIPT: backupScript, WEBDAV_REMOTE: '' },
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /WEBDAV_REMOTE must use/);
  assert.equal(await readFile(harness.dockerLog, 'utf8'), '');
});

test('WebDAV backup refuses concurrent execution before invoking Docker', async (t) => {
  const stamp = '20400101T030405Z';
  const harness = await createHarness(t, stamp);
  const result = spawnSync(webdavScript, [], {
    env: { ...harness.env, BACKUP_SCRIPT: backupScript, FAKE_FLOCK_BUSY: '1' },
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /another backup is already running/);
  assert.equal(await readFile(harness.dockerLog, 'utf8'), '');
});

test('WebDAV backup publishes only a remotely verified snapshot', async (t) => {
  const stamp = '20400102T010203Z';
  const harness = await createHarness(t, stamp);
  const result = spawnSync(webdavScript, [], {
    env: { ...harness.env, BACKUP_SCRIPT: backupScript },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const snapshot = join(harness.remote, 'Google1', 'TimeBlog', 'backups', stamp);
  assert.equal((await stat(join(snapshot, '_SUCCESS'))).isFile(), true);
  assert.equal((await readdir(snapshot)).length, 6);
  const log = await readFile(harness.rcloneLog, 'utf8');
  assert.match(log, /copy .*\.incomplete-/);
  assert.match(log, /check .*--download/);
  assert.match(log, /moveto .*\.incomplete-/);
  assert.match(log, /size .*\/20400102T010203Z .*--json/);
  assert.match(log, /touch .*_SUCCESS/);
});

test('WebDAV download mismatch leaves an incomplete snapshot without success marker', async (t) => {
  const stamp = '20400103T010203Z';
  const harness = await createHarness(t, stamp);
  const result = spawnSync(webdavScript, [], {
    env: { ...harness.env, BACKUP_SCRIPT: backupScript, FAKE_RCLONE_FAIL_DOWNLOAD: '1' },
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  const remoteRoot = join(harness.remote, 'Google1', 'TimeBlog', 'backups');
  assert.equal((await stat(join(remoteRoot, `.incomplete-${stamp}`))).isDirectory(), true);
  await assert.rejects(stat(join(remoteRoot, stamp, '_SUCCESS')));
});

test('WebDAV published size mismatch never receives a success marker', async (t) => {
  const stamp = '20400104T010203Z';
  const harness = await createHarness(t, stamp);
  const result = spawnSync(webdavScript, [], {
    env: { ...harness.env, BACKUP_SCRIPT: backupScript, FAKE_RCLONE_WRONG_SIZE: '1' },
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /size\/count mismatch/);
  const snapshot = join(harness.remote, 'Google1', 'TimeBlog', 'backups', stamp);
  assert.equal((await stat(snapshot)).isDirectory(), true);
  await assert.rejects(stat(join(snapshot, '_SUCCESS')));
});

test('systemd and environment examples keep scheduling explicit and secrets external', async () => {
  const envExample = await readFile(join(deployDir, 'webdav-backup.env.example'), 'utf8');
  const service = await readFile(join(deployDir, 'systemd', 'timeline-webdav-backup.service'), 'utf8');
  const timer = await readFile(join(deployDir, 'systemd', 'timeline-webdav-backup.timer'), 'utf8');
  const ci = await readFile(join(deployDir, '..', '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.doesNotMatch(envExample, /(?:PASSWORD|TOKEN|SECRET)=/);
  assert.match(envExample, /^WEBDAV_REMOTE=/m);
  assert.match(envExample, /^LOCAL_RETENTION_COUNT=7$/m);
  assert.match(envExample, /^REMOTE_RETENTION_COUNT=90$/m);
  assert.match(envExample, /^BACKUP_RETENTION_DRY_RUN=0$/m);
  assert.match(service, /^EnvironmentFile=\/etc\/timeblog\/webdav-backup\.env$/m);
  assert.match(service, /\$\{TIMEBLOG_PROJECT_DIR\}\/deploy\/webdav-backup\.sh/);
  assert.match(timer, /^OnCalendar=\*-\*-\* 03:30:00 Asia\/Shanghai$/m);
  assert.match(ci, /deploy\/webdav-backup\.test\.mjs/);
  assert.match(ci, /deploy\/webdav-retention\.test\.mjs/);
});
