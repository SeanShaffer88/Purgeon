import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { SourceMapGenerator } from 'source-map-js';
import { executableAnchors, rangeHit, reportCoverage, sourceTreeHash, hash, canonical, metricVersion, rustTestModules } from '../scripts/coverage-report.mjs';

function setup(t, sources = { 'src/backend/a.js': 'export const a = 1;\n' }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'purgeon-coverage-'));
  t.after(() => fs.rmSync(root,{recursive:true,force:true}));
  const files = Object.entries(sources).map(([name,source]) => {
    fs.mkdirSync(path.dirname(path.join(root,name)),{recursive:true});
    fs.writeFileSync(path.join(root,name),source);
    return { path:name,sha256:hash(source),language:'javascript',core:name.startsWith('src/backend/') || ['src/cli.js','src/cli-args.js'].includes(name) };
  });
  const instrumentation = { metricVersion,nodeVersion:process.version,webviewVersion:'fixture',viteVersion:'8.3.5',jsFlags:{precise:true,detailed:true,sourceMaps:true,productionMode:true},rustVersion:null,llvmVersion:null,target:'x86_64-pc-windows-msvc',nativeFlags:[] };
  const manifest = { schemaVersion:1,sourceRoot:root,sourceTreeHash:sourceTreeHash(files),instrumentationId:hash(JSON.stringify(canonical(instrumentation))),files };
  const evidence = { schemaVersion:1,sourceTreeHash:manifest.sourceTreeHash,instrumentationId:manifest.instrumentationId,instrumentation,runs:[] };
  function rawRun(id, relative, count = 1) {
    const sourcePath = path.join(root,relative);
    const source = fs.readFileSync(sourcePath,'utf8');
    const url = pathToFileURL(sourcePath).href;
    const coveragePath = path.join(root,`${id}.json`);
    fs.writeFileSync(coveragePath,JSON.stringify({result:[{scriptId:'1',url,functions:[{functionName:'',isBlockCoverage:true,ranges:[{startOffset:0,endOffset:source.length,count}]}]}]}));
    const run = { id,kind:'node-v8',sourceTreeHash:manifest.sourceTreeHash,instrumentationId:manifest.instrumentationId,artifacts:{coverageFiles:[coveragePath],scriptFiles:[{url,sourcePath,sourceSha256:hash(source)}]} };
    evidence.runs.push(run);
    return run;
  }
  return { root,manifest,evidence,rawRun };
}

test('innermost zero V8 ranges override a positive module and preserve UTF16 offsets', () => {
  const functions = [{ranges:[{startOffset:0,endOffset:30,count:1}]},{ranges:[{startOffset:5,endOffset:20,count:0},{startOffset:10,endOffset:15,count:1}]}];
  assert.equal(rangeHit(functions,6,30),false);
  assert.equal(rangeHit(functions,11,30),true);
  assert.equal(rangeHit(functions,25,30),true);
  assert.equal(rangeHit(functions,30,30),null);
  assert.throws(() => rangeHit([{ranges:[{startOffset:0,endOffset:31,count:1}]}],2,30),/Invalid/);
});

test('multiline JSX runtime anchors exclude imports, bindings, closing tags and punctuation', () => {
  const source = 'import React from "react";\nconst View = () => (\n  <div\n    title={getTitle()}\n  >\n    Hello\n    {name}\n  </div>\n);\n';
  const lines = [...new Set(executableAnchors(source).map((anchor) => anchor.line))];
  assert.deepEqual(lines,[2,3,4,6,7]);
});

test('bare class fields are executable anchors and UTF16 function zeros do not borrow module hits', (t) => {
  const fields = executableAnchors('class C {\n field;\n static count;\n}\n');
  assert.deepEqual([...new Set(fields.map((anchor) => anchor.line))],[2,3]);
  const source = 'const emoji = "😀";\nfunction unused() { return 42; }\n';
  const fixture = setup(t,{'src/backend/a.js':source});
  const run = fixture.rawRun('node','src/backend/a.js');
  const rawPath = run.artifacts.coverageFiles[0];
  const raw = JSON.parse(fs.readFileSync(rawPath));
  raw.result[0].functions.push({isBlockCoverage:false,ranges:[{startOffset:source.indexOf('function'),endOffset:source.length-1,count:0}]});
  fs.writeFileSync(rawPath,JSON.stringify(raw));
  const report = reportCoverage(fixture.manifest,fixture.evidence);
  assert.deepEqual(report.files[0].coveredLines,[1]);
  assert.deepEqual(report.files[0].uncoveredLines,[2]);
});

