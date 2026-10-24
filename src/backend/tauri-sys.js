// The app's system layer: thin calls into the Rust core (src-tauri/src/lib.rs).
import { invoke } from '@tauri-apps/api/core';

export async function createTauriSys() {
  const info = await invoke('sys_info');
  return {
    info: { env: info.env, home: info.home, dataDir: info.data_dir, exe: info.exe },
    runPS: (script, input) => invoke('run_ps', { script, input: input ?? null }),
    exec: (file, args) => invoke('exec', { file, args }),
    runCommandLine: (commandLine) => invoke('run_command_line', { commandLine }),
    launch: (file, args = []) => invoke('launch', { file, args }),
    readDir: (path) => invoke('read_dir', { path }),
    stat: (path) => invoke('stat', { path }),
    exists: (path) => invoke('exists', { path }),
    readText: (path) => invoke('read_text', { path }),
    writeText: (path, contents) => invoke('write_text', { path, contents }),
    makeDir: (path) => invoke('make_dir', { path }),
    removePath: (path) => invoke('remove_path', { path }),
    trash: (path) => invoke('move_to_trash', { path }),
    walk: (roots, maxDirDepth, maxFileDepth) => invoke('walk', { roots, maxDirDepth, maxFileDepth }),
    folderSize: (path, maxEntries, maxMs) => invoke('folder_size', { path, maxEntries, maxMs }),
    quit: () => invoke('quit'),
  };
}
