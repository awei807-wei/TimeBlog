import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const deployDir = dirname(fileURLToPath(import.meta.url));
const webdavScript = join(deployDir, 'webdav-backup.sh');

const fakeBackup = `#!/usr/bin/env bash
set -Eeuo pipefail
printf 'run %s\n' "$BACKUP_STAMP" >> "$FAKE_BACKUP_LOG"
mkdir -p "$BACKUP_DIR"
printf 'PGDMP-%s\n' "$BACKUP_STAMP" > "$BACKUP_DIR/timeline.dump-$BACKUP_STAMP"
tar -czf "$BACKUP_DIR/media.tar.gz-$BACKUP_STAMP" --files-from /dev/null
tar -czf "$BACKUP_DIR/exports.tar.gz-$BACKUP_STAMP" --files-from /dev/null
printf '{"schemaVersion":1,"createdAt":"%s","database":"timeline.dump-%s","media":"media.tar.gz-%s","exports":"exports.tar.gz-%s","checksums":"SHA256SUMS-%s"}\n' \
  "$BACKUP_STAMP" "$BACKUP_STAMP" "$BACKUP_STAMP" "$BACKUP_STAMP" "$BACKUP_STAMP" \
  > "$BACKUP_DIR/manifest.json-$BACKUP_STAMP"
(
  cd "$BACKUP_DIR"
  sha256sum "timeline.dump-$BACKUP_STAMP" "media.tar.gz-$BACKUP_STAMP" \
    "exports.tar.gz-$BACKUP_STAMP" "manifest.json-$BACKUP_STAMP" \
    > "SHA256SUMS-$BACKUP_STAMP"
)
`;

const fakeRclone = `#!/usr/bin/env bash
set -Eeuo pipefail
command_name="$1"
shift
printf '%s' "$command_name" >> "$FAKE_RCLONE_LOG"
printf ' %q' "$@" >> "$FAKE_RCLONE_LOG"
printf '\n' >> "$FAKE_RCLONE_LOG"
map_remote() { printf '%s/%s' "$FAKE_REMOTE_ROOT" "\${1#*:}"; }
case "$command_name" in
  copy)
    source_dir="$1"
    destination="$(map_remote "$2")"
    mkdir -p "$destination"
    files=("$source_dir"/*-"$BACKUP_STAMP")
    [[ "\${#files[@]}" == 5 ]]
    for file in "\${files[@]}"; do cp -- "$file" "$destination/"; done
    ;;
  check)
    source_dir="$1"
    destination="$(map_remote "$2")"
    files=("$source_dir"/*-"$BACKUP_STAMP")
    for file in "\${files[@]}"; do cmp -- "$file" "$destination/$(basename "$file")"; done
    ;;
  moveto)
    source_path="$(map_remote "$1")"
    destination="$(map_remote "$2")"
    mkdir -p "$(dirname "$destination")"
    mv -- "$source_path" "$destination"
    ;;
  size)
    source_path="$(map_remote "$1")"
    files=("$source_path"/*-"$BACKUP_STAMP")
    bytes=0
    for file in "\${files[@]}"; do
      file_size="$(stat -c '%s' -- "$file")"
      ((bytes += file_size))
    done
    printf '{"count":%d,"bytes":%d,"sizeless":0}\n' "\${#files[@]}" "$bytes"
    ;;
  touch)
    destination="$(map_remote "$1")"
    mkdir -p "$(dirname "$destination")"
    touch -- "$destination"
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
  *) exit 91 ;;
esac
`;

function artifactNames(stamp) {
  return [
    `timeline.dump-${stamp}`,
    `media.tar.gz-${stamp}`,
    `exports.tar.gz-${stamp}`,
    `SHA256SUMS-${stamp}`,
    `manifest.json-${stamp}`,
  ];
}

