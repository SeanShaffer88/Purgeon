//! Native-only baseline storage. Machine baselines are ACL-protected plaintext;
//! user baselines are protected with current-user DPAPI. No renderer paths enter here.
use std::ffi::c_void;
use std::fs::File;
use std::io::{Read, Write};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle};
use std::path::{Path, PathBuf};
use std::ptr::null_mut;
use std::sync::atomic::{AtomicU64, Ordering};

type Handle = *mut c_void;
const MAX_PLAIN: usize = 32768;
const MAX_STORED: usize = 65536;
const READ_CONTROL: u32 = 0x20000;
const OPEN_REPARSE: u32 = 0x00200000;
const BACKUP_SEMANTICS: u32 = 0x02000000;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Authority {
    User,
    Machine,
}
#[derive(Clone, Copy)]
pub enum Domain {
    Debloat,
    Restore,
    EventLogs,
    Boot,
    Drivers,
    Tasks,
}
impl Domain {
    fn directory(self) -> &'static str {
        match self {
            Self::Debloat => "debloat",
            Self::Restore => "restore",
            Self::EventLogs => "EventLogs",
            Self::Boot => "Boot",
            Self::Drivers => "Drivers",
            Self::Tasks => "Tasks",
        }
    }
}

#[repr(C)]
struct Guid(u32, u16, u16, [u8; 8]);
#[repr(C)]
struct SecurityAttributes {
    length: u32,
    descriptor: Handle,
    inherit: i32,
}
#[repr(C)]
struct FileInformation {
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
#[link(name = "kernel32")]
extern "system" {
    fn CreateFileW(
        path: *const u16,
        access: u32,
        share: u32,
        sa: Handle,
        disposition: u32,
        flags: u32,
        template: Handle,
    ) -> Handle;
    fn CreateDirectoryW(path: *const u16, sa: *const SecurityAttributes) -> i32;
    fn GetFileInformationByHandle(file: Handle, information: *mut FileInformation) -> i32;
    fn GetFinalPathNameByHandleW(file: Handle, path: *mut u16, length: u32, flags: u32) -> u32;
    fn MoveFileExW(source: *const u16, destination: *const u16, flags: u32) -> i32;
    fn GetCurrentProcess() -> Handle;
    fn GetCurrentProcessId() -> u32;
    fn CloseHandle(handle: Handle) -> i32;
    fn LocalFree(memory: Handle) -> Handle;
}
#[link(name = "advapi32")]
extern "system" {
    fn OpenProcessToken(process: Handle, access: u32, token: *mut Handle) -> i32;
    fn GetTokenInformation(
        token: Handle,
        class: u32,
        data: Handle,
        size: u32,
        needed: *mut u32,
    ) -> i32;
    fn ConvertSidToStringSidW(sid: Handle, text: *mut *mut u16) -> i32;
    fn ConvertStringSecurityDescriptorToSecurityDescriptorW(
        text: *const u16,
        revision: u32,
        descriptor: *mut Handle,
        size: *mut u32,
    ) -> i32;
    fn GetSecurityInfo(
        object: Handle,
        kind: u32,
        information: u32,
        owner: *mut Handle,
        group: *mut Handle,
        dacl: *mut Handle,
        sacl: *mut Handle,
        descriptor: *mut Handle,
    ) -> u32;
    fn GetSecurityDescriptorOwner(
        descriptor: Handle,
        owner: *mut Handle,
        defaulted: *mut i32,
    ) -> i32;
    fn GetSecurityDescriptorDacl(
        descriptor: Handle,
        present: *mut i32,
        acl: *mut Handle,
        defaulted: *mut i32,
    ) -> i32;
    fn GetSecurityDescriptorControl(
        descriptor: Handle,
        control: *mut u16,
        revision: *mut u32,
    ) -> i32;
    fn EqualSid(first: Handle, second: Handle) -> i32;
    fn ConvertStringSidToSidW(text: *const u16, sid: *mut Handle) -> i32;
    fn GetAce(acl: Handle, index: u32, ace: *mut Handle) -> i32;
    fn SetSecurityInfo(
        object: Handle,
        kind: u32,
        information: u32,
        owner: Handle,
        group: Handle,
        dacl: Handle,
        sacl: Handle,
    ) -> u32;
}
#[link(name = "shell32")]
extern "system" {
    fn SHGetKnownFolderPath(
        folder: *const Guid,
        flags: u32,
        token: Handle,
        path: *mut *mut u16,
    ) -> i32;
}
#[link(name = "ole32")]
extern "system" {
    fn CoTaskMemFree(memory: Handle);
}

struct LocalMemory(Handle);
impl Drop for LocalMemory {
    fn drop(&mut self) {
        unsafe {
            LocalFree(self.0);
        }
    }
}
struct Token(Handle);
impl Drop for Token {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}
fn os_error() -> String {
    std::io::Error::last_os_error().to_string()
}
// Extended paths bypass Win32 normalization. Accept only literal normal local
// drive paths before adding the prefix; stored paths remain in normal form.
// https://learn.microsoft.com/en-us/windows/win32/fileio/maximum-file-path-limitation
fn wide(path: &Path) -> Result<Vec<u16>, String> {
    let units: Vec<u16> = path.as_os_str().encode_wide().collect();
    let invalid = || "Invalid normal local Win32 path".to_string();
    if units.len() < 3
        || !matches!(units[0], 65..=90 | 97..=122)
        || units[1] != b':' as u16
        || units[2] != b'\\' as u16
        || units.iter().any(|&u| u == 0 || u == b'/' as u16)
        || units[2..].contains(&(b':' as u16))
    {
        return Err(invalid());
    }
    if units.len() > 3 {
        for component in units[3..].split(|&u| u == b'\\' as u16) {
            if component.is_empty()
                || component.len() > 255
                || component == [b'.' as u16]
                || component == [b'.' as u16, b'.' as u16]
                || matches!(component.last(), Some(32 | 46))
                || component
                    .iter()
                    .any(|&u| u < 32 || matches!(u, 34 | 42 | 60 | 62 | 63 | 124))
            {
                return Err(invalid());
            }
        }
    }
    let length = units.len().checked_add(5).ok_or_else(invalid)?;
    if length > 32767 {
        return Err("Extended Win32 path exceeds UTF-16 limit".into());
    }
    let mut encoded = Vec::with_capacity(length);
    encoded.extend(r"\\?\".encode_utf16());
    encoded.extend(units);
    encoded.push(0);
    Ok(encoded)
}
fn text_wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(Some(0)).collect()
}
fn checked(ok: i32) -> Result<(), String> {
    if ok == 0 {
        Err(os_error())
    } else {
        Ok(())
    }
}

fn token() -> Result<Token, String> {
    let mut handle = null_mut();
    checked(unsafe { OpenProcessToken(GetCurrentProcess(), 8, &mut handle) })?;
    Ok(Token(handle))
}
fn current_sid(token: &Token) -> Result<String, String> {
    let mut needed = 0;
    unsafe {
        GetTokenInformation(token.0, 1, null_mut(), 0, &mut needed);
    }
    if needed == 0 || needed > 65536 {
        return Err("Invalid token identity size".into());
    }
    // Token structures contain pointers and must be pointer-aligned.
    let mut buffer = vec![0usize; (needed as usize).div_ceil(std::mem::size_of::<usize>())];
    checked(unsafe {
        GetTokenInformation(token.0, 1, buffer.as_mut_ptr().cast(), needed, &mut needed)
    })?;
    let sid = unsafe { *(buffer.as_ptr() as *const Handle) };
    let mut text = null_mut();
    checked(unsafe { ConvertSidToStringSidW(sid, &mut text) })?;
    let _allocation = LocalMemory(text.cast());
    let mut length = 0;
    while length < 184 && unsafe { *text.add(length) } != 0 {
        length += 1;
    }
    if length == 184 {
        return Err("Invalid token SID".into());
    }
    String::from_utf16(unsafe { std::slice::from_raw_parts(text, length) })
        .map_err(|e| e.to_string())
}
fn validate_identity(
    authority: Authority,
    sid: &str,
    hash: &str,
    id: &str,
    writing: bool,
) -> Result<(), String> {
    let sid_parts: Vec<&str> = sid.split('-').collect();
    let alias = id.to_ascii_lowercase();
    let reserved = ["con", "prn", "aux", "nul", "conin$", "conout$"].contains(&alias.as_str())
        || (alias.len() == 4
            && (alias.starts_with("com") || alias.starts_with("lpt"))
            && alias.as_bytes()[3].is_ascii_digit());
    if sid.len() > 184
        || sid_parts.len() < 4
        || sid_parts.len() > 18
        || sid_parts[0] != "S"
        || sid_parts[1] != "1"
        || sid_parts[2..].iter().any(|part| {
            part.is_empty()
                || !part.bytes().all(|b| b.is_ascii_digit())
                || (part.len() > 1 && part.starts_with('0'))
        })
        || sid_parts[2]
            .parse::<u64>()
            .map_or(true, |n| n > 0xffffffffffff)
        || sid_parts[3..].iter().any(|p| p.parse::<u32>().is_err())
        || hash.len() != 64
        || !hash.bytes().all(|b| b.is_ascii_hexdigit())
        || id.is_empty()
        || id.len() > 96
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        || reserved
    {
        return Err("Invalid baseline identity".into());
    }
    let token = token()?;
    if matches!(authority, Authority::User) && current_sid(&token)? != sid {
        return Err("User baseline identity does not match the current token".into());
    }
    if writing && matches!(authority, Authority::Machine) {
        let mut value = 0u32;
        let mut needed = 0;
        checked(unsafe {
            GetTokenInformation(token.0, 20, (&mut value as *mut u32).cast(), 4, &mut needed)
        })?;
        if value == 0 {
            return Err("Machine baseline writes require an elevated executor".into());
        }
    }
    Ok(())
}

fn known_folder(authority: Authority) -> Result<PathBuf, String> {
    let folder = match authority {
        Authority::User => Guid(
            0xf1b32785,
            0x6fba,
            0x4fcf,
            [0x9d, 0x55, 0x7b, 0x8e, 0x7f, 0x15, 0x70, 0x91],
        ),
        Authority::Machine => Guid(
            0x62ab5d82,
            0xfdc1,
            0x4dc3,
            [0xa9, 0xdd, 0x07, 0x0d, 0x1d, 0x49, 0x5d, 0x97],
        ),
    };
    let mut text = null_mut();
    let status = unsafe { SHGetKnownFolderPath(&folder, 0, null_mut(), &mut text) };
    if status < 0 {
        return Err(format!("KnownFolder failed: 0x{:08x}", status as u32));
    }
    if text.is_null() {
        return Err("KnownFolder returned no path".into());
    }
    let mut length = 0;
    while length < 32768 && unsafe { *text.add(length) } != 0 {
        length += 1;
    }
    let result = if length == 32768 {
        Err("KnownFolder path is too long".into())
    } else {
        String::from_utf16(unsafe { std::slice::from_raw_parts(text, length) })
            .map(PathBuf::from)
            .map_err(|e| e.to_string())
    };
    unsafe {
        CoTaskMemFree(text.cast());
    }
    let path = result?;
    let string = path.to_str().ok_or("KnownFolder path is invalid")?;
    if string.len() < 3
        || string.as_bytes()[1] != b':'
        || string.as_bytes()[2] != b'\\'
        || !string.as_bytes()[0].is_ascii_alphabetic()
        || string[2..].contains(':')
        || string.contains('/')
        || string.contains('\0')
        || path.components().any(|c| {
            matches!(
                c,
                std::path::Component::ParentDir | std::path::Component::CurDir
            )
        })
    {
        return Err("Baseline storage requires a local KnownFolder".into());
    }
    Ok(path)
}

struct Descriptor(LocalMemory);
impl Descriptor {
    fn artifact_directory(sid: &str) -> Result<Self, String> {
        let sddl = format!("O:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FRFX;;;{sid})");
        let mut sd = null_mut();
        checked(unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                text_wide(&sddl).as_ptr(),
                1,
                &mut sd,
                null_mut(),
            )
        })?;
        Ok(Self(LocalMemory(sd)))
    }
    fn new(authority: Authority, sid: &str) -> Result<Self, String> {
        let sddl = match authority {
            Authority::User => format!("O:{sid}D:P(A;;FA;;;SY)(A;;FA;;;{sid})"),
            Authority::Machine => format!("O:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FRFX;;;{sid})"),
        };
        let mut sd = null_mut();
        checked(unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                text_wide(&sddl).as_ptr(),
                1,
                &mut sd,
                null_mut(),
            )
        })?;
        Ok(Self(LocalMemory(sd)))
    }
    fn attributes(&self) -> SecurityAttributes {
        SecurityAttributes {
            length: std::mem::size_of::<SecurityAttributes>() as u32,
            descriptor: self.0 .0,
            inherit: 0,
        }
    }
    fn shared_machine() -> Result<Self, String> {
        let mut sd = null_mut();
        checked(unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                text_wide("O:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FRFX;;;BU)").as_ptr(),
                1,
                &mut sd,
                null_mut(),
            )
        })?;
        Ok(Self(LocalMemory(sd)))
    }
    fn validate_container(file: &File, authority: Authority, sid: &str) -> Result<(), String> {
        let mut owner = null_mut();
        let mut acl = null_mut();
        let mut sd = null_mut();
        let error = unsafe {
            GetSecurityInfo(
                file.as_raw_handle(),
                1,
                5,
                &mut owner,
                null_mut(),
                &mut acl,
                null_mut(),
                &mut sd,
            )
        };
        if error != 0 {
            return Err(std::io::Error::from_raw_os_error(error as i32).to_string());
        }
        let _allocation = LocalMemory(sd);
        if owner.is_null() || acl.is_null() {
            return Err("Baseline ancestor has no owner or DACL".into());
        }
        let mut trusted = Vec::new();
        for identity in ["S-1-5-18", "S-1-5-32-544"].into_iter().chain(
            if matches!(authority, Authority::User) {
                Some(sid)
            } else {
                None
            },
        ) {
            let mut pointer = null_mut();
            checked(unsafe { ConvertStringSidToSidW(text_wide(identity).as_ptr(), &mut pointer) })?;
            trusted.push(LocalMemory(pointer));
        }
        let is_trusted = |pointer| {
            trusted
                .iter()
                .any(|identity| unsafe { EqualSid(pointer, identity.0) } != 0)
        };
        if !is_trusted(owner) {
            return Err("Baseline ancestor has an untrusted owner".into());
        }
        let mut control = 0;
        let mut revision = 0;
        checked(unsafe { GetSecurityDescriptorControl(sd, &mut control, &mut revision) })?;
        if matches!(authority, Authority::Machine) && control & 0x1000 == 0 {
            return Err("Machine baseline ancestor DACL is not protected".into());
        }
        let count = unsafe { *((acl as *const u16).add(2)) };
        for index in 0..count {
            let mut ace = null_mut();
            checked(unsafe { GetAce(acl, index as u32, &mut ace) })?;
            let header = unsafe { std::slice::from_raw_parts(ace as *const u8, 4) };
            if header[1] & 8 != 0 {
                continue;
            } // INHERIT_ONLY_ACE has no access on this directory.
            if header[0] != 0 || u16::from_ne_bytes([header[2], header[3]]) < 16 {
                return Err("Baseline ancestor contains an unsupported access rule".into());
            }
            let mask = unsafe { *((ace as *const u32).add(1)) };
            let principal = unsafe { (ace as *mut u8).add(8).cast() };
            const MUTATING: u32 =
                2 | 4 | 16 | 64 | 256 | 0x10000 | 0x40000 | 0x80000 | 0x10000000 | 0x40000000;
            if mask & MUTATING != 0 && !is_trusted(principal) {
                return Err("Baseline ancestor grants mutation to an untrusted principal".into());
            }
        }
        Ok(())
    }
    fn validate(&self, file: &File) -> Result<(), String> {
        let mut owner = null_mut();
        let mut acl = null_mut();
        let mut sd = null_mut();
        let error = unsafe {
            GetSecurityInfo(
                file.as_raw_handle(),
                1,
                5,
                &mut owner,
                null_mut(),
                &mut acl,
                null_mut(),
                &mut sd,
            )
        };
        if error != 0 {
            return Err(std::io::Error::from_raw_os_error(error as i32).to_string());
        }
        let _allocation = LocalMemory(sd);
        let mut expected_owner = null_mut();
        let mut expected_acl = null_mut();
        let mut defaulted = 0;
        let mut present = 0;
        let mut control = 0u16;
        let mut revision = 0;
        checked(unsafe {
            GetSecurityDescriptorOwner(self.0 .0, &mut expected_owner, &mut defaulted)
        })?;
        checked(unsafe {
            GetSecurityDescriptorDacl(self.0 .0, &mut present, &mut expected_acl, &mut defaulted)
        })?;
        checked(unsafe { GetSecurityDescriptorControl(sd, &mut control, &mut revision) })?;
        if owner.is_null()
            || acl.is_null()
            || expected_owner.is_null()
            || expected_acl.is_null()
            || control & 0x1000 == 0
            || unsafe { EqualSid(owner, expected_owner) } == 0
        {
            return Err("Baseline store has an untrusted owner or unprotected ACL".into());
        }
        // Both ACLs come from validated Windows security descriptors. Exact ACL
        // comparison rejects inherited, writable, extra, or reordered ACEs.
        let length = unsafe { *((acl as *const u16).add(1)) } as usize;
        let expected_length = unsafe { *((expected_acl as *const u16).add(1)) } as usize;
        if length < 8
            || length != expected_length
            || unsafe {
                std::slice::from_raw_parts(acl as *const u8, length)
                    != std::slice::from_raw_parts(expected_acl as *const u8, expected_length)
            }
        {
            return Err("Baseline store ACL does not match the required access policy".into());
        }
        Ok(())
    }
}

