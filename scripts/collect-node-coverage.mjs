// Diagnostic source-based Node coverage. Does not exercise the production WebView.
// Usage: node scripts/collect-node-coverage.mjs <new-output-directory>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { inventory, hash, canonical, sourceTreeHash, metricVersion, rustTestModules, reportCoverage } from './coverage-report.mjs';

export function collectScriptFiles(root, files, coverageFiles) {
  // Windows paths are case-insensitive; raw V8 URL identities remain unchanged.
  const key = (filename) => process.platform === 'win32' ? filename.toLowerCase() : filename;
  const sources = new Map(files.filter((file) => file.language === 'javascript').map((file) => {
    const sourcePath = path.resolve(root,file.path);
    if (hash(fs.readFileSync(sourcePath)) !== file.sha256) throw new Error('Source hash changed: '+file.path);
    return [key(sourcePath),{sourcePath,sourceSha256:file.sha256}];
  }));
  const descriptors = new Map([...sources.values()].map((source) => {
    const url = pathToFileURL(source.sourcePath).href;
    return [url,{url,...source}];
  }));
  for (const filename of coverageFiles) {
    for (const script of JSON.parse(fs.readFileSync(filename)).result) {
      if (!script.url.startsWith('file:')) continue;
      const sourceUrl = new URL(script.url);
      sourceUrl.search = '';
      sourceUrl.hash = '';
      const source = sources.get(key(fileURLToPath(sourceUrl)));
      if (source) descriptors.set(script.url,{url:script.url,...source});
    }
  }
  return [...descriptors.values()];
}

export function collectSourceFiles(root) {
return inventory(root).map((entry) => {
  const source = fs.readFileSync(path.join(root,entry.path));
  return {...entry,sha256:hash(source),core:entry.language === 'javascript' ? entry.path.startsWith('src/backend/') || entry.path.startsWith('packages/purgeon-core/src/') || ['src/cli.js','src/cli-args.js'].includes(entry.path) : entry.path.startsWith('src-tauri/src/') && entry.path !== 'src-tauri/src/main.rs',excludedRanges:entry.language === 'rust' ? rustTestModules(source.toString('utf8')) : []};
});
}

function main() {
const root = fileURLToPath(new URL('../', import.meta.url));
const destination = process.argv[2] && path.resolve(process.argv[2]);
if (process.argv.length !== 3 || !destination || fs.existsSync(destination)) throw new Error('Supply a new output directory');
fs.mkdirSync(destination, { recursive: true });
const save = (name, value) => fs.writeFileSync(path.join(destination,name), JSON.stringify(value,null,2)+'\n', {flag:'wx'});
const files = collectSourceFiles(root);
const workload = [process.execPath,path.join(root,'package-lock.json'),...fs.readdirSync(path.join(root,'test'),{recursive:true}).filter((name) => /\.(js|json)$/.test(name)).map((name) => path.join(root,'test',name))].map((filename) => ({path:filename,sha256:hash(fs.readFileSync(filename))}));
save('workload-inputs.json',workload);
const instrumentation = {metricVersion,nodeVersion:process.version,webviewVersion:null,viteVersion:JSON.parse(fs.readFileSync(path.join(root,'node_modules/vite/package.json'))).version,jsFlags:{precise:true,detailed:true,sourceMaps:true,productionMode:true},rustVersion:null,llvmVersion:null,target:'x86_64-pc-windows-msvc',nativeFlags:[]};
const manifest = {schemaVersion:1,sourceRoot:root,sourceTreeHash:sourceTreeHash(files),instrumentationId:hash(JSON.stringify(canonical(instrumentation))),files};
save('manifest.json',manifest);
const rawDirectory = path.join(destination,'raw');
fs.mkdirSync(rawDirectory);
const args = ['--test','test/*.test.js'];
const result = spawnSync(process.execPath,args,{cwd:root,env:{...process.env,NODE_V8_COVERAGE:rawDirectory},encoding:'utf8',windowsHide:true,timeout:300000,maxBuffer:64*1024*1024});
fs.writeFileSync(path.join(destination,'stdout.log'),result.stdout || '');
fs.writeFileSync(path.join(destination,'stderr.log'),result.stderr || '');
save('execution.json',{executable:process.execPath,args,exitCode:result.status,signal:result.signal,error:result.error?.message,scope:'Node test adapter diagnostic; productionMode describes source accounting only, not a production WebView workload'});
const coverageFiles = fs.readdirSync(rawDirectory).filter((name) => name.endsWith('.json')).sort().map((name) => path.join(rawDirectory,name));
save('raw-hashes.json',coverageFiles.map((filename) => ({path:filename,sha256:hash(fs.readFileSync(filename))})));
const changed = [...files.map((file) => ({path:path.join(root,file.path),sha256:file.sha256})),...workload].filter((file) => !fs.existsSync(file.path) || hash(fs.readFileSync(file.path)) !== file.sha256).map((file) => file.path);
if (changed.length) {
  save('report.json',{schemaVersion:1,metricVersion,verdict:'invalid',exitCode:2,changedInputs:changed,testExitCode:result.status,incompleteReasons:['Inputs changed during collection; do not merge counters with a newer source tree']});
  console.error('Inputs changed during collection: '+changed.join(', '));
  process.exit(2);
}
const scriptFiles = collectScriptFiles(root,files,coverageFiles);
const evidence = {schemaVersion:1,sourceTreeHash:manifest.sourceTreeHash,instrumentationId:manifest.instrumentationId,instrumentation,runs:[{id:'node-tests',kind:'node-v8',sourceTreeHash:manifest.sourceTreeHash,instrumentationId:manifest.instrumentationId,artifacts:{coverageFiles,scriptFiles}}]};
save('evidence.json',evidence);
const report = reportCoverage(manifest,evidence);
if (result.status !== 0) {
  report.verdict = 'incomplete';
  report.exitCode = 2;
  report.incompleteReasons.push('Node test workload did not complete successfully');
}
report.collection = {testExitCode:result.status,diagnosticOnly:true,missing:['Production WebView workload','Native LLVM profile and objects']};
save('report.json',report);
save('artifact-hashes.json',fs.readdirSync(destination).filter((name) => fs.statSync(path.join(destination,name)).isFile()).map((name) => ({path:name,sha256:hash(fs.readFileSync(path.join(destination,name)))})));
console.log(JSON.stringify({destination,testExitCode:result.status,verdict:report.verdict,languages:report.languages}));
process.exitCode = result.status === 0 ? report.exitCode : 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