test('unloaded production files stay zero and missing manifest membership cannot narrow denominator', (t) => {
  const fixture = setup(t,{'src/backend/a.js':'export const a = 1;\n','src/Lazy.jsx':'export default () => <p>Lazy</p>;\n'});
  fixture.rawRun('node','src/backend/a.js');
  const report = reportCoverage(fixture.manifest,fixture.evidence);
  assert.equal(report.verdict,'below-floor');
  assert.equal(report.languages.javascript.overall.percent,50);
  assert.deepEqual(report.files.find((file) => file.path === 'src/Lazy.jsx').coveredLines,[]);
  const missing = {...fixture.manifest,files:fixture.manifest.files.slice(0,1)};
  assert.throws(() => reportCoverage(missing,fixture.evidence),/every production/);
});

test('mixed Node and mapped WebView evidence merge unique source lines, never double-count them', (t) => {
  const fixture = setup(t,{'src/backend/a.js':'export const a = 1;\n','src/View.jsx':'export default () => <p>Hi</p>;\n'});
  fixture.rawRun('node','src/backend/a.js');
  const sourcePath = path.join(fixture.root,'chunk.js');
  const source = 'x'.repeat(120);
  fs.writeFileSync(sourcePath,source);
  const map = new SourceMapGenerator({file:'chunk.js'});
  const relative = 'src/View.jsx';
  const original = fs.readFileSync(path.join(fixture.root,relative),'utf8');
  executableAnchors(original).forEach((anchor,index) => map.addMapping({generated:{line:1,column:index*3},original:{line:anchor.line,column:anchor.column},source:relative}));
  map.setSourceContent(relative,original);
  const mapPath = path.join(fixture.root,'chunk.js.map');
  fs.writeFileSync(mapPath,JSON.stringify(map.toJSON()));
  const coveragePath = path.join(fixture.root,'webview.json');
  const url = 'http://tauri.localhost/chunk.js';
  fs.writeFileSync(coveragePath,JSON.stringify({result:[{url,scriptId:'2',functions:[{isBlockCoverage:true,ranges:[{startOffset:0,endOffset:source.length,count:1}]}]}]}));
  fixture.evidence.runs.push({id:'webview',kind:'webview-v8',sourceTreeHash:fixture.manifest.sourceTreeHash,instrumentationId:fixture.manifest.instrumentationId,artifacts:{coverageFiles:[coveragePath],scriptFiles:[{url,sourcePath,sourceSha256:hash(source),mapPath,mapSha256:hash(fs.readFileSync(mapPath))}]}});
  const report = reportCoverage(fixture.manifest,fixture.evidence);
  assert.equal(report.verdict,'pass');
  assert.equal(report.languages.javascript.overall.coveredLines,2);
  fixture.evidence.runs.push({...fixture.evidence.runs[1],id:'webview-again'});
  assert.equal(reportCoverage(fixture.manifest,fixture.evidence).languages.javascript.overall.coveredLines,2);
  const broken = JSON.parse(fs.readFileSync(mapPath));
  broken.mappings = '';
  fs.writeFileSync(mapPath,JSON.stringify(broken));
  for (const run of fixture.evidence.runs.filter((run) => run.kind === 'webview-v8')) run.artifacts.scriptFiles[0].mapSha256 = hash(fs.readFileSync(mapPath));
  assert.equal(reportCoverage(fixture.manifest,fixture.evidence).verdict,'incomplete');
});

test('mapping gaps, source changes and incompatible instrumentation cannot pass', (t) => {
  const fixture = setup(t);
  const run = fixture.rawRun('node','src/backend/a.js');
  const raw = JSON.parse(fs.readFileSync(run.artifacts.coverageFiles[0]));
  raw.result[0].functions[0].ranges = [];
  fs.writeFileSync(run.artifacts.coverageFiles[0],JSON.stringify(raw));
  assert.equal(reportCoverage(fixture.manifest,fixture.evidence).verdict,'incomplete');
  assert.throws(() => reportCoverage(fixture.manifest,{...fixture.evidence,instrumentationId:'wrong'}),/provenance/);
  fs.appendFileSync(path.join(fixture.root,'src/backend/a.js'),'// changed');
  assert.throws(() => reportCoverage(fixture.manifest,fixture.evidence),/Source hash changed/);
});

