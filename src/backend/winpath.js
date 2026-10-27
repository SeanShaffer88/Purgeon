// Windows path helpers (the webview has no Node.js "path" module).

export const sep = '\\';

const clean = (p) => String(p || '').replace(/\//g, '\\');

// Joins parts with single backslashes.
export function join(...parts) {
  const filtered = parts.map(clean).filter((p) => p !== '');
  if (!filtered.length) return '.';
  return resolveDots(filtered.join('\\').replace(/\\{2,}/g, (m, i) => (i === 0 ? '\\\\' : '\\')));
}

// Collapses "." and ".." in an absolute path; relative paths are returned as they are.
export function resolve(p) {
  return /^[a-z]:[\\/]/i.test(clean(p)) ? resolveDots(clean(p)) : clean(p);
}

function resolveDots(p) {
  const m = p.match(/^([a-z]:)\\?(.*)$/i);
  if (!m) return p;
  const out = [];
  for (const seg of m[2].split('\\')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return `${m[1]}\\${out.join('\\')}`;
}

export function basename(p, ext) {
  const b = clean(p).replace(/\\+$/, '').split('\\').pop();
  return ext && b.toLowerCase().endsWith(ext.toLowerCase()) ? b.slice(0, -ext.length) : b;
}

export function dirname(p) {
  const s = clean(p).replace(/\\+$/, '');
  const i = s.lastIndexOf('\\');
  if (i < 0) return '.';
  return i === 2 && /^[a-z]:/i.test(s) ? s.slice(0, 3) : s.slice(0, i);
}

export function extname(p) {
  const b = basename(p);
  const i = b.lastIndexOf('.');
  return i > 0 ? b.slice(i) : '';
}

// Relative path from one absolute Windows path to another, with Node's
// path.win32.relative semantics for the cases this app meets: same drive
// gives ".." steps plus the remaining segments (compared without case, as
// Windows does); different drives give the target unchanged.
export function relative(from, to) {
  const f = resolve(from);
  const t = resolve(to);
  const fd = (f.match(/^([a-z]:)/i) || [])[1]?.toLowerCase();
  const td = (t.match(/^([a-z]:)/i) || [])[1]?.toLowerCase();
  if (!fd || !td || fd !== td) return t;
  const fs = f.slice(2).split('\\').filter(Boolean);
  const ts = t.slice(2).split('\\').filter(Boolean);
  let i = 0;
  while (i < fs.length && i < ts.length && fs[i].toLowerCase() === ts[i].toLowerCase()) i++;
  const parts = [...Array(fs.length - i).fill('..'), ...ts.slice(i)];
  return parts.length ? parts.join('\\') : '.';
}
