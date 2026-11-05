import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { rolldown } from 'rolldown';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { leftoverSections } from '../src/leftover-sections.js';

const require = createRequire(import.meta.url);
const cache = new Map();
const noop = () => {};
const dialog = ({ children, buttons }) => React.createElement('section', null, children, buttons);
const compiled = new Map();
for (const name of ['dialog-shared.jsx', 'command-dialogs.jsx', 'dialogs.jsx', 'more.jsx', 'onboarding.jsx']) {
  const entry = `fixture:${name}`;
  const bundle = await rolldown({ input: entry, transform: { jsx: 'react-jsx' }, plugins: [{
    name: 'inert-ui-fixture',
    resolveId(id) { return id === entry ? id : { id, external: true }; },
    load(id) { if (id === entry) return readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8'); },
  }] });
  try { compiled.set(name, (await bundle.generate({ format: 'cjs' })).output[0].code); }
  finally { await bundle.close(); }
}
// Render the actual JSX using installed React, with explicit inert seams. No
// production backend is imported or initialized; effects do not run during SSR.
function componentModule(name) {
  if (cache.has(name)) return cache.get(name);
  const output = compiled.get(name);
  const module = { exports: {} };
  const dependency = (id) => {
    if (id === 'react' || id === 'react/jsx-runtime') return require(id);
    if (id === './backend/i18n.js') return { tx: (text) => text, t: (text) => text };
    if (id === './core-dialog.jsx') return { Dialog: dialog, Busy: noop, ConfirmDialog: noop, useModalLayer: noop };
    if (id === './onboarding.jsx') return { SettingHelp: noop };
    if (id === './backend/impact.js') return { summarizeImpact: noop, failureHint: noop };
    if (id === './backend/winpath.js') return {};
    if (id === './leftover-sections.js') return { leftoverSections };
    if (id === './dialog-shared.jsx' || id === './command-dialogs.jsx') return componentModule(id.slice(2));
    throw new Error(`Unexpected UI fixture import: ${id}`);
  };
  Function('require', 'module', 'exports', 'window', output)(dependency, module, module.exports, { api: { invoke() { throw new Error('SSR fixture must not call native API'); } } });
  cache.set(name, module.exports);
  return module.exports;
}
const render = (Component, props) => renderToStaticMarkup(React.createElement(Component, props));

test('Cleanup Impact Lab keeps selector evidence in original plan order and labels incomplete inventory', () => {
  const { PlanView } = componentModule('dialog-shared.jsx');
  const results = [
    { kind: 'file', path: 'approved-file', reason: 'exact record', ok: true, detail: 'Eligible' },
    { kind: 'file', path: 'blocked-file', reason: 'installed owner', ok: false, detail: 'Protected' },
  ];
  const first = { applications: [], sharedFiles: [], services: ['Observed service'], tasks: [], startup: [], recovery: 'Prospective only', pathEvidence: true };
  const impact = { items: [first, { ...first, services: [] }], sources: { installed: 'unavailable', shared: 'observed', integration: 'partial' }, truncated: true };
  const props = { results, onBack: noop, onExport: noop };
  const html = render(PlanView, { ...props, impact });
  assert.match(html, /Cleanup Impact Lab/);
  assert.match(html, /<label[^>]*><span>Inspect item<\/span><select/);
  assert.match(html, /<option[^>]*selected=""[^>]*>approved-file<\/option><option[^>]*>blocked-file<\/option>/);
  assert.match(html, /Selection evidence<\/dt><dd>exact record<\/dd>/);
  assert.match(html, /inventory is partial/);
  assert.match(html, /Inventory unavailable/);
  assert.match(html, /No observed matches/);
  assert.match(html, /Observed service/);
  assert.match(html, /Prospective only/);
  assert.doesNotMatch(render(PlanView, props), /Cleanup Impact Lab/);
});

test('React exposes one current onboarding step status and hides decorative progress dots', () => {
  const { WelcomeDialog } = componentModule('onboarding.jsx');
  const html = render(WelcomeDialog, { onClose: noop, onGetStarted: noop });
  const dots = [...html.matchAll(/<span\b[^>]*class="step-dot[^"]*"[^>]*>/g)];
  assert.equal(dots.length, 3);
  for (const [dot] of dots) {
    assert.match(dot, /aria-hidden="true"/);
    assert.doesNotMatch(dot, /aria-label=/);
  }
  assert.equal([...html.matchAll(/role="status"/g)].length, 1);
  assert.match(html, /class="welcome-step-text" role="status" aria-live="polite">Step 1 of 3\s*<\/span>/);
  assert.doesNotMatch(html, /Step [23] of 3/);
});

test('React renders the palette active descendant as an existing selected option', () => {
  const { CommandPalette } = componentModule('command-dialogs.jsx');
  for (const commands of [[{ id: 'one / two', text: 'First command' }], []]) {
    const html = render(CommandPalette, { commands, onRun: noop, onClose: noop });
    assert.match(html, /role="combobox"/);
    const list = html.match(/aria-controls="([^"]+)"/)[1];
    assert.ok(html.includes(`id="${list}" role="listbox"`));
    if (commands.length) {
      const active = html.match(/aria-activedescendant="([^"]+)"/)[1];
      assert.ok(html.includes(`id="${active}" role="option" tabindex="-1" aria-selected="true"`));
    } else assert.doesNotMatch(html, /aria-activedescendant=/);
  }
});

test('React renders leftover checkbox names and existing disclosure targets for unusual program names', () => {
  const { LeftoversDialog } = componentModule('dialogs.jsx');
  const html = render(LeftoversDialog, { title: 'Leftovers', heading: 'Review', items: [
    { program: 'Example / One', kind: 'file', path: 'fixture-a', confidence: 'high' },
    { program: 'Example / One', kind: 'file', path: 'fixture-b', confidence: 'low' },
    { program: 'Other', kind: 'key', path: 'fixture-c', confidence: 'high' },
  ], onClose: noop, onRemove: noop, onDryRun: noop, onExportPlan: noop });
  const names = [...html.matchAll(/aria-labelledby="([^"]+)"/g)];
  assert.equal(names.length, 4);
  for (const [, id] of names) assert.ok(html.includes(`id="${id}"`), id);
  const targets = [...html.matchAll(/aria-controls="([^"]+)"/g)];
  assert.equal(targets.length, 2);
  for (const [, id] of targets) assert.ok(html.includes(`id="${id}"`), id);
  assert.equal([...html.matchAll(/aria-expanded="true"/g)].length, 2);
});

test('React renders native treemap buttons inside list items and a selected settings category', () => {
  const { DiskMapDialog, SettingsDialog } = componentModule('more.jsx');
  const map = render(DiskMapDialog, { data: [{ key: 'example', name: 'Example', total: 100, install: 100, data: [] }], onClose: noop, onAnalyze: noop });
  assert.match(map, /role="listitem"><button aria-pressed="false" aria-label="Example: 0 KB"/);
  assert.doesNotMatch(map, /<button[^>]*role="listitem"/);
  const settings = render(SettingsDialog, { initial: {}, onApply: noop, onClose: noop });
  assert.match(settings, /role="group" aria-label="Settings categories"/);
  assert.equal([...settings.matchAll(/aria-pressed="true"/g)].length, 1);
  assert.doesNotMatch(settings, /role="tablist"/);
});