test('undescribed Node production loads and positive nondetailed counters are incomplete', (t) => {
  const fixture = setup(t);
  const run = fixture.rawRun('node','src/backend/a.js');
  const descriptors = run.artifacts.scriptFiles;
  run.artifacts.scriptFiles = [];
  assert.equal(reportCoverage(fixture.manifest,fixture.evidence).verdict,'incomplete');
  run.artifacts.scriptFiles = descriptors;
  const rawPath = run.artifacts.coverageFiles[0];
  const raw = JSON.parse(fs.readFileSync(rawPath));
  raw.result[0].functions[0].isBlockCoverage = false;
  fs.writeFileSync(rawPath,JSON.stringify(raw));
  assert.equal(reportCoverage(fixture.manifest,fixture.evidence).verdict,'incomplete');
  raw.result[0].functions[0].ranges[0].count = 0;
  fs.writeFileSync(rawPath,JSON.stringify(raw));
  assert.equal(reportCoverage(fixture.manifest,fixture.evidence).verdict,'below-floor');
});

test('generated mapping columns cannot spill into another generated line', (t) => {
  const fixture = setup(t);
  const sourcePath = path.join(fixture.root,'chunk.js');
  const generated = 'x\nxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
  fs.writeFileSync(sourcePath,generated);
  const map = new SourceMapGenerator({file:'chunk.js'});
  map.addMapping({generated:{line:1,column:5},original:{line:1,column:0},source:'src/backend/a.js'});
  map.setSourceContent('src/backend/a.js',fs.readFileSync(path.join(fixture.root,'src/backend/a.js'),'utf8'));
  const mapPath = sourcePath+'.map';
  fs.writeFileSync(mapPath,JSON.stringify(map.toJSON()));
  const coveragePath = path.join(fixture.root,'raw.json');
  const url = 'http://tauri.localhost/chunk.js';
  fs.writeFileSync(coveragePath,JSON.stringify({result:[{url,functions:[{isBlockCoverage:true,ranges:[{startOffset:0,endOffset:generated.length,count:1}]}]}]}));
  fixture.evidence.runs.push({id:'bad-map',kind:'webview-v8',sourceTreeHash:fixture.manifest.sourceTreeHash,instrumentationId:fixture.manifest.instrumentationId,artifacts:{coverageFiles:[coveragePath],scriptFiles:[{url,sourcePath,sourceSha256:hash(generated),mapPath,mapSha256:hash(fs.readFileSync(mapPath))}]}});
  assert.throws(() => reportCoverage(fixture.manifest,fixture.evidence),/out of line bounds/);
});

test('unloaded lazy chunk descriptors need no map but duplicate source entries are refused when loaded', (t) => {
  const fixture = setup(t);
  const run = fixture.rawRun('node','src/backend/a.js');
  run.artifacts.scriptFiles.push({url:'http://tauri.localhost/lazy.js',sourcePath:path.join(fixture.root,'not-loaded.js'),sourceSha256:'not-read'});
  assert.equal(reportCoverage(fixture.manifest,fixture.evidence).verdict,'pass');
  const generated = path.join(fixture.root,'chunk.js');
  fs.writeFileSync(generated,'xxxxxxxxxx');
  const original = fs.readFileSync(path.join(fixture.root,'src/backend/a.js'),'utf8');
  const mapPath = generated+'.map';
  fs.writeFileSync(mapPath,JSON.stringify({version:3,file:'chunk.js',sources:['src/backend/a.js','./src/backend/a.js'],sourcesContent:[original,original],names:[],mappings:'AAAA,CCAA'}));
  const rawPath = path.join(fixture.root,'duplicate-raw.json');
  fs.writeFileSync(rawPath,JSON.stringify({result:[{url:'http://tauri.localhost/chunk.js',functions:[{isBlockCoverage:true,ranges:[{startOffset:0,endOffset:10,count:1}]}]}]}));
  fixture.evidence.runs.push({id:'duplicate-map',kind:'webview-v8',sourceTreeHash:fixture.manifest.sourceTreeHash,instrumentationId:fixture.manifest.instrumentationId,artifacts:{coverageFiles:[rawPath],scriptFiles:[{url:'http://tauri.localhost/chunk.js',sourcePath:generated,sourceSha256:hash(fs.readFileSync(generated)),mapPath,mapSha256:hash(fs.readFileSync(mapPath))}]}});
  assert.throws(() => reportCoverage(fixture.manifest,fixture.evidence),/Duplicate source-map/);
});

