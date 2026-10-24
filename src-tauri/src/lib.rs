// SweepUninstall's native core: a few small, general system commands. The uninstall,
// scan, backup, debloat and startup logic lives in src/backend (JavaScript) and is built
// on these.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use std::fs;
use std::io::Write;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, UNIX_EPOCH};
use tauri::Manager;

mod snapshot;
mod tracker;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Serialize)]
struct ExecResult {
    ok: bool,
    code: i32,
    stdout: String,
    stderr: String,
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

/// Runs a PowerShell script (Windows PowerShell 5.1, always present) with optional stdin.
/// Fails with stderr when the script exits with an error.
#[tauri::command]
async fn run_ps(script: String, input: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let wrapped = format!("$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.Encoding]::UTF8;{script}");
        let utf16: Vec<u8> = wrapped.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
        let mut child = Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", &STANDARD.encode(utf16)])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| e.to_string())?;
        if let Some(mut stdin) = child.stdin.take() {
            if let Some(data) = input {
                let _ = stdin.write_all(data.as_bytes());
            }
        }
        let out = child.wait_with_output().map_err(|e| e.to_string())?;
        if out.status.success() {
            Ok(text(&out.stdout))
        } else {
            let err = text(&out.stderr);
            Err(if err.trim().is_empty() { format!("PowerShell exited with {}", out.status) } else { err })
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Runs a program directly (no shell), e.g. reg.exe, sc.exe or net.exe.
#[tauri::command]
async fn exec(file: String, args: Vec<String>) -> ExecResult {
    tauri::async_runtime::spawn_blocking(move || match Command::new(&file).args(&args).creation_flags(CREATE_NO_WINDOW).output() {
        Ok(o) => ExecResult { ok: o.status.success(), code: o.status.code().unwrap_or(-1), stdout: text(&o.stdout), stderr: text(&o.stderr) },
        Err(e) => ExecResult { ok: false, code: -1, stdout: String::new(), stderr: e.to_string() },
    })
    .await
    .unwrap_or(ExecResult { ok: false, code: -1, stdout: String::new(), stderr: "task failed".into() })
}

/// Runs an uninstall command line exactly as stored in the registry (through cmd, as Windows
/// does) and waits for it. The uninstaller's own windows still appear.
#[tauri::command]
async fn run_command_line(command_line: String) -> ExecResult {
    tauri::async_runtime::spawn_blocking(move || {
        match Command::new("cmd.exe").raw_arg(format!("/d /s /c \"{command_line}\"")).creation_flags(CREATE_NO_WINDOW).status() {
            Ok(s) => ExecResult { ok: s.success(), code: s.code().unwrap_or(-1), stdout: String::new(), stderr: String::new() },
            Err(e) => ExecResult { ok: false, code: -1, stdout: String::new(), stderr: e.to_string() },
        }
    })
    .await
    .unwrap_or(ExecResult { ok: false, code: -1, stdout: String::new(), stderr: "task failed".into() })
}

/// Starts a program or document without waiting (installers, regedit).
#[tauri::command]
fn launch(file: String, args: Vec<String>) -> Result<(), String> {
    Command::new(file).args(args).spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[derive(Serialize)]
struct Entry {
    name: String,
    dir: bool,
    file: bool,
    link: bool,
}

#[tauri::command]
fn read_dir(path: String) -> Vec<Entry> {
    let Ok(rd) = fs::read_dir(&path) else { return vec![] };
    rd.flatten()
        .filter_map(|e| {
            let t = e.file_type().ok()?;
            Some(Entry { name: e.file_name().to_string_lossy().into_owned(), dir: t.is_dir(), file: t.is_file(), link: t.is_symlink() })
        })
        .collect()
}

#[derive(Serialize)]
struct Stat {
    size: u64,
    dir: bool,
    created: f64,
    modified: f64,
}

fn millis(t: std::io::Result<std::time::SystemTime>) -> f64 {
    t.ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as f64).unwrap_or(0.0)
}

#[tauri::command]
fn stat(path: String) -> Option<Stat> {
    let m = fs::metadata(&path).ok()?;
    Some(Stat { size: m.len(), dir: m.is_dir(), created: millis(m.created()), modified: millis(m.modified()) })
}

#[tauri::command]
fn exists(path: String) -> bool {
    Path::new(&path).exists()
}

#[tauri::command]
fn read_text(path: String) -> Result<String, String> {
    fs::read_to_string(path).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_text(path: String, contents: String) -> Result<(), String> {
    if let Some(parent) = Path::new(&path).parent() {
        let _ = fs::create_dir_all(parent);
    }
    fs::write(path, contents).map_err(|e| e.to_string())
}

#[tauri::command]
fn make_dir(path: String) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|e| e.to_string())
}

/// Deletes SweepUninstall's own data (backups, records). Program leftovers go to the
/// Recycle Bin through the JavaScript side instead.
#[tauri::command]
fn remove_path(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Ok(());
    }
    if p.is_dir() { fs::remove_dir_all(p) } else { fs::remove_file(p) }.map_err(|e| e.to_string())
}

/// Moves a leftover file or folder to the Recycle Bin, without any Windows dialogs.
#[tauri::command]
async fn move_to_trash(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || trash::delete(&path).map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())?
}

