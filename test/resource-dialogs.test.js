import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const {parse}=createRequire(import.meta.url)('espree');
const read=name=>fs.readFileSync(new URL('../src/'+name,import.meta.url),'utf8');
const ast=text=>parse(text,{ecmaVersion:'latest',sourceType:'module',ecmaFeatures:{jsx:true},range:true});

test('eager App import closure excludes optional dialog families and all named lazy exports exist',()=>{
  const optional=new Set(['dialogs.jsx','more.jsx','tools.jsx','groups.jsx','transfer.jsx','snapshots.jsx']);const seen=new Set();
  const walk=name=>{if(seen.has(name))return;seen.add(name);for(const node of ast(read(name)).body){if(node.type!=='ImportDeclaration'||!node.source.value.startsWith('./'))continue;const target=path.posix.normalize(path.posix.join(path.posix.dirname(name),node.source.value));if(/\.jsx?$/.test(target))walk(target);}};
  walk('App.jsx');for(const name of optional)assert.equal(seen.has(name),false,`${name} stays outside eager closure`);
  const app=read('App.jsx');const pairs=[...app.matchAll(/optionalDialog\(\(\) => import\('\.\/([^']+)'\), '([^']+)'\)/g)];assert.ok(pairs.length>40);
  for(const [,file,name] of pairs)assert.ok(ast(read(file)).body.some(node=>node.type==='ExportNamedDeclaration'&&(node.declaration?.id?.name===name||node.specifiers.some(specifier=>specifier.exported.name===name))),`${file} exports ${name}`);
});

test('single modal registry preserves nested isolation, safe focus, Escape, Tab loop and opener restoration',()=>{
  const text=read('core-dialog.jsx');const nodes=ast(text).body.filter(node=>{
    const d=node.declaration||node;return ['modalLayers','originalInert','focusableIn','topModal'].includes(d.declarations?.[0]?.id.name)||['updateModalIsolation','useModalLayer'].includes(d.id?.name);
  });
  const code=nodes.map(node=>text.slice(...(node.declaration||node).range)).join('\n');
  const handlers=new Set(),microtasks=[],cleanups=[];const html={};const body={parentElement:html,children:[]};
  const document={documentElement:html,activeElement:null,querySelectorAll:()=>dialogs.filter(node=>node.isConnected),addEventListener(){},removeEventListener(){}};
  const node=(parent,tag='DIV')=>({parentElement:parent,tagName:tag,children:[],inert:false,isConnected:true,getClientRects:()=>[{}],contains(other){return other===this||this.children.some(child=>child.contains(other));},closest(){let n=this;while(n){if(n.inert)return n;n=n.parentElement;}return null;},focus(){document.activeElement=this;},querySelector(){return this.children[0]||null;},querySelectorAll(){return this.children;}});
  const app=node(body);const opener=node(app,'BUTTON');app.children=[opener];document.activeElement=opener;
  const overlayA=node(body),overlayB=node(body);const a=node(overlayA),b=node(overlayB);a.children=[node(a,'BUTTON'),node(a,'BUTTON')];b.children=[node(b,'BUTTON'),node(b,'BUTTON')];overlayA.children=[a];overlayB.children=[b];body.children=[app,overlayA,overlayB];const dialogs=[a,b];
  const useModal=Function('useRef','useEffect','document','window','queueMicrotask',code+'\nreturn useModalLayer;')(value=>({current:value}),fn=>cleanups.push(fn()),document,{addEventListener:(_type,fn)=>handlers.add(fn),removeEventListener:(_type,fn)=>handlers.delete(fn)},fn=>microtasks.push(fn));
  let closed=0;useModal({current:a},()=>{});assert.equal(app.inert,true);assert.equal(document.activeElement,a.children[0]);
  useModal({current:b},()=>closed++);assert.equal(overlayA.inert,true);assert.equal(document.activeElement,b.children[0]);
  const event=key=>({key,defaultPrevented:false,preventDefault(){this.defaultPrevented=true;},stopPropagation(){}});
  document.activeElement=b.children[1];const tab=event('Tab');for(const fn of handlers)fn(tab);assert.equal(document.activeElement,b.children[0]);
  for(const fn of handlers)fn(event('Escape'));assert.equal(closed,1);
  b.isConnected=false;cleanups[1]();microtasks.splice(0).forEach(fn=>fn());assert.equal(overlayA.inert,false);assert.equal(document.activeElement,a.children[0]);
  a.isConnected=false;cleanups[0]();microtasks.splice(0).forEach(fn=>fn());assert.equal(app.inert,false);assert.equal(document.activeElement,opener);
});
