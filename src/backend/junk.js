// Junk files: temporary files, crash dumps, error reports and caches that Windows and programs
// recreate when needed. Only the contents of these known folders are cleaned, never the folders
// themselves, and only items left untouched for a while. Everything goes to the Recycle Bin
// (through backups.removeItems), so a cleanup can be undone. The registry is never touched.
import { sys, env } from './sys.js';
import * as path from './winpath.js';

const DAY = 24 * 3600 * 1000;

const local = (...p) => env('LOCALAPPDATA') && path.join(env('LOCALAPPDATA'), ...p);
const win = (...p) => env('SystemRoot') && path.join(env('SystemRoot'), ...p);
const progData = (...p) => env('ProgramData') && path.join(env('ProgramData'), ...p);

export const CATEGORIES = [
  { id: 'usertemp', label: 'Temporary files', detail: 'Your Temp folder. Items used in the last day are kept.', roots: () => [env('TEMP')], minAge: DAY },
  { id: 'wintemp', label: 'Windows temporary files', detail: 'The Windows Temp folder. Items used in the last day are kept.', roots: () => [win('Temp')], minAge: DAY, admin: true },
  { id: 'dumps', label: 'Crash dumps', detail: 'Memory dumps written when programs or Windows crashed.', roots: () => [local('CrashDumps'), win('Minidump')], files: () => [win('MEMORY.DMP')] },
  {
    id: 'wer',
    label: 'Windows error reports',
    detail: 'Problem reports already sent or queued for Microsoft.',
    roots: () => [progData('Microsoft', 'Windows', 'WER', 'ReportArchive'), progData('Microsoft', 'Windows', 'WER', 'ReportQueue'), local('Microsoft', 'Windows', 'WER', 'ReportArchive'), local('Microsoft', 'Windows', 'WER', 'ReportQueue')],
  },
  { id: 'thumbs', label: 'Thumbnail cache', detail: 'Explorer rebuilds thumbnails when needed. Files in use are skipped.', roots: () => [local('Microsoft', 'Windows', 'Explorer')], match: /^thumbcache_.*\.db$/i },
  { id: 'shaders', label: 'DirectX shader cache', detail: 'Compiled graphics shaders; games and apps rebuild them.', roots: () => [local('D3DSCache'), local('NVIDIA', 'DXCache'), local('AMD', 'DxCache')] },
  { id: 'update', label: 'Windows Update downloads', detail: 'Update files already downloaded. Windows downloads them again if still needed.', roots: () => [win('SoftwareDistribution', 'Download')], minAge: 3 * DAY, admin: true },
  {
    id: 'delivery',
    label: 'Delivery Optimization cache',
    detail: 'Update pieces kept to share with other PCs.',
    roots: () => [win('ServiceProfiles', 'NetworkService', 'AppData', 'Local', 'Microsoft', 'Windows', 'DeliveryOptimization', 'Cache')],
    admin: true,
  },
];

const allRoots = () =>
  CATEGORIES.flatMap((c) => c.roots())
    .filter(Boolean)
    .map((r) => path.resolve(r).toLowerCase());
const allFiles = () =>
  CATEGORIES.flatMap((c) => (c.files ? c.files() : []))
    .filter(Boolean)
    .map((r) => path.resolve(r).toLowerCase());

// Whether a path may be cleaned as junk: strictly inside one of the junk folders, or one of the known junk files.
export function isJunkPath(p) {
  if (!p || !/^[a-z]:\\/i.test(p) || /(^|\\)\.\.(\\|$)/.test(p)) return false;
  const n = path.resolve(p).toLowerCase().replace(/\\+$/, '');
  return allFiles().includes(n) || allRoots().some((r) => n.startsWith(r + '\\'));
}

// Lists what each category would clean: [{ id, label, detail, admin, bytes, items: [{ path, dir, bytes }] }].
export async function scan(now = Date.now()) {
  const own = [sys.info.dataDir].filter(Boolean).map((d) => path.resolve(d).toLowerCase());
  return Promise.all(
    CATEGORIES.map(async (c) => {
      const items = [];
      for (const root of [...new Set(c.roots().filter(Boolean))]) {
        for (const e of await sys.listJunk(root, 8000).catch(() => [])) {
          if (c.match && !c.match.test(path.basename(e.path))) continue;
          if (c.minAge && now - e.newest < c.minAge) continue;
          if (own.some((o) => e.path.toLowerCase().startsWith(o))) continue;
          items.push({ path: e.path, dir: e.dir, bytes: e.bytes });
        }
      }
      for (const f of (c.files ? c.files() : []).filter(Boolean)) {
        const s = await sys.stat(f).catch(() => null);
        if (s && !s.dir) items.push({ path: f, dir: false, bytes: s.size });
      }
      return { id: c.id, label: c.label, detail: c.detail, admin: !!c.admin, bytes: items.reduce((n, i) => n + i.bytes, 0), items };
    })
  );
}

// Cleanup items for backups.removeItems from the chosen categories of a scan.
export const cleanupItems = (categories) =>
  categories.flatMap((c) => c.items.map((i) => ({ kind: 'junk', path: i.path, dir: i.dir, bytes: i.bytes, confidence: 'high', reason: c.label })));
