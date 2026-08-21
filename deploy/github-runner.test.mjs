import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';

const manifestRoot = new URL('./k8s/github-runner/', import.meta.url);
const readManifest = (name) => readFile(new URL(name, manifestRoot), 'utf8');

const [deployment, configMap, kustomization, networkPolicy, pvc, serviceAccount, release, ci] = await Promise.all([
  readManifest('deployment.yaml'),
  readManifest('configmap.yaml'),
  readManifest('kustomization.yaml'),
  readManifest('networkpolicy.yaml'),
  readManifest('pvc.yaml'),
  readManifest('serviceaccount.yaml'),
  readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'),
  readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'),
]);

test('runner manifests are complete and kustomize-ordered', () => {
  for (const resource of ['namespace.yaml', 'serviceaccount.yaml', 'pvc.yaml', 'configmap.yaml', 'networkpolicy.yaml', 'deployment.yaml']) {
    assert.match(kustomization, new RegExp(`- ${resource.replace('.', '\\.')}`));
  }
  assert.match(kustomization, /^namespace: timeblog-ci$/m);
  assert.match(pvc, /kind: PersistentVolumeClaim/);
  assert.match(pvc, /storageClassName: local-path/);
  assert.match(pvc, /storage: 5Gi/);
  assert.match(serviceAccount, /automountServiceAccountToken: false/);
});

test('runner deployment has one amd64 replica and the required images', () => {
  assert.match(deployment, /^  replicas: 1$/m);
  assert.match(deployment, /^    type: Recreate$/m);
  assert.match(deployment, /image: ghcr\.io\/actions\/actions-runner:2\.336\.0/);
  assert.match(deployment, /image: docker:29\.6\.1-dind/);
  assert.match(deployment, /value: timeblog-build-amd64/);
  assert.match(deployment, /kubernetes\.io\/arch: amd64/);
  assert.match(deployment, /kubernetes\.io\/os: linux/);
});

test('runner configuration is persistent while work and Docker state are temporary', () => {
  assert.match(deployment, /name: runner-config[\s\S]*?persistentVolumeClaim:[\s\S]*?claimName: timeblog-github-runner-config/);
  assert.match(deployment, /name: runner-work[\s\S]*?emptyDir:[\s\S]*?sizeLimit: 4Gi/);
  assert.match(deployment, /name: dind-data[\s\S]*?emptyDir:[\s\S]*?sizeLimit: 20Gi/);
  assert.match(deployment, /mountPath: \/runner$/m);
  assert.match(deployment, /mountPath: \/runner\/_work$/m);
  assert.match(deployment, /mountPath: \/var\/lib\/docker$/m);
  assert.match(deployment, /limits:[\s\S]*?memory: 768Mi[\s\S]*?ephemeral-storage: 4Gi/);
  assert.match(deployment, /name: dind[\s\S]*?limits:[\s\S]*?memory: 2560Mi[\s\S]*?ephemeral-storage: 20Gi/);
});

test('only DIND is privileged and the Pod cannot use host or control-plane access', () => {
  assert.equal((deployment.match(/privileged: true/g) ?? []).length, 1);
  assert.match(deployment, /name: dind[\s\S]*?privileged: true/);
  assert.match(deployment, /name: runner[\s\S]*?privileged: false/);
  assert.match(deployment, /name: runner[\s\S]*?runAsUser: 1001[\s\S]*?runAsGroup: 1001[\s\S]*?runAsNonRoot: true/);
  assert.match(deployment, /initContainers:[\s\S]*?name: prepare-dind-certs[\s\S]*?privileged: false/);
  assert.doesNotMatch(deployment, /name: docker-cli/);
  assert.doesNotMatch(deployment, /^\s+hostPath:/m);
  assert.doesNotMatch(deployment, /^\s+hostNetwork:\s*true$/m);
  assert.doesNotMatch(deployment, /^\s+hostPID:\s*true$/m);
  assert.match(deployment, /node-role\.kubernetes\.io\/control-plane[\s\S]*?operator: DoesNotExist/);
  assert.match(deployment, /node-role\.kubernetes\.io\/master[\s\S]*?operator: DoesNotExist/);
  assert.match(deployment, /automountServiceAccountToken: false/);
  assert.match(networkPolicy, /kind: NetworkPolicy/);
  assert.match(networkPolicy, /policyTypes:[\s\S]*?- Ingress/);
  assert.match(networkPolicy, /policyTypes:[\s\S]*?- Egress/);
  assert.match(networkPolicy, /ingress: \[\]/);
  assert.match(networkPolicy, /protocol: UDP[\s\S]*?port: 53/);
  assert.match(networkPolicy, /protocol: TCP[\s\S]*?port: 443/);
});

