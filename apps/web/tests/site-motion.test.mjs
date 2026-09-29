import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import React, { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import ts from 'typescript';
import postcss from 'postcss';

const require = createRequire(import.meta.url);
const source = await fs.readFile(new URL('../app/AppMotion.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
function load(navigation = {}) {
  const mod = { exports: {} };
  vm.compileFunction(compiled, ['require', 'module', 'exports'])(id => id === 'next/navigation' ? navigation : require(id), mod, mod.exports);
  return mod.exports;
}
const { installPressFeedback } = load();
function controls(t) {
  const dom = new JSDOM('<body><input id="text"><button id="button" aria-pressed="true"><span>保存</span></button><button disabled id="disabled">禁用</button><button aria-disabled="true" id="aria">禁用</button><div inert><button id="inert">禁用</button></div><a id="link" href="#next">导航</a><div cmdk-item data-disabled="false" id="command">命令</div><div contenteditable="true" id="editor">正文</div><input type="submit" id="submit"></body>');
  const doc = dom.window.document;
  const cleanup = installPressFeedback(doc, dom.window);
  t.after(() => { cleanup(); dom.window.close(); });
  const get = id => doc.getElementById(id);
  const pointer = (type, element, options = {}) => {
    const event = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: 5, clientY: 5, ...options });
    Object.defineProperties(event, { pointerId: { value: options.pointerId ?? 1 }, isPrimary: { value: options.isPrimary ?? true } });
    element.dispatchEvent(event);
    assert.equal(event.defaultPrevented, false, 'visual feedback never consumes an action');
  };
  const keyboard = (type, element, key, options = {}) => element.dispatchEvent(new dom.window.KeyboardEvent(type, { key, bubbles: true, cancelable: true, ...options }));
  return { dom, doc, get, pointer, keyboard, cleanup, pressed: id => get(id).hasAttribute('data-press-feedback') };
}

test('presses release immediately without changing persistent selected state', t => {
  const ui = controls(t);
  ui.pointer('pointerdown', ui.get('button').firstChild);
  assert.equal(ui.pressed('button'), true);
  ui.get('text').dispatchEvent(new ui.dom.window.FocusEvent('focusout', { bubbles: true }));
  assert.equal(ui.pressed('button'), true, 'an unrelated field blur must not cancel a new press');
  ui.pointer('pointerup', ui.doc.body);
  assert.equal(ui.pressed('button'), false);
  assert.equal(ui.get('button').getAttribute('aria-pressed'), 'true');
  ui.pointer('pointerdown', ui.get('command'));
  assert.equal(ui.pressed('command'), true, 'data-disabled=false is enabled');
  ui.pointer('pointercancel', ui.get('command'));
  assert.equal(ui.pressed('command'), false);
});

test('disabled controls, editable text, right click and secondary touch never depress', t => {
  const ui = controls(t);
  for (const id of ['disabled', 'aria', 'inert', 'text', 'editor']) {
    ui.pointer('pointerdown', ui.get(id));
    assert.equal(ui.pressed(id), false, id);
  }
  ui.pointer('pointerdown', ui.get('button'), { button: 2 });
  assert.equal(ui.pressed('button'), false);
  ui.pointer('pointerdown', ui.get('button'), { isPrimary: false });
  assert.equal(ui.pressed('button'), false);
  ui.pointer('pointerdown', ui.get('submit'));
  assert.equal(ui.pressed('submit'), true);
});

test('touch scrolling, pointer exit, focus loss, window blur and cleanup clear feedback', t => {
  const ui = controls(t);
  ui.pointer('pointerdown', ui.get('button'));
  ui.pointer('pointermove', ui.get('button'), { clientY: 30 });
  assert.equal(ui.pressed('button'), false);
  ui.pointer('pointerdown', ui.get('button'));
  ui.pointer('pointerout', ui.get('button'), { relatedTarget: ui.doc.body });
  assert.equal(ui.pressed('button'), false);
  ui.pointer('pointerdown', ui.get('button'));
  ui.get('button').dispatchEvent(new ui.dom.window.FocusEvent('focusout', { bubbles: true }));
  assert.equal(ui.pressed('button'), false);
  ui.pointer('pointerdown', ui.get('button'));
  ui.dom.window.dispatchEvent(new ui.dom.window.Event('blur'));
  assert.equal(ui.pressed('button'), false);
  ui.pointer('pointerdown', ui.get('button'));
  ui.cleanup();
  assert.equal(ui.pressed('button'), false);
  ui.pointer('pointerdown', ui.get('button'));
  assert.equal(ui.pressed('button'), false);
});

test('keyboard activation handles Enter and Space, but not IME, shortcuts or link scrolling', t => {
  const ui = controls(t);
  for (const key of ['Enter', ' ']) {
    ui.keyboard('keydown', ui.get('button'), key);
    assert.equal(ui.pressed('button'), true);
    ui.keyboard('keyup', ui.get('button'), key);
    assert.equal(ui.pressed('button'), false);
  }
  for (const options of [{ isComposing: true }, { ctrlKey: true }, { repeat: true }]) {
    ui.keyboard('keydown', ui.get('button'), 'Enter', options);
    assert.equal(ui.pressed('button'), false);
  }
  ui.keyboard('keydown', ui.get('link'), ' ');
  assert.equal(ui.pressed('link'), false);
  ui.keyboard('keydown', ui.get('link'), 'Enter');
  assert.equal(ui.pressed('link'), true);
});

test('delegation covers dynamically created portal controls', t => {
  const ui = controls(t);
  const portal = ui.doc.createElement('div');
  portal.innerHTML = '<button id="portal">确认</button>';
  ui.doc.body.appendChild(portal);
  ui.pointer('pointerdown', ui.get('portal'));
  assert.equal(ui.pressed('portal'), true);
  ui.pointer('pointerup', ui.get('portal'));
  assert.equal(ui.pressed('portal'), false);
});

test('route and query arrivals preserve children and avoid editor query or article double animations', async t => {
  const dom = new JSDOM('<body><div id="root"></div></body>');
  const saved = new Map();
  for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  let path = '/';
  let query = '';
  let reduced = false;
  let mounts = 0;
  const listeners = new Set();
  dom.window.matchMedia = () => ({ matches: reduced, addEventListener: (_, listener) => listeners.add(listener), removeEventListener: (_, listener) => listeners.delete(listener) });
  const Motion = load({ usePathname: () => path, useSearchParams: () => new URLSearchParams(query) }).default;
  function Content() { useEffect(() => { mounts += 1; }, []); return React.createElement('input', { defaultValue: '未保存草稿' }); }
  const root = createRoot(dom.window.document.getElementById('root'));
  const render = () => act(() => root.render(React.createElement(React.Fragment, null, React.createElement('div', { className: 'public-content' }, React.createElement(Content)), React.createElement(Motion))));
  t.after(async () => {
    await act(() => root.unmount());
    assert.equal(listeners.size, 0);
    dom.window.close();
    for (const [name, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; }
  });
  await render();
  const content = dom.window.document.querySelector('.public-content');
  const input = content.querySelector('input');
  input.value = '仍在编辑';
  path = '/calendar'; await render();
  assert.ok(content.classList.contains('site-route-arrival'));
  const end = new dom.window.Event('animationend', { bubbles: true });
  Object.defineProperty(end, 'animationName', { value: 'site-route-arrival' });
  content.dispatchEvent(end);
  assert.equal(content.classList.contains('site-route-arrival'), false);
  query = 'month=2026-10'; await render();
  assert.ok(content.classList.contains('site-route-arrival'));
  path = '/article/test'; await render();
  assert.equal(content.classList.contains('site-route-arrival'), false);
  path = '/admin'; await render();
  content.dispatchEvent(end);
  query = 'edit=another'; await render();
  assert.equal(content.classList.contains('site-route-arrival'), false);
  reduced = true; path = '/categories'; await render();
  assert.equal(content.classList.contains('site-route-arrival'), false);
  assert.equal(content.querySelector('input'), input);
  assert.equal(input.value, '仍在编辑');
  assert.equal(mounts, 1);
});

test('motion stylesheet parses, preserves transforms and includes reduced-motion fallbacks', async () => {
  const css = await fs.readFile(new URL('../app/site-motion.css', import.meta.url), 'utf8');
  assert.doesNotThrow(() => postcss.parse(css));
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /scale: none !important/);
  assert.doesNotMatch(css, /(?:^|[;{])\s*(?:transform|outline)\s*:/);
  assert.doesNotMatch(css, /aria-pressed.*scale/);
});
