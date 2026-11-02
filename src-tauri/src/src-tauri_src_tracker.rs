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
use ferrisetw::trace::{stop_trace_by_name, TraceError, TraceTrait, UserTrace};
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

#[derive(Serialize)]
pub struct TrackProgress {
    pub processes: usize,
    pub events: u64,
}

pub fn peek() -> Result<TrackProgress, String> {
    let running = RUNNING.lock().map_err(|e| e.to_string())?;
    let state = &running
        .as_ref()
        .ok_or("Live tracking is not running")?
        .value()
        .state;
    let state = state.lock().map_err(|e| e.to_string())?;
    Ok(TrackProgress {
        processes: state.processes.len(),
        events: state.events.values().sum(),
    })
}

// Lifecycle transitions own the trace and worker together. RUNNING and State
// locks are never held across producer STOP or the consumer's blocking drain.
struct Running {
    trace: UserTrace,
    state: Arc<Mutex<State>>,
    worker: std::thread::JoinHandle<Result<(), String>>,
}
unsafe impl Send for Running {}
enum Owned<T> {
    Active(T),
    Stopping(T),
}
impl<T> Owned<T> {
    fn value(&self) -> &T {
        match self {
            Self::Active(value) | Self::Stopping(value) => value,
        }
    }
}
static RUNNING: Mutex<Option<Owned<Running>>> = Mutex::new(None);
static LIFECYCLE: Mutex<()> = Mutex::new(());

fn ensure_restart_allowed<T>(slot: &Mutex<Option<Owned<T>>>) -> Result<bool, String> {
    let running = slot.lock().map_err(|e| e.to_string())?;
    match running.as_ref() {
        Some(Owned::Stopping(_))=>Err("The previous live trace could not stop. Retry Stop before starting another trace; its state and worker are retained".into()),
        Some(Owned::Active(_))=>Ok(true),
        None=>Ok(false),
    }
}
fn stop_slot<T, R>(
    slot: &Mutex<Option<Owned<T>>>,
    request_stop: impl FnOnce(&T) -> Result<(), String>,
    drain: impl FnOnce(T) -> Result<R, String>,
) -> Result<R, String> {
    let owned = slot
        .lock()
        .map_err(|e| e.to_string())?
        .take()
        .ok_or("Live tracking is not running")?;
    let value = match owned {
        Owned::Active(value) | Owned::Stopping(value) => value,
    };
    if let Err(error) = request_stop(&value) {
        // Even a poisoned slot must retain the original trace and join handle;
        // returning a stop error must never detach a still-running consumer.
        *slot
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(Owned::Stopping(value));
        return Err(error);
    }
    drain(value)
}
fn instance_not_found(error: &TraceError) -> bool {
    matches!(error, TraceError::EtwNativeError(ferrisetw::native::EvntraceNativeError::IoError(error)) if matches!(error.raw_os_error(),Some(4201)|Some(-2147020695)))
}
fn stop_producer(_: &Running) -> Result<(), String> {
    match stop_trace_by_name(SESSION) {
        Ok(())=>Ok(()),
        Err(error) if instance_not_found(&error)=>Ok(()),
        Err(error)=>Err(format!("Live tracking producer could not stop: {error:?}. State and worker are retained; retry Stop before restarting")),
    }
}
fn drain_running(running: Running) -> Result<State, String> {
    let Running {
        trace,
        state,
        worker,
    } = running;
    // Stop the producer first, leaving ferrisetw's callback context valid until
    // ProcessTrace has delivered its queued tail. No forced drain timeout.
    let processed = worker
        .join()
        .map_err(|_| "Live tracking worker panicked; no complete result is available".to_string())
        .and_then(|result| result);
    let closed = match trace.stop() {
        Ok(()) => Ok(()),
        Err(error) if instance_not_found(&error) => Ok(()),
        Err(error) => Err(format!("Live tracking consumer cleanup failed: {error:?}")),
    };
    match (processed, closed) {
        (Err(processed), Err(closed)) => return Err(format!("{processed}; {closed}")),
        (Err(error), _) | (_, Err(error)) => return Err(error),
        (Ok(()), Ok(())) => {}
    }
    let mut state = state.lock().map_err(|e| e.to_string())?;
    Ok(std::mem::take(&mut *state))
}

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
    let _lifecycle = LIFECYCLE.lock().map_err(|e| e.to_string())?;
    if ensure_restart_allowed(&RUNNING)? {
        stop_slot(&RUNNING, stop_producer, drain_running)?;
    } else {
        let _ = stop_trace_by_name(SESSION); // unchanged crash-leftover cleanup, only without an owned trace
    }
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
    let worker = std::thread::spawn(move || {
        UserTrace::process_from_handle(handle)
            .map_err(|error| format!("Live tracking consumer failed: {error:?}"))
    });
    *RUNNING
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(Owned::Active(Running {
        trace,
        state,
        worker,
    }));
    Ok(())
}

