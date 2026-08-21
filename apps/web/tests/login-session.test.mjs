import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const moduleStubs = {
  react: {
    createContext: () => ({ Provider: Symbol('Provider') }),
    useCallback: callback => callback,
    useContext: () => null,
    useEffect: () => undefined,
    useMemo: factory => factory(),
    useRef: value => ({ current: value }),
    useState: value => [value, () => undefined],
  },
  'react/jsx-runtime': {
    Fragment: Symbol('Fragment'),
    jsx: () => null,
    jsxs: () => null,
  },
  'next/link': () => null,
  'next/navigation': { useRouter: () => ({}) },
  '@/lib/api': { API: '/api/v1' },
  '../SessionContext': { useSession: () => ({ refreshSession: async () => ({ authenticated: false, csrfToken: '' }) }) },
};

async function loadTypeScriptModule(relativeURL, exposedNames = [], stubOverrides = {}) {
  const sourceURL = new URL(relativeURL, import.meta.url);
  const source = await fs.readFile(sourceURL, 'utf8');
  const compiled = ts.transpileModule(source, {
    fileName: sourceURL.pathname,
    compilerOptions: {
      esModuleInterop: true,
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    reportDiagnostics: true,
  });
  const diagnostics = compiled.diagnostics?.filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error) ?? [];
  assert.deepEqual(diagnostics, [], `transpile diagnostics for ${sourceURL.pathname}`);

  const loadedModule = { exports: {} };
  const stubs = { ...moduleStubs, ...stubOverrides };
  const requireStub = specifier => {
    if (Object.hasOwn(stubs, specifier)) return stubs[specifier];
    throw new Error(`unexpected import while loading ${sourceURL.pathname}: ${specifier}`);
  };
  const exposeForTest = exposedNames.map(name => `exports.${name} = ${name};`).join('\n');
  const evaluate = vm.compileFunction(`${compiled.outputText}\n${exposeForTest}`, ['require', 'module', 'exports'], { filename: sourceURL.pathname });
  evaluate(requireStub, loadedModule, loadedModule.exports);
  return loadedModule.exports;
}

const sessionModule = await loadTypeScriptModule('../app/SessionContext.tsx');
const loginModule = await loadTypeScriptModule('../app/login/page.tsx', ['resolveSuccessfulLogin']);

function createProviderHarness() {
  const effects = [];
  const stateUpdates = [];
  const stateNames = ['state', 'csrfToken', 'busy', 'feedback'];
  let stateIndex = 0;
  const Provider = Symbol('SessionContext.Provider');
  return {
    effects,
    stateUpdates,
    react: {
      createContext: () => ({ Provider }),
      useCallback: callback => callback,
      useContext: () => null,
      useEffect: effect => effects.push(effect),
      useMemo: factory => factory(),
      useRef: value => ({ current: value }),
      useState: value => {
        const name = stateNames[stateIndex++];
        return [value, nextValue => stateUpdates.push({ name, value: nextValue })];
      },
    },
    runtime: {
      Fragment: Symbol('Fragment'),
      jsx: (type, props) => ({ type, props }),
      jsxs: (type, props) => ({ type, props }),
    },
  };
}

