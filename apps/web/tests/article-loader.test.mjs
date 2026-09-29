import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

async function compileTypeScriptModule(relativeURL) {
  const sourceURL = new URL(relativeURL, import.meta.url);
  const source = await fs.readFile(sourceURL, 'utf8');
  const compiled = ts.transpileModule(source, {
    fileName: sourceURL.pathname,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    reportDiagnostics: true,
  });
  const diagnostics = compiled.diagnostics?.filter(
    diagnostic => diagnostic.category === ts.DiagnosticCategory.Error,
  ) ?? [];
  assert.deepEqual(diagnostics, [], `transpile diagnostics for ${sourceURL.pathname}`);

  return vm.compileFunction(
    compiled.outputText,
    ['require', 'module', 'exports', 'fetch', 'AbortSignal', 'process'],
    { filename: sourceURL.pathname },
  );
}

const evaluateAPI = await compileTypeScriptModule('../lib/api.ts');
const evaluateLoader = await compileTypeScriptModule('../lib/article-loader.ts');

function createHarness(t, fetcher) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = [];
  const signals = [];
  const timeouts = [];
  // Inject dependencies only into these VM modules, never patch global fetch.
  const fetchStub = async (url, init) => {
    calls.push({ url: String(url), init });
    return fetcher(url, init);
  };
  const timeoutSignal = {
    timeout(milliseconds) {
      const controller = new AbortController();
      timeouts.push(milliseconds);
      signals.push(controller.signal);
      setTimeout(() => {
        controller.abort(new DOMException('The request timed out', 'TimeoutError'));
      }, milliseconds);
      return controller.signal;
    },
  };
  const instantiate = (evaluate, imports = {}) => {
    const loadedModule = { exports: {} };
    const requireStub = specifier => {
      assert.ok(Object.hasOwn(imports, specifier), `unexpected import: ${specifier}`);
      return imports[specifier];
    };
    evaluate(
      requireStub, loadedModule, loadedModule.exports, fetchStub, timeoutSignal,
      { env: { NEXT_PUBLIC_API_URL: '/api/v1' } },
    );
    return loadedModule.exports;
  };
  const api = instantiate(evaluateAPI);
  const loader = instantiate(evaluateLoader, { './api': api });
  return { api, loader, calls, signals, timeouts };
}

function article(overrides = {}) {
  return {
    id: 'article-1',
    kind: 'article',
    visibility: 'public',
    title: '读取文章',
    slug: 'article-1',
    journalDate: '2026-09-29',
    renderedHtml: '<p>正文</p>',
    ...overrides,
  };
}

function response(body = article()) {
  return { ok: true, status: 200, json: async () => body };
}

function rejectOnAbort(signal, error) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(error ?? signal.reason);
      return;
    }
    signal.addEventListener('abort', () => reject(error ?? signal.reason), { once: true });
  });
}

test('APIError preserves the HTTP status and existing API message', t => {
  const { api } = createHarness(t, async () => response());
  const error = new api.APIError(503);
  assert.ok(error instanceof Error);
  assert.equal(error.name, 'APIError');
  assert.equal(error.status, 503);
  assert.equal(error.message, 'API 503');
});

test('getArticle forwards the exact optional signal and preserves no-store and normalization', async t => {
  const expected = article();
  const { api, calls, timeouts } = createHarness(t, async () => response(expected));
  const signal = new AbortController().signal;
  const decoded = '文章阅读';
  const encoded = encodeURIComponent(decoded);
  assert.equal(await api.getArticle(encoded, signal), expected);
  assert.equal(await api.getArticle(decoded), expected);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.url, `/api/v1/public/articles/${encoded}`);
    assert.equal(call.init.cache, 'no-store');
    assert.equal(call.init.headers.Accept, 'application/json');
  }
  assert.equal(calls[0].init.signal, signal);
  assert.equal(calls[1].init.signal, undefined);
  assert.deepEqual(timeouts, []);
});

test('getJSON produces APIError for non-ok responses without parsing the error body', async t => {
  const { api } = createHarness(t, async () => ({
    ok: false, status: 404,
    json: () => assert.fail('error bodies must not be exposed'),
  }));
  await assert.rejects(api.getArticle('missing'), error => {
    assert.ok(error instanceof api.APIError);
    assert.equal(error.status, 404);
    assert.equal(error.message, 'API 404');
    return true;
  });
});

test('loadArticle returns ready with the original article and a ten-second fetch signal', async t => {
  const expected = article({ placeholder: false });
  const { loader, calls, signals, timeouts } = createHarness(t, async () => response(expected));
  assert.deepEqual(await loader.loadArticle('article-1'), { status: 'ready', article: expected });
  assert.equal(loader.ARTICLE_TIMEOUT_MS, 10_000);
  assert.deepEqual(timeouts, [10_000]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.signal, signals[0]);
  assert.ok(signals[0] instanceof AbortSignal);
  assert.equal(signals[0].aborted, false);
  assert.equal(calls[0].init.cache, 'no-store');
});

