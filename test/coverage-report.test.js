import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { SourceMapGenerator } from 'source-map-js';
import { collectScriptFiles } from '../scripts/collect-node-coverage.mjs';
import { executableAnchors, rangeHit, reportCoverage, sourceTreeHash, hash, canonical, metricVersion, rustTestModules, nativeSegmentLines, validateNativeExports } from '../scripts/coverage-report.mjs';

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

test('Node collector preserves loaded URL aliases only for frozen production sources', (t) => {
  const fixture = setup(t,{'src/backend/a.js':'export const a = 1;\n','src/backend/unloaded.js':'export const b = 2;\n'});
  const sourcePath = path.join(fixture.root,'src/backend/a.js');
  const base = pathToFileURL(sourcePath).href;
  const aliases = [base+'?restart=1',base+'?restart=close#loaded'];
  if (process.platform === 'win32') aliases.push(pathToFileURL(sourcePath.toUpperCase()).href+'?case=1');
  const foreign = pathToFileURL(path.join(fixture.root,'foreign.js')).href+'?restart=1';
  const rawPath = path.join(fixture.root,'aliases.json');
  const raw = {result:[...aliases,aliases[0],foreign,'node:fs'].map((url) => ({url}))};
  fs.writeFileSync(rawPath,JSON.stringify(raw));
  const descriptors = collectScriptFiles(fixture.root,fixture.manifest.files,[rawPath,rawPath]);
  assert.equal(descriptors.length,2+aliases.length);
  for (const url of [base,...aliases]) assert.deepEqual(descriptors.find((entry) => entry.url === url),{url,sourcePath,sourceSha256:fixture.manifest.files[0].sha256});
  assert.ok(descriptors.some((entry) => entry.url === pathToFileURL(path.join(fixture.root,'src/backend/unloaded.js')).href));
  assert.ok(!descriptors.some((entry) => entry.url === foreign));
  assert.deepEqual(JSON.parse(fs.readFileSync(rawPath)),raw);
  fs.appendFileSync(sourcePath,'// changed\n');
  assert.throws(() => collectScriptFiles(fixture.root,fixture.manifest.files,[rawPath]),/Source hash changed/);
});

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

