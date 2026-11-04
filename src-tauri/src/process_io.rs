//! Bounded retention without closing a live child's pipes at the output cap.
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

pub const INPUT_LIMIT: usize = 16 * 1024 * 1024;
const OUTPUT_LIMIT: usize = 64 * 1024 * 1024;

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
    execute_authorized(command, input, timeout, cap, |_| Ok(()))
}

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
        let mut command = child(
            "$s=New-Object Diagnostics.ProcessStartInfo;$s.FileName=([Environment]::SystemDirectory+'\\WindowsPowerShell\\v1.0\\powershell.exe');$s.Arguments='-NoProfile -NonInteractive -Command \"Start-Sleep -Seconds 30\"';$s.UseShellExecute=$false;$s.CreateNoWindow=$true;$p=[Diagnostics.Process]::Start($s);[Console]::Out.Write($p.Id)",
        );
        let result = execute(&mut command, None, Duration::from_secs(20)).unwrap();
        assert!(result.status.success());
        let pid: u32 = String::from_utf8(result.stdout).unwrap().parse().unwrap();
        assert_terminated(pid);
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
