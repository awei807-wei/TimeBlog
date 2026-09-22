import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

async function loadTypeScriptModule(relativeURL) {
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
  const diagnostics = compiled.diagnostics?.filter(
    diagnostic => diagnostic.category === ts.DiagnosticCategory.Error,
  ) ?? [];
  assert.deepEqual(diagnostics, [], `transpile diagnostics for ${sourceURL.pathname}`);

  const loadedModule = { exports: {} };
  const requireStub = specifier => {
    throw new Error(`unexpected import while loading ${sourceURL.pathname}: ${specifier}`);
  };
  const evaluate = vm.compileFunction(compiled.outputText, ['require', 'module', 'exports'], {
    filename: sourceURL.pathname,
  });
  evaluate(requireStub, loadedModule, loadedModule.exports);
  return loadedModule.exports;
}

const digitalAssets = await loadTypeScriptModule('../lib/digital-assets.ts');
const previousAPIURL = process.env.NEXT_PUBLIC_API_URL;
process.env.NEXT_PUBLIC_API_URL = '/api/v1';
const api = await loadTypeScriptModule('../lib/api.ts');
if (previousAPIURL === undefined) delete process.env.NEXT_PUBLIC_API_URL;
else process.env.NEXT_PUBLIC_API_URL = previousAPIURL;

function asset(overrides = {}) {
  return {
    id: 'asset-1',
    name: 'example.com',
    startDate: '2026-01-01',
    endDate: '2026-12-31',
    renewalPrice: 128.5,
    renewalUrl: 'https://example.com/renew',
    ...overrides,
  };
}

function validForm(overrides = {}) {
  return {
    name: 'example.com',
    startDate: '2026-09-23',
    endDate: '2026-09-23',
    renewalPrice: '128.50',
    renewalUrl: 'https://example.com/renew',
    ...overrides,
  };
}

test('UTC calendar parsing accepts real padded dates and rejects impossible or loose dates', () => {
  const leapDay = digitalAssets.parseUTCDate('2024-02-29');
  assert.notEqual(leapDay, null);
  assert.equal(digitalAssets.formatUTCDate(leapDay), '2024-02-29');
  assert.equal(digitalAssets.parseUTCDate('2026-02-30'), null);
  assert.equal(digitalAssets.parseUTCDate('2026-2-03'), null);
  assert.equal(digitalAssets.parseUTCDate('2026-02-3'), null);
  assert.equal(digitalAssets.parseUTCDate('not-a-date'), null);
});

test('Shanghai today is derived independently from the runtime local timezone', () => {
  assert.equal(
    digitalAssets.todayInShanghai(new Date('2026-09-22T16:00:00.000Z')),
    '2026-09-23',
  );
});

test('empty data produces a one-day range anchored to today', () => {
  assert.deepEqual(digitalAssets.buildDigitalAssetRange([], '2026-09-23'), {
    startDate: '2026-09-23',
    endDate: '2026-09-23',
    startDay: digitalAssets.parseUTCDate('2026-09-23'),
    endDay: digitalAssets.parseUTCDate('2026-09-23'),
    totalDays: 1,
  });
});

test('asset ranges always include today before future data and after expired data', () => {
  const future = digitalAssets.buildDigitalAssetRange([
    asset({ startDate: '2027-01-01', endDate: '2027-02-01' }),
  ], '2026-09-23');
  assert.equal(future.startDate, '2026-09-23');
  assert.equal(future.endDate, '2027-02-01');

  const expired = digitalAssets.buildDigitalAssetRange([
    asset({ startDate: '2025-01-01', endDate: '2025-12-31' }),
  ], '2026-09-23');
  assert.equal(expired.startDate, '2025-01-01');
  assert.equal(expired.endDate, '2026-09-23');
});

test('cross-year ranges use UTC day counts and expose the new-year timeline tick', () => {
  const range = digitalAssets.buildDigitalAssetRange([
    asset({ startDate: '2025-12-31', endDate: '2026-01-02' }),
  ], '2025-12-31');
  const ticks = digitalAssets.buildDigitalAssetTimelineTicks(range);

  assert.equal(range.totalDays, 3);
  assert.equal(range.startDate, '2025-12-31');
  assert.equal(range.endDate, '2026-01-02');
  assert.ok(ticks.some(tick => tick.date === '2026-01-01' && tick.label === '2026年1月'));
});

test('single-day assets keep a minimum visible bar without leaving the track', () => {
  const singleDay = asset({ id: 'single', startDate: '2026-01-01', endDate: '2026-01-01' });
  const range = digitalAssets.buildDigitalAssetRange([
    singleDay,
    asset({ id: 'late', startDate: '2026-12-31', endDate: '2026-12-31' }),
  ], '2026-09-23');
  const bar = digitalAssets.digitalAssetBar(singleDay, range, 640);

  assert.ok(bar.width >= digitalAssets.DIGITAL_ASSET_MIN_BAR_WIDTH);
  assert.ok(bar.left >= 0);
  assert.ok(bar.left + bar.width <= 640);
});