test('CLI preserves native inputs and existing aliases for valid and invalid exports', (t) => {
  const fixture = setup(t);
  fixture.rawRun('node','src/backend/a.js');
  const manifestPath = path.join(fixture.root,'manifest.json');
  const evidencePath = path.join(fixture.root,'evidence.json');
  const profdataPath = path.join(fixture.root,'native.profdata');
  const objectPath = path.join(fixture.root,'native.object');
  const toolPath = path.join(fixture.root,process.platform === 'win32' ? 'llvm-fixture.exe' : 'llvm-fixture');
  const toolScript = path.join(fixture.root,'llvm-fixture.cjs');
  const jsonPath = path.join(fixture.root,'export.json');
  const lcovPath = path.join(fixture.root,'export.lcov');
  fs.writeFileSync(profdataPath,'inert profile');
  fs.writeFileSync(objectPath,'inert object');
  fs.writeFileSync(lcovPath,'');
  fs.copyFileSync(process.execPath,toolPath);
  fs.writeFileSync(toolScript,`if (process.execPath === ${JSON.stringify(toolPath)}) { process.stdout.write(require('node:fs').readFileSync(process.argv.includes('-format=lcov') ? ${JSON.stringify(lcovPath)} : ${JSON.stringify(jsonPath)})); process.exit(0); }`);
  Object.assign(fixture.evidence.instrumentation,{rustVersion:'fixture',llvmVersion:'fixture'});
  fixture.evidence.instrumentationId = fixture.manifest.instrumentationId = hash(JSON.stringify(canonical(fixture.evidence.instrumentation)));
  fixture.evidence.runs[0].instrumentationId = fixture.manifest.instrumentationId;
  fixture.evidence.runs.push({id:'native',kind:'native-llvm',sourceTreeHash:fixture.manifest.sourceTreeHash,instrumentationId:fixture.manifest.instrumentationId,artifacts:{profdataPath,profdataSha256:hash(fs.readFileSync(profdataPath)),objects:[{path:objectPath,sha256:hash(fs.readFileSync(objectPath))}]}});
  fs.writeFileSync(manifestPath,JSON.stringify(fixture.manifest));
  fs.writeFileSync(evidencePath,JSON.stringify(fixture.evidence));
  const invoke = (output) => spawnSync(process.execPath,['scripts/coverage-report.mjs','--manifest',manifestPath,'--evidence',evidencePath,'--out',output,'--llvm-cov',toolPath],{encoding:'utf8',env:{...process.env,NODE_OPTIONS:`--require ${JSON.stringify(toolScript)}`}});
  for (const scenario of ['valid','invalid-export','invalid-manifest','invalid-evidence','malformed-manifest','malformed-evidence']) {
    const valid = scenario === 'valid';
    fs.writeFileSync(manifestPath,scenario === 'malformed-manifest' ? '{' : JSON.stringify({...fixture.manifest,...(scenario === 'invalid-manifest' ? {sourceTreeHash:'wrong'} : {})}));
    fs.writeFileSync(evidencePath,scenario === 'malformed-evidence' ? '{' : JSON.stringify({...fixture.evidence,...(scenario === 'invalid-evidence' ? {sourceTreeHash:'wrong'} : {})}));
    fs.writeFileSync(jsonPath,scenario === 'invalid-export' ? '{}' : JSON.stringify({type:'llvm.coverage.json.export',version:'3.1.0',data:[{files:[]}]}));
    const reportPath = path.join(fixture.root,'report.json');
    assert.equal(invoke(reportPath).status,valid ? 0 : 2);
    if (!scenario.startsWith('malformed-')) assert.equal(JSON.parse(fs.readFileSync(reportPath)).verdict,valid ? 'pass' : 'invalid');
    for (const input of [profdataPath,objectPath,toolPath]) {
      const before = fs.readFileSync(input);
      const hardlink = path.join(fixture.root,'hardlink');
      fs.linkSync(input,hardlink);
      const aliases = [input,hardlink];
      if (process.platform === 'win32') {
        const junction = path.join(fixture.root,'junction');
        fs.symlinkSync(fixture.root,junction,'junction');
        aliases.push(input.toUpperCase(),input.toLowerCase(),path.join(junction,path.basename(input)));
      }
      else { const symlink = path.join(fixture.root,'symlink'); fs.symlinkSync(input,symlink); aliases.push(symlink); }
      for (const alias of aliases) {
        const result = invoke(alias);
        assert.equal(result.status,2);
        if (!scenario.startsWith('malformed-')) assert.match(result.stderr,/overwrite source or evidence/);
        assert.deepEqual(fs.readFileSync(input),before);
      }
      fs.unlinkSync(hardlink);
      if (process.platform === 'win32') fs.rmdirSync(path.join(fixture.root,'junction'));
      else fs.unlinkSync(path.join(fixture.root,'symlink'));
    }
  }
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
  fs.writeFileSync(jsonPath,JSON.stringify({type:'llvm.coverage.json.export',version:'3.1.0',data:[{files:[{filename:path.join(fixture.root,relative),segments:[[1,1,1,true,true,false],[1,2,0,false,false,false],[3,1,1,true,true,false],[3,2,0,false,false,false]],summary:{lines:{count:2,covered:2}}}]}]}));
  const validLcov = `SF:${path.join(fixture.root,relative)}\nDA:1,1\nDA:3,1\nLF:2\nLH:2\nend_of_record\n`;
  fs.writeFileSync(lcovPath,validLcov);
  const profdataPath = path.join(fixture.root,'fixture.profdata');
  const objectPath = path.join(fixture.root,'fixture.exe');
  fs.writeFileSync(profdataPath,'fixture-profile'); fs.writeFileSync(objectPath,'fixture-object');
  const nativeOptions = {exportNative: () => ({json:fs.readFileSync(jsonPath,'utf8'),lcov:fs.readFileSync(lcovPath,'utf8'),provenance:{fixtureOnly:true}})};
  fixture.evidence.runs.push({id:'native',kind:'native-llvm',sourceTreeHash:fixture.manifest.sourceTreeHash,instrumentationId:fixture.manifest.instrumentationId,artifacts:{jsonPath,lcovPath,profdataPath,profdataSha256:hash(fs.readFileSync(profdataPath)),objects:[{path:objectPath,sha256:hash(fs.readFileSync(objectPath))}]}});
  const report = reportCoverage(fixture.manifest,fixture.evidence,nativeOptions);
  assert.equal(report.verdict,'pass');
  assert.equal(report.languages.rust.overall.executableLines,1);
  fs.writeFileSync(lcovPath,validLcov.replace('DA:1,1','DA:1,0'));
  assert.throws(() => reportCoverage(fixture.manifest,fixture.evidence,nativeOptions),/counter mismatch/);
  for (const [input, expected] of [
    [validLcov.replace('LF:2\n',''), /Missing LCOV/],
    [validLcov.replace('LF:2','LF:broken'), /Invalid or duplicate LCOV line summary/],
    [validLcov.replace('LH:2','LH:1'), /summary mismatch/],
    [validLcov.replace('LF:2','LF:2\nLF:2'), /duplicate LCOV line summary/],
    [validLcov.replace('DA:1,1','DA:1,1\nDA:1,1'), /duplicate LCOV executable/],
    [validLcov.replace('DA:1,1','DA:1,9007199254740992'), /Invalid or duplicate LCOV executable/],
    [validLcov.replace('end_of_record\n',''), /Unterminated LCOV/],
    [validLcov + validLcov, /Duplicate LCOV source/],
    ['DA:1,1\n' + validLcov, /outside source record/],
  ]) {
    fs.writeFileSync(lcovPath,input);
    assert.throws(() => reportCoverage(fixture.manifest,fixture.evidence,nativeOptions),expected);
  }
  fs.writeFileSync(lcovPath,validLcov);
  const validJson = fs.readFileSync(jsonPath,'utf8');
  const json = JSON.parse(validJson);
  for (const summary of [{count:-1,covered:0},{count:2,covered:3},{count:'2',covered:2}]) {
    json.data[0].files[0].summary.lines = summary;
    fs.writeFileSync(jsonPath,JSON.stringify(json));
    assert.throws(() => reportCoverage(fixture.manifest,fixture.evidence,nativeOptions),/Invalid LLVM line summary/);
  }
  json.data[0].files[0].summary.lines = {count:3,covered:3};
  fs.writeFileSync(jsonPath,JSON.stringify(json));
  fs.writeFileSync(lcovPath,validLcov.replace('LF:2\nLH:2','LF:3\nLH:3'));
  assert.equal(reportCoverage(fixture.manifest,fixture.evidence,nativeOptions).languages.rust.overall.executableLines,1,'aggregate diagnostics do not replace source lines');
  json.data[0].files.push(json.data[0].files[0]);
  fs.writeFileSync(jsonPath,JSON.stringify(json));
  assert.throws(() => reportCoverage(fixture.manifest,fixture.evidence,nativeOptions),/Duplicate LLVM/);
  fs.writeFileSync(jsonPath,validJson);
  fs.writeFileSync(lcovPath,validLcov);
  fs.appendFileSync(objectPath,'changed');
  assert.match(reportCoverage(fixture.manifest,fixture.evidence,nativeOptions).incompleteReasons.join('\n'),/changed covered native object/);
  fs.writeFileSync(objectPath,'fixture-object');
  assert.equal(reportCoverage(fixture.manifest,fixture.evidence).verdict,'incomplete','public path cannot use supplied reports without a trusted LLVM tool');
});

