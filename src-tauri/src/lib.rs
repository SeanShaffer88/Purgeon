// Purgeon's native core: a few small, general system commands. The uninstall,
// scan, backup, debloat and startup logic lives in src/backend (JavaScript) and is built
// on these.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use std::fs;
use std::io::Write;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::time::{Duration, Instant, UNIX_EPOCH};
use tauri::{Emitter, Manager};

mod launch_args;
mod snapshot;
mod tracker;
mod windows_tools;

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
        // A PSModulePath inherited from PowerShell 7 stops Windows PowerShell loading its own modules.
        let mut child = Command::new(windows_tools::command("powershell.exe"))
            .env_remove("PSModulePath")
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
    tauri::async_runtime::spawn_blocking(move || {
        match Command::new(windows_tools::command(&file))
            .args(&args)
            .creation_flags(CREATE_NO_WINDOW)
            .output()
        {
            Ok(o) => ExecResult {
                ok: o.status.success(),
                code: o.status.code().unwrap_or(-1),
                stdout: text(&o.stdout),
                stderr: text(&o.stderr),
            },
            Err(e) => ExecResult {
                ok: false,
                code: -1,
                stdout: String::new(),
                stderr: e.to_string(),
            },
        }
    })
    .await
    .unwrap_or(ExecResult {
        ok: false,
        code: -1,
        stdout: String::new(),
        stderr: "task failed".into(),
    })
}

/// Runs an uninstall command line exactly as stored in the registry (through cmd, as Windows
/// does) and waits for it. The uninstaller's own windows still appear.
#[tauri::command]
async fn run_command_line(command_line: String) -> ExecResult {
    tauri::async_runtime::spawn_blocking(move || {
        match Command::new(windows_tools::command("cmd.exe"))
            .raw_arg(format!("/d /s /c \"{command_line}\""))
            .creation_flags(CREATE_NO_WINDOW)
            .status()
        {
            Ok(s) => ExecResult {
                ok: s.success(),
                code: s.code().unwrap_or(-1),
                stdout: String::new(),
                stderr: String::new(),
            },
            Err(e) => ExecResult {
                ok: false,
                code: -1,
                stdout: String::new(),
                stderr: e.to_string(),
            },
        }
    })
    .await
    .unwrap_or(ExecResult {
        ok: false,
        code: -1,
        stdout: String::new(),
        stderr: "task failed".into(),
    })
}

