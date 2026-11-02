//! Same-directory commits use an exclusively held source handle. Ancestors stay
//! open without delete sharing, so a checked parent cannot be replaced mid-write.
//! Flushing contents before atomic rename avoids torn files; this is not a
//! guarantee against every storage controller or filesystem power-loss failure.
use std::ffi::c_void;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::io::AsRawHandle;
use std::path::{Path, PathBuf};

const OPEN_REPARSE: u32 = 0x00200000;
const BACKUP_SEMANTICS: u32 = 0x02000000;
const READ_ATTRIBUTES: u32 = 0x80;
const DELETE: u32 = 0x10000;

#[repr(C)]
struct Information {
    attributes: u32,
    creation: [u32; 2],
    access: [u32; 2],
    write: [u32; 2],
    volume: u32,
    size_high: u32,
    size_low: u32,
    links: u32,
    index_high: u32,
    index_low: u32,
}
#[repr(C)]
struct RenameInformation {
    replace: u8,
    root: *mut c_void,
    length: u32,
    name: [u16; 1],
}
#[repr(C)]
struct DispositionInformation {
    delete: u8,
}
#[link(name = "kernel32")]
extern "system" {
    fn GetFileInformationByHandle(file: *mut c_void, info: *mut Information) -> i32;
    fn SetFileInformationByHandle(
        file: *mut c_void,
        class: u32,
        information: *const c_void,
        length: u32,
    ) -> i32;
    fn GetFinalPathNameByHandleW(file: *mut c_void, path: *mut u16, length: u32, flags: u32)
        -> u32;
}
fn last_error() -> String {
    std::io::Error::last_os_error().to_string()
}
fn verify(file: &File, path: &Path, directory: bool) -> Result<(), String> {
    let mut info: Information = unsafe { std::mem::zeroed() };
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
        return Err(last_error());
    }
    if info.attributes & 0x400 != 0
        || (info.attributes & 0x10 != 0) != directory
        || (!directory && info.links != 1)
    {
        return Err(
            "Atomic commit refuses reparse points, directories and hardlinked files".into(),
        );
    }
    let mut resolved = vec![0u16; 32768];
    let length = unsafe {
        GetFinalPathNameByHandleW(
            file.as_raw_handle(),
            resolved.as_mut_ptr(),
            resolved.len() as u32,
            0,
        )
    } as usize;
    if length == 0 || length >= resolved.len() {
        return Err("Could not verify atomic commit path".into());
    }
    let resolved = String::from_utf16(&resolved[..length]).map_err(|e| e.to_string())?;
    if !directory {
        crate::security::checked_path(resolved.trim_start_matches("\\\\?\\"))?;
    }
    // Windows TEMP and profile paths can legitimately use 8.3 components.
    // Compare the canonical long name after checking the opened object's type;
    // ancestor handles are independently checked and pinned as well.
    let canonical = fs::canonicalize(path).map_err(|e| e.to_string())?;
    let expected = canonical.to_str().ok_or("Invalid atomic commit path")?;
    if !resolved
        .trim_start_matches("\\\\?\\")
        .trim_end_matches('\\')
        .eq_ignore_ascii_case(
            expected
                .trim_start_matches("\\\\?\\")
                .trim_end_matches('\\'),
        )
    {
        return Err("Atomic commit path resolves to a different location".into());
    }
    Ok(())
}
struct Parent {
    path: PathBuf,
    // Pin every ancestor, including directories above the immediate parent.
    handles: Vec<(PathBuf, File)>,
}
impl Parent {
    fn open(target: &Path) -> Result<Self, String> {
        let path = target
            .parent()
            .ok_or("Atomic destination has no parent")?
            .to_path_buf();
        let mut handles = Vec::new();
        let ancestors: Vec<_> = path.ancestors().map(Path::to_path_buf).collect();
        for ancestor in ancestors.into_iter().rev() {
            if !ancestor.exists() {
                // Earlier ancestors remain pinned without delete sharing.
                fs::create_dir(&ancestor).map_err(|e| e.to_string())?;
            }
            let file = OpenOptions::new()
                .access_mode(READ_ATTRIBUTES)
                .share_mode(3)
                .custom_flags(OPEN_REPARSE | BACKUP_SEMANTICS)
                .open(&ancestor)
                .map_err(|e| e.to_string())?;
            verify(&file, &ancestor, true)?;
            handles.push((ancestor, file));
        }
        Ok(Self { path, handles })
    }
    fn recheck(&self) -> Result<(), String> {
        for (path, file) in &self.handles {
            verify(file, path, true)?;
        }
        Ok(())
    }
}
fn canonical_target(path: &Path) -> Result<PathBuf, String> {
    let mut existing = path;
    let mut missing = Vec::new();
    loop {
        match fs::symlink_metadata(existing) {
            Ok(_) => break,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                missing.push(
                    existing
                        .file_name()
                        .ok_or("Invalid atomic path")?
                        .to_os_string(),
                );
                existing = existing
                    .parent()
                    .ok_or("Atomic path has no existing ancestor")?;
            }
            Err(error) => return Err(error.to_string()),
        }
    }
    let canonical = fs::canonicalize(existing).map_err(|e| e.to_string())?;
    let mut canonical = PathBuf::from(canonical.to_string_lossy().trim_start_matches("\\\\?\\"));
    for segment in missing.into_iter().rev() {
        canonical.push(segment);
    }
    crate::security::checked_path(canonical.to_str().ok_or("Invalid canonical atomic path")?)?;
    Ok(canonical)
}
fn destination_check(target: &Path) -> Result<(), String> {
    match OpenOptions::new()
        .access_mode(READ_ATTRIBUTES)
        .share_mode(3)
        .custom_flags(OPEN_REPARSE)
        .open(target)
    {
        Ok(file) => verify(&file, target, false),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
fn rename(file: &File, parent: &Parent, target: &Path) -> Result<(), String> {
    parent.recheck()?;
    destination_check(target)?;
    let canonical = canonical_target(target)?;
    let name: Vec<u16> = canonical.as_os_str().encode_wide().collect();
    if name.contains(&0) {
        return Err("Atomic destination contains a NUL character".into());
    }
    let offset = std::mem::offset_of!(RenameInformation, name);
    let name_bytes = name
        .len()
        .checked_mul(2)
        .ok_or("Atomic rename path is too long")?;
    let length = offset
        .checked_add(name_bytes)
        .and_then(|bytes| bytes.checked_add(2))
        .ok_or("Atomic rename buffer is too large")?;
    let buffer_bytes = u32::try_from(length).map_err(|_| "Atomic rename buffer is too large")?;
    let name_bytes = u32::try_from(name_bytes).map_err(|_| "Atomic rename path is too long")?;
    // u64 alignment covers FILE_RENAME_INFO's pointer fields on x64 Windows.
    // SetFileInformationByHandle also receives a terminating WCHAR. It is not
    // counted in FileNameLength; never rely on incidental allocation padding.
    let mut buffer = vec![0u64; length.div_ceil(8)];
    let info = buffer.as_mut_ptr().cast::<RenameInformation>();
    unsafe {
        (*info).replace = 1;
        (*info).root = std::ptr::null_mut();
        (*info).length = name_bytes;
        std::ptr::copy_nonoverlapping(name.as_ptr(), (*info).name.as_mut_ptr(), name.len());
        if SetFileInformationByHandle(file.as_raw_handle(), 3, info.cast(), buffer_bytes) == 0 {
            return Err(last_error());
        }
    }
    Ok(())
}
fn verify_committed(file: &File, parent: &Parent, target: &Path) -> Result<(), String> {
    let result = (|| {
        #[cfg(test)]
        injected_failure("postverify")?;
        parent.recheck()?;
        verify(file, target, false)
    })();
    result.map_err(|error| format!("Atomic rename completed but destination verification failed: {error}. The committed file is retained; inspect it before retrying"))
}
fn discard(file: &File) {
    let information = DispositionInformation { delete: 1 };
    unsafe {
        SetFileInformationByHandle(
            file.as_raw_handle(),
            4,
            (&information as *const DispositionInformation).cast(),
            std::mem::size_of::<DispositionInformation>() as u32,
        );
    }
}

struct OwnedStage {
    file: File,
    committed: bool,
}

#[cfg(test)]
thread_local! { static FAIL_STAGE: std::cell::Cell<Option<&'static str>> = const { std::cell::Cell::new(None) }; }
#[cfg(test)]
fn injected_failure(stage: &'static str) -> Result<(), String> {
    FAIL_STAGE.with(|failure| {
        if failure.get() == Some(stage) {
            failure.set(None);
            Err(format!("injected {stage} failure"))
        } else {
            Ok(())
        }
    })
}
impl Drop for OwnedStage {
    fn drop(&mut self) {
        if !self.committed {
            discard(&self.file);
        }
    }
}

pub fn write(target: &str, contents: &[u8]) -> Result<(), String> {
    write_stream(target, |file| {
        file.write_all(contents).map_err(|e| e.to_string())
    })
}

/// Streams into a uniquely owned sibling stage; only a fully written, flushed
/// stage can replace the destination. Errors discard the owned handle, never a
/// caller-supplied path or the previous destination.
pub fn write_stream<T>(
    target: &str,
    writer: impl FnOnce(&mut File) -> Result<T, String>,
) -> Result<T, String> {
    crate::security::checked_path(target)?;
    let target = Path::new(target);
    canonical_target(target)?;
    let parent = Parent::open(target)?;
    destination_check(target)?;
    let temporary = parent
        .path
        .join(format!(".purgeon-{}.tmp", crate::broker::random_id()?));
    crate::security::checked_path(temporary.to_str().ok_or("Invalid temporary path")?)?;
    #[cfg(test)]
    injected_failure("create")?;
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .access_mode(0x40000000 | READ_ATTRIBUTES | DELETE)
        .share_mode(0)
        .custom_flags(OPEN_REPARSE)
        .open(&temporary)
        .map_err(|e| e.to_string())?;
    let mut stage = OwnedStage {
        file,
        committed: false,
    };
    (|| {
        verify(&stage.file, &temporary, false)?;
        let value = writer(&mut stage.file)?;
        #[cfg(test)]
        injected_failure("flush")?;
        stage.file.sync_all().map_err(|e| e.to_string())?;
        #[cfg(test)]
        injected_failure("commit")?;
        rename(&stage.file, &parent, target)?;
        // The syscall already committed. A later verification error must never
        // delete the committed destination through the cleanup guard.
        stage.committed = true;
        verify_committed(&stage.file, &parent, target)?;
        Ok(value)
    })()
}

pub fn commit_staged(source: &str, target: &str) -> Result<(), String> {
    crate::security::checked_path(source)?;
    crate::security::checked_path(target)?;
    let source = Path::new(source);
    let target = Path::new(target);
    canonical_target(source)?;
    canonical_target(target)?;
    if source
        .to_string_lossy()
        .eq_ignore_ascii_case(&target.to_string_lossy())
        || !source
            .parent()
            .ok_or("Staged file has no parent")?
            .to_string_lossy()
            .eq_ignore_ascii_case(
                &target
                    .parent()
                    .ok_or("Destination has no parent")?
                    .to_string_lossy(),
            )
    {
        return Err("Staged commit requires different files in the same directory".into());
    }
    let parent = Parent::open(target)?;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .access_mode(0x80000000 | 0x40000000 | READ_ATTRIBUTES | DELETE)
        .share_mode(0)
        .custom_flags(OPEN_REPARSE)
        .open(source)
        .map_err(|e| e.to_string())?;
    verify(&file, source, false)?;
    file.sync_all().map_err(|e| e.to_string())?;
    rename(&file, &parent, target)?;
    verify_committed(&file, &parent, target)
}

/// Native save-picker authority for one create-only EVTX delivery. The caller
/// keeps this object in native memory; its path is never accepted over IPC.
pub(crate) struct ExportDestination {
    path: PathBuf,
    parent: Parent,
}
impl ExportDestination {
    pub(crate) fn selected(path: PathBuf) -> Result<Self, String> {
        let name = path.to_str().ok_or("Invalid selected destination")?;
        crate::security::checked_path(name)?;
        canonical_target(&path)?;
        if !path
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case("evtx"))
        {
            return Err("Choose a new .evtx file".into());
        }
        if !path.parent().is_some_and(Path::is_dir) {
            return Err("Choose an existing local destination folder".into());
        }
        let parent = Parent::open(&path)?;
        match fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
            Err(error) => return Err(error.to_string()),
            Ok(_) => return Err("The selected file already exists. Choose a new filename; existing files are never overwritten".into()),
        }
        Ok(Self { path, parent })
    }
    pub(crate) fn display_path(&self) -> String {
        self.path.to_string_lossy().into_owned()
    }
    pub(crate) fn deliver(
        &self,
        mut source: File,
        expected_digest: &str,
        deadline: std::time::Instant,
        mut progress: impl FnMut(u64) -> Result<(), String>,
    ) -> Result<(), String> {
        use sha2::Digest;
        use std::io::{Read, Seek, SeekFrom};
        self.parent.recheck()?;
        canonical_target(&self.path)?;
        let source_size = source.metadata().map_err(|e| e.to_string())?.len();
        source.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .access_mode(0x40000000 | READ_ATTRIBUTES | DELETE)
            .share_mode(0)
            .custom_flags(OPEN_REPARSE)
            .open(&self.path)
            .map_err(|e| e.to_string())?;
        let result = (|| {
            verify(&file, &self.path, false)?;
            let mut buffer = vec![0u8; 1024 * 1024];
            let mut copied = 0u64;
            let mut digest = sha2::Sha256::new();
            loop {
                if std::time::Instant::now() >= deadline {
                    return Err(
                        "Event export delivery deadline exceeded; protected capture is retained"
                            .into(),
                    );
                }
                let length = source.read(&mut buffer).map_err(|e| e.to_string())?;
                if length == 0 {
                    break;
                }
                file.write_all(&buffer[..length])
                    .map_err(|e| e.to_string())?;
                digest.update(&buffer[..length]);
                copied = copied
                    .checked_add(length as u64)
                    .ok_or("Export size overflow")?;
                if copied > source_size {
                    return Err("Protected event export changed during delivery".into());
                }
                progress(copied)?;
            }
            if copied != source_size {
                return Err("Protected event export was truncated during delivery".into());
            }
            let actual: String = digest
                .finalize()
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect();
            if actual != expected_digest {
                return Err("Protected event capture integrity changed; delivery refused and source evidence retained".into());
            }
            file.sync_all().map_err(|e| e.to_string())?;
            verify(&file, &self.path, false)?;
            self.parent.recheck()?;
            progress(copied)?;
            Ok(())
        })();
        if result.is_err() {
            discard(&file);
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_destination_is_create_only_and_failed_integrity_cleans_only_its_new_file() {
        use sha2::Digest;
        let root = scratch();
        let source = root.join("capture.evtx");
        let output = root.join("copy.evtx");
        fs::write(&source, vec![42u8; 65536]).unwrap();
        let digest: String = sha2::Sha256::digest(fs::read(&source).unwrap())
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        let selected = ExportDestination::selected(output.clone()).unwrap();
        assert!(
            !output.exists(),
            "selection must not create or truncate the destination"
        );
        selected
            .deliver(
                File::open(&source).unwrap(),
                &digest,
                std::time::Instant::now() + std::time::Duration::from_secs(5),
                |_| Ok(()),
            )
            .unwrap();
        assert_eq!(fs::read(&output).unwrap(), fs::read(&source).unwrap());
        assert!(selected
            .deliver(
                File::open(&source).unwrap(),
                &digest,
                std::time::Instant::now() + std::time::Duration::from_secs(5),
                |_| Ok(())
            )
            .is_err());
        assert!(ExportDestination::selected(output.clone()).is_err());
        let bad_output = root.join("bad.evtx");
        let bad = ExportDestination::selected(bad_output.clone()).unwrap();
        assert!(bad
            .deliver(
                File::open(&source).unwrap(),
                &"0".repeat(64),
                std::time::Instant::now() + std::time::Duration::from_secs(5),
                |_| Ok(())
            )
            .is_err());
        assert!(!bad_output.exists());
        assert!(source.exists());
        drop(selected);
        drop(bad);
        fs::remove_dir_all(root).unwrap();
    }
    fn scratch() -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "purgeon-atomic-{}",
            crate::broker::random_id().unwrap()
        ));
        fs::create_dir(&path).unwrap();
        path
    }
    #[test]
    fn owned_stream_stages_preserve_old_files_and_clean_every_failed_phase() {
        let root = scratch();
        let target = root.join("backup-secret.bin");
        let unrelated = root.join("backup-secret.bin.part");
        fs::write(&target, b"old protected bytes").unwrap();
        fs::write(&unrelated, b"not our stage").unwrap();
        write(target.to_str().unwrap(), b"old protected bytes").unwrap();
        for failure in ["create", "flush", "commit"] {
            FAIL_STAGE.with(|stage| stage.set(Some(failure)));
            assert_eq!(
                write(target.to_str().unwrap(), b"new protected bytes").unwrap_err(),
                format!("injected {failure} failure")
            );
            assert_eq!(fs::read(&target).unwrap(), b"old protected bytes");
            assert_eq!(fs::read_dir(&root).unwrap().count(), 2);
        }
        let error = write_stream(target.to_str().unwrap(), |file| {
            file.write_all(b"partial").map_err(|e| e.to_string())?;
            Err::<(), _>("first writer error".to_string())
        });
        assert_eq!(error.unwrap_err(), "first writer error");
        assert_eq!(fs::read(&target).unwrap(), b"old protected bytes");
        assert_eq!(fs::read_dir(&root).unwrap().count(), 2);
        let panicked = std::panic::catch_unwind(|| {
            let _ = write_stream(target.to_str().unwrap(), |file| -> Result<(), String> {
                file.write_all(b"partial before unwind").unwrap();
                panic!("injected writer panic");
            });
        });
        assert!(panicked.is_err());
        assert_eq!(fs::read(&target).unwrap(), b"old protected bytes");
        assert_eq!(fs::read_dir(&root).unwrap().count(), 2);
        let alias = root.join("concurrent-alias");
        assert!(write_stream(target.to_str().unwrap(), |file| {
            file.write_all(b"complete").map_err(|e| e.to_string())?;
            fs::hard_link(&target, &alias).unwrap();
            Ok(())
        })
        .is_err());
        assert_eq!(fs::read(&target).unwrap(), b"old protected bytes");
        assert_eq!(fs::read(&alias).unwrap(), b"old protected bytes");
        assert_eq!(fs::read_dir(&root).unwrap().count(), 3);
        fs::remove_file(alias).unwrap();
        let check = File::open(&target).unwrap();
        let mut info: Information = unsafe { std::mem::zeroed() };
        assert_ne!(
            unsafe { GetFileInformationByHandle(check.as_raw_handle(), &mut info) },
            0
        );
        eprintln!(
            "alias recovery canonical={:?}, links={}",
            fs::canonicalize(&target),
            info.links
        );
        drop(check);
        write(target.to_str().unwrap(), b"complete").unwrap();
        let successful = root.join("new-secret.bin");
        write(successful.to_str().unwrap(), b"complete").unwrap();
        assert_eq!(fs::read(&successful).unwrap(), b"complete");
        assert_eq!(fs::read(&target).unwrap(), b"complete");
        assert_eq!(fs::read(&unrelated).unwrap(), b"not our stage");
        assert_eq!(fs::read_dir(&root).unwrap().count(), 3);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn rename_buffers_terminate_all_utf16_alignment_residues_and_verify_exact_targets() {
        assert_eq!(std::mem::offset_of!(RenameInformation, replace), 0);
        assert_eq!(std::mem::offset_of!(RenameInformation, root), 8);
        assert_eq!(std::mem::offset_of!(RenameInformation, length), 16);
        assert_eq!(std::mem::offset_of!(RenameInformation, name), 20);
        let root = scratch();
        let mut residues = std::collections::HashSet::new();
        for length in 0..8 {
            let target = root.join(format!("é😀{}-secret.bin", "x".repeat(length)));
            residues.insert(target.as_os_str().encode_wide().count() % 4);
            write(target.to_str().unwrap(), b"first").unwrap();
            assert_eq!(fs::read(&target).unwrap(), b"first");
            write(target.to_str().unwrap(), b"second").unwrap();
            assert_eq!(fs::read(&target).unwrap(), b"second");
            assert_eq!(fs::read_dir(&root).unwrap().count(), length + 1);
        }
        assert_eq!(residues.len(), 4);
        let target = root.join("committed-but-unverified.bin");
        fs::write(&target, b"old").unwrap();
        FAIL_STAGE.with(|stage| stage.set(Some("postverify")));
        let error = write(target.to_str().unwrap(), b"committed").unwrap_err();
        assert!(error.contains("rename completed but destination verification failed"));
        assert_eq!(fs::read(&target).unwrap(), b"committed");
        assert_eq!(fs::read_dir(&root).unwrap().count(), 9);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn complete_concurrent_writes_and_no_temp_collision() {
        let root = scratch();
        let target = root.join("settings.json");
        let legacy = root.join(format!("settings.json.tmp-{}", std::process::id()));
        fs::write(&legacy, b"do not touch").unwrap();
        let handles: Vec<_> = (0..8)
            .map(|n| {
                let target = target.clone();
                std::thread::spawn(move || {
                    let value = vec![b'A' + n; 64 * 1024];
                    write(target.to_str().unwrap(), &value).map(|()| value)
                })
            })
            .collect();
        let successful: Vec<_> = handles
            .into_iter()
            .filter_map(|h| h.join().unwrap().ok())
            .collect();
        assert!(!successful.is_empty());
        let actual = fs::read(&target).unwrap();
        assert!(successful.iter().any(|value| value == &actual));
        assert_eq!(fs::read(legacy).unwrap(), b"do not touch");
        assert_eq!(fs::read_dir(&root).unwrap().count(), 2);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn failed_commit_keeps_old_destination_and_stage() {
        let root = scratch();
        let target = root.join("backup.swpkg");
        let stage = root.join("stage.tmp");
        fs::write(&target, b"old").unwrap();
        fs::write(&stage, b"new").unwrap();
        let lock = OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&target)
            .unwrap();
        assert!(commit_staged(stage.to_str().unwrap(), target.to_str().unwrap()).is_err());
        drop(lock);
        assert_eq!(fs::read(&target).unwrap(), b"old");
        assert_eq!(fs::read(&stage).unwrap(), b"new");
        commit_staged(stage.to_str().unwrap(), target.to_str().unwrap()).unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"new");
        assert!(!stage.exists());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn refuses_hardlinked_target_without_changing_either_name() {
        let root = scratch();
        let original = root.join("original.json");
        let target = root.join("alias.json");
        fs::write(&original, b"old").unwrap();
        fs::hard_link(&original, &target).unwrap();
        assert!(write(target.to_str().unwrap(), b"new").is_err());
        assert_eq!(fs::read(&original).unwrap(), b"old");
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn refuses_reparse_parent_and_keeps_real_target() {
        use base64::Engine;
        use std::os::windows::process::CommandExt;
        let root = scratch();
        let real = root.join("real");
        let link = root.join("junction");
        fs::create_dir(&real).unwrap();
        fs::write(real.join("state.json"), b"old").unwrap();
        let quote = |p: &Path| p.to_string_lossy().replace('\'', "''");
        let script = format!("$ErrorActionPreference='Stop';New-Item -ItemType Junction -Path '{}' -Target '{}' | Out-Null", quote(&link), quote(&real));
        let encoded: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
        let output = std::process::Command::new(
            crate::windows_tools::system_file("powershell.exe").unwrap(),
        )
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            &base64::engine::general_purpose::STANDARD.encode(encoded),
        ])
        .creation_flags(0x0800_0000)
        .output()
        .unwrap();
        assert!(
            output.status.success(),
            "Scratch junction creation must succeed to exercise reparse refusal: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(write(link.join("state.json").to_str().unwrap(), b"new").is_err());
        assert_eq!(fs::read(real.join("state.json")).unwrap(), b"old");
        fs::remove_dir(&link).unwrap();
        fs::remove_dir_all(root).unwrap();
    }
}
