// Offline coverage accounting only. Never runs the application, tests or a build.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { parse } from 'espree';
import { SourceMapConsumer } from 'source-map-js';

export const metricVersion = 'purgeon-coverage-v2';
// Native metric: unique mapped source lines, independently derived from LLVM segments.
export const hash = (text) => createHash('sha256').update(text).digest('hex');
export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
const digest = (value) => hash(JSON.stringify(canonical(value)));
const slash = (value) => value.replace(/\\/g, '/');
const statementKinds = new Set(['VariableDeclaration','ExpressionStatement','ReturnStatement','ThrowStatement','IfStatement','SwitchStatement','ForStatement','ForInStatement','ForOfStatement','WhileStatement','DoWhileStatement','BreakStatement','ContinueStatement','DebuggerStatement','WithStatement']);
const expressionKinds = new Set(['Literal','ThisExpression','Super','ArrayExpression','ObjectExpression','FunctionExpression','ArrowFunctionExpression','ClassExpression','SequenceExpression','UnaryExpression','UpdateExpression','BinaryExpression','AssignmentExpression','LogicalExpression','ConditionalExpression','NewExpression','CallExpression','MemberExpression','AwaitExpression','YieldExpression','TemplateLiteral','TaggedTemplateExpression','ChainExpression','ImportExpression','SpreadElement','JSXElement','JSXFragment']);

export function executableAnchors(source) {
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module', loc: true, range: true, ecmaFeatures: { jsx: true } });
  const anchors = new Map();
  const starts = lineOffsets(source);
  const add = (offset) => {
    let low = 0, high = starts.length;
    while (low + 1 < high) { const middle = (low + high) >>> 1; if (starts[middle] <= offset) low = middle; else high = middle; }
    const line = low + 1;
    const column = offset - starts[low];
    anchors.set(`${line}:${column}`, { line, column, offset });
  };
  function pattern(node) {
    if (!node) return;
    if (node.type === 'AssignmentPattern') { pattern(node.left); walk(node.right); }
    else if (node.type === 'ObjectPattern') for (const property of node.properties) { if (property.computed) walk(property.key); pattern(property.value || property.argument); }
    else if (node.type === 'ArrayPattern') node.elements.forEach(pattern);
    else if (node.type === 'RestElement') pattern(node.argument);
  }
  function walk(node, parent, key) {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'ImportDeclaration' || node.type === 'ExportAllDeclaration' || node.type === 'ExportSpecifier') return;
    if (node.type === 'ExportNamedDeclaration') { if (node.declaration) walk(node.declaration); return; }
    if (node.type === 'VariableDeclarator') { pattern(node.id); walk(node.init); return; }
    if (['FunctionDeclaration','FunctionExpression','ArrowFunctionExpression'].includes(node.type)) {
      if (expressionKinds.has(node.type) && parent?.type !== 'MethodDefinition' && !(parent?.type === 'Property' && parent.method)) add(node.range[0]);
      node.params.forEach(pattern); walk(node.body); return;
    }
    if (node.type === 'JSXText') { const index = node.raw.search(/\S/); if (index >= 0) add(node.range[0] + index); return; }
    if (node.type === 'JSXClosingElement' || node.type === 'JSXClosingFragment') return;
    if (node.type === 'Identifier') {
      if (key === 'id' || key === 'label' || key === 'params' || key === 'param' || key === 'local' || key === 'exported') return;
      if (parent && ((['Property','MethodDefinition','PropertyDefinition'].includes(parent.type) && key === 'key' && !parent.computed) || parent.type === 'MemberExpression' && key === 'property' && !parent.computed)) return;
      add(node.range[0]); return;
    }
    if (key === 'key' && parent && ['Property','MethodDefinition','PropertyDefinition'].includes(parent.type) && !parent.computed) return;
    if (statementKinds.has(node.type) || expressionKinds.has(node.type) || node.type === 'PropertyDefinition') add(node.range[0]);
    for (const [childKey, value] of Object.entries(node)) {
      if (['loc','range','tokens','comments','parent'].includes(childKey)) continue;
      if (Array.isArray(value)) for (const child of value) walk(child, node, childKey);
      else if (value && typeof value === 'object') walk(value, node, childKey);
    }
  }
  walk(ast);
  return [...anchors.values()].sort((a, b) => a.offset - b.offset);
}

export function rangeHit(functions, offset, length) {
  const containing = [];
  for (const fn of functions) for (const range of fn.ranges || []) {
    const { startOffset: start, endOffset: end, count } = range;
    if (![start,end,count].every(Number.isInteger) || start < 0 || end < start || end > length || count < 0) throw new Error('Invalid V8 UTF-16 range');
    if (start <= offset && offset < end) containing.push({ span: end - start, count });
  }
  if (!containing.length) return null;
  const smallest = Math.min(...containing.map((range) => range.span));
  return containing.filter((range) => range.span === smallest).every((range) => range.count > 0);
}

