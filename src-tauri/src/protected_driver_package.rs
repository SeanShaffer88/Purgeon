//! Driver-package capture is not EVTX storage. Complete native-derived file sets
//! are bounded, pinned, hashed and compared; no renderer path is accepted here.
use crate::state_store::{self, DriverPackageRoot};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs::File,
    io::{Read, Seek, SeekFrom},
    os::windows::{ffi::OsStrExt, io::AsRawHandle},
    path::{Path, PathBuf},
    time::Instant,
};
pub const MAX_FILES: usize = 4096;
const MAX_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_DEPTH: usize = 32;
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Member {
    pub name: String,
    pub bytes: u64,
    pub digest: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub files: Vec<Member>,
    pub directories: Vec<String>,
    pub inf: String,
    pub catalog: String,
}
fn component(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 255
        && name.is_ascii()
        && !name.ends_with(['.', ' '])
        && !name
            .chars()
            .any(|c| c.is_control() || "<>:\"/\\|?*".contains(c))
        && !matches!(
            name.to_ascii_uppercase().split('.').next().unwrap_or(""),
            "CON"
                | "PRN"
                | "AUX"
                | "NUL"
                | "COM1"
                | "COM2"
                | "COM3"
                | "COM4"
                | "COM5"
                | "COM6"
                | "COM7"
                | "COM8"
                | "COM9"
                | "LPT1"
                | "LPT2"
                | "LPT3"
                | "LPT4"
                | "LPT5"
                | "LPT6"
                | "LPT7"
                | "LPT8"
                | "LPT9"
        )
}
pub fn relative(name: &str) -> Result<PathBuf, String> {
    if name.is_empty()
        || name.split('/').count() > MAX_DEPTH
        || name
            .split('/')
            .any(|p| !component(p) || p == "." || p == "..")
    {
        return Err("Unsupported driver package path".into());
    }
    Ok(name.split('/').collect())
}
impl Manifest {
    pub fn validate(&self) -> Result<(), String> {
        if self.files.is_empty()
            || self.files.len() > MAX_FILES
            || self.directories.len() > MAX_FILES
        {
            return Err("Driver package count exceeds bounds".into());
        }
        relative(&self.inf)?;
        relative(&self.catalog)?;
        if !self.inf.to_ascii_lowercase().ends_with(".inf")
            || !self.catalog.to_ascii_lowercase().ends_with(".cat")
        {
            return Err("Driver package lacks native INF/catalog identity".into());
        }
        let mut names = HashSet::new();
        let mut total = 0u64;
        for member in &self.files {
            relative(&member.name)?;
            if member.digest.len() != 64
                || !member.digest.bytes().all(|c| c.is_ascii_hexdigit())
                || !names.insert(member.name.to_ascii_lowercase())
            {
                return Err("Invalid or colliding driver file manifest".into());
            }
            total = total
                .checked_add(member.bytes)
                .ok_or("Driver package size overflow")?;
        }
        for name in &self.directories {
            relative(name)?;
            if !names.insert(name.to_ascii_lowercase()) {
                return Err("Driver package path collision".into());
            }
        }
        if total > MAX_BYTES
            || !self.files.iter().any(|f| f.name == self.inf && f.bytes > 0)
            || !self
                .files
                .iter()
                .any(|f| f.name == self.catalog && f.bytes > 0)
        {
            return Err("Driver package is incomplete or exceeds size bounds".into());
        }
        Ok(())
    }
    pub fn fingerprint(&self) -> Result<String, String> {
        self.validate()?;
        Ok(hex(&Sha256::digest(
            serde_json::to_vec(self).map_err(|e| e.to_string())?,
        )))
    }
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
pub struct Pinned {
    pub manifest: Manifest,
    pub root: PathBuf,
    files: Vec<(String, File)>,
    _directories: Vec<File>,
}
impl Pinned {
    pub fn trusted_catalog(&mut self) -> Result<(), String> {
        let (_, file) = self
            .files
            .iter_mut()
            .find(|(name, _)| *name == self.manifest.catalog)
            .ok_or("Native catalog missing from held package")?;
        trust_catalog(&self.root.join(relative(&self.manifest.catalog)?), file)
    }
    pub fn verify(&mut self, deadline: Instant) -> Result<(), String> {
        self.verify_content(deadline)?;
        self.trusted_catalog()
    }
    fn verify_content(&mut self, deadline: Instant) -> Result<(), String> {
        for (name, file) in &mut self.files {
            let expected = self
                .manifest
                .files
                .iter()
                .find(|f| f.name == *name)
                .ok_or("Held member lost manifest")?;
            if hash_file_named(file, name, deadline)? != *expected {
                return Err("Held driver package content changed".into());
            }
        }
        Ok(())
    }
    pub fn inf_path(&self) -> Result<PathBuf, String> {
        Ok(self.root.join(relative(&self.manifest.inf)?))
    }
}
fn hash_file_named(file: &mut File, name: &str, deadline: Instant) -> Result<Member, String> {
    file.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
    let size = file.metadata().map_err(|e| e.to_string())?.len();
    if size > MAX_BYTES {
        return Err("Driver file exceeds size bound".into());
    }
    let mut digest = Sha256::new();
    let mut bytes = 0u64;
    let mut buffer = [0u8; 65536];
    loop {
        if Instant::now() >= deadline {
            return Err("Driver package verification deadline expired".into());
        }
        let length = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if length == 0 {
            break;
        }
        bytes += length as u64;
        if bytes > size {
            return Err("Driver package file grew during verification".into());
        }
        digest.update(&buffer[..length]);
    }
    if bytes != size || file.metadata().map_err(|e| e.to_string())?.len() != size {
        return Err("Driver package file changed while hashing".into());
    }
    Ok(Member {
        name: name.into(),
        bytes,
        digest: hex(&digest.finalize()),
    })
}
enum Root<'a> {
    Source,
    Backup(&'a DriverPackageRoot, bool),
}
fn scan(
    root: &Path,
    inf: &str,
    catalog: &str,
    kind: Root<'_>,
    deadline: Instant,
) -> Result<Pinned, String> {
    reject_streams(root, true)?;
    let mut files = Vec::new();
    let mut directories = Vec::new();
    let mut names = Vec::new();
    let mut members = Vec::new();
    let mut total = 0u64;
    let mut queue = vec![PathBuf::new()];
    let mut seen = HashSet::new();
    match &kind {
        Root::Source => {
            for ancestor in root.ancestors().collect::<Vec<_>>().into_iter().rev() {
                directories.push(state_store::pin_driver_ancestor(ancestor)?);
            }
            directories.push(state_store::pin_driver_source(root, true)?);
        }
        Root::Backup(slot, _) => slot.recheck()?,
    }
    while let Some(relative_dir) = queue.pop() {
        if Instant::now() >= deadline {
            return Err("Driver package scan deadline expired".into());
        }
        let directory = root.join(&relative_dir);
        let mut rows = std::fs::read_dir(&directory)
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        rows.sort_by_key(|e| e.file_name());
        for row in rows {
            if files.len() + names.len() >= MAX_FILES {
                return Err("Driver package entry count exceeds limit".into());
            }
            let name = row
                .file_name()
                .into_string()
                .map_err(|_| "Unsupported driver filename")?;
            if !component(&name) {
                return Err("Unsupported driver filename or alternate stream".into());
            }
            let rel = relative_dir.join(&name);
            let text = rel
                .to_str()
                .ok_or("Unsupported driver filename")?
                .replace('\\', "/");
            relative(&text)?;
            if !seen.insert(text.to_ascii_lowercase()) {
                return Err("Driver package case collision".into());
            }
            let meta = std::fs::symlink_metadata(row.path()).map_err(|e| e.to_string())?;
            let dir = meta.is_dir();
            let mut file = match &kind {
                Root::Source => state_store::pin_driver_source(&row.path(), dir)?,
                Root::Backup(slot, seal) => slot.child(&rel, dir, *seal)?,
            };
            reject_streams(&row.path(), dir)?;
            if dir {
                names.push(text);
                directories.push(file);
                queue.push(rel);
            } else {
                let member = hash_file_named(&mut file, &text, deadline)?;
                total = total
                    .checked_add(member.bytes)
                    .ok_or("Driver package size overflow")?;
                if total > MAX_BYTES {
                    return Err("Driver package exceeds total size bound".into());
                }
                members.push(member);
                files.push((text, file));
            }
        }
    }
    members.sort_by(|a, b| a.name.cmp(&b.name));
    names.sort();
    let manifest = Manifest {
        files: members,
        directories: names,
        inf: inf.into(),
        catalog: catalog.into(),
    };
    manifest.validate()?;
    Ok(Pinned {
        manifest,
        root: root.into(),
        files,
        _directories: directories,
    })
}
pub fn source(root: &Path, inf: &str, catalog: &str, deadline: Instant) -> Result<Pinned, String> {
    scan(root, inf, catalog, Root::Source, deadline)
}
pub struct Backup {
    pub slot: DriverPackageRoot,
}
impl Backup {
    pub fn reserve(id: &str) -> Result<Self, String> {
        Ok(Self {
            slot: DriverPackageRoot::open("S-1-5-32-545", id, true)?,
        })
    }
    pub fn open(id: &str) -> Result<Self, String> {
        Ok(Self {
            slot: DriverPackageRoot::open("S-1-5-32-545", id, false)?,
        })
    }
    pub fn path(&self) -> &Path {
        self.slot.path()
    }
    pub fn verify(
        &self,
        expected: &Manifest,
        seal: bool,
        deadline: Instant,
    ) -> Result<Pinned, String> {
        expected.validate()?;
        // PnPUtil may emit one package wrapper directory. Match exact set/hash
        // first at root, or one unambiguous wrapper; never arbitrary traversal.
        let root = scan(
            self.path(),
            &expected.inf,
            &expected.catalog,
            Root::Backup(&self.slot, seal),
            deadline,
        );
        if let Ok(mut pinned) = root {
            if pinned.manifest == *expected {
                pinned.trusted_catalog()?;
                return Ok(pinned);
            }
        }
        let rows = std::fs::read_dir(self.path())
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        if rows.len() != 1 || !rows[0].file_type().map_err(|e| e.to_string())?.is_dir() {
            return Err(
                "Exported driver package does not match the complete source manifest".into(),
            );
        }
        let wrapper = rows[0]
            .file_name()
            .into_string()
            .map_err(|_| "Unsupported driver export wrapper")?;
        if !component(&wrapper) {
            return Err("Invalid driver export wrapper".into());
        }
        let _pin = self.slot.child(Path::new(&wrapper), true, seal)?;
        // Paths remain relative to the protected root for ACL checks.
        let mut wrapped = expected.clone();
        for member in &mut wrapped.files {
            member.name = format!("{wrapper}/{}", member.name);
        }
        for name in &mut wrapped.directories {
            *name = format!("{wrapper}/{name}");
        }
        wrapped.directories.push(wrapper.clone());
        wrapped.directories.sort();
        wrapped.inf = format!("{wrapper}/{}", expected.inf);
        wrapped.catalog = format!("{wrapper}/{}", expected.catalog);
        let mut pinned = scan(
            self.path(),
            &wrapped.inf,
            &wrapped.catalog,
            Root::Backup(&self.slot, seal),
            deadline,
        )?;
        if pinned.manifest != wrapped {
            return Err("Driver export is incomplete, changed or has extra files".into());
        }
        pinned.trusted_catalog()?;
        Ok(pinned)
    }
}

fn reject_streams(path: &Path, directory: bool) -> Result<(), String> {
    #[repr(C)]
    struct Data {
        bytes: i64,
        name: [u16; 296],
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn FindFirstStreamW(
            path: *const u16,
            level: u32,
            data: *mut Data,
            flags: u32,
        ) -> *mut std::ffi::c_void;
        fn FindNextStreamW(handle: *mut std::ffi::c_void, data: *mut Data) -> i32;
        fn FindClose(handle: *mut std::ffi::c_void) -> i32;
    }
    let name: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut data: Data = unsafe { std::mem::zeroed() };
    let handle = unsafe { FindFirstStreamW(name.as_ptr(), 0, &mut data, 0) };
    if handle == -1isize as *mut std::ffi::c_void {
        if directory && std::io::Error::last_os_error().raw_os_error() == Some(38) {
            return Ok(());
        }
        return Err(format!(
            "Could not verify driver file streams: {}",
            std::io::Error::last_os_error()
        ));
    }
    struct Search(*mut std::ffi::c_void);
    impl Drop for Search {
        fn drop(&mut self) {
            unsafe {
                FindClose(self.0);
            }
        }
    }
    let _search = Search(handle);
    loop {
        let len = data
            .name
            .iter()
            .position(|c| *c == 0)
            .ok_or("Invalid file stream name")?;
        if String::from_utf16(&data.name[..len]).map_err(|e| e.to_string())? != "::$DATA" {
            return Err("Driver package contains an alternate data stream".into());
        }
        if unsafe { FindNextStreamW(handle, &mut data) } == 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() != Some(38) {
                return Err(error.to_string());
            }
            break;
        }
    }
    Ok(())
}
fn trust_catalog(path: &Path, file: &File) -> Result<(), String> {
    use std::ffi::c_void;
    #[repr(C)]
    struct Guid(u32, u16, u16, [u8; 8]);
    #[repr(C)]
    struct Info {
        size: u32,
        path: *const u16,
        file: *mut c_void,
        subject: *const Guid,
    }
    #[repr(C)]
    struct Data {
        size: u32,
        policy: *mut c_void,
        sip: *mut c_void,
        ui: u32,
        revocation: u32,
        choice: u32,
        info: *mut Info,
        state_action: u32,
        state: *mut c_void,
        url: *const u16,
        flags: u32,
        context: u32,
        signature: *mut c_void,
    }
    #[link(name = "wintrust")]
    extern "system" {
        fn WinVerifyTrust(hwnd: *mut c_void, action: *const Guid, data: *mut Data) -> i32;
    }
    let text: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut info = Info {
        size: std::mem::size_of::<Info>() as u32,
        path: text.as_ptr(),
        file: file.as_raw_handle(),
        subject: std::ptr::null(),
    };
    let mut data = Data {
        size: std::mem::size_of::<Data>() as u32,
        policy: std::ptr::null_mut(),
        sip: std::ptr::null_mut(),
        ui: 2,
        revocation: 0,
        choice: 1,
        info: &mut info,
        state_action: 1,
        state: std::ptr::null_mut(),
        url: std::ptr::null(),
        flags: 0x1000,
        context: 0,
        signature: std::ptr::null_mut(),
    };
    let action = Guid(
        0x00aac56b,
        0xcd44,
        0x11d0,
        [0x8c, 0xc2, 0x00, 0xc0, 0x4f, 0xc2, 0x95, 0xee],
    );
    let status = unsafe { WinVerifyTrust(-1isize as *mut c_void, &action, &mut data) };
    data.state_action = 2;
    let closed = unsafe { WinVerifyTrust(-1isize as *mut c_void, &action, &mut data) };
    if status != 0 || closed != 0 {
        return Err(format!(
            "Driver catalog trust failed (offline): {status}, cleanup {closed}"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Scratch(PathBuf);
    impl Scratch {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!(
                "purgeon-driver-fixture-{}",
                crate::broker::random_id().unwrap()
            ));
            std::fs::create_dir(&p).unwrap();
            Self(p)
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn manifest() -> Manifest {
        Manifest {
            files: vec![
                Member {
                    name: "fixture.cat".into(),
                    bytes: 1,
                    digest: "1".repeat(64),
                },
                Member {
                    name: "fixture.inf".into(),
                    bytes: 1,
                    digest: "2".repeat(64),
                },
            ],
            directories: vec![],
            inf: "fixture.inf".into(),
            catalog: "fixture.cat".into(),
        }
    }
    #[test]
    fn complete_manifest_rejects_missing_catalog_extra_collision_and_unsafe_names() {
        let valid = manifest();
        valid.validate().unwrap();
        for name in [
            "../escape",
            "a/../b",
            "C:/caller",
            "file:stream",
            "CON.inf",
            "nested//file",
            "trailing.",
            "a\\b",
            "x/aux",
            "a/ ",
        ] {
            assert!(relative(name).is_err(), "{name}");
        }
        assert!(relative("nested/driver.sys").is_ok());
        assert!(relative(&vec!["a"; 33].join("/")).is_err());
        let mut missing = valid.clone();
        missing.files.remove(0);
        assert!(missing.validate().is_err());
        let mut collision = valid.clone();
        collision.files.push(Member {
            name: "FIXTURE.INF".into(),
            bytes: 1,
            digest: "0".repeat(64),
        });
        assert!(collision.validate().is_err());
        let mut large = valid;
        large.files[0].bytes = MAX_BYTES;
        assert!(large.validate().is_err());
    }
    #[test]
    fn held_named_members_verify_unchanged_and_detect_content_change_without_catalog_or_driver_calls(
    ) {
        let scratch = Scratch::new();
        let mut files = Vec::new();
        let mut members = Vec::new();
        for (name, bytes) in [
            ("fixture.inf", b"fixture inf".as_slice()),
            ("fixture.cat", b"fixture catalog".as_slice()),
        ] {
            let path = scratch.0.join(name);
            std::fs::write(&path, bytes).unwrap();
            let mut file = File::open(&path).unwrap();
            members.push(
                hash_file_named(&mut file, name, Instant::now() + Duration::from_secs(5)).unwrap(),
            );
            files.push((name.into(), file));
        }
        let manifest = Manifest {
            files: members,
            directories: vec![],
            inf: "fixture.inf".into(),
            catalog: "fixture.cat".into(),
        };
        let mut pinned = Pinned {
            manifest,
            root: scratch.0.clone(),
            files,
            _directories: vec![],
        };
        pinned
            .verify_content(Instant::now() + Duration::from_secs(5))
            .unwrap();
        std::fs::write(scratch.0.join("fixture.inf"), b"changed inf").unwrap();
        assert!(pinned
            .verify_content(Instant::now() + Duration::from_secs(5))
            .is_err());
    }
    #[test]
    fn scratch_hardlinks_and_directory_and_file_alternate_streams_are_refused() {
        let scratch = Scratch::new();
        let file = scratch.0.join("fixture.inf");
        std::fs::write(&file, b"fixture").unwrap();
        let alias = scratch.0.join("alias.inf");
        std::fs::hard_link(&file, &alias).unwrap();
        let error = state_store::pin_driver_source(&file, false).unwrap_err();
        assert!(error.contains("alias"));
        assert!(reject_streams(&scratch.0, true).is_ok());
        assert!(reject_streams(&file, false).is_ok());
        std::fs::write(format!("{}:unexpected", file.display()), b"hidden").unwrap();
        assert!(reject_streams(&file, false).is_err());
        std::fs::write(format!("{}:unexpected", scratch.0.display()), b"hidden").unwrap();
        assert!(reject_streams(&scratch.0, true).is_err());
    }
    use std::time::Duration;
}
