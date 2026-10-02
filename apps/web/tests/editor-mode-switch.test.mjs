import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { after, test } from 'node:test';
import ts from 'typescript';
import { JSDOM } from 'jsdom';
import { act, createElement as h, useState } from 'react';
import { createRoot } from 'react-dom/client';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' });
for (const key of ['window', 'document', 'HTMLElement', 'Event', 'KeyboardEvent']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
after(() => dom.window.close());
const source = await fs.readFile(new URL('../app/admin/EditorModeSwitch.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
}).outputText.replace(/from (['"])([^'"]+)\1/g, (_, quote, specifier) => `from ${JSON.stringify(import.meta.resolve(specifier))}`);
const { default: EditorModeSwitch } = await import(`data:text/javascript,${encodeURIComponent(compiled)}`);

async function fixture(t, disabled = false) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const changes = [];
  function App() {
    const [mode, setMode] = useState('rich');
    return h(EditorModeSwitch, { id: 'editor-test', mode, disabled, onModeChange: next => { changes.push(next); setMode(next); } });
  }
  await act(async () => root.render(h(App)));
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  const press = async (target, key) => act(async () => target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })));
  return { host, changes, press, tabs: [...host.querySelectorAll('[role=tab]')] };
}

test('mode tabs preserve a single keyboard stop and move focus with arrow keys', async t => {
  const { host, tabs, changes, press } = await fixture(t);
  assert.equal(tabs[0].tabIndex, 0);
  assert.equal(tabs[1].tabIndex, -1);
  tabs[0].focus();
  await press(tabs[0], 'ArrowRight');
  assert.equal(document.activeElement, tabs[1]);
  assert.equal(tabs[1].getAttribute('aria-selected'), 'true');
  assert.equal(host.querySelectorAll('[role=tab][tabindex="0"]').length, 1);
  await press(tabs[1], 'Home');
  assert.equal(document.activeElement, tabs[0]);
  await press(tabs[0], 'End');
  assert.deepEqual(changes, ['markdown', 'rich', 'markdown']);
});

test('saving disables both pointer and keyboard mode changes', async t => {
  const { tabs, changes, press } = await fixture(t, true);
  assert.ok(tabs.every(tab => tab.disabled));
  await act(async () => tabs[1].click());
  await press(tabs[0], 'ArrowRight');
  assert.deepEqual(changes, []);
});
