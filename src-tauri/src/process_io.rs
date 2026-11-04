//! Bounded retention without closing a live child's pipes at the output cap.
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

pub const INPUT_LIMIT: usize = 16 * 1024 * 1024;
const OUTPUT_LIMIT: usize = 64 * 1024 * 1024;

#[cfg(test)]
type SpawnHook = Box<dyn FnOnce(&std::process::Child)>;
#[cfg(test)]
thread_local! {
    // Consumed by one invocation on this thread; never changes process environment.
    pub(crate) static AFTER_AUTHORIZATION: std::cell::RefCell<Option<SpawnHook>> = const { std::cell::RefCell::new(None) };
    pub(crate) static AFTER_SPAWN: std::cell::RefCell<Option<SpawnHook>> = const { std::cell::RefCell::new(None) };
}

pub fn validate_input(input: Option<&str>) -> Result<(), String> {
    if input.is_some_and(|value| value.len() > INPUT_LIMIT) {
        Err("Command input exceeds limit".into())
    } else {
        Ok(())
    }
}

fn drain(mut reader: impl Read, cap: usize) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    let mut buffer = [0u8; 65536];
    let mut exceeded = false;
    loop {
        let length = match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(length) => length,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error.to_string()),
        };
        let keep = length.min(cap.saturating_sub(bytes.len()));
        bytes.extend_from_slice(&buffer[..keep]);
        exceeded |= keep != length;
        // The rest is discarded, but reading continues to EOF so the cap does
        // not change the child's execution or create pipe backpressure.
    }
    if exceeded {
        Err("Command output exceeds limit".into())
    } else {
        Ok(bytes)
    }
}

pub fn execute(
    command: &mut Command,
    input: Option<String>,
    timeout: Duration,
) -> Result<Output, String> {
    execute_bounded(command, input, timeout, OUTPUT_LIMIT)
}

fn execute_bounded(
    command: &mut Command,
    input: Option<String>,
    timeout: Duration,
    cap: usize,
) -> Result<Output, String> {
    crate::recovery_worker::execute_ordinary(command, input, timeout, cap)
}

#[cfg(test)]
pub(crate) fn execute_authorized(
    command: &mut Command,
    input: Option<String>,
    timeout: Duration,
    cap: usize,
    authorize: impl FnOnce(&std::process::Child) -> Result<(), String>,
) -> Result<Output, String> {
    execute_in_job(command, input, timeout, cap, None, authorize)
}

