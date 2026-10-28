// Relationship Graph join: startup entries belong to the program whose
// install folder their executable lives in; everything else is an orphan
// candidate. exeOf pulls the real executable out of a command line.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph, exeOf } from '../src/backend/graph.js';

test('exeOf extracts the executable from quoted and unquoted commands', () => {
  assert.equal(exeOf('"C:\\Program Files\\Contoso\\editor.exe" --minimized'), 'C:\\Program Files\\Contoso\\editor.exe');
  assert.equal(exeOf('C:\\Windows\\System32\\svchost.exe -k netsvcs'), 'C:\\Windows\\System32\\svchost.exe');
  assert.equal(exeOf(''), '');
});

const PROGRAMS = [
  { name: 'Contoso Editor', publisher: 'Contoso', location: 'C:\\Program Files\\Contoso', key: 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Contoso' },
  { name: 'Fabrikam Viewer', publisher: 'Fabrikam', location: 'C:\\Program Files\\Fabrikam', key: '' },
];

const ENTRIES = [
  { type: 'service', name: 'Contoso Update Service', display: 'Contoso Update', command: '"C:\\Program Files\\Contoso\\updater.exe" /service', serviceName: 'ContosoUpdate' },
  { type: 'run', name: 'ContosoTray', command: '"C:\\Program Files\\Contoso\\tray.exe"', source: 'hkcu-run' },
  { type: 'task', name: 'Fabrikam Backup', path: '\\Fabrikam\\Backup', command: 'C:\\Program Files\\Fabrikam\\backup.exe' },
  { type: 'service', name: 'Ghost Service', command: '"C:\\Program Files\\Ghost\\ghost.exe"', serviceName: 'GhostSvc' },
  { type: 'run', name: 'GhostTray', command: '"C:\\Users\\Sam\\AppData\\Local\\Ghost\\tray.exe"', source: 'hkcu-run' },
];

test('buildGraph joins entries to their programs and isolates the rest', () => {
  const { nodes, orphanCandidates } = buildGraph(PROGRAMS, ENTRIES);
  const contoso = nodes.find((n) => n.name === 'Contoso Editor');
  assert.deepEqual(contoso.links.map((l) => l.kind), ['Service', 'Startup entry']);
  const fabrikam = nodes.find((n) => n.name === 'Fabrikam Viewer');
  assert.deepEqual(fabrikam.links.map((l) => l.kind), ['Scheduled task']);
  assert.equal(fabrikam.links[0].taskPath, '\\Fabrikam\\Backup', 'task orphans keep the path the removal needs');
  assert.deepEqual(orphanCandidates.map((o) => o.label), ['Ghost Service', 'GhostTray']);
  assert.equal(orphanCandidates[0].serviceName, 'GhostSvc', 'service orphans keep the service name the removal needs');
  assert.equal(orphanCandidates[0].target, 'C:\\Program Files\\Ghost\\ghost.exe');
});

test('buildGraph sorts programs by connection count and tolerates empty input', () => {
  const { nodes } = buildGraph(PROGRAMS, ENTRIES);
  assert.equal(nodes[0].name, 'Contoso Editor', 'the most-connected program comes first');
  assert.deepEqual(buildGraph([], []), { nodes: [], orphanCandidates: [] });
  assert.deepEqual(buildGraph(null, null), { nodes: [], orphanCandidates: [] });
});
