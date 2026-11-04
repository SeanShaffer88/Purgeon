//! Private, inert child. Only an authenticated instance of this executable can
//! authorize dispatch, after assigning the child to its kill-on-close job.
use crate::{broker, process_io, recovery_lease};
use serde::{Deserialize, Serialize};
use std::os::windows::{io::AsRawHandle, process::CommandExt};
use std::process::{Command, Output};
use std::time::Duration;

const MODE: &str = "--recovery-worker";
const ORDINARY_MODE: &str = "--command-worker";
const PREFIX: &str = "\\\\.\\pipe\\Purgeon-Recovery-";
#[cfg(test)]
thread_local! {
    pub(crate) static REJECT_NEXT_PEER: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Frame {
    version: u32,
    file: String,
    args: Vec<String>,
    env: Vec<(String, Option<String>)>,
    directory: Option<String>,
}

pub(crate) fn execute_ordinary(
    command: &Command,
    input: Option<String>,
    timeout: Duration,
    cap: usize,
) -> Result<Output, String> {
    process_io::validate_input(input.as_deref())?;
    let string = |value: &std::ffi::OsStr| {
        value
            .to_str()
            .map(str::to_owned)
            .ok_or("Non-Unicode command".to_string())
    };
    let frame = Frame {
        version: 1,
        file: string(command.get_program())?,
        args: command.get_args().map(string).collect::<Result<_, _>>()?,
        env: command
            .get_envs()
            .map(|(key, value)| Ok((string(key)?, value.map(string).transpose()?)))
            .collect::<Result<_, String>>()?,
        directory: command
            .get_current_dir()
            .map(|path| string(path.as_os_str()))
            .transpose()?,
    };
    // Chunk the ordinary request rather than imposing recovery's 256 KiB
    // frame ceiling on the previously supported command environment.
    let data = serde_json::to_vec(&frame).map_err(|e| e.to_string())?;
    let name = format!("{PREFIX}{}-{}", std::process::id(), broker::random_id()?);
    let pipe = broker::server_pipe(&name)?;
    let deadline = std::time::Instant::now() + timeout;
    #[cfg(test)]
    let mut worker = worker_command(&name)?;
    #[cfg(not(test))]
    let mut worker = {
        let mut worker = Command::new(std::env::current_exe().map_err(|e| e.to_string())?);
        worker
            .args([ORDINARY_MODE, &name])
            .creation_flags(0x08000000);
        worker
    };
    #[cfg(test)]
    {
        worker.env("PURGEON_TEST_ORDINARY_WORKER", "1");
        tests::configure_ack_fault(&mut worker);
        if let Some((_, Some(value))) = command
            .get_envs()
            .find(|(key, _)| *key == "PURGEON_TEST_WORKER_READY")
        {
            worker.env("PURGEON_TEST_WORKER_READY", value);
        }
    }
    let output = process_io::execute_in_job(&mut worker, input, timeout, cap, None, |child| {
        broker::accept_pipe_until(pipe.0, deadline)?;
        authenticate_worker(pipe.0, child)?;
        broker::send_until(pipe.0, &data.len(), deadline)?;
        for chunk in data.chunks(32 * 1024) {
            broker::send_until(pipe.0, &chunk, deadline)?;
        }
        let spawned: Result<(), String> = broker::receive_until(pipe.0, deadline)?;
        spawned
    });
    if output.as_ref().err().is_some_and(|error| {
        matches!(
            error.as_str(),
            "Broker connection timed out" | "Broker operation deadline exceeded"
        )
    }) {
        return Err("Command timeout; inspect the operation before retrying".into());
    }
    output
}

pub(crate) fn execute(
    token: &str,
    command: &Command,
    input: Option<String>,
    timeout: Duration,
) -> Result<Output, String> {
    process_io::validate_input(input.as_deref())?;
    recovery_lease::validate(token)?;
    let string = |value: &std::ffi::OsStr| {
        value
            .to_str()
            .map(str::to_owned)
            .ok_or("Non-Unicode recovery command".to_string())
    };
    let frame = Frame {
        version: 1,
        file: string(command.get_program())?,
        args: command.get_args().map(string).collect::<Result<_, _>>()?,
        env: command
            .get_envs()
            .map(|(key, value)| Ok((string(key)?, value.map(string).transpose()?)))
            .collect::<Result<_, String>>()?,
        directory: command
            .get_current_dir()
            .map(|path| string(path.as_os_str()))
            .transpose()?,
    };
    if serde_json::to_vec(&frame).map_err(|e| e.to_string())?.len() > 256 * 1024 {
        return Err("Recovery command frame exceeds limit".into());
    }
    let name = format!("{PREFIX}{}-{}", std::process::id(), broker::random_id()?);
    let pipe = broker::server_pipe(&name)?;
    let job_name = crate::security::ProcessJob::recovery_name()?;
    let job = crate::security::ProcessJob::create(Some(&job_name))?;
    let deadline = std::time::Instant::now() + timeout;
    let mut worker = worker_command(&name)?;
    let mut execution = None;
    let output = process_io::execute_in_job(
        &mut worker,
        input,
        timeout,
        process_io::recovery_output_limit(),
        Some(&job),
        |child| {
            broker::accept_pipe_until(pipe.0, deadline)?;
            authenticate_worker(pipe.0, child)?;
            // A target has not been dispatched at any earlier failure point.
            execution = Some(recovery_lease::ExecutionGuard::begin_named(
                token, &job_name,
            )?);
            broker::send_until(pipe.0, &frame, deadline)
        },
    );
    // Job closure settles execution, never provider completion or journal state.
    // A normally completed failing command is still known to have terminated.
    if output.is_ok() {
        if let Some(execution) = execution.take() {
            execution.confirm()?;
        }
    }
    drop(execution);
    drop(job);
    output
}

fn worker_command(name: &str) -> Result<Command, String> {
    let mut worker = Command::new(std::env::current_exe().map_err(|e| e.to_string())?);
    #[cfg(not(test))]
    worker.args([MODE, name]);
    #[cfg(test)]
    worker
        .args([
            "--exact",
            "recovery_worker::tests::inert_entry",
            "--nocapture",
        ])
        .env("PURGEON_TEST_RECOVERY_PIPE", name);
    worker.creation_flags(0x08000000);
    Ok(worker)
}

fn authenticate_worker(pipe: broker::Handle, child: &std::process::Child) -> Result<(), String> {
    #[link(name = "kernel32")]
    extern "system" {
        fn GetNamedPipeClientProcessId(pipe: broker::Handle, pid: *mut u32) -> i32;
        fn GetProcessId(process: broker::Handle) -> u32;
    }
    let mut pid = 0;
    let expected = unsafe { GetProcessId(child.as_raw_handle()) };
    #[cfg(test)]
    let expected = if REJECT_NEXT_PEER.with(|flag| flag.replace(false)) {
        0
    } else {
        expected
    };
    // The retained child handle prevents PID reuse from authenticating a peer.
    if unsafe { GetNamedPipeClientProcessId(pipe, &mut pid) } == 0 || pid != expected {
        return Err("Recovery worker authentication failed".into());
    }
    Ok(())
}

pub(crate) fn private_mode() -> Result<bool, String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if !matches!(args.first().map(String::as_str), Some(MODE | ORDINARY_MODE)) {
        return Ok(false);
    }
    let [_, name] = args.as_slice() else {
        return Err("Invalid recovery worker arguments".into());
    };
    run_worker_mode(name, args[0] == ORDINARY_MODE)
}

