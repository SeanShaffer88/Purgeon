import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const {parse}=require('espree');
const source=fs.readFileSync(new URL('../src/App.jsx',import.meta.url),'utf8');
let callback;
function visit(node){if(!node||typeof node!=='object')return;if(node.type==='VariableDeclarator'&&node.id.name==='load'&&node.init?.callee?.name==='useCallback')callback=node.init.arguments[0];for(const value of Object.values(node))if(Array.isArray(value))value.forEach(visit);else if(value&&typeof value==='object')visit(value);}
visit(parse(source,{ecmaVersion:'latest',sourceType:'module',ecmaFeatures:{jsx:true},range:true}));
assert.ok(callback,'exercise actual App load callback, without exporting UI test hooks');
function fixture(){
  const requests=[],rows=[],errors=[],loading=[],deferred=[];
  const deps={view:'desktop',mounted:{current:true},currentView:{current:'desktop'},loadGeneration:{current:0},VIEWS:{desktop:{},store:{},processes:{custom:true}},desktopCache:{current:[]},outsideChecked:{current:false},api:{invoke:(channel,arg)=>new Promise((resolve,reject)=>requests.push({channel,arg,resolve,reject}))},defer:fn=>deferred.push(fn),setLoading:value=>loading.push(value),setError:value=>errors.push(value),setRows:value=>rows.push(value),setCustomKey:()=>{},setInsight:()=>{},setModal:()=>{},toRow:(_v,value)=>value};
  const names=Object.keys(deps);const load=Function(...names,`return (${source.slice(...callback.range)});`)(...names.map(name=>deps[name]));
  return {deps,load,requests,rows,errors,loading,deferred};
}
test('newer same-view reload owns success and finalization; stale rejection cannot clear its rows',async()=>{
  const f=fixture();const first=f.load();const second=f.load();f.requests[1].resolve([{key:'new'}]);await second;
  f.requests[0].reject(Error('old failure'));await first;
  assert.deepEqual(f.rows,[[{key:'new'}]]);assert.ok(!f.errors.includes('old failure'));assert.equal(f.loading.filter(value=>value===false).length,1);
});
test('view change and unmount discard late responses and deferred work',async()=>{
  const f=fixture();const first=f.load();f.deps.currentView.current='store';f.requests[0].resolve([{key:'old'}]);await first;assert.deepEqual(f.rows,[]);
  f.deps.currentView.current='desktop';const next=f.load();f.requests[1].resolve([{key:'current'}]);await next;
  f.deps.mounted.current=false;const before=f.requests.length;f.deferred.forEach(fn=>fn());assert.equal(f.requests.length,before,'no detached background inventory work begins');
});
test('actual graph selection callback discards stale success and error after new selection or unmount',async()=>{
  const text=fs.readFileSync(new URL('../src/dialogs.jsx',import.meta.url),'utf8');
  const ast=parse(text,{ecmaVersion:'latest',sourceType:'module',ecmaFeatures:{jsx:true},range:true});
  const graph=ast.body.find(node=>node.declaration?.id?.name==='GraphDialog').declaration;
  const pick=graph.body.body.find(node=>node.type==='VariableDeclaration'&&node.declarations[0].id.name==='pick').declarations[0].init;
  const pending=[],deep=[];const alive={current:true},selectionGeneration={current:0};
  const fn=Function('alive','selectionGeneration','setSelected','setDeep','api',`return (${text.slice(...pick.range)});`)(alive,selectionGeneration,()=>{},value=>deep.push(value),{invoke:()=>new Promise((resolve,reject)=>pending.push({resolve,reject}))});
  fn({name:'A'});fn({name:'B'});pending[1].resolve({dependents:['B']});await new Promise(setImmediate);pending[0].reject(Error('A'));await new Promise(setImmediate);
  assert.deepEqual(deep,[null,null,{dependents:['B']}]);
  fn({name:'C'});alive.current=false;pending[2].resolve({dependents:['C']});await new Promise(setImmediate);assert.deepEqual(deep.at(-1),null);
});