test('session status request includes credentials and normalizes an authenticated response', async () => {
  let request;
  const result = await sessionModule.requestSessionStatus(async (url, init) => {
    request = { url, init };
    return new Response(JSON.stringify({ authenticated: true, csrfToken: 'csrf-token' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });

  assert.equal(request.url, '/api/v1/auth/session/status');
  assert.equal(request.init.cache, 'no-store');
  assert.equal(request.init.credentials, 'include');
  assert.equal(request.init.headers.Accept, 'application/json');
  assert.deepEqual(result, { authenticated: true, csrfToken: 'csrf-token' });
});

test('session status maps 401 and authenticated=false to an anonymous snapshot', async () => {
  const unauthorized = await sessionModule.requestSessionStatus(async () => new Response(null, { status: 401 }));
  const anonymous = await sessionModule.requestSessionStatus(async () => new Response(
    JSON.stringify({ authenticated: false, csrfToken: 'must-not-leak' }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  ));

  assert.deepEqual(unauthorized, { authenticated: false, csrfToken: '' });
  assert.deepEqual(anonymous, { authenticated: false, csrfToken: '' });
});

test('session status rejects server errors and malformed success bodies', async () => {
  await assert.rejects(
    sessionModule.requestSessionStatus(async () => new Response(null, { status: 503 })),
    /session 503/,
  );
  await assert.rejects(
    sessionModule.requestSessionStatus(async () => new Response('not-json', { status: 200 })),
    SyntaxError,
  );
});

test('SessionProvider applies only the latest refresh and ignores writes after unmount', async () => {
  const harness = createProviderHarness();
  const pendingResponses = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Promise(resolve => pendingResponses.push(resolve));
  try {
    const providerModule = await loadTypeScriptModule('../app/SessionContext.tsx', [], {
      react: harness.react,
      'react/jsx-runtime': harness.runtime,
    });
    const rendered = providerModule.SessionProvider({ children: null });
    const refreshSession = rendered.props.value.refreshSession;
    const cleanup = harness.effects[0]();
    assert.equal(pendingResponses.length, 1, 'mount starts the initial session probe');

    const latestRefresh = refreshSession();
    assert.equal(pendingResponses.length, 2, 'explicit refresh does not reuse a pre-login probe');
    pendingResponses[1](new Response(
      JSON.stringify({ authenticated: true, csrfToken: 'latest-csrf' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    assert.deepEqual(await latestRefresh, { authenticated: true, csrfToken: 'latest-csrf' });
    pendingResponses[0](new Response(null, { status: 401 }));
    await new Promise(resolve => setImmediate(resolve));

    assert.deepEqual(
      harness.stateUpdates.filter(update => update.name === 'state').map(update => update.value),
      ['authenticated'],
      'the stale anonymous response must not overwrite the explicit login refresh',
    );

    cleanup();
    const updatesBeforeUnmountedRefresh = harness.stateUpdates.length;
    const afterUnmount = refreshSession();
    pendingResponses[2](new Response(
      JSON.stringify({ authenticated: true, csrfToken: 'after-unmount' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    await afterUnmount;
    assert.equal(harness.stateUpdates.length, updatesBeforeUnmountedRefresh);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('password success keeps a returned TOTP challenge without probing a session', async () => {
  let refreshCalls = 0;
  const result = await loginModule.resolveSuccessfulLogin(
    1,
    new Response(JSON.stringify({ challenge: ' challenge-id ', requiresTotp: true }), { status: 200 }),
    async () => {
      refreshCalls += 1;
      return { authenticated: true, csrfToken: 'unused' };
    },
  );

  assert.deepEqual(result, { kind: 'challenge', challenge: 'challenge-id' });
  assert.equal(refreshCalls, 0);
});

test('password-only success confirms the server session before authenticating', async () => {
  let refreshCalls = 0;
  const result = await loginModule.resolveSuccessfulLogin(
    1,
    new Response(JSON.stringify({ authenticated: true, requiresTotp: false }), { status: 200 }),
    async () => {
      refreshCalls += 1;
      return { authenticated: true, csrfToken: 'csrf-token' };
    },
  );

  assert.deepEqual(result, { kind: 'authenticated' });
  assert.equal(refreshCalls, 1);
});

test('TOTP success ignores its body and trusts only the refreshed session status', async () => {
  const authenticated = await loginModule.resolveSuccessfulLogin(
    2,
    new Response('not-json', { status: 200 }),
    async () => ({ authenticated: true, csrfToken: 'csrf-token' }),
  );
  const missing = await loginModule.resolveSuccessfulLogin(
    2,
    new Response(JSON.stringify({ authenticated: true }), { status: 200 }),
    async () => ({ authenticated: false, csrfToken: '' }),
  );

  assert.deepEqual(authenticated, { kind: 'authenticated' });
  assert.deepEqual(missing, { kind: 'session-missing' });
});

test('password response without a challenge supports password-only deployments', async () => {
  const result = await loginModule.resolveSuccessfulLogin(
    1,
    new Response(null, { status: 200 }),
    async () => ({ authenticated: true, csrfToken: 'csrf-token' }),
  );

  assert.deepEqual(result, { kind: 'authenticated' });
});
