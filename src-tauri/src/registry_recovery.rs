//! Lease-owned registry recovery images. Source and image stay read-only pinned
//! through a known importer exit; no caller-selected executable or image path.
use crate::transfer_recovery as files;
use sha2::{Digest, Sha256};
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

pub(crate) const MAX_SOURCE: usize = 8 * 1024 * 1024;
pub(crate) const MAX_TOTAL: usize = 64 * 1024 * 1024;
pub(crate) const MAX_PINS: usize = 64;
const READ: u32 = 0x80000000;
const DELETE: u32 = 0x10000;

fn hash(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
fn read(file: &mut File, limit: usize) -> Result<Vec<u8>, String> {
    let size = usize::try_from(file.metadata().map_err(|e| e.to_string())?.len())
        .map_err(|e| e.to_string())?;
    if size > limit {
        return Err("Registry recovery export exceeds safety limits".into());
    }
    file.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
    let mut bytes = Vec::with_capacity(size);
    file.take((limit + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() != size {
        return Err("Registry recovery image changed while reading".into());
    }
    Ok(bytes)
}
fn decode(bytes: &[u8]) -> Result<String, String> {
    let text = if bytes.starts_with(&[0xff, 0xfe]) || bytes.starts_with(&[0xfe, 0xff]) {
        if !bytes.len().is_multiple_of(2) {
            return Err("Invalid UTF-16 registry export".into());
        }
        let little = bytes[0] == 0xff;
        let words: Vec<u16> = bytes[2..]
            .as_chunks::<2>()
            .0
            .iter()
            .map(|b| {
                if little {
                    u16::from_le_bytes([b[0], b[1]])
                } else {
                    u16::from_be_bytes([b[0], b[1]])
                }
            })
            .collect();
        String::from_utf16(&words).map_err(|_| "Invalid UTF-16 registry export")?
    } else {
        String::from_utf8(
            bytes
                .strip_prefix(&[0xef, 0xbb, 0xbf])
                .unwrap_or(bytes)
                .to_vec(),
        )
        .map_err(|_| "Invalid UTF-8 registry export")?
    };
    if text.contains('\0') || text.starts_with('\u{feff}') {
        return Err("Ambiguous registry export encoding".into());
    }
    Ok(text)
}
fn valid_name(name: &str) -> bool {
    name.strip_prefix("before-")
        .and_then(|v| v.strip_suffix(".reg"))
        .is_some_and(|v| {
            !v.is_empty() && !v.starts_with('0') && v.bytes().all(|b| b.is_ascii_digit())
        })
}
struct CreatingImage<'a> {
    parents: &'a files::Parents,
    path: &'a Path,
    identity: files::Identity,
    writer: Option<File>,
    committed: bool,
}
impl CreatingImage<'_> {
    fn cleanup(&mut self) -> Result<(), String> {
        self.parents.verify()?;
        if let Some(writer) = self.writer.as_ref() {
            if files::identity(writer, false)? != self.identity {
                return Err("Created image identity changed".into());
            }
            files::cleanup_held(writer)?;
        } else {
            let file = files::open(self.path, false, DELETE | 0x80, 0)?;
            if files::identity(&file, false)? != self.identity {
                return Err("Created image identity changed".into());
            }
            files::cleanup_held(&file)?;
        }
        self.committed = true;
        Ok(())
    }
}
impl Drop for CreatingImage<'_> {
    fn drop(&mut self) {
        if !self.committed {
            let _ = self.cleanup();
        }
    }
}
pub(crate) struct Pinned {
    source: File,
    source_path: PathBuf,
    source_id: files::Identity,
    source_hash: String,
    parents: files::Parents,
    image: Option<File>,
    image_path: PathBuf,
    image_id: files::Identity,
    image_hash: String,
    pub(crate) text: String,
    pub(crate) bytes: usize,
}
impl Pinned {
    pub(crate) fn prepare(directory: &Path, name: &str, remaining: usize) -> Result<Self, String> {
        Self::prepare_with(directory, name, remaining, |_, _| Ok(()))
    }
    fn prepare_with(
        directory: &Path,
        name: &str,
        remaining: usize,
        fault: impl Fn(bool, &Path) -> Result<(), String>,
    ) -> Result<Self, String> {
        if !valid_name(name) {
            return Err("Invalid registry recovery export basename".into());
        }
        let source_path = files::canonical(
            directory
                .join(name)
                .to_str()
                .ok_or("Invalid registry export path")?,
        )?;
        if source_path.parent() != Some(directory) {
            return Err("Registry recovery export escaped its journal".into());
        }
        let parents = files::Parents::open(&source_path)?;
        let mut source = files::open(&source_path, false, READ, 1)?;
        let source_id = files::identity(&source, false)?;
        let raw = read(&mut source, MAX_SOURCE.min(remaining))?;
        let text = decode(&raw)?;
        let image_size = text
            .encode_utf16()
            .count()
            .checked_mul(2)
            .and_then(|n| n.checked_add(2))
            .ok_or("Registry image size overflow")?;
        let bytes = raw
            .len()
            .checked_add(image_size)
            .ok_or("Registry image size overflow")?;
        if bytes > remaining {
            return Err("Pinned registry recovery resource budget exceeded".into());
        }
        let mut normalized = Vec::with_capacity(image_size);
        normalized.extend_from_slice(&[0xff, 0xfe]);
        for word in text.encode_utf16() {
            normalized.extend_from_slice(&word.to_le_bytes());
        }
        let image_path = directory.join(format!(
            ".registry-import-{}.reg",
            crate::broker::random_id()?
        ));
        let writer = OpenOptions::new()
            .read(true)
            .write(true)
            .access_mode(READ | 0x40000000 | DELETE)
            .create_new(true)
            .share_mode(0)
            .custom_flags(0x00200000)
            .open(&image_path)
            .map_err(|e| e.to_string())?;
        let image_id = match files::identity(&writer, false) {
            Ok(id) => id,
            Err(error) => {
                // CREATE_NEW owns this exact handle even if metadata query failed.
                if files::cleanup_held(&writer).is_err() {
                    return Err(format!(
                        "{error}; partial import image retained at {}",
                        image_path.display()
                    ));
                }
                return Err(error);
            }
        };
        let mut creating = CreatingImage {
            parents: &parents,
            path: &image_path,
            identity: image_id.clone(),
            writer: Some(writer),
            committed: false,
        };
        let prepared = (|| -> Result<File, String> {
            fault(false, &image_path)?;
            let writer = creating.writer.as_mut().ok_or("Image writer unavailable")?;
            writer
                .write_all(&normalized)
                .and_then(|()| writer.sync_all())
                .map_err(|e| e.to_string())?;
            drop(creating.writer.take());
            fault(true, &image_path)?;
            let mut image = files::open(&image_path, false, READ, 1)?;
            if files::identity(&image, false)? != image_id
                || read(&mut image, image_size)? != normalized
            {
                return Err("Registry import image was replaced".into());
            }
            parents.verify()?;
            Ok(image)
        })();
        let image = match prepared {
            Ok(image) => {
                creating.committed = true;
                drop(creating);
                image
            }
            Err(error) => {
                if creating.cleanup().is_err() {
                    return Err(format!(
                        "{error}; partial import image retained for identity review at {}",
                        image_path.display()
                    ));
                }
                return Err(error);
            }
        };
        Ok(Self {
            source,
            source_path,
            source_id,
            source_hash: hash(&raw),
            parents,
            image: Some(image),
            image_path,
            image_id,
            image_hash: hash(&normalized),
            text,
            bytes,
        })
    }
    pub(crate) fn verify(&mut self) -> Result<(), String> {
        self.parents.verify()?;
        files::verify_path(&self.source, &self.source_path)?;
        if files::identity(&self.source, false)? != self.source_id
            || hash(&read(&mut self.source, MAX_SOURCE)?) != self.source_hash
        {
            return Err("Pinned registry export changed".into());
        }
        let image = self
            .image
            .as_mut()
            .ok_or("Registry import image is unavailable")?;
        files::verify_path(image, &self.image_path)?;
        if files::identity(image, false)? != self.image_id
            || hash(&read(image, MAX_TOTAL)?) != self.image_hash
        {
            return Err("Pinned registry import image changed".into());
        }
        Ok(())
    }
    pub(crate) fn import(&mut self) -> RunOutcome {
        if let Err(error) = self.verify() {
            return RunOutcome::Known(Err(error));
        }
        let executable = match crate::windows_tools::system_file("reg.exe") {
            Ok(path) => path,
            Err(error) => return RunOutcome::Known(Err(error)),
        };
        let mut command = Command::new(executable);
        command
            .arg("import")
            .arg(&self.image_path)
            .arg("/reg:64")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(0x08000000);
        run(&mut command, Duration::from_secs(120))
    }
}
impl Drop for Pinned {
    fn drop(&mut self) {
        // The child is known finished before this owner is dropped. Reopen only
        // to delete the same created image by handle; a replacement is retained.
        drop(self.image.take());
        let cleanup = (|| -> Result<(), String> {
            self.parents.verify()?;
            let file = files::open(&self.image_path, false, DELETE | 0x80, 0)?;
            if files::identity(&file, false)? != self.image_id {
                return Err("Import image identity changed".into());
            }
            files::cleanup_held(&file)
        })();
        let _ = cleanup;
    }
}