/// Lists folders to `max_dir_depth` and files to `max_file_depth` under each root, as
/// "D<path>" / "F<path>" lines, for installation snapshots. Links are not followed.
#[tauri::command]
async fn walk(roots: Vec<String>, max_dir_depth: u32, max_file_depth: u32) -> Vec<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut out = Vec::new();
        fn go(dir: &Path, depth: u32, md: u32, mf: u32, out: &mut Vec<String>) {
            let Ok(rd) = fs::read_dir(dir) else { return };
            for e in rd.flatten() {
                let Ok(t) = e.file_type() else { continue };
                if t.is_symlink() {
                    continue;
                }
                let p = e.path();
                if t.is_dir() {
                    out.push(format!("D{}", p.display()));
                    if depth < md {
                        go(&p, depth + 1, md, mf, out);
                    }
                } else if t.is_file() && depth <= mf {
                    out.push(format!("F{}", p.display()));
                }
            }
        }
        for r in roots {
            go(Path::new(&r), 1, max_dir_depth, max_file_depth, &mut out);
        }
        out
    })
    .await
    .unwrap_or_default()
}

#[derive(Serialize)]
struct FolderSize {
    bytes: u64,
    entries: u64,
    truncated: bool,
}

/// Total size of a folder, skipping links, stopping at an entry and time budget.
#[tauri::command]
async fn folder_size(path: String, max_entries: u64, max_ms: u64) -> FolderSize {
    tauri::async_runtime::spawn_blocking(move || {
        let start = Instant::now();
        let (mut bytes, mut entries, mut truncated) = (0u64, 0u64, false);
        let mut stack: Vec<PathBuf> = vec![PathBuf::from(path)];
        while let Some(dir) = stack.pop() {
            if entries > max_entries || start.elapsed() > Duration::from_millis(max_ms) {
                truncated = true;
                break;
            }
            let Ok(rd) = fs::read_dir(&dir) else { continue };
            for e in rd.flatten() {
                entries += 1;
                let Ok(t) = e.file_type() else { continue };
                if t.is_symlink() {
                    continue;
                }
                if t.is_dir() {
                    stack.push(e.path());
                } else if t.is_file() {
                    bytes += e.metadata().map(|m| m.len()).unwrap_or(0);
                }
            }
        }
        FolderSize { bytes, entries, truncated }
    })
    .await
    .unwrap_or(FolderSize { bytes: 0, entries: 0, truncated: true })
}

/// SHA-256 of each file, as lowercase hex; empty for a file that cannot be read.
#[tauri::command]
async fn sha256_files(paths: Vec<String>) -> Vec<String> {
    use sha2::{Digest, Sha256};
    tauri::async_runtime::spawn_blocking(move || {
        paths
            .iter()
            .map(|p| {
                let Ok(mut f) = fs::File::open(p) else { return String::new() };
                let mut h = Sha256::new();
                let mut buf = vec![0u8; 64 * 1024];
                loop {
                    match std::io::Read::read(&mut f, &mut buf) {
                        Ok(0) => break,
                        Ok(n) => h.update(&buf[..n]),
                        Err(_) => return String::new(),
                    }
                }
                h.finalize().iter().map(|b| format!("{b:02x}")).collect()
            })
            .collect()
    })
    .await
    .unwrap_or_default()
}

/// Appends text to a file (the command log), creating it and its folder if needed.
#[tauri::command]
fn append_text(path: String, contents: String) -> Result<(), String> {
    if let Some(parent) = Path::new(&path).parent() {
        let _ = fs::create_dir_all(parent);
    }
    fs::OpenOptions::new().create(true).append(true).open(&path).and_then(|mut f| f.write_all(contents.as_bytes())).map_err(|e| e.to_string())
}
/// Moves several items to the Recycle Bin; one entry per path, empty when it worked.
#[tauri::command]
async fn move_many_to_trash(paths: Vec<String>) -> Vec<String> {
    tauri::async_runtime::spawn_blocking(move || paths.iter().map(|p| trash::delete(p).err().map(|e| e.to_string()).unwrap_or_default()).collect())
        .await
        .unwrap_or_default()
}

#[derive(Serialize)]
struct JunkEntry {
    path: String,
    dir: bool,
    bytes: u64,
    /// Newest modification time inside the entry (ms since 1970), so recently used folders are left alone.
    newest: f64,
}

