import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root = fileURLToPath(new URL('../', import.meta.url));
const npm = process.env.npm_execpath;
if (!npm) throw new Error('Run through npm run test:package');
const tempRoot = fs.realpathSync(os.tmpdir());
const destination = fs.mkdtempSync(path.join(tempRoot, 'purgeon-core-consumer-'));
console.log(`Standalone consumer: ${destination}`);
function run(args, cwd = destination) {
  const result = spawnSync(process.execPath, [npm, ...args, '--cache', path.join(destination, 'cache')], { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${args.join(' ')} exited ${result.status}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
try {
  const packed = JSON.parse(run(['pack', './packages/purgeon-core', '--offline', '--ignore-scripts', '--json', '--pack-destination', destination], root))[0];
  fs.writeFileSync(path.join(destination, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  run(['install', path.join(destination, packed.filename), '--offline', '--ignore-scripts', '--no-audit', '--no-fund']);
  fs.copyFileSync(new URL('./core-consumer-test.mjs', import.meta.url), path.join(destination, 'test.mjs'));
  for (const mode of ['approved', 'denied', 'missing', 'throws', 'nonliteral', 'failed', 'app-owned', 'example']) {
    const result = spawnSync(process.execPath, ['test.mjs', mode], { cwd: destination, encoding: 'utf8' });
    process.stdout.write(result.stdout);
    if (result.status !== 0) throw new Error(`Packed consumer ${mode} exited ${result.status}\n${result.stderr}`);
  }
  console.log(`Packed ${packed.filename}: ${packed.files.length} files; independent offline consumer passed`);
  const artifacts = path.join(root, 'out', 'core');
  fs.mkdirSync(artifacts, { recursive: true });
  const artifact = path.join(artifacts, packed.filename);
  fs.copyFileSync(path.join(destination, packed.filename), artifact);
  const sha256 = createHash('sha256').update(fs.readFileSync(artifact)).digest('hex');
  fs.writeFileSync(artifact + '.sha256', sha256 + '  ' + packed.filename + '\n');
  console.log(`Verified artifact: ${artifact}\nSHA256: ${sha256}`);
} finally {
  const resolved = fs.realpathSync(destination);
  if (path.dirname(resolved) !== tempRoot || !path.basename(resolved).startsWith('purgeon-core-consumer-')) {
    throw new Error(`Refusing cleanup outside owned temporary directory: ${resolved}`);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}
