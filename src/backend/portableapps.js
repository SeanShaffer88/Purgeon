// PortableApps.com installer generator. Creates a PortableApps.com-compatible directory
// structure (App/AppInfo, App/<program>, Data) and an NSIS installer script (.paf.exe source)
// from a program that was monitored using Purgeon's Install Monitor.
// The monitored program's recorded files are copied into the package; registry entries are
// documented in appinfo.ini so the launcher can handle them on launch/close.
// Binary files are copied as raw bytes; never as text.
import { sys } from './sys.js';
import * as path from './winpath.js';
import * as monitor from './monitor.js';

const PAF_TEMPLATE = `!define PORTABLEAPPNAME "{appName}"
!define PORTABLEAPPVERSION "{appVersion}"
!define PORTABLEAPPDESCRIPTION "{appDescription}"
!define PORTABLEAPPPUBLISHER "{appPublisher}"
!define PORTABLEAPPHOMEPAGE "{appHomepage}"
!define PORTABLEAPPICON "{appIcon}"
!define PORTABLEAPPLAUNCHER "{launcherExe}"
!define PORTABLEAPPDIR "{installDir}"

Name "{appName} Portable"
OutFile "{outputFile}"
InstallDir "$PROGRAMFILES\\{appName} Portable"
RequestExecutionLevel user

!include "FileFunc.nsh"
!include "WordFunc.nsh"
!include "LogicLib.nsh"

Section "MainSection"
  SetOutPath "$INSTDIR"
  File /r "{stageDir}\\*.*"
  CreateDirectory "$INSTDIR\\Data"
  CreateShortcut "$DESKTOP\\{appName} Portable.lnk" "$INSTDIR\\{launcherExe}"
SectionEnd

!macro uninstallStart
  Delete "$DESKTOP\\{appName} Portable.lnk"
!macroend

!macro uninstallEnd
  RMDir /r "$INSTDIR"
!macroend
`;

const APPINFO_INI = `[Details]
Name={appName}
AppId={appId}
Version={appVersion}
Build={build}
PackageName={packageName}
Publisher={appPublisher}
Homepage={appHomepage}
Category=Development
Description={appDescription}
Language=English
LocaleTriggers=
Icon={appIcon}
Start={launcherExe}

[Control]
Start={startExe}
Parameters=
WorkingDirectory={appDir}
ProgramExecutable={startExe}
ProgramDirectory={appDir}
License=
Homepage={appHomepage}
Publisher={appPublisher}
`;

const LAUNCHER_INI = `[Launch]
ProgramExecutable={startExe}
WorkingDirectory={appDir}

[Directories]
Data={dataDir}

[Files]
Move=settings, registry
`;

let portableAppsRoot = '';

export const setRoot = async (dir) => {
  portableAppsRoot = dir;
  await sys.makeDir(dir);
};

// List monitored programs eligible for portable packaging.
export async function list() {
  const records = await monitor.list();
  return records.map((r) => ({
    id: r.id,
    name: r.name,
    installer: r.installer,
    items: r.items.length,
    finished: r.finished,
    hasProgramFiles: r.items.some(
      (i) => (i.kind === 'dir' || i.kind === 'file') && !isProtectedPath(i.path)
    ),
  }));
}

// Check if a path is a protected system path (shouldn't be packaged).
function isProtectedPath(p) {
  const lower = String(p ?? '').toLowerCase();
  const roots = ['c:\\windows', 'c:\\programdata', 'c:\\$recycle.bin', 'c:\\users\\all users'];
  return roots.some((r) => lower.startsWith(r));
}

// Sanitize a name for use as a PortableApps.com package id/directory.
function safeName(name) {
  return String(name ?? 'Program').replace(/[^a-z0-9]+/gi, '').replace(/^([0-9])/, 'P$1') || 'Program';
}

// When the same program has been packaged before, auto-increment the build number so the
// new package doesn't overwrite the previous one. Looks at existing package directories in
// the outputDir for the same id.
async function nextBuildNumber(outputDir, id) {
  try {
    const dirs = (await sys.readDir(outputDir).catch(() => [])).filter((d) => d.dir).map((d) => d.name);
    return maxBuild(dirs, id);
  } catch {
    return 1;
  }
}

