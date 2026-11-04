// Heuristic assessment of recorded changes; does not prove runtime portability.
import * as path from './winpath.js';

function isProtectedPath(p) {
  const lower = String(p ?? '').toLowerCase();
  const roots = ['c:\\windows', 'c:\\programdata', 'c:\\$recycle.bin', 'c:\\users\\all users'];
  return roots.some((r) => lower.startsWith(r));
}

function installRootOf(rec) {
  const paths = rec.items
    .filter((i) => (i.kind === 'dir' || i.kind === 'file') && !isProtectedPath(i.path))
    .map((i) => i.path);
  if (!paths.length) return '';
  if (paths.length === 1) {
    const item = rec.items.find((i) => i.path === paths[0]);
    return item.kind === 'dir' ? paths[0].replace(/\\+$/, '') : path.dirname(paths[0]);
  }
  const sorted = paths.map((p) => p.toLowerCase()).sort();
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  let i = 0;
  while (i < first.length && i < last.length && first[i] === last[i]) i++;
  const common = first.slice(0, i);
  const lastSep = common.lastIndexOf('\\');
  const root = lastSep >= 0 ? common.slice(0, lastSep + 1) : common;
  // A bare drive root (e.g. "C:\\") is not a real install root.
  return /^[a-z]:\\$/i.test(root) ? '' : root;
}

export async function classifyForPortable(items) {
  const reasons = [];
  const installRoot = installRootOf({ items });

  for (const item of items) {
    // Services and drivers are system-wide, not portable.
    if (item.kind === 'service') {
      reasons.push(`Installs the service "${item.path}" — services are system-wide and cannot be made portable.`);
    }
    if (item.kind === 'task') {
      reasons.push(`Creates the scheduled task "${item.path}" — scheduled tasks run outside the app folder.`);
    }
    // Driver files (.sys) are kernel-level, not portable.
    if (item.kind === 'file' && /\.sys$/i.test(item.path)) {
      reasons.push(`Installs the driver "${item.path}" — drivers are system-wide and cannot be made portable.`);
    }
    // Licensing/activation data in the registry.
    if (item.kind === 'key' && /\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths/i.test(item.path)) {
      // App Paths is OK - it's just an app registration
    }
    if (item.kind === 'key' && /(licens|activat|productkey|registration)/i.test(item.path)) {
      reasons.push(`Writes licensing data to "${item.path}" — licensing is tied to the machine.`);
    }
    if (item.kind === 'value' && /(licens|activat|productkey|registration)/i.test(item.name || '')) {
      reasons.push(`Writes licensing value "${item.name}" — licensing is tied to the machine.`);
    }
    // Files or dirs outside the install root are dependencies elsewhere on the system.
    if (item.kind === 'file' || item.kind === 'dir') {
      if (!item.path) continue;
      const rel = item.path.toLowerCase();
      if (isProtectedPath(item.path)) continue;
      if (installRoot) {
        const root = installRoot.toLowerCase();
        if (!rel.startsWith(root) && !rel.startsWith('c:\\windows') && !rel.startsWith('c:\\programdata')) {
          reasons.push(`Writes to "${item.path}" outside the app folder — not self-contained.`);
        }
      } else {
        // No common install root: the program writes to multiple unrelated
        // locations. Flag anything not under a program-typical folder.
        const nonAppRoots = ['c:\\users\\public\\', 'c:\\users\\all users\\'];
        if (nonAppRoots.some((r) => rel.startsWith(r))) {
          reasons.push(`Writes to "${item.path}" outside a program folder — not self-contained.`);
        }
      }
    }
  }

  return {
    portable: reasons.length === 0,
    reasons,
  };
}
