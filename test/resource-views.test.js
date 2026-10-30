import { test } from 'node:test';
import assert from 'node:assert/strict';
import { leftoverSections } from '../src/leftover-sections.js';
import { createRefreshGate } from '../src/refresh-gate.js';
import { installTips } from '../src/tips.js';
import { createIconLoader } from '../src/icon-loader.js';

test('leftover index preserves program/group/original row order and overlapping groups',()=>{
  const groups=[{id:'files',kinds:['file','dir']},{id:'overlap',kinds:['file','file']},{id:'keys',kinds:['key']}];
  const items=[{kind:'key',program:'B'},{kind:'file',program:'A'},{kind:'file',program:'B'},{kind:'dir'},{kind:'unknown',program:'Empty'}];
  const old=[...new Set(items.map(it=>it.program||''))].map(program=>{const gs=groups.map(g=>({...g,id:`${program}|${g.id}`,rows:items.map((it,idx)=>({it,idx})).filter(({it})=>(it.program||'')===program&&g.kinds.includes(it.kind))})).filter(g=>g.rows.length);return {program,groups:gs,rows:gs.flatMap(g=>g.rows)};});
  assert.deepEqual(leftoverSections(items,groups),old);
});
test('process view timer coalesces and successful actions request one trailing sample; disposal rejects late state',async()=>{
  const pending=[]; const received=[];const errors=[];
  const gate=createRefreshGate(()=>new Promise((resolve,reject)=>pending.push({resolve,reject})),v=>received.push(v),e=>errors.push(e.message));
  const first=gate.request();for(let i=0;i<20;i++)gate.request();gate.request(true);gate.request(true);
  assert.equal(pending.length,1);pending[0].resolve(1);await new Promise(setImmediate);
  assert.equal(pending.length,2);pending[1].resolve(2);await first;assert.deepEqual(received,[1,2]);
  const last=gate.request();gate.dispose();pending[2].reject(Error('late'));await last;assert.deepEqual(errors,[]);await gate.request();assert.equal(pending.length,3);
});
test('tooltip mutations scan added subtree and nearest control only, preserve owned titles, and cancel queued work',()=>{
  let callback,frame;let cancelled=false,disconnected=false,fullScans=0;
  const original={MutationObserver:globalThis.MutationObserver,requestAnimationFrame:globalThis.requestAnimationFrame,cancelAnimationFrame:globalThis.cancelAnimationFrame};
  globalThis.MutationObserver=class{constructor(fn){callback=fn;}observe(){}disconnect(){disconnected=true;}};
  globalThis.requestAnimationFrame=(fn)=>{frame=fn;return 1;};globalThis.cancelAnimationFrame=()=>{cancelled=true;};
  const control=(text,title='')=>({nodeType:1,title,dataset:{},textContent:text,innerText:text,matches:()=>true,querySelectorAll:()=>[],closest(){return this;}});
  const first=control('Close','Owned title');const added=control('Cancel');const root={matches:()=>false,querySelectorAll:()=>{fullScans++;return [first];},contains:()=>true};
  try{
    const dispose=installTips(root);assert.equal(first.title,'Owned title');assert.equal(fullScans,1);
    callback([{target:root,addedNodes:[added]}]);frame();assert.ok(added.title);assert.equal(fullScans,1);
    const changed=control('Close');callback([{target:{nodeType:3,parentElement:changed},addedNodes:[]}]);frame();assert.ok(changed.title);
    callback([{target:root,addedNodes:[control('Save')]}]);dispose();assert.ok(cancelled&&disconnected);
  }finally{Object.assign(globalThis,original);}
});
test('icon requests coalesce equal source identities and invalidate changed same-key sources',async()=>{
  const pending=[];const loader=createIconLoader(rows=>new Promise(resolve=>pending.push({rows,resolve})));
  const a={key:'a',icon:'C:\\Old.exe',version:'1'};loader.retain([a]);
  const first=loader.load([a]);const second=loader.load([{...a,sizeKB:100}]);await new Promise(setImmediate);assert.equal(pending.length,1);
  const b={...a,icon:'C:\\New.exe'};loader.retain([b]);const third=loader.load([b]);await new Promise(setImmediate);assert.equal(pending.length,2);
  pending[0].resolve({a:'old'});pending[1].resolve({});assert.deepEqual(await first,{a:'old'});await second;assert.deepEqual(await third,{a:null});
  assert.deepEqual(await loader.load([b]),{a:null});assert.equal(pending.length,2,'negative result cached only for unchanged source');
});
