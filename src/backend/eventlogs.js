// Event Logs (Tools › System Tools): Windows' event logs — how big each
// one is, saving a copy out to a file, clearing one, turning one off.
//
// Safety shape: clearing always saves a copy first (into Purgeon's own
// backup folder for log copies), and the copy is kept even after the log
// is cleared — clearing is the one action here with no undo, so the copy
// IS the undo. The Security log is view-and-save only: Purgeon will never
// clear it or turn it off, and that guard lives here in the backend, not
// just in the window.
import path from 'node:path';
import { sys } from './sys.js';
import { runPSJson } from './shell.js';
import { record } from './history.js';

const note = (entry) => record(entry).catch(() => {});

export function channelGuard(name) {
  if (String(name || '').trim().toLowerCase() === 'security') {
    return 'The Security log is never cleared or turned off from Purgeon — it is the record Windows keeps of sign-ins and security events. You can save a copy of it.';
  }
  return null;
}

export function shapeChannels(rows) {
  return (Array.isArray(rows) ? rows : [rows])
    .filter((r) => r && r.LogName)
    .map((r) => ({
      name: String(r.LogName),
      records: Number(r.RecordCount) || 0,
      sizeBytes: Number(r.FileSize) || 0,
      enabled: r.IsEnabled !== false,
      guarded: !!channelGuard(r.LogName),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function channels() {
  const rows = await runPSJson(`Get-WinEvent -ListLog * -ErrorAction SilentlyContinue | Select-Object LogName, RecordCount, FileSize, IsEnabled | ConvertTo-Json -Compress`).catch(() => []);
  return shapeChannels(rows);
}

const CHANNEL_RE = /^[\w\-./ ]+$/;

function checkedChannel(name) {
  const n = String(name || '').trim();
  if (!n || !CHANNEL_RE.test(n) || n.includes('..')) throw new Error('That event log name does not look right.');
  return n;
}

async function wevt(args) {
  const r = await sys.exec('wevtutil.exe', args);
  if (!r.ok) throw new Error(((r.stderr || r.stdout || 'wevtutil failed').trim().split('\n').find((l) => l.trim()) || 'wevtutil failed').trim());
  return r;
}

// Save a copy of a log to a caller-chosen .evtx file.
export async function exportLog(name, destPath) {
  const channel = checkedChannel(name);
  if (!destPath || !/\.evtx$/i.test(destPath)) throw new Error('Choose a place to save the .evtx copy.');
  await wevt(['epl', channel, destPath]);
  note({ type: 'Event log', title: `Saved a copy of the ${channel} log`, detail: destPath, undo: null });
  return { ok: true, path: destPath };
}

// Clear a log — always after saving a copy into Purgeon's log-backup
// folder, which is kept. Returns where the copy went.
export async function clearLog(name) {
  const channel = checkedChannel(name);
  const guard = channelGuard(channel);
  if (guard) throw new Error(guard);
  const dir = path.join(sys.info.dataDir, 'log-backups');
  await sys.makeDir(dir);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(dir, `${channel.replace(/[\\/:*?"<>|]/g, '_')}-${stamp}.evtx`);
  await wevt(['epl', channel, backup]);
  await wevt(['cl', channel]);
  note({
    type: 'Event log', title: `Cleared the ${channel} log`,
    detail: `A copy was saved first: ${backup}. The copy is kept — it is the only way back.`,
    undo: null,
  });
  return { ok: true, backup };
}

export async function setEnabled(name, on) {
  const channel = checkedChannel(name);
  const guard = channelGuard(channel);
  if (guard) throw new Error(guard);
  await wevt(['sl', channel, on ? '/e:true' : '/e:false']);
  note({
    type: 'Event log', title: `${channel} log turned ${on ? 'on' : 'off'}`,
    detail: on ? 'New events will be recorded again.' : 'Events stop being recorded while it is off.',
    undo: { channel: 'logs:setEnabled', arg: { name: channel, on: !on } },
  });
  return { ok: true };
}
