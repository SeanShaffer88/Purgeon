import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setSys } from '../src/backend/sys.js';
import { createNodeSys } from './node-sys.js';
import { exportProgram } from '../src/backend/transfer.js';

test('export validates a sibling ZIP before commit, excludes itself, and preserves an old package on failure', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'purgeon-export-atomic-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const final = path.join(dir, 'existing.swpkg');
  fs.writeFileSync(path.join(dir, 'source.txt'), 'fixture');
  const base = createNodeSys();
  for (const failCommit of [true, false]) {
    fs.writeFileSync(final, 'old package');
    let staged;
    let commits = 0;
    setSys({ ...base, commitStagedFile: async (source, target) => {
      commits++;
      staged = source;
      assert.equal(path.dirname(source), path.dirname(target));
      assert.equal(fs.readFileSync(target, 'utf8'), 'old package', 'old destination survives ZIP generation and validation');
      assert.ok(fs.statSync(source).size > 0);
      if (failCommit) throw new Error('Injected replacement failure');
      fs.renameSync(source, target);
    } });
    const operation = () => exportProgram({ name: 'Fixture', key: 'fixture' }, [{ kind: 'dir', path: dir }], final);
    if (failCommit) {
      await assert.rejects(operation, /previous package was retained/);
      assert.equal(fs.readFileSync(final, 'utf8'), 'old package');
      assert.equal(fs.existsSync(staged), true, 'failed native commit preserves the diagnostic stage');
      fs.unlinkSync(staged); // Fixture-owned cleanup, never a product delete capability.
    } else {
      const result = await operation();
      assert.equal(result.file, final);
      assert.equal(result.items[0].files, 1, `neither final output nor open staging ZIP is archived recursively; ${JSON.stringify(fs.readdirSync(dir))}`);
      assert.equal(fs.readFileSync(final).subarray(0, 2).toString(), 'PK');
      const zipNames = await base.runPS(`Add-Type -AssemblyName System.IO.Compression.FileSystem; $zip = [IO.Compression.ZipFile]::OpenRead('${final.replace(/'/g, "''")}'); try { @($zip.Entries | ForEach-Object FullName) | ConvertTo-Json -Compress } finally { $zip.Dispose() }`);
      assert.deepEqual(JSON.parse(zipNames), ['files/0/source.txt', 'manifest.json']);
    }
    assert.equal(commits, 1);
    assert.equal(fs.existsSync(staged), false, 'only the owned stage is removed or committed');
  }
});