test('registration entrypoint uses the optional one-time token only for a new PVC', () => {
  assert.match(deployment, /name: RUNNER_TOKEN[\s\S]*?secretKeyRef:[\s\S]*?optional: true/);
  assert.match(configMap, /if \[\[ ! -f "\$runner_root\/\.runner" \]\]/);
  assert.match(configMap, /--token "\$RUNNER_TOKEN"/);
  assert.match(configMap, /unset RUNNER_TOKEN/);
  assert.match(configMap, /exec "\$runner_root\/run\.sh"/);
  assert.match(configMap, /--labels "\$\{RUNNER_LABELS:-timeblog-build-amd64\}"/);
  assert.doesNotMatch(configMap, /--runnergroup/);
  assert.match(configMap, /DOCKER-in-Docker did not become ready/i);
  assert.match(deployment, /name: DOCKER_CERT_PATH[\s\S]*?value: \/certs\/client/);
  assert.match(deployment, /name: dind-certs[\s\S]*?mountPath: \/certs\/client[\s\S]*?subPath: client[\s\S]*?readOnly: true/);
});

test('release publish selects the runner through a repository variable while deploy stays hosted', () => {
  const publish = release.slice(release.indexOf('  publish:'), release.indexOf('  deploy:'));
  const deploy = release.slice(release.indexOf('  deploy:'));
  assert.match(publish, /github\.event\.workflow_run\.conclusion == 'success'/);
  assert.match(publish, /github\.event\.workflow_run\.event == 'push'/);
  assert.match(publish, /github\.event\.workflow_run\.head_branch == 'main'/);
  assert.match(publish, /runs-on: \$\{\{ vars\.TIMEBLOG_BUILD_RUNNER \|\| 'ubuntu-latest' \}\}/);
  assert.match(publish, /timeout-minutes: 60/);
  assert.match(deploy, /runs-on: ubuntu-latest/);
  assert.match(publish, /contents: read/);
  assert.match(publish, /packages: write/);
  assert.match(publish, /platforms: linux\/amd64/);
  assert.match(publish, /cache-from: type=gha,scope=timeblog-core/);
  assert.match(publish, /cache-from: type=gha,scope=timeblog-web/);
});

test('CI keeps untrusted work hosted and avoids duplicate main release builds', () => {
  const mainReleaseGuard = /if: \$\{\{ github\.event_name != 'push' \|\| github\.ref != 'refs\/heads\/main' \}\}/;
  const shouldValidateArtifacts = (eventName, ref) => eventName !== 'push' || ref !== 'refs/heads/main';
  const api = ci.slice(ci.indexOf('  api:'), ci.indexOf('  web:'));
  const web = ci.slice(ci.indexOf('  web:'), ci.indexOf('  container_contracts:'));
  const containers = ci.slice(ci.indexOf('  container_contracts:'));

  assert.equal(shouldValidateArtifacts('push', 'refs/heads/main'), false);
  assert.equal(shouldValidateArtifacts('push', 'refs/heads/feature'), true);
  assert.equal(shouldValidateArtifacts('pull_request', 'refs/pull/1/merge'), true);
  assert.equal((ci.match(/^    runs-on: ubuntu-latest$/gm) ?? []).length, 3);
  assert.doesNotMatch(ci, /TIMEBLOG_BUILD_RUNNER/);
  assert.doesNotMatch(api, /docker build/);
  assert.match(api, /node --test deploy\/compose\.test\.mjs deploy\/github-runner\.test\.mjs deploy\/nas-config-contract\.test\.mjs deploy\/production-ssh-preflight\.test\.mjs deploy\/release\.test\.mjs/);
  assert.match(web, /name: Validate the production web build outside main release/);
  assert.match(web, mainReleaseGuard);
  assert.match(containers, /^  container_contracts:$/m);
  assert.match(containers, mainReleaseGuard);
  assert.match(containers, /image: core[\s\S]*?context: services\/core[\s\S]*?dockerfile: services\/core\/Dockerfile/);
  assert.match(containers, /image: web[\s\S]*?context: \.[\s\S]*?dockerfile: apps\/web\/Dockerfile/);
  assert.match(containers, /run: docker build -f "\$DOCKERFILE" "\$BUILD_CONTEXT"/);
});

test('registration Secret is intentionally external to the repository', async () => {
  const names = await readdir(manifestRoot);
  assert.ok(!names.includes('secret.yaml'));
  assert.ok(!names.includes('secret.yml'));
  assert.doesNotMatch(deployment, /stringData:/);
  assert.doesNotMatch(deployment, /data:\s*\n\s+token:/);
});