test('CLI reports real pass, below-floor and invalid exit codes without executing production modules', (t) => {
  const fixture = setup(t);
  const run = fixture.rawRun('node','src/backend/a.js');
  const manifestPath = path.join(fixture.root,'manifest.json');
  const evidencePath = path.join(fixture.root,'evidence.json');
  const reportPath = path.join(fixture.root,'report.json');
  fs.writeFileSync(manifestPath,JSON.stringify(fixture.manifest));
  const invoke = () => {
    fs.writeFileSync(evidencePath,JSON.stringify(fixture.evidence));
    return spawnSync(process.execPath,['scripts/coverage-report.mjs','--manifest',manifestPath,'--evidence',evidencePath,'--out',reportPath],{encoding:'utf8'});
  };
  assert.equal(invoke().status,0);
  assert.equal(JSON.parse(fs.readFileSync(reportPath)).verdict,'pass');
  const raw = JSON.parse(fs.readFileSync(run.artifacts.coverageFiles[0]));
  raw.result[0].functions[0].ranges[0].count = 0;
  fs.writeFileSync(run.artifacts.coverageFiles[0],JSON.stringify(raw));
  assert.equal(invoke().status,1);
  assert.equal(JSON.parse(fs.readFileSync(reportPath)).verdict,'below-floor');
  fixture.evidence.sourceTreeHash = 'wrong';
  assert.equal(invoke().status,2);
  assert.equal(JSON.parse(fs.readFileSync(reportPath)).verdict,'invalid');
});

test('native coverage requires every Rust denominator and crosschecks LLVM JSON with LCOV', (t) => {
  const fixture = setup(t,{});
  const relative = 'src-tauri/src/lib.rs';
  fs.mkdirSync(path.dirname(path.join(fixture.root,relative)),{recursive:true});
  fs.writeFileSync(path.join(fixture.root,relative),'fn production() {}\n#[cfg(test)]\nmod tests { fn test() {} }\n');
  fixture.manifest.files.push({path:relative,sha256:hash(fs.readFileSync(path.join(fixture.root,relative))),language:'rust',core:true,excludedRanges:[{start:2,end:3,reason:'cfg(test)'}]});
  fixture.manifest.sourceTreeHash = sourceTreeHash(fixture.manifest.files);
  fixture.evidence.sourceTreeHash = fixture.manifest.sourceTreeHash;
  assert.equal(reportCoverage(fixture.manifest,fixture.evidence).verdict,'incomplete');
  fixture.evidence.instrumentation.rustVersion = 'fixture';
  fixture.evidence.instrumentation.llvmVersion = 'fixture';
  fixture.evidence.instrumentationId = fixture.manifest.instrumentationId = hash(JSON.stringify(canonical(fixture.evidence.instrumentation)));
  const jsonPath = path.join(fixture.root,'llvm.json');
  const lcovPath = path.join(fixture.root,'llvm.lcov');
  fs.writeFileSync(jsonPath,JSON.stringify({data:[{files:[{filename:path.join(fixture.root,relative),summary:{lines:{count:2,covered:2}}}]}]}));
  fs.writeFileSync(lcovPath,`SF:${path.join(fixture.root,relative)}\nDA:1,1\nDA:3,1\nend_of_record\n`);
  const profdataPath = path.join(fixture.root,'fixture.profdata');
  const objectPath = path.join(fixture.root,'fixture.exe');
  fs.writeFileSync(profdataPath,'fixture-profile'); fs.writeFileSync(objectPath,'fixture-object');
  const nativeOptions = {exportNative: () => ({json:fs.readFileSync(jsonPath,'utf8'),lcov:fs.readFileSync(lcovPath,'utf8'),provenance:{fixtureOnly:true}})};
  fixture.evidence.runs.push({id:'native',kind:'native-llvm',sourceTreeHash:fixture.manifest.sourceTreeHash,instrumentationId:fixture.manifest.instrumentationId,artifacts:{jsonPath,lcovPath,profdataPath,profdataSha256:hash(fs.readFileSync(profdataPath)),objects:[{path:objectPath,sha256:hash(fs.readFileSync(objectPath))}]}});
  const report = reportCoverage(fixture.manifest,fixture.evidence,nativeOptions);
  assert.equal(report.verdict,'pass');
  assert.equal(report.languages.rust.overall.executableLines,1);
  fs.writeFileSync(lcovPath,`SF:${path.join(fixture.root,relative)}\nDA:1,0\nDA:3,1\nend_of_record\n`);
  assert.throws(() => reportCoverage(fixture.manifest,fixture.evidence,nativeOptions),/summary mismatch/);
  assert.equal(reportCoverage(fixture.manifest,fixture.evidence).verdict,'incomplete','public path cannot use supplied reports without a trusted LLVM tool');
});