fn open(path: &Path, directory: bool, read: bool) -> Result<Option<File>, String> {
    // Listing access makes directory pins participate in delete-sharing checks.
    let access = READ_CONTROL
        | 0x80
        | if directory { 0x1 } else { 0 } // FILE_LIST_DIRECTORY
        | if read { 0x80000000 } else { 0 };
    let handle = unsafe {
        CreateFileW(
            wide(path)?.as_ptr(),
            access,
            if directory { 3 } else { 1 },
            null_mut(),
            3,
            OPEN_REPARSE | if directory { BACKUP_SEMANTICS } else { 0 },
            null_mut(),
        )
    };
    if handle == -1isize as Handle {
        let error = std::io::Error::last_os_error();
        return if matches!(error.raw_os_error(), Some(2 | 3)) {
            Ok(None)
        } else {
            Err(error.to_string())
        };
    }
    let file = unsafe { File::from_raw_handle(handle) };
    verify(&file, path, directory)?;
    Ok(Some(file))
}
fn verify(file: &File, path: &Path, directory: bool) -> Result<(), String> {
    let mut info: FileInformation = unsafe { std::mem::zeroed() };
    checked(unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) })?;
    if info.attributes & 0x400 != 0
        || (info.attributes & 0x10 != 0) != directory
        || (!directory && info.links != 1)
    {
        return Err("Baseline path is a reparse point, alias, or incorrect object type".into());
    }
    let mut text = vec![0u16; 32768];
    let length = unsafe {
        GetFinalPathNameByHandleW(
            file.as_raw_handle(),
            text.as_mut_ptr(),
            text.len() as u32,
            0,
        )
    } as usize;
    if length == 0 || length >= text.len() {
        return Err("Could not verify baseline handle path".into());
    }
    let resolved = String::from_utf16(&text[..length]).map_err(|e| e.to_string())?;
    let expected = path.to_str().ok_or("Invalid baseline path")?;
    if !resolved
        .strip_prefix("\\\\?\\")
        .unwrap_or(&resolved)
        .eq_ignore_ascii_case(expected)
    {
        return Err("Baseline handle resolves to a different path".into());
    }
    Ok(())
}

