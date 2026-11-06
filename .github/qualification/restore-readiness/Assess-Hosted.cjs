'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const repo = path.resolve(__dirname, '../../..');
const base = '972d548eb26459f53a1d4170f2c0c6650418071d';
const product = '4f4e1d2898ce9520d434b695d36991411e38a8ed';
const reviewPath = 'coverage/reviews/cleanup-impact-lab.json';
const expectedReviewSource = '89458c41e4f03b2708bdf6e053e05a807549246a';
const expectedBaselineReport = '019694677df2aae4603accaaf2570e43ed26fa1ab3a4de8b4401a2aa7526b77e';
const qualificationFiles = [
  '.github/workflows/qualify-restore-readiness.yml',
  '.github/qualification/restore-readiness/Assess-Hosted.cjs',
  '.github/qualification/restore-readiness/Collect-NativeCoverage.ps1',
  '.github/qualification/restore-readiness/Merge-Coverage.mjs',
  '.github/qualification/restore-readiness/workspace-wrapper.rs'
].sort();
const languages = ['javascript', 'rust'];
const scopes = ['core', 'overall'];
const read = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const ensure = (ok, message) => { if (!ok) throw Error(message); };
function git(...args) {
  return cp.execFileSync('git', ['-c', `safe.directory=${repo.replaceAll('\\','/')}`, ...args], { cwd: repo, encoding: 'utf8', maxBuffer: 32*1024*1024 });
}
function noFall(now, before) {
  // No defined previous ratio at 0/0. Removing a defined denominator is not a pass.
  return before.executable === 0 || now.executable > 0 && BigInt(now.covered)*BigInt(before.executable) >= BigInt(before.covered)*BigInt(now.executable);
}
const counts = f => ({ covered: f.coveredLines.length, executable: f.executableLines.length });
const floor = c => c.executable === 0 ? null : BigInt(c.covered)*100n >= BigInt(c.executable)*85n;
const critical = (p, policy) => policy.criticalFiles.includes(p) || policy.criticalPrefixes.some(prefix => p.startsWith(prefix));
function hunkLines(diff) {
  const lines = new Set();
  for (const m of diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    for (let i=0; i<Number(m[2] ?? 1); i++) lines.add(Number(m[1])+i);
  }
  return lines;
}
function validateReport(r) {
  ensure(r.schemaVersion === 1 && r.metricVersion === 'purgeon-coverage-v2', 'Invalid report version');
  ensure(Array.isArray(r.incompleteReasons) && r.incompleteReasons.length === 0, 'Incomplete report');
  for (const key of ['sourceTreeHash','instrumentationId']) ensure(/^[a-f0-9]{64}$/.test(r[key]), `Invalid ${key}`);
  ensure(r.languages && Object.keys(r.languages).sort().join() === [...languages].sort().join(), 'Unexpected languages');
  ensure(Array.isArray(r.files) && r.files.length > 0, 'Missing source inventory');
  const files = new Map();
  for (const f of r.files) {
    ensure(typeof f.path === 'string' && !f.path.includes('\\') && !path.isAbsolute(f.path) && !f.path.split('/').some(s => !s || s === '.' || s === '..') && !files.has(f.path), 'Invalid/duplicate source path');
    ensure(languages.includes(f.language) && typeof f.core === 'boolean', `Unexpected language/core: ${f.path}`);
    for (const key of ['executableLines','coveredLines','uncoveredLines']) ensure(Array.isArray(f[key]) && f[key].every(n => Number.isSafeInteger(n) && n>0) && new Set(f[key]).size === f[key].length, `Unknown/invalid mapping: ${f.path}`);
    const exec = new Set(f.executableLines), hits = new Set(f.coveredLines);
    ensure(f.coveredLines.every(n => exec.has(n)) && f.uncoveredLines.length + hits.size === exec.size && f.uncoveredLines.every(n => exec.has(n) && !hits.has(n)), `Artificial coverage credit: ${f.path}`);
    files.set(f.path, f);
  }
  for (const language of languages) for (const scope of scopes) {
    const selected = r.files.filter(f => f.language === language && (scope === 'overall' || f.core));
    const c = selected.reduce((a,f) => ({ covered: a.covered+f.coveredLines.length, executable: a.executable+f.executableLines.length }), {covered:0,executable:0});
    const declared = r.languages[language][scope];
    ensure(declared && declared.coveredLines === c.covered && declared.executableLines === c.executable, `Aggregate mismatch: ${language}/${scope}`);
  }
  return files;
}
function gitBytes(...args) {
  return cp.execFileSync('git', args, {cwd:repo, maxBuffer:32*1024*1024});
}
function safeFile(s) {
  ensure(typeof s === 'string' && /^(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/.test(s) && !s.split('/').some(x=>x==='.'||x==='..'),'Unsafe artifact file path');
  return s;
}
function blobProof(file, expected) {
  safeFile(file);
  const work=fs.readFileSync(path.join(repo,file)), canonical=gitBytes('show',product+':'+file);
  const lf=Buffer.from(work.toString('latin1').replace(/\r\n/g,'\n'),'latin1');
  const transformation=work.equals(canonical)?'identity':lf.equals(canonical)?'checkout-crlf-to-lf':null;
  ensure(transformation && (!expected || hash(work)===expected), 'Source hash mismatch: '+file);
  return {path:file, sourceSHA256:hash(work), gitCanonicalBlobSHA256:hash(canonical), transformation};
}
const digestFile = p => hash(fs.readFileSync(p));
function measuredDisk(disk, requirePostflight) {
  const GiB=1024**3;
  const {volumes,maxGrowthBytes,earlyGrowthBytes,hardReserveBytes,earlyFreeBytes,intervalMilliseconds,nativeTemp83Verified,samples}=disk;
  ensure(maxGrowthBytes===50*GiB && earlyGrowthBytes===49.5*GiB && hardReserveBytes===3*GiB && earlyFreeBytes===3.5*GiB && intervalMilliseconds===1000 && nativeTemp83Verified===true,'Disk and native temp parameters differ from approval');
  ensure(Array.isArray(volumes) && (volumes.length===1 && volumes[0].role==='workspace-and-native-temp' || volumes.length===2 && volumes[0].role==='workspace' && volumes[1].role==='native-temp'),'Wrong guarded volume set');
  ensure(volumes.every((v,i)=>Number.isSafeInteger(v.startFreeBytes) && (i===0?v.startFreeBytes>=12*GiB:v.startFreeBytes>earlyFreeBytes)),'Invalid preflight disk samples');
  ensure(Array.isArray(samples) && samples.length>=3 && samples.length<=5000 && samples[0].phase==='start' && samples.some(s=>s.phase==='native-temp-probe'),'Missing starting or native temp probe disk sample');
  const start=volumes.map(v=>v.startFreeBytes);
  ensure(JSON.stringify(samples[0].freeBytes)===JSON.stringify(start),'Disk starting samples differ from preflight');
  let peakGrowthBytes=0, priorTime=-Infinity;
  const min=[...start];
  for(const sample of samples){
    const time=Date.parse(sample.measuredUtc);
    ensure(typeof sample.phase==='string' && Number.isFinite(time) && time>=priorTime,'Invalid disk sample chronology');
    priorTime=time;
    ensure(Array.isArray(sample.freeBytes) && sample.freeBytes.length===start.length && sample.freeBytes.every(n=>Number.isSafeInteger(n)&&n>earlyFreeBytes),'Per-volume disk reserve violated');
    const growth=sample.freeBytes.reduce((total,free,i)=>total+Math.max(0,start[i]-free),0);
    ensure(growth===sample.growthBytes && growth<earlyGrowthBytes,'Aggregate disk growth limit violated');
    peakGrowthBytes=Math.max(peakGrowthBytes,growth);
    sample.freeBytes.forEach((free,i)=>{min[i]=Math.min(min[i],free);});
  }
  const last=samples.at(-1);
  if(requirePostflight)ensure(last.phase==='post-assessment','Postflight disk sample missing');
  const summary=volumes.map((v,i)=>({role:v.role,startFreeBytes:start[i],minFreeBytes:min[i],finalFreeBytes:last.freeBytes[i]}));
  ensure(summary.every(v=>v.minFreeBytes>hardReserveBytes) && peakGrowthBytes<=maxGrowthBytes,'Measured disk budget violated');
  return {samples:samples.length,volumes:summary,peakGrowthBytes,maxGrowthBytes,earlyGrowthBytes,hardReserveBytes,earlyFreeBytes,intervalMilliseconds,nativeTemp83Verified,postflight:requirePostflight};
}

function safePayload(artifact) {
  const payload=JSON.stringify(artifact,null,2)+'\n';
  ensure(Buffer.byteLength(payload)<=3*1024*1024 && !/[A-Za-z]:[\\/]|file:\/\/|\\\\/.test(payload),'Unsafe artifact size or content');
  return payload;
}

function finalizeDisk(candidate,diskPath,output) {
  const artifact=read(candidate);
  const disk=measuredDisk(read(diskPath),true);
  const sameVolumes=artifact.disk?.volumes?.length===disk.volumes.length && artifact.disk.volumes.every((prior,i)=>{
    const current=disk.volumes[i];
    return prior.role===current.role && prior.startFreeBytes===current.startFreeBytes && prior.minFreeBytes>=current.minFreeBytes;
  });
  ensure(sameVolumes && artifact.disk.samples<disk.samples && artifact.disk.peakGrowthBytes<=disk.peakGrowthBytes && artifact.disk.postflight===false && typeof artifact.coverage?.pass==='boolean','Private assessment and postflight disk evidence disagree');
  artifact.disk=disk;
  artifact.privateEvidenceDigests.diskSamples=digestFile(diskPath);
  const payload=safePayload(artifact);
  const staged=output+'.partial';
  fs.mkdirSync(path.dirname(output));
  fs.writeFileSync(staged,payload,{flag:'wx'});
  fs.renameSync(staged,output);
  console.log(JSON.stringify({pass:artifact.coverage.pass,sourceCommit:artifact.sourceCommit,qualificationCommit:artifact.qualificationCommit,files:artifact.files.length,disk,sha256:hash(payload)}));
}

async function main(combined,nodeRun,nativeRun,output) {
  ensure([combined,nodeRun,nativeRun,output].every(Boolean),'Expected four evidence paths');
  const head=git('rev-parse','HEAD').trim();
  ensure(head===process.env.GITHUB_SHA && /^[a-f0-9]{40}$/.test(head),'Wrong qualification checkout');
  ensure(process.env.GITHUB_REF_NAME==='qualification/restore-readiness-4f4e1d2-x3hrhb3','Wrong branch');
  ensure(git('rev-parse',head+'^').trim()===product,'Qualification must be one commit atop the product');
  ensure(git('status','--porcelain=v1','--untracked-files=all').trim()==='','Qualification checkout is dirty');
  const extra=git('diff','--no-ext-diff','--no-textconv','--no-renames','--name-status',product,head).trim().split(/\r?\n/);
  ensure(JSON.stringify(extra.sort())===JSON.stringify(qualificationFiles.map(f=>'A\t'+f).sort()),'Qualification changed product tree');
  ensure(git('merge-base',base,product).trim()===base,'Product does not descend from baseline');
  const baselineBlob=gitBytes('show',base+':'+reviewPath);
  const before=JSON.parse(baselineBlob);
  ensure(before.metricVersion==='purgeon-coverage-v2' && before.sourceCommit===expectedReviewSource && before.evidenceSHA256.combinedCoverageReport===expectedBaselineReport && before.manualAssessment.pass===true,'Baseline identity or review mismatch');
  const baselineFiles=new Map();
  for(const f of before.files){
    safeFile(f.path);
    ensure(!baselineFiles.has(f.path) && languages.includes(f.language) && typeof f.core==='boolean' && Number.isSafeInteger(f.covered) && Number.isSafeInteger(f.executable) && f.covered>=0 && f.executable>=f.covered,'Invalid reviewed baseline file');
    baselineFiles.set(f.path,f);
  }
  ensure(baselineFiles.size===298,'Unexpected baseline inventory');
  const policyBytes=gitBytes('show',base+':coverage/policy.json');
  ensure(policyBytes.equals(gitBytes('show',head+':coverage/policy.json')),'Coverage policy drift');
  blobProof('coverage/policy.json');
  const policy=JSON.parse(policyBytes);
  ensure(policy.changedCritical.numerator===85 && policy.changedCritical.denominator===100 && policy.touchedLegacyCritical.floorOnceAchieved.numerator===85 && policy.touchedLegacyCritical.floorOnceAchieved.denominator===100 && policy.touchedLegacyCritical.exactRatioNoFall===true,'Unsupported policy');
  const reportPath=path.join(combined,'report.json'), manifestPath=path.join(combined,'manifest.json');
  const evidencePath=path.join(combined,'evidence.json');
  const report=read(reportPath), manifest=read(manifestPath), evidence=read(evidencePath), files=validateReport(report);
  const {inventory,sourceTreeHash,metricVersion,canonical}=await import(pathToFileURL(path.join(repo,'scripts/coverage-report.mjs')).href);
  ensure(path.resolve(manifest.sourceRoot).toLowerCase()===repo.toLowerCase() && manifest.sourceTreeHash===report.sourceTreeHash && evidence.sourceTreeHash===report.sourceTreeHash && manifest.instrumentationId===report.instrumentationId && evidence.instrumentationId===report.instrumentationId && sourceTreeHash(manifest.files,manifest.externalScripts||[])===report.sourceTreeHash,'Manifest or evidence identity mismatch');
  const expectedInventory=inventory(repo);
  ensure(JSON.stringify(expectedInventory)===JSON.stringify(manifest.files.map(({path,language})=>({path,language}))) && files.size===manifest.files.length,'Measured inventory mismatch');
  ensure(report.inputs.length>0 && report.inputs.every(i=>digestFile(i.path)===i.sha256),'Combined report inputs drifted');
  ensure(report.inputs.some(i=>path.resolve(i.path).toLowerCase()===path.resolve(manifestPath).toLowerCase()) && report.inputs.some(i=>path.resolve(i.path).toLowerCase()===path.resolve(evidencePath).toLowerCase()),'Combined report does not bind manifest/evidence');
  ensure(report.instrumentation.nodeVersion==='v26.13.0' && report.instrumentation.viteVersion==='8.3.5' && report.instrumentation.rustVersion==='1.99.0' && report.instrumentation.llvmVersion==='23.1.1' && report.instrumentation.target==='x86_64-pc-windows-msvc' && JSON.stringify(report.instrumentation.nativeFlags)==='["-Cinstrument-coverage"]','Unexpected workload settings');
  const proof=manifest.files.map(f=>{
    const r=files.get(f.path);
    ensure(r && r.language===f.language && r.core===f.core,'Measured file shape drift');
    return {...blobProof(f.path,f.sha256),language:r.language,core:r.core,coveredLines:r.coveredLines,executableLines:r.executableLines};
  });
  const ratios=languages.flatMap(language=>scopes.map(scope=>{
    const baseline=[...baselineFiles.values()].filter(f=>f.language===language&&(scope==='overall'||f.core)).reduce((a,f)=>({covered:a.covered+f.covered,executable:a.executable+f.executable}),{covered:0,executable:0});
    const reviewed=before.manualAssessment.ratios.filter(r=>r.language===language&&r.scope===scope);
    ensure(reviewed.length===1 && reviewed[0].covered===baseline.covered && reviewed[0].executable===baseline.executable,'Reviewed aggregate drift');
    const actual=report.languages[language][scope], now={covered:actual.coveredLines,executable:actual.executableLines};
    return {language,scope,...now,before:baseline,pass:noFall(now,baseline)};
  }));
  const paths=git('diff','--no-ext-diff','--no-textconv','--no-renames','--name-only','-z',base,product,'--').split('\0').filter(Boolean);
  const changedByLanguage=Object.fromEntries(languages.map(l=>[l,{covered:0,executable:0}]));
  const touched=[];
  for(const file of paths){
    if(!critical(file,policy))continue;
    const now=files.get(file),old=baselineFiles.get(file);
    if(!now&&!old)continue;
    ensure(now && (!old||old.language===now.language),'Critical measured file removed or language changed: '+file);
    const lines=hunkLines(git('diff','--no-ext-diff','--no-textconv','--no-renames','--unified=0',base,product,'--',file));
    const changed=now.executableLines.filter(n=>!old||lines.has(n));
    const hits=new Set(now.coveredLines), uncovered=changed.filter(n=>!hits.has(n));
    const changedCovered=changed.length-uncovered.length;
    changedByLanguage[now.language].covered+=changedCovered;
    changedByLanguage[now.language].executable+=changed.length;
    const c=counts(now), b=old?{covered:old.covered,executable:old.executable}:null;
    touched.push({path:file,language:now.language,newFile:!old,...c,before:b,changedCovered,changedExecutable:changed.length,changedUncovered:uncovered,pass:old?noFall(c,b)&&(floor(b)!==true||floor(c)===true):floor(c)!==false});
  }
  for(const c of Object.values(changedByLanguage)){c.pass=floor(c);if(!c.executable)c.applicability='0/0 N/A: no changed executable lines';}
  const pass=ratios.every(r=>r.pass)&&touched.every(t=>t.pass)&&Object.values(changedByLanguage).every(c=>c.pass!==false);
  const nodeResultPath=path.join(nodeRun,'execution.json'), nativeResultPath=path.join(nativeRun,'result.json');
  const nodeExecution=read(nodeResultPath), nativeExecution=read(nativeResultPath);
  const workloadPath=path.join(nodeRun,'workload-inputs.json');
  const workloadSourceProof=[];
  for(const input of read(workloadPath)) {
    ensure(digestFile(input.path)===input.sha256,'Node workload input drift');
    if(path.resolve(input.path).toLowerCase()===path.resolve(nodeExecution.executable).toLowerCase())continue;
    const rel=path.relative(repo,input.path).replaceAll('\\','/');
    ensure(rel==='package-lock.json' || (rel.startsWith('test/') && /\.(js|json)$/.test(rel)),'Unexpected Node workload source');
    workloadSourceProof.push(blobProof(rel,input.sha256));
  }
  ensure(workloadSourceProof.some(x=>x.path==='package-lock.json') && JSON.stringify(nodeExecution.args)==='["--test","test/*.test.js"]','Expected full Node workload proof missing');
  const regressionPath='test/recovery.test.js';
  ensure(paths.includes(regressionPath),'Regression source is absent from the candidate diff');
  let regressionSourceProof;
  if(/^test\//.test(regressionPath)) {
    const tracked=workloadSourceProof.find(x=>x.path===regressionPath);
    ensure(tracked,'Regression source is absent from the Node workload');
    regressionSourceProof={kind:'node',...tracked};
  } else {
    ensure(/^src-tauri\/(?:src|tests)\/.+\.rs$/.test(regressionPath),'Unsupported native regression source');
    const snapshots=['source-before.json','source-after.json'].map(name=>read(path.join(nativeRun,name)).filter(row=>row.path===regressionPath));
    ensure(snapshots.every(rows=>rows.length===1) && snapshots[0][0].sha256.toLowerCase()===snapshots[1][0].sha256.toLowerCase(),'Native regression source snapshot missing or changed');
    regressionSourceProof={kind:'rust',...blobProof(regressionPath,snapshots[0][0].sha256.toLowerCase())};
  }
  const diskPath=path.join(nativeRun,'disk-samples.json'), disk=read(diskPath);
  ensure(nodeExecution.exitCode===0 && nodeExecution.signal===null && nativeExecution.testExitCode===0 && nativeExecution.exportExitCode===0 && nativeExecution.sourceUnchanged && nativeExecution.sourceCommit===product,'Workload result failure');
  const assessedDisk=measuredDisk(disk,false);
  ensure(['pass','below-floor'].includes(report.verdict) && report.exitCode===(report.verdict==='pass'?0:1),'Unexpected reporter status');
  const toolsPath=path.join(nativeRun,'tool-inputs.json');
  const tools=read(toolsPath).map(t=>({name:path.basename(t.Path),sha256:t.Hash.toLowerCase()}));
  ensure(tools.length===7 && new Set(tools.map(x=>x.name)).size===7 && tools.every(t=>/^[a-f0-9]{64}$/.test(t.sha256)),'Invalid tool digest metadata');
  const toolHash=name=>tools.find(t=>t.name===name)?.sha256;
  const wrapperSource=toolHash('workspace-wrapper.rs');
  const wrapperBinary=toolHash('workspace-wrapper.exe');
  ensure(wrapperSource==='7c93b293259459115f2ad84c8ed70628305f597672dcd83354e8863201ef7d28' && wrapperBinary===report.instrumentation.nativeBuildScript?.wrapperSha256,'Unexpected wrapper evidence');
  const i=report.instrumentation;
  const instrumentation={metricVersion:i.metricVersion,nodeVersion:i.nodeVersion,webviewVersion:i.webviewVersion,viteVersion:i.viteVersion,jsFlags:i.jsFlags,rustVersion:i.rustVersion,llvmVersion:i.llvmVersion,target:i.target,nativeFlags:i.nativeFlags,nativeBuildScript:i.nativeBuildScript};
  ensure(hash(JSON.stringify(canonical(instrumentation)))===report.instrumentationId,'Instrumentation identity mismatch');
  const artifact={
    schemaVersion:1,metricVersion,sourceCommit:product,qualificationCommit:head,
    sourceTreeHash:report.sourceTreeHash,instrumentationId:report.instrumentationId,instrumentation,
    coverage:{baseline:{mergeCommit:base,measuredCommit:before.sourceCommit,review:reviewPath,reviewSHA256:hash(baselineBlob),priorReportSHA256:expectedBaselineReport,policySHA256:hash(policyBytes)},ratios,touched,changedByLanguage,pass},
    qualificationFiles:qualificationFiles.map(f=>({path:f,gitBlobSHA256:hash(gitBytes('show',head+':'+f))})),
    changedSourceProof:paths.map(f=>blobProof(f)),workloadSourceProof,regressionSourceProof,
    reporter:{exitCode:report.exitCode,verdict:report.verdict,incompleteReasons:[]},
    wrapper:{sourceSHA256:wrapperSource,binarySHA256:wrapperBinary,compileArgv:['--edition=2021','<reviewed-wrapper-source>','-o','<owned-wrapper-output>'],compilerSHA256:toolHash('rustc.exe')},
    tools,
    workloads:{nodeExitCode:nodeExecution.exitCode,nativeTestExitCode:nativeExecution.testExitCode,nativeExportExitCode:nativeExecution.exportExitCode,sourceUnchanged:true,rustTestThreads:1,cargoJobs:1},
    disk:assessedDisk,
    privateEvidenceDigests:{report:digestFile(reportPath),manifest:digestFile(manifestPath),evidence:digestFile(evidencePath),nodeResult:digestFile(nodeResultPath),nativeResult:digestFile(nativeResultPath),diskSamples:digestFile(diskPath),toolInputs:digestFile(toolsPath),nodeWorkloadInputs:digestFile(workloadPath)},
    files:proof,
    limits:['Only sanitized measured line arrays and hashes are exported. Raw profiles, binaries and logs remain on the disposable runner.','Node tests do not exercise the production WebView.','The manually reviewed baseline supplies exact reviewed prior counts. The original raw prior report is hash identified and stays local.']
  };
  const payload=safePayload(artifact);
  fs.writeFileSync(output,payload,{flag:'wx'});
  console.log(JSON.stringify({pass,sourceCommit:product,qualificationCommit:head,files:proof.length,coverage:changedByLanguage,sha256:hash(payload)}));
  process.exitCode=pass?0:1;
}
function boundedTail(filename, cap=1024*1024) {
  if (!fs.existsSync(filename)) return {lines:[],truncated:false};
  const descriptor=fs.openSync(filename,'r');
  try {
    const {size}=fs.fstatSync(descriptor);
    const offset=Math.max(0,size-cap);
    const bytes=Buffer.alloc(size-offset);
    const readBytes=fs.readSync(descriptor,bytes,0,bytes.length,offset);
    const lines=bytes.subarray(0,readBytes).toString('utf8').split(/\r?\n/);
    if(offset>0)lines.shift();
    return {lines,truncated:offset>0};
  } finally {
    fs.closeSync(descriptor);
  }
}

function diagnosticSpan(spans) {
  if(!Array.isArray(spans))return undefined;
  for(const span of spans.filter(s=>s?.is_primary)) {
    const file=typeof span.file_name==='string'?span.file_name.replaceAll('\\','/'):'';
    if(!/^(?:(?:src-tauri\/)?(?:src|tests)\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.rs|(?:src-tauri\/)?build(?:_support)?\.rs)$/.test(file))continue;
    if(!Number.isSafeInteger(span.line_start)||span.line_start<1||span.line_start>1000000)continue;
    return {file,line:span.line_start};
  }
}

function diagnoseCargo(stdout,stderr) {
  const streams=[boundedTail(stdout),boundedTail(stderr)];
  const compilerErrors=[], failedTests=new Set(), nativeCodes=new Set(), categories=new Set();
  let buildFinished=null, testResult=null, libTestFailure=false, compilerErrorCount=0;
  for(const {lines} of streams)for(const line of lines) {
    let classification=line;
    if(line.startsWith('{')) {
      let event;
      try{event=JSON.parse(line);}catch{continue;}
      if(event.reason==='build-finished'&&typeof event.success==='boolean')buildFinished=event.success;
      if(event.reason!=='compiler-message'||event.message?.level!=='error')continue;
      compilerErrorCount++;
      const {code,spans,message,rendered}=event.message;
      const entry={};
      if(typeof code?.code==='string'&&/^(?:E\d{4}|[a-z][a-z0-9_]{0,63})$/.test(code.code))entry.code=code.code;
      const location=diagnosticSpan(spans);
      if(location)entry.location=location;
      if(compilerErrors.length<12)compilerErrors.push(entry);
      classification=[message,rendered].filter(t=>typeof t==='string').join('\n');
    }
    const failed=/^test ([A-Za-z_][A-Za-z0-9_:]{0,159}) \.\.\. FAILED$/.exec(line);
    if(failed&&failedTests.size<16)failedTests.add(failed[1]);
    const result=/^test result: (ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; (\d+) filtered out;/.exec(line);
    if(result)testResult={status:result[1],passed:Number(result[2]),failed:Number(result[3]),ignored:Number(result[4])};
    if(/^error: test failed, to rerun pass (?:--lib|\x60--lib\x60)$/.test(line))libTestFailure=true;
    for(const code of classification.matchAll(/\bLNK\d{4}\b|\bos error (?:5|32|39|112|1450|1455)\b/gi)) {
      if(nativeCodes.size<12)nativeCodes.add(code[0].toUpperCase());
    }
    if(/error linking with|linker command failed|\bLNK\d{4}\b/i.test(classification))categories.add('linker');
    if(/no space left|not enough space|disk full|\bos error (?:39|112)\b/i.test(classification))categories.add('storage');
    if(/out of memory|not enough memory|paging file|\bos error (?:1450|1455)\b/i.test(classification))categories.add('memory');
    if(/access is denied|permission denied|sharing violation|\bos error (?:5|32)\b/i.test(classification))categories.add('access-or-sharing');
    if(/failed to run custom build command/i.test(classification))categories.add('build-script');
    if(/failed to (?:download|fetch)|offline mode/i.test(classification))categories.add('dependency');
  }
  console.log(JSON.stringify({cargoFailure:{buildFinished,compilerErrorCount,compilerErrors,failedTests:[...failedTests],testResult,libTestFailure,nativeCodes:[...nativeCodes],categories:[...categories],truncated:streams.some(s=>s.truncated)}}));
}

function diagnoseAssessment(stderr) {
  const text=boundedTail(stderr,8192).lines.join('\n');
  const rules=[
    [/disk|reserve|growth limit/i,'disk-policy'],
    [/baseline|ratchet|coverage|line set|mapping|aggregate/i,'coverage-policy'],
    [/source|checkout|blob|inventory|manifest/i,'source-identity'],
    [/tool|wrapper|instrumentation/i,'toolchain-identity'],
    [/payload|artifact|privacy/i,'artifact-safety'],
    [/workload|test|export/i,'workload-result']
  ];
  console.log(JSON.stringify({assessmentRejection:rules.find(([pattern])=>pattern.test(text))?.[1]??'unclassified'}));
}

const [mode,...args]=process.argv.slice(2);
Promise.resolve().then(()=>{
  if(mode==='--finalize-disk')return finalizeDisk(...args);
  if(mode==='--diagnose-cargo')return diagnoseCargo(...args);
  if(mode==='--diagnose-assessment')return diagnoseAssessment(...args);
  return main(mode,...args);
}).catch(error=>{
  if(mode==='--diagnose-cargo'||mode==='--diagnose-assessment')console.error('Sanitized diagnostic unavailable');
  else console.error(error.message);
  process.exitCode=2;
});
