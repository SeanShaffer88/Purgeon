// Explorer right-click entries: "Who owns this?" on files and folders, and "Uninstall with
// SweepUninstall" on shortcuts and programs. They are added for the current user only, under
// keys named SweepUninstall*, and turning them off deletes exactly those keys again.
import { sys } from './sys.js';
import { reg, runPS, psq } from './shell.js';

const CLASSES = 'HKCU\\Software\\Classes';
const ENTRIES = [
  { key: `${CLASSES}\\*\\shell\\SweepUninstallWhoOwns`, label: 'Who owns this? (SweepUninstall)', arg: '--who-owns' },
  { key: `${CLASSES}\\Directory\\shell\\SweepUninstallWhoOwns`, label: 'Who owns this? (SweepUninstall)', arg: '--who-owns' },
  { key: `${CLASSES}\\lnkfile\\shell\\SweepUninstallUninstall`, label: 'Uninstall with SweepUninstall', arg: '--uninstall-target' },
  { key: `${CLASSES}\\exefile\\shell\\SweepUninstallUninstall`, label: 'Uninstall with SweepUninstall', arg: '--uninstall-target' },
];

export async function enabled() {
  return (await reg(['query', ENTRIES[0].key])).ok;
}

export async function enable() {
  for (const e of ENTRIES) {
    for (const args of [
      ['add', e.key, '/v', 'MUIVerb', '/t', 'REG_SZ', '/d', e.label, '/f'],
      ['add', e.key, '/v', 'Icon', '/t', 'REG_SZ', '/d', `"${sys.info.exe}",0`, '/f'],
      ['add', `${e.key}\\command`, '/ve', '/t', 'REG_SZ', '/d', `"${sys.info.exe}" ${e.arg} "%1"`, '/f'],
    ]) {
      const r = await reg(args);
      if (!r.ok) throw new Error(r.stderr.trim());
    }
  }
  return true;
}

export async function disable() {
  for (const e of ENTRIES) {
    const r = await reg(['delete', e.key, '/f']);
    if (!r.ok && !/unable to find/i.test(r.stderr)) throw new Error(r.stderr.trim());
  }
  return false;
}

// The target of a shortcut, or the path itself.
export async function resolveTarget(p) {
  if (!/\.lnk$/i.test(p)) return p;
  const t = await runPS(`(New-Object -ComObject WScript.Shell).CreateShortcut(${psq(p)}).TargetPath`).catch(() => '');
  return t.trim() || p;
}