export function inventory(root) {
  const found = [];
  const descend = (folder, language) => {
    if (!fs.existsSync(folder)) return;
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const filename = path.join(folder, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Production source link is not allowed: ${filename}`);
      if (entry.isDirectory()) descend(filename, language);
      else if (entry.isFile() && (language === 'javascript' ? /\.(js|jsx)$/.test(entry.name) : /\.rs$/.test(entry.name))) found.push({ path: slash(path.relative(root, filename)), language });
    }
  };
  descend(path.join(root, 'src'), 'javascript');
  descend(path.join(root, 'packages', 'purgeon-core', 'src'), 'javascript');
  descend(path.join(root, 'src-tauri', 'src'), 'rust');
  for (const filename of ['build.rs','build_support.rs']) if (fs.existsSync(path.join(root, 'src-tauri', filename))) found.push({ path: `src-tauri/${filename}`, language: 'rust' });
  return found.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
const coreFor = (file, language) => language === 'javascript' ? (file.startsWith('src/backend/') || file.startsWith('packages/purgeon-core/src/')) || ['src/cli.js','src/cli-args.js'].includes(file) : file.startsWith('src-tauri/src/') && file !== 'src-tauri/src/main.rs';

// Deliberately narrow lexical proof, not a Rust parser. Only whole top-level
// #[cfg(test)] mod NAME { ... } spans may be excluded; ambiguity retains lines.
export function rustTestModules(source) {
  const tokens = [];
  let index = 0, line = 1;
  const consume = (end) => { line += (source.slice(index,end).match(/\n/g) || []).length; index = end; };
  while (index < source.length) {
    const tail = source.slice(index);
    if (/^\s/.test(tail)) { consume(index+1); continue; }
    if (tail.startsWith('//')) { const end = source.indexOf('\n',index); consume(end < 0 ? source.length : end); continue; }
    if (tail.startsWith('/*')) {
      let end = index+2, nesting = 1;
      while (end < source.length && nesting) { if (source.startsWith('/*',end)) { nesting++; end+=2; } else if (source.startsWith('*/',end)) { nesting--; end+=2; } else end++; }
      if (nesting) throw new Error('Unterminated Rust comment');
      consume(end); continue;
    }
    const raw = tail.match(/^(?:br|cr|r)(#{0,255})"/);
    if (raw) { const end = source.indexOf('"'+raw[1],index+raw[0].length); if (end < 0) throw new Error('Unterminated Rust raw string'); consume(end+1+raw[1].length); continue; }
    if (tail[0] === '"') {
      let end = index+1;
      for (; end < source.length; end++) { if (source[end] === '\\') end++; else if (source[end] === '"') break; }
      if (end >= source.length) throw new Error('Unterminated Rust string');
      consume(end+1); continue;
    }
    if (tail[0] === "'") {
      const character = tail.match(/^'(?:\\(?:u\{[a-fA-F0-9_]+\}|x[a-fA-F0-9]{2}|[^\r\n])|[^'\\\r\n])'/u);
      if (character) { consume(index+character[0].length); continue; }
      const lifetime = tail.match(/^'[A-Za-z_][A-Za-z0-9_]*/);
      if (lifetime) { consume(index+lifetime[0].length); continue; }
      throw new Error('Ambiguous Rust character/lifetime syntax');
    }
    if (source.charCodeAt(index) > 127) throw new Error('Unsupported non-ASCII Rust token outside literals');
    const word = tail.match(/^[A-Za-z_][A-Za-z0-9_]*/);
    const value = word ? word[0] : source[index];
    tokens.push({value,start:index,line});
    consume(index+value.length);
  }
  const spans = [];
  let depth = 0;
  for (let cursor = 0; cursor < tokens.length; cursor++) {
    const token = tokens[cursor];
    if (depth === 0 && tokens.slice(cursor,cursor+8).map((item) => item.value).join(' ') === '# [ cfg ( test ) ] mod') {
      const name = tokens[cursor+8], open = tokens[cursor+9];
      if (!name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name.value) || open?.value !== '{') continue;
      let end = cursor+10, nesting = 1;
      for (; end < tokens.length && nesting; end++) { if (tokens[end].value === '{') nesting++; else if (tokens[end].value === '}') nesting--; }
      if (nesting) throw new Error('Unbalanced Rust test module');
      const close = tokens[end-1];
      const previous = tokens[cursor-1], next = tokens[end];
      if (previous?.line === token.line || next?.line === close.line) throw new Error('Test exclusion shares a source line with other code');
      spans.push({start:token.line,end:close.line,reason:'cfg(test)'});
    }
    if (token.value === '{') depth++;
    else if (token.value === '}') { depth--; if (depth < 0) throw new Error('Unbalanced Rust braces'); }
  }
  if (depth !== 0) throw new Error('Unbalanced Rust braces');
  return spans;
}
export function sourceTreeHash(files, externalScripts = []) {
  return digest({ metricVersion, externalScripts: [...externalScripts].sort((a,b) => (a.url+'|'+a.sha256) < (b.url+'|'+b.sha256) ? -1 : (a.url+'|'+a.sha256) > (b.url+'|'+b.sha256) ? 1 : 0), files: files.map((file) => ({ path: file.path, sha256: file.sha256, language: file.language, core: file.core, excludedRanges: [...(file.excludedRanges || [])].sort((a,b) => a.start-b.start || a.end-b.end) })).sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) });
}
function checkManifest(manifest) {
  if (manifest.schemaVersion !== 1 || !path.isAbsolute(manifest.sourceRoot) || !Array.isArray(manifest.files)) throw new Error('Invalid frozen manifest');
  for (const script of manifest.externalScripts || []) if (!script || typeof script.url !== 'string' || !script.url || script.url.length > 2048 || script.url.includes('*') || !/^[a-f0-9]{64}$/.test(script.sha256 || '') || !['tauri-runtime','webview-runtime','vendor'].includes(script.reason)) throw new Error('Invalid frozen external runtime exclusion');
  const actual = inventory(manifest.sourceRoot);
  if (manifest.files.length !== actual.length) throw new Error('Manifest must enumerate every production source file');
  const entries = new Map();
  for (const file of manifest.files) {
    if (typeof file.path !== 'string' || slash(file.path) !== file.path || file.path.split('/').some((part) => !part || part === '.' || part === '..') || entries.has(file.path)) throw new Error('Invalid or duplicate manifest path');
    const expected = actual.find((item) => item.path === file.path);
    if (!expected || expected.language !== file.language || file.core !== coreFor(file.path, file.language)) throw new Error(`Incorrect source/core membership: ${file.path}`);
    const bytes = fs.readFileSync(path.join(manifest.sourceRoot, file.path));
    if (hash(bytes) !== file.sha256) throw new Error(`Source hash changed: ${file.path}`);
    const source = bytes.toString('utf8');
    const lines = source.split('\n').length;
    for (const range of file.excludedRanges || []) if (file.language !== 'rust' || range.reason !== 'cfg(test)' || !Number.isInteger(range.start) || !Number.isInteger(range.end) || range.start < 1 || range.end < range.start || range.end > lines) throw new Error(`Invalid reviewed exclusion: ${file.path}`);
    if (file.excludedRanges?.length) {
      const proven = rustTestModules(source);
      for (const range of file.excludedRanges) if (!proven.some((span) => span.start === range.start && span.end === range.end)) throw new Error(`Exclusion is not a whole top-level cfg(test) module: ${file.path}`);
    }
    const anchors = file.language === 'javascript' ? executableAnchors(source) : [];
    entries.set(file.path, { ...file, source, anchors, hits: new Set(), nativeLines: null });
  }
  if (sourceTreeHash(manifest.files,manifest.externalScripts || []) !== manifest.sourceTreeHash) throw new Error('Frozen source-tree hash mismatch');
  return entries;
}
function lineOffsets(source) {
  const starts = [0];
  for (let index = 0; index < source.length; index++) if (source[index] === '\n') starts.push(index + 1);
  return starts;
}
function artifactReader(provenance) {
  return (filename) => {
    if (!path.isAbsolute(filename)) throw new Error('Artifact paths must be absolute');
    const bytes = fs.readFileSync(filename);
    provenance.set(filename, { path: filename, sha256: hash(bytes), bytes: bytes.length });
    return bytes;
  };
}
function mappedSource(root, mapPath, source) {
  if (source.startsWith('file:')) return slash(path.relative(root, fileURLToPath(source)));
  if (/^[a-z]+:/i.test(source) && !path.isAbsolute(source)) return null;
  return slash(path.relative(root, path.resolve(path.dirname(mapPath), source)));
}
function applyJavascript(run, entries, root, read, reasons, scriptIdentities, externalScripts) {
  const artifacts = run.artifacts;
  if (!Array.isArray(artifacts?.coverageFiles) || !Array.isArray(artifacts?.scriptFiles)) throw new Error('Invalid JavaScript artifact inventory');
  const raws = artifacts.coverageFiles.map((filename) => { const raw = JSON.parse(read(filename)); if (!Array.isArray(raw.result)) throw new Error('Invalid raw V8 coverage'); return raw; });
  const loaded = new Set(raws.flatMap((raw) => raw.result.map((script) => script.url)));
  const scripts = new Map();
  for (const descriptor of artifacts.scriptFiles) {
    if (!loaded.has(descriptor.url)) continue;
    if (scripts.has(descriptor.url) || !path.isAbsolute(descriptor.sourcePath)) throw new Error('Duplicate or invalid generated script descriptor');
    const identity = JSON.stringify([descriptor.sourceSha256,descriptor.mapSha256 || null]);
    if (scriptIdentities.has(descriptor.url) && scriptIdentities.get(descriptor.url) !== identity) throw new Error('Conflicting script or map bytes across compatible runs');
    scriptIdentities.set(descriptor.url,identity);
    const bytes = read(descriptor.sourcePath);
    if (hash(bytes) !== descriptor.sourceSha256) throw new Error('Runtime script hash differs from frozen descriptor');
    const source = bytes.toString('utf8');
    const direct = slash(path.relative(root, descriptor.sourcePath));
    const locations = new Map();
    if (descriptor.scope && !['production','external'].includes(descriptor.scope)) throw new Error('Invalid script scope');
    if (descriptor.scope === 'external') {
      if (entries.has(direct)) throw new Error('Production source cannot be excluded as external');
      if (descriptor.mapPath) {
        const mapBytes = read(descriptor.mapPath);
        if (hash(mapBytes) !== descriptor.mapSha256) throw new Error('External source-map hash differs');
        const consumer = new SourceMapConsumer(JSON.parse(mapBytes));
        if (!consumer.sources.length) throw new Error('External vendor map has no verified sources');
        for (const mapped of consumer.sources) {
          const relative = mappedSource(root,descriptor.mapPath,mapped);
          if (!relative || entries.has(relative) || !relative.startsWith('node_modules/')) throw new Error('Mixed or unverifiable external chunk');
          const actualPath = path.join(root,relative);
          const nodeModulesRoot = fs.realpathSync(path.join(root,'node_modules'));
          const actual = fs.realpathSync(actualPath);
          if (!actual.startsWith(nodeModulesRoot+path.sep)) throw new Error('External vendor source escapes actual node_modules');
          const content = consumer.sourceContentFor(mapped,true);
          if (content === null || hash(read(actualPath)) !== hash(content)) throw new Error('External vendor source bytes differ');
        }
      } else if (!externalScripts.some((script) => script.url === descriptor.url && script.sha256 === descriptor.sourceSha256)) throw new Error('External runtime lacks exact frozen URL/hash review');
      scripts.set(descriptor.url,{source,locations,external:true});
      continue;
    }
    if (descriptor.mapPath) {
      const mapBytes = read(descriptor.mapPath);
      if (hash(mapBytes) !== descriptor.mapSha256) throw new Error('Source-map hash differs');
      const map = JSON.parse(mapBytes);
      if (map.sections) throw new Error('Indexed source maps require explicit flattening evidence');
      const consumer = new SourceMapConsumer(map);
      const seen = new Set();
      for (const mapped of consumer.sources) {
        const relative = mappedSource(root, descriptor.mapPath, mapped);
        if (!relative || !entries.has(relative)) continue;
        if (seen.has(relative)) throw new Error('Duplicate source-map source entries are ambiguous');
        seen.add(relative);
        const content = consumer.sourceContentFor(mapped, true);
        if (content === null || hash(content) !== entries.get(relative).sha256) throw new Error(`Source-map source bytes differ or are absent: ${relative}`);
      }
      const offsets = lineOffsets(source);
      consumer.eachMapping((mapping) => {
        if (!mapping.source || mapping.originalLine == null) return;
        const relative = mappedSource(root, descriptor.mapPath, mapping.source);
        if (!relative || !entries.has(relative)) return;
        const lineStart = offsets[mapping.generatedLine - 1];
        const lineEnd = mapping.generatedLine < offsets.length ? offsets[mapping.generatedLine] - 1 : source.length;
        const offset = lineStart + mapping.generatedColumn;
        if (!Number.isInteger(lineStart) || !Number.isInteger(mapping.generatedColumn) || mapping.generatedColumn < 0 || offset >= lineEnd || offset < lineStart) throw new Error('Source-map generated location out of line bounds');
        const originalStarts = lineOffsets(entries.get(relative).source);
        const originalStart = originalStarts[mapping.originalLine - 1];
        const originalEnd = mapping.originalLine < originalStarts.length ? originalStarts[mapping.originalLine] - 1 : entries.get(relative).source.length;
        if (!Number.isInteger(originalStart) || !Number.isInteger(mapping.originalColumn) || mapping.originalColumn < 0 || originalStart + mapping.originalColumn > originalEnd) throw new Error('Source-map original location out of line bounds');
        const key = `${relative}:${mapping.originalLine}:${mapping.originalColumn}`;
        if (!locations.has(key)) locations.set(key, []);
        locations.get(key).push(offset);
      });
      for (const relative of seen) for (const anchor of entries.get(relative).anchors) if (!locations.has(`${relative}:${anchor.line}:${anchor.column}`)) reasons.push(`${run.id}: unmapped executable anchor ${relative}:${anchor.line}:${anchor.column}`);
    } else if (entries.get(direct)?.language === 'javascript' && hash(bytes) === entries.get(direct).sha256) {
      for (const anchor of entries.get(direct).anchors) locations.set(`${direct}:${anchor.line}:${anchor.column}`, [anchor.offset]);
    } else throw new Error(`Loaded production script requires a verified source map: ${descriptor.url}`);
    scripts.set(descriptor.url, { source, locations });
  }
  for (const raw of raws) {
    for (const script of raw.result) {
      const descriptor = scripts.get(script.url);
      if (!descriptor) {
        let unknownProduction = false;
        if (script.url.startsWith('file:')) { try { unknownProduction = entries.has(slash(path.relative(root,fileURLToPath(script.url)))); } catch { /* Not a valid local production source. */ } }
        if (unknownProduction || run.kind === 'webview-v8' && /^(https?|tauri):/.test(script.url)) reasons.push(`${run.id}: missing descriptor for loaded script ${script.url}`);
        continue;
      }
      if (!Array.isArray(script.functions)) throw new Error('Missing detailed V8 functions');
      for (const fn of script.functions) if (!descriptor.external && fn.isBlockCoverage !== true && fn.ranges?.some((range) => range.count > 0)) reasons.push(`${run.id}: positive function-only V8 coverage is not detailed: ${script.url}`);
      for (const [key, offsets] of descriptor.locations) {
        const hits = offsets.map((offset) => rangeHit(script.functions, offset, descriptor.source.length));
        if (hits.some((hit) => hit === null)) reasons.push(`${run.id}: V8 gap at ${key}`);
        if (hits.some((hit) => hit === true)) {
          const position = key.match(/^(.*):(\d+):(\d+)$/);
          entries.get(position[1]).hits.add(Number(position[2]));
        }
      }
    }
  }
}

function fileDigest(filename) {
  const handle = fs.openSync(filename,'r');
  const digest = createHash('sha256'), chunk = Buffer.alloc(65536);
  try { let count; while ((count = fs.readSync(handle,chunk,0,chunk.length,null))) digest.update(chunk.subarray(0,count)); }
  finally { fs.closeSync(handle); }
  return digest.digest('hex');
}
function exportNative(artifacts, tool, sources) {
  if (!path.isAbsolute(tool || '')) throw new Error('An explicit configured absolute --llvm-cov path is required');
  const inputs = [artifacts.profdataPath,...artifacts.objects.map((object) => object.path),tool];
  const before = inputs.map((filename) => ({path:filename,sha256:fileDigest(filename)}));
  const objects = [...artifacts.objects].sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const base = ['export',objects[0].path,`-instr-profile=${artifacts.profdataPath}`,...objects.slice(1).map((object) => `-object=${object.path}`),...sources];
  const calls = [base,[...base,'-format=lcov']].map((args) => {
    const result = spawnSync(tool,args,{encoding:'utf8',windowsHide:true,timeout:60000,maxBuffer:128*1024*1024});
    if (result.error || result.status !== 0) throw new Error(`llvm-cov export failed (${result.status}): ${result.error?.message || result.stderr}`);
    return {args,exitCode:result.status,stdout:result.stdout,stdoutSHA256:hash(result.stdout)};
  });
  const after = inputs.map((filename) => ({path:filename,sha256:fileDigest(filename)}));
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Native tool/profile/object bytes changed during export');
  return {json:calls[0].stdout,lcov:calls[1].stdout,provenance:{tool,inputs:before,calls:calls.map(({stdout,...call}) => call)}};
}

// LLVM 23 LineCoverageStats / LineCoverageIterator, not interval union:
// https://github.com/llvm/llvm-project/blob/release/23.x/llvm/lib/ProfileData/Coverage/CoverageMapping.cpp#L1447
// Keep segment order (including LLVM's preceding-uncounted same-location exception).
export function nativeSegmentLines(segments, source) {
  if (!Array.isArray(segments)) throw new Error('Missing LLVM segments');
  const sourceLines = source.split('\n');
  let previous;
  for (const segment of segments) {
    if (!Array.isArray(segment) || segment.length !== 6 ||
        !segment.slice(0,3).every((n) => Number.isSafeInteger(n) && n >= 0) ||
        !segment.slice(3).every((flag) => typeof flag === 'boolean') ||
        segment[0] < 1 || segment[0] > sourceLines.length || segment[1] < 1 ||
        segment[1] > Buffer.byteLength(sourceLines[segment[0]-1]) + 1 ||
        (!segment[3] && segment[2] !== 0)) throw new Error('Invalid LLVM segment');
    if (previous && (segment[0] < previous[0] || segment[0] === previous[0] &&
        (segment[1] < previous[1] || segment[1] === previous[1] && previous[3]))) throw new Error('Invalid LLVM segment ordering');
    previous = segment;
  }
  const result = new Map();
  if (!segments.length) return result;
  let next = 0, wrapped;
  for (let line = segments[0][0]; next < segments.length; line++) {
    const group = [];
    while (next < segments.length && segments[next][0] === line) group.push(segments[next++]);
    const starts = group.filter((s) => s[3] && s[4] && !s[5]);
    const skipped = group.length && !group[0][3] && group[0][4];
    const mapped = (!skipped && (wrapped?.[3] || starts.length > 0)) || group.some((s) => s[3] && s[4]);
    if (mapped) {
      let count = wrapped?.[2] ?? 0;
      for (const segment of starts) count = Math.max(count,segment[2]);
      result.set(line,count);
    }
    if (group.length) wrapped = group.at(-1);
  }
  return result;
}

export function validateNativeExports(jsonText, lcovText, entries, root) {
  const llvm = JSON.parse(jsonText);
  if (llvm.type !== 'llvm.coverage.json.export' || llvm.version !== '3.1.0' || !Array.isArray(llvm.data)) throw new Error('Invalid llvm-cov JSON');
  const identities = new Map([...entries.keys()].map((name) => [path.resolve(root,name).toLowerCase(),name]));
  const sourceName = (filename) => {
    if (typeof filename !== 'string' || !path.isAbsolute(filename)) throw new Error('Invalid native source path');
    return identities.get(path.resolve(filename).toLowerCase()) ?? slash(path.relative(root,path.resolve(filename)));
  };
  if (llvm.data.some((group) => !group || !Array.isArray(group.files))) throw new Error('Invalid llvm-cov file group');
  const jsonFiles = new Map();
  for (const group of llvm.data) for (const file of group.files) {
    const relative = sourceName(file.filename);
    if (!entries.has(relative)) continue;
    if (jsonFiles.has(relative)) throw new Error('Duplicate LLVM source records');
    jsonFiles.set(relative, file);
  }
  let current = null;
  const lcov = new Map();
  const summaries = new Map();
  for (const line of lcovText.split(/\r?\n/)) {
    if (line.startsWith('SF:')) {
      if (current !== null) throw new Error('Unterminated LCOV source record');
      current = sourceName(line.slice(3));
      if (!entries.has(current)) continue;
      if (lcov.has(current)) throw new Error('Duplicate LCOV source records');
      lcov.set(current, new Map());
      summaries.set(current, {});
    } else if (line.startsWith('DA:') && lcov.has(current)) {
      const match = line.match(/^DA:(\d+),(\d+)(?:,[^,]+)?$/);
      if (!match) throw new Error('Invalid LCOV line counter');
      const number = Number(match[1]);
      if (!Number.isSafeInteger(number) || !Number.isSafeInteger(Number(match[2])) || number < 1 || number > entries.get(current).source.split('\n').length || lcov.get(current).has(number)) throw new Error('Invalid or duplicate LCOV executable line');
      lcov.get(current).set(number, Number(match[2]));
    } else if (/^(LF|LH):/.test(line) && lcov.has(current)) {
      const match = line.match(/^(LF|LH):(\d+)$/);
      if (!match || !Number.isSafeInteger(Number(match[2])) || Object.hasOwn(summaries.get(current), match[1])) throw new Error('Invalid or duplicate LCOV line summary');
      summaries.get(current)[match[1]] = Number(match[2]);
    } else if (line === 'end_of_record') {
      if (current === null) throw new Error('Unexpected LCOV record terminator');
      current = null;
    } else if (/^(DA|LF|LH):/.test(line) && current === null) throw new Error('LCOV line data outside source record');
  }
  if (current !== null) throw new Error('Unterminated LCOV source record');

  const result = new Map();
  for (const [relative, file] of entries) {
    if (file.language !== 'rust') continue;
    const jsonFile = jsonFiles.get(relative), lines = lcov.get(relative);
    if (!jsonFile && !lines) continue;
    if (!jsonFile || !lines) throw new Error(`Missing native source record: ${relative}`);
    const summary = jsonFile.summary?.lines;
    if (!summary || !Number.isSafeInteger(summary.count) || !Number.isSafeInteger(summary.covered) || summary.count < 0 || summary.covered < 0 || summary.covered > summary.count) throw new Error(`Invalid LLVM line summary: ${relative}`);
    const header = summaries.get(relative);
    if (!Number.isSafeInteger(header.LF) || !Number.isSafeInteger(header.LH)) throw new Error(`Missing LCOV line summary: ${relative}`);
    if (header.LF !== summary.count || header.LH !== summary.covered) throw new Error(`LLVM JSON/LCOV line summary mismatch: ${relative}`);
    const derived = nativeSegmentLines(jsonFile.segments,file.source);
    if (derived.size !== lines.size || [...derived].some(([line,count]) => lines.get(line) !== count)) throw new Error(`LLVM segment/LCOV line counter mismatch: ${relative}`);
    result.set(relative,{lines:derived,aggregate:{count:summary.count,covered:summary.covered},unique:{count:derived.size,covered:[...derived.values()].filter((n) => n > 0).length}});
  }
  return result;
}

function applyNative(run, entries, root, read, reasons, options, exports) {
  const artifacts = run.artifacts || {};
  let owned;
  try {
    if (!path.isAbsolute(artifacts.profdataPath || '') || !Array.isArray(artifacts.objects) || !artifacts.objects.length) throw new Error('Actual profdata and covered object inputs are required');
    if (fileDigest(artifacts.profdataPath) !== artifacts.profdataSha256) throw new Error('Actual merged profile hash differs');
    const names = new Set();
    for (const object of artifacts.objects) {
      if (!path.isAbsolute(object.path || '') || names.has(object.path) || fileDigest(object.path) !== object.sha256) throw new Error('Invalid or changed covered native object');
      names.add(object.path);
    }
    owned = (options.exportNative || exportNative)(artifacts,options.llvmCovPath,[...entries].filter(([,file]) => file.language === 'rust').map(([relative]) => path.resolve(root,relative)));
    exports.push({runId:run.id,...owned.provenance,jsonSHA256:hash(owned.json),lcovSHA256:hash(owned.lcov)});
    for (const filename of [artifacts.jsonPath,artifacts.lcovPath].filter(Boolean)) read(filename);
  } catch (error) { reasons.push(`${run.id}: native derivation incomplete: ${error.message}`); return; }
  const validated = validateNativeExports(owned.json, owned.lcov, entries, root);
  exports.at(-1).lineDiagnostics = [...validated].map(([filename,record]) => ({filename,aggregate:record.aggregate,unique:record.unique}));
  for (const [relative, file] of entries) {
    if (file.language !== 'rust') continue;
    const record = validated.get(relative);
    if (!record) { reasons.push(`${run.id}: native denominator unknown for ${relative}`); continue; }
    const lines = record.lines;
    const mapped = [...lines.keys()].sort((a,b) => a-b);
    if (file.nativeMappedLines && JSON.stringify(file.nativeMappedLines) !== JSON.stringify(mapped)) throw new Error('Native executable denominator changed across runs');
    file.nativeMappedLines = mapped;
    const excluded = (line) => (file.excludedRanges || []).some((range) => range.start <= line && line <= range.end);
    const included = [...lines.keys()].filter((line) => !excluded(line)).sort((a,b) => a-b);
    if (file.nativeLines && JSON.stringify(file.nativeLines) !== JSON.stringify(included)) throw new Error('Native executable denominator changed across runs');
    file.nativeLines = included;
    for (const line of included) if (lines.get(line) > 0) file.hits.add(line);
  }
}

export function reportCoverage(manifest, evidence, options = {}) {
  const entries = checkManifest(manifest);
  if (evidence.schemaVersion !== 1 || evidence.sourceTreeHash !== manifest.sourceTreeHash || evidence.instrumentationId !== manifest.instrumentationId || !Array.isArray(evidence.runs)) throw new Error('Coverage provenance does not match frozen manifest');
  const settings = evidence.instrumentation;
  if (!settings || settings.metricVersion !== metricVersion || settings.target !== 'x86_64-pc-windows-msvc' || !['precise','detailed','sourceMaps','productionMode'].every((key) => settings.jsFlags?.[key] === true) || !Array.isArray(settings.nativeFlags) || digest(settings) !== evidence.instrumentationId || manifest.instrumentation && digest(manifest.instrumentation) !== evidence.instrumentationId) throw new Error('Invalid or mismatched instrumentation settings');
  const reasons = [];
  const provenance = new Map();
  const read = artifactReader(provenance);
  const ids = new Set();
  const scriptIdentities = new Map();
  const nativeExports = [];
  for (const run of evidence.runs) {
    if (!run.id || ids.has(run.id) || run.sourceTreeHash !== manifest.sourceTreeHash || run.instrumentationId !== manifest.instrumentationId) throw new Error('Incompatible or duplicate evidence run');
    ids.add(run.id);
    if (run.kind === 'node-v8' || run.kind === 'webview-v8') {
      if (!(run.kind === 'node-v8' ? settings.nodeVersion : settings.webviewVersion)) throw new Error('Collected runtime version is required');
      applyJavascript(run, entries, manifest.sourceRoot, read, reasons, scriptIdentities, manifest.externalScripts || []);
    } else if (run.kind === 'native-llvm') {
      if (!settings.rustVersion || !settings.llvmVersion) throw new Error('Collected native compiler versions are required');
      applyNative(run, entries, manifest.sourceRoot, read, reasons, options, nativeExports);
    } else throw new Error('Unsupported evidence run kind');
  }
  const files = [...entries.values()].map((file) => {
    const lines = file.language === 'javascript' ? [...new Set(file.anchors.map((anchor) => anchor.line))].sort((a,b) => a-b) : file.nativeLines;
    if (lines === null) reasons.push(`Native denominator unknown: ${file.path}`);
    const covered = lines?.filter((line) => file.hits.has(line)) || [];
    return { path: file.path, language: file.language, core: file.core, executableLines: lines, coveredLines: covered, uncoveredLines: lines?.filter((line) => !file.hits.has(line)) ?? null, percent: lines === null ? null : lines.length ? covered.length / lines.length * 100 : 100 };
  });
  const languages = {};
  for (const language of ['javascript','rust']) {
    languages[language] = {};
    for (const [name, core, floor] of [['overall',false,70],['core',true,85]]) {
      const selected = files.filter((file) => file.language === language && (!core || file.core));
      const unknown = selected.some((file) => file.executableLines === null);
      const denominator = unknown ? null : selected.reduce((sum,file) => sum+file.executableLines.length,0);
      const covered = selected.reduce((sum,file) => sum+file.coveredLines.length,0);
      const percent = denominator === null ? null : denominator ? covered/denominator*100 : 100;
      languages[language][name] = { executableLines: denominator, coveredLines: covered, percent, floor, pass: percent !== null && percent >= floor };
    }
  }
  const incompleteReasons = [...new Set(reasons)];
  const verdict = incompleteReasons.length ? 'incomplete' : Object.values(languages).every((language) => language.core.pass && language.overall.pass) ? 'pass' : 'below-floor';
  return { schemaVersion: 1, metricVersion, sourceTreeHash: manifest.sourceTreeHash, instrumentationId: manifest.instrumentationId, instrumentation: settings, runs: evidence.runs.map((run) => ({id:run.id,kind:run.kind,profileSetHash:run.artifacts?.profileSetHash ?? null})), metric: 'Unique AST executable source lines; native unique mapped source lines derived from LLVM segments and crosschecked with LCOV DA', files, languages, incompleteReasons, verdict, exitCode: verdict === 'pass' ? 0 : verdict === 'below-floor' ? 1 : 2, provenance: [...provenance.values()], nativeExports, provenanceLimits: ['Artifact hashes verify supplied bytes, not that a collector executed the claimed workload.', 'Native line exports are derived read-only from hashed profile and object inputs.'] };
}

function outputOverwrites(output, inputs) {
  const normalized = (filename) => {
    const resolved = fs.existsSync(filename) ? fs.realpathSync(filename) : path.resolve(filename);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  const destination = normalized(output);
  const existing = fs.existsSync(output) ? fs.statSync(output, { bigint:true }) : null;
  return inputs.some((filename) => {
    if (normalized(filename) === destination) return true;
    const input = existing && fs.existsSync(filename) ? fs.statSync(filename, { bigint:true }) : null;
    return input && input.dev === existing.dev && input.ino === existing.ino;
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let output;
  let outputAllowed = false;
  try {
    const args = process.argv.slice(2);
    if (![6,8].includes(args.length) || new Set(args.filter((_,index) => index%2===0)).size !== args.length/2 || !['--manifest','--evidence','--out'].every((flag) => args.includes(flag)) || args.filter((_,index) => index%2===0).some((flag) => !['--manifest','--evidence','--out','--llvm-cov'].includes(flag))) throw new Error('Use --manifest <file> --evidence <file> --out <file> [--llvm-cov <configured absolute tool>]');
    const value = (flag) => args.includes(flag) ? args[args.indexOf(flag)+1] : undefined;
    output = value('--out');
    const manifest = JSON.parse(fs.readFileSync(value('--manifest'),'utf8'));
    const evidence = JSON.parse(fs.readFileSync(value('--evidence'),'utf8'));
    const artifactPaths = (evidence.runs || []).flatMap((run) => { const artifacts = run.artifacts || {}; return [...(artifacts.coverageFiles || []), ...(artifacts.scriptFiles || []).flatMap((file) => [file.sourcePath,file.mapPath].filter(Boolean)), ...[artifacts.jsonPath,artifacts.lcovPath,artifacts.profdataPath].filter(Boolean), ...(artifacts.objects || []).map((object) => object.path)]; });
    const protectedPaths = [value('--manifest'),value('--evidence'),value('--llvm-cov'), ...artifactPaths, ...(manifest.files || []).map((file) => path.resolve(manifest.sourceRoot,file.path))].filter(Boolean);
    if (outputOverwrites(output,protectedPaths)) { output = undefined; throw new Error('Report output would overwrite source or evidence'); }
    outputAllowed = true;
    const report = reportCoverage(manifest,evidence,{llvmCovPath:value('--llvm-cov')});
    report.inputs = [value('--manifest'),value('--evidence')].map((filename) => ({path:path.resolve(filename),sha256:hash(fs.readFileSync(filename))}));
    outputAllowed = false;
    const protectedInputs = [...protectedPaths, ...report.provenance.map((file) => file.path), ...report.nativeExports.flatMap((native) => native.inputs.map((file) => file.path))];
    if (outputOverwrites(output,protectedInputs)) { output = undefined; throw new Error('Report output would overwrite source or evidence'); }
    outputAllowed = true;
    fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'w'});
    process.exitCode = report.exitCode;
  } catch (error) {
    const report = { schemaVersion:1,metricVersion,verdict:'invalid',incompleteReasons:[error.message],exitCode:2 };
    if (output && outputAllowed) fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');
    else process.stderr.write(error.message+'\n');
    process.exitCode = 2;
  }
}
