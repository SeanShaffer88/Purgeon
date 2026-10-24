// The system layer the backend logic runs on. In the app it is the Rust core
// (src-tauri/src/lib.rs, see tauri-sys.js); the tests plug in a Node.js version.
//
// runPS(script, input) -> stdout            exec(file, args) -> { ok, code, stdout, stderr }
// runCommandLine(cmd) -> { ok, code }       launch(file, args)
// readDir(p) -> [{ name, dir, file, link }] stat(p) -> { size, dir, created, modified } | null
// exists(p) / readText(p) / writeText(p, s) / makeDir(p) / removePath(p) / trash(p)
// walk(roots, maxDirDepth, maxFileDepth) -> ['D<path>' | 'F<path>']
// folderSize(p, maxEntries, maxMs) -> { bytes, entries, truncated }
// info: { env, home, dataDir, exe }
export const sys = {};

let lowerEnv = {};

export function setSys(impl) {
  Object.assign(sys, impl);
  lowerEnv = Object.fromEntries(Object.entries(impl.info?.env || {}).map(([k, v]) => [k.toLowerCase(), v]));
}

// Windows environment variables are case-insensitive.
export const env = (name) => lowerEnv[name.toLowerCase()] || '';
export const homeDir = () => sys.info?.home || env('USERPROFILE');