struct Store {
    path: PathBuf,
    descriptor: Descriptor,
    // Keep every ancestor open: renaming any ancestor would invalidate authority.
    directories: Vec<(PathBuf, File)>,
}

/// EVTX-only, native-identity-derived artifact slot. The privileged writer owns
/// creation; authenticated users can only read the retained output.
pub(crate) struct ArtifactSlot {
    path: PathBuf,
    sid: String,
    directories: Vec<(PathBuf, File)>,
}
impl ArtifactSlot {
    pub(crate) fn open(sid: &str, id: &str, create: bool) -> Result<Self, String> {
        if id.len() != 32 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("Invalid native event artifact identity".into());
        }
        validate_identity(Authority::Machine, sid, &"0".repeat(64), id, create)?;
        let root = known_folder(Authority::Machine)?;
        let shared = Descriptor::shared_machine()?;
        let scoped = Descriptor::new(Authority::Machine, sid)?;
        let payload = Descriptor::artifact_directory(sid)?;
        let mut directories = Vec::new();
        let ancestors: Vec<_> = root.ancestors().map(Path::to_path_buf).collect();
        for ancestor in ancestors.into_iter().rev() {
            let file = open(&ancestor, true, false)?.ok_or("KnownFolder ancestor is missing")?;
            directories.push((ancestor, file));
        }
        let mut path = root;
        for (index, segment) in ["Purgeon", "Broker", "EventLogs", sid, "payload"]
            .into_iter()
            .enumerate()
        {
            path.push(segment);
            let descriptor = if index < 3 {
                &shared
            } else if index == 3 {
                &scoped
            } else {
                &payload
            };
            let mut file = open(&path, true, false)?;
            if file.is_none() && create {
                let attributes = descriptor.attributes();
                if unsafe { CreateDirectoryW(wide(&path)?.as_ptr(), &attributes) } == 0 {
                    let error = std::io::Error::last_os_error();
                    if error.raw_os_error() != Some(183) {
                        return Err(error.to_string());
                    }
                }
                file = open(&path, true, false)?;
            }
            let file = file.ok_or("Protected event artifact directory is missing")?;
            if index < 3 {
                Descriptor::validate_container(&file, Authority::Machine, sid)?;
            } else {
                descriptor.validate(&file)?;
            }
            directories.push((path.clone(), file));
        }
        path.push(format!("{id}.evtx"));
        Ok(Self {
            path,
            sid: sid.into(),
            directories,
        })
    }
    pub(crate) fn path(&self) -> &Path {
        &self.path
    }
    pub(crate) fn recheck(&self) -> Result<(), String> {
        for (path, file) in &self.directories {
            verify(file, path, true)?;
        }
        Ok(())
    }
    pub(crate) fn require_absent(&self) -> Result<(), String> {
        self.recheck()?;
        match std::fs::symlink_metadata(&self.path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.to_string()),
            Ok(_) => {
                Err("Protected event artifact already exists; it will not be overwritten".into())
            }
        }
    }
    fn validate_file_acl(&self, file: &File, protected: bool) -> Result<(), String> {
        let mut owner = null_mut();
        let mut acl = null_mut();
        let mut sd = null_mut();
        let error = unsafe {
            GetSecurityInfo(
                file.as_raw_handle(),
                1,
                5,
                &mut owner,
                null_mut(),
                &mut acl,
                null_mut(),
                &mut sd,
            )
        };
        if error != 0 {
            return Err(std::io::Error::from_raw_os_error(error as i32).to_string());
        }
        let _allocation = LocalMemory(sd);
        if owner.is_null() || acl.is_null() {
            return Err("Event artifact has no trusted owner/DACL".into());
        }
        let mut trusted_owner = false;
        for sid in ["S-1-5-18", "S-1-5-32-544"] {
            let mut pointer = null_mut();
            checked(unsafe { ConvertStringSidToSidW(text_wide(sid).as_ptr(), &mut pointer) })?;
            let pointer = LocalMemory(pointer);
            trusted_owner |= unsafe { EqualSid(owner, pointer.0) } != 0;
        }
        let mut control = 0;
        let mut revision = 0;
        checked(unsafe { GetSecurityDescriptorControl(sd, &mut control, &mut revision) })?;
        if !trusted_owner || (protected && control & 0x1000 == 0) {
            return Err("Event artifact has untrusted ownership or an unprotected DACL".into());
        }
        let expected = Descriptor::new(Authority::Machine, &self.sid)?;
        let mut expected_acl = null_mut();
        let mut present = 0;
        let mut defaulted = 0;
        checked(unsafe {
            GetSecurityDescriptorDacl(
                expected.0 .0,
                &mut present,
                &mut expected_acl,
                &mut defaulted,
            )
        })?;
        let actual_count = unsafe { *((acl as *const u16).add(2)) };
        let expected_count = unsafe { *((expected_acl as *const u16).add(2)) };
        if actual_count != expected_count {
            return Err("Event artifact contains unexpected access rules".into());
        }
        for index in 0..actual_count {
            let mut actual = null_mut();
            let mut wanted = null_mut();
            checked(unsafe { GetAce(acl, index as u32, &mut actual) })?;
            checked(unsafe { GetAce(expected_acl, index as u32, &mut wanted) })?;
            let length = unsafe { *((actual as *const u16).add(1)) } as usize;
            let expected_length = unsafe { *((wanted as *const u16).add(1)) } as usize;
            if length < 16 || length != expected_length {
                return Err("Invalid event artifact access rule".into());
            }
            let mut bytes =
                unsafe { std::slice::from_raw_parts(actual as *const u8, length) }.to_vec();
            // A newly generated EVTX inherits only the exact trusted payload
            // directory grants; INHERITED_ACE is the sole permitted difference.
            if bytes[1] & !0x10 != 0 {
                return Err("Unexpected event artifact inheritance flags".into());
            }
            bytes[1] &= !0x10;
            if bytes != unsafe { std::slice::from_raw_parts(wanted as *const u8, length) } {
                return Err("Event artifact grants unexpected access".into());
            }
        }
        Ok(())
    }
    pub(crate) fn seal(&self) -> Result<File, String> {
        self.recheck()?;
        let handle = unsafe {
            CreateFileW(
                wide(&self.path)?.as_ptr(),
                0x80000000 | 0x40000 | READ_CONTROL | 0x80,
                1,
                null_mut(),
                3,
                OPEN_REPARSE,
                null_mut(),
            )
        };
        if handle == -1isize as Handle {
            return Err(os_error());
        }
        let file = unsafe { File::from_raw_handle(handle) };
        verify(&file, &self.path, false)?;
        self.validate_file_acl(&file, false)?;
        let descriptor = Descriptor::new(Authority::Machine, &self.sid)?;
        let mut acl = null_mut();
        let mut present = 0;
        let mut defaulted = 0;
        checked(unsafe {
            GetSecurityDescriptorDacl(descriptor.0 .0, &mut present, &mut acl, &mut defaulted)
        })?;
        let error = unsafe {
            SetSecurityInfo(
                file.as_raw_handle(),
                1,
                4 | 0x80000000,
                null_mut(),
                null_mut(),
                acl,
                null_mut(),
            )
        };
        if error != 0 {
            return Err(std::io::Error::from_raw_os_error(error as i32).to_string());
        }
        self.validate_file_acl(&file, true)?;
        verify(&file, &self.path, false)?;
        self.recheck()?;
        Ok(file)
    }
    pub(crate) fn read(&self) -> Result<File, String> {
        self.recheck()?;
        let file = open(&self.path, false, true)?.ok_or("Retained event artifact is missing")?;
        self.validate_file_acl(&file, true)?;
        self.recheck()?;
        Ok(file)
    }
}
impl Store {
    fn open(
        domain: Domain,
        authority: Authority,
        sid: &str,
        hash: &str,
        id: &str,
        create: bool,
        resolve_root: impl FnOnce(Authority) -> Result<PathBuf, String>,
    ) -> Result<Option<Self>, String> {
        validate_identity(authority, sid, hash, id, create)?;
        let root = resolve_root(authority)?;
        let descriptor = Descriptor::new(authority, sid)?;
        let shared_machine = Descriptor::shared_machine()?;
        let mut directories = Vec::new();
        let ancestors: Vec<_> = root.ancestors().map(Path::to_path_buf).collect();
        for path in ancestors.into_iter().rev() {
            let file = open(&path, true, false)?.ok_or("KnownFolder ancestor is missing")?;
            if path == root && matches!(authority, Authority::User) {
                Descriptor::validate_container(&file, authority, sid)?;
            }
            directories.push((path, file));
        }
        let fixed: &[&str] = match authority {
            Authority::User => &[
                "com.seanshaffer.sweepuninstall",
                "broker-native",
                domain.directory(),
            ],
            Authority::Machine => &["Purgeon", "Broker", domain.directory()],
        };
        let mut path = root;
        for (index, segment) in fixed.iter().copied().chain([sid, hash]).enumerate() {
            path.push(segment);
            let shared = matches!(authority, Authority::Machine) && index < fixed.len();
            let creation_descriptor = if shared { &shared_machine } else { &descriptor };
            let mut file = open(&path, true, false)?;
            if file.is_none() && create {
                let sa = creation_descriptor.attributes();
                if unsafe { CreateDirectoryW(wide(&path)?.as_ptr(), &sa) } == 0 {
                    let error = std::io::Error::last_os_error();
                    if error.raw_os_error() != Some(183) {
                        return Err(error.to_string());
                    }
                }
                file = open(&path, true, false)?;
            }
            let Some(file) = file else {
                return Ok(None);
            };
            if shared || (matches!(authority, Authority::User) && index == 0) {
                Descriptor::validate_container(&file, authority, sid)?;
            } else {
                descriptor.validate(&file)?;
            }
            directories.push((path.clone(), file));
        }
        path.push(format!(
            "{id}.{}",
            match authority {
                Authority::User => "dpapi",
                Authority::Machine => "json",
            }
        ));
        Ok(Some(Self {
            path,
            descriptor,
            directories,
        }))
    }
    fn recheck(&self) -> Result<(), String> {
        for (path, file) in &self.directories {
            verify(file, path, true)?;
        }
        Ok(())
    }
}

/// Driver package directories are separate from the EVTX-only artifact slot.
/// Every returned handle pins its verified name without delete sharing.
pub(crate) struct DriverPackageRoot {
    path: PathBuf,
    sid: String,
    directories: Vec<(PathBuf, File)>,
}
impl DriverPackageRoot {
    pub(crate) fn open(sid: &str, id: &str, create: bool) -> Result<Self, String> {
        if id.len() != 32 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("Invalid native driver backup identity".into());
        }
        validate_identity(Authority::Machine, sid, &"0".repeat(64), id, create)?;
        let mut path = known_folder(Authority::Machine)?;
        let mut directories = Vec::new();
        for ancestor in path
            .ancestors()
            .map(Path::to_path_buf)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
        {
            let file = open(&ancestor, true, false)?.ok_or("KnownFolder ancestor missing")?;
            directories.push((ancestor, file));
        }
        for (index, segment) in ["Purgeon", "Broker", "Drivers", sid, "payload", id]
            .into_iter()
            .enumerate()
        {
            path.push(segment);
            let descriptor = if index < 3 {
                Descriptor::shared_machine()?
            } else {
                Descriptor::artifact_directory(sid)?
            };
            if create && index == 5 {
                let sa = descriptor.attributes();
                checked(unsafe { CreateDirectoryW(wide(&path)?.as_ptr(), &sa) })?;
            } else if open(&path, true, false)?.is_none() && create {
                let sa = descriptor.attributes();
                if unsafe { CreateDirectoryW(wide(&path)?.as_ptr(), &sa) } == 0
                    && std::io::Error::last_os_error().raw_os_error() != Some(183)
                {
                    return Err(os_error());
                }
            }
            let file =
                open(&path, true, false)?.ok_or("Protected driver package directory missing")?;
            if index < 3 {
                Descriptor::validate_container(&file, Authority::Machine, sid)?;
            } else {
                descriptor.validate(&file)?;
            }
            directories.push((path.clone(), file));
        }
        Ok(Self {
            path,
            sid: sid.into(),
            directories,
        })
    }
    pub(crate) fn path(&self) -> &Path {
        &self.path
    }
    pub(crate) fn recheck(&self) -> Result<(), String> {
        let scoped = self.directories.len().saturating_sub(6);
        for (index, (path, file)) in self.directories.iter().enumerate() {
            verify(file, path, true)?;
            if index >= scoped {
                if index - scoped < 3 {
                    Descriptor::validate_container(file, Authority::Machine, &self.sid)?;
                } else {
                    Descriptor::artifact_directory(&self.sid)?.validate(file)?;
                }
            }
        }
        Ok(())
    }
    pub(crate) fn child(
        &self,
        relative: &Path,
        directory: bool,
        seal: bool,
    ) -> Result<File, String> {
        if relative
            .components()
            .any(|c| !matches!(c, std::path::Component::Normal(_)))
        {
            return Err("Invalid driver package relative path".into());
        }
        crate::protected_driver_package::relative(
            &relative
                .to_str()
                .ok_or("Invalid driver package path")?
                .replace('\\', "/"),
        )?;
        self.recheck()?;
        let path = self.path.join(relative);
        let handle = unsafe {
            CreateFileW(
                wide(&path)?.as_ptr(),
                READ_CONTROL
                    | 0x80
                    | if directory { 0 } else { 0x80000000 }
                    | if seal { 0x40000 } else { 0 },
                1,
                null_mut(),
                3,
                OPEN_REPARSE | if directory { BACKUP_SEMANTICS } else { 0 },
                null_mut(),
            )
        };
        if handle == -1isize as Handle {
            return Err(os_error());
        }
        let file = unsafe { File::from_raw_handle(handle) };
        verify(&file, &path, directory)?;
        let descriptor = if directory {
            Descriptor::artifact_directory(&self.sid)?
        } else {
            Descriptor::new(Authority::Machine, &self.sid)?
        };
        validate_driver_acl(&file, &descriptor, !seal)?;
        if seal {
            let mut acl = null_mut();
            let mut present = 0;
            let mut defaulted = 0;
            checked(unsafe {
                GetSecurityDescriptorDacl(descriptor.0 .0, &mut present, &mut acl, &mut defaulted)
            })?;
            let error = unsafe {
                SetSecurityInfo(
                    file.as_raw_handle(),
                    1,
                    4 | 0x80000000,
                    null_mut(),
                    null_mut(),
                    acl,
                    null_mut(),
                )
            };
            if error != 0 {
                return Err(std::io::Error::from_raw_os_error(error as i32).to_string());
            }
            validate_driver_acl(&file, &descriptor, true)?;
        }
        verify(&file, &path, directory)?;
        self.recheck()?;
        Ok(file)
    }
}
fn validate_driver_acl(file: &File, expected: &Descriptor, protected: bool) -> Result<(), String> {
    let mut owner = null_mut();
    let mut acl = null_mut();
    let mut sd = null_mut();
    let error = unsafe {
        GetSecurityInfo(
            file.as_raw_handle(),
            1,
            5,
            &mut owner,
            null_mut(),
            &mut acl,
            null_mut(),
            &mut sd,
        )
    };
    if error != 0 {
        return Err(std::io::Error::from_raw_os_error(error as i32).to_string());
    }
    let _allocation = LocalMemory(sd);
    let mut trusted = false;
    if owner.is_null() || acl.is_null() {
        return Err("Driver artifact lacks trusted security metadata".into());
    }
    for sid in ["S-1-5-18", "S-1-5-32-544"] {
        let mut pointer = null_mut();
        checked(unsafe { ConvertStringSidToSidW(text_wide(sid).as_ptr(), &mut pointer) })?;
        let pointer = LocalMemory(pointer);
        trusted |= unsafe { EqualSid(owner, pointer.0) } != 0;
    }
    let mut control = 0;
    let mut revision = 0;
    checked(unsafe { GetSecurityDescriptorControl(sd, &mut control, &mut revision) })?;
    if !trusted || (protected && control & 0x1000 == 0) {
        return Err("Driver artifact has untrusted ownership or unprotected ACL".into());
    }
    let mut wanted = null_mut();
    let mut present = 0;
    let mut defaulted = 0;
    checked(unsafe {
        GetSecurityDescriptorDacl(expected.0 .0, &mut present, &mut wanted, &mut defaulted)
    })?;
    let count = unsafe { *((acl as *const u16).add(2)) };
    if count != unsafe { *((wanted as *const u16).add(2)) } {
        return Err("Driver artifact has unexpected access rules".into());
    }
    for index in 0..count {
        let mut a = null_mut();
        let mut b = null_mut();
        checked(unsafe { GetAce(acl, index as u32, &mut a) })?;
        checked(unsafe { GetAce(wanted, index as u32, &mut b) })?;
        let len = unsafe { *((a as *const u16).add(1)) } as usize;
        let other = unsafe { *((b as *const u16).add(1)) } as usize;
        if len < 16 || len != other {
            return Err("Invalid driver artifact access rule".into());
        }
        let mut bytes = unsafe { std::slice::from_raw_parts(a as *const u8, len) }.to_vec();
        bytes[1] &= !0x10;
        if bytes != unsafe { std::slice::from_raw_parts(b as *const u8, len) } {
            return Err("Driver artifact grants unexpected access".into());
        }
    }
    Ok(())
}
/// Source-package names are native-derived. TrustedInstaller ownership and
/// inherited read-only ACLs are permitted; untrusted mutation grants are not.
pub(crate) fn pin_driver_source(path: &Path, directory: bool) -> Result<File, String> {
    let file = open(path, directory, !directory)?.ok_or("Driver package source missing")?;
    let mut owner = null_mut();
    let mut acl = null_mut();
    let mut sd = null_mut();
    let error = unsafe {
        GetSecurityInfo(
            file.as_raw_handle(),
            1,
            5,
            &mut owner,
            null_mut(),
            &mut acl,
            null_mut(),
            &mut sd,
        )
    };
    if error != 0 {
        return Err(std::io::Error::from_raw_os_error(error as i32).to_string());
    }
    let _allocation = LocalMemory(sd);
    if owner.is_null() || acl.is_null() {
        return Err("Driver source security metadata missing".into());
    }
    let mut trusted = Vec::new();
    for identity in [
        "S-1-5-18",
        "S-1-5-32-544",
        "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464",
    ] {
        let mut pointer = null_mut();
        checked(unsafe { ConvertStringSidToSidW(text_wide(identity).as_ptr(), &mut pointer) })?;
        trusted.push(LocalMemory(pointer));
    }
    let is_trusted = |sid| trusted.iter().any(|p| unsafe { EqualSid(sid, p.0) } != 0);
    if !is_trusted(owner) {
        return Err("Driver source has untrusted owner".into());
    }
    let count = unsafe { *((acl as *const u16).add(2)) };
    for index in 0..count {
        let mut ace = null_mut();
        checked(unsafe { GetAce(acl, index as u32, &mut ace) })?;
        let header = unsafe { std::slice::from_raw_parts(ace as *const u8, 4) };
        if header[0] != 0 || u16::from_ne_bytes([header[2], header[3]]) < 16 {
            return Err("Unsupported driver source ACL rule".into());
        }
        if header[1] & 8 != 0 {
            continue;
        }
        let mask = unsafe { *((ace as *const u32).add(1)) };
        let principal = unsafe { (ace as *mut u8).add(8).cast() };
        if mask & (2 | 4 | 16 | 64 | 256 | 0x10000 | 0x40000 | 0x80000 | 0x10000000 | 0x40000000)
            != 0
            && !is_trusted(principal)
        {
            return Err("Driver source grants mutation to untrusted principal".into());
        }
    }
    Ok(file)
}
pub(crate) fn pin_driver_ancestor(path: &Path) -> Result<File, String> {
    open(path, true, false)?.ok_or("Driver package ancestor missing".into())
}