pub(crate) fn execute_in_job(
    command: &mut Command,
    input: Option<String>,
    timeout: Duration,
    cap: usize,
    existing_job: Option<&crate::security::ProcessJob>,
    authorize: impl FnOnce(&std::process::Child) -> Result<(), String>,
) -> Result<Output, String> {
    validate_input(input.as_deref())?;
    let mut child = match command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            return Err(error.to_string());
        }
    };
    #[cfg(test)]
    AFTER_SPAWN.with(|slot| {
        if let Some(hook) = slot.borrow_mut().take() {
            hook(&child);
        }
    });
    let start = Instant::now();
    let owned_job;
    let assignment = match existing_job {
        Some(job) => job.assign_child(&child).map(|()| None),
        None => crate::security::ProcessJob::assign(&child).map(Some),
    };
    let job = match assignment {
        Ok(job) => {
            owned_job = job;
            existing_job.or(owned_job.as_ref()).unwrap()
        }
        Err(error) => {
            let killed = child.kill();
            let deadline = Instant::now() + Duration::from_secs(5);
            while matches!(child.try_wait(), Ok(None)) && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(10));
            }
            // Generic callers have no recovery admission state. Recovery uses
            // an inert worker here and has not sent authorization yet.
            return Err(format!(
                "Command job assignment failed: {error}; root kill: {killed:?}"
            ));
        }
    };
    let mut workers = Vec::new();
    let outcome = (|| {
        authorize(&child)?;
        #[cfg(test)]
        AFTER_AUTHORIZATION.with(|slot| {
            if let Some(hook) = slot.borrow_mut().take() {
                hook(&child);
            }
        });
        let pipes = (child.stdin.take(), child.stdout.take(), child.stderr.take());
        let (Some(mut stdin), Some(stdout), Some(stderr)) = pipes else {
            return Err("Missing command pipe".into());
        };
        workers.push(
            std::thread::Builder::new()
                .name("command-input".into())
                .spawn(move || {
                    if let Some(input) = input {
                        stdin
                            .write_all(input.as_bytes())
                            .map_err(|e| e.to_string())?;
                    }
                    Ok::<_, String>(Vec::new())
                })
                .map_err(|e| e.to_string())?,
        );
        workers.push(
            std::thread::Builder::new()
                .name("command-output".into())
                .spawn(move || drain(stdout, cap))
                .map_err(|e| e.to_string())?,
        );
        workers.push(
            std::thread::Builder::new()
                .name("command-error".into())
                .spawn(move || drain(stderr, cap))
                .map_err(|e| e.to_string())?,
        );
        loop {
            match child.try_wait() {
                Ok(Some(status)) => return Ok(status),
                Err(error) => return Err(error.to_string()),
                Ok(None) => {}
            }
            if start.elapsed() >= timeout {
                return Err("Command timeout; inspect the operation before retrying".into());
            }
            std::thread::sleep(Duration::from_millis(30));
        }
    })();
    let cleanup_deadline = Instant::now() + Duration::from_secs(5);
    if let Err(error) = job.terminate_and_confirm(cleanup_deadline) {
        return Err(format!(
            "Command containment unconfirmed: {error}; command outcome: {outcome:?}"
        ));
    }
    // A worker can be blocked even after the root exits. Never join without
    // observing completion. Recovery callers retain their own uncertainty state.
    while workers.iter().any(|worker| !worker.is_finished()) {
        if Instant::now() >= cleanup_deadline {
            return Err(format!(
                "Command pipe shutdown unconfirmed; command outcome: {outcome:?}"
            ));
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let mut results = workers
        .into_iter()
        .map(|worker| {
            worker
                .join()
                .map_err(|_| "Command pipe worker failed".to_string())
                .and_then(|result| result)
        })
        .collect::<Vec<_>>();
    let status = outcome?;
    if results.len() != 3 {
        return Err("Missing command pipe worker".into());
    }
    let stderr = results.pop().unwrap();
    let stdout = results.pop().unwrap();
    results.pop().unwrap()?;
    Ok(Output {
        status,
        stdout: stdout?,
        stderr: stderr?,
    })
}

pub(crate) fn recovery_output_limit() -> usize {
    OUTPUT_LIMIT
}

pub fn copy_hash(mut reader: impl Read, mut writer: impl Write) -> Result<(u64, Vec<u8>), String> {
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 65536];
    let mut copied = 0u64;
    loop {
        let length = match reader.read(&mut buffer) {
            Ok(length) => length,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error.to_string()),
        };
        if length == 0 {
            break;
        }
        writer
            .write_all(&buffer[..length])
            .map_err(|e| e.to_string())?;
        digest.update(&buffer[..length]);
        copied = copied
            .checked_add(length as u64)
            .ok_or("Copied file size overflow")?;
    }
    Ok((copied, digest.finalize().to_vec()))
}
pub fn hash_reader(mut reader: impl Read) -> Result<Vec<u8>, String> {
    let (_, hash) = copy_hash(&mut reader, std::io::sink())?;
    Ok(hash)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{self, Cursor};
    use std::os::windows::process::CommandExt;
    fn child(script: &str) -> Command {
        let mut command = Command::new(crate::windows_tools::command("powershell.exe"));
        command
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .creation_flags(0x08000000);
        command
    }
    #[test]
    fn ordinary_spawn_boundary_contains_early_descendant() {
        spawn_boundary(true);
    }
    #[test]
    fn old_launch_negative_control_escapes_the_same_boundary() {
        spawn_boundary(false);
    }
    fn spawn_boundary(ordinary: bool) {
        use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
        use std::{cell::RefCell, rc::Rc};
        #[link(name = "kernel32")]
        extern "system" {
            fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut std::ffi::c_void;
            fn WaitForSingleObject(handle: *mut std::ffi::c_void, milliseconds: u32) -> u32;
            fn TerminateProcess(handle: *mut std::ffi::c_void, code: u32) -> i32;
            fn DuplicateHandle(
                source: *mut std::ffi::c_void,
                handle: *mut std::ffi::c_void,
                target: *mut std::ffi::c_void,
                result: *mut *mut std::ffi::c_void,
                access: u32,
                inherit: i32,
                options: u32,
            ) -> i32;
            fn GetCurrentProcess() -> *mut std::ffi::c_void;
        }
        struct Fixture {
            directory: std::path::PathBuf,
            handles: Vec<OwnedHandle>,
        }
        impl Drop for Fixture {
            fn drop(&mut self) {
                // Kill only retained original handles, including on assertion failure.
                for handle in &self.handles {
                    unsafe {
                        TerminateProcess(handle.as_raw_handle(), 1);
                        assert_eq!(WaitForSingleObject(handle.as_raw_handle(), 5000), 0);
                    }
                }
                let _ = std::fs::remove_dir_all(&self.directory);
            }
        }
        let directory = std::env::temp_dir().join(format!(
            "purgeon-spawn-boundary-{}",
            crate::broker::random_id().unwrap()
        ));
        std::fs::create_dir(&directory).unwrap();
        let fixture = Rc::new(RefCell::new(Fixture {
            directory,
            handles: Vec::new(),
        }));
        let path = fixture
            .borrow()
            .directory
            .to_string_lossy()
            .replace('\'', "''");
        // No admission gate: the old target immediately attempts descendant creation.
        // PID-ready is published only after WriteAllText closes the PID file.
        let mut command = child(&format!("$ErrorActionPreference='Stop';$s=New-Object Diagnostics.ProcessStartInfo;$s.FileName=([Environment]::SystemDirectory+'\\WindowsPowerShell\\v1.0\\powershell.exe');$s.Arguments='-NoProfile -NonInteractive -Command \"Start-Sleep -Seconds 60\"';$s.UseShellExecute=$false;$s.CreateNoWindow=$true;$s.RedirectStandardOutput=$true;$s.RedirectStandardError=$true;$p=[Diagnostics.Process]::Start($s);[IO.File]::WriteAllText('{path}\\pid',[string]$p.Id);[IO.File]::Open('{path}\\pid-ready',[IO.FileMode]::CreateNew).Dispose();while(-not [IO.File]::Exists('{path}\\release')){{Start-Sleep -Milliseconds 10}}"));
        command.env(
            "PURGEON_TEST_WORKER_READY",
            fixture.borrow().directory.join("worker-ready"),
        );
        let monitor_directory = fixture.borrow().directory.clone();
        let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel(1);
        let monitor = std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(20);
            while !monitor_directory.join("pid-ready").exists() {
                assert!(Instant::now() < deadline, "descendant publication timeout");
                std::thread::sleep(Duration::from_millis(10));
            }
            let pid: u32 = std::fs::read_to_string(monitor_directory.join("pid"))
                .unwrap()
                .parse()
                .unwrap();
            let handle = unsafe { OpenProcess(0x00100001, 0, pid) };
            assert!(
                !handle.is_null(),
                "OpenProcess: {}",
                io::Error::last_os_error()
            );
            let handle = unsafe { OwnedHandle::from_raw_handle(handle) };
            assert_eq!(
                unsafe { WaitForSingleObject(handle.as_raw_handle(), 0) },
                258
            );
            ready_tx.send(handle).unwrap();
        });
        let captured = fixture.clone();
        let boundary = Rc::new(RefCell::new(Ok(())));
        let observation = boundary.clone();
        AFTER_SPAWN.with(|slot| {
            *slot.borrow_mut() = Some(Box::new(move |root| {
                let mut root_handle = std::ptr::null_mut();
                let this = unsafe { GetCurrentProcess() };
                assert_ne!(
                    unsafe {
                        DuplicateHandle(this, root.as_raw_handle(), this, &mut root_handle, 0, 0, 2)
                    },
                    0
                );
                captured
                    .borrow_mut()
                    .handles
                    .push(unsafe { OwnedHandle::from_raw_handle(root_handle) });
                let deadline = Instant::now() + Duration::from_secs(20);
                while !captured.borrow().directory.join("pid-ready").exists()
                    && !captured.borrow().directory.join("worker-ready").exists()
                {
                    if Instant::now() >= deadline {
                        *observation.borrow_mut() =
                            Err("SETUP BLOCKED: target never published descendant readiness");
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(10));
                }
            }))
        });
        let captured = fixture.clone();
        let observation = boundary.clone();
        AFTER_AUTHORIZATION.with(|slot| {
            *slot.borrow_mut() = Some(Box::new(move |_| {
                match ready_rx.recv_timeout(Duration::from_secs(20)) {
                    Ok(handle) => {
                        captured.borrow_mut().handles.push(handle);
                        std::fs::File::create_new(captured.borrow().directory.join("release"))
                            .unwrap();
                    }
                    Err(_) => {
                        *observation.borrow_mut() = Err("original descendant handle not ready");
                    }
                }
            }));
        });
        let result = if ordinary {
            execute(&mut command, None, Duration::from_secs(20))
        } else {
            execute_in_job(
                &mut command,
                None,
                Duration::from_secs(20),
                OUTPUT_LIMIT,
                None,
                |_| Ok(()),
            )
        };
        eprintln!(
            "spawn boundary ordinary={ordinary}; stage={:?}; executor={result:?}",
            boundary.borrow()
        );
        monitor
            .join()
            .expect("descendant monitor failed; see executor diagnostic above");
        assert!(
            boundary.borrow().is_ok(),
            "{:?}; executor: {result:?}",
            boundary.borrow()
        );
        if ordinary {
            assert!(
                result.as_ref().is_ok_and(|output| output.status.success()),
                "{result:?}"
            );
        }
        let handles = fixture.borrow();
        assert_eq!(handles.handles.len(), 2);
        assert_eq!(
            unsafe { WaitForSingleObject(handles.handles[0].as_raw_handle(), 0) },
            0
        );
        // Termination is asynchronous: allow a bounded wait for the positive
        // case, while the old-launch control must still be alive immediately.
        assert_eq!(unsafe { WaitForSingleObject(handles.handles[1].as_raw_handle(), if ordinary { 5000 } else { 0 }) }, if ordinary { 0 } else { 258 },
            "original descendant escaped the executor's specific owned job after pre-assignment dispatch");
    }
    #[test]
    fn ordinary_contract_preserves_unicode_input_environment_directory_and_spawn_errors() {
        let directory = std::env::temp_dir().join(format!(
            "purgeon-ordinary-contract-{}",
            crate::broker::random_id().unwrap()
        ));
        std::fs::create_dir(&directory).unwrap();
        let mut command = child("[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);[Console]::InputEncoding=[Text.UTF8Encoding]::new($false);[Console]::Out.Write([Console]::In.ReadToEnd());[Console]::Out.Write($env:PURGEON_VALUE);[Console]::Out.Write([Environment]::CurrentDirectory);[Console]::Error.Write('failure');if($env:PATH){exit 9};exit 7");
        command
            .current_dir(&directory)
            .env("PURGEON_VALUE", "quoted \"value\" é")
            .env_remove("PATH");
        let output = execute(
            &mut command,
            Some("input é\n".into()),
            Duration::from_secs(20),
        )
        .unwrap();
        assert_eq!(output.status.code(), Some(7));
        assert_eq!(output.stderr, b"failure");
        assert_eq!(
            String::from_utf8(output.stdout).unwrap(),
            format!("input é\nquoted \"value\" é{}", directory.display())
        );
        std::fs::remove_dir(directory).unwrap();
        let mut missing = Command::new("purgeon-synthetic-nonexistent-target.exe");
        assert!(execute(&mut missing, None, Duration::from_secs(20)).is_err());
    }
    #[test]
    fn ordinary_authentication_failure_never_dispatches_target() {
        let marker = std::env::temp_dir().join(format!(
            "purgeon-no-dispatch-{}",
            crate::broker::random_id().unwrap()
        ));
        let mut command = child(&format!(
            "[IO.File]::WriteAllText('{}','dispatched')",
            marker.to_string_lossy().replace('\'', "''")
        ));
        crate::recovery_worker::REJECT_NEXT_PEER.with(|flag| flag.set(true));
        assert_eq!(
            execute(&mut command, None, Duration::from_secs(20)).unwrap_err(),
            "Recovery worker authentication failed"
        );
        assert!(!marker.exists());
    }
    #[test]
    fn ordinary_assignment_failure_never_dispatches_target() {
        use std::os::windows::io::AsRawHandle;
        #[link(name = "kernel32")]
        extern "system" {
            fn TerminateProcess(handle: *mut std::ffi::c_void, code: u32) -> i32;
            fn WaitForSingleObject(handle: *mut std::ffi::c_void, milliseconds: u32) -> u32;
        }
        AFTER_SPAWN.with(|slot| {
            *slot.borrow_mut() = Some(Box::new(|child| {
                assert_ne!(unsafe { TerminateProcess(child.as_raw_handle(), 1) }, 0);
                assert_eq!(
                    unsafe { WaitForSingleObject(child.as_raw_handle(), 5000) },
                    0
                );
            }))
        });
        let marker = std::env::temp_dir().join(format!(
            "purgeon-no-assignment-{}",
            crate::broker::random_id().unwrap()
        ));
        let mut command = child(&format!(
            "[IO.File]::WriteAllText('{}','dispatched')",
            marker.to_string_lossy().replace('\'', "''")
        ));
        let error = execute(&mut command, None, Duration::from_secs(20)).unwrap_err();
        assert!(
            error.starts_with("Command job assignment failed:"),
            "{error}"
        );
        assert!(!marker.exists());
    }
    #[test]
    fn ordinary_parent_death_terminates_original_target() {
        use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
        #[link(name = "kernel32")]
        extern "system" {
            fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut std::ffi::c_void;
            fn WaitForSingleObject(handle: *mut std::ffi::c_void, milliseconds: u32) -> u32;
            fn TerminateProcess(handle: *mut std::ffi::c_void, code: u32) -> i32;
        }
        const KEY: &str = "PURGEON_ORDINARY_PARENT_FIXTURE";
        if let Ok(directory) = std::env::var(KEY) {
            let path = directory.replace('\'', "''");
            let mut command = child(&format!("[IO.File]::WriteAllText('{path}\\pid',[string]$PID);[IO.File]::Open('{path}\\ready',[IO.FileMode]::CreateNew).Dispose();Start-Sleep -Seconds 60"));
            let _ = execute(&mut command, None, Duration::from_secs(40));
            panic!("parent fixture should be terminated by its owner");
        }
        let directory = std::env::temp_dir().join(format!(
            "purgeon-ordinary-parent-{}",
            crate::broker::random_id().unwrap()
        ));
        std::fs::create_dir(&directory).unwrap();
        let mut parent = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "process_io::tests::ordinary_parent_death_terminates_original_target",
                "--nocapture",
            ])
            .env(KEY, &directory)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(15);
        while !directory.join("ready").exists() {
            if Instant::now() >= deadline {
                parent.kill().unwrap();
                parent.wait().unwrap();
                panic!("parent fixture target readiness timeout");
            }
            std::thread::yield_now();
        }
        let pid: u32 = std::fs::read_to_string(directory.join("pid"))
            .unwrap()
            .parse()
            .unwrap();
        let handle = unsafe { OpenProcess(0x00100001, 0, pid) };
        assert!(!handle.is_null());
        let target = unsafe { OwnedHandle::from_raw_handle(handle) };
        assert_eq!(
            unsafe { WaitForSingleObject(target.as_raw_handle(), 0) },
            258
        );
        parent.kill().unwrap();
        parent.wait().unwrap();
        let wait = unsafe { WaitForSingleObject(target.as_raw_handle(), 5000) };
        if wait != 0 {
            unsafe {
                TerminateProcess(target.as_raw_handle(), 1);
                WaitForSingleObject(target.as_raw_handle(), 5000);
            }
        }
        std::fs::remove_dir_all(directory).unwrap();
        assert_eq!(wait, 0, "original ordinary target survived parent death");
    }
    #[test]
    fn ordinary_frames_larger_than_recovery_ceiling_preserve_environment() {
        let mut command = child("[Console]::Out.Write($env:PURGEON_LARGE.Length)");
        command.env("PURGEON_LARGE", "\"".repeat(150_000));
        let output = execute(&mut command, None, Duration::from_secs(20)).unwrap();
        assert!(output.status.success());
        assert_eq!(output.stdout, b"150000");
    }
    #[test]
    fn utf8_input_limit_is_exact_and_checked_before_spawn() {
        let accepted = "é".repeat(INPUT_LIMIT / 2);
        assert_eq!(accepted.len(), INPUT_LIMIT);
        assert!(validate_input(Some(&accepted)).is_ok());
        let oversized = accepted + "a";
        let mut nonexistent = Command::new("purgeon-test-must-never-spawn-invalid-input.exe");
        assert_eq!(
            execute(&mut nonexistent, Some(oversized), Duration::ZERO).unwrap_err(),
            "Command input exceeds limit"
        );
    }
    #[test]
    fn drain_keeps_exact_cap_and_consumes_every_byte_after_overflow() {
        assert_eq!(drain(Cursor::new(vec![1; 64]), 64).unwrap().len(), 64);
        let mut cursor = Cursor::new(vec![1; 65537]);
        assert_eq!(
            drain(&mut cursor, 64).unwrap_err(),
            "Command output exceeds limit"
        );
        assert_eq!(cursor.position(), 65537);
        let mut cursor = Cursor::new(vec![1; OUTPUT_LIMIT + 1]);
        assert!(drain(&mut cursor, OUTPUT_LIMIT).is_err());
        assert_eq!(cursor.position(), (OUTPUT_LIMIT + 1) as u64);
    }
    #[test]
    fn oversized_both_streams_finish_without_pipe_deadlock_or_early_kill() {
        struct Marker(std::path::PathBuf);
        impl Drop for Marker {
            fn drop(&mut self) {
                let _ = std::fs::remove_file(&self.0);
            }
        }
        let marker = Marker(std::env::temp_dir().join(format!(
            "purgeon-output-test-{}",
            crate::broker::random_id().unwrap()
        )));
        std::fs::File::create_new(&marker.0).unwrap();
        let script = format!("[Console]::Out.Write('x'*131072);[Console]::Error.Write('y'*131072);[IO.File]::WriteAllText('{}','completed');exit 7",marker.0.to_string_lossy().replace('\'',"''"));
        let mut command = child(&script);
        assert_eq!(
            execute_bounded(&mut command, None, Duration::from_secs(20), 64).unwrap_err(),
            "Command output exceeds limit"
        );
        assert_eq!(std::fs::read(&marker.0).unwrap(), b"completed");
        let mut command =
            child("[Console]::Out.Write('ok');[Console]::Error.Write('failure');exit 7");
        let result = execute(&mut command, None, Duration::from_secs(20)).unwrap();
        assert_eq!(result.status.code(), Some(7));
        assert_eq!(result.stdout, b"ok");
        assert_eq!(result.stderr, b"failure");
    }
    #[test]
    fn existing_timeout_joins_all_pipe_workers() {
        let mut command = child("[Threading.Thread]::Sleep(5000)");
        assert_eq!(
            execute(
                &mut command,
                Some("input".into()),
                Duration::from_millis(25)
            )
            .unwrap_err(),
            "Command timeout; inspect the operation before retrying"
        );
    }
    #[test]
    fn root_exit_confirms_descendant_termination_before_return() {
        use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
        #[link(name = "kernel32")]
        extern "system" {
            fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut std::ffi::c_void;
            fn WaitForSingleObject(handle: *mut std::ffi::c_void, milliseconds: u32) -> u32;
        }
        struct Markers(std::path::PathBuf);
        impl Drop for Markers {
            fn drop(&mut self) {
                for stage in ["admission", "pid", "pid-ready", "release"] {
                    let _ = std::fs::remove_file(self.0.join(stage));
                }
                let _ = std::fs::remove_dir(&self.0);
            }
        }
        let directory = std::env::temp_dir().join(format!(
            "purgeon-root-exit-{}",
            crate::broker::random_id().unwrap()
        ));
        std::fs::create_dir(&directory).unwrap();
        let markers = Markers(directory);
        let [admission, pid, pid_ready, release] = ["admission", "pid", "pid-ready", "release"]
            .map(|stage| markers.0.join(stage).to_string_lossy().replace('\'', "''"));
        let mut command = child(&format!(
            "$ErrorActionPreference='Stop';$deadline=[DateTime]::UtcNow.AddSeconds(15);while(-not [IO.File]::Exists('{admission}')){{if([DateTime]::UtcNow -ge $deadline){{throw 'admission timeout'}};Start-Sleep -Milliseconds 10}};$s=New-Object Diagnostics.ProcessStartInfo;$s.FileName=([Environment]::SystemDirectory+'\\WindowsPowerShell\\v1.0\\powershell.exe');$s.Arguments='-NoProfile -NonInteractive -Command \"Start-Sleep -Seconds 60\"';$s.UseShellExecute=$false;$s.CreateNoWindow=$true;$p=[Diagnostics.Process]::Start($s);[IO.File]::WriteAllText('{pid}',[string]$p.Id);[IO.File]::Open('{pid_ready}',[IO.FileMode]::CreateNew).Dispose();$deadline=[DateTime]::UtcNow.AddSeconds(15);while(-not [IO.File]::Exists('{release}')){{if([DateTime]::UtcNow -ge $deadline){{throw 'release timeout'}};Start-Sleep -Milliseconds 10}}"
        ));
        let mut descendant = None;
        let result = execute_authorized(
            &mut command,
            None,
            Duration::from_secs(40),
            OUTPUT_LIMIT,
            |_| {
                std::fs::File::create_new(markers.0.join("admission"))
                    .map_err(|error| format!("admission write: {error}"))?;
                let deadline = Instant::now() + Duration::from_secs(15);
                while !markers.0.join("pid-ready").exists() {
                    if Instant::now() >= deadline {
                        return Err("descendant PID publication timeout".into());
                    }
                    std::thread::sleep(Duration::from_millis(10));
                }
                let pid = std::fs::read_to_string(markers.0.join("pid"))
                    .map_err(|error| format!("descendant PID read: {error}"))?
                    .parse::<u32>()
                    .map_err(|error| format!("descendant PID parse: {error}"))?;
                // Capture the original descendant before allowing root exit.
                // Reopening its PID after cleanup can observe a different process.
                let handle = unsafe { OpenProcess(0x00100000, 0, pid) };
                if handle.is_null() {
                    return Err(format!(
                        "descendant OpenProcess: {}",
                        io::Error::last_os_error()
                    ));
                }
                let handle = unsafe { OwnedHandle::from_raw_handle(handle) };
                let wait = unsafe { WaitForSingleObject(handle.as_raw_handle(), 0) };
                descendant = Some(handle);
                if wait != 258 {
                    return Err(format!(
                        "descendant was not live before root release: {wait}"
                    ));
                }
                std::fs::File::create_new(markers.0.join("release"))
                    .map(|_| ())
                    .map_err(|error| format!("release write: {error}"))
            },
        );
        let descendant = descendant
            .unwrap_or_else(|| panic!("original descendant handle was not captured: {result:?}"));
        assert_eq!(
            unsafe { WaitForSingleObject(descendant.as_raw_handle(), 0) },
            0, // WAIT_OBJECT_0
            "original descendant remained alive after executor returned"
        );
        let result = result.unwrap();
        assert!(result.status.success());
    }
    fn assert_terminated(pid: u32) {
        #[link(name = "kernel32")]
        extern "system" {
            fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut std::ffi::c_void;
            fn WaitForSingleObject(handle: *mut std::ffi::c_void, milliseconds: u32) -> u32;
            fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
        }
        let handle = unsafe { OpenProcess(0x00100000, 0, pid) };
        if handle.is_null() {
            assert_eq!(std::io::Error::last_os_error().raw_os_error(), Some(87));
        } else {
            let wait = unsafe { WaitForSingleObject(handle, 0) };
            unsafe { CloseHandle(handle) };
            assert_eq!(wait, 0, "descendant remained alive after executor returned");
        }
    }
    #[test]
    fn parent_death_closes_job_after_assignment() {
        const KEY: &str = "PURGEON_JOB_PARENT_DEATH_MARKER";
        if let Ok(marker) = std::env::var(KEY) {
            let script = format!(
                "[IO.File]::WriteAllText('{}',[string]$PID);Start-Sleep -Seconds 30",
                marker.replace('\'', "''")
            );
            let mut process = child(&script)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap();
            let _job = crate::security::ProcessJob::assign(&process).unwrap();
            let deadline = Instant::now() + Duration::from_secs(15);
            loop {
                if std::fs::read_to_string(&marker).is_ok_and(|value| value.parse::<u32>().is_ok())
                {
                    // exit deliberately skips Rust Drop. Windows must close
                    // the job handle as part of parent process teardown.
                    std::process::exit(0);
                }
                assert!(Instant::now() < deadline);
                assert!(process.try_wait().unwrap().is_none());
                std::thread::sleep(Duration::from_millis(20));
            }
        }
        let marker = std::env::temp_dir().join(format!(
            "purgeon-job-death-{}",
            crate::broker::random_id().unwrap()
        ));
        std::fs::File::create_new(&marker).unwrap();
        let result = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "process_io::tests::parent_death_closes_job_after_assignment",
                "--nocapture",
            ])
            .env(KEY, &marker)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}{}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );
        let pid = std::fs::read_to_string(&marker).unwrap().parse().unwrap();
        // OS termination is asynchronous at handle close; allow a bounded
        // grace period before asserting the observed process is signalled.
        std::thread::sleep(Duration::from_millis(200));
        assert_terminated(pid);
        std::fs::remove_file(marker).unwrap();
    }
    #[test]
    fn streaming_hash_handles_short_writes_and_independent_corruption() {
        struct Short(Vec<u8>);
        impl Write for Short {
            fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
                let n = bytes.len().min(3);
                self.0.extend_from_slice(&bytes[..n]);
                Ok(n)
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }
        let input = vec![42; 65537];
        let mut output = Short(Vec::new());
        let (count, hash) = copy_hash(Cursor::new(&input), &mut output).unwrap();
        assert_eq!(count, input.len() as u64);
        assert_eq!(output.0, input);
        assert_eq!(hash, hash_reader(Cursor::new(&output.0)).unwrap());
        output.0[100] ^= 1;
        assert_ne!(hash, hash_reader(Cursor::new(&output.0)).unwrap());
        assert_eq!(copy_hash(Cursor::new([]), io::sink()).unwrap().0, 0);
    }
    #[test]
    fn first_reader_and_partial_write_errors_propagate() {
        struct Broken;
        impl Read for Broken {
            fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
                Err(io::Error::other("reader failure"))
            }
        }
        impl Write for Broken {
            fn write(&mut self, _: &[u8]) -> io::Result<usize> {
                Err(io::Error::other("writer failure"))
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }
        assert_eq!(drain(Broken, 1).unwrap_err(), "reader failure");
        assert_eq!(copy_hash(Broken, io::sink()).unwrap_err(), "reader failure");
        assert_eq!(
            copy_hash(Cursor::new(b"abc"), Broken).unwrap_err(),
            "writer failure"
        );
    }
}
