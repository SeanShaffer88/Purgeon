import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import nodePath from 'node:path';
import { setSys } from '../src/backend/sys.js';
import * as transfer from '../src/backend/transfer.js';

const target = 'C:\\Users\\LimitTester\\AppData\\Roaming\\LimitFixture';
async function script() {
  let extracted;
  const manifest={format:'purgeon-program-backup',version:1,source:{profile:'C:\\Users\\LimitTester'},program:{name:'Fixture'},items:[{n:0,kind:'dir',path:target}]};
  setSys({info:{dataDir:'C:\\LimitFixture',home:'C:\\Users\\LimitTester',env:{}},makeDir:async()=>{},exists:async path=>path==='C:\\',reserveTransferRestore:async()=>{throw Error('Target reservation must follow preflight');},runPS:async value=>{if(value.includes("GetEntry('manifest.json')"))return JSON.stringify(manifest);extracted=value;throw Error('captured preflight');}});
  await transfer.setRoot('C:\\LimitFixture');await assert.rejects(transfer.restore('C:\\Fixture.swpkg',[0]),/captured preflight/);return extracted;
}
function probe(source,entries,kind='dir') {
  // Substitute only the ZIP reader with trusted metadata. The product's actual
  // preflight runs, with no extraction, large allocation or target creation.
  source=source.replace('$zip = [IO.Compression.ZipFile]::OpenRead($in.file)', "$zip = [pscustomobject]@{ Entries = @($in.entries) }; $zip | Add-Member -MemberType ScriptMethod -Name Dispose -Value {} ");
  const result=spawnSync(nodePath.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-Command',source],{input:JSON.stringify({file:'unused',preflight:true,items:[{n:0,kind,target}],keys:[],entries}),encoding:'utf8',windowsHide:true,timeout:60000,maxBuffer:1024*1024});
  assert.ifError(result.error);return result;
}
const entry=(relative,length=0)=>({FullName:'files/0/'+relative,Length:length,CompressedLength:Math.max(1,length)});
test('selected restore byte and depth boundaries match native undo limits before mutation',async()=>{
  const source=await script();
  for(const [entries,kind,allowed] of [[[entry('file',536870912)],'file',true],[[entry('file',536870913)],'file',false],[[entry(Array(64).fill('d').join('/'))],'dir',true],[[entry(Array(65).fill('d').join('/'))],'dir',false]]){
    const result=probe(source,entries,kind);assert.equal(result.status===0,allowed,result.stderr);
  }
});
test('selected node limits count implicit directories and root without extracting them',async()=>{
  const source=await script(),entries=[];
  // 156 independent 64-node chains + 15 root files + the selected root = 10,000.
  for(let i=0;i<156;i++)entries.push(entry([`b${i}`,...Array(62).fill('d'),'file'].join('/')));
  for(let i=0;i<15;i++)entries.push(entry(`file${i}`));
  const allowed=probe(source,entries);assert.equal(allowed.status,0,allowed.stderr);
  const denied=probe(source,[...entries,entry('one-too-many')]);assert.notEqual(denied.status,0);assert.match(denied.stderr,/node limit/);
});
