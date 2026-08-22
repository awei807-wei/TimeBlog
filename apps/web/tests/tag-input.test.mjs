import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const sourceURL = new URL('../app/admin/TagInput.tsx', import.meta.url);
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

let currentHarness = null;
const reactStub = {
  useEffect: effect => currentHarness.useEffect(effect),
  useId: () => currentHarness.useId(),
  useRef: initialValue => currentHarness.useRef(initialValue),
  useState: initialValue => currentHarness.useState(initialValue),
};
const runtimeStub = {
  Fragment: Symbol('Fragment'),
  jsx: (type, props) => ({ type, props: props || {} }),
  jsxs: (type, props) => ({ type, props: props || {} }),
};
const moduleStubs = {
  react: reactStub,
  'react/jsx-runtime': runtimeStub,
  'lucide-react': { X: () => null },
};
const loadedModule = { exports: {} };
const requireStub = specifier => {
  if (Object.hasOwn(moduleStubs, specifier)) return moduleStubs[specifier];
  throw new Error(`unexpected import while loading ${sourceURL.pathname}: ${specifier}`);
};
vm.compileFunction(compiled.outputText, ['require', 'module', 'exports'], { filename: sourceURL.pathname })(requireStub, loadedModule, loadedModule.exports);
const TagInput = loadedModule.exports.default;

function createHarness(values) {
  const state = [];
  const refs = [];
  const changes = [];
  const harness = {
    cursor: 0,
    tree: null,
    props: {
      label: '标签',
      values,
      onChange: nextValues => {
        changes.push(nextValues);
        harness.props = { ...harness.props, values: nextValues };
        harness.render();
      },
      placeholder: '输入后回车',
      ariaLabel: '标签',
      prefix: '',
    },
    changes,
    useEffect() {
      this.cursor += 1;
    },
    useId() {
      this.cursor += 1;
      return 'tag-input-id';
    },
    useRef(initialValue) {
      const index = this.cursor++;
      if (!refs[index]) refs[index] = { current: initialValue };
      return refs[index];
    },
    useState(initialValue) {
      const index = this.cursor++;
      if (!Object.hasOwn(state, index)) state[index] = initialValue;
      return [state[index], nextValue => {
        state[index] = typeof nextValue === 'function' ? nextValue(state[index]) : nextValue;
        this.render();
      }];
    },
    render() {
      this.cursor = 0;
      currentHarness = this;
      this.tree = TagInput(this.props);
      currentHarness = null;
    },
  };
  harness.render();
  return harness;
}

function findNode(node, predicate) {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findNode(child, predicate);
      if (found) return found;
    }
    return null;
  }
  if (predicate(node)) return node;
  return findNode(node.props?.children, predicate);
}

function inputNode(harness, className) {
  return findNode(harness.tree, node => node.type === 'input' && node.props.className === className);
}

function tagInputNode(harness) {
  return findNode(harness.tree, node => node.type === 'div' && node.props.className === 'tag-input');
}

function changeInput(harness, className, value) {
  inputNode(harness, className).props.onChange({ target: { value } });
}

function pressEnter(harness, className, { isComposing = false, keyCode = 13 } = {}) {
  const input = inputNode(harness, className);
  const event = {
    key: 'Enter',
    keyCode,
    target: {
      tagName: 'INPUT',
      classList: { contains: candidate => candidate === className },
    },
    nativeEvent: { isComposing },
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {
      this.propagationStopped = true;
    },
  };
  input.props.onKeyDown(event);
  tagInputNode(harness).props.onKeyDown(event);
  return event;
}

test('TagInput confirms Enter at the container boundary without committing during IME composition', () => {
  const draftHarness = createHarness(['Existing']);
  changeInput(draftHarness, 'tag-input-editor', 'next');
  const draftEvent = pressEnter(draftHarness, 'tag-input-editor');
  assert.deepEqual(draftHarness.changes, [['Existing', 'next']]);
  assert.equal(draftEvent.defaultPrevented, true);
  assert.equal(draftEvent.propagationStopped, true);

  const emptyHarness = createHarness(['Existing']);
  changeInput(emptyHarness, 'tag-input-editor', '   ');
  const emptyEvent = pressEnter(emptyHarness, 'tag-input-editor');
  assert.deepEqual(emptyHarness.changes, []);
  assert.equal(emptyEvent.defaultPrevented, true);
  assert.equal(emptyEvent.propagationStopped, true);

  const duplicateHarness = createHarness(['Existing']);
  changeInput(duplicateHarness, 'tag-input-editor', ' existing ');
  pressEnter(duplicateHarness, 'tag-input-editor');
  assert.deepEqual(duplicateHarness.changes, [['Existing']]);

  const imeHarness = createHarness([]);
  changeInput(imeHarness, 'tag-input-editor', '中文');
  const imeEvent = pressEnter(imeHarness, 'tag-input-editor', { isComposing: true, keyCode: 229 });
  assert.deepEqual(imeHarness.changes, []);
  assert.equal(imeEvent.defaultPrevented, false);
  assert.equal(imeEvent.propagationStopped, false);

  const compositionInput = inputNode(imeHarness, 'tag-input-editor');
  compositionInput.props.onCompositionStart();
  const guardedEvent = pressEnter(imeHarness, 'tag-input-editor');
  assert.deepEqual(imeHarness.changes, []);
  assert.equal(guardedEvent.defaultPrevented, false);
  compositionInput.props.onCompositionEnd();
  pressEnter(imeHarness, 'tag-input-editor');
  assert.deepEqual(imeHarness.changes, [['中文']]);
});

test('TagInput commits Enter in the inline editor and keeps its edited value normalized', () => {
  const harness = createHarness(['Old']);
  const chip = findNode(harness.tree, node => node.type === 'span' && node.props.className === 'taxonomy-tag');
  chip.props.onDoubleClick({ target: { closest: () => null } });
  changeInput(harness, 'taxonomy-tag-edit', ' New ');
  const event = pressEnter(harness, 'taxonomy-tag-edit');
  assert.deepEqual(harness.changes, [['New']]);
  assert.equal(event.defaultPrevented, true);
  assert.equal(event.propagationStopped, true);
});
