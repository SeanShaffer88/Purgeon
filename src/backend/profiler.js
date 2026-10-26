// Startup performance profiler. Modules register load times; Purgeon's first run writes a
// profile so cold-path modules can be lazy-loaded on subsequent starts.
// Usage: profiler.mark('module:loaded'); profiler.report() -> { lines, totalMs, entries }
const marks = [];
const startMs = Date.now();

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