/// Starts a program or document without waiting (installers, regedit).
#[tauri::command]
fn launch(file: String, args: Vec<String>) -> Result<(), String> {
    Command::new(windows_tools::command(&file))
        .args(args)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
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
    let Ok(rd) = fs::read_dir(&path) else {
        return vec![];
    };
    rd.flatten()
        .filter_map(|e| {
            let t = e.file_type().ok()?;
            Some(Entry {
                name: e.file_name().to_string_lossy().into_owned(),
                dir: t.is_dir(),
                file: t.is_file(),
                link: t.is_symlink(),
            })
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
    t.ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

#[tauri::command]
fn stat(path: String) -> Option<Stat> {
    let m = fs::metadata(&path).ok()?;
    Some(Stat {
        size: m.len(),
        dir: m.is_dir(),
        created: millis(m.created()),
        modified: millis(m.modified()),
    })
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

/// Deletes Purgeon's own data (backups, records). Program leftovers go to the
/// Recycle Bin through the JavaScript side instead.
#[tauri::command]
fn remove_path(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Ok(());
    }
    if p.is_dir() {
        fs::remove_dir_all(p)
    } else {
        fs::remove_file(p)
    }
    .map_err(|e| e.to_string())
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
        FolderSize {
            bytes,
            entries,
            truncated,
        }
    })
    .await
    .unwrap_or(FolderSize {
        bytes: 0,
        entries: 0,
        truncated: true,
    })
}

/// SHA-256 of each file, as lowercase hex; empty for a file that cannot be read.
#[tauri::command]
async fn sha256_files(paths: Vec<String>) -> Vec<String> {
    use sha2::{Digest, Sha256};
    tauri::async_runtime::spawn_blocking(move || {
        paths
            .iter()
            .map(|p| {
                let Ok(mut f) = fs::File::open(p) else {
                    return String::new();
                };
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
    fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .and_then(|mut f| f.write_all(contents.as_bytes()))
        .map_err(|e| e.to_string())
}
/// When each uninstall entry was last written (ms since 1970), keyed like the program list
/// ("HKLM\SOFTWARE\...\Uninstall\X"). Programs written within a minute or two of each other were
/// usually installed together.
#[tauri::command]
fn uninstall_key_times() -> std::collections::HashMap<String, f64> {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_64KEY};
    use winreg::RegKey;
    let mut out = std::collections::HashMap::new();
    let roots = [
        (
            HKEY_LOCAL_MACHINE,
            "HKLM",
            "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
        ),
        (
            HKEY_LOCAL_MACHINE,
            "HKLM",
            "SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
        ),
        (
            HKEY_CURRENT_USER,
            "HKCU",
            "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
        ),
    ];
    for (hive, label, path) in roots {
        let Ok(root) =
            RegKey::predef(hive).open_subkey_with_flags(path, KEY_READ | KEY_WOW64_64KEY)
        else {
            continue;
        };
        for name in root.enum_keys().flatten() {
            let Ok(key) = root.open_subkey_with_flags(&name, KEY_READ | KEY_WOW64_64KEY) else {
                continue;
            };
            let Ok(info) = key.query_info() else { continue };
            let ft = &info.last_write_time;
            let ticks = ((ft.dwHighDateTime as u64) << 32) | ft.dwLowDateTime as u64;
            if ticks > 116_444_736_000_000_000 {
                out.insert(
                    format!("{label}\\{path}\\{name}"),
                    ((ticks - 116_444_736_000_000_000) / 10_000) as f64,
                );
            }
        }
    }
    out
}
#[derive(Serialize)]
struct RegHit {
    kind: &'static str,
    path: String,
    name: String,
    data: String,
}

#[derive(Serialize)]
struct RegSearch {
    results: Vec<RegHit>,
    #[serde(rename = "timedOut")]
    timed_out: bool,
    full: bool,
}

/// Registry keys whose name contains `term`, and values whose name or text mentions it, under
/// HKCU\Software and HKLM\SOFTWARE (Classes is left out: it is huge and shared).
#[tauri::command]
async fn search_registry(term: String, max: usize, max_ms: u64) -> RegSearch {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_64KEY};
    use winreg::{RegKey, RegValue};
    tauri::async_runtime::spawn_blocking(move || {
        let needle = term.to_lowercase();
        let start = Instant::now();
        let mut out = Vec::new();
        let mut timed_out = false;
        fn text(v: &RegValue) -> Option<String> {
            match v.vtype {
                winreg::enums::RegType::REG_SZ
                | winreg::enums::RegType::REG_EXPAND_SZ
                | winreg::enums::RegType::REG_MULTI_SZ => {
                    Some(snapshot::utf16(&v.bytes).replace('\0', " | "))
                }
                _ => None,
            }
        }
        let mut stack: Vec<(RegKey, String, u32)> = Vec::new();
        for (hive, name, path) in [
            (HKEY_CURRENT_USER, "HKEY_CURRENT_USER", "Software"),
            (HKEY_LOCAL_MACHINE, "HKEY_LOCAL_MACHINE", "SOFTWARE"),
        ] {
            if let Ok(k) =
                RegKey::predef(hive).open_subkey_with_flags(path, KEY_READ | KEY_WOW64_64KEY)
            {
                stack.push((k, format!("{name}\\{path}"), 0));
            }
        }
        while let Some((key, full, depth)) = stack.pop() {
            if out.len() >= max {
                break;
            }
            if start.elapsed() > Duration::from_millis(max_ms) {
                timed_out = true;
                break;
            }
            let leaf = full.rsplit('\\').next().unwrap_or("").to_lowercase();
            if depth > 0 && leaf.contains(&needle) {
                out.push(RegHit {
                    kind: "key",
                    path: full.clone(),
                    name: String::new(),
                    data: String::new(),
                });
                continue; // the key covers everything inside it
            }
            for (vname, value) in key.enum_values().flatten() {
                let data = text(&value).unwrap_or_default();
                if vname.to_lowercase().contains(&needle) || data.to_lowercase().contains(&needle) {
                    out.push(RegHit {
                        kind: "value",
                        path: full.clone(),
                        name: vname,
                        data: data.chars().take(200).collect(),
                    });
                }
            }
            if depth < 14 {
                for sub in key.enum_keys().flatten() {
                    if depth == 0 && sub.eq_ignore_ascii_case("Classes") {
                        continue;
                    }
                    if let Ok(k) = key.open_subkey_with_flags(&sub, KEY_READ | KEY_WOW64_64KEY) {
                        stack.push((k, format!("{full}\\{sub}"), depth + 1));
                    }
                }
            }
        }
        let full = out.len() >= max;
        RegSearch {
            results: out,
            timed_out,
            full,
        }
    })
    .await
    .unwrap_or(RegSearch {
        results: vec![],
        timed_out: true,
        full: false,
    })
}
/// Moves several items to the Recycle Bin; one entry per path, empty when it worked.
#[tauri::command]
async fn move_many_to_trash(paths: Vec<String>) -> Vec<String> {
    tauri::async_runtime::spawn_blocking(move || {
        paths
            .iter()
            .map(|p| {
                trash::delete(p)
                    .err()
                    .map(|e| e.to_string())
                    .unwrap_or_default()
            })
            .collect()
    })
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
        let Ok(rd) = fs::read_dir(&root) else {
            return vec![];
        };
        let mut out = Vec::new();
        for e in rd.flatten() {
            let Ok(t) = e.file_type() else { continue };
            if t.is_symlink() {
                continue;
            }
            let modified = |m: &fs::Metadata| millis(m.modified());
            let Ok(meta) = e.metadata() else { continue };
            let (mut bytes, mut newest) =
                (if t.is_file() { meta.len() } else { 0 }, modified(&meta));
            if t.is_dir() {
                let mut stack = vec![e.path()];
                while let Some(dir) = stack.pop() {
                    if start.elapsed() > Duration::from_millis(max_ms) {
                        break;
                    }
                    let Ok(rd) = fs::read_dir(&dir) else { continue };
                    for c in rd.flatten() {
                        let (Ok(ct), Ok(cm)) = (c.file_type(), c.metadata()) else {
                            continue;
                        };
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
            out.push(JunkEntry {
                path: e.path().display().to_string(),
                dir: t.is_dir(),
                bytes,
                newest,
            });
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

/// Starts an installer as a child of Purgeon, so it and everything it starts are
/// tracked. .msi packages go through msiexec. Returns the process id.
#[tauri::command]
fn track_launch(file: String) -> Result<u32, String> {
    let lower = file.to_lowercase();
    let mut cmd = if lower.ends_with(".msi") {
        let mut c = Command::new(windows_tools::command("msiexec.exe"));
        c.args(["/i", &file]);
        c
    } else if lower.ends_with(".bat") || lower.ends_with(".cmd") {
        let mut c = Command::new(windows_tools::command("cmd.exe"));
        c.args(["/c", &file]);
        c
    } else {
        Command::new(&file)
    };
    // The installer gets no share of Purgeon's console or output.
    let child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
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

/// The processor each program file is built for, from its PE header: "x64", "x86", "arm64",
/// "arm", or "" when the file can't be read.
#[tauri::command]
fn exe_arch(paths: Vec<String>) -> Vec<String> {
    fn machine(p: &str) -> Option<&'static str> {
        use std::io::{Read, Seek, SeekFrom};
        let mut f = std::fs::File::open(p).ok()?;
        let mut dos = [0u8; 64];
        f.read_exact(&mut dos).ok()?;
        if &dos[0..2] != b"MZ" {
            return None;
        }
        let pe_at = u32::from_le_bytes([dos[60], dos[61], dos[62], dos[63]]) as u64;
        f.seek(SeekFrom::Start(pe_at)).ok()?;
        let mut pe = [0u8; 6];
        f.read_exact(&mut pe).ok()?;
        if &pe[0..4] != b"PE\0\0" {
            return None;
        }
        Some(match u16::from_le_bytes([pe[4], pe[5]]) {
            0x8664 => "x64",
            0x014c => "x86",
            0xaa64 => "arm64",
            0x01c4 => "arm",
            _ => "",
        })
    }
    paths
        .iter()
        .map(|p| machine(p).unwrap_or("").to_string())
        .collect()
}

#[derive(Serialize)]
struct ProcessInfo {
    pid: u32,
    ppid: u32,
    name: String,
    session: u32,
}

/// Every running process (id, parent id, exe name, session), cheaply, for spotting installers
/// as they start.
#[tauri::command]
fn list_processes() -> Vec<ProcessInfo> {
    #[repr(C)]
    struct ProcessEntry32W {
        size: u32,
        usage: u32,
        pid: u32,
        heap: usize,
        module: u32,
        threads: u32,
        ppid: u32,
        priority: i32,
        flags: u32,
        exe: [u16; 260],
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn CreateToolhelp32Snapshot(flags: u32, pid: u32) -> isize;
        fn Process32FirstW(snap: isize, entry: *mut ProcessEntry32W) -> i32;
        fn Process32NextW(snap: isize, entry: *mut ProcessEntry32W) -> i32;
        fn ProcessIdToSessionId(pid: u32, session: *mut u32) -> i32;
        fn CloseHandle(handle: isize) -> i32;
    }
    const TH32CS_SNAPPROCESS: u32 = 2;
    let mut out = Vec::new();
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == -1 {
            return out;
        }
        let mut e: ProcessEntry32W = std::mem::zeroed();
        e.size = std::mem::size_of::<ProcessEntry32W>() as u32;
        let mut ok = Process32FirstW(snap, &mut e);
        while ok != 0 {
            let len = e.exe.iter().position(|&c| c == 0).unwrap_or(e.exe.len());
            let mut session = u32::MAX;
            ProcessIdToSessionId(e.pid, &mut session);
            out.push(ProcessInfo {
                pid: e.pid,
                ppid: e.ppid,
                name: String::from_utf16_lossy(&e.exe[..len]),
                session,
            });
            ok = Process32NextW(snap, &mut e);
        }
        CloseHandle(snap);
    }
    out
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
async fn take_snapshot(
    out: String,
    name: String,
    file_roots: Vec<String>,
    file_depth: u32,
    reg_roots: Vec<snapshot::RegRoot>,
    excludes: Vec<String>,
) -> Result<snapshot::SnapshotStats, String> {
    tauri::async_runtime::spawn_blocking(move || {
        snapshot::take(&out, &name, &file_roots, file_depth, &reg_roots, &excludes)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Compares two snapshots: what was added, removed and changed from `before` to `after`.
#[tauri::command]
async fn compare_snapshots(
    before: String,
    after: String,
    limit: usize,
) -> Result<snapshot::Comparison, String> {
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
/// does) or a file named "portable" sits next to it, all data is kept in a "Purgeon Data"
/// folder beside it instead of in the user's profile. Falls back to normal mode when that
/// folder cannot be created (a read-only location).
fn portable_dir() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let named = exe
        .file_stem()?
        .to_string_lossy()
        .to_lowercase()
        .contains("portable");
    if !named && !dir.join("portable").exists() {
        return None;
    }
    // A portable copy from before the rename keeps using its "SweepUninstall Data" folder.
    let old = dir.join("SweepUninstall Data");
    let data = if old.is_dir() && !dir.join("Purgeon Data").exists() {
        old
    } else {
        dir.join("Purgeon Data")
    };
    fs::create_dir_all(&data).ok().map(|_| data)
}

/// CLI requests, including typos, run without a window and are validated before dispatch.
fn cli_args() -> Vec<String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if launch_args::is_window_request(&args) {
        vec![]
    } else {
        args
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
    /// All start-up arguments, for requests the window handles (--resume-queue, --who-owns, --uninstall-target).
    launch: Vec<String>,
}

#[tauri::command]
fn sys_info(app: tauri::AppHandle) -> SysInfo {
    let portable = portable_dir();
    SysInfo {
        env: windows_tools::environment(),
        home: std::env::var("USERPROFILE").unwrap_or_default(),
        data_dir: portable
            .clone()
            .or_else(|| app.path().app_data_dir().ok())
            .map(|p| p.display().to_string())
            .unwrap_or_default(),
        exe: std::env::current_exe()
            .map(|p| p.display().to_string())
            .unwrap_or_default(),
        portable: portable.is_some(),
        args: cli_args(),
        launch: std::env::args().skip(1).collect(),
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

// ---- tray icon ----------------------------------------------------------------------------
// The close button asks whether to exit or keep running in the tray (where installer detection and
// new-startup-entry alerts keep working), unless a choice was remembered; View › Minimize
// to Tray hides the window there when it is minimized; View › Start Minimized to Tray starts it
// there. The tray icon shows while any of these is on. A left click on it shows the window again;
// a right click opens its menu.
// What the close button does: 0 ask (the page shows the question), 1 hide to the tray, 2 exit.
static CLOSE_MODE: AtomicU8 = AtomicU8::new(0);
// Set while the question is showing: a second close then exits, so a page that stopped
// responding can never keep the window from closing.
static CLOSE_ASKING: AtomicBool = AtomicBool::new(false);
// Set by the page once it has loaded and registered its close-question listener.
// While it is unset, a close is never intercepted: a page that failed to load must
// not be able to trap the window open.
static FRONTEND_READY: AtomicBool = AtomicBool::new(false);
static MINIMIZE_TO_TRAY: AtomicBool = AtomicBool::new(false);

fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        // Restore first, then show: showing a still-minimized window and then restoring it leaves
        // the page at the minimized size.
        if w.is_minimized().unwrap_or(false) {
            let _ = w.unminimize();
        }
        if !w.is_visible().unwrap_or(true) {
            let _ = w.show();
        }
        let _ = w.set_focus();
        refit(&w);
    }
}

// A window hidden while minimized comes back "restored" but still at Windows' minimized spot
// (160×28 at -32000,-32000), and every later restore returns there. Windows still remembers the
// real size in the window's placement, so put it back there.
// The window's last normal (not minimized or maximized) position and size, kept as it moves.
static LAST_NORMAL: std::sync::Mutex<Option<[i32; 4]>> = std::sync::Mutex::new(None);

#[link(name = "user32")]
extern "system" {
    fn GetWindowRect(hwnd: isize, r: *mut [i32; 4]) -> i32;
    fn IsIconic(hwnd: isize) -> i32;
    fn IsZoomed(hwnd: isize) -> i32;
}

fn sane(r: &[i32; 4]) -> bool {
    r[0] > -30000 && r[1] > -30000 && r[2] - r[0] >= 300 && r[3] - r[1] >= 150
}

fn remember_normal(w: &tauri::WebviewWindow) {
    let Ok(hwnd) = w.hwnd() else { return };
    let hwnd = hwnd.0 as isize;
    let mut r = [0i32; 4];
    unsafe {
        if IsIconic(hwnd) != 0 || IsZoomed(hwnd) != 0 || GetWindowRect(hwnd, &mut r) == 0 {
            return;
        }
    }
    if sane(&r) {
        *LAST_NORMAL.lock().unwrap() = Some(r);
    }
}

fn refit(w: &tauri::WebviewWindow) {
    #[repr(C)]
    struct Placement {
        length: u32,
        flags: u32,
        show_cmd: u32,
        min_pos: [i32; 2],
        max_pos: [i32; 2],
        normal: [i32; 4],
    }
    #[link(name = "user32")]
    extern "system" {
        fn GetWindowPlacement(hwnd: isize, p: *mut Placement) -> i32;
        fn SetWindowPlacement(hwnd: isize, p: *const Placement) -> i32;
    }
    const SW_SHOWNORMAL: u32 = 1;
    let Ok(hwnd) = w.hwnd() else { return };
    let hwnd = hwnd.0 as isize;
    unsafe {
        let mut rect = [0i32; 4];
        if IsIconic(hwnd) != 0 || GetWindowRect(hwnd, &mut rect) == 0 {
            return;
        }
        if sane(&rect) {
            return;
        }
        let mut p: Placement = std::mem::zeroed();
        p.length = std::mem::size_of::<Placement>() as u32;
        if GetWindowPlacement(hwnd, &mut p) == 0 {
            return;
        }
        // Windows' remembered size can be the minimized one too: then use the last size the
        // window had on screen, or a normal size.
        if !sane(&p.normal) {
            p.normal = LAST_NORMAL
                .lock()
                .unwrap()
                .unwrap_or([100, 100, 100 + 960, 100 + 720]);
        }
        p.flags = 0;
        p.show_cmd = SW_SHOWNORMAL;
        SetWindowPlacement(hwnd, &p);
    }
}

/// The page found itself smaller than its window (see refit).
#[tauri::command]
fn refit_window(app: tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        refit(&w);
    }
}

/// Hides the window in the tray (the close question's "Minimize to Tray"); the tray icon shows
/// so there is a way back. Hidden windows have no taskbar button.
#[tauri::command]
fn hide_to_tray(app: tauri::AppHandle) {
    if let Some(t) = app.tray_by_id("main") {
        let _ = t.set_visible(true);
    }
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
}

#[tauri::command]
fn set_tray(app: tauri::AppHandle, close: String, minimize: bool, visible: bool) {
    CLOSE_MODE.store(
        match close.as_str() {
            "tray" => 1,
            "exit" => 2,
            _ => 0,
        },
        Ordering::SeqCst,
    );
    let close = close == "tray";
    MINIMIZE_TO_TRAY.store(minimize, Ordering::SeqCst);
    let hidden = app
        .get_webview_window("main")
        .map(|w| !w.is_visible().unwrap_or(true))
        .unwrap_or(false);
    if let Some(t) = app.tray_by_id("main") {
        // Never hide the icon while the window is hidden: it is the only way back.
        let _ = t.set_visible(close || minimize || visible || hidden);
    }
}

/// The close question was answered (or dismissed): the next close asks again.
#[tauri::command]
fn close_answered() {
    CLOSE_ASKING.store(false, Ordering::SeqCst);
}

/// The page has loaded and is listening for the close question.
#[tauri::command]
fn frontend_ready() {
    FRONTEND_READY.store(true, Ordering::SeqCst);
}

/// Brings the window back (from the tray too), for questions that need an answer now.
#[tauri::command]
fn show_window(app: tauri::AppHandle) {
    show_main(&app);
}

#[tauri::command]
fn set_on_top(app: tauri::AppHandle, on: bool) -> Result<(), String> {
    let w = app.get_webview_window("main").ok_or("no window")?;
    w.set_always_on_top(on).map_err(|e| e.to_string())
}

// Whether to start hidden in the tray: "--tray" on the command line, or the startInTray setting
// (the settings file is read here, before the window would first show).
fn start_in_tray(app: &tauri::App) -> bool {
    if std::env::args().any(|a| a.eq_ignore_ascii_case("--tray")) {
        return true;
    }
    let dir = portable_dir().or_else(|| app.path().app_data_dir().ok());
    dir.and_then(|d| std::fs::read_to_string(d.join("settings.json")).ok())
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.get("startInTray").and_then(|b| b.as_bool()))
        .unwrap_or(false)
}

fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
    let open = MenuItem::with_id(app, "open", "Show Purgeon", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let monitor = MenuItem::with_id(
        app,
        "monitor",
        "Monitor an Installation...",
        true,
        None::<&str>,
    )?;
    let junk = MenuItem::with_id(app, "junk", "Cleaner", true, None::<&str>)?;
    let startup = MenuItem::with_id(app, "startup", "Startup && Services", true, None::<&str>)?;
    let updates = MenuItem::with_id(app, "updates", "Program Updates", true, None::<&str>)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Exit Purgeon", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &open, &sep1, &monitor, &junk, &startup, &updates, &sep2, &quit,
        ],
    )?;
    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("Purgeon\nLeft-click: show the window\nRight-click: menu")
        .menu(&menu)
        .show_menu_on_left_click(false);
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    let icon = tray
        .on_menu_event(|app, e| match e.id().as_ref() {
            "quit" => app.exit(0),
            id => {
                show_main(app);
                let _ = app.emit("tray", id.to_string());
            }
        })
        .on_tray_icon_event(|tray, e| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = e
            {
                show_main(tray.app_handle());
            }
        })
        .build(app)?;
    icon.set_visible(false)?;
    Ok(())
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
            let config = app
                .config()
                .app
                .windows
                .first()
                .cloned()
                .ok_or("no window configured")?;
            let mut builder = tauri::WebviewWindowBuilder::from_config(app, &config)?;
            if let Some(dir) = portable_dir() {
                builder = builder.data_directory(dir.join("WebView"));
            }
            let window = builder.build()?;
            if cli {
                return Ok(());
            }
            build_tray(app)?;
            let hide = window.clone();
            window.on_window_event(move |e| match e {
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    match CLOSE_MODE.load(Ordering::SeqCst) {
                        0 if !FRONTEND_READY.load(Ordering::SeqCst) => {}
                        1 => {
                            api.prevent_close();
                            let _ = hide.hide();
                        }
                        0 if !CLOSE_ASKING.swap(true, Ordering::SeqCst) => {
                            api.prevent_close();
                            let _ = hide.emit("close-requested", ());
                        }
                        _ => {}
                    }
                }
                // Minimizing shows up as a resize; with Minimize to Tray the window then hides
                // so it leaves the taskbar, and the tray icon brings it back.
                // (Purgeon's own minimize button hides straight to the tray instead; this
                // covers Win+Down and the taskbar.) The hide waits until the minimize has finished:
                // hiding from inside its resize event leaves the page at the minimized size later.
                tauri::WindowEvent::Resized(_)
                    if MINIMIZE_TO_TRAY.load(Ordering::SeqCst)
                        && hide.is_minimized().unwrap_or(false) =>
                {
                    let w = hide.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(150));
                        let _ = w.hide();
                    });
                }
                tauri::WindowEvent::Resized(_) | tauri::WindowEvent::Moved(_) => {
                    remember_normal(&hide)
                }
                _ => {}
            });
            let in_tray = start_in_tray(app);
            // Size the window to the screen it opens on (in Windows' scaled units, so the
            // display scale setting is respected), then show it.
            if let Ok(Some(monitor)) = window.current_monitor() {
                let scale = monitor.scale_factor();
                let area = monitor.work_area();
                let (w, h) = (
                    area.size.width as f64 / scale,
                    area.size.height as f64 / scale,
                );
                let width = (w * 0.5).clamp(760.0, 1500.0).min(w * 0.95);
                let height = (h * 0.7).clamp(560.0, 1100.0).min(h * 0.92);
                let _ = window.set_size(tauri::LogicalSize::new(width, height));
                let _ = window.center();
            }
            // Window events start after setup, so record the starting size here.
            remember_normal(&window);
            if in_tray {
                if let Some(t) = app.tray_by_id("main") {
                    let _ = t.set_visible(true);
                }
            } else {
                let _ = window.show();
            }
            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            run_ps,
            exec,
            run_command_line,
            launch,
            read_dir,
            stat,
            exists,
            read_text,
            write_text,
            make_dir,
            remove_path,
            move_to_trash,
            move_many_to_trash,
            list_junk,
            walk,
            folder_size,
            take_snapshot,
            compare_snapshots,
            snapshot_subtree,
            sys_info,
            quit,
            cli_print,
            track_start,
            track_launch,
            track_running,
            track_stop,
            wait_process,
            sha256_files,
            append_text,
            uninstall_key_times,
            set_tray,
            set_on_top,
            show_window,
            hide_to_tray,
            close_answered,
            frontend_ready,
            refit_window,
            list_processes,
            exe_arch,
            search_registry
        ])
        .run(tauri::generate_context!())
        .expect("error while running Purgeon");
}
