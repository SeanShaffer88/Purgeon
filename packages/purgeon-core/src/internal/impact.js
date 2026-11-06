// Pre-change impact summary + failure next steps, as pure text logic so both are
// testable and identical wherever they are shown.
//
// The impact summary counts the selection, estimates its size and flags a possible
// restart. The size estimate is
// the removal backup's forecast (files measured, registry entries estimated) — the
// same number the backup itself works from, labelled "about" because folder sizes
// are measured with a cap.

const RESTART_KINDS = new Set(['service', 'task', 'driver']);

// items: leftover/removal items; forecastBytes: backups:forecastSize for the selection.
export function summarizeImpact(items, forecastBytes) {
  const list = items || [];
  const files = list.filter((i) => i.kind === 'file' || i.kind === 'dir').length;
  const registry = list.filter((i) => i.kind === 'key' || i.kind === 'value').length;
  const others = list.length - files - registry;
  const parts = [];
  if (files) parts.push(`${files} file${files === 1 ? '' : 's'} or folders`);
  if (registry) parts.push(`${registry} registry ${registry === 1 ? 'entry' : 'entries'}`);
  if (others) parts.push(`${others} other ${others === 1 ? 'item' : 'items'}`);
  const mb = (Number(forecastBytes) || 0) / (1024 * 1024);
  const size = mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(0, Math.round((Number(forecastBytes) || 0) / 1024))} KB`;
  return {
    count: list.length,
    needsRestart: list.some((i) => RESTART_KINDS.has(i.kind)),
    text: list.length
      ? `${list.length} selected: ${parts.join(', ')} · about ${size} of selected data`
      : 'Nothing selected.',
  };
}

// A plain next step for a failed item, from its failure wording. Empty when the
// wording matches nothing known — a wrong suggestion is worse than none.
export function failureHint(detail) {
  const d = String(detail || '').toLowerCase();
  if (!d) return '';
  if (/in use|being used|locked|open in another/.test(d)) return 'Close the program using it, then try again.';
  if (/access is denied|access denied|permission|administrator|elevat/.test(d)) return 'Restart Purgeon as administrator (File › Restart as Administrator) and try again.';
  if (/not found|cannot find|could not be found|no longer exists|already gone|does not exist/.test(d)) return 'It is already gone — nothing more to do.';
  if (/protected|shared|still used|kept/.test(d)) return 'Kept on purpose: another program still uses it, or Windows protects it.';
  if (/cancelled|canceled|aborted/.test(d)) return 'Stopped by choice — nothing was changed for this item.';
  if (/recycle|trash/.test(d)) return 'Emptying the Recycle Bin or retrying usually clears this.';
  return '';
}
