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

#[derive(Serialize)]
struct SysInfo {
    env: std::collections::HashMap<String, String>,
    home: String,
    data_dir: String,
    exe: String,
}

#[tauri::command]
fn sys_info(app: tauri::AppHandle) -> SysInfo {
    SysInfo {
        env: std::env::vars().collect(),
        home: std::env::var("USERPROFILE").unwrap_or_default(),
        data_dir: app.path().app_data_dir().map(|p| p.display().to_string()).unwrap_or_default(),
        exe: std::env::current_exe().map(|p| p.display().to_string()).unwrap_or_default(),
    }
}

#[tauri::command]
fn quit(app: tauri::AppHandle) {
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // Size the window to the screen it opens on (in Windows' scaled units, so the
            // display scale setting is respected), then show it.
            if let Some(window) = app.get_webview_window("main") {
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
            }
            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            run_ps, exec, run_command_line, launch, read_dir, stat, exists, read_text, write_text, make_dir, remove_path, move_to_trash, walk, folder_size, sys_info, quit
        ])
        .run(tauri::generate_context!())
        .expect("error while running SweepUninstall");
}