test('Rust cfgtest exclusions require exact whole top-level module spans, ignoring literal lookalikes', () => {
  const source = `fn production() {}\nconst TEXT: &str = r###"#[cfg(test)] mod fake { }"###;\n/* #[cfg(test)] mod comment {} */\n#[cfg(test)]\nmod tests {\n let raw = r#"{not a module}"#;\n let ch = '{';\n}\n`;
  assert.deepEqual(rustTestModules(source),[{start:4,end:8,reason:'cfg(test)'}]);
  assert.deepEqual(rustTestModules('#[cfg(any(test, feature = "x"))]\nmod mixed {}\n'),[]);
  assert.deepEqual(rustTestModules('mod outer {\n#[cfg(test)]\nmod nested {}\n}\n'),[]);
});

test('Rust 1.99.0 LLVM 23.1.1 overlapping closure uses nine verified source lines and retains ten aggregate lines', (t) => {
  // Locally compiled inert --test fixture: JSON and LF/LH are 10/10, while
  // merged file segments emit nine unique DA rows. The closure and outer
  // function share a source line in the function-group summary.
  const fixture = setup(t,{});
  const relative = 'src-tauri/src/lib.rs';
  const source = 'fn outer() -> i32 {\n    let closure = || {\n        7\n    };\n    closure()\n}\n#[test]\nfn exercise() {\n    assert_eq!(outer(), 7);\n}\n';
  fs.mkdirSync(path.dirname(path.join(fixture.root,relative)),{recursive:true});
  fs.writeFileSync(path.join(fixture.root,relative),source);
  fixture.manifest.files.push({path:relative,sha256:hash(source),language:'rust',core:true});
  fixture.evidence.sourceTreeHash = fixture.manifest.sourceTreeHash = sourceTreeHash(fixture.manifest.files);
  Object.assign(fixture.evidence.instrumentation,{rustVersion:'1.99.0',llvmVersion:'23.1.1'});
  fixture.evidence.instrumentationId = fixture.manifest.instrumentationId = hash(JSON.stringify(canonical(fixture.evidence.instrumentation)));
  const objectPath = path.join(fixture.root,'overlap.exe');
  const profdataPath = path.join(fixture.root,'overlap.profdata');
  fs.writeFileSync(objectPath,'fixture-object');
  fs.writeFileSync(profdataPath,'fixture-profile');
  fixture.evidence.runs.push({id:'overlap',kind:'native-llvm',sourceTreeHash:fixture.manifest.sourceTreeHash,instrumentationId:fixture.manifest.instrumentationId,artifacts:{profdataPath,profdataSha256:hash(fs.readFileSync(profdataPath)),objects:[{path:objectPath,sha256:hash(fs.readFileSync(objectPath))}]}});
  const exported = {json:JSON.stringify({type:'llvm.coverage.json.export',version:'3.1.0',data:[{files:[{filename:path.join(fixture.root,relative),segments:[1,2,3,4,5,6,8,9,10].flatMap((line) => [[line,1,1,true,true,false],[line,2,0,false,false,false]]),summary:{lines:{count:10,covered:10}}}]}]}),lcov:`SF:${path.join(fixture.root,relative)}\n${[1,2,3,4,5,6,8,9,10].map((line) => `DA:${line},1`).join('\n')}\nLF:10\nLH:10\nend_of_record\n`,provenance:{fixtureOnly:true}};
  assert.equal(reportCoverage(fixture.manifest,fixture.evidence,{exportNative:() => exported}).languages.rust.overall.executableLines,9);
  const second = {...fixture.evidence.runs[0],id:'second'};
  fixture.evidence.runs.push(second);
  const zero = JSON.parse(exported.json);
  zero.data[0].files[0].segments.forEach((segment) => { segment[2] = 0; });
  zero.data[0].files[0].summary.lines.covered = 0;
  const zeroExport = {...exported,json:JSON.stringify(zero),lcov:exported.lcov.replaceAll(',1',',0').replace('LH:10','LH:0')};
  let calls = 0;
  assert.equal(reportCoverage(fixture.manifest,fixture.evidence,{exportNative:() => calls++ ? exported : zeroExport}).languages.rust.overall.coveredLines,9);
  const changed = JSON.parse(exported.json);
  changed.data[0].files[0].segments = changed.data[0].files[0].segments.filter((segment) => segment[0] !== 1);
  changed.data[0].files[0].segments.push([11,1,1,true,true,false]);
  const changedExport = {...exported,json:JSON.stringify(changed),lcov:exported.lcov.replace('DA:1,1','DA:11,1')};
  calls = 0;
  assert.throws(() => reportCoverage(fixture.manifest,fixture.evidence,{exportNative:() => calls++ ? changedExport : exported}),/denominator changed/);
  fs.appendFileSync(profdataPath,'changed');
  assert.match(reportCoverage(fixture.manifest,fixture.evidence,{exportNative:() => exported}).incompleteReasons.join('\n'),/profile hash differs/);

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

test('LLVM line iterator preserves wrapped counts, gap behavior, skipped overrides and termination', () => {
  const source = 'xxxxxxxxxx\n'.repeat(8);
  const cases = [
    {segments:[[1,1,4,true,true,false],[4,1,0,false,false,false]],lines:[[1,4],[2,4],[3,4],[4,4]]},
    {segments:[[1,1,0,true,true,false],[1,3,7,true,true,false],[1,5,0,false,false,false]],lines:[[1,7]]},
    {segments:[[1,1,9,true,false,true],[3,1,0,false,false,false]],lines:[[2,9],[3,9]]},
    {segments:[[1,1,4,true,true,false],[2,1,0,false,true,false],[3,1,0,false,false,false]],lines:[[1,4]]},
    {segments:[[1,1,4,true,true,false],[2,1,0,false,true,false],[2,3,2,true,true,false],[3,1,0,false,false,false]],lines:[[1,4],[2,4],[3,2]]},
    {segments:[[1,1,0,false,true,false],[1,1,8,true,true,false],[2,1,0,false,false,false]],lines:[[1,8],[2,8]]},
    {segments:[[1,1,0,false,true,false],[1,3,8,true,true,true]],lines:[[1,0]]},
    {segments:[[1,1,3,true,true,false]],lines:[[1,3]]},
    {segments:[],lines:[]},
  ];
  for (const {segments,lines} of cases) assert.deepEqual([...nativeSegmentLines(segments,source)],lines);
});

test('LLVM segments reject malformed flags, unsafe counters, bounds and ordering without sorting', () => {
  const good = [1,1,0,true,true,false];
  for (const bad of [[1,1,-1,true,true,false],[1,1,2**53,true,true,false],[1,1,0,1,true,false],[1,1,0,true,true], [0,1,0,true,true,false],[1,99,0,true,true,false],[3,1,0,true,true,false],[1,1,1,false,false,false]]) {
    assert.throws(() => nativeSegmentLines([bad],'abc\n'),/Invalid LLVM segment/);
  }
  assert.throws(() => nativeSegmentLines([good,good],'abc\n'),/ordering/);
  assert.throws(() => nativeSegmentLines([[1,2,0,false,false,false],good],'abc\n'),/ordering/);
  assert.throws(() => nativeSegmentLines(null,'abc\n'),/Missing LLVM/);
});

test('native parser crosschecks every source counter even when totals agree, including zero lines', () => {
  const root = path.resolve('fixture-root');
  const filename = path.join(root,'a.rs');
  const entries = new Map([['a.rs',{language:'rust',source:'abc\ndef\nghi\n'}],['build.rs',{language:'rust',source:''}],['build_support.rs',{language:'rust',source:''}]]);
  const record = {filename,segments:[[1,1,0,true,true,false],[1,2,0,false,false,false],[3,1,2,true,true,false],[3,2,0,false,false,false]],summary:{lines:{count:2,covered:1}}};
  const json = () => JSON.stringify({type:'llvm.coverage.json.export',version:'3.1.0',data:[{files:[record]}]});
  const lcov = `SF:${filename}\nDA:1,0\nDA:3,2\nLF:2\nLH:1\nend_of_record\n`;
  const result = validateNativeExports(json(),lcov,entries,root);
  assert.deepEqual([...result.get('a.rs').lines],[[1,0],[3,2]]);
  assert.equal(result.has('build.rs'),false);
  assert.equal(result.has('build_support.rs'),false);
  for (const changed of [lcov.replace('DA:1,0\n',''),lcov.replace('DA:3,2','DA:2,2'),lcov.replace('DA:3,2','DA:3,1'),lcov.replace('DA:3,2','DA:3,2\nDA:2,0')]) assert.throws(() => validateNativeExports(json(),changed,entries,root),/counter mismatch/);
  assert.throws(() => validateNativeExports(json().replace('3.1.0','2.0.0'),lcov,entries,root),/Invalid llvm/);
  const empty = {...record,segments:[],summary:{lines:{count:0,covered:0}}};
  const emptyJson = JSON.stringify({type:'llvm.coverage.json.export',version:'3.1.0',data:[{files:[empty]}]});
  assert.equal(validateNativeExports(emptyJson,`SF:${filename}\nLF:0\nLH:0\nend_of_record\n`,entries,root).get('a.rs').lines.size,0);
});

test('v1 instrumentation cannot be mixed with v2 source identity', (t) => {
  const fixture = setup(t);
  fixture.evidence.instrumentation.metricVersion = 'purgeon-coverage-v1';
  assert.throws(() => reportCoverage(fixture.manifest,fixture.evidence),/instrumentation/);
});

test('cross-file expansion mappings remain per-file and source aliases cannot duplicate records', () => {
  const root = path.resolve('macro-fixture');
  const names = ['a.rs','macro.rs'];
  const entries = new Map(names.map((name) => [name,{language:'rust',source:'abc\n'}]));
  // Expanded-file metadata must not replace the merged segments for either file.
  const files = names.map((name,index) => ({filename:path.join(root,name),segments:[[1,1,index,true,true,false],[1,2,0,false,false,false]],expansions:[{filenames:names,source_region:[1,1,1,2,1,0,1,1]}],summary:{lines:{count:1,covered:index}}}));
  const json = () => JSON.stringify({type:'llvm.coverage.json.export',version:'3.1.0',data:[{files}]});
  const lcov = files.map((file,index) => `SF:${file.filename}\nDA:1,${index}\nLF:1\nLH:${index}\nend_of_record\n`).join('');
  const result = validateNativeExports(json(),lcov,entries,root);
  assert.equal(result.get('a.rs').lines.get(1),0);
  assert.equal(result.get('macro.rs').lines.get(1),1);
  for (const alias of [path.join(root,'A.rs'),path.join(root,'tests') + path.sep + '..' + path.sep + 'a.rs']) {
    files.push({...files[0],filename:alias});
    assert.throws(() => validateNativeExports(json(),lcov,entries,root),/Duplicate LLVM source/);
    files.pop();
  }
});

test('native exporter receives every frozen Rust source as a separate LLVM argument', (t) => {
  const fixture = setup(t,{});
  const relatives = ['src-tauri/build.rs','src-tauri/build_support.rs','src-tauri/src/lib.rs','src-tauri/src/path with spaces.rs'];
  for (const relative of relatives) {
    fs.mkdirSync(path.dirname(path.join(fixture.root,relative)),{recursive:true});
    fs.writeFileSync(path.join(fixture.root,relative),'');
    fixture.manifest.files.push({path:relative,sha256:hash(''),language:'rust',core:relative.startsWith('src-tauri/src/')});
  }
  fixture.evidence.sourceTreeHash = fixture.manifest.sourceTreeHash = sourceTreeHash(fixture.manifest.files);
  Object.assign(fixture.evidence.instrumentation,{rustVersion:'fixture',llvmVersion:'fixture'});
  fixture.evidence.instrumentationId = fixture.manifest.instrumentationId = hash(JSON.stringify(canonical(fixture.evidence.instrumentation)));
  const objectPath = path.join(fixture.root,'fixture.object'), profdataPath = path.join(fixture.root,'fixture.profdata');
  fs.writeFileSync(objectPath,'object'); fs.writeFileSync(profdataPath,'profile');
  fixture.evidence.runs.push({id:'native',kind:'native-llvm',sourceTreeHash:fixture.manifest.sourceTreeHash,instrumentationId:fixture.manifest.instrumentationId,artifacts:{profdataPath,profdataSha256:hash('profile'),objects:[{path:objectPath,sha256:hash('object')}]}});
  const sources = relatives.map((relative) => path.resolve(fixture.root,relative));
  const exported = {json:JSON.stringify({type:'llvm.coverage.json.export',version:'3.1.0',data:[{files:sources.map((filename) => ({filename,segments:[],summary:{lines:{count:0,covered:0}}}))}]}),lcov:sources.map((filename) => `SF:${filename}\nLF:0\nLH:0\nend_of_record\n`).join(''),provenance:{fixtureOnly:true}};
  assert.equal(reportCoverage(fixture.manifest,fixture.evidence,{exportNative:(_artifacts,_tool,received) => { assert.deepEqual(received,sources); return exported; }}).verdict,'pass');
  const toolPath = path.join(fixture.root,process.platform === 'win32' ? 'llvm fixture.exe' : 'llvm fixture');
  fs.copyFileSync(process.execPath,toolPath);
  const preload = path.join(fixture.root,'preload.cjs'), calls = path.join(fixture.root,'calls.jsonl');
  fs.writeFileSync(preload,`if(process.execPath === ${JSON.stringify(toolPath)}) { require('node:fs').appendFileSync(${JSON.stringify(calls)},JSON.stringify(process.argv.slice(1))+'\\n'); process.stdout.write(process.argv.includes('-format=lcov') ? ${JSON.stringify(exported.lcov)} : ${JSON.stringify(exported.json)}); process.exit(0); }`);
  const manifestPath = path.join(fixture.root,'manifest.json'), evidencePath = path.join(fixture.root,'evidence.json');
  fs.writeFileSync(manifestPath,JSON.stringify(fixture.manifest)); fs.writeFileSync(evidencePath,JSON.stringify(fixture.evidence));
  const result = spawnSync(process.execPath,['scripts/coverage-report.mjs','--manifest',manifestPath,'--evidence',evidencePath,'--out',path.join(fixture.root,'report.json'),'--llvm-cov',toolPath],{encoding:'utf8',env:{...process.env,NODE_OPTIONS:`--require ${JSON.stringify(preload)}`}});
  assert.equal(result.status,0,result.stderr);
  const args = fs.readFileSync(calls,'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(args.length,2);
  assert.deepEqual(args[0].slice(-sources.length),sources);
  assert.deepEqual(args[1].slice(-sources.length-1),[...sources,'-format=lcov']);
});
