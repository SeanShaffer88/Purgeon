// Relationship Graph (Tools › Advanced Tools): how each program connects to
// the rest of the system — the services, scheduled tasks and startup entries
// that run its files — joined entirely on this PC from data Purgeon already
// gathers. Entries that point at files no longer on the PC, and belong to no
// installed program, are listed first as orphans.
import { sys } from './sys.js';
import { listDesktop, listStore } from './programs.js';
import * as startup from './startup.js';
import { readState, dependencyInfo } from './safety.js';

const clean = (p) => String(p || '').replace(/^"|"$/g, '').trim().replace(/\\+$/, '');
const inside = (child, parent) => {
  const c = clean(child).toLowerCase();
  const p = clean(parent).toLowerCase();
  return !!p && (c === p || c.startsWith(p + '\\'));
};

// The executable a startup entry's command actually runs.
export function exeOf(command) {
  const cmd = String(command || '').trim();
  if (!cmd) return '';
  const quoted = /^"([^"]+)"/.exec(cmd);
  if (quoted) return quoted[1];
  const m = /^(.+?\.(?:exe|com|bat|cmd|lnk))\b/i.exec(cmd);
  if (m) return m[1];
  return cmd.split(/\s+/)[0] || '';
}

export const KIND_LABEL = { run: 'Startup entry', folder: 'Startup entry', task: 'Scheduled task', service: 'Service' };

// Joins startup entries to programs by install folder. Pure, so the join is
// unit-tested: an entry belongs to a program when the file it runs lives
// inside that program's install folder. Entries matching no program come
// back as orphan candidates (their caller checks whether the file is
// actually gone).
export function buildGraph(programs, entries) {
  const nodes = (programs || [])
    .filter((p) => p && p.name)
    .map((p) => ({ name: p.name, publisher: p.publisher || '', location: clean(p.location), key: p.key || '', links: [] }));
  const orphanCandidates = [];
  for (const e of entries || []) {
    const target = exeOf(e.command);
    const owner = target ? nodes.find((n) => n.location && inside(target, n.location)) : null;
    const shaped = { kind: KIND_LABEL[e.type] || 'Entry', type: e.type, label: e.name, target, where: e.where || '', serviceName: e.serviceName || '', taskPath: e.type === 'task' ? e.path || '' : '' };
    if (owner) owner.links.push(shaped);
    else orphanCandidates.push(shaped);
  }
  nodes.sort((a, b) => b.links.length - a.links.length || a.name.localeCompare(b.name));
  return { nodes, orphanCandidates };
}

export async function graph(shouldStop) {
  const [desktop, store, entries] = await Promise.all([listDesktop().catch(() => []), listStore().catch(() => []), startup.list().catch(() => [])]);
  const { nodes, orphanCandidates } = buildGraph([...desktop, ...store], entries);
  // An orphan is only claimed when the file it points at is verifiably
  // gone — "not matched to a program" alone proves nothing.
  const orphans = [];
  let cancelled = false;
  for (const o of orphanCandidates) {
    if (shouldStop && shouldStop()) { cancelled = true; break; }
    if (o.target && /^[a-z]:\\/i.test(o.target) && !(await sys.exists(o.target).catch(() => true))) orphans.push(o);
  }
  return { programs: nodes, orphans, cancelled };
}

// The selected program's deeper links, computed on demand: which installed
// programs registered a need for it, and how many shared files live in its
// folder.
export async function programLinks(program) {
  const [dep, state] = await Promise.all([dependencyInfo(program).catch(() => null), readState().catch(() => ({ shared: [] }))]);
  const sharedFiles = program.location ? (state.shared || []).filter((s) => inside(s.path, program.location)).length : 0;
  return { dependents: dep?.dependents || [], unknown: dep?.unknown || 0, note: dep?.note || '', sharedFiles };
}
