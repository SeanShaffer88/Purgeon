import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (name) => readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8');
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

// Execute the production event handlers with inert state/API doubles. These
// checks do not start the application or contact the native system adapter.
test('Ctrl+0 resets zoom; Ctrl+Shift+0 opens disk usage for shifted keyboard events', () => {
  const source = read('App.jsx');
  const start = source.indexOf('const onKey = (e) => {', source.indexOf('// Keyboard shortcuts'));
  const body = source.slice(start, source.indexOf("window.addEventListener('keydown', onKey)", start)).trim();
  const actions = [];
  const handler = Function('document', 'dispatchRef', 'goBack', 'goForward', `${body}\nreturn onKey;`)({ querySelector: () => null }, { current: (action) => actions.push(action) }, () => {}, () => {});
  for (const [key, shiftKey, code] of [['0', false, 'Digit0'], [')', true, 'Digit0'], ['0', true, 'Digit0']]) {
    let prevented = false;
    handler({ key, code, shiftKey, ctrlKey: true, altKey: false, target: { tagName: 'DIV' }, preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
  }
  assert.deepEqual(actions, ['zoomReset', 'view:disk', 'view:disk']);
  handler({ key: '0', code: 'Digit0', shiftKey: true, ctrlKey: true, altKey: true, target: { tagName: 'DIV' } });
  assert.equal(actions.length, 3, 'AltGr does not trigger either action');
  assert.match(source, /\['view:disk', 'Disk Usage', 'Ctrl\+Shift\+0'\]/);
  assert.match(read('onboarding.jsx'), /\['Ctrl\+Shift\+0', 'Disk Usage'\]/);
});

function diskHarness(invoke) {
  const source = read('disk.jsx');
  const start = source.indexOf('  const [drives');
  const end = source.indexOf('\n  return (', start);
  const effects = [], updates = [], errors = [];
  const mount = Function('api', 'useState', 'useRef', 'useEffect', 'useMemo', 'systemDriveRoot', 'sortEntries', 'parentOf', 'crumbsOf', 'filter', 'onError', 'onStatus', `${source.slice(start, end)}\nreturn { scan };`);
  const view = mount({ invoke }, (initial) => [initial, (value) => updates.push(value)], (value) => ({ current: value }), (effect) => effects.push(effect), (fn) => fn(), () => 'C:\\', (entries) => entries, () => null, () => [], '', (error) => errors.push(error), () => {});
  const cleanup = effects[0]() || (() => {});
  return { ...view, cleanup, updates, errors };
}

test('unmounted disk discovery cannot start or cancel another view measurement', async () => {
  const discovery = deferred(), calls = [];
  const view = diskHarness((name) => { calls.push(name); return name === 'disk:drives' ? discovery.promise : Promise.resolve({ entries: [] }); });
  view.cleanup();
  discovery.resolve([{ root: 'C:\\' }]);
  await settle();
  assert.deepEqual(calls, ['disk:drives']);
  assert.deepEqual(view.updates, []);
  assert.deepEqual(view.errors, []);
});

test('unmounted disk discovery ignores rejection and pending list results', async () => {
  const discovery = deferred();
  const view = diskHarness(() => discovery.promise);
  view.cleanup(); discovery.reject(new Error('late discovery'));
  await settle();
  assert.deepEqual(view.errors, []);
  const listed = deferred(), calls = [];
  const active = diskHarness((name) => { calls.push(name); return name === 'disk:drives' ? Promise.resolve([{ root: 'C:\\' }]) : name === 'disk:list' ? listed.promise : Promise.resolve(); });
  await settle();
  const count = active.updates.length;
  active.cleanup();
  listed.resolve({ entries: [{ path: 'C:\\folder', bytes: 0, pending: true }] });
  await settle();
  assert.equal(active.updates.length, count);
  assert.equal(calls.includes('disk:measure'), false);
});

test('mounted disk discovery still lists and measures folders', async () => {
  const calls = [];
  const view = diskHarness((name) => {
    calls.push(name);
    return Promise.resolve(name === 'disk:drives' ? [{ root: 'C:\\' }] : name === 'disk:list' ? { entries: [{ path: 'C:\\folder', bytes: 0, pending: true }] } : name === 'disk:measure' ? { measured: [{ path: 'C:\\folder', bytes: 10 }], complete: true } : undefined);
  });
  await settle();
  assert.deepEqual(calls, ['disk:drives', 'disk:measureCancel', 'disk:list', 'disk:measure']);
  assert.ok(view.updates.some((value) => value?.complete === true && value.total === 10));
  view.cleanup();
});

test('palette keyboard selection stays in bounds, runs the selected command and closes with Escape', () => {
  const source = read('command-dialogs.jsx');
  const body = source.match(/onKeyDown=\{\(e\) => \{([\s\S]*?)\n          \}\}/)[1];
  let selected = 0, closed = 0;
  const commands = [{ id: 'first' }, { id: 'second' }], ran = [];
  const press = (key, shown = commands) => {
    let prevented = false, stopped = false;
    Function('e', 'shown', 'i', 'setI', 'onRun', 'onClose', body)({ key, preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } }, shown, selected, (fn) => { selected = fn(selected); }, (command) => ran.push(command), () => closed++);
    return { prevented, stopped };
  };
  assert.equal(press('ArrowUp').prevented, true);
  assert.equal(selected, 0);
  press('ArrowDown'); press('ArrowDown');
  assert.equal(selected, 1);
  press('Enter');
  assert.deepEqual(ran, [commands[1]]);
  selected = 0;
  press('ArrowDown', []);
  assert.equal(selected, 0);
  press('Enter', []);
  assert.equal(ran.length, 1);
  assert.equal(press('Escape').stopped, true);
  assert.equal(closed, 1);
});

// Source-level relationship guards complement the executable handler tests;
// they do not establish browser accessibility or screen-reader behavior.
test('palette declares linked combobox/listbox/options and preserves input focus', () => {
  const source = read('command-dialogs.jsx');
  assert.match(source, /role="combobox"/);
  assert.match(source, /aria-controls=\{listId\}/);
  assert.match(source, /id=\{listId\} role="listbox"/);
  assert.match(source, /aria-activedescendant=\{shown\[i\] \? `\$\{listId\}-\$\{encodeURIComponent\(shown\[i\]\.id\)\}` : undefined\}/);
  assert.match(source, /id=\{`\$\{listId\}-\$\{encodeURIComponent\(c\.id\)\}`\} role="option" tabIndex=\{-1\} aria-selected=\{n === i\}/);
  assert.match(source, /onMouseDown=\{\(e\) => e\.preventDefault\(\)\}/);
});

test('leftover names, disclosure targets and mixed checkbox state remain exposed', () => {
  const source = read('dialogs.jsx');
  for (const part of ['program', 'group']) {
    const token = part === 'program' ? 's.program' : 'g.id';
    const expression = `\`\${treeId}-${part}-\${encodeURIComponent(${token})}\``;
    assert.ok(source.includes(`aria-labelledby={${expression}}`));
    assert.ok(source.includes(`id={${expression}}`));
  }
  assert.match(source, /aria-expanded=\{open\}/);
  const target = '`\${treeId}-rows-\${encodeURIComponent(g.id)}`'.replaceAll('\\', '');
  assert.ok(source.includes(`aria-controls={${target}}`));
  assert.ok(source.includes(`id={${target}} hidden={!open}`));
  assert.match(source, /el\.indeterminate = some/);
  assert.match(source, /el\.indeterminate = !s\.rows\.every/);
});

test('settings categories, treemap actions and notification dismissals have semantic state/names', () => {
  const more = read('more.jsx'), app = read('App.jsx');
  assert.match(more, /className="settings-rail" role="group" aria-label="Settings categories"/);
  assert.match(more, /aria-pressed=\{page === id\}/);
  assert.match(more, /<div key=\{b\.item\.key\} role="listitem">\s*<button\s+aria-pressed=\{sel === b\.item\.key\}/);
  assert.match(app, /aria-label=\{tx\("Dismiss error"\)\}/);
  assert.match(app, /aria-label=\{tx\("Dismiss undo notification"\)\}/);
});
