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
}
impl Domain {
    fn directory(self) -> &'static str {
        match self {
            Self::Debloat => "debloat",
            Self::Restore => "restore",
            Self::EventLogs => "EventLogs",
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
fn wide(path: &Path) -> Vec<u16> {
    path.as_os_str().encode_wide().chain(Some(0)).collect()
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
    // Directories remain pinned without FILE_SHARE_DELETE for the operation.
    let access = READ_CONTROL | 0x80 | if read { 0x80000000 } else { 0 };
    let handle = unsafe {
        CreateFileW(
            wide(path).as_ptr(),
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
                if unsafe { CreateDirectoryW(wide(&path).as_ptr(), &attributes) } == 0 {
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
                wide(&self.path).as_ptr(),
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
    ) -> Result<Option<Self>, String> {
        validate_identity(authority, sid, hash, id, create)?;
        let root = known_folder(authority)?;
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
                if unsafe { CreateDirectoryW(wide(&path).as_ptr(), &sa) } == 0 {
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

pub fn read(
    domain: Domain,
    authority: Authority,
    caller_sid: &str,
    catalog_hash: &str,
    tweak_id: &str,
) -> Result<Option<Vec<u8>>, String> {
    let Some(store) = Store::open(domain, authority, caller_sid, catalog_hash, tweak_id, false)?
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
    let store = Store::open(domain, authority, caller_sid, catalog_hash, tweak_id, true)?
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
        let sa = store.descriptor.attributes();
        let handle = unsafe {
            CreateFileW(
                wide(&path).as_ptr(),
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
        // Parent directories are pinned and the existing target cannot be replaced
        // while its validation handle is open. Release it immediately before rename.
        if let Some(existing) = open(&store.path, false, false)? {
            store.descriptor.validate(&existing)?;
        }
        drop(file);
        checked(unsafe {
            MoveFileExW(
                wide(&temporary_path).as_ptr(),
                wide(&store.path).as_ptr(),
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