/// The items directly inside a junk folder, each with its total size and newest modification time.
#[tauri::command]
async fn list_junk(root: String, max_ms: u64) -> Vec<JunkEntry> {
    tauri::async_runtime::spawn_blocking(move || {
        let start = Instant::now();
        let Ok(rd) = fs::read_dir(&root) else { return vec![] };
        let mut out = Vec::new();
        for e in rd.flatten() {
            let Ok(t) = e.file_type() else { continue };
            if t.is_symlink() {
                continue;
            }
            let modified = |m: &fs::Metadata| millis(m.modified());
            let Ok(meta) = e.metadata() else { continue };
            let (mut bytes, mut newest) = (if t.is_file() { meta.len() } else { 0 }, modified(&meta));
            if t.is_dir() {
                let mut stack = vec![e.path()];
                while let Some(dir) = stack.pop() {
                    if start.elapsed() > Duration::from_millis(max_ms) {
                        break;
                    }
                    let Ok(rd) = fs::read_dir(&dir) else { continue };
                    for c in rd.flatten() {
                        let (Ok(ct), Ok(cm)) = (c.file_type(), c.metadata()) else { continue };
                        if ct.is_symlink() {
                            continue;
                        }
                        newest = newest.max(modified(&cm));
                        if ct.is_dir() {
                            stack.push(c.path());
                        } else {
                            bytes += cm.len();
                        }
                    }
                }
            }
            out.push(JunkEntry { path: e.path().display().to_string(), dir: t.is_dir(), bytes, newest });
        }
        out
    })
    .await
    .unwrap_or_default()
}

/// Starts live installation tracking (administrator only).
#[tauri::command]
fn track_start() -> Result<(), String> {
    tracker::start()
}

/// Starts an installer as a child of SweepUninstall, so it and everything it starts are
/// tracked. .msi packages go through msiexec. Returns the process id.
#[tauri::command]
fn track_launch(file: String) -> Result<u32, String> {
    let lower = file.to_lowercase();
    let mut cmd = if lower.ends_with(".msi") {
        let mut c = Command::new("msiexec.exe");
        c.args(["/i", &file]);
        c
    } else if lower.ends_with(".bat") || lower.ends_with(".cmd") {
        let mut c = Command::new("cmd.exe");
        c.args(["/c", &file]);
        c
    } else {
        Command::new(&file)
    };
    // The installer gets no share of SweepUninstall's console or output.
    let child = cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().map_err(|e| e.to_string())?;
    let pid = child.id();
    tracker::add_pid(pid, file);
    Ok(pid)
}

/// Waits for a process to exit; false when it is still running after `timeout_ms`.
#[tauri::command]
async fn wait_process(pid: u32, timeout_ms: u32) -> bool {
    #[link(name = "kernel32")]
    extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> isize;
        fn WaitForSingleObject(handle: isize, ms: u32) -> u32;
        fn CloseHandle(handle: isize) -> i32;
    }
    const SYNCHRONIZE: u32 = 0x0010_0000;
    tauri::async_runtime::spawn_blocking(move || unsafe {
        let h = OpenProcess(SYNCHRONIZE, 0, pid);
        if h == 0 {
            return true; // already gone
        }
        let r = WaitForSingleObject(h, timeout_ms);
        CloseHandle(h);
        r == 0
    })
    .await
    .unwrap_or(false)
}

#[tauri::command]
fn track_running() -> bool {
    tracker::is_running()
}

#[tauri::command]
fn track_stop() -> Result<tracker::TrackResult, String> {
    tracker::stop()
}

/// Takes a snapshot of files/folders and registry keys/values into a compressed file.
#[tauri::command]
async fn take_snapshot(out: String, name: String, file_roots: Vec<String>, file_depth: u32, reg_roots: Vec<snapshot::RegRoot>, excludes: Vec<String>) -> Result<snapshot::SnapshotStats, String> {
    tauri::async_runtime::spawn_blocking(move || snapshot::take(&out, &name, &file_roots, file_depth, &reg_roots, &excludes))
        .await
        .map_err(|e| e.to_string())?
}

/// Compares two snapshots: what was added, removed and changed from `before` to `after`.
#[tauri::command]
async fn compare_snapshots(before: String, after: String, limit: usize) -> Result<snapshot::Comparison, String> {
    tauri::async_runtime::spawn_blocking(move || snapshot::compare(&before, &after, limit))
        .await
        .map_err(|e| e.to_string())?
}

/// All keys and values at or under `key` in a snapshot.
#[tauri::command]
async fn snapshot_subtree(path: String, key: String) -> Result<snapshot::Subtree, String> {
    tauri::async_runtime::spawn_blocking(move || snapshot::subtree(&path, &key))
        .await
        .map_err(|e| e.to_string())?
}

