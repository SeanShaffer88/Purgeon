// Every React hook a source file calls must be imported in that file. A missing
// import is not a build error (the name is only resolved when the code runs), so
// it ships silently and kills the window the first time the component draws —
// this is the exact failure that left the v1.0.1 window black on a real machine
// (dialogs.jsx called useRef without importing it). Guard the whole tree.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOKS = ['useState', 'useEffect', 'useRef', 'useMemo', 'useCallback', 'useContext', 'useReducer'];
const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? sourceFiles(p) : /\.jsx?$/.test(e.name) ? [p] : [];
  });
}

test('every React hook called in src is imported from react in the same file', () => {
  const problems = [];
  for (const file of sourceFiles(srcDir)) {
    const code = fs.readFileSync(file, 'utf8');
    const imported = new Set();
    for (const m of code.matchAll(/import\s*\{([^}]*)\}\s*from\s*'react'/g)) {
      for (const name of m[1].split(',')) {
        const clean = name.trim().split(/\s+as\s+/)[0];
        if (clean) imported.add(clean);
      }
    }
    // Code with the react import lines removed, so an import never counts as a use.
    const body = code.replace(/import\s*\{[^}]*\}\s*from\s*'react';?/g, '');
    for (const hook of HOOKS) {
      if (new RegExp(`\\b${hook}\\s*\\(`).test(body) && !imported.has(hook)) {
        problems.push(`${path.relative(srcDir, file)} calls ${hook} without importing it`);
      }
    }
  }
  assert.deepEqual(problems, []);
});
