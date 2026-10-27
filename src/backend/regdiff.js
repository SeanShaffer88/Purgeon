// Registry diff: capture a snapshot of chosen registry keys before an operation, then compare
// against the live registry afterward to show exactly what changed (keys added, values
// changed, keys removed). The user decides which keys to watch; Purgeon never reads keys
// outside the user's list.
import { runPSJson, reg, psq } from './shell.js';
import { sys } from './sys.js';
import * as path from './winpath.js';

let diffRoot = '';

export const setRoot = async (dir) => {
  diffRoot = dir;
  await sys.makeDir(diffRoot);
};

const snapFile = (id) => path.join(diffRoot, `${id}.json`);

// Capture the current values of the listed registry keys.
// keys: ['HKLM\\SOFTWARE\\Foo', 'HKCU\\Software\\Bar\\baz']
export async function capture({ id, keys }) {
  if (!id || !keys || !keys.length) throw new Error('Name the diff and list registry keys to watch.');
  const input = JSON.stringify(keys);
  const script = `
$in = [Console]::In.ReadToEnd() | ConvertFrom-Json
$out = foreach ($k in $in) {
  $key = Get-Item -LiteralPath "Registry::$k" -ErrorAction SilentlyContinue
  if (-not $key) { continue }
  $vals = @{}
  foreach ($n in $key.GetValueNames()) {
    try {
      $v = $key.GetValue($n, $null, 'DoNotExpandEnvironmentNames')
      $kind = [string]$key.GetValueKind($n)
      if ($v -is [byte[]]) { $v = ($v | ForEach-Object { $_.ToString('x2') }) -join '' }
      elseif ($v -is [string[]]) { $v = $v -join '\\0' }
      $vals[$n] = { kind = $kind; data = [string]$v }
    } catch {}
  }
  [pscustomobject]@{ key = $k; values = $vals }
}
@($out) | ConvertTo-Json -Compress
`;
  const snapshot = { id, keys, captured: new Date().toISOString(), entries: [] };
  try {
    const rows = await runPSJson(script, { input });
    snapshot.entries = rows.map((r) => ({ key: r.key, values: r.values || {} }));
  } catch (e) {
    snapshot.error = String(e);
  }
  await sys.writeText(snapFile(id), JSON.stringify(snapshot, null, 2));
  return snapshot;
}

// Compare the saved snapshot against the live registry now.
export async function diff(id) {
  const snapshot = JSON.parse(await sys.readText(snapFile(id)));
  const input = JSON.stringify(snapshot.keys);
  const script = `
$in = [Console]::In.ReadToEnd() | ConvertFrom-Json
$out = foreach ($k in $in) {
  $key = Get-Item -LiteralPath "Registry::$k" -ErrorAction SilentlyContinue
  if (-not $key) { continue }
  $vals = @{}
  foreach ($n in $key.GetValueNames()) {
    try {
      $v = $key.GetValue($n, $null, 'DoNotExpandEnvironmentNames')
      $kind = [string]$key.GetValueKind($n)
      if ($v -is [byte[]]) { $v = ($v | ForEach-Object { $_.ToString('x2') }) -join '' }
      elseif ($v -is [string[]]) { $v = $v -join '\\0' }
      $vals[$n] = { kind = $kind; data = [string]$v }
    } catch {}
  }
  [pscustomobject]@{ key = $k; values = $vals }
}
@($out) | ConvertTo-Json -Compress
`;
  const now = { entries: [] };
  try {
    const rows = await runPSJson(script, { input });
    now.entries = rows.map((r) => ({ key: r.key, values: r.values || {} }));
  } catch (e) {
    now.error = String(e);
  }

  const beforeByKey = {};
  for (const e of snapshot.entries) beforeByKey[e.key] = e.values;
  const afterByKey = {};
  for (const e of now.entries) afterByKey[e.key] = e.values;

  const changes = { added: [], removed: [], changed: [] };
  const allKeys = new Set([...Object.keys(beforeByKey), ...Object.keys(afterByKey)]);
  for (const key of allKeys) {
    const before = beforeByKey[key] || {};
    const after = afterByKey[key] || {};
    const beforeVals = new Set(Object.keys(before));
    const afterVals = new Set(Object.keys(after));
    // Key entirely removed
    if (!afterVals.size && beforeVals.size && !now.entries.some((e) => e.key === key)) {
      changes.removed.push({ key });
      continue;
    }
    for (const val of afterVals) {
      if (!beforeVals.has(val)) {
        changes.added.push({ key, name: val, value: after[val] });
      } else if (before[val].data !== after[val].data || before[val].kind !== after[val].kind) {
        changes.changed.push({ key, name: val, before: before[val], after: after[val] });
      }
    }
    for (const val of beforeVals) {
      if (!afterVals.has(val)) {
        changes.removed.push({ key, name: val, value: before[val] });
      }
    }
  }
  return { id, captured: snapshot.captured, compared: new Date().toISOString(), changes };
}