test('Rust cfgtest exclusions require exact whole top-level module spans, ignoring literal lookalikes', () => {
  const source = `fn production() {}\nconst TEXT: &str = r###"#[cfg(test)] mod fake { }"###;\n/* #[cfg(test)] mod comment {} */\n#[cfg(test)]\nmod tests {\n let raw = r#"{not a module}"#;\n let ch = '{';\n}\n`;
  assert.deepEqual(rustTestModules(source),[{start:4,end:8,reason:'cfg(test)'}]);
  assert.deepEqual(rustTestModules('#[cfg(any(test, feature = "x"))]\nmod mixed {}\n'),[]);
  assert.deepEqual(rustTestModules('mod outer {\n#[cfg(test)]\nmod nested {}\n}\n'),[]);
});

test('a relabeled full production Rust span cannot shrink the native denominator', (t) => {
  const fixture = setup(t,{});
  const relative = 'src-tauri/src/lib.rs';
  const source = 'fn production() {}\n#[cfg(test)]\nmod tests {}\n';
  fs.mkdirSync(path.dirname(path.join(fixture.root,relative)),{recursive:true});
  fs.writeFileSync(path.join(fixture.root,relative),source);
  fixture.manifest.files.push({path:relative,sha256:hash(source),language:'rust',core:true,excludedRanges:[{start:1,end:3,reason:'cfg(test)'}]});
  fixture.evidence.sourceTreeHash = fixture.manifest.sourceTreeHash = sourceTreeHash(fixture.manifest.files);
  assert.throws(() => reportCoverage(fixture.manifest,fixture.evidence),/not a whole top-level/);
});

test('external runtime exclusions require a frozen exact hash and cannot exclude production files', (t) => {
  const fixture = setup(t);
  fixture.rawRun('node','src/backend/a.js');
  const sourcePath = path.join(fixture.root,'bootstrap.js');
  const source = 'runtime();';
  fs.writeFileSync(sourcePath,source);
  const coveragePath = path.join(fixture.root,'runtime.json');
  const url = 'http://tauri.localhost/bootstrap.js';
  fs.writeFileSync(coveragePath,JSON.stringify({result:[{url,functions:[]}]}));
  const descriptor = {url,sourcePath,sourceSha256:hash(source),scope:'external'};
  fixture.evidence.runs.push({id:'runtime',kind:'webview-v8',sourceTreeHash:fixture.manifest.sourceTreeHash,instrumentationId:fixture.manifest.instrumentationId,artifacts:{coverageFiles:[coveragePath],scriptFiles:[descriptor]}});
  assert.throws(() => reportCoverage(fixture.manifest,fixture.evidence),/exact frozen/);
  fixture.manifest.externalScripts = [{url,sha256:hash(source),reason:'tauri-runtime'}];
  fixture.evidence.sourceTreeHash = fixture.manifest.sourceTreeHash = sourceTreeHash(fixture.manifest.files,fixture.manifest.externalScripts);
  for (const run of fixture.evidence.runs) run.sourceTreeHash = fixture.manifest.sourceTreeHash;
  assert.equal(reportCoverage(fixture.manifest,fixture.evidence).verdict,'pass');
  descriptor.sourcePath = path.join(fixture.root,'src/backend/a.js');
  descriptor.sourceSha256 = hash(fs.readFileSync(descriptor.sourcePath));
  assert.throws(() => reportCoverage(fixture.manifest,fixture.evidence),/Production source cannot/);
});
