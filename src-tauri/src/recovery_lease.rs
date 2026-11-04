//! Cross-process admission for the configured backup journals. Never delete the
//! inert lock file: only the lifetime of its exclusive OS handle grants ownership.
use crate::transfer_recovery as files;
use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::io::AsRawHandle;
use std::path::Path;
use std::sync::{Mutex, OnceLock};

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Marker {
    version: u32,
    operation_id: String,
    #[serde(default)]
    boot_identity: Option<String>,
    #[serde(default)]
    job_name: Option<String>,
    containment: String,
    phase: String,
}
struct Lease {
    file: File,
    _parents: (files::Parents, files::Parents),
    running: bool,
    quarantined: bool,
}
#[derive(Default)]
struct State {
    leases: HashMap<String, Lease>,
}
fn leases() -> &'static Mutex<State> {
    static LEASES: OnceLock<Mutex<State>> = OnceLock::new();
    LEASES.get_or_init(|| Mutex::new(State::default()))
}
fn mark(file: &mut File, marker: Option<&Marker>) -> Result<(), String> {
    let bytes = match marker {
        Some(marker) => serde_json::to_vec(marker).map_err(|e| e.to_string())?,
        None => b"0".to_vec(),
    };
    file.seek(SeekFrom::Start(0))
        .and_then(|_| file.write_all(&bytes))
        .and_then(|_| file.set_len(bytes.len() as u64))
        .and_then(|_| file.sync_all())
        .map_err(|e| format!("Recovery execution marker unavailable: {e}"))
}
/// Bound to exactly one admitted root. Drop retains durable uncertainty.
pub struct ExecutionGuard {
    token: String,
    settled: bool,
}
pub(crate) fn validate(token: &str) -> Result<(), String> {
    let mut state = leases()
        .lock()
        .map_err(|_| "Recovery lease state unavailable")?;
    let lease = state
        .leases
        .get_mut(token)
        .ok_or("Unknown recovery lease")?;
    reconcile(lease)?;
    if lease.running || lease.quarantined {
        return Err("Recovery root busy or quarantined".into());
    }
    lease._parents.0.verify()?;
    lease._parents.1.verify()
}
impl ExecutionGuard {
    #[cfg(test)]
    pub fn begin(token: &str) -> Result<Self, String> {
        Self::begin_impl(token, None)
    }
    pub fn begin_named(token: &str, name: &str) -> Result<Self, String> {
        if !crate::security::ProcessJob::valid_recovery_name(name) {
            return Err("Invalid recovery job name".into());
        }
        Self::begin_impl(token, Some(name))
    }
    fn begin_impl(token: &str, name: Option<&str>) -> Result<Self, String> {
        let mut state = leases()
            .lock()
            .map_err(|_| "Recovery lease state unavailable")?;
        let lease = state
            .leases
            .get_mut(token)
            .ok_or("Unknown recovery lease")?;
        if lease.running || lease.quarantined {
            return Err("Recovery root busy or quarantined".into());
        }
        lease._parents.0.verify()?;
        lease._parents.1.verify()?;
        let marker = Marker {
            version: if name.is_some() { 2 } else { 1 },
            operation_id: crate::broker::random_id()?,
            boot_identity: None,
            job_name: name.map(str::to_owned),
            containment: if name.is_some() {
                "named-job-v2"
            } else {
                "gated-job-v1"
            }
            .into(),
            phase: "authorization-intent".into(),
        };
        // No authorization has been sent yet. A failed durable write cannot
        // have launched the target; retain a corrupt marker for restart review.
        if let Err(error) = mark(&mut lease.file, Some(&marker)) {
            lease.quarantined = true;
            return Err(error);
        }
        lease.running = true;
        Ok(Self {
            token: token.into(),
            settled: false,
        })
    }
    pub fn confirm(mut self) -> Result<(), String> {
        let mut state = leases()
            .lock()
            .map_err(|_| "Recovery lease state unavailable")?;
        let lease = state
            .leases
            .get_mut(&self.token)
            .ok_or("Unknown recovery lease")?;
        lease._parents.0.verify()?;
        lease._parents.1.verify()?;
        mark(&mut lease.file, None)?;
        lease.running = false;
        self.settled = true;
        Ok(())
    }
}
impl Drop for ExecutionGuard {
    fn drop(&mut self) {
        if !self.settled {
            if let Ok(mut state) = leases().lock() {
                if let Some(lease) = state.leases.get_mut(&self.token) {
                    lease.running = false;
                    lease.quarantined = true;
                }
            }
        }
    }
}
fn marker_closed(bytes: &[u8]) -> Result<bool, String> {
    let previous: Marker = serde_json::from_slice(bytes).map_err(|_| {
        "Recovery quarantined: malformed or legacy execution marker; reconciliation required"
    })?;
    if previous.version != 2
        || previous.containment != "named-job-v2"
        || previous.phase != "authorization-intent"
        || previous.operation_id.len() != 32
        || !previous.operation_id.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err(
            "Recovery quarantined: unsupported execution marker; reconciliation required".into(),
        );
    }
    crate::security::ProcessJob::recovery_closed(
        previous
            .job_name
            .as_deref()
            .ok_or("Missing recovery job name; reconciliation required")?,
    )
}