async function createHarness(t, currentStamp) {
  const root = await mkdtemp(join(tmpdir(), 'timeblog-retention-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binDir = join(root, 'bin');
  const backups = join(root, 'backups');
  const remoteRoot = join(root, 'remote');
  const backupPath = join(binDir, 'backup');
  const rclonePath = join(binDir, 'rclone');
  const backupLog = join(root, 'backup.log');
  const rcloneLog = join(root, 'rclone.log');
  await mkdir(binDir);
  await mkdir(backups);
  await mkdir(remoteRoot);
  await writeFile(backupPath, fakeBackup);
  await writeFile(rclonePath, fakeRclone);
  await writeFile(backupLog, '');
  await writeFile(rcloneLog, '');
  await chmod(backupPath, 0o700);
  await chmod(rclonePath, 0o700);

  const env = {
    ...process.env,
    BACKUP_DIR: backups,
    BACKUP_SCRIPT: backupPath,
    BACKUP_STAMP: currentStamp,
    FAKE_BACKUP_LOG: backupLog,
    FAKE_RCLONE_LOG: rcloneLog,
    FAKE_REMOTE_ROOT: remoteRoot,
    RCLONE_BIN: rclonePath,
    WEBDAV_BACKUP_LOCK: join(root, 'backup.lock'),
    WEBDAV_REMOTE: 'webdav:backups',
    LOCAL_RETENTION_COUNT: '2',
    REMOTE_RETENTION_COUNT: '2',
  };

  async function addManagedSnapshot(stamp) {
    const result = spawnSync(backupPath, [], { env: { ...env, BACKUP_STAMP: stamp }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const remoteSnapshot = join(remoteRoot, 'backups', stamp);
    await mkdir(remoteSnapshot, { recursive: true });
    for (const name of artifactNames(stamp)) {
      await copyFile(join(backups, name), join(remoteSnapshot, name));
    }
    await writeFile(join(remoteSnapshot, '_SUCCESS'), '');
  }

  return { root, backups, remoteRoot, backupLog, rcloneLog, env, addManagedSnapshot };
}

test('retention removes only oldest fully managed local and remote snapshots', async (t) => {
  const currentStamp = '20400104T000000Z';
  const harness = await createHarness(t, currentStamp);
  const oldStamps = ['20400101T000000Z', '20400102T000000Z', '20400103T000000Z'];
  for (const stamp of oldStamps) await harness.addManagedSnapshot(stamp);

  const unmanagedStamp = '20390101T000000Z';
  const unmanaged = join(harness.remoteRoot, 'backups', unmanagedStamp);
  await mkdir(unmanaged, { recursive: true });
  await writeFile(join(unmanaged, '_SUCCESS'), '');
  await writeFile(join(unmanaged, 'extra.txt'), 'do not delete');
  await mkdir(join(harness.remoteRoot, 'backups', '.incomplete-20380101T000000Z'), { recursive: true });
  await mkdir(join(harness.remoteRoot, 'backups', 'operator-notes'), { recursive: true });
  await writeFile(join(harness.backups, 'operator-note.txt'), 'do not delete');
  await writeFile(join(harness.backups, 'manifest.json-20380101T000000Z'), 'incomplete');

  const result = spawnSync(webdavScript, [], { env: harness.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, new RegExp(`unmanaged contents: ${unmanagedStamp}`));
  assert.match(result.stdout, /retention evaluated: local_keep=2 remote_keep=2 dry_run=0/);

  for (const stamp of oldStamps.slice(0, 2)) {
    await assert.rejects(stat(join(harness.backups, `manifest.json-${stamp}`)));
    await assert.rejects(stat(join(harness.remoteRoot, 'backups', stamp)));
  }
  for (const stamp of [oldStamps[2], currentStamp]) {
    assert.equal((await stat(join(harness.backups, `manifest.json-${stamp}`))).isFile(), true);
    assert.equal((await stat(join(harness.remoteRoot, 'backups', stamp, '_SUCCESS'))).isFile(), true);
  }
  assert.equal((await stat(join(unmanaged, 'extra.txt'))).isFile(), true);
  assert.equal((await stat(join(harness.remoteRoot, 'backups', '.incomplete-20380101T000000Z'))).isDirectory(), true);
  assert.equal((await stat(join(harness.remoteRoot, 'backups', 'operator-notes'))).isDirectory(), true);
  assert.equal((await stat(join(harness.backups, 'operator-note.txt'))).isFile(), true);
  assert.equal((await stat(join(harness.backups, 'manifest.json-20380101T000000Z'))).isFile(), true);
});

test('retention dry-run reports candidates without deleting them', async (t) => {
  const harness = await createHarness(t, '20400103T000000Z');
  await harness.addManagedSnapshot('20400101T000000Z');
  await harness.addManagedSnapshot('20400102T000000Z');
  const result = spawnSync(webdavScript, [], {
    env: { ...harness.env, BACKUP_RETENTION_DRY_RUN: '1' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /dry-run would remove local snapshot: 20400101T000000Z/);
  assert.match(result.stdout, /dry-run would remove remote snapshot: 20400101T000000Z/);
  assert.equal((await stat(join(harness.backups, 'manifest.json-20400101T000000Z'))).isFile(), true);
  assert.equal((await stat(join(harness.remoteRoot, 'backups', '20400101T000000Z'))).isDirectory(), true);
});

test('invalid retention relationship fails before creating a backup', async (t) => {
  const harness = await createHarness(t, '20400101T000000Z');
  const result = spawnSync(webdavScript, [], {
    env: { ...harness.env, LOCAL_RETENTION_COUNT: '7', REMOTE_RETENTION_COUNT: '2' },
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /REMOTE_RETENTION_COUNT must be greater/);
  assert.equal(await readFile(harness.backupLog, 'utf8'), '');
});

test('remote retention uses exact file deletion and empty-directory removal', async () => {
  const source = await readFile(webdavScript, 'utf8');
  assert.match(source, /rclone_transfer_flags[\s\S]*deletefile/);
  assert.match(source, /rmdir/);
  assert.doesNotMatch(source, /"\$RCLONE_BIN" purge/);
});
