//! Live installation tracking with Event Tracing for Windows (ETW).
//!
//! While an installer runs, Windows reports every file created, renamed or deleted and every
//! registry key and value created, changed or deleted. Only events from the installer and the
//! processes it starts (plus Windows Installer's msiexec processes, which do the work for .msi
//! packages) are kept. This catches changes at any depth, unlike a before/after snapshot.
//! Needs administrator rights; the JavaScript side falls back to snapshots without them.
use ferrisetw::parser::Parser;
use ferrisetw::provider::{EventFilter, Provider};
use ferrisetw::schema_locator::SchemaLocator;
use ferrisetw::trace::{stop_trace_by_name, TraceTrait, UserTrace};
use ferrisetw::EventRecord;
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::sync::{Arc, Mutex};

const PROCESS: &str = "22fb2cd6-0e7b-422b-a0c7-2fad1fd0e716"; // Microsoft-Windows-Kernel-Process
const FILE: &str = "edd08927-9cc4-4e65-b970-c2560fb5c289"; // Microsoft-Windows-Kernel-File
const REGISTRY: &str = "70eb4f03-c1de-4f73-a051-33d13d5413bd"; // Microsoft-Windows-Kernel-Registry
const SESSION: &str = "Purgeon-InstallTracker";

#[derive(Serialize, Clone)]
pub struct TrackedProcess {
    pid: u32,
    parent: u32,
    image: String,
}

#[derive(Default)]
struct State {
    pids: HashSet<u32>,
    processes: Vec<TrackedProcess>,
    created_files: BTreeSet<String>,
    created_dirs: BTreeSet<String>,
    deleted: BTreeSet<String>,
    created_keys: BTreeSet<String>,
    deleted_keys: BTreeSet<String>,
    // (key, value name) -> whether the value did not exist before
    set_values: BTreeMap<(String, String), bool>,
    deleted_values: BTreeSet<(String, String)>,
    events: HashMap<String, u64>,
}

#[derive(Serialize)]
pub struct SetValue {
    key: String,
    name: String,
    new: bool,
}

#[derive(Serialize)]
pub struct TrackResult {
    processes: Vec<TrackedProcess>,
    created_files: Vec<String>,
    created_dirs: Vec<String>,
    deleted: Vec<String>,
    created_keys: Vec<String>,
    deleted_keys: Vec<String>,
    set_values: Vec<SetValue>,
    deleted_values: Vec<[String; 2]>,
    events: HashMap<String, u64>,
}

// The running trace. UserTrace holds raw session handles; it is only touched under this lock.
struct Running(UserTrace, Arc<Mutex<State>>);
unsafe impl Send for Running {}
static RUNNING: Mutex<Option<Running>> = Mutex::new(None);

fn count(state: &Arc<Mutex<State>>, what: String) {
    if let Ok(mut s) = state.lock() {
        *s.events.entry(what).or_insert(0) += 1;
    }
}

fn tracked(state: &Arc<Mutex<State>>, pid: u32) -> bool {
    state.lock().map(|s| s.pids.contains(&pid)).unwrap_or(false)
}

fn on_process(state: &Arc<Mutex<State>>, record: &EventRecord, locator: &SchemaLocator) {
    if record.event_id() != 1 {
        return;
    }
    let Ok(schema) = locator.event_schema(record) else {
        return;
    };
    let parser = Parser::create(record, &schema);
    let (Ok(pid), Ok(parent)) = (
        parser.try_parse::<u32>("ProcessID"),
        parser.try_parse::<u32>("ParentProcessID"),
    ) else {
        return;
    };
    let image: String = parser.try_parse("ImageName").unwrap_or_default();
    let Ok(mut s) = state.lock() else { return };
    // Children of tracked processes, and Windows Installer's msiexec, which installs .msi packages for them.
    if s.pids.contains(&parent) || image.to_lowercase().ends_with("\\msiexec.exe") {
        s.pids.insert(pid);
        s.processes.push(TrackedProcess { pid, parent, image });
    }
}

