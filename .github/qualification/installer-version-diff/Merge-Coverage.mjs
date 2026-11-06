// External, offline accounting. No builds, tests, counter synthesis or floor changes.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const read = filename => JSON.parse(fs.readFileSync(filename,'utf8').replace(/^\uFEFF/,''));
const check = (condition,message) => { if (!condition) throw new Error(message); };
const digestFile = filename => sha(fs.readFileSync(filename));
const samePath = (a,b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
try {
  const args = process.argv.slice(2);
  check(args.length === 5,'Usage: node Merge-Coverage.mjs <node-manifest> <node-evidence> <native-run> <new-output-directory> <absolute-llvm-cov>');
  const [manifestPath,evidencePath,nativeRun,out,llvmCov] = args.map(p => path.resolve(p));
  const manifest = read(manifestPath), evidence = read(evidencePath);
  const reporter = path.join(manifest.sourceRoot,'scripts/coverage-report.mjs');
  const { canonical, sourceTreeHash, inventory, metricVersion, rustTestModules } = await import(pathToFileURL(reporter));
  const digest = value => sha(JSON.stringify(canonical(value)));
  check(manifest.schemaVersion === 1 && evidence.schemaVersion === 1,'Invalid Node schemas');
  check(manifest.sourceTreeHash === sourceTreeHash(manifest.files,manifest.externalScripts || []) && evidence.sourceTreeHash === manifest.sourceTreeHash,'Frozen tree identity mismatch');
  check(evidence.instrumentationId === manifest.instrumentationId && digest(evidence.instrumentation) === evidence.instrumentationId,'Node instrumentation mismatch');
  check(evidence.runs.length > 0 && evidence.runs.every(r => r.kind === 'node-v8' && r.sourceTreeHash === manifest.sourceTreeHash && r.instrumentationId === manifest.instrumentationId),'Expected compatible fresh Node runs only');
  const actual = inventory(manifest.sourceRoot);
  check(JSON.stringify(actual) === JSON.stringify(manifest.files.map(({path,language}) => ({path,language}))), 'Frozen inventory differs');
  for (const file of manifest.files) {
    const bytes = fs.readFileSync(path.join(manifest.sourceRoot,file.path));
    check(sha(bytes) === file.sha256,`Frozen source changed: ${file.path}`);
    const proven = file.language === 'rust' ? rustTestModules(bytes.toString('utf8')) : [];
    for (const range of file.excludedRanges || []) check(proven.some(r => JSON.stringify(r) === JSON.stringify(range)),`Unsupported exclusion: ${file.path}`);
  }
  const before = read(path.join(nativeRun,'source-before.json'));
  const after = read(path.join(nativeRun,'source-after.json'));
  const normalizeSnapshot = rows => rows.map(r => ({path:r.path,sha256:r.sha256.toLowerCase()})).sort((a,b) => a.path.localeCompare(b.path));
  check(JSON.stringify(normalizeSnapshot(before)) === JSON.stringify(normalizeSnapshot(after)), 'Native source snapshots differ');
  for (const row of before) check(digestFile(path.join(manifest.sourceRoot,row.path)) === row.sha256.toLowerCase(),`Native snapshot changed: ${row.path}`);
  const result = read(path.join(nativeRun,'result.json'));
  check(result.testExitCode === 0 && result.exportExitCode === 0 && result.sourceUnchanged === true,'Native collection did not complete successfully with unchanged sources');
  const provenance = read(path.join(nativeRun,'export/provenance.json'));
  check(provenance.metricVersion === metricVersion,'Native metric version mismatch');
  for (const input of [...provenance.inputs,...provenance.objects,provenance.profile]) check(digestFile(input.path) === input.sha256.toLowerCase(),`Native input changed: ${input.path}`);
  for (const file of manifest.files.filter(f => f.language === 'rust')) {
    check(before.some(r => r.path === file.path && r.sha256.toLowerCase() === file.sha256),`Native source absent from frozen snapshot: ${file.path}`);
    check(provenance.inputs.some(r => samePath(r.path,path.join(manifest.sourceRoot,file.path)) && r.sha256.toLowerCase() === file.sha256),`Native export source mismatch: ${file.path}`);
  }
  check(provenance.inputs.some(r => samePath(r.path,llvmCov) && r.sha256.toLowerCase() === digestFile(llvmCov)),'LLVM tool absent from export provenance');
  const rustVersion = provenance.compilerVersion.match(/^release: (\S+)\r?$/m)?.[1];
  const llvmVersion = provenance.compilerVersion.match(/^LLVM version: (\S+)\r?$/m)?.[1];
  check(rustVersion === '1.99.0' && llvmVersion === '23.1.1' && provenance.version.includes('LLVM version '+llvmVersion),'Unexpected native versions');
  // Verify the actual recorded wrapper and harness, including build-script instrumentation.
  const tools = read(path.join(nativeRun,'tool-inputs.json'));
  for (const tool of tools) check(digestFile(tool.Path) === tool.Hash.toLowerCase(),`Recorded collection tool changed: ${tool.Path}`);
  for (const name of ['workspace-wrapper.exe','workspace-wrapper.rs','Collect-NativeCoverage.ps1']) check(tools.some(t => path.basename(t.Path) === name),`Missing wrapper/harness evidence: ${name}`);
  const settings = {...evidence.instrumentation,rustVersion,llvmVersion,nativeFlags:['-Cinstrument-coverage'],nativeBuildScript:{wrapperSha256:tools.find(t => path.basename(t.Path) === 'workspace-wrapper.exe').Hash.toLowerCase(),policy:'Configured workspace build_script_build receives -Cinstrument-coverage; all other compiler arguments forwarded'}};
  const instrumentationId = digest(settings);
  const mergedManifest = {...manifest,instrumentation:settings,instrumentationId};
  const nativeArtifacts = {profdataPath:provenance.profile.path,profdataSha256:provenance.profile.sha256,objects:provenance.objects,jsonPath:path.join(nativeRun,'export/llvm.json'),lcovPath:path.join(nativeRun,'export/llvm.lcov')};
  const mergedEvidence = {...evidence,instrumentation:settings,instrumentationId,runs:[...evidence.runs.map(r => ({...r,instrumentationId})),{id:'native-'+path.basename(nativeRun),kind:'native-llvm',sourceTreeHash:manifest.sourceTreeHash,instrumentationId,artifacts:nativeArtifacts}]};
  check(!samePath(out,manifest.sourceRoot) && !path.relative(manifest.sourceRoot,out).split(path.sep).every(p => p !== '..'),'Output must be outside the product repository');
  fs.mkdirSync(out); // refuse existing output; never overwrite earlier evidence
  const save = (name,value) => fs.writeFileSync(path.join(out,name),JSON.stringify(value,null,2)+'\n',{flag:'wx'});
  save('manifest.json',mergedManifest); save('evidence.json',mergedEvidence);
  save('merge-inputs.json',{inputs:[manifestPath,evidencePath,path.join(nativeRun,'export/provenance.json'),path.join(nativeRun,'source-before.json'),path.join(nativeRun,'source-after.json'),reporter].map(p => ({path:p,sha256:digestFile(p)})),limitation:'Node-only workload; no WebView run. Hashes verify recorded bytes, not workload authenticity. Native source-map gaps remain incomplete.'});
  const reportArgs = [reporter,'--manifest',path.join(out,'manifest.json'),'--evidence',path.join(out,'evidence.json'),'--out',path.join(out,'report.json'),'--llvm-cov',llvmCov];
  const execution = spawnSync(process.execPath,reportArgs,{encoding:'utf8',windowsHide:true,maxBuffer:16*1024*1024});
  fs.writeFileSync(path.join(out,'report.stdout.log'),execution.stdout || '',{flag:'wx'});
  fs.writeFileSync(path.join(out,'report.stderr.log'),execution.stderr || '',{flag:'wx'});
  save('execution.json',{executable:process.execPath,args:reportArgs,exitCode:execution.status,signal:execution.signal,error:execution.error?.message});
  console.log(JSON.stringify({output:out,reporterExitCode:execution.status}));
  process.exitCode = execution.status ?? 2;
} catch (error) { console.error(error.message); process.exitCode = 2; }