test('status classification covers active, thirty-day expiry, expired and upcoming assets', () => {
  const today = '2026-09-23';
  assert.equal(digitalAssets.digitalAssetStatus(
    asset({ startDate: '2026-01-01', endDate: '2026-10-24' }),
    today,
  ), 'active');
  assert.equal(digitalAssets.digitalAssetStatus(
    asset({ startDate: '2026-01-01', endDate: '2026-10-23' }),
    today,
  ), 'expiring');
  assert.equal(digitalAssets.digitalAssetStatus(
    asset({ startDate: '2026-01-01', endDate: '2026-09-22' }),
    today,
  ), 'expired');
  assert.equal(digitalAssets.digitalAssetStatus(
    asset({ startDate: '2026-09-24', endDate: '2026-12-31' }),
    today,
  ), 'upcoming');
});

test('form validation permits a single-day asset and returns all five normalized fields', () => {
  const result = digitalAssets.validateDigitalAssetForm(validForm({
    name: '  example.com  ',
    renewalUrl: '  https://example.com/renew  ',
  }));

  assert.deepEqual(result.errors, {});
  assert.deepEqual(result.payload, {
    name: 'example.com',
    startDate: '2026-09-23',
    endDate: '2026-09-23',
    renewalPrice: 128.5,
    renewalUrl: 'https://example.com/renew',
  });
});

test('form validation rejects invalid names, dates, prices and non-HTTP URLs', () => {
  assert.match(
    digitalAssets.validateDigitalAssetForm(validForm({ name: ' ' })).errors.name,
    /名称/,
  );
  assert.match(
    digitalAssets.validateDigitalAssetForm(validForm({ endDate: '2026-09-22' })).errors.endDate,
    /不能早于/,
  );
  assert.match(
    digitalAssets.validateDigitalAssetForm(validForm({ renewalPrice: '-1' })).errors.renewalPrice,
    /非负数字/,
  );
  assert.match(
    digitalAssets.validateDigitalAssetForm(validForm({ renewalPrice: '1.234' })).errors.renewalPrice,
    /两位小数/,
  );
  assert.match(
    digitalAssets.validateDigitalAssetForm(validForm({ renewalPrice: '10000000000.00' })).errors.renewalPrice,
    /不能超过/,
  );
  assert.match(
    digitalAssets.validateDigitalAssetForm(validForm({ renewalUrl: 'ftp://example.com/renew' })).errors.renewalUrl,
    /HTTP 或 HTTPS/,
  );
});

test('renewal prices are displayed with exactly two decimals and no currency suffix', () => {
  assert.equal(digitalAssets.formatRenewalPrice(2), '2.00');
  assert.equal(digitalAssets.formatRenewalPrice(2.5), '2.50');
  assert.equal(digitalAssets.formatRenewalPrice(128.567), '128.57');
});

test('digital asset requests are allowed only for the authenticated session state', () => {
  assert.equal(digitalAssets.canRequestDigitalAssets('authenticated'), true);
  assert.equal(digitalAssets.canRequestDigitalAssets('loading'), false);
  assert.equal(digitalAssets.canRequestDigitalAssets('anonymous'), false);
  assert.equal(digitalAssets.canRequestDigitalAssets('error'), false);
});

