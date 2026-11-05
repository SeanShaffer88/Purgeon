import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orphans } from '../src/backend/owners.js';
import { setSys } from '../src/backend/sys.js';

test('orphan findings keep portable programs and profile data low confidence and require a matching folder for registry keys', async () => {
  const now = Date.UTC(2026, 9, 15);
  const old = now - 45 * 86400000;
  const home = 'C:\\Users\\OrphanFixture';
  const programFiles = 'C:\\Program Files';
  const appData = home + '\\AppData\\Roaming';
  const portable = programFiles + '\\FableArchive';
  const profile = appData + '\\AmberNotes';
  const systemOwned = programFiles + '\\WindowsOwnedFixture';
  const recent = programFiles + '\\RecentTool';
  const installed = programFiles + '\\RegisteredTool';
  const key = 'HKEY_CURRENT_USER\\Software\\AmberNotes';
  const unmatched = 'HKEY_CURRENT_USER\\Software\\UnmatchedFixture';
  const dirs = new Map([
    [programFiles, ['FableArchive', 'WindowsOwnedFixture', 'RecentTool', 'RegisteredTool']],
    [appData, ['AmberNotes']],
  ]);
  const scripts = [];
  const walks = [];

  setSys({
    info: { home, dataDir: 'C:\\OrphanFixtureState', env: { ProgramFiles: programFiles, APPDATA: appData } },
    readDir: async (root) => (dirs.get(root) ?? []).map((name) => ({ name, dir: true })),
    stat: async (file) => ({ modified: file === recent ? now : old }),
    walk: async (roots) => {
      walks.push(roots);
      return roots[0] === portable ? [`F${portable}\\launch.exe`] : [];
    },
    runPS: async (script, input) => {
      if (script.includes('Get-Acl')) {
        scripts.push('acl');
        assert.deepEqual(JSON.parse(input), [portable, systemOwned]);
        return JSON.stringify([
          { path: portable, owner: 'FixtureUser' },
          { path: systemOwned, owner: 'NT SERVICE\\TrustedInstaller' },
        ]);
      }
      if (script.includes('Win32_Service')) {
        scripts.push('orphan-scan');
        return JSON.stringify({
          keys: [{ name: 'AmberNotes', path: key }, { name: 'UnmatchedFixture', path: unmatched }],
          services: [],
          running: [],
        });
      }
      if (script.includes('CurrentVersion\\Uninstall')) {
        scripts.push('installed');
        return JSON.stringify([{ name: 'Licensed Application', location: installed }]);
      }
      if (script.includes('Get-AppxProvisionedPackage')) {
        scripts.push('provisioned');
        return '[]';
      }
      if (script.includes('Get-AppxPackage')) {
        scripts.push('store');
        return '[]';
      }
      scripts.push('unexpected');
      throw Error('Unexpected fixture provider request');
    },
  });

  const found = await orphans(now);
  assert.deepEqual(found.map(({ kind, path, score, reason, confidence, seen }) => ({ kind, path, score, reason, confidence, seen })), [
    {
      kind: 'dir', path: portable, score: 30, confidence: 'low', seen: old,
      reason: 'No installed program matches it, but it contains programs: it may be a portable or manually installed app',
    },
    {
      kind: 'dir', path: profile, score: 40, confidence: 'low', seen: old,
      reason: 'No installed program matches this folder; it may still hold settings or saved games',
    },
    {
      kind: 'key', path: key, score: 50, confidence: 'low', seen: undefined,
      reason: 'Matches a leftover folder, and no installed program',
    },
  ]);
  assert.deepEqual(walks, [[portable], [systemOwned]]);
  assert.deepEqual(scripts.sort(), ['acl', 'installed', 'orphan-scan', 'provisioned', 'store']);
});