pub(crate) struct ProcessExit {
    pub(crate) success: bool,
    pub(crate) code: Option<i32>,
}
pub(crate) trait Running: Send {
    fn poll(&mut self) -> Result<Option<ProcessExit>, String>;
    fn kill(&mut self) -> Result<(), String>;
}
// Windows job handles may be moved between threads. This wrapper only owns and
// closes the handle; it never exposes or concurrently aliases the raw handle.
struct ImportJob {
    _inner: crate::security::ProcessJob,
}
unsafe impl Send for ImportJob {}
struct Process {
    child: Child,
    _job: Option<ImportJob>,
}
impl Running for Process {
    fn poll(&mut self) -> Result<Option<ProcessExit>, String> {
        self.child
            .try_wait()
            .map(|s| {
                s.map(|s| ProcessExit {
                    success: s.success(),
                    code: s.code(),
                })
            })
            .map_err(|e| e.to_string())
    }
    fn kill(&mut self) -> Result<(), String> {
        self.child.kill().map_err(|e| e.to_string())
    }
}
pub(crate) enum RunOutcome {
    Known(Result<(), String>),
    Unknown(Box<dyn Running>),
}
fn terminate(mut child: Box<dyn Running>, message: String, allowance: Duration) -> RunOutcome {
    let _ = child.kill();
    let deadline = Instant::now() + allowance;
    loop {
        if let Ok(Some(_)) = child.poll() {
            return RunOutcome::Known(Err(message));
        }
        if Instant::now() >= deadline {
            return RunOutcome::Unknown(child);
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}
fn wait(mut child: Box<dyn Running>, timeout: Duration) -> RunOutcome {
    let deadline = Instant::now() + timeout;
    loop {
        match child.poll() {
            Ok(Some(status)) => {
                return RunOutcome::Known(if status.success {
                    Ok(())
                } else {
                    Err(format!("Registry recovery importer failed (exit code {}); recovery evidence retained", status.code.map_or_else(|| "unavailable".into(), |code| code.to_string())))
                })
            }
            Err(error) => {
                return terminate(
                    child,
                    format!("Registry importer wait failed: {error}"),
                    Duration::from_secs(2),
                )
            }
            Ok(None) => {}
        }
        if Instant::now() >= deadline {
            return terminate(
                child,
                "Registry recovery import timed out; outcome needs review".into(),
                Duration::from_secs(2),
            );
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}
fn run(command: &mut Command, timeout: Duration) -> RunOutcome {
    let child = match command.spawn() {
        Ok(child) => child,
        Err(error) => return RunOutcome::Known(Err(error.to_string())),
    };
    match crate::security::ProcessJob::assign(&child) {
        Ok(job) => wait(
            Box::new(Process {
                child,
                _job: Some(ImportJob { _inner: job }),
            }),
            timeout,
        ),
        Err(error) => terminate(
            Box::new(Process { child, _job: None }),
            format!("Registry importer job assignment failed: {error}"),
            Duration::from_secs(2),
        ),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    struct Fixture {
        root: PathBuf,
    }
    impl Fixture {
        fn new(bytes: &[u8]) -> Self {
            let raw = std::env::temp_dir().join(format!(
                "purgeon-pinned-{}",
                crate::broker::random_id().unwrap()
            ));
            fs::create_dir_all(&raw).unwrap();
            let root = files::canonical(raw.join("probe").to_str().unwrap())
                .unwrap()
                .parent()
                .unwrap()
                .to_path_buf();
            fs::write(root.join("before-1.reg"), bytes).unwrap();
            Self { root }
        }
        fn pin(&self) -> Pinned {
            Pinned::prepare(&self.root, "before-1.reg", MAX_TOTAL).unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.root).unwrap();
        }
    }
    const TEXT: &str = "Windows Registry Editor Version 5.00\r\n\r\n[HKEY_CURRENT_USER\\Software\\Pinned]\r\n\"Unicode\"=\"恢复 café\"\r\n";
    #[test]
    fn exact_unicode_sources_normalize_and_hold_source_image_and_ancestor_pins() {
        let utf16 = |little| {
            let mut bytes = if little {
                vec![255, 254]
            } else {
                vec![254, 255]
            };
            for word in TEXT.encode_utf16() {
                bytes.extend_from_slice(&if little {
                    word.to_le_bytes()
                } else {
                    word.to_be_bytes()
                });
            }
            bytes
        };
        for bytes in [
            TEXT.as_bytes().to_vec(),
            [vec![239, 187, 191], TEXT.as_bytes().to_vec()].concat(),
            utf16(true),
            utf16(false),
        ] {
            let f = Fixture::new(&bytes);
            let mut pin = f.pin();
            assert_eq!(pin.text, TEXT);
            pin.verify().unwrap();
            assert_eq!(decode(&fs::read(&pin.image_path).unwrap()).unwrap(), TEXT);
            assert!(fs::write(f.root.join("before-1.reg"), b"changed").is_err());
            assert!(fs::remove_file(f.root.join("before-1.reg")).is_err());
            assert!(fs::write(&pin.image_path, b"changed").is_err());
            assert!(fs::remove_file(&pin.image_path).is_err());
            assert!(fs::rename(&f.root, f.root.with_extension("moved")).is_err());
            // An ordinary read/shareREAD importer remains compatible.
            let mut reader = OpenOptions::new()
                .read(true)
                .share_mode(1)
                .open(&pin.image_path)
                .unwrap();
            let mut actual = Vec::new();
            reader.read_to_end(&mut actual).unwrap();
            assert_eq!(decode(&actual).unwrap(), TEXT);
            drop(reader);
            let image = pin.image_path.clone();
            drop(pin);
            assert!(!image.exists());
            fs::write(f.root.join("before-1.reg"), b"released").unwrap();
        }
    }
    #[test]
    fn malformed_encodings_names_links_writers_and_resource_limits_refuse_before_import() {
        for bytes in [
            vec![255, 254, 0],
            vec![255, 254, 0, 216],
            vec![0xff],
            vec![255, 254, 0, 0],
            vec![239, 187, 191, 239, 187, 191],
        ] {
            let f = Fixture::new(&bytes);
            assert!(Pinned::prepare(&f.root, "before-1.reg", MAX_TOTAL).is_err());
            assert_eq!(fs::read(f.root.join("before-1.reg")).unwrap(), bytes);
        }
        let f = Fixture::new(TEXT.as_bytes());
        for name in [
            "../before-1.reg",
            "before-0.reg",
            "before-1.reg:stream",
            "C:\\bad.reg",
            "before-1.reg\\child",
        ] {
            assert!(Pinned::prepare(&f.root, name, MAX_TOTAL).is_err());
        }
        let writer = OpenOptions::new()
            .write(true)
            .share_mode(7)
            .open(f.root.join("before-1.reg"))
            .unwrap();
        assert!(Pinned::prepare(&f.root, "before-1.reg", MAX_TOTAL).is_err());
        drop(writer);
        fs::hard_link(f.root.join("before-1.reg"), f.root.join("alias.reg")).unwrap();
        assert!(Pinned::prepare(&f.root, "before-1.reg", MAX_TOTAL).is_err());
        fs::remove_file(f.root.join("alias.reg")).unwrap();
        assert!(Pinned::prepare(&f.root, "before-1.reg", TEXT.len()).is_err());
        let large = vec![b'a'; MAX_SOURCE + 1];
        let f = Fixture::new(&large);
        assert!(Pinned::prepare(&f.root, "before-1.reg", MAX_TOTAL).is_err());
    }
    #[test]
    fn neutral_reader_keeps_pins_until_real_child_exit_and_timeout_is_confirmed() {
        const ENV: &str = "PURGEON_PINNED_READER";
        if let Some(path) = std::env::var_os(ENV) {
            let path = PathBuf::from(path);
            let file = OpenOptions::new()
                .read(true)
                .share_mode(1)
                .open(&path)
                .unwrap();
            assert_eq!(decode(&fs::read(&path).unwrap()).unwrap(), TEXT);
            fs::write(path.with_extension("started"), b"ready").unwrap();
            while !path.with_extension("release").exists() {
                std::thread::sleep(Duration::from_millis(10));
            }
            drop(file);
            return;
        }
        for timeout in [false, true] {
            let f = Fixture::new(TEXT.as_bytes());
            let pin = f.pin();
            let image = pin.image_path.clone();
            let source = f.root.join("before-1.reg");
            let observer = std::thread::spawn(move || {
                let until = Instant::now() + Duration::from_secs(10);
                while !image.with_extension("started").exists() {
                    assert!(Instant::now() < until);
                    std::thread::sleep(Duration::from_millis(10));
                }
                assert!(fs::write(&source, b"changed").is_err());
                assert!(fs::remove_file(&image).is_err());
                if !timeout {
                    fs::write(image.with_extension("release"), b"go").unwrap();
                }
            });
            let mut command = Command::new(std::env::current_exe().unwrap());
            command.args(["--exact","registry_recovery::tests::neutral_reader_keeps_pins_until_real_child_exit_and_timeout_is_confirmed","--nocapture"]).env(ENV,&pin.image_path).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).creation_flags(0x08000000);
            let child = command.spawn().unwrap();
            let job = crate::security::ProcessJob::assign(&child).unwrap();
            // Start the short timeout after the neutral reader is ready, not
            // during variable CI process startup latency.
            let ready_deadline = Instant::now() + Duration::from_secs(10);
            while !pin.image_path.with_extension("started").exists() {
                assert!(Instant::now() < ready_deadline);
                std::thread::sleep(Duration::from_millis(10));
            }
            let result = wait(
                Box::new(Process {
                    child,
                    _job: Some(ImportJob { _inner: job }),
                }),
                if timeout {
                    Duration::from_secs(1)
                } else {
                    Duration::from_secs(10)
                },
            );
            match result {
                RunOutcome::Known(result) => assert_eq!(result.is_ok(), !timeout),
                RunOutcome::Unknown(_) => panic!("Neutral child termination must be known"),
            };
            observer.join().unwrap();
            drop(pin);
        }
    }
    #[test]
    fn failed_spawn_and_nonzero_exit_are_bounded_without_registry_execution() {
        let mut missing = Command::new("C:\\PurgeonDoesNotExist\\missing.exe");
        assert!(matches!(
            run(&mut missing, Duration::from_secs(1)),
            RunOutcome::Known(Err(_))
        ));
        let mut command = Command::new(crate::windows_tools::system_file("cmd.exe").unwrap());
        command
            .args(["/c", "exit", "7"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(0x08000000);
        match run(&mut command, Duration::from_secs(5)) {
            RunOutcome::Known(Err(error)) => assert!(error.contains("7")),
            _ => panic!("Nonzero result was not retained"),
        };
    }
    #[test]
    fn parent_junction_is_refused_without_touching_the_recovery_export() {
        let f = Fixture::new(TEXT.as_bytes());
        let target = f.root.join("actual");
        fs::create_dir(&target).unwrap();
        fs::write(target.join("before-1.reg"), TEXT).unwrap();
        let junction = f.root.join("redirect");
        let status = Command::new(crate::windows_tools::system_file("cmd.exe").unwrap())
            .args(["/c", "mklink", "/J"])
            .arg(&junction)
            .arg(&target)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(0x08000000)
            .status()
            .unwrap();
        assert!(status.success());
        assert!(Pinned::prepare(&junction, "before-1.reg", MAX_TOTAL).is_err());
        assert_eq!(
            fs::read_to_string(target.join("before-1.reg")).unwrap(),
            TEXT
        );
        fs::remove_dir(junction).unwrap();
    }
    #[test]
    fn failed_image_preparation_cleans_owned_handles_and_never_deletes_a_replacement() {
        for after_close in [false, true] {
            let f = Fixture::new(TEXT.as_bytes());
            assert!(
                Pinned::prepare_with(&f.root, "before-1.reg", MAX_TOTAL, |closed, _| {
                    if closed == after_close {
                        Err("injected prepare failure".into())
                    } else {
                        Ok(())
                    }
                })
                .is_err()
            );
            assert_eq!(fs::read_dir(&f.root).unwrap().count(), 1);
        }
        let f = Fixture::new(TEXT.as_bytes());
        let foreign = std::sync::Mutex::new(None);
        let error = Pinned::prepare_with(&f.root, "before-1.reg", MAX_TOTAL, |closed, path| {
            if closed {
                fs::remove_file(path).unwrap();
                fs::write(path, b"foreign replacement").unwrap();
                *foreign.lock().unwrap() = Some(path.to_path_buf());
                return Err("injected replacement".into());
            }
            Ok(())
        })
        .err()
        .unwrap();
        assert!(error.contains("retained"));
        assert_eq!(
            fs::read(foreign.lock().unwrap().as_ref().unwrap()).unwrap(),
            b"foreign replacement"
        );
    }
}