fn on_file(state: &Arc<Mutex<State>>, record: &EventRecord, locator: &SchemaLocator) {
    if !tracked(state, record.process_id()) {
        return;
    }
    let id = record.event_id();
    let Ok(schema) = locator.event_schema(record) else {
        return;
    };
    let parser = Parser::create(record, &schema);
    let field = if id == 30 { "FileName" } else { "FilePath" };
    let Ok(name) = parser.try_parse::<String>(field) else {
        count(state, format!("file:{id}:unparsed"));
        return;
    };
    count(state, format!("file:{id}"));
    let Ok(mut s) = state.lock() else { return };
    match id {
        // CreateNewFile: FILE_DIRECTORY_FILE (1) in CreateOptions marks a new folder.
        30 => {
            let options: u32 = parser.try_parse("CreateOptions").unwrap_or(0);
            if options & 1 != 0 {
                s.created_dirs.insert(name);
            } else {
                s.created_files.insert(name);
            }
        }
        // DeletePath
        26 => {
            s.created_files.remove(&name);
            s.deleted.insert(name);
        }
        // RenamePath: the file now has this name (installers often write a temporary file and rename it).
        27 => {
            s.created_files.insert(name);
        }
        _ => {}
    }
}

fn join_key(base: &str, relative: &str) -> String {
    match (base.is_empty(), relative.is_empty()) {
        (true, _) => relative.to_string(),
        (_, true) => base.to_string(),
        _ => format!(
            "{}\\{}",
            base.trim_end_matches('\\'),
            relative.trim_start_matches('\\')
        ),
    }
}

fn on_registry(state: &Arc<Mutex<State>>, record: &EventRecord, locator: &SchemaLocator) {
    if !tracked(state, record.process_id()) {
        return;
    }
    let id = record.event_id();
    let Ok(schema) = locator.event_schema(record) else {
        return;
    };
    let parser = Parser::create(record, &schema);
    if parser.try_parse::<u32>("Status").unwrap_or(0) != 0 {
        return; // failed operations change nothing
    }
    let text = |name: &str| parser.try_parse::<String>(name).unwrap_or_default();
    count(state, format!("registry:{id}"));
    let Ok(mut s) = state.lock() else { return };
    match id {
        // CreateKey: Disposition 1 means the key was newly created (2: it already existed).
        1 => {
            if parser.try_parse::<u32>("Disposition").unwrap_or(0) == 1 {
                let key = join_key(&text("BaseName"), &text("RelativeName"));
                if !key.is_empty() {
                    s.created_keys.insert(key);
                }
            }
        }
        // SetValueKey: PreviousDataType/Size are 0 when the value did not exist before.
        5 => {
            let key = text("KeyName");
            if key.is_empty() {
                return;
            }
            let prev_type = parser.try_parse::<u32>("PreviousDataType");
            let prev_size = parser.try_parse::<u32>("PreviousDataSize").unwrap_or(1);
            let new = matches!(prev_type, Ok(0)) && prev_size == 0;
            let entry = s.set_values.entry((key, text("ValueName"))).or_insert(new);
            *entry = *entry && new; // once it existed, it stays "changed"
        }
        // DeleteKey
        3 => {
            let key = text("KeyName");
            if !key.is_empty() {
                s.created_keys.remove(&key);
                s.deleted_keys.insert(key);
            }
        }
        // DeleteValueKey
        6 => {
            let key = text("KeyName");
            if !key.is_empty() {
                s.deleted_values.insert((key, text("ValueName")));
            }
        }
        _ => {}
    }
}