for (const status of [404, 410]) {
  test(`loadArticle maps HTTP ${status} to not-found`, async t => {
    const { loader } = createHarness(t, async () => ({ ok: false, status }));
    assert.deepEqual(await loader.loadArticle('missing'), { status: 'not-found' });
  });
}

test('loadArticle hides placeholder articles as not-found', async t => {
  const { loader } = createHarness(t, async () => response(article({ placeholder: true })));
  assert.deepEqual(await loader.loadArticle('hidden'), { status: 'not-found' });
});

for (const status of [401, 403, 408, 429, 500, 504]) {
  test(`loadArticle maps HTTP ${status} to failed rather than timeout or not-found`, async t => {
    const { loader } = createHarness(t, async () => ({ ok: false, status }));
    assert.deepEqual(await loader.loadArticle('article-1'), { status: 'failed' });
  });
}

test('loadArticle hides network errors instead of throwing or leaking details', async t => {
  const { loader } = createHarness(t, async () => {
    throw new TypeError('private upstream network detail');
  });
  assert.deepEqual(await loader.loadArticle('article-1'), { status: 'failed' });
});

test('loadArticle hides JSON parsing errors', async t => {
  const { loader } = createHarness(t, async () => ({
    ok: true, status: 200,
    json: async () => { throw new SyntaxError('private response contents'); },
  }));
  assert.deepEqual(await loader.loadArticle('article-1'), { status: 'failed' });
});

test('loadArticle recognizes TimeoutError even when the signal has not fired', async t => {
  const { loader, signals } = createHarness(t, async () => {
    throw new DOMException('private timeout detail', 'TimeoutError');
  });
  assert.deepEqual(await loader.loadArticle('article-1'), { status: 'timeout' });
  assert.equal(signals[0].aborted, false);
});

test('loadArticle does not misclassify an unrelated AbortError as a timeout', async t => {
  const { loader } = createHarness(t, async () => {
    throw new DOMException('unrelated abort', 'AbortError');
  });
  assert.deepEqual(await loader.loadArticle('article-1'), { status: 'failed' });
});

test('loadArticle does not infer HTTP status from arbitrary error text or properties', async t => {
  const { loader } = createHarness(t, async () => {
    throw Object.assign(new Error('API 404'), { status: 404 });
  });
  assert.deepEqual(await loader.loadArticle('article-1'), { status: 'failed' });
});

test('loadArticle rejects invalid identifiers without requesting or allocating a timeout', async t => {
  const { loader, calls, timeouts } = createHarness(t, async () => {
    assert.fail('invalid identifiers must not fetch');
  });
  for (const slug of ['', '   ', 'bad%ZZ', '%', '%20%20']) {
    assert.deepEqual(await loader.loadArticle(slug), { status: 'not-found' });
  }
  assert.deepEqual(calls, []);
  assert.deepEqual(timeouts, []);
});

test('loadArticle validates without decoding the identifier twice', async t => {
  const { loader, calls } = createHarness(t, async () => response());
  for (const slug of ['文章阅读', encodeURIComponent('文章阅读'), '100%25', '%252F']) {
    const result = await loader.loadArticle(slug);
    assert.equal(result.status, 'ready');
    assert.equal(calls.at(-1).url, `/api/v1/public/articles/${encodeURIComponent(decodeURIComponent(slug))}`);
  }
});

test('loadArticle times out pending response headers using a fake clock', async t => {
  const { loader, signals } = createHarness(t, async (url, init) => rejectOnAbort(init.signal));
  const pending = loader.loadArticle('article-1');
  t.mock.timers.tick(9_999);
  assert.equal(signals[0].aborted, false);
  t.mock.timers.tick(1);
  assert.deepEqual(await pending, { status: 'timeout' });
  assert.equal(signals[0].aborted, true);
});

test('the same timeout remains active while response.json reads the body', async t => {
  let bodyStarted;
  const readingBody = new Promise(resolve => { bodyStarted = resolve; });
  const { loader, calls, signals } = createHarness(t, async (url, init) => ({
    ok: true, status: 200,
    json: () => {
      bodyStarted();
      return rejectOnAbort(init.signal, new DOMException('body interrupted', 'AbortError'));
    },
  }));
  const pending = loader.loadArticle('article-1');
  await readingBody;
  assert.equal(calls[0].init.signal, signals[0]);
  t.mock.timers.tick(9_999);
  assert.equal(signals[0].aborted, false);
  t.mock.timers.tick(1);
  assert.deepEqual(await pending, { status: 'timeout' });
  assert.equal(signals[0].aborted, true);
});

test('loadArticle does not memoize requests or share signals between calls', async t => {
  let count = 0;
  const { loader, calls, signals, timeouts } = createHarness(t, async () => response(article({ title: `read-${++count}` })));
  const first = await loader.loadArticle('article-1');
  const second = await loader.loadArticle('article-1');
  assert.equal(first.status, 'ready');
  assert.equal(second.status, 'ready');
  assert.equal(first.article.title, 'read-1');
  assert.equal(second.article.title, 'read-2');
  assert.equal(calls.length, 2);
  assert.notEqual(signals[0], signals[1]);
  assert.deepEqual(timeouts, [10_000, 10_000]);
});