pub fn add_pid(pid: u32, image: String) {
    let Ok(_lifecycle) = LIFECYCLE.lock() else {
        return;
    };
    if let Ok(running) = RUNNING.lock() {
        if let Some(running) = running.as_ref() {
            let state = &running.value().state;
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
    let _lifecycle = LIFECYCLE.lock().map_err(|e| e.to_string())?;
    let s = stop_slot(&RUNNING, stop_producer, drain_running)?;
    let devices = dos_devices();
    let paths = |set: &BTreeSet<String>| {
        set.iter()
            .filter_map(|p| to_drive_path(p, &devices))
            .collect::<Vec<_>>()
    };
    Ok(TrackResult {
        processes: s.processes,
        created_files: paths(&s.created_files),
        created_dirs: paths(&s.created_dirs),
        deleted: paths(&s.deleted),
        created_keys: s.created_keys.into_iter().collect(),
        deleted_keys: s.deleted_keys.into_iter().collect(),
        set_values: s
            .set_values
            .into_iter()
            .map(|((key, name), new)| SetValue { key, name, new })
            .collect(),
        deleted_values: s.deleted_values.into_iter().map(|(k, v)| [k, v]).collect(),
        events: s.events,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        mpsc,
    };
    use std::time::Duration;

    struct Fake {
        state: Arc<Mutex<Vec<&'static str>>>,
        release: mpsc::Sender<()>,
        worker: std::thread::JoinHandle<Result<(), String>>,
    }
    fn drain_fake(fake: Fake) -> Result<Vec<&'static str>, String> {
        fake.worker
            .join()
            .map_err(|_| "worker panic".to_string())??;
        let mut state = fake.state.lock().map_err(|e| e.to_string())?;
        Ok(std::mem::take(&mut *state))
    }
    #[test]
    fn stop_releases_shared_locks_before_join_and_keeps_the_last_callback() {
        let slot = Arc::new(Mutex::new(None::<Owned<Fake>>));
        let callback_slot = slot.clone();
        let state = Arc::new(Mutex::new(vec!["before"]));
        let callback_state = state.clone();
        let (release, receiver) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            receiver.recv().map_err(|e| e.to_string())?;
            let _shared = callback_slot.lock().map_err(|e| e.to_string())?;
            callback_state
                .lock()
                .map_err(|e| e.to_string())?
                .push("tail");
            Ok(())
        });
        *slot.lock().unwrap() = Some(Owned::Active(Fake {
            state,
            release,
            worker,
        }));
        let (completed, result) = mpsc::channel();
        let controller = std::thread::spawn(move || {
            let drained = stop_slot(
                &slot,
                |fake| fake.release.send(()).map_err(|e| e.to_string()),
                drain_fake,
            );
            completed.send(drained).unwrap();
        });
        assert_eq!(
            result
                .recv_timeout(Duration::from_secs(3))
                .unwrap()
                .unwrap(),
            vec!["before", "tail"]
        );
        controller.join().unwrap();
    }
    #[test]
    fn stop_failure_retains_worker_state_and_blocks_restart_until_successful_retry() {
        let slot = Mutex::new(None);
        let state = Arc::new(Mutex::new(vec!["before"]));
        let tail = state.clone();
        let (release, receiver) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            receiver.recv().map_err(|e| e.to_string())?;
            tail.lock().map_err(|e| e.to_string())?.push("tail");
            Ok(())
        });
        *slot.lock().unwrap() = Some(Owned::Active(Fake {
            state: state.clone(),
            release,
            worker,
        }));
        assert_eq!(
            stop_slot(&slot, |_| Err("access denied".into()), drain_fake).unwrap_err(),
            "access denied"
        );
        assert!(ensure_restart_allowed(&slot).is_err());
        assert_eq!(*state.lock().unwrap(), vec!["before"]);
        assert_eq!(
            stop_slot(
                &slot,
                |fake| fake.release.send(()).map_err(|e| e.to_string()),
                drain_fake
            )
            .unwrap(),
            vec!["before", "tail"]
        );
        assert!(!ensure_restart_allowed(&slot).unwrap());
    }
    #[test]
    fn finished_worker_never_proves_a_failed_producer_stop_or_permits_restart() {
        let slot = Mutex::new(Some(Owned::Active(123)));
        assert_eq!(
            stop_slot(&slot, |_| Err("already stopping".into()), |_| Ok(())).unwrap_err(),
            "already stopping"
        );
        assert!(ensure_restart_allowed(&slot).is_err());
        assert!(matches!(*slot.lock().unwrap(), Some(Owned::Stopping(123))));
        assert_eq!(stop_slot(&slot, |_| Ok(()), Ok).unwrap(), 123);
    }
    #[test]
    fn process_error_and_join_panic_never_become_successful_partial_results() {
        for panic in [false, true] {
            let (release, _) = mpsc::channel();
            let worker = std::thread::spawn(move || {
                if panic {
                    panic!("mock worker panic")
                };
                Err("ProcessTrace failed".into())
            });
            let slot = Mutex::new(Some(Owned::Active(Fake {
                state: Arc::new(Mutex::new(vec!["partial"])),
                release,
                worker,
            })));
            assert!(stop_slot(&slot, |_| Ok(()), drain_fake).is_err());
            assert!(slot.lock().unwrap().is_none());
        }
        // Release panic=abort is unchanged. This mock checks join error handling
        // in the test/unwind profile, not recovery from release aborts.
    }
    #[test]
    fn serialized_duplicate_stops_have_exactly_one_owner() {
        let slot = Arc::new(Mutex::new(Some(Owned::Active(7))));
        let lifecycle = Arc::new(Mutex::new(()));
        let calls = Arc::new(AtomicUsize::new(0));
        let workers: Vec<_> = (0..2)
            .map(|_| {
                let (slot, lifecycle, calls) = (slot.clone(), lifecycle.clone(), calls.clone());
                std::thread::spawn(move || {
                    let _guard = lifecycle.lock().unwrap();
                    stop_slot(
                        &slot,
                        |_| {
                            calls.fetch_add(1, Ordering::SeqCst);
                            Ok(())
                        },
                        Ok,
                    )
                })
            })
            .collect();
        let successes = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .filter(Result::is_ok)
            .count();
        assert_eq!(successes, 1);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
    #[test]
    fn only_exact_instance_not_found_codes_count_as_a_stopped_owned_producer() {
        for code in [4201, -2147020695] {
            let error =
                TraceError::EtwNativeError(ferrisetw::native::EvntraceNativeError::IoError(
                    std::io::Error::from_raw_os_error(code),
                ));
            assert!(instance_not_found(&error));
        }
        for code in [5, 234, 2402, -2147024891] {
            let error =
                TraceError::EtwNativeError(ferrisetw::native::EvntraceNativeError::IoError(
                    std::io::Error::from_raw_os_error(code),
                ));
            assert!(!instance_not_found(&error));
        }
    }
}
