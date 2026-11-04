// Export existing instrumented cargo artifacts; does not build or run programs.
// Usage: node scripts/collect-native-coverage.mjs <target-dir> <matching-llvm-bin> <new-output-dir>
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hash, inventory, validateNativeExports, metricVersion } from './coverage-report.mjs';

const root = fileURLToPath(new URL('../',import.meta.url));
if (process.argv.length !== 5) throw new Error('Expected target directory, matching LLVM bin directory, new output directory');
const [target, llvm, destination] = process.argv.slice(2).map((value) => path.resolve(value));
fs.mkdirSync(destination); // refuse overwriting an earlier evidence set
const save = (name,value) => fs.writeFileSync(path.join(destination,name),JSON.stringify(value,null,2)+'\n',{flag:'wx'});
const sha = (filename) => hash(fs.readFileSync(filename));
const calls = [];
function invoke(executable,args,output) {
  const result = spawnSync(executable,args,{encoding:'utf8',windowsHide:true,maxBuffer:256*1024*1024,timeout:120000});
  calls.push({executable,args,exitCode:result.status,error:result.error?.message,stderr:result.stderr,stdoutSHA256:hash(result.stdout || '')});
  save('calls-'+calls.length+'.json',calls.at(-1));
  if (output) fs.writeFileSync(path.join(destination,output),result.stdout || '',{flag:'wx'});
  if (result.error || result.status !== 0) throw new Error(`Command failed (${result.status}): ${result.error?.message || result.stderr}`);
  return result.stdout;
}
const cov = path.join(llvm,'llvm-cov.exe'), prof = path.join(llvm,'llvm-profdata.exe');
const version = invoke(cov,['--version']);
const compiler = path.resolve(llvm,'../../../../bin/rustc.exe');
const compilerVersion = invoke(compiler,['-Vv']);
const llvmVersion = version.match(/LLVM version\s+(\d+\.\d+\.\d+)(?:-rust-(\S+))?/i);
if (!llvmVersion || compilerVersion.match(/LLVM version:\s+(\S+)/)?.[1] !== llvmVersion[1] || llvmVersion[2] && !compilerVersion.includes('release: '+llvmVersion[2].replace(/-stable$/,''))) throw new Error('Compiler and LLVM tool versions do not match');
const rows = fs.readFileSync(path.join(target,'cargo.jsonl'),'utf8').split(/\r?\n/).filter((line) => line.startsWith('{')).map((line) => JSON.parse(line));
if (!rows.some((row) => row.reason === 'build-finished' && row.success)) throw new Error('Cargo evidence does not contain a successful completed build');
const objects = [...new Set(rows.filter((row) => row.reason === 'compiler-artifact' && row.manifest_path && path.resolve(row.manifest_path) === path.join(root,'src-tauri','Cargo.toml')).flatMap((row) => [...(row.filenames || []),row.executable].filter((name) => name && /\.(exe|dll)$/i.test(name))))].sort();
const profiles = fs.readdirSync(path.join(target,'profiles')).filter((name) => name.endsWith('.profraw')).sort().map((name) => path.join(target,'profiles',name));
if (!objects.length || !profiles.length) throw new Error('Missing objects or raw profiles');
const sources = inventory(root).filter((file) => file.language === 'rust').map((file) => path.join(root,file.path));
const inputs = [...objects,...profiles,cov,prof,compiler,...sources,path.join(target,'cargo.jsonl'),path.join(root,'src-tauri','Cargo.lock')].map((filename) => ({path:filename,sha256:sha(filename)}));
save('inputs.json',inputs);
const profile = path.join(destination,'merged.profdata');
invoke(prof,['merge','-sparse',...profiles,'-o',profile]);
const args = ['export',objects[0],...objects.slice(1).map((name) => '-object='+name),'-instr-profile='+profile,...sources];
invoke(cov,args,'llvm.json');
invoke(cov,[...args,'-format=lcov'],'llvm.lcov');
for (const input of inputs) if (sha(input.path) !== input.sha256) throw new Error(`Input changed during export: ${input.path}`);
const json = JSON.parse(fs.readFileSync(path.join(destination,'llvm.json'),'utf8'));
const entries = new Map(inventory(root).filter((file) => file.language === 'rust').map((file) => [file.path,{...file,source:fs.readFileSync(path.join(root,file.path),'utf8')}]));
const validated = validateNativeExports(JSON.stringify(json),fs.readFileSync(path.join(destination,'llvm.lcov'),'utf8'),entries,root);
const diagnostics = [...entries.keys()].map((filename) => {
  const record = validated.get(filename);
  return record ? {filename,aggregate:record.aggregate,unique:record.unique} : {filename,status:'unknown',reason:'Missing native source mapping'};
});
save('diagnostics.json',diagnostics);
save('provenance.json',{metricVersion,version,compilerVersion,inputs,objects:objects.map((filename) => ({path:filename,sha256:sha(filename)})),profile:{path:profile,sha256:sha(profile)},calls,limitation:'Hashes freeze export inputs, not source bytes at compilation. Verify the pre-build source snapshot before claiming final coverage.'});
console.log(JSON.stringify({destination,objects:objects.length,profiles:profiles.length,files:diagnostics.length,unknown:diagnostics.filter((file) => file.status === 'unknown'),aggregateDifferences:diagnostics.filter((file) => file.aggregate && (file.aggregate.count !== file.unique.count || file.aggregate.covered !== file.unique.covered))}));
