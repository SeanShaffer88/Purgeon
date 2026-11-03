import test from 'node:test';
import assert from 'node:assert/strict';
import { setSys } from '../src/backend/sys.js';
import * as updater from '../src/backend/updatecheck.js';
const id='a'.repeat(32),digest='b'.repeat(64),nativePath='C:\\NativeTemp\\Purgeon-Update-random\\Purgeon-Setup-x64.exe';
const release=()=>({tag:'v9.9.9',assets:[{name:updater.SETUP_ASSET,url:'https://example.invalid/no-request',size:123,digest:`sha256:${digest}`}]});
function fixture(options={}){
  const calls=[];let bytes='expected';let bound;
  const forbidden=async()=>{calls.push(['forbidden']);throw new Error('Forbidden generic update boundary');};
  setSys({info:{version:'1.4.1',portable:options.portable===true,env:{TEMP:'C:\\RendererCannotChoose'}},
    runPS:async(script)=>{if(script.includes('Invoke-RestMethod')){calls.push(['metadata']);return JSON.stringify(options.release||release());}calls.push(['download',script]);assert.ok(script.includes(`-OutFile '${nativePath}'`));if(options.downloadError)throw Error('Download interrupted');if(options.tampered)bytes='replacement';return '';},
    reserveUpdateDownload:async(expected)=>{calls.push(['reserve',expected]);bound=structuredClone(expected);if(options.reserveError)throw Error('Reservation refused');return options.badReservation||{id,path:nativePath};},
    launchVerifiedUpdate:async(...args)=>{calls.push(['verified',...args]);assert.deepEqual(args,[id]);assert.deepEqual(bound,{sha256:digest,size:123});if(options.launchError)throw Error(options.launchError);if(bytes!=='expected')throw Error('Native SHA-256 mismatch; download retained');},
    cancelUpdateDownload:async(value)=>{calls.push(['cancel',value]);if(options.cancelError)throw Error('Cleanup unavailable');return options.cleanup||{removed:true,detail:'Removed native-owned reservation'};},
    launch:forbidden,stat:forbidden,sha256Files:forbidden,removePath:forbidden,
  });return calls;
}

test('update uses immutable native metadata reservation and opaque verified launch without generic fallback',async()=>{
  const calls=fixture();const result=await updater.downloadAndInstall();assert.equal(result.ok,true);assert.equal(result.file,nativePath);assert.deepEqual(calls.map(c=>c[0]),['metadata','reserve','download','verified']);assert.deepEqual(calls[1][1],{sha256:digest,size:123});
});

test('bytes replaced after download are rejected at the native launch boundary with no retry or fallback',async()=>{
  const calls=fixture({tampered:true});const result=await updater.downloadAndInstall();assert.equal(result.ok,false);assert.match(result.error,/SHA-256 mismatch.*retained/);assert.equal(calls.filter(c=>c[0]==='verified').length,1);assert.ok(!calls.some(c=>['forbidden','cancel'].includes(c[0])));
});

test('failed native validation or cancelled process creation reports failure and retains native evidence',async()=>{
  for(const launchError of ['Wrong size; download retained','USER_CANCELLED','Unknown or consumed reservation']){const calls=fixture({launchError});const result=await updater.downloadAndInstall();assert.equal(result.ok,false);assert.ok(result.error.includes(launchError));assert.deepEqual(calls.map(c=>c[0]),['metadata','reserve','download','verified']);}
});

test('failed downloads request only native-owned cleanup and report unconfirmed cleanup honestly',async()=>{
  for(const options of [{},{cleanup:{removed:false,detail:'Native reservation retained: sharing denied'}},{cancelError:true}]){const calls=fixture({...options,downloadError:true});const result=await updater.downloadAndInstall();assert.equal(result.ok,false);assert.deepEqual(calls.map(c=>c[0]),['metadata','reserve','download','cancel']);if(options.cleanup||options.cancelError)assert.match(result.error,/retained/);}
});

test('portable, missing digest and reservation failures cannot download or launch',async()=>{
  for(const options of [{portable:true},{release:{tag:'v9.9.9',assets:[{name:updater.SETUP_ASSET,url:'https://example.invalid/no-request',digest:''}]}},{reserveError:true}]){const calls=fixture(options);const result=await updater.downloadAndInstall();assert.equal(result.ok,false);assert.ok(!calls.some(c=>['download','verified','forbidden'].includes(c[0])));}
});

test('invalid native reservation response fails closed without a raw path launch',async()=>{
  const calls=fixture({badReservation:{id:'bad',path:nativePath}});assert.equal((await updater.downloadAndInstall()).ok,false);assert.ok(!calls.some(c=>['download','verified','forbidden'].includes(c[0])));
});