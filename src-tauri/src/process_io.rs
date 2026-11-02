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
    validate_input(input.as_deref())?;
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let start = Instant::now();
    let job = match crate::security::ProcessJob::assign(&child) {
        Ok(job) => job,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
    };
    // All three pipes were requested at spawn; take them before launching any
    // worker so a setup failure cannot strand an already running reader.
    let pipes = (child.stdin.take(), child.stdout.take(), child.stderr.take());
    let (Some(mut stdin), Some(stdout), Some(stderr)) = pipes else {
        drop(job);
        let _ = child.kill();
        let _ = child.wait();
        return Err("Missing command pipe".into());
    };
    let writer = std::thread::spawn(move || {
        // stdin is dropped on success and failure, delivering EOF in either case.
        if let Some(input) = input {
            stdin
                .write_all(input.as_bytes())
                .map_err(|e| e.to_string())?;
        }
        Ok::<_, String>(())
    });
    let out = std::thread::spawn(move || drain(stdout, cap));
    let err = std::thread::spawn(move || drain(stderr, cap));
    let outcome = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Err(error) => break Err(error.to_string()),
            Ok(None) => {}
        }
        if start.elapsed() >= timeout {
            break Err("Command timeout; inspect the operation before retrying".into());
        }
        std::thread::sleep(Duration::from_millis(30));
    };
    // Retain the existing job lifetime: root exit or timeout ends descendants.
    // Output overflow alone never terminates the child.
    drop(job);
    if outcome.is_err() {
        let _ = child.kill();
    }
    let _ = child.wait();
    // Collect every join before propagating any error; no early ? skips workers.
    let written = writer.join().map_err(|_| "Input writer failed");
    let stdout = out.join().map_err(|_| "Output reader failed");
    let stderr = err.join().map_err(|_| "Error reader failed");
    let status = outcome?;
    written??;
    Ok(Output {
        status,
        stdout: stdout??,
        stderr: stderr??,
    })
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