test('GET uses the admin collection path, included credentials and no-store caching', async () => {
  let request;
  const records = [asset()];
  const result = await api.getDigitalAssets(undefined, async (url, init) => {
    request = { url, init };
    return new Response(JSON.stringify({ digitalAssets: records }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });

  assert.equal(request.url, '/api/v1/admin/digital-assets');
  assert.equal(request.init.method, 'GET');
  assert.equal(request.init.credentials, 'include');
  assert.equal(request.init.cache, 'no-store');
  assert.equal(request.init.headers.Accept, 'application/json');
  assert.deepEqual(result, records);
});

test('POST and PATCH send complete JSON payloads with CSRF and included credentials', async () => {
  const requests = [];
  const payload = {
    name: 'example.com',
    startDate: '2026-09-23',
    endDate: '2027-09-23',
    renewalPrice: 128.5,
    renewalUrl: 'https://example.com/renew',
  };
  const fetcher = async (url, init) => {
    requests.push({ url, init });
    return new Response(JSON.stringify(asset({ ...payload, id: 'saved-id' })), {
      status: init.method === 'POST' ? 201 : 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  await api.createDigitalAsset(payload, 'csrf-token', fetcher);
  await api.updateDigitalAsset('asset/id with space', payload, 'csrf-token', fetcher);

  assert.equal(requests[0].url, '/api/v1/admin/digital-assets');
  assert.equal(requests[0].init.method, 'POST');
  assert.equal(requests[1].url, '/api/v1/admin/digital-assets/asset%2Fid%20with%20space');
  assert.equal(requests[1].init.method, 'PATCH');
  for (const request of requests) {
    assert.equal(request.init.credentials, 'include');
    assert.equal(request.init.cache, 'no-store');
    assert.equal(request.init.headers.Accept, 'application/json');
    assert.equal(request.init.headers['Content-Type'], 'application/json');
    assert.equal(request.init.headers['X-CSRF-Token'], 'csrf-token');
    assert.deepEqual(JSON.parse(request.init.body), payload);
  }
});

test('problem+json failures prefer detail over title', async () => {
  await assert.rejects(
    () => api.createDigitalAsset(
      {
        name: 'example.com',
        startDate: '2026-09-23',
        endDate: '2027-09-23',
        renewalPrice: 128.5,
        renewalUrl: 'https://example.com/renew',
      },
      'csrf-token',
      async () => new Response(JSON.stringify({
        title: 'Validation failed',
        detail: '续费地址必须是有效的 HTTP 或 HTTPS URL。',
      }), {
        status: 422,
        headers: { 'Content-Type': 'application/problem+json' },
      }),
    ),
    error => {
      assert.equal(error.message, '续费地址必须是有效的 HTTP 或 HTTPS URL。');
      return true;
    },
  );
});

test('DELETE sends CSRF with included credentials and never parses a 204 response body', async () => {
  let request;
  let jsonCalls = 0;
  await api.deleteDigitalAsset('asset/id with space', 'csrf-token', async (url, init) => {
    request = { url, init };
    return {
      ok: true,
      status: 204,
      json: async () => {
        jsonCalls += 1;
        throw new Error('204 body must not be parsed');
      },
    };
  });

  assert.equal(request.url, '/api/v1/admin/digital-assets/asset%2Fid%20with%20space');
  assert.equal(request.init.method, 'DELETE');
  assert.equal(request.init.credentials, 'include');
  assert.equal(request.init.cache, 'no-store');
  assert.equal(request.init.headers.Accept, 'application/json');
  assert.equal(request.init.headers['X-CSRF-Token'], 'csrf-token');
  assert.equal(request.init.body, undefined);
  assert.equal(jsonCalls, 0);
});

test('calendar component contracts enforce authentication gating and safe external links', async () => {
  const component = await fs.readFile(
    new URL('../app/calendar/DigitalAssetGantt.tsx', import.meta.url),
    'utf8',
  );
  const calendarView = await fs.readFile(
    new URL('../app/calendar/CalendarView.tsx', import.meta.url),
    'utf8',
  );
  const styles = await fs.readFile(
    new URL('../app/public-views.css', import.meta.url),
    'utf8',
  );

  assert.match(component, /const \{ state, csrfToken \} = useSession\(\)/);
  assert.match(
    component,
    /if \(canRequestDigitalAssets\(state\)\) \{\s*return <AuthenticatedDigitalAssetGantt key=\{csrfToken\} csrfToken=\{csrfToken\} \/>;/,
  );
  assert.match(
    component,
    /function AuthenticatedDigitalAssetGantt[\s\S]*?getDigitalAssets\(controller\.signal\)[\s\S]*?<div className="digital-assets-manager"/,
  );
  assert.match(component, /state === 'anonymous'[\s\S]*匿名访问不会请求管理员数字资产接口/);
  assert.match(component, /<label htmlFor=\{`\$\{formId\}-name`\}>资产名称<\/label>/);
  assert.match(component, /<input id=\{`\$\{formId\}-start`\} type="date"/);
  assert.match(component, /<input id=\{`\$\{formId\}-end`\} type="date"/);
  assert.match(component, /<input id=\{`\$\{formId\}-price`\} type="number"[\s\S]*?min="0"[\s\S]*?step="0\.01"/);
  assert.match(component, /<input id=\{`\$\{formId\}-url`\} type="url"/);
  assert.match(component, /target="_blank" rel="noopener noreferrer"/);
  assert.match(component, /window\.confirm\(/);
  assert.match(calendarView, /import DigitalAssetGantt from '\.\/DigitalAssetGantt'/);
  assert.match(calendarView, /<DigitalAssetGantt \/>/);
  assert.match(styles, /\.digital-assets-scroll\s*\{[\s\S]*?overflow-x:\s*auto;/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.digital-assets-bar \{ transition: none; \}/);
});