/// Starts tracking. Nothing is tracked until a process is added with `add_pid` or `launch`.
pub fn start() -> Result<(), String> {
    let mut running = RUNNING.lock().map_err(|e| e.to_string())?;
    if let Some(Running(trace, _)) = running.take() {
        let _ = trace.stop();
    }
    let _ = stop_trace_by_name(SESSION); // a session left over from a crash
    let state = Arc::new(Mutex::new(State::default()));
    let (s1, s2, s3) = (state.clone(), state.clone(), state.clone());
    let process = Provider::by_guid(PROCESS)
        .any(0x10)
        .add_filter(EventFilter::ByEventIds(vec![1]))
        .add_callback(move |r: &EventRecord, l: &SchemaLocator| on_process(&s1, r, l))
        .build();
    // FileName rundown, DeletePath, RenamePath and CreateNewFile keywords.
    let file = Provider::by_guid(FILE)
        .any(0x10 | 0x400 | 0x800 | 0x1000)
        .add_filter(EventFilter::ByEventIds(vec![26, 27, 30]))
        .add_callback(move |r: &EventRecord, l: &SchemaLocator| on_file(&s2, r, l))
        .build();
    let registry = Provider::by_guid(REGISTRY)
        .any(u64::MAX)
        .add_filter(EventFilter::ByEventIds(vec![1, 3, 5, 6]))
        .add_callback(move |r: &EventRecord, l: &SchemaLocator| on_registry(&s3, r, l))
        .build();
    let (trace, handle) = UserTrace::new()
        .named(SESSION.to_string())
        .enable(process)
        .enable(file)
        .enable(registry)
        .start()
        .map_err(|e| {
            format!("Live tracking could not start ({e:?}). It needs administrator rights.")
        })?;
    std::thread::spawn(move || {
        let _ = UserTrace::process_from_handle(handle);
    });
    *running = Some(Running(trace, state));
    Ok(())
}

pub fn add_pid(pid: u32, image: String) {
    if let Ok(running) = RUNNING.lock() {
        if let Some(Running(_, state)) = running.as_ref() {
            if let Ok(mut s) = state.lock() {
                s.pids.insert(pid);
                s.processes.push(TrackedProcess {
                    pid,
                    parent: std::process::id(),
                    image,
                });
            }
        }
    }
}

pub fn is_running() -> bool {
    RUNNING.lock().map(|r| r.is_some()).unwrap_or(false)
}

/// Device paths (\Device\HarddiskVolume3\...) to drive paths (C:\...).
fn dos_devices() -> Vec<(String, String)> {
    #[link(name = "kernel32")]
    extern "system" {
        fn QueryDosDeviceW(name: *const u16, target: *mut u16, max: u32) -> u32;
    }
    let mut out = Vec::new();
    for letter in b'A'..=b'Z' {
        let drive = format!("{}:", letter as char);
        let name: Vec<u16> = drive.encode_utf16().chain(Some(0)).collect();
        let mut buf = vec![0u16; 1024];
        let n = unsafe { QueryDosDeviceW(name.as_ptr(), buf.as_mut_ptr(), buf.len() as u32) };
        if n > 0 {
            let end = buf.iter().position(|&c| c == 0).unwrap_or(0);
            out.push((String::from_utf16_lossy(&buf[..end]), drive));
        }
    }
    out
}

fn to_drive_path(p: &str, devices: &[(String, String)]) -> Option<String> {
    let p = p.trim_start_matches("\\??\\");
    if p.len() > 2 && p.as_bytes()[1] == b':' {
        return Some(p.to_string());
    }
    devices.iter().find_map(|(dev, drive)| {
        let rest = p.strip_prefix(dev.as_str())?;
        (rest.is_empty() || rest.starts_with('\\')).then(|| format!("{drive}{rest}"))
    })
}

/// Stops tracking and returns everything recorded, with file paths as drive paths.
pub fn stop() -> Result<TrackResult, String> {
    let Running(trace, state) = RUNNING
        .lock()
        .map_err(|e| e.to_string())?
        .take()
        .ok_or("Live tracking is not running")?;
    let _ = trace.stop();
    let s = state.lock().map_err(|e| e.to_string())?;
    let devices = dos_devices();
    let paths = |set: &BTreeSet<String>| {
        set.iter()
            .filter_map(|p| to_drive_path(p, &devices))
            .collect::<Vec<_>>()
    };
    Ok(TrackResult {
        processes: s.processes.clone(),
        created_files: paths(&s.created_files),
        created_dirs: paths(&s.created_dirs),
        deleted: paths(&s.deleted),
        created_keys: s.created_keys.iter().cloned().collect(),
        deleted_keys: s.deleted_keys.iter().cloned().collect(),
        set_values: s
            .set_values
            .iter()
            .map(|((key, name), new)| SetValue {
                key: key.clone(),
                name: name.clone(),
                new: *new,
            })
            .collect(),
        deleted_values: s
            .deleted_values
            .iter()
            .map(|(k, v)| [k.clone(), v.clone()])
            .collect(),
        events: s.events.clone(),
    })
}