pub fn read(
    domain: Domain,
    authority: Authority,
    caller_sid: &str,
    catalog_hash: &str,
    tweak_id: &str,
) -> Result<Option<Vec<u8>>, String> {
    read_resolving(
        domain,
        authority,
        caller_sid,
        catalog_hash,
        tweak_id,
        known_folder,
    )
}

// The resolver stays private: public callers always use Windows known folders.
// Identity, ancestor pinning, ACLs and DPAPI remain shared with scratch tests.
fn read_resolving(
    domain: Domain,
    authority: Authority,
    caller_sid: &str,
    catalog_hash: &str,
    tweak_id: &str,
    resolve_root: impl FnOnce(Authority) -> Result<PathBuf, String>,
) -> Result<Option<Vec<u8>>, String> {
    let Some(store) = Store::open(
        domain,
        authority,
        caller_sid,
        catalog_hash,
        tweak_id,
        false,
        resolve_root,
    )?
    else {
        return Ok(None);
    };
    let Some(mut file) = open(&store.path, false, true)? else {
        return Ok(None);
    };
    store.descriptor.validate(&file)?;
    let length = file.metadata().map_err(|e| e.to_string())?.len();
    if length > MAX_STORED as u64 {
        return Err("Stored baseline exceeds size limit".into());
    }
    let mut bytes = Vec::with_capacity(length as usize);
    (&mut file)
        .take((MAX_STORED + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > MAX_STORED
        || bytes.len() as u64 != length
        || file.metadata().map_err(|e| e.to_string())?.len() != length
    {
        return Err("Baseline changed during bounded read".into());
    }
    verify(&file, &store.path, false)?;
    store.descriptor.validate(&file)?;
    store.recheck()?;
    let plaintext = match authority {
        Authority::User => crate::security::protect(&bytes, true)?,
        Authority::Machine => bytes,
    };
    if plaintext.len() > MAX_PLAIN {
        return Err("Decoded baseline exceeds size limit".into());
    }
    Ok(Some(plaintext))
}

pub fn write(
    domain: Domain,
    authority: Authority,
    caller_sid: &str,
    catalog_hash: &str,
    tweak_id: &str,
    plaintext: &[u8],
) -> Result<(), String> {
    write_resolving(
        domain,
        authority,
        caller_sid,
        catalog_hash,
        tweak_id,
        plaintext,
        known_folder,
    )
}

fn write_resolving(
    domain: Domain,
    authority: Authority,
    caller_sid: &str,
    catalog_hash: &str,
    tweak_id: &str,
    plaintext: &[u8],
    resolve_root: impl FnOnce(Authority) -> Result<PathBuf, String>,
) -> Result<(), String> {
    if plaintext.len() > MAX_PLAIN {
        return Err("Baseline exceeds plaintext size limit".into());
    }
    validate_identity(authority, caller_sid, catalog_hash, tweak_id, true)?;
    let bytes = match authority {
        Authority::User => crate::security::protect(plaintext, false)?,
        Authority::Machine => plaintext.to_vec(),
    };
    if bytes.len() > MAX_STORED {
        return Err("Protected baseline exceeds stored size limit".into());
    }
    let store = Store::open(
        domain,
        authority,
        caller_sid,
        catalog_hash,
        tweak_id,
        true,
        resolve_root,
    )?
    .ok_or("Baseline directory is missing")?;
    if let Some(existing) = open(&store.path, false, false)? {
        store.descriptor.validate(&existing)?;
    }
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let parent = store.path.parent().ok_or("Baseline parent is missing")?;
    let mut temporary = None;
    for _ in 0..32 {
        let path = parent.join(format!(
            ".baseline-{}-{}.tmp",
            unsafe { GetCurrentProcessId() },
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        #[cfg(test)]
        eprintln!(
            "baseline temporary path UTF16={}",
            path.as_os_str().encode_wide().count()
        );
        let sa = store.descriptor.attributes();
        let handle = unsafe {
            CreateFileW(
                wide(&path)?.as_ptr(),
                0x40000000 | READ_CONTROL,
                0,
                (&sa as *const SecurityAttributes).cast_mut().cast(),
                1,
                OPEN_REPARSE,
                null_mut(),
            )
        };
        if handle == -1isize as Handle {
            let error = std::io::Error::last_os_error();
            if matches!(error.raw_os_error(), Some(80 | 183)) {
                continue;
            }
            return Err(error.to_string());
        }
        temporary = Some((path, unsafe { File::from_raw_handle(handle) }));
        break;
    }
    let (temporary_path, mut file) =
        temporary.ok_or("Could not reserve baseline temporary file")?;
    let result = (|| {
        verify(&file, &temporary_path, false)?;
        store.descriptor.validate(&file)?;
        file.write_all(&bytes).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        store.recheck()?;
        // Parent directories are pinned; existing target metadata and ACL are
        // revalidated immediately before atomic replacement.
        if let Some(existing) = open(&store.path, false, false)? {
            store.descriptor.validate(&existing)?;
        }
        drop(file);
        checked(unsafe {
            MoveFileExW(
                wide(&temporary_path)?.as_ptr(),
                wide(&store.path)?.as_ptr(),
                1 | 8,
            )
        })?;
        let final_file = open(&store.path, false, false)?.ok_or("Written baseline disappeared")?;
        store.descriptor.validate(&final_file)?;
        store.recheck()
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary_path);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    // Only this owned directory is created or removed. No known-folder lookup
    // occurs in these tests; all security checks still use the actual token.
    struct Scratch(PathBuf);
    impl Scratch {
        fn new(sid: &str) -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let parent = PathBuf::from(env!("CARGO_MANIFEST_DIR").replace('/', "\\"))
                .join(r"target\coverage-fixtures");
            std::fs::create_dir_all(&parent).expect("create fixture parent");
            let path = parent.join(format!(
                "state-store-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            let descriptor = Descriptor::new(Authority::User, sid).expect("user descriptor");
            let attributes = descriptor.attributes();
            checked(unsafe {
                CreateDirectoryW(wide(&path).expect("fixture path").as_ptr(), &attributes)
            })
            .expect("create fresh protected fixture root");
            Self(path)
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.0).expect("remove owned fixture root");
        }
    }
    const HASH: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    #[test]
    fn user_dpapi_round_trip_without_storage() {
        let plaintext = b"state-store diagnostic baseline";
        let protected = crate::security::protect(plaintext, false)
            .expect("DPAPI encrypt without state-store filesystem operations");
        assert_ne!(protected, plaintext);
        let decoded = crate::security::protect(&protected, true)
            .expect("DPAPI decrypt without state-store filesystem operations");
        assert_eq!(decoded, plaintext);
    }

    #[test]
    fn scratch_protected_store_opens_without_dpapi() {
        let sid = current_sid(&token().expect("current token")).expect("current SID");
        let scratch = Scratch::new(&sid);
        let store = Store::open(
            Domain::Restore,
            Authority::User,
            &sid,
            HASH,
            "diagnostic",
            true,
            |_| Ok(scratch.0.clone()),
        )
        .expect("open/create protected scratch directories without DPAPI")
        .expect("protected scratch store exists after creation");
        store
            .recheck()
            .expect("recheck protected scratch ancestors");
        assert!(open(&store.path, false, false)
            .expect("open absent scratch record after protected directory creation")
            .is_none());
    }

    #[test]
    fn scratch_missing_record_does_not_create_storage() {
        let sid = current_sid(&token().expect("current token")).expect("current SID");
        let scratch = Scratch::new(&sid);
        let result = read_resolving(
            Domain::Restore,
            Authority::User,
            &sid,
            HASH,
            "missing",
            |_| Ok(scratch.0.clone()),
        )
        .expect("read missing scratch record");
        assert_eq!(result, None);
        assert_eq!(std::fs::read_dir(&scratch.0).unwrap().count(), 0);
    }

    #[test]
    fn scratch_user_round_trip_protects_and_replaces_record() {
        let sid = current_sid(&token().expect("current token")).expect("current SID");
        let scratch = Scratch::new(&sid);
        for plaintext in [
            b"original baseline".as_slice(),
            b"replacement baseline".as_slice(),
        ] {
            write_resolving(
                Domain::Restore,
                Authority::User,
                &sid,
                HASH,
                "roundtrip",
                plaintext,
                |_| Ok(scratch.0.clone()),
            )
            .expect("write protected scratch baseline");
            assert_eq!(
                read_resolving(
                    Domain::Restore,
                    Authority::User,
                    &sid,
                    HASH,
                    "roundtrip",
                    |_| Ok(scratch.0.clone()),
                )
                .expect("read protected scratch baseline"),
                Some(plaintext.to_vec())
            );
            let path = scratch
                .0
                .join("com.seanshaffer.sweepuninstall/broker-native/restore")
                .join(&sid)
                .join(HASH)
                .join("roundtrip.dpapi");
            let protected = std::fs::read(&path).expect("stored ciphertext");
            assert_ne!(protected, plaintext);
            assert_eq!(
                crate::security::protect(&protected, true).unwrap(),
                plaintext
            );
            assert_eq!(
                std::fs::read_dir(path.parent().unwrap()).unwrap().count(),
                1
            );
        }
    }

    #[test]
    fn local_path_encoder_rejects_ambiguous_namespaces() {
        for path in [
            r"relative",
            r"C:relative",
            r"\rooted",
            r"\\server\share",
            r"\\?\C:\safe",
            r"\\.\C:\safe",
            r"C:/safe",
            r"C:\safe/mixed",
            r"C:\safe:stream",
            r"C:\.\safe",
            r"C:\safe\..\other",
            r"C:\trailing.",
            r"C:\trailing ",
            r"C:\\empty",
            "C:\\nul\0name",
        ] {
            assert!(wide(Path::new(path)).is_err(), "accepted {path:?}");
        }
    }

    #[test]
    fn local_path_encoder_preserves_unicode_and_bounds_utf16() {
        for path in [r"C:\", r"C:\normal\file", r"Z:\基準\é\🦀"] {
            let encoded = wide(Path::new(path)).unwrap();
            assert_eq!(encoded, text_wide(&format!(r"\\?\{path}")));
        }
        // All segments remain <=255 units; this tests the total, including
        // the four-unit prefix and terminating NUL, independently of a volume.
        let path_of_length = |length: usize| {
            let mut path = String::from(r"C:\");
            while length - path.len() > 255 {
                path.push_str(&"a".repeat(254));
                path.push('\\');
            }
            path.push_str(&"b".repeat(length - path.len()));
            path
        };
        assert_eq!(
            wide(Path::new(&path_of_length(32762))).unwrap().len(),
            32767
        );
        assert!(wide(Path::new(&path_of_length(32763))).is_err());
        assert!(wide(Path::new(&format!(r"C:\{}", "a".repeat(256)))).is_err());
    }

    fn path_units(path: &Path) -> usize {
        path.as_os_str().encode_wide().count()
    }

    // Create each component explicitly with the same protected descriptor.
    // This never normalizes or redirects the owned scratch root.
    fn owned_directory_at(scratch: &Scratch, sid: &str, length: usize) -> PathBuf {
        let descriptor = Descriptor::new(Authority::User, sid).unwrap();
        let attributes = descriptor.attributes();
        let mut path = scratch.0.clone();
        assert!(path_units(&path) < length);
        while path_units(&path) < length {
            let remaining = length - path_units(&path);
            assert!(remaining >= 2, "directory boundary must fit a component");
            let mut segment = (remaining - 1).min(120);
            if remaining - segment - 1 == 1 {
                segment -= 1;
            }
            path.push("界".repeat(segment));
            let encoded = wide(&path).unwrap();
            if unsafe { CreateDirectoryW(encoded.as_ptr(), &attributes) } == 0 {
                let error = std::io::Error::last_os_error();
                assert_eq!(
                    error.raw_os_error(),
                    Some(183),
                    "create owned boundary: {error}"
                );
            }
            assert!(open(&path, true, false).unwrap().is_some());
        }
        assert_eq!(path_units(&path), length);
        path
    }

    #[test]
    fn scratch_legacy_directory_api_and_extended_boundaries() {
        let sid = current_sid(&token().unwrap()).unwrap();
        let scratch = Scratch::new(&sid);
        let descriptor = Descriptor::new(Authority::User, &sid).unwrap();
        let attributes = descriptor.attributes();
        eprintln!("owned root UTF16={}", path_units(&scratch.0));
        for length in [247, 248, 285, 512] {
            let parent = owned_directory_at(&scratch, &sid, length - 2);
            let path = parent.join("x");
            let legacy: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
            let result = unsafe { CreateDirectoryW(legacy.as_ptr(), &attributes) };
            let error = if result == 0 {
                std::io::Error::last_os_error().raw_os_error()
            } else {
                None
            };
            eprintln!(
                "CreateDirectoryW legacy path UTF16={length}, result={result}, raw_error={error:?}"
            );
            if result != 0 {
                // A host may opt into long paths. Record that result without
                // requiring or changing its manifest or machine policy.
                assert!(open(&path, true, false).unwrap().is_some());
            } else {
                checked(unsafe { CreateDirectoryW(wide(&path).unwrap().as_ptr(), &attributes) })
                    .expect("extended CreateDirectoryW after legacy failure");
                assert!(open(&path, true, false).unwrap().is_some());
            }
            eprintln!("extended directory verified UTF16={}", path_units(&path));
        }
        for length in [259, 260, 261, 301, 512] {
            let parent_length = if length < 285 { 247 } else { 285 };
            let parent = owned_directory_at(&scratch, &sid, parent_length);
            let path = parent.join("f".repeat(length - parent_length - 1));
            let encoded = wide(&path).unwrap();
            let handle = unsafe {
                CreateFileW(
                    encoded.as_ptr(),
                    READ_CONTROL | 0x40000000,
                    0,
                    (&attributes as *const SecurityAttributes).cast_mut().cast(),
                    1,
                    OPEN_REPARSE,
                    null_mut(),
                )
            };
            assert_ne!(
                handle,
                -1isize as Handle,
                "CreateFileW UTF16={length}: {}",
                os_error()
            );
            let file = unsafe { File::from_raw_handle(handle) };
            verify(&file, &path, false).unwrap();
            descriptor.validate(&file).unwrap();
            drop(file);
            assert_eq!(path_units(&path), length);
            eprintln!("extended file verified UTF16={length}, parent={parent_length}");
        }
    }

    #[test]
    fn scratch_long_unicode_store_round_trips_identity_bounds() {
        let sid = current_sid(&token().unwrap()).unwrap();
        let scratch = Scratch::new(&sid);
        let root = owned_directory_at(&scratch, &sid, 512);
        assert_eq!(
            read_resolving(
                Domain::Restore,
                Authority::User,
                &sid,
                HASH,
                "missing",
                |_| Ok(root.clone())
            )
            .unwrap(),
            None
        );
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 0);
        for id in ["a".to_string(), "z".repeat(96)] {
            let store = Store::open(
                Domain::Restore,
                Authority::User,
                &sid,
                HASH,
                &id,
                true,
                |_| Ok(root.clone()),
            )
            .unwrap()
            .unwrap();
            let record = store.path.clone();
            let parent = record.parent().unwrap().to_path_buf();
            eprintln!(
                "store root={}, parent={}, record={}, id={}",
                path_units(&root),
                path_units(&parent),
                path_units(&record),
                id.len()
            );
            assert!(!record.to_string_lossy().starts_with(r"\\?\"));
            drop(store);
            for plaintext in [b"first".as_slice(), b"replacement".as_slice()] {
                write_resolving(
                    Domain::Restore,
                    Authority::User,
                    &sid,
                    HASH,
                    &id,
                    plaintext,
                    |_| Ok(root.clone()),
                )
                .unwrap();
                assert_eq!(
                    read_resolving(Domain::Restore, Authority::User, &sid, HASH, &id, |_| Ok(
                        root.clone()
                    ))
                    .unwrap(),
                    Some(plaintext.to_vec())
                );
                let bytes = std::fs::read(&record).unwrap();
                assert_ne!(bytes, plaintext);
                assert_eq!(crate::security::protect(&bytes, true).unwrap(), plaintext);
                assert!(std::fs::read_dir(&parent).unwrap().all(|entry| !entry
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".baseline-")));
            }
        }
    }

    #[test]
    fn scratch_ancestor_pinning_is_preserved() {
        let sid = current_sid(&token().unwrap()).unwrap();
        let scratch = Scratch::new(&sid);
        let store = Store::open(
            Domain::Restore,
            Authority::User,
            &sid,
            HASH,
            "pin",
            true,
            |_| Ok(scratch.0.clone()),
        )
        .unwrap()
        .unwrap();
        let parent = store.path.parent().unwrap().to_path_buf();
        let record_name = store.path.file_name().unwrap().to_owned();
        let moved = scratch.0.join("moved");
        std::fs::write(&store.path, b"original record").unwrap();
        let sentinel = scratch.0.join("sentinel");
        std::fs::write(&sentinel, b"unchanged").unwrap();
        assert!(checked(unsafe {
            MoveFileExW(
                wide(&parent).unwrap().as_ptr(),
                wide(&moved).unwrap().as_ptr(),
                0,
            )
        })
        .is_err());
        assert!(std::fs::rename(&parent, &moved).is_err());
        assert_eq!(std::fs::read(&store.path).unwrap(), b"original record");
        assert_eq!(std::fs::read(&sentinel).unwrap(), b"unchanged");
        store.recheck().unwrap();
        drop(store);
        std::fs::rename(&parent, &moved).unwrap();
        assert_eq!(
            std::fs::read(moved.join(record_name)).unwrap(),
            b"original record"
        );
    }

    #[test]
    fn scratch_driver_ancestor_pin_blocks_rename_until_released() {
        let sid = current_sid(&token().unwrap()).unwrap();
        let scratch = Scratch::new(&sid);
        let parent = scratch.0.join("ancestor");
        let moved = scratch.0.join("moved");
        std::fs::create_dir(&parent).unwrap();
        let pin = pin_driver_ancestor(&parent).unwrap();
        assert!(checked(unsafe {
            MoveFileExW(
                wide(&parent).unwrap().as_ptr(),
                wide(&moved).unwrap().as_ptr(),
                0,
            )
        })
        .is_err());
        assert!(std::fs::rename(&parent, &moved).is_err());
        drop(pin);
        std::fs::rename(&parent, &moved).unwrap();
    }

    #[test]
    fn scratch_hardlink_alias_is_rejected() {
        let sid = current_sid(&token().unwrap()).unwrap();
        let scratch = Scratch::new(&sid);
        let file = scratch.0.join("original");
        let alias = scratch.0.join("alias");
        std::fs::write(&file, b"owned fixture").unwrap();
        std::fs::hard_link(&file, &alias).unwrap();
        assert!(open(&file, false, true).is_err());
        assert!(open(&alias, false, true).is_err());
    }

    #[test]
    fn scratch_junction_is_rejected_without_following_target() {
        let sid = current_sid(&token().unwrap()).unwrap();
        let scratch = Scratch::new(&sid);
        let target = scratch.0.join("target");
        let junction = scratch.0.join("junction");
        std::fs::create_dir(&target).unwrap();
        std::fs::write(target.join("sentinel"), b"unchanged").unwrap();
        let output = std::process::Command::new("cmd.exe")
            .args(["/d", "/c", "mklink", "/J"])
            .arg(&junction)
            .arg(&target)
            .output()
            .expect("run owned junction creation");
        assert!(
            output.status.success(),
            "junction regression blocked: status={:?}; stdout={}; stderr={}",
            output.status.code(),
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        let rejected = open(&junction, true, false).is_err();
        // Remove the junction itself before recursive scratch cleanup.
        std::fs::remove_dir(&junction).unwrap();
        assert!(rejected);
        assert_eq!(
            std::fs::read(target.join("sentinel")).unwrap(),
            b"unchanged"
        );
    }
}