fn reconcile(lease: &mut Lease) -> Result<(), String> {
    if !lease.quarantined || lease.running {
        return Ok(());
    }
    lease._parents.0.verify()?;
    lease._parents.1.verify()?;
    lease
        .file
        .seek(SeekFrom::Start(0))
        .map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    (&mut lease.file)
        .take(4097)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if marker_closed(&bytes)? {
        mark(&mut lease.file, None)?;
        lease.quarantined = false;
    }
    Ok(())
}
pub fn acquire(root: &Path) -> Result<String, String> {
    let mut state = leases()
        .lock()
        .map_err(|_| "Recovery lease state unavailable")?;
    // Reject redirected configured ancestors before canonicalization can hide
    // them. Keep both sets of pins alive through release.
    let requested = root.join("recovery.lock");
    crate::security::checked_path(requested.to_str().ok_or("Invalid recovery root")?)?;
    let configured_parents = files::Parents::open(&requested)
        .map_err(|e| format!("Recovery configured parent pins: {e}"))?;
    let path = files::canonical(
        root.join("recovery.lock")
            .to_str()
            .ok_or("Invalid recovery root")?,
    )?;
    let parents = files::Parents::open(&path).map_err(|e| format!("Recovery parent pins: {e}"))?;
    let mut file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .share_mode(0)
        .custom_flags(0x00200000)
        .open(&path)
        .map_err(|e| format!("Recovery busy or unavailable; no operation was started: {e}"))?;
    files::identity(&file, false)?;
    files::verify_path(&file, &path)?;
    let mut marker = Vec::new();
    (&mut file)
        .take(4097)
        .read_to_end(&mut marker)
        .map_err(|e| e.to_string())?;
    if !marker.is_empty() && marker != b"0" {
        if !marker_closed(&marker)? {
            return Err(
                "Recovery quarantined after interrupted execution; reconciliation required".into(),
            );
        }
        // Only execution quarantine is reconciled; pending journals are untouched.
        parents.verify()?;
        configured_parents.verify()?;
        mark(&mut file, None)?;
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn SetHandleInformation(handle: *mut std::ffi::c_void, mask: u32, flags: u32) -> i32;
    }
    // The File owns this valid handle; clear HANDLE_FLAG_INHERIT explicitly.
    if unsafe { SetHandleInformation(file.as_raw_handle(), 1, 0) } == 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    parents.verify()?;
    configured_parents.verify()?;
    let token = crate::broker::random_id()?;
    state.leases.insert(
        token.clone(),
        Lease {
            file,
            running: false,
            quarantined: false,
            _parents: (parents, configured_parents),
        },
    );
    Ok(token)
}
pub fn release(token: &str) -> Result<(), String> {
    let mut state = leases()
        .lock()
        .map_err(|_| "Recovery lease state unavailable")?;
    if let Some(lease) = state.leases.get_mut(token) {
        reconcile(lease)?;
    }
    if state
        .leases
        .get(token)
        .is_some_and(|lease| lease.running || lease.quarantined)
    {
        return Err("Recovery busy or quarantined; lease retained for reconciliation".into());
    }
    state
        .leases
        .remove(token)
        .ok_or("Unknown or already released recovery lease")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn short_spelling_keeps_configured_parent_pins() {
        use std::os::windows::ffi::OsStrExt;
        #[link(name = "kernel32")]
        extern "system" {
            fn GetShortPathNameW(long: *const u16, short: *mut u16, size: u32) -> u32;
        }
        let root = std::env::temp_dir().join(format!(
            "purgeon-recovery-short-{}",
            crate::broker::random_id().unwrap()
        ));
        std::fs::create_dir(&root).unwrap();
        let long: Vec<u16> = root.as_os_str().encode_wide().chain(Some(0)).collect();
        let mut short = vec![0u16; 32768];
        let n = unsafe { GetShortPathNameW(long.as_ptr(), short.as_mut_ptr(), short.len() as u32) }
            as usize;
        assert!(n > 0 && n < short.len());
        let alias = std::path::PathBuf::from(String::from_utf16(&short[..n]).unwrap());
        assert_ne!(alias, root, "Fixture requires a distinct short-path alias");
        let token = acquire(&alias).unwrap();
        validate(&token).unwrap();
        release(&token).unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn ordinary_exec_outlives_recovery_deadline() {
        if isolated("recovery_lease::tests::ordinary_exec_outlives_recovery_deadline") {
            return;
        }
        use std::os::windows::process::CommandExt;
        use std::time::{Duration, Instant};
        let mut command =
            std::process::Command::new(crate::windows_tools::command("powershell.exe"));
        command
            .args(["-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Milliseconds 1500;[Console]::Out.Write('ordinary');[Console]::Error.Write('fixture');exit 7"])
            .creation_flags(crate::CREATE_NO_WINDOW);
        let limit = Duration::from_millis(500);
        let start = Instant::now();
        let output = crate::dispatch_exec(&mut command, None, limit).unwrap();
        assert!(start.elapsed() > limit);
        assert_eq!(output.status.code(), Some(7));
        assert_eq!(output.stdout, b"ordinary");
        assert_eq!(output.stderr, b"fixture");
        assert_eq!(
            crate::dispatch_exec(&mut command, Some("invalid-token"), limit).unwrap_err(),
            "Unknown recovery lease"
        );
        let root = std::env::temp_dir().join(format!(
            "purgeon-exec-deadline-{}",
            crate::broker::random_id().unwrap()
        ));
        std::fs::create_dir(&root).unwrap();
        let token = acquire(&root).unwrap();
        let start = Instant::now();
        let error = crate::dispatch_exec(&mut command, Some(&token), limit).unwrap_err();
        assert!(
            error.contains("timeout") || error.contains("timed out") || error.contains("deadline"),
            "{error}"
        );
        assert!(start.elapsed() < Duration::from_secs(6));
        release(&token).unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn named_job_reconciles_token_and_preserves_pending_bytes() {
        if isolated("recovery_lease::tests::named_job_reconciles_token_and_preserves_pending_bytes")
        {
            return;
        }
        let root = std::env::temp_dir().join(format!(
            "purgeon-named-{}",
            crate::broker::random_id().unwrap()
        ));
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("pending.json"), b"unchanged\0journal").unwrap();
        let token = acquire(&root).unwrap();
        let name = crate::security::ProcessJob::recovery_name().unwrap();
        let job = crate::security::ProcessJob::create(Some(&name)).unwrap();
        assert!(crate::security::ProcessJob::create(Some(&name)).is_err());
        let guard = ExecutionGuard::begin_named(&token, &name).unwrap();
        drop(guard);
        // An empty job also proves closure while its coordinator still lives.
        validate(&token).unwrap();
        release(&token).unwrap();
        drop(job);
        assert!(crate::security::ProcessJob::recovery_closed(&name).unwrap());
        let token = acquire(&root).unwrap();
        let mut command = std::process::Command::new(crate::windows_tools::command("cmd.exe"));
        command.args(["/c", "exit 7"]);
        let result = crate::recovery_worker::execute(
            &token,
            &command,
            None,
            std::time::Duration::from_secs(10),
        )
        .unwrap();
        assert_eq!(result.status.code(), Some(7));
        validate(&token).unwrap();
        release(&token).unwrap();
        assert_eq!(
            std::fs::read(root.join("pending.json")).unwrap(),
            b"unchanged\0journal"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn named_marker_restart_observation_and_live_members() {
        if isolated("recovery_lease::tests::named_marker_restart_observation_and_live_members") {
            return;
        }
        let root = std::env::temp_dir().join(format!(
            "purgeon-observe-{}",
            crate::broker::random_id().unwrap()
        ));
        std::fs::create_dir(&root).unwrap();
        let token = acquire(&root).unwrap();
        let name = crate::security::ProcessJob::recovery_name().unwrap();
        let job = crate::security::ProcessJob::create(Some(&name)).unwrap();
        let mut child = std::process::Command::new(crate::windows_tools::command("powershell.exe"))
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Start-Sleep -Seconds 30",
            ])
            .spawn()
            .unwrap();
        job.assign_child(&child).unwrap();
        drop(ExecutionGuard::begin_named(&token, &name).unwrap());
        assert!(!crate::security::ProcessJob::recovery_closed(&name).unwrap());
        assert!(validate(&token).is_err());
        // Simulate the next coordinator opening the durable file; the original
        // job and member remain live, so no PID or uptime inference can clear it.
        leases().lock().unwrap().leases.remove(&token);
        assert!(acquire(&root).is_err());
        drop(job);
        child.wait().unwrap();
        let successor = acquire(&root).unwrap();
        release(&successor).unwrap();
        assert!(crate::security::ProcessJob::recovery_closed(&name).unwrap());
        std::fs::remove_dir_all(root).unwrap();
    }
    fn isolated(name: &str) -> bool {
        const KEY: &str = "PURGEON_LEASE_ISOLATED";
        if std::env::var(KEY).as_deref() == Ok(name) {
            return false;
        }
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", name, "--nocapture"])
            .env(KEY, name)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        true
    }
    #[test]
    fn exclusive_cross_process_and_abrupt_exit() {
        if isolated("recovery_lease::tests::exclusive_cross_process_and_abrupt_exit") {
            return;
        }
        const ENV: &str = "PURGEON_RECOVERY_LEASE_TEST_ROOT";
        if let Ok(root) = std::env::var(ENV) {
            let token = acquire(Path::new(&root));
            match std::env::var("PURGEON_RECOVERY_LEASE_TEST_MODE")
                .unwrap()
                .as_str()
            {
                "busy" => assert!(token.unwrap_err().contains("busy")),
                "refused" => assert!(token.is_err()),
                "exit" => {
                    assert!(token.is_ok());
                    std::fs::write(Path::new(&root).join("pending.json"), b"scratch pending")
                        .unwrap();
                    std::process::exit(0);
                }
                "dirty-exit" => {
                    assert!(token.is_ok());
                    let _execution = ExecutionGuard::begin(token.as_ref().unwrap()).unwrap();
                    // Deliberately bypass job containment for this inert
                    // fixture: demonstrate that durable admission stays closed
                    // even while an orphan could still write a scratch marker.
                    use std::os::windows::process::CommandExt;
                    let marker = Path::new(&root).join("orphan-finished");
                    std::process::Command::new(crate::windows_tools::command("powershell.exe"))
                        .args([
                            "-NoProfile",
                            "-NonInteractive",
                            "-Command",
                            &format!(
                                "$deadline=[DateTime]::UtcNow.AddSeconds(60);while (!(Test-Path -LiteralPath '{}') -and [DateTime]::UtcNow -lt $deadline) {{ Start-Sleep -Milliseconds 20 }};if (Test-Path -LiteralPath '{}') {{ [IO.File]::WriteAllText('{}','finished') }}",
                                Path::new(&root).join("orphan-continue").to_string_lossy().replace('\'', "''"),
                                Path::new(&root).join("orphan-continue").to_string_lossy().replace('\'', "''"),
                                marker.to_string_lossy().replace('\'', "''")
                            ),
                        ])
                        .stdin(std::process::Stdio::null())
                        .stdout(std::process::Stdio::null())
                        .stderr(std::process::Stdio::null())
                        .creation_flags(0x08000000)
                        .spawn()
                        .unwrap();
                    std::process::exit(0);
                }
                _ => release(&token.unwrap()).unwrap(),
            }
            return;
        }
        let root = std::env::temp_dir().join(format!(
            "purgeon-recovery-{}",
            crate::broker::random_id().unwrap()
        ));
        std::fs::create_dir(&root).unwrap();
        let independent = root.join("independent");
        std::fs::create_dir(&independent).unwrap();
        let run = |path: &Path, mode| {
            std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "recovery_lease::tests::exclusive_cross_process_and_abrupt_exit",
                    "--nocapture",
                ])
                .env(ENV, path)
                .env("PURGEON_RECOVERY_LEASE_TEST_MODE", mode)
                .status()
                .unwrap()
        };
        let token = acquire(&root).unwrap();
        assert!(acquire(&root).is_err());
        assert!(run(&root, "busy").success());
        // A syntactic alias cannot acquire a second handle to the same file.
        assert!(run(&root.join("independent").join(".."), "refused").success());
        assert!(run(&independent, "available").success());
        release(&token).unwrap();
        assert!(release(&token).is_err());
        assert!(run(&root, "exit").success());
        let token = acquire(&root).unwrap();
        assert_eq!(
            std::fs::read(root.join("pending.json")).unwrap(),
            b"scratch pending"
        );
        release(&token).unwrap();
        let token = acquire(&root).unwrap();
        let execution = ExecutionGuard::begin(&token).unwrap();
        assert!(release(&token).unwrap_err().contains("retained"));
        let independent_token = acquire(&independent).unwrap();
        release(&independent_token).unwrap();
        execution.confirm().unwrap();
        release(&token).unwrap();
        assert!(run(&root, "dirty-exit").success());
        assert!(!root.join("orphan-finished").exists());
        assert!(acquire(&root).unwrap_err().contains("reconciliation"));
        std::fs::write(root.join("orphan-continue"), b"continue").unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
        while !root.join("orphan-finished").exists() {
            assert!(
                std::time::Instant::now() < deadline,
                "inert orphan fixture did not finish"
            );
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert!(acquire(&root).unwrap_err().contains("reconciliation"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn hardlinked_lock_is_refused() {
        if isolated("recovery_lease::tests::hardlinked_lock_is_refused") {
            return;
        }
        let root = std::env::temp_dir().join(format!(
            "purgeon-recovery-links-{}",
            crate::broker::random_id().unwrap()
        ));
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("source"), b"fixture").unwrap();
        std::fs::hard_link(root.join("source"), root.join("recovery.lock")).unwrap();
        let error = acquire(&root).unwrap_err();
        assert!(error.contains("hardlinks"), "{error}");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn foreign_tokens_never_start_execution() {
        assert!(ExecutionGuard::begin("unknown").is_err());
        assert!(release("unknown").unwrap_err().contains("Unknown"));
    }

    #[test]
    fn quarantine_is_scoped_and_ordinary_reads_remain_available() {
        if isolated(
            "recovery_lease::tests::quarantine_is_scoped_and_ordinary_reads_remain_available",
        ) {
            return;
        }
        let root = std::env::temp_dir().join(format!(
            "purgeon-scope-{}",
            crate::broker::random_id().unwrap()
        ));
        let other = root.join("other");
        std::fs::create_dir_all(&other).unwrap();
        let first = acquire(&root).unwrap();
        let second = acquire(&other).unwrap();
        let first_execution = ExecutionGuard::begin(&first).unwrap();
        let second_execution = ExecutionGuard::begin(&second).unwrap();
        drop(first_execution);
        assert!(validate(&first).is_err());
        assert!(release(&first).is_err());
        assert!(acquire(&root).is_err());
        second_execution.confirm().unwrap();
        release(&second).unwrap();
        let second = acquire(&other).unwrap();
        release(&second).unwrap();
        let mut missing = std::process::Command::new("purgeon-inert-missing-fixture.exe");
        let error =
            crate::process_io::execute(&mut missing, None, std::time::Duration::from_secs(1))
                .unwrap_err();
        assert!(!error.contains("quarantined"));
        let mut state = leases().lock().unwrap();
        state.leases.remove(&first); // Test-only process teardown; dirty evidence stays.
        drop(state);
        assert!(acquire(&root).unwrap_err().contains("reconciliation"));
        std::fs::remove_dir_all(root).unwrap();
    }
}
