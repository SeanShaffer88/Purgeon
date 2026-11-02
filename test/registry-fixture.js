// In-memory reg.exe stand-in. It never forwards a command to Windows.
import fs from 'node:fs';
export function registryFixture() {
  const keys = new Map();
  const calls = [];
  const canonical = (key) => String(key).replace(/^HKCU(?=\\)/i, 'HKEY_CURRENT_USER').replace(/^HKLM(?=\\)/i, 'HKEY_LOCAL_MACHINE').toLowerCase();
  const exec = async (file, args) => {
    calls.push([file, args]);
    if (file !== 'reg.exe') throw new Error(`Unexpected test command: ${file}`);
    const [operation, target] = args;
    const key = canonical(target);
    const value = args.includes('/v') ? args[args.indexOf('/v') + 1] : '';
    let ok = true;
    if (operation === 'add') {
      if (!keys.has(key)) keys.set(key, new Map());
      keys.get(key).set(value, args.includes('/d') ? args[args.indexOf('/d') + 1] : '');
    } else if (operation === 'query') ok = keys.has(key) && (!args.includes('/v') || keys.get(key).has(value));
    else if (operation === 'delete') {
      if (args.includes('/v') || args.includes('/ve')) ok = !!keys.get(key)?.delete(value);
      else ok = keys.delete(key);
    } else if (operation === 'export') {
      ok = keys.has(key);
      if (ok) fs.writeFileSync(args[2], `Windows Registry Editor Version 5.00\r\n\r\n[${target}]\r\n`);
    } else if (operation === 'import') {
      const text = fs.readFileSync(target, 'utf8');
      for (const match of text.matchAll(/^\[([^\]]+)\]/gm)) keys.set(canonical(match[1]), new Map([['A', '1']]));
    } else throw new Error(`Unexpected test registry operation: ${operation}`);
    return { ok, stdout: ok ? 'fixture result' : '', stderr: ok ? '' : 'Unable to find the specified registry key or value', code: ok ? 0 : 1 };
  };
  const query = async (...args) => { const result = await exec('reg.exe', args); return result.ok ? result.stdout : null; };
  return { exec, query, keys, canonical, calls };
}