#[cfg(test)]
fn run_worker(name: &str) -> Result<bool, String> {
    run_worker_mode(name, false)
}

fn run_worker_mode(name: &str, ordinary: bool) -> Result<bool, String> {
    let rest = name.strip_prefix(PREFIX).ok_or("Invalid recovery pipe")?;
    let (pid, nonce) = rest.split_once('-').ok_or("Invalid recovery pipe")?;
    if nonce.len() != 32 || !nonce.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("Invalid recovery nonce".into());
    }
    let pid = pid.parse::<u32>().map_err(|e| e.to_string())?;
    // client_pipe verifies server PID and its executable image against our own.
    let pipe = broker::client_pipe(name, pid)?;
    #[cfg(test)]
    if let Some(path) = std::env::var_os("PURGEON_TEST_WORKER_READY") {
        std::fs::File::create_new(path).map_err(|e| e.to_string())?;
    }
    let frame: Frame = if ordinary {
        let length: usize = broker::receive(pipe.0)?;
        let mut data = Vec::new();
        while data.len() < length {
            let chunk: Vec<u8> = broker::receive(pipe.0)?;
            if chunk.is_empty() || chunk.len() > 32 * 1024 || chunk.len() > length - data.len() {
                return Err("Invalid command frame chunk".into());
            }
            data.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&data).map_err(|e| e.to_string())?
    } else {
        broker::receive(pipe.0)?
    };
    if frame.version != 1 || frame.file.is_empty() {
        return Err("Invalid recovery command frame".into());
    }
    broker::require_live_parent(pid)?;
    #[cfg(test)]
    let ack_fault = tests::capture_ack_fault();
    let mut command = Command::new(frame.file);
    command.args(frame.args).creation_flags(0x08000000);
    for (key, value) in frame.env {
        match value {
            Some(value) => {
                command.env(key, value);
            }
            None => {
                command.env_remove(key);
            }
        }
    }
    if let Some(directory) = frame.directory {
        command.current_dir(directory);
    }
    // Inherit only the stdio pipes; lease and job handles are noninheritable.
    let status = if ordinary {
        match command.spawn() {
            Ok(mut child) => {
                #[cfg(test)]
                tests::simulate_ack_fault(ack_fault, pipe.0, &mut child)?;
                broker::send(pipe.0, &Ok::<(), String>(()))?;
                child.wait().map_err(|e| e.to_string())?
            }
            Err(error) => {
                let error = error.to_string();
                broker::send(pipe.0, &Err::<(), _>(error.clone()))?;
                return Err(error);
            }
        }
    } else {
        command.status().map_err(|e| e.to_string())?
    };
    #[cfg(not(test))]
    std::process::exit(status.code().unwrap_or(2));
    #[cfg(test)]
    unsafe {
        test_exit(status.code().unwrap_or(2));
    }
}

