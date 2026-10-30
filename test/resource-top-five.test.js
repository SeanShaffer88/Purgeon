import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { setSys } from '../src/backend/sys.js';
import * as programs from '../src/backend/programs.js';
import * as insights from '../src/backend/insights.js';
import * as archive from '../src/backend/archive.js';
import { scanFiles } from '../src/backend/leftovers.js';

test('signature cache uses first case spelling and its corresponding stamp', async () => {
  const saved = new Map(); const calls = [];
  const first='C:\\Apps\\Tool.exe', second='c:\\apps\\tool.exe';
  setSys({ makeDir:async()=>{}, readText:async(p)=>{ if(!saved.has(p))throw Error('missing'); return saved.get(p); },
    writeTextAtomic:async(p,s)=>saved.set(p,s), stat:async(p)=>({size:p===first?1:2,modified:10}),
    runPS:async(_script,input)=>{calls.push(JSON.parse(input));return JSON.stringify([{path:second,status:'Valid',signer:'Fixture'}]);} });
  await insights.setRoot('C:\\MemoryResource');
  assert.equal((await insights.signatures([first,second])).get(second).status,'Valid');
  await insights.signatures([first]);
  assert.equal(calls.length,1,'first spelling stamp was cached rather than overwritten by the duplicate spelling');
  await insights.signatures([second]);
  assert.equal(calls.length,2,'different stamp still misses');
  saved.clear(); calls.length=0;
  setSys({stat:async(p)=>{if(p===first)await new Promise(setImmediate);return {size:p===first?1:2,modified:10};}});
  await insights.setRoot('C:\\MemoryResource');
  await insights.signatures([first,second]);
  assert.deepEqual(calls[0],[second,first],'first miss is determined by completed stamp reads');
  await insights.signatures([second]);
  assert.equal(calls.length,1,'first completed spelling keeps its stamp');
  await insights.signatures([first]);
  assert.equal(calls.length,2);
});

test('archive attaches only newest case-insensitive entry without reordering entries or backups', async () => {
  let data=JSON.stringify([{key:'A',backups:['old']},{key:'b',backups:[]},{key:'a',backups:['existing']}]);
  setSys({makeDir:async()=>{},readText:async()=>data,writeTextAtomic:async(_p,s)=>{data=s;}});
  await archive.setRoot('C:\\MemoryArchive');
  await archive.attachBackup(['A','a','missing','b'],'new');
  assert.deepEqual(JSON.parse(data),[{key:'A',backups:['old']},{key:'b',backups:['new']},{key:'a',backups:['existing','new']}]);
});

test('shortcut scan retains depth-first order, uppercase extensions, depth limit and link refusal', async () => {
  const root='C:\\FixtureHome\\Desktop'; const dirs=new Map();
  dirs.set(root,[{name:'first.LNK',file:true},{name:'sub',dir:true},{name:'ignored.bin',file:true},{name:'last.url',file:true},{name:'link',dir:true,link:true}]);
  dirs.set(root+'\\sub',[{name:'nested.lnk',file:true},{name:'deep',dir:true}]);
  let d=root+'\\sub\\deep'; for(let i=0;i<3;i++){dirs.set(d,[{name:`level${i}.lnk`,file:true},{name:'next',dir:true}]);d+='\\next';}
  dirs.set(d,[{name:'too-deep.lnk',file:true}]);
  const visited=[]; const resolved=[];
  setSys({info:{env:{},home:'C:\\FixtureHome'},exists:async()=>false,readDir:async(p)=>{visited.push(p);return dirs.get(p)||[];}});
  await scanFiles({name:'Fixture',publisher:'',location:'C:\\Apps\\Fixture'},async(paths)=>{resolved.push(...paths);return new Map();});
  assert.deepEqual(resolved,[root+'\\first.LNK',root+'\\sub\\nested.lnk',root+'\\sub\\deep\\level0.lnk',root+'\\sub\\deep\\next\\level1.lnk',root+'\\sub\\deep\\next\\next\\level2.lnk']);
  assert.ok(!visited.includes(root+'\\link'));
  assert.ok(!visited.includes(d),'depth-five folder is not visited');
});

test('icon batch disposes all created resources after success, draw/save failure and throwing disposal', async () => {
  let script;
  setSys({runPS:async(value)=>{script=value;return '[]';}});
  await programs.iconsFor([{key:'fixture',icon:'C:\\Fixture.exe'}]);
  // Execute the production control flow with fake disposable resources only.
  // No Drawing objects, files, shell commands or registry operations are used.
  script=script.replace('Add-Type -AssemblyName System.Drawing','')
    .replace(/\$icon = if[^\n]+/u,"$icon = [ResourceFixture]::Make('icon')")
    .replace('New-Object System.Drawing.Bitmap 16, 16',"[ResourceFixture]::Make('bmp')")
    .replace('[System.Drawing.Graphics]::FromImage($bmp)',"[ResourceFixture]::Make('g')")
    .replace('New-Object System.IO.MemoryStream',"[ResourceFixture]::Make('ms')")
    .replace('[System.Drawing.Imaging.ImageFormat]::Png',"'Png'");
  const types=`public class ResourceFixture {
    public static string Mode; public static System.Collections.Generic.List<string> Created=new System.Collections.Generic.List<string>();
    public static System.Collections.Generic.List<string> Disposed=new System.Collections.Generic.List<string>();
    public string Name; public string InterpolationMode;
    public static ResourceFixture Make(string n){Created.Add(n);return new ResourceFixture{Name=n};}
    public ResourceFixture ToBitmap(){return Make("iconBitmap");}
    public void DrawImage(object b,int x,int y,int w,int h){if(Mode=="draw")throw new System.Exception("draw");}
    public void Save(object s,object f){if(Mode=="save")throw new System.Exception("save");}
    public byte[] ToArray(){return new byte[]{1,2,3};}
    public void Dispose(){Disposed.Add(Name);if(Mode=="dispose"&&Name=="ms")throw new System.Exception("dispose");}
  }`;
  for(const mode of ['ok','draw','save','dispose']){
    const body=`Add-Type -TypeDefinition '${types.replace(/'/g,"''")}'; function Test-Path { $true }; [ResourceFixture]::Mode='${mode}'; $json=& { ${script} }; [pscustomobject]@{json=$json;created=@([ResourceFixture]::Created);disposed=@([ResourceFixture]::Disposed)} | ConvertTo-Json -Compress`;
    const result=await new Promise((resolve,reject)=>{const child=execFile('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(body,'utf16le').toString('base64')],{windowsHide:true,timeout:30000},(error,stdout)=>error?reject(error):resolve(JSON.parse(stdout)));child.stdin.end('[{"key":"fixture","file":"C:\\\\Fixture.exe"}]');});
    assert.deepEqual([...result.disposed].sort(),[...result.created].sort(),mode);
    const rows=typeof result.json==='string'?JSON.parse(result.json):[]; const list=Array.isArray(rows)?rows:[rows];
    assert.equal(list.length,mode==='draw'||mode==='save'?0:1,mode);
    if(list.length)assert.equal(list[0].png,'AQID');
  }
});
