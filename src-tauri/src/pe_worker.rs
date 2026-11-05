//! Read-only PE inspection in an authenticated child with a bounded lifetime.
use crate::{broker, process_io, recovery_worker};
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::os::windows::io::{AsHandle, AsRawHandle, OwnedHandle};
use std::path::{Component, Path, Prefix};
use std::time::{Duration, Instant};

pub(crate) const MODE: &str = "--pe-worker";
const PROBE_MODE: &str = "--qualify-pe-worker-panic";
const PROBE_UNAVAILABLE: &str = "PE worker qualification is unavailable";
pub(crate) const FAILURE: &str = "PE architecture worker unavailable";
const VERSION: u32 = 1;
const MAX_BATCH: usize = 4_096;
const MAX_FRAME_BYTES: usize = 240 * 1024;
const MAX_PATH_BYTES: usize = 3 * 32_767;
const TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Deserialize, Serialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
enum Request {
    Read {
        version: u32,
        paths: Vec<String>,
    },
    #[cfg(feature = "packaged-panic-probe")]
    Panic {
        version: u32,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum Architecture {
    X64,
    X86,
    Arm64,
    Arm,
    Unknown,
}

impl Architecture {
    fn as_str(self) -> &'static str {
        match self {
            Self::X64 => "x64",
            Self::X86 => "x86",
            Self::Arm64 => "arm64",
            Self::Arm => "arm",
            Self::Unknown => "",
        }
    }
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
enum Reply {
    Read {
        version: u32,
        architectures: Vec<Architecture>,
    },
    #[cfg(feature = "packaged-panic-probe")]
    Panicking { version: u32 },
}

// Read regular files on local drives or ordinary UNC shares. Windows device
// namespaces, IPC shares, DOS devices and alternate streams are not PE files.
fn file_path(path: &str) -> bool {
    if path.contains('\0') || path.len() > MAX_PATH_BYTES {
        return false;
    }
    let mut components = Path::new(path).components();
    let Some(Component::Prefix(prefix)) = components.next() else {
        return false;
    };
    match prefix.kind() {
        Prefix::Disk(_) | Prefix::VerbatimDisk(_) => {}
        Prefix::UNC(_, share) | Prefix::VerbatimUNC(_, share) => {
            let share = share.to_string_lossy();
            if ["pipe", "mailslot", "ipc$"].iter().any(|alias| {
                share
                    .trim_end_matches(['.', ' '])
                    .eq_ignore_ascii_case(alias)
            }) {
                return false;
            }
        }
        _ => return false,
    }
    components.next() == Some(Component::RootDir)
        && components.all(|component| match component {
            Component::Normal(name) => {
                let name = name.to_string_lossy();
                let base = name.split('.').next().unwrap_or("").trim_end();
                let base = base.to_ascii_uppercase();
                !name.contains(':')
                    && !matches!(
                        base.as_str(),
                        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
                    )
                    && !matches!(
                        base.strip_prefix("COM")
                            .or_else(|| base.strip_prefix("LPT")),
                        Some(
                            "0" | "1"
                                | "2"
                                | "3"
                                | "4"
                                | "5"
                                | "6"
                                | "7"
                                | "8"
                                | "9"
                                | "¹"
                                | "²"
                                | "³"
                        )
                    )
            }
            _ => true,
        })
}

fn machine(mut reader: impl Read + Seek) -> Option<Architecture> {
    let mut dos = [0; 64];
    reader.read_exact(&mut dos).ok()?;
    if &dos[..2] != b"MZ" {
        return None;
    }
    let offset = u32::from_le_bytes([dos[60], dos[61], dos[62], dos[63]]);
    if offset < dos.len() as u32 {
        return None;
    }
    reader.seek(SeekFrom::Start(offset.into())).ok()?;
    let mut pe = [0; 6];
    reader.read_exact(&mut pe).ok()?;
    if &pe[..4] != b"PE\0\0" {
        return None;
    }
    Some(match u16::from_le_bytes([pe[4], pe[5]]) {
        0x8664 => Architecture::X64,
        0x014c => Architecture::X86,
        0xaa64 => Architecture::Arm64,
        0x01c4 => Architecture::Arm,
        _ => Architecture::Unknown,
    })
}

fn read_file(path: &str) -> Option<Architecture> {
    if !file_path(path) {
        return None;
    }
    let file = File::open(path).ok()?;
    if !file.metadata().ok()?.is_file() {
        return None;
    }
    machine(file)
}

pub(crate) fn serve(pipe: broker::Handle, parent: u32) -> Result<(), String> {
    let deadline = Instant::now() + TIMEOUT;
    let request: Request = broker::receive_until(pipe, deadline)?;
    broker::require_live_parent(parent)?;
    let reply = match request {
        Request::Read {
            version: VERSION,
            paths,
        } if paths.len() <= MAX_BATCH => Reply::Read {
            version: VERSION,
            architectures: paths
                .iter()
                .map(|path| read_file(path).unwrap_or(Architecture::Unknown))
                .collect(),
        },
        #[cfg(feature = "packaged-panic-probe")]
        Request::Panic { version: VERSION } => {
            broker::send_until(pipe, &Reply::Panicking { version: VERSION }, deadline)?;
            std::panic::set_hook(Box::new(|_| {}));
            panic!("inert packaged PE worker fixture");
        }
        _ => return Err(FAILURE.into()),
    };
    broker::send_until(pipe, &reply, deadline)
}

#[link(name = "kernel32")]
extern "system" {
    fn WaitForSingleObject(handle: broker::Handle, milliseconds: u32) -> u32;
}

fn confirm_worker_exit(process: &OwnedHandle) -> Result<(), String> {
    if unsafe { WaitForSingleObject(process.as_raw_handle(), 5_000) } == 0 {
        Ok(())
    } else {
        Err(FAILURE.into())
    }
}

fn exchange(
    request: impl Serialize,
    deadline: Instant,
) -> Result<(std::process::ExitStatus, Option<Reply>), String> {
    let (name, pipe) = recovery_worker::new_worker_pipe()?;
    let mut worker = recovery_worker::pe_worker_command(&name)?;
    let mut reply = None;
    let mut worker_handle = None;
    let output = process_io::execute_in_job(
        &mut worker,
        None,
        deadline.saturating_duration_since(Instant::now()),
        1024,
        None,
        |child| {
            worker_handle = Some(
                child
                    .as_handle()
                    .try_clone_to_owned()
                    .map_err(|_| FAILURE)?,
            );
            broker::accept_pipe_until(pipe.0, deadline)?;
            recovery_worker::authenticate_worker(pipe.0, child)?;
            broker::send_until(pipe.0, &request, deadline)?;
            // A missing reply alone cannot prove a crash or termination.
            // Always let the job runner observe the child exit and confirm cleanup.
            reply = broker::receive_until(pipe.0, deadline).ok();
            Ok(())
        },
    );
    // Job accounting can reach zero just before the process handle signals.
    if let Some(handle) = worker_handle {
        confirm_worker_exit(&handle)?;
    }
    Ok((output?.status, reply))
}

fn batch_result(
    count: usize,
    result: Result<(std::process::ExitStatus, Option<Reply>), String>,
) -> Result<Vec<String>, String> {
    match result {
        Ok((
            status,
            Some(Reply::Read {
                version: VERSION,
                architectures,
            }),
        )) if status.success() && architectures.len() == count => Ok(architectures
            .into_iter()
            .map(|arch| arch.as_str().to_owned())
            .collect()),
        _ => Err(FAILURE.into()),
    }
}

fn read_batches(
    paths: Vec<String>,
    mut read: impl FnMut(Vec<String>) -> Result<Vec<String>, String>,
) -> Result<Vec<String>, String> {
    let mut output = Vec::with_capacity(paths.len());
    let mut batch = Vec::new();
    let mut size = 0;
    for mut path in paths {
        if path.len() > MAX_PATH_BYTES {
            path.clear();
        }
        // Worst-case JSON string expansion, plus quotes and a comma. The gap
        // between this budget and the broker limit covers the request envelope.
        let cost = 3 + path
            .bytes()
            .map(|byte| match byte {
                b'\\' | b'"' => 2,
                0..=31 => 6,
                _ => 1,
            })
            .sum::<usize>();
        // Windows paths with this many control characters cannot name files.
        if cost > MAX_FRAME_BYTES {
            path.clear();
        }
        let cost = if path.is_empty() { 3 } else { cost };
        if batch.len() == MAX_BATCH || size + cost > MAX_FRAME_BYTES {
            output.extend(read(std::mem::take(&mut batch))?);
            size = 0;
        }
        size += cost;
        batch.push(path);
    }
    if !batch.is_empty() {
        output.extend(read(batch)?);
    }
    Ok(output)
}

fn read_until(paths: Vec<String>, deadline: Instant) -> Result<Vec<String>, String> {
    read_batches(paths, |paths| {
        let count = paths.len();
        if deadline <= Instant::now() {
            return Err(FAILURE.into());
        }
        batch_result(
            count,
            exchange(
                Request::Read {
                    version: VERSION,
                    paths,
                },
                deadline,
            ),
        )
    })
}

pub(crate) fn read(paths: Vec<String>) -> Result<Vec<String>, String> {
    read_until(paths, Instant::now() + TIMEOUT)
}

fn qualification_requested(args: &mut impl Iterator<Item = std::ffi::OsString>) -> bool {
    args.next().is_some_and(|mode| mode == PROBE_MODE)
}

pub(crate) fn qualification_entry() {
    let mut args = std::env::args_os().skip(1);
    if !qualification_requested(&mut args) {
        return;
    }
    #[cfg(feature = "packaged-panic-probe")]
    if args.next().is_none() && qualify().is_ok() {
        std::process::exit(0);
    }
    eprintln!("{PROBE_UNAVAILABLE}");
    std::process::exit(2);
}
#[cfg(feature = "packaged-panic-probe")]
fn qualify() -> Result<(), String> {
    if !cfg!(panic = "abort") {
        return Err(FAILURE.into());
    }
    let outcome = exchange(
        Request::Panic { version: VERSION },
        Instant::now() + TIMEOUT,
    );
    // MSVC fast-fail from abort. Require the authenticated pre-panic marker
    // and a confirmed reaped child before running a second request.
    if !matches!(
        &outcome,
        Ok((status, Some(Reply::Panicking { version: VERSION })))
            if status.code().map(|code| code as u32) == Some(0xc000_0409)
    ) {
        return Err(FAILURE.into());
    }
    let diagnostic = batch_result(0, outcome).unwrap_err();
    let executable = std::env::current_exe().map_err(|_| FAILURE)?;
    let executable = executable.to_str().ok_or(FAILURE)?;
    if read(vec![executable.to_owned()])? != ["x64"] {
        return Err(FAILURE.into());
    }
    println!(
        "{}",
        serde_json::json!({
            "contained": true,
            "childReaped": true,
            "nextArchitecture": "x64",
            "diagnostic": diagnostic
        })
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn header(machine: u16) -> [u8; 70] {
        let mut bytes = [0; 70];
        bytes[..2].copy_from_slice(b"MZ");
        bytes[60..64].copy_from_slice(&64u32.to_le_bytes());
        bytes[64..68].copy_from_slice(b"PE\0\0");
        bytes[68..70].copy_from_slice(&machine.to_le_bytes());
        bytes
    }

    #[test]
    fn qualification_flag_is_private_and_positioned_first() {
        let args = |raw: &[&str]| {
            raw.iter()
                .map(std::ffi::OsString::from)
                .collect::<Vec<_>>()
                .into_iter()
        };
        assert!(!qualification_requested(&mut args(&[])));
        assert!(!qualification_requested(&mut args(&[
            "--unrelated",
            PROBE_MODE
        ])));
        assert!(qualification_requested(&mut args(&[PROBE_MODE])));
        assert!(qualification_requested(&mut args(&[
            PROBE_MODE,
            "bad-extra-argument"
        ])));
    }

    #[test]
    fn header_decodes_machines_and_rejects_malformed_offsets_and_signatures() {
        for (number, expected) in [
            (0x8664, "x64"),
            (0x014c, "x86"),
            (0xaa64, "arm64"),
            (0x01c4, "arm"),
            (0xffff, ""),
        ] {
            assert_eq!(
                machine(Cursor::new(header(number))).unwrap().as_str(),
                expected
            );
        }
        let mut bytes = header(0x8664);
        assert!(machine(Cursor::new(&bytes[..63])).is_none());
        assert!(machine(Cursor::new(&bytes[..68])).is_none());
        bytes[0] = 0;
        assert!(machine(Cursor::new(bytes)).is_none());
        bytes = header(0x8664);
        bytes[64] = 0;
        assert!(machine(Cursor::new(bytes)).is_none());
        for offset in [0u32, 63, u32::MAX] {
            bytes[60..64].copy_from_slice(&offset.to_le_bytes());
            assert!(machine(Cursor::new(bytes)).is_none());
        }
    }

    #[test]
    fn path_validation_excludes_device_stream_and_nonabsolute_paths() {
        for path in [
            r"C:\app\one.exe",
            r"C:/app/one.exe",
            r"\\?\C:\app\one.exe",
            r"\\server\share\one.exe",
            r"\\?\UNC\server\share\one.exe",
        ] {
            assert!(file_path(path), "{path}");
        }
        for path in [
            "",
            "file.exe",
            r"C:file.exe",
            r"\folder\file.exe",
            r"\\.\pipe\one.exe",
            r"\\?\GLOBALROOT\Device\one.exe",
            r"\\server\pipe\one.exe",
            r"\\?\UNC\server\mailslot\one.exe",
            r"\\server\iPc$.\one.exe",
            r"C:\normal.exe:alternate",
            r"C:\path\nul .exe",
            r"C:\path\lpt³.exe",
            "C:\\path\\bad\0.exe",
        ] {
            assert!(!file_path(path), "{path}");
        }
        assert!(!file_path(&"x".repeat(MAX_PATH_BYTES + 1)));
    }

    #[test]
    fn batches_preserve_order_and_respect_count_and_wire_limits() {
        let mut paths = vec![r"C:\path\long.exe".replace("long", &"é".repeat(40_000)); 5];
        paths.extend((0..MAX_BATCH + 2).map(|i| format!("C:\\test\\{i}.exe")));
        paths.push("x".repeat(MAX_PATH_BYTES + 1));
        paths.push("\u{0001}".repeat(50_000));
        paths.push("\"\\quoted".to_owned());
        let mut expected = paths.clone();
        expected[MAX_BATCH + 7].clear();
        expected[MAX_BATCH + 8].clear();
        let mut sizes = Vec::new();
        let actual = read_batches(paths, |batch| {
            sizes.push(batch.len());
            let wire = serde_json::to_vec(&Request::Read {
                version: VERSION,
                paths: batch.clone(),
            })
            .unwrap();
            assert!(wire.len() < 256 * 1024);
            Ok(batch)
        })
        .unwrap();
        assert_eq!(actual, expected);
        assert!(sizes.len() > 2);
        assert!(sizes.iter().all(|size| *size <= MAX_BATCH));
        assert!(sizes.contains(&MAX_BATCH));
        assert!(
            read_batches(Vec::new(), |_| panic!("empty request spawned a worker"))
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            read_batches(vec!["path".into()], |_| Err(FAILURE.into())).unwrap_err(),
            FAILURE
        );
    }

    #[test]
    fn closed_wire_rejects_wrong_operation_version_fields_and_response_lengths() {
        for message in [
            serde_json::json!({"operation":"read","version":1,"paths":["file.exe"],"args":[]}),
            serde_json::json!({"operation":"exec","version":1,"paths":[]}),
            serde_json::json!({"operation":"read","version":2,"paths":[]}),
            serde_json::json!({"operation":"read","version":1,"paths":vec![""; MAX_BATCH + 1]}),
        ] {
            let outcome = exchange(message, Instant::now() + TIMEOUT).unwrap();
            assert!(!outcome.0.success());
            assert!(outcome.1.is_none());
        }
        #[cfg(not(feature = "packaged-panic-probe"))]
        {
            let outcome = exchange(
                serde_json::json!({"operation":"panic","version":1}),
                Instant::now() + TIMEOUT,
            )
            .unwrap();
            assert_eq!(outcome.0.code(), Some(2));
            assert!(outcome.1.is_none());
        }
        let reply = |version, architectures| {
            Some(Reply::Read {
                version,
                architectures,
            })
        };
        use std::os::windows::process::ExitStatusExt;
        let ok = std::process::ExitStatus::from_raw(0);
        let error = std::process::ExitStatus::from_raw(2);
        for result in [
            Ok((ok, reply(2, vec![Architecture::X64]))),
            Ok((ok, reply(VERSION, Vec::new()))),
            Ok((error, reply(VERSION, vec![Architecture::X64]))),
            Ok((ok, None)),
            Err("C:\\private\\unexpected.exe".into()),
        ] {
            assert_eq!(batch_result(1, result).unwrap_err(), FAILURE);
        }
        assert!(serde_json::from_value::<Reply>(serde_json::json!({
            "operation":"read","version":1,"architectures":["bad"]
        }))
        .is_err());
    }

    #[test]
    fn real_worker_returns_ordered_paths_and_recovers_after_denied_or_expired_request() {
        let root = std::env::temp_dir().join(format!(
            "purgeon-pe-worker-{}",
            broker::random_id().unwrap()
        ));
        std::fs::create_dir(&root).unwrap();
        let path = root.join("input.exe");
        std::fs::write(&path, header(0xaa64)).unwrap();
        let path = path.to_str().unwrap().to_owned();
        let missing = root.join("missing.exe").to_str().unwrap().to_owned();
        let directory = root.to_str().unwrap().to_owned();
        let own = std::env::current_exe()
            .unwrap()
            .to_str()
            .unwrap()
            .to_owned();

        for denied in [true, false] {
            let handle = std::rc::Rc::new(std::cell::RefCell::new(None::<OwnedHandle>));
            let observed = handle.clone();
            process_io::AFTER_SPAWN.with(|slot| {
                *slot.borrow_mut() = Some(Box::new(move |child| {
                    *observed.borrow_mut() = Some(child.as_handle().try_clone_to_owned().unwrap());
                    if !denied {
                        std::thread::sleep(Duration::from_millis(1_100));
                    }
                }));
            });
            if denied {
                recovery_worker::REJECT_NEXT_PEER.with(|flag| flag.set(true));
            }
            let timeout = if denied {
                TIMEOUT
            } else {
                Duration::from_secs(1)
            };
            let deadline = Instant::now() + timeout;
            assert_eq!(
                read_until(vec![path.clone()], deadline).unwrap_err(),
                FAILURE
            );
            assert!(!recovery_worker::REJECT_NEXT_PEER.with(std::cell::Cell::get));
            let handle = handle.borrow_mut().take().unwrap();
            assert_eq!(unsafe { WaitForSingleObject(handle.as_raw_handle(), 0) }, 0);
        }

        assert_eq!(
            read_until(vec![path.clone()], Instant::now()).unwrap_err(),
            FAILURE
        );
        assert_eq!(
            read(vec![
                missing,
                path,
                directory,
                own,
                r"\\.\pipe\fixture.exe".into()
            ])
            .unwrap(),
            ["", "arm64", "", "x64", ""]
        );
        std::fs::remove_file(root.join("input.exe")).unwrap();
        std::fs::remove_dir(root).unwrap();
    }
}