#[cfg(test)]
extern "C" {
    // Use CRT termination so registered atexit writers run in test workers.
    #[link_name = "exit"]
    fn test_exit(status: i32) -> !;
}

// Test workers enter before libtest writes its banner. The production binary
// already enters private_mode before application initialization.
// LLVM's XCU profiling initializer must register its exit writer before worker
// dispatch can exit. XCV is a qualified Windows/MSVC test technique, not a
// stable ABI or shipping initialization path.
#[cfg(test)]
#[used]
#[link_section = ".CRT$XCV"]
static TEST_WORKER_ENTRY: extern "C" fn() = {
    extern "C" fn enter() {
        if let Ok(name) = std::env::var("PURGEON_TEST_RECOVERY_PIPE") {
            let ordinary = std::env::var_os("PURGEON_TEST_ORDINARY_WORKER").is_some();
            match run_worker_mode(&name, ordinary) {
                Ok(_) => unsafe { test_exit(0) },
                Err(_) => unsafe { test_exit(2) },
            }
        }
    }
    enter
};

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use std::process::Stdio;
    use std::time::Instant;

    thread_local! {
        static ACK_FAULT: std::cell::RefCell<Option<(String, std::path::PathBuf)>> = const { std::cell::RefCell::new(None) };
    }

    pub(super) fn configure_ack_fault(worker: &mut Command) {
        ACK_FAULT.with(|slot| {
            if let Some((fault, root)) = slot.borrow_mut().take() {
                worker
                    .env("PURGEON_TEST_ACK_FAULT", fault)
                    .env("PURGEON_TEST_ACK_ROOT", root);
            }
        });
    }

    pub(super) fn capture_ack_fault() -> Option<(String, std::path::PathBuf)> {
        let ack_fault = std::env::var("PURGEON_TEST_ACK_FAULT").ok().map(|fault| {
            (
                fault,
                std::path::PathBuf::from(std::env::var_os("PURGEON_TEST_ACK_ROOT").unwrap()),
            )
        });
        for key in [
            "PURGEON_TEST_RECOVERY_PIPE",
            "PURGEON_TEST_ORDINARY_WORKER",
            "PURGEON_TEST_WORKER_READY",
            "PURGEON_TEST_ACK_FAULT",
            "PURGEON_TEST_ACK_ROOT",
        ] {
            // This dedicated worker is single threaded and must not turn a target
            // libtest binary into another inert worker through fixture inheritance.
            std::env::remove_var(key);
        }
        ack_fault
    }

    pub(super) fn simulate_ack_fault(
        ack_fault: Option<(String, std::path::PathBuf)>,
        pipe: broker::Handle,
        child: &mut std::process::Child,
    ) -> Result<(), String> {
        if let Some((fault, root)) = ack_fault {
            let deadline = std::time::Instant::now() + Duration::from_secs(10);
            while !root.join("ack-release").exists() {
                if std::time::Instant::now() >= deadline {
                    return Err("Test target readiness timed out".into());
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            if fault == "missing" {
                loop {
                    std::thread::sleep(Duration::from_millis(10));
                }
            }
            broker::send(pipe, &serde_json::json!({"unexpected": true}))?;
            child.wait().map_err(|e| e.to_string())?;
            return Err("Malformed test ACK target unexpectedly exited".into());
        }
        Ok(())
    }

    use std::os::windows::io::{AsHandle, FromRawHandle, OwnedHandle};
    #[link(name = "kernel32")]
    extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> broker::Handle;
        fn WaitForSingleObject(handle: broker::Handle, milliseconds: u32) -> u32;
        fn TerminateProcess(handle: broker::Handle, code: u32) -> i32;
    }
    struct Fixture {
        root: std::path::PathBuf,
        handles: std::sync::Mutex<Vec<OwnedHandle>>,
    }
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir()
                .join(format!("purgeon-frame-{}", broker::random_id().unwrap()));
            std::fs::create_dir(&root).unwrap();
            Self {
                root,
                handles: std::sync::Mutex::new(Vec::new()),
            }
        }
        fn retain_alive(&self, handle: OwnedHandle) {
            let raw = handle.as_raw_handle();
            self.handles.lock().unwrap().push(handle);
            assert_eq!(unsafe { WaitForSingleObject(raw, 0) }, 258);
        }
        fn assert_terminated(&self, count: usize) {
            let handles = self.handles.lock().unwrap();
            assert_eq!(handles.len(), count);
            for handle in handles.iter() {
                assert_eq!(
                    unsafe { WaitForSingleObject(handle.as_raw_handle(), 5000) },
                    0
                );
            }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            for handle in self
                .handles
                .get_mut()
                .unwrap_or_else(|poison| poison.into_inner())
                .iter()
            {
                unsafe {
                    TerminateProcess(handle.as_raw_handle(), 1);
                    WaitForSingleObject(handle.as_raw_handle(), 5000);
                }
            }
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn ordinary_frame_rejections_never_dispatch_target() {
        for case in ["empty", "oversize", "excess", "truncated"] {
            let fixture = Fixture::new();
            let marker = fixture.root.join("target-marker");
            let data = serde_json::to_vec(&frame(&format!(
                "[IO.File]::WriteAllText('{}','ran')",
                marker.display()
            )))
            .unwrap();
            let name = name();
            let pipe = broker::server_pipe(&name).unwrap();
            let mut worker = worker_command(&name).unwrap();
            worker.env("PURGEON_TEST_ORDINARY_WORKER", "1");
            let deadline = Instant::now() + Duration::from_secs(10);
            let mut pipe = Some(pipe);
            let result = process_io::execute_authorized(
                &mut worker,
                None,
                Duration::from_secs(10),
                1024,
                |child| {
                    fixture.retain_alive(child.as_handle().try_clone_to_owned().unwrap());
                    let handle = pipe.as_ref().unwrap().0;
                    broker::accept_pipe_until(handle, deadline)?;
                    authenticate_worker(handle, child)?;
                    broker::send_until(handle, &data.len(), deadline)?;
                    let chunk = match case {
                        "empty" => Vec::new(),
                        "oversize" => vec![0u8; 32 * 1024 + 1],
                        "excess" => vec![0u8; data.len() + 1],
                        "truncated" => data[..data.len() / 2].to_vec(),
                        _ => unreachable!(),
                    };
                    broker::send_until(handle, &chunk, deadline)?;
                    if case == "truncated" {
                        pipe.take();
                    }
                    Ok(())
                },
            );
            assert!(
                result.as_ref().is_ok_and(|output| !output.status.success()),
                "{case}: {result:?}"
            );
            fixture.assert_terminated(1);
            assert!(!marker.exists(), "{case}: target dispatched");
        }
    }

    #[test]
    fn ordinary_missing_or_malformed_spawn_ack_terminates_worker_and_target() {
        for fault in ["missing", "malformed"] {
            let fixture = std::sync::Arc::new(Fixture::new());
            let root = fixture.root.to_string_lossy().replace('\'', "''");
            let mut command = Command::new(crate::windows_tools::command("powershell.exe"));
            command.args(["-NoProfile", "-NonInteractive", "-Command", &format!("[IO.File]::WriteAllText('{root}\\target.pid',[string]$PID);[IO.File]::WriteAllText('{root}\\ready','ready');Start-Sleep -Seconds 60")]);
            let observed = fixture.clone();
            let (tx, rx) = std::sync::mpsc::channel();
            process_io::AFTER_SPAWN.with(|slot| {
                *slot.borrow_mut() = Some(Box::new(move |child| {
                    observed.retain_alive(child.as_handle().try_clone_to_owned().unwrap());
                    std::thread::spawn(move || {
                        let deadline = Instant::now() + Duration::from_secs(10);
                        while !observed.root.join("ready").exists() {
                            assert!(Instant::now() < deadline, "target readiness timeout");
                            std::thread::sleep(Duration::from_millis(10));
                        }
                        let pid = std::fs::read_to_string(observed.root.join("target.pid"))
                            .unwrap()
                            .parse()
                            .unwrap();
                        let handle = unsafe { OpenProcess(0x00100001, 0, pid) };
                        assert!(!handle.is_null());
                        observed.retain_alive(unsafe { OwnedHandle::from_raw_handle(handle) });
                        std::fs::write(observed.root.join("ack-release"), b"ready").unwrap();
                        tx.send(()).unwrap();
                    });
                }))
            });
            ACK_FAULT
                .with(|slot| *slot.borrow_mut() = Some((fault.to_owned(), fixture.root.clone())));
            let acknowledged = std::rc::Rc::new(std::cell::Cell::new(false));
            let observed = acknowledged.clone();
            process_io::AFTER_AUTHORIZATION.with(|slot| {
                *slot.borrow_mut() = Some(Box::new(move |_| observed.set(true)));
            });
            let start = Instant::now();
            let result = execute_ordinary(&command, None, Duration::from_secs(12), 1024);
            process_io::AFTER_AUTHORIZATION.with(|slot| slot.borrow_mut().take());
            rx.recv_timeout(Duration::from_secs(1)).unwrap();
            assert!(
                !acknowledged.get(),
                "{fault}: executor accepted a spawn ACK"
            );
            assert!(start.elapsed() < Duration::from_secs(18));
            assert!(result.is_err(), "{fault}: {result:?}");
            let error = result.unwrap_err();
            assert!(
                error.contains(if fault == "missing" {
                    "Command timeout"
                } else {
                    "unknown variant"
                }),
                "{fault}: {error}"
            );
            fixture.assert_terminated(2);
        }
    }

    #[test]
    fn accept_respects_short_command_deadline() {
        let pipe = broker::server_pipe(&name()).unwrap();
        let start = Instant::now();
        assert!(broker::accept_pipe_until(pipe.0, start + Duration::from_millis(25)).is_err());
        assert!(start.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn inert_entry() {
        if let Ok(name) = std::env::var("PURGEON_TEST_RECOVERY_PIPE") {
            match run_worker(&name) {
                Ok(_) => std::process::exit(0),
                Err(error) => {
                    eprintln!("{error}");
                    std::process::exit(2);
                }
            }
        }
    }

    fn frame(script: &str) -> Frame {
        Frame {
            version: 1,
            file: crate::windows_tools::command("powershell.exe")
                .to_string_lossy()
                .into_owned(),
            args: vec![
                "-NoProfile".into(),
                "-NonInteractive".into(),
                "-Command".into(),
                script.into(),
            ],
            env: vec![("PSModulePath".into(), None)],
            directory: None,
        }
    }
    fn name() -> String {
        format!(
            "{PREFIX}{}-{}",
            std::process::id(),
            broker::random_id().unwrap()
        )
    }

    #[test]
    fn missing_or_malformed_authorization_is_inert() {
        for malformed in [false, true] {
            let name = name();
            let pipe = broker::server_pipe(&name).unwrap();
            let mut child = worker_command(&name)
                .unwrap()
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap();
            broker::accept_pipe(pipe.0).unwrap();
            authenticate_worker(pipe.0, &child).unwrap();
            assert!(child.try_wait().unwrap().is_none());
            if malformed {
                broker::send(pipe.0, &serde_json::json!({"version": 99})).unwrap();
            }
            drop(pipe);
            let deadline = Instant::now() + Duration::from_secs(5);
            while child.try_wait().unwrap().is_none() {
                if Instant::now() >= deadline {
                    child.kill().unwrap();
                    child.wait().unwrap();
                    panic!("Inert worker did not exit on EOF");
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        }
    }

    #[test]
    fn authorized_command_preserves_input_environment_directory_and_exit_status() {
        let root = std::env::temp_dir().join(format!(
            "purgeon-worker-contract-{}",
            broker::random_id().unwrap()
        ));
        std::fs::create_dir(&root).unwrap();
        let run = |frame: Frame, input| {
            let name = name();
            let pipe = broker::server_pipe(&name).unwrap();
            let mut worker = worker_command(&name).unwrap();
            worker.env("PSModulePath", "purgeon-fixture-invalid-modules");
            process_io::execute_authorized(
                &mut worker,
                input,
                Duration::from_secs(20),
                process_io::recovery_output_limit(),
                |child| {
                    broker::accept_pipe(pipe.0)?;
                    authenticate_worker(pipe.0, child)?;
                    broker::send(pipe.0, &frame)
                },
            )
        };
        let mut frame = frame("[Console]::OutputEncoding=[Text.Encoding]::UTF8;[Console]::Out.Write([Console]::In.ReadToEnd());[Console]::Out.Write($env:PURGEON_WORKER_VALUE);[Console]::Out.Write([Environment]::CurrentDirectory);if($env:PSModulePath -like '*purgeon-fixture-invalid-modules*'){exit 9}");
        frame.env.push((
            "PURGEON_WORKER_VALUE".into(),
            Some("quoted \"value\" é".into()),
        ));
        frame.directory = Some(root.to_string_lossy().into_owned());
        let result = run(frame, Some("input\n".into())).unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        let output = String::from_utf8(result.stdout).unwrap();
        let (_, directory) = output.split_once("input\nquoted \"value\" é").unwrap();
        assert_eq!(
            std::fs::canonicalize(directory).unwrap(),
            std::fs::canonicalize(&root).unwrap(),
            "{output}"
        );
        let result = run(self::frame("exit 7"), None).unwrap();
        assert_eq!(result.status.code(), Some(7));
        std::fs::remove_dir_all(root).unwrap();
    }

    fn assert_gone(pid: u32) {
        #[link(name = "kernel32")]
        extern "system" {
            fn OpenProcess(access: u32, inherit: i32, pid: u32) -> broker::Handle;
            fn WaitForSingleObject(handle: broker::Handle, milliseconds: u32) -> u32;
            fn CloseHandle(handle: broker::Handle) -> i32;
        }
        let process = unsafe { OpenProcess(0x100000, 0, pid) };
        if process.is_null() {
            assert_eq!(std::io::Error::last_os_error().raw_os_error(), Some(87));
        } else {
            let signalled = unsafe { WaitForSingleObject(process, 5000) };
            unsafe {
                CloseHandle(process);
            }
            assert_eq!(signalled, 0, "Owned fixture process {pid} remained alive");
        }
    }

    #[test]
    fn parent_death_windows() {
        const CASE: &str = "PURGEON_TEST_WORKER_PARENT_CASE";
        const ROOT: &str = "PURGEON_TEST_WORKER_ROOT";
        if let Ok(case) = std::env::var(CASE) {
            let root = std::env::var(ROOT).unwrap();
            let root = Path::new(&root);
            let name = name();
            let pipe = broker::server_pipe(&name).unwrap();
            let job_name = crate::security::ProcessJob::recovery_name().unwrap();
            let job = crate::security::ProcessJob::create(Some(&job_name)).unwrap();
            std::fs::write(root.join("job.name"), &job_name).unwrap();
            let child = worker_command(&name)
                .unwrap()
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap();
            std::fs::write(root.join("worker.pid"), child.id().to_string()).unwrap();
            if case == "before-assignment" {
                std::process::exit(0);
            }
            job.assign_child(&child).unwrap();
            if case == "after-assignment" {
                std::process::exit(0);
            }
            broker::accept_pipe(pipe.0).unwrap();
            authenticate_worker(pipe.0, &child).unwrap();
            if case == "before-authorization" {
                std::process::exit(0);
            }
            let target = root
                .join("target.pid")
                .to_string_lossy()
                .replace('\'', "''");
            broker::send(
                pipe.0,
                &frame(&format!(
                    "[IO.File]::WriteAllText('{target}',[string]$PID);Start-Sleep -Seconds 30"
                )),
            )
            .unwrap();
            let deadline = Instant::now() + Duration::from_secs(10);
            while !root.join("target.pid").exists() {
                assert!(Instant::now() < deadline);
                std::thread::sleep(Duration::from_millis(10));
            }
            // Deliberately skip Drop: OS handle teardown must terminate the job.
            std::process::exit(0);
        }
        for case in [
            "before-assignment",
            "after-assignment",
            "before-authorization",
            "after-authorization",
        ] {
            let root = std::env::temp_dir().join(format!(
                "purgeon-worker-test-{}",
                broker::random_id().unwrap()
            ));
            std::fs::create_dir(&root).unwrap();
            let output = Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "recovery_worker::tests::parent_death_windows",
                    "--nocapture",
                ])
                .env(CASE, case)
                .env(ROOT, &root)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{case}: {}{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            let pid = std::fs::read_to_string(root.join("worker.pid"))
                .unwrap()
                .parse()
                .unwrap();
            assert_gone(pid);
            let job_name = std::fs::read_to_string(root.join("job.name")).unwrap();
            assert!(crate::security::ProcessJob::recovery_closed(&job_name).unwrap());
            if case == "after-authorization" {
                assert_gone(
                    std::fs::read_to_string(root.join("target.pid"))
                        .unwrap()
                        .parse()
                        .unwrap(),
                );
            } else {
                assert!(!root.join("target.pid").exists());
            }
            std::fs::remove_dir_all(root).unwrap();
        }
    }
}
