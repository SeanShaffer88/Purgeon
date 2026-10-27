// Startup performance profiler with persistent baseline and regression detection.
// Modules register load times; Purgeon's first run writes a baseline so cold-path modules
// can be lazy-loaded on subsequent starts, and later runs can detect regressions.
// Usage: profiler.mark('module:loaded'); profiler.report() -> { lines, totalMs, entries }
import { sys } from './sys.js';
import * as winpath from './winpath.js';

const marks = [];
const startMs = Date.now();
let profileRoot = '';

export const setRoot = async (dir) => {
  profileRoot = dir;
  await sys.makeDir(profileRoot);
};

const baselineFile = () => winpath.join(profileRoot, 'last-baseline.json');

export const mark = (label) => {
  marks.push({ label, ms: Date.now() - startMs });
};

export const reset = () => {
  marks.length = 0;
};

export const report = () => {
  const lines = [`Purgeon startup profile (cold start)`];
  let prev = 0;
  for (const m of marks) {
    const delta = m.ms - prev;
    lines.push(`  +${delta.toFixed(0)} ms  ${m.label}`);
    prev = m.ms;
  }
  lines.push(`  -------  total ${marks.length > 0 ? marks[marks.length - 1].ms.toFixed(0) : 0} ms`);
  return {
    lines,
    totalMs: marks.length > 0 ? marks[marks.length - 1].ms : 0,
    entries: marks,
  };
};

// Time a function call and record it under a label.
export const time = async (label, fn) => {
  const t0 = Date.now();
  const result = await fn();
  mark(`${label} (${Date.now() - t0} ms)`);
  return result;
};

// Save the current profile as the baseline for regression detection.
export const saveBaseline = async () => {
  const r = report();
  const baseline = { totalMs: r.totalMs, entries: r.entries, savedAt: new Date().toISOString() };
  await sys.writeText(baselineFile(), JSON.stringify(baseline, null, 2));
  return baseline;
};

// Load the saved baseline.
export const loadBaseline = async () => {
  try {
    return JSON.parse(await sys.readText(baselineFile()));
  } catch {
    return null;
  }
};

// Compare the current profile against the baseline and return regressions.
// thresholdPct: percentage increase that counts as a regression.
// thresholdMs: absolute ms increase that counts as a regression (both must be exceeded).
export const detectRegressions = async (thresholdPct = 25, thresholdMs = 100) => {
  const baseline = await loadBaseline();
  if (!baseline) return { baseline: null, regressions: [] };
  const current = report();
  const regressions = [];
  const byLabel = {};
  for (const e of baseline.entries) byLabel[e.label] = e;
  for (const c of current.entries) {
    const b = byLabel[c.label];
    if (!b) continue;
    const deltaMs = c.ms - b.ms;
    const deltaPct = b.ms > 0 ? (deltaMs / b.ms) * 100 : 0;
    if (deltaMs > thresholdMs && deltaPct > thresholdPct) {
      regressions.push({
        label: c.label,
        baselineMs: b.ms,
        currentMs: c.ms,
        deltaMs,
        deltaPct: deltaPct.toFixed(1),
      });
    }
  }
  return { baseline, regressions, current: { totalMs: current.totalMs } };
};
