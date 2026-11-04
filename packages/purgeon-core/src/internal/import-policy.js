import { isProtectedKey, isProtected } from './paths.js';
import * as path from './winpath.js';

const keyName = (key) => String(key).replace(/^HKLM\\/i, 'HKEY_LOCAL_MACHINE\\').replace(/^HKCU\\/i, 'HKEY_CURRENT_USER\\').toLowerCase();
export function validateTarget(target, kind) {
  if (typeof target !== 'string' || target.length > 4096 || /[\x00-\x1f]/.test(target)) throw new Error('Invalid import target');
  if (['key', 'value'].includes(kind)) {
    if (isProtectedKey(target) || target.includes('/') || /\\(?:\.|\.\.)\\/.test(target)) throw new Error('Protected Windows registry target');
  } else if (['file', 'dir'].includes(kind)) {
    if (isProtected(target) || target.slice(2).includes(':') || /(^|[\\/])\.\.?([\\/]|$)/.test(target) || /(^|[\\/])(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|[\\/]|$)/i.test(target) || /[. ]([\\/]|$)/.test(target)) throw new Error('Unsafe import path');
    if (path.resolve(target).toLowerCase() !== target.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()) throw new Error('Import path is not canonical');
  } else throw new Error('Unsupported package item kind');
}

// Every header must belong to the approved key. Delete directives are forbidden.
// Value syntax is constrained too, so a malformed line cannot introduce a key.
export function validateRegistryText(text, target) {
  validateTarget(target, 'key');
  if (typeof text !== 'string' || text.length > 8 * 1024 * 1024 || text.includes('\0')) throw new Error('Invalid registry payload');
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (!/^Windows Registry Editor Version 5\.00$/.test(lines.shift()?.trim() || '')) throw new Error('Unsupported registry export');
  let headers = 0, continuation = false;
  const root = keyName(target);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith(';')) continue;
    if (line.startsWith('[')) {
      if (continuation || !/^\[[^\[\]\x00-\x1f]+\]$/.test(line) || line.startsWith('[-')) throw new Error('Registry deletion or malformed header');
      const key = line.slice(1, -1); const normalized = keyName(key);
      if (isProtectedKey(key) || normalized !== root && !normalized.startsWith(root + '\\')) throw new Error('Registry contents differ from the approved target');
      headers++; continue;
    }
    if (!headers) throw new Error('Registry value before key');
    if (continuation) {
      if (!/^[0-9a-f,\s\\]+$/i.test(line)) throw new Error('Invalid continued registry value');
    } else if (!/^(?:@|"(?:[^"\\]|\\.)*")=(?:"(?:[^"\\]|\\.)*"|dword:[0-9a-f]{1,8}|hex(?:\([0-9a-f]+\))?:[0-9a-f,\s\\]*)$/i.test(line)) throw new Error('Unsupported registry value syntax');
    continuation = line.endsWith('\\');
  }
  if (!headers || continuation) throw new Error('Incomplete registry export');
  return text;
}
