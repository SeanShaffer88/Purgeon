// Power Options: the active power plan and the timings and switches the
// plan carries, read and changed through Windows' own powercfg tool — the
// same switches Settings and Control Panel use. Every change records what
// was there before in Change History, with an undo that puts it back.
//
// The setting GUIDs used here are Windows' published power-setting
// identifiers (Microsoft Learn's power settings reference gives the battery
// threshold's; the sleep/video GUIDs are the long-documented constants
// powercfg itself prints). Timeouts go through powercfg /change, which
// takes minutes and needs no GUIDs.
import { sys } from './sys.js';
import { record } from './history.js';

const SUB_VIDEO = '7516b95f-f776-4464-8c53-06167f40cc99';
const VIDEOIDLE = '3c0bc021-c8a8-4e07-a973-6b14cbcb2b7e';
const SUB_SLEEP = '238c9fa8-0aad-41ed-83f4-97be242c8f20';
const STANDBYIDLE = '29f6c1db-86da-48c5-9fdb-f2b67b1f44da';
const HIBERNATEIDLE = '9d7815a6-7ee4-497e-8888-515a05f02364';
const RTCWAKE = 'bd3b718a-0680-4d9d-8ab2-e1d2b4ac806d';
const SUB_USB = '2a737441-1930-4402-8d77-b2bebba308a3';
const USBSELECTIVE = '48e6b7a6-50f5-4782-a5d4-53bb8f07e226';
// powercfg resolves these two by their published aliases (Microsoft Learn's
// battery-threshold page names ESBATTTHRESHOLD and its 0-100 range), which
// avoids depending on the subgroup GUID.
const SUB_ENERGYSAVER = 'SUB_ENERGYSAVER';
const ESBATTTHRESHOLD = 'ESBATTTHRESHOLD';

const note = (entry) => record(entry).catch(() => {});
const cfg = async (args) => {
  const r = await sys.exec('powercfg', args);
  if (!r.ok) throw new Error((r.stderr || r.stdout || 'powercfg failed').trim().split('\n')[0]);
  return r.stdout || '';
};

// "Power Scheme GUID: <guid>  (Balanced) *" lines from powercfg /list.
export function parsePlans(text) {
  const plans = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/GUID:\s*([0-9a-f-]{36})\s*\((.*?)\)\s*(\*)?/i);
    if (m) plans.push({ guid: m[1].toLowerCase(), name: m[2].trim(), active: !!m[3] });
  }
  return plans;
}

// "Current AC Power Setting Index: 0x0000003c" lines from powercfg /query.
export function parseIndexes(text) {
  const grab = (label) => {
    const m = String(text || '').match(new RegExp(label + '[^:]*:\\s*0x([0-9a-f]+)', 'i'));
    return m ? parseInt(m[1], 16) : null;
  };
  return { ac: grab('AC Power Setting Index'), dc: grab('DC Power Setting Index') };
}

const querySetting = async (sub, setting) => parseIndexes(await cfg(['/query', 'SCHEME_CURRENT', sub, setting]));

// The whole window state. Timeout values come back in seconds from /query
// and are presented in minutes (0 = never).
export async function state() {
  const plans = parsePlans(await cfg(['/list']));
  const [video, standby, hibernate, saver, wake, usb] = await Promise.all([
    querySetting(SUB_VIDEO, VIDEOIDLE),
    querySetting(SUB_SLEEP, STANDBYIDLE),
    querySetting(SUB_SLEEP, HIBERNATEIDLE),
    querySetting(SUB_ENERGYSAVER, ESBATTTHRESHOLD),
    querySetting(SUB_SLEEP, RTCWAKE),
    querySetting(SUB_USB, USBSELECTIVE),
  ]);
  const mins = (v) => (v === null ? null : Math.round(v / 60));
  return {
    plans,
    screen: { ac: mins(video.ac), dc: mins(video.dc) },
    sleep: { ac: mins(standby.ac), dc: mins(standby.dc) },
    hibernate: { ac: mins(hibernate.ac), dc: mins(hibernate.dc) },
    batterySaverPct: saver.dc ?? saver.ac ?? null,
    wakeTimers: wake.ac === null ? null : wake.ac > 0,
    usbSuspend: usb.ac === null ? null : usb.ac > 0,
  };
}