/// Portable mode: when the program file's name contains "portable" (as the portable release's
/// does) or a file named "portable" sits next to it, all data is kept in a "SweepUninstall Data"
/// folder beside it instead of in the user's profile. Falls back to normal mode when that
/// folder cannot be created (a read-only location).
fn portable_dir() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let named = exe.file_stem()?.to_string_lossy().to_lowercase().contains("portable");
    if !named && !dir.join("portable").exists() {
        return None;
    }
    let data = dir.join("SweepUninstall Data");
    fs::create_dir_all(&data).ok().map(|_| data)
}

/// Command-line requests (--snapshot, --compare, --list-snapshots, --help) run without a window.
fn cli_args() -> Vec<String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| matches!(a.to_lowercase().as_str(), "--snapshot" | "--compare" | "--list-snapshots" | "--monitor" | "--help" | "-h" | "/?")) {
        args
    } else {
        vec![]
    }
}

#[derive(Serialize)]
struct SysInfo {
    env: std::collections::HashMap<String, String>,
    home: String,
    data_dir: String,
    exe: String,
    portable: bool,
    args: Vec<String>,
}

#[tauri::command]
fn sys_info(app: tauri::AppHandle) -> SysInfo {
    let portable = portable_dir();
    SysInfo {
        env: std::env::vars().collect(),
        home: std::env::var("USERPROFILE").unwrap_or_default(),
        data_dir: portable.clone().or_else(|| app.path().app_data_dir().ok()).map(|p| p.display().to_string()).unwrap_or_default(),
        exe: std::env::current_exe().map(|p| p.display().to_string()).unwrap_or_default(),
        portable: portable.is_some(),
        args: cli_args(),
    }
}

#[tauri::command]
fn quit(app: tauri::AppHandle, code: Option<i32>) {
    app.exit(code.unwrap_or(0));
}

#[link(name = "kernel32")]
extern "system" {
    fn AttachConsole(process_id: u32) -> i32;
    fn GetStdHandle(which: u32) -> isize;
    fn SetStdHandle(which: u32, handle: isize) -> i32;
}

/// Connects to the console the program was started from, unless output is already redirected.
/// Error output is switched off: the browser engine logs harmless window-class messages there,
/// and command-line errors are printed to standard output instead.
fn attach_console() {
    const STD_OUTPUT_HANDLE: u32 = -11i32 as u32;
    const STD_ERROR_HANDLE: u32 = -12i32 as u32;
    const ATTACH_PARENT_PROCESS: u32 = u32::MAX;
    unsafe {
        let h = GetStdHandle(STD_OUTPUT_HANDLE);
        if h == 0 || h == -1 {
            AttachConsole(ATTACH_PARENT_PROCESS);
        }
        SetStdHandle(STD_ERROR_HANDLE, 0);
    }
}

/// Writes command-line output to the console (or to wherever output is redirected).
#[tauri::command]
fn cli_print(text: String) {
    let mut out = std::io::stdout();
    let _ = out.write_all(text.as_bytes());
    let _ = out.flush();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let cli = !cli_args().is_empty();
    if cli {
        attach_console();
    }
    tauri::Builder::default()
        .setup(move |app| {
            // The window is created here so that in portable mode the browser data goes in the
            // portable data folder too.
            let config = app.config().app.windows.first().cloned().ok_or("no window configured")?;
            let mut builder = tauri::WebviewWindowBuilder::from_config(app, &config)?;
            if let Some(dir) = portable_dir() {
                builder = builder.data_directory(dir.join("WebView"));
            }
            let window = builder.build()?;
            if cli {
                return Ok(());
            }
            // Size the window to the screen it opens on (in Windows' scaled units, so the
            // display scale setting is respected), then show it.
            if let Ok(Some(monitor)) = window.current_monitor() {
                let scale = monitor.scale_factor();
                let area = monitor.work_area();
                let (w, h) = (area.size.width as f64 / scale, area.size.height as f64 / scale);
                let width = (w * 0.5).clamp(760.0, 1500.0).min(w * 0.95);
                let height = (h * 0.7).clamp(560.0, 1100.0).min(h * 0.92);
                let _ = window.set_size(tauri::LogicalSize::new(width, height));
                let _ = window.center();
            }
            let _ = window.show();
            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            run_ps, exec, run_command_line, launch, read_dir, stat, exists, read_text, write_text, make_dir, remove_path, move_to_trash, move_many_to_trash, list_junk, walk, folder_size, take_snapshot,
            compare_snapshots, snapshot_subtree, sys_info, quit, cli_print, track_start, track_launch, track_running, track_stop, wait_process, sha256_files, append_text
        ])
        .run(tauri::generate_context!())
        .expect("error while running SweepUninstall");
}