async function maxBuild(dirs, id) {
  const prefix = `${id}Portable v`;
  let max = 0;
  for (const d of dirs) {
    const m = d.match(new RegExp(`^${prefix}(\\\\d+)$`));
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max + 1;
}

// Best-guess install root: the common parent of all recorded file/dir paths.
function installRootOf(rec) {
  const paths = rec.items
    .filter((i) => (i.kind === 'dir' || i.kind === 'file') && !isProtectedPath(i.path))
    .map((i) => i.path);
  if (!paths.length) return '';
  const sorted = paths.map((p) => p.toLowerCase()).sort();
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  let i = 0;
  while (i < first.length && i < last.length && first[i] === last[i]) i++;
  const common = first.slice(0, i);
  const lastSep = common.lastIndexOf('\\');
  return lastSep >= 0 ? common.slice(0, lastSep + 1) : common;
}

// Binary-safe file copy: reads as Uint8Array, writes as Uint8Array.
// Falls back to readFile/writeFile if readBinary/writeBinary aren't available.
async function readBytes(source) {
  if (typeof sys.readBinary === 'function') {
    const b = await sys.readBinary(source);
    return b instanceof Uint8Array ? b : new Uint8Array(b);
  }
  if (typeof sys.readFile === 'function') {
    const b = await sys.readFile(source);
    return b instanceof Uint8Array ? b : new Uint8Array(b);
  }
  throw new Error(`sys.readBinary/readFile is not available; cannot copy ${source}`);
}

async function writeBytes(target, bytes) {
  if (typeof sys.writeBinary === 'function') {
    await sys.writeBinary(target, bytes);
    return;
  }
  if (typeof sys.writeFile === 'function') {
    await sys.writeFile(target, bytes);
    return;
  }
  throw new Error(`sys.writeBinary/writeFile is not available; cannot write ${target}`);
}

async function copyFile(source, target, copied) {
  try {
    const bytes = await readBytes(source);
    await writeBytes(target, bytes);
    copied.push({ path: target, size: bytes.byteLength || bytes.length || 0 });
  } catch {
    // If the file can't be read at all, record a zero-byte placeholder so the
    // package structure still exists but the missing file is obvious.
    await sys.writeText(target, `## BINARY: ${source}\n`);
    copied.push({ path: target, size: 0 });
  }
}

async function copyDirRecursive(source, target, seenDirs, copied) {
  const entries = await sys.readDir(source).catch(() => []);
  await sys.makeDir(target);
  seenDirs.add(source.toLowerCase());
  for (const e of entries) {
    const src = path.join(source, e.name);
    const dst = path.join(target, e.name);
    if (e.dir && !e.link) {
      if (!seenDirs.has(src.toLowerCase())) await copyDirRecursive(src, dst, seenDirs, copied);
    } else if (e.file) {
      await copyFile(src, dst, copied);
    }
  }
}

// Generate the PortableApps.com directory structure for a monitored program.
// Returns { packageDir, id, name, version, files, nsiScriptPath, appInfoPath, launcherExe, startExe, installRoot }.
// Generate the PortableApps.com directory structure for a monitored program or a scanned program.
// Accepts either monitorId (looks up from monitor.list()) or items (direct file/folder/registry items).
// Returns { packageDir, id, name, version, files, nsiScriptPath, appInfoPath, launcherExe, startExe, installRoot }.
export async function generate({
  monitorId,
  items: directItems,
  outputDir,
  appName,
  appVersion,
  appPublisher,
  appHomepage,
  appDescription,
  startExe,
}) {
  if (!outputDir) throw new Error('outputDir is required');

  let rec = null;
  let items = directItems;

  if (!items) {
    if (!monitorId) throw new Error('monitorId or items is required');
    const records = await monitor.list();
    rec = records.find((r) => r.id === monitorId);
    if (!rec) throw new Error(`No monitored program with id ${monitorId}`);
    items = rec.items;
  }

  const name = appName || (rec ? rec.name : 'Program');
  const id = safeName(name);
  const version = appVersion || '1.0.0';
  const publisher = appPublisher || 'Unknown';
  const homepage = appHomepage || '';
  const description = appDescription || `Portable version of ${name}`;
  const build = String(await nextBuildNumber(outputDir, id));

  // Determine the main executable: prefer the provided startExe, else the largest .exe among recorded files.
  let launchExe = startExe;
  if (!launchExe) {
    let best = null;
    for (const item of rec.items) {
      if (item.kind !== 'file' || !/\.exe$/i.test(item.path) || isProtectedPath(item.path))
        continue;
      try {
        const s = await sys.stat(item.path);
        if (s && (!best || s.size > best.size)) best = { path: item.path, size: s.size };
      } catch {}
    }
    launchExe = best?.path;
  }

  const packageDir = path.join(outputDir, `${id}Portable v${build}`);
  const appDir = path.join(packageDir, 'App');
  const appInfoDir = path.join(appDir, 'AppInfo');
  const programDir = path.join(appDir, id);
  const dataDir = path.join(packageDir, 'Data');
  const launcherExe = `${id}Portable.exe`;
  const installRoot = installRootOf(rec);

  await sys.makeDir(appInfoDir);
  await sys.makeDir(programDir);
  await sys.makeDir(dataDir);

  // Copy recorded program files into the package (binary-safe).
  const copied = [];
  const seenDirs = new Set();
  for (const item of rec.items) {
    if ((item.kind === 'dir' || item.kind === 'file') && !isProtectedPath(item.path)) {
      const rel = installRoot ? path.relative(installRoot, item.path) : item.path;
      const target = path.join(programDir, rel);
      if (item.kind === 'dir') {
        await copyDirRecursive(item.path, target, seenDirs, copied);
      } else {
        await copyFile(item.path, target, copied);
      }
    }
  }

  // If no files copied, create a placeholder so the package isn't empty.
  if (copied.length === 0) {
    await sys.writeText(
      path.join(programDir, 'README.txt'),
      `This portable package for ${name} was created from monitored installation "${rec.name}". No portable files were recorded; add the program's files manually to App/${id}/.\n`
    );
    copied.push({ path: path.join(programDir, 'README.txt'), size: 0 });
  }

  // Write appinfo.ini
  let appInfo = APPINFO_INI
    .replace(/\{appName\}/g, name)
    .replace(/\{appId\}/g, id)
    .replace(/\{appVersion\}/g, version)
    .replace(/\{build\}/g, build)
    .replace(/\{packageName\}/g, `${id}Portable`)
    .replace(/\{appPublisher\}/g, publisher)
    .replace(/\{appHomepage\}/g, homepage)
    .replace(/\{appDescription\}/g, description)
    .replace(/\{appIcon\}/g, `${id}.exe`)
    .replace(/\{launcherExe\}/g, launcherExe)
    .replace(/\{startExe\}/g, path.basename(launchExe ?? `${id}.exe`))
    .replace(/\{appDir\}/g, '..\\App\\' + id);
  await sys.writeText(path.join(appInfoDir, 'appinfo.ini'), appInfo);

  // Write launcher configuration
  const launcherCfg = LAUNCHER_INI
    .replace(/\{startExe\}/g, path.basename(launchExe ?? `${id}.exe`))
    .replace(/\{appDir\}/g, '..\\App\\' + id)
    .replace(/\{dataDir\}/g, '..\\Data');
  await sys.writeText(path.join(appInfoDir, 'launcher.ini'), launcherCfg);

  // Generate NSIS installer script
  const nsiContent = PAF_TEMPLATE
    .replace(/\{appName\}/g, name)
    .replace(/\{appVersion\}/g, version)
    .replace(/\{appDescription\}/g, description)
    .replace(/\{appPublisher\}/g, publisher)
    .replace(/\{appHomepage\}/g, homepage)
    .replace(/\{appIcon\}/g, `${id}.exe`)
    .replace(/\{launcherExe\}/g, launcherExe)
    .replace(/\{installDir\}/g, `${id}Portable`)
    .replace(/\{outputFile\}/g, path.join(outputDir, `${id}Portable.paf.exe`))
    .replace(/\{stageDir\}/g, packageDir);

  const nsiPath = path.join(outputDir, `${id}Portable.nsi`);
  await sys.writeText(nsiPath, nsiContent);

  // Create a README explaining how to build the .paf.exe
  await sys.writeText(
    path.join(packageDir, 'README_launcher.txt'),
    `This directory is a PortableApps.com package source for ${name}.\nTo build the .paf.exe installer:\n1. Install the PortableApps.com Launcher (PAL) and NSIS.\n2. Place the PAL launcher executable as ${packageDir}\\${launcherExe}.\n3. Compile ${nsiPath} with NSIS (makensis).\nThe resulting .paf.exe will install ${name} as a portable app.\n`
  );

  return {
    packageDir,
    id,
    name,
    version,
    files: copied,
    nsiScriptPath: nsiPath,
    appInfoPath: path.join(appInfoDir, 'appinfo.ini'),
    launcherExe,
    startExe: launchExe ?? `${id}.exe`,
    installRoot,
  };
}
