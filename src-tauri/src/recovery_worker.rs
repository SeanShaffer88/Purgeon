//! Private, inert child. Only an authenticated instance of this executable can
//! authorize dispatch, after assigning the child to its kill-on-close job.
use crate::{broker, process_io, recovery_lease};
use serde::{Deserialize, Serialize};
use std::os::windows::{io::AsRawHandle, process::CommandExt};
use std::process::{Command, Output};
use std::time::Duration;

const MODE: &str = "--recovery-worker";
const PREFIX: &str = "\\\\.\\pipe\\Purgeon-Recovery-";
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Frame {
    version: u32,
    file: String,
    args: Vec<String>,
    env: Vec<(String, Option<String>)>,
    directory: Option<String>,
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
    // The retained child handle prevents PID reuse from authenticating a peer.
    if unsafe { GetNamedPipeClientProcessId(pipe, &mut pid) } == 0
        || pid != unsafe { GetProcessId(child.as_raw_handle()) }
    {
        return Err("Recovery worker authentication failed".into());
    }
    Ok(())
}

pub(crate) fn private_mode() -> Result<bool, String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) != Some(MODE) {
        return Ok(false);
    }
    let [_, name] = args.as_slice() else {
        return Err("Invalid recovery worker arguments".into());
    };
    run_worker(name)
}

fn run_worker(name: &str) -> Result<bool, String> {
    let rest = name.strip_prefix(PREFIX).ok_or("Invalid recovery pipe")?;
    let (pid, nonce) = rest.split_once('-').ok_or("Invalid recovery pipe")?;
    if nonce.len() != 32 || !nonce.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("Invalid recovery nonce".into());
    }
    let pid = pid.parse::<u32>().map_err(|e| e.to_string())?;
    // client_pipe verifies server PID and its executable image against our own.
    let pipe = broker::client_pipe(name, pid)?;
    let frame: Frame = broker::receive(pipe.0)?;
    if frame.version != 1 || frame.file.is_empty() {
        return Err("Invalid recovery command frame".into());
    }
    broker::require_live_parent(pid)?;
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
    let status = command.status().map_err(|e| e.to_string())?;
    std::process::exit(status.code().unwrap_or(2));
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use std::process::Stdio;
    use std::time::Instant;

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
        assert!(
            output.ends_with(&format!("input\nquoted \"value\" é{}", root.display())),
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