const GUID_RE = /^[0-9a-f-]{36}$/i;

export async function setPlan(guid, name) {
  if (!GUID_RE.test(String(guid || ''))) throw new Error('That power plan is not on this PC any more.');
  const before = parsePlans(await cfg(['/list'])).find((p) => p.active);
  await cfg(['/setactive', guid]);
  note({
    type: 'Power', title: `Switched the power plan to ${name || 'another plan'}`,
    detail: before ? `It was ${before.name} before.` : '',
    undo: before ? { channel: 'power:setPlan', arg: { guid: before.guid, name: before.name } } : null,
  });
  return { ok: true };
}

const TIMEOUT_FLAGS = {
  screen: ['monitor-timeout-ac', 'monitor-timeout-dc'],
  sleep: ['standby-timeout-ac', 'standby-timeout-dc'],
  hibernate: ['hibernate-timeout-ac', 'hibernate-timeout-dc'],
};
const TIMEOUT_LABELS = { screen: 'Screen off', sleep: 'Sleep', hibernate: 'Hibernate' };

export async function setTimeout(kind, acMin, dcMin, previous) {
  const flags = TIMEOUT_FLAGS[kind];
  if (!flags) throw new Error('Unknown power timing.');
  for (const [flag, value] of [[flags[0], acMin], [flags[1], dcMin]]) {
    if (!Number.isInteger(value) || value < 0 || value > 6000) throw new Error('Choose a time between never and 100 hours.');
    await cfg(['/change', flag, String(value)]);
  }
  note({
    type: 'Power', title: `${TIMEOUT_LABELS[kind]} timing changed`,
    detail: `Plugged in: ${acMin === 0 ? 'never' : acMin + ' min'} · On battery: ${dcMin === 0 ? 'never' : dcMin + ' min'}.`,
    undo: previous ? { channel: 'power:setTimeout', arg: { kind, acMin: previous.ac, dcMin: previous.dc, previous: null } } : null,
  });
  return { ok: true };
}

async function setIndex(sub, setting, ac, dc) {
  await cfg(['/setacvalueindex', 'SCHEME_CURRENT', sub, setting, String(ac)]);
  await cfg(['/setdcvalueindex', 'SCHEME_CURRENT', sub, setting, String(dc)]);
  await cfg(['/setactive', 'SCHEME_CURRENT']); // re-apply so the change takes hold now
}

export async function setBatterySaver(pct, previous) {
  if (!Number.isInteger(pct) || pct < 0 || pct > 100) throw new Error('Battery saver level must be between 0 and 100 percent.');
  await setIndex(SUB_ENERGYSAVER, ESBATTTHRESHOLD, pct, pct);
  note({
    type: 'Power', title: `Battery saver now turns on at ${pct}%`,
    detail: previous !== null && previous !== undefined ? `It was ${previous}% before.` : '',
    undo: previous !== null && previous !== undefined ? { channel: 'power:setBatterySaver', arg: { pct: previous, previous: null } } : null,
  });
  return { ok: true };
}

export async function setWakeTimers(on, previous) {
  await setIndex(SUB_SLEEP, RTCWAKE, on ? 1 : 0, on ? 1 : 0);
  note({
    type: 'Power', title: on ? 'Wake timers allowed' : 'Wake timers not allowed',
    detail: 'Wake timers let scheduled work bring the PC out of sleep.',
    undo: previous !== null && previous !== undefined ? { channel: 'power:setWakeTimers', arg: { on: previous, previous: null } } : null,
  });
  return { ok: true };
}

export async function setUsbSuspend(on, previous) {
  await setIndex(SUB_USB, USBSELECTIVE, on ? 1 : 0, on ? 1 : 0);
  note({
    type: 'Power', title: on ? 'USB selective suspend on' : 'USB selective suspend off',
    detail: 'Selective suspend lets Windows power down idle USB devices.',
    undo: previous !== null && previous !== undefined ? { channel: 'power:setUsbSuspend', arg: { on: previous, previous: null } } : null,
  });
  return { ok: true };
}
