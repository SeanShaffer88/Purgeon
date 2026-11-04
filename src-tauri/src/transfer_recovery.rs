//! Exact replacement receipts. No recovery operation searches by newest deletion.
//! Receipts are validated local evidence, not authenticated renderer authority.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::ffi::c_void;
use std::fs::{self, File, OpenOptions};
use std::io::Read;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
use std::os::windows::io::AsRawHandle;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

const ATTR: u32 = 0x80;
const READ: u32 = 0x80000000;
const DELETE: u32 = 0x10000;
const FLAGS: u32 = 0x00200000 | 0x02000000;
const MAX_ENTRIES: usize = 10000;
const MAX_BYTES: u64 = 512 * 1024 * 1024;

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
    high: u32,
    low: u32,
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
    fn GetFinalPathNameByHandleW(file: *mut c_void, path: *mut u16, length: u32, flags: u32)
        -> u32;
    fn SetFileInformationByHandle(
        file: *mut c_void,
        class: u32,
        info: *const c_void,
        length: u32,
    ) -> i32;
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Identity {
    volume: u32,
    high: u32,
    low: u32,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Receipt {
    version: u32,
    target: String,
    sid: String,
    machine: String,
    info_name: String,
    info_sha256: String,
    identity: Identity,
    directory: bool,
    digest: String,
}
#[derive(Serialize)]
pub struct Restored {
    restored: bool,
}
fn error() -> String {
    std::io::Error::last_os_error().to_string()
}
fn text(path: &Path) -> Result<String, String> {
    path.to_str()
        .map(str::to_owned)
        .ok_or("Transfer path is not Unicode".into())
}
fn same(a: &Path, b: &Path) -> bool {
    a.to_string_lossy()
        .eq_ignore_ascii_case(&b.to_string_lossy())
}
// Ancestor pins are observations, not mutation targets: drive/profile roots must
// be pin-able while still rejecting redirects and changed handle paths.
pub(crate) fn verify_path(file: &File, expected: &Path) -> Result<(), String> {
    let mut buffer = vec![0u16; 32768];
    let count = unsafe {
        GetFinalPathNameByHandleW(
            file.as_raw_handle(),
            buffer.as_mut_ptr(),
            buffer.len() as u32,
            0,
        )
    } as usize;
    if count == 0 || count >= buffer.len() {
        return Err("Cannot resolve replacement handle".into());
    }
    let actual = String::from_utf16(&buffer[..count]).map_err(|e| e.to_string())?;
    if !same(Path::new(actual.trim_start_matches("\\\\?\\")), expected) {
        return Err("Replacement handle resolves to another path".into());
    }
    Ok(())
}
pub(crate) fn identity(file: &File, directory: bool) -> Result<Identity, String> {
    let mut info: Information = unsafe { std::mem::zeroed() };
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
        return Err(error());
    }
    if info.attributes & 0x400 != 0
        || (info.attributes & 0x10 != 0) != directory
        || (!directory && info.links != 1)
    {
        return Err(
            "Replacement backup refuses reparse points, hardlinks or a changed item kind".into(),
        );
    }
    Ok(Identity {
        volume: info.volume,
        high: info.high,
        low: info.low,
    })
}
pub(crate) fn open(
    path: &Path,
    directory: bool,
    access: u32,
    sharing: u32,
) -> Result<File, String> {
    let file = OpenOptions::new()
        .access_mode(access)
        .share_mode(sharing)
        .custom_flags(FLAGS)
        .open(path)
        .map_err(|e| e.to_string())?;
    identity(&file, directory)?;
    verify_path(&file, path)?;
    Ok(file)
}
pub(crate) struct Parents(Vec<(PathBuf, File)>);
impl Parents {
    pub(crate) fn open(path: &Path) -> Result<Self, String> {
        let mut pins = Vec::new();
        let parent = path.parent().ok_or("Replacement has no parent")?;
        let canonical = fs::canonicalize(parent).map_err(|e| e.to_string())?;
        let canonical = PathBuf::from(text(&canonical)?.trim_start_matches("\\\\?\\"));
        let parents: Vec<_> = parent.ancestors().collect();
        let canonical_parents: Vec<_> = canonical.ancestors().collect();
        if parents.len() != canonical_parents.len() {
            return Err("Replacement ancestor path changed".into());
        }
        for (parent, canonical) in parents.into_iter().zip(canonical_parents) {
            let file = OpenOptions::new()
                .access_mode(ATTR)
                .share_mode(3)
                .custom_flags(FLAGS)
                .open(parent)
                .map_err(|e| e.to_string())?;
            // Open every supplied ancestor so canonicalization cannot hide a redirect.
            identity(&file, true)?;
            verify_path(&file, canonical)?;
            pins.push((canonical.to_path_buf(), file));
        }
        Ok(Self(pins))
    }
    pub(crate) fn verify(&self) -> Result<(), String> {
        for (path, file) in &self.0 {
            identity(file, true)?;
            verify_path(file, path)?;
        }
        Ok(())
    }
}
fn sha(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
fn valid_hash(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
}
pub(crate) fn missing(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(false),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(true),
        Err(e) => Err(e.to_string()),
    }
}
pub(crate) fn canonical(path: &str) -> Result<PathBuf, String> {
    crate::security::checked_path(path)?;
    let requested = Path::new(path);
    let parent = requested.parent().ok_or("Replacement has no parent")?;
    let parent = fs::canonicalize(parent).map_err(|e| e.to_string())?;
    let mut result = PathBuf::from(parent.to_string_lossy().trim_start_matches("\\\\?\\"));
    result.push(requested.file_name().ok_or("Replacement has no name")?);
    crate::security::checked_path(&text(&result)?)?;
    Ok(result)
}
struct Context {
    target: PathBuf,
    bin: PathBuf,
    sid: String,
    machine: String,
}
impl Context {
    fn production(target: &str) -> Result<Self, String> {
        let target = canonical(target)?;
        let profile = fs::canonicalize(std::env::var("USERPROFILE").map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        let profile = PathBuf::from(profile.to_string_lossy().trim_start_matches("\\\\?\\"));
        if !text(&target)?
            .to_lowercase()
            .starts_with(&(text(&profile)?.to_lowercase() + "\\"))
        {
            return Err("Replacement recovery is limited to the current user profile".into());
        }
        let sid = crate::broker::current_sid()?;
        let machine: String = winreg::RegKey::predef(winreg::enums::HKEY_LOCAL_MACHINE)
            .open_subkey_with_flags(
                "SOFTWARE\\Microsoft\\Cryptography",
                winreg::enums::KEY_READ | winreg::enums::KEY_WOW64_64KEY,
            )
            .and_then(|key| key.get_value("MachineGuid"))
            .map_err(|e| e.to_string())?;
        if machine.is_empty() || machine.len() > 256 {
            return Err("Machine recovery identity is invalid".into());
        }
        let volume = &text(&target)?[..3];
        let bin = Path::new(volume).join("$Recycle.Bin").join(&sid);
        Ok(Self {
            target,
            bin,
            sid,
            machine,
        })
    }
    fn paths(&self, receipt: &Receipt) -> Result<(PathBuf, PathBuf), String> {
        if receipt.version != 1
            || receipt.sid != self.sid
            || receipt.machine != self.machine
            || !same(Path::new(&receipt.target), &self.target)
            || !receipt.info_name.starts_with("$I")
            || receipt.info_name.len() < 3
            || receipt.info_name.encode_utf16().count() > 255
            || receipt.info_name.ends_with(['.', ' '])
            || receipt.info_name[2..].chars().any(|c| {
                c.is_control() || ['\\', '/', ':', '*', '?', '"', '<', '>', '|'].contains(&c)
            })
            || !valid_hash(&receipt.info_sha256)
            || !valid_hash(&receipt.digest)
        {
            return Err("Invalid, foreign or unsupported exact replacement receipt".into());
        }
        Ok((
            self.bin.join(&receipt.info_name),
            self.bin.join(format!("$R{}", &receipt.info_name[2..])),
        ))
    }
}
// Both Windows $I layouts are bounded and decoded strictly. Path length includes NUL.
fn original_path(bytes: &[u8]) -> Result<PathBuf, String> {
    if bytes.len() < 28 || bytes.len() > 65564 {
        return Err("Invalid Recycle Bin metadata length".into());
    }
    let version = u64::from_le_bytes(bytes[..8].try_into().unwrap());
    let raw = match version {
        1 if bytes.len() == 544 => &bytes[24..],
        2 => {
            let count = u32::from_le_bytes(bytes[24..28].try_into().unwrap()) as usize;
            if count == 0
                || count > 32768
                || count.checked_mul(2).and_then(|n| n.checked_add(28)) != Some(bytes.len())
            {
                return Err("Invalid Recycle Bin path length".into());
            }
            &bytes[28..]
        }
        _ => return Err("Unsupported Recycle Bin metadata format".into()),
    };
    let units: Vec<u16> = raw
        .as_chunks::<2>()
        .0
        .iter()
        .map(|b| u16::from_le_bytes([b[0], b[1]]))
        .collect();
    let end = units
        .iter()
        .position(|u| *u == 0)
        .ok_or("Recycle Bin path is not terminated")?;
    if end == 0 || (version == 2 && end != units.len() - 1) {
        return Err("Invalid Recycle Bin path terminator".into());
    }
    let path =
        String::from_utf16(&units[..end]).map_err(|_| "Invalid Recycle Bin path encoding")?;
    crate::security::checked_path(&path)?;
    Ok(PathBuf::from(path))
}
fn metadata(path: &Path, target: &Path, deletable: bool) -> Result<(File, String), String> {
    let mut file = open(path, false, READ | if deletable { DELETE } else { 0 }, 1)?;
    if file.metadata().map_err(|e| e.to_string())?.len() > 65564 {
        return Err("Recycle Bin metadata exceeds limit".into());
    }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    if !same(&original_path(&bytes)?, target) {
        return Err("Recycle Bin metadata belongs to a different original path".into());
    }
    Ok((file, sha(&bytes)))
}
pub(crate) fn snapshot(root: &Path, directory: bool) -> Result<(Identity, String), String> {
    let (id, digest, _) = snapshot_pinned(root, directory, false)?;
    Ok((id, digest))
}
pub(crate) fn snapshot_pinned(
    root: &Path,
    directory: bool,
    pin_children: bool,
) -> Result<(Identity, String, Vec<File>), String> {
    let started = Instant::now();
    let root_file = open(root, directory, ATTR, 7)?;
    let id = identity(&root_file, directory)?;
    let mut hash = Sha256::new();
    let mut count = 0;
    let mut discovered = 1usize;
    let mut bytes = 0u64;
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    let mut pins = Vec::new();
    while let Some((path, depth)) = stack.pop() {
        count += 1;
        if count > MAX_ENTRIES || depth > 64 || started.elapsed() > Duration::from_secs(30) {
            return Err("Replacement backup exceeds entry, depth or time limits".into());
        }
        let m = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
        if m.file_attributes() & 0x400 != 0 {
            return Err("Replacement backup contains a reparse point".into());
        }
        let dir = m.is_dir();
        // Child delete sharing is required for Windows to rename the held root.
        // Deny data writers; membership changes are checked again after staging.
        let mut file = open(
            &path,
            dir,
            if dir { ATTR } else { READ },
            if pin_children && path != root { 5 } else { 7 },
        )?;
        let node = identity(&file, dir)?;
        let relative = text(path.strip_prefix(root).map_err(|e| e.to_string())?)?;
        hash.update((relative.len() as u64).to_le_bytes());
        hash.update(relative.as_bytes());
        hash.update([u8::from(dir)]);
        hash.update(node.volume.to_le_bytes());
        hash.update(node.high.to_le_bytes());
        hash.update(node.low.to_le_bytes());
        if dir {
            let mut children = Vec::new();
            for child in fs::read_dir(&path).map_err(|e| e.to_string())? {
                if discovered >= MAX_ENTRIES || started.elapsed() > Duration::from_secs(30) {
                    return Err("Replacement directory exceeds entry or time limit".into());
                }
                discovered += 1;
                children.push(child.map_err(|e| e.to_string())?.path());
            }
            children.sort();
            let mut names = HashSet::new();
            for child in children.into_iter().rev() {
                if !names.insert(
                    text(
                        child
                            .file_name()
                            .map(Path::new)
                            .ok_or("Invalid child name")?,
                    )?
                    .to_lowercase(),
                ) {
                    return Err("Ambiguous replacement child names".into());
                }
                stack.push((child, depth + 1));
            }
        } else {
            let size = file.metadata().map_err(|e| e.to_string())?.len();
            bytes = bytes.checked_add(size).ok_or("Replacement size overflow")?;
            if bytes > MAX_BYTES {
                return Err("Replacement backup exceeds 512 MiB limit".into());
            }
            hash.update(size.to_le_bytes());
            let mut buffer = [0u8; 65536];
            let mut read = 0u64;
            loop {
                if started.elapsed() > Duration::from_secs(30) {
                    return Err("Replacement hashing timed out".into());
                }
                let n = file.read(&mut buffer).map_err(|e| e.to_string())?;
                if n == 0 {
                    break;
                }
                read += n as u64;
                if read > size {
                    return Err("Replacement file changed while hashing".into());
                }
                hash.update(&buffer[..n]);
            }
            if read != size {
                return Err("Replacement file changed while hashing".into());
            }
        }
        verify_path(&file, &path)?;
        if pin_children {
            pins.push(file);
        }
    }
    Ok((
        id,
        hash.finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect(),
        pins,
    ))
}
fn info_names(bin: &Path) -> Result<HashSet<String>, String> {
    let started = Instant::now();
    let entries = match fs::read_dir(bin) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(HashSet::new()),
        Err(e) => return Err(e.to_string()),
    };
    let mut names = HashSet::new();
    for (count, entry) in entries.enumerate() {
        if count >= 200000 || started.elapsed() > Duration::from_secs(30) {
            return Err("Recycle Bin inventory exceeds entry or time limit".into());
        }
        let name = entry
            .map_err(|e| e.to_string())?
            .file_name()
            .into_string()
            .map_err(|_| "Invalid Recycle Bin item name")?;
        if name.starts_with("$I") {
            names.insert(name);
        }
        if names.len() > 100000 {
            return Err("Recycle Bin inventory exceeds limit".into());
        }
    }
    Ok(names)
}
fn capture_expected(
    context: &Context,
    directory: bool,
    recycle: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<Receipt, String> {
    let parents = Parents::open(&context.target)?;
    let (source_id, digest) = snapshot(&context.target, directory)?;
    let _before_bin_pins = if missing(&context.bin)? {
        None
    } else {
        Some(Parents::open(&context.bin.join("receipt"))?)
    };
    let before = info_names(&context.bin)?;
    recycle(&context.target)?;
    parents.verify()?;
    if !missing(&context.target)? {
        return Err("Replacement did not remove the original; evidence retained".into());
    }
    let _bin_pins = Parents::open(&context.bin.join("receipt"))?;
    let mut matches = Vec::new();
    for name in info_names(&context.bin)?.difference(&before) {
        let payload = context.bin.join(format!("$R{}", &name[2..]));
        let Ok(file) = open(&payload, directory, ATTR, 7) else {
            continue;
        };
        if identity(&file, directory)? != source_id {
            continue;
        }
        let (_info, info_sha256) = metadata(&context.bin.join(name), &context.target, false)?;
        let (id, actual_digest) = snapshot(&payload, directory)?;
        if id != source_id || actual_digest != digest {
            return Err(
                "Original replacement backup changed while recycling; evidence retained".into(),
            );
        }
        let receipt = Receipt {
            version: 1,
            target: text(&context.target)?,
            sid: context.sid.clone(),
            machine: context.machine.clone(),
            info_name: name.clone(),
            info_sha256,
            identity: id,
            directory,
            digest: digest.clone(),
        };
        context.paths(&receipt)?;
        matches.push(receipt);
    }
    if matches.len() != 1 {
        return Err("Cannot identify exactly one original replacement backup; review the retained Recycle Bin evidence".into());
    }
    Ok(matches.remove(0))
}
pub fn capture(target: &str, directory: bool) -> Result<Receipt, String> {
    let context = Context::production(target)?;
    capture_expected(&context, directory, |path| {
        trash::delete(path).map_err(|e| e.to_string())
    })
}
#[cfg(test)]
fn capture_in(
    context: &Context,
    recycle: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<Receipt, String> {
    capture_expected(
        context,
        fs::symlink_metadata(&context.target)
            .map_err(|e| e.to_string())?
            .is_dir(),
        recycle,
    )
}
struct Checked {
    _parents: Parents,
    _info: File,
    payload: PathBuf,
    file: File,
}
fn checked(context: &Context, receipt: &Receipt, access: u32) -> Result<Checked, String> {
    let (info, payload) = context.paths(receipt)?;
    let parents = Parents::open(&payload)?;
    let (info_file, info_sha256) = metadata(&info, &context.target, true)?;
    if info_sha256 != receipt.info_sha256 {
        return Err("Exact replacement metadata changed; evidence retained".into());
    }
    let file = open(&payload, receipt.directory, access, 1)?;
    if identity(&file, receipt.directory)? != receipt.identity {
        return Err("Exact original replacement identity changed".into());
    }
    let (id, digest) = snapshot(&payload, receipt.directory)?;
    if id != receipt.identity || digest != receipt.digest {
        return Err("Exact original replacement contents changed".into());
    }
    parents.verify()?;
    Ok(Checked {
        _parents: parents,
        _info: info_file,
        payload,
        file,
    })
}
pub fn validate(target: &str, receipt: &Receipt) -> Result<(), String> {
    let context = Context::production(target)?;
    checked(&context, receipt, ATTR)?;
    Ok(())
}
fn restore_in(
    context: &Context,
    receipt: &Receipt,
    cleanup: impl FnOnce(&File) -> Result<(), String>,
) -> Result<Restored, String> {
    let held = checked(context, receipt, ATTR | DELETE)?;
    let parents = Parents::open(&context.target)?;
    if !missing(&context.target)? {
        return Err("Replacement destination already exists; original backup retained".into());
    }
    let name: Vec<u16> = context.target.as_os_str().encode_wide().collect();
    let offset = std::mem::offset_of!(RenameInformation, name);
    let bytes = offset
        .checked_add(name.len() * 2 + 2)
        .ok_or("Replacement rename path is too long")?;
    let mut buffer = vec![0u64; bytes.div_ceil(8)];
    let pointer = buffer.as_mut_ptr().cast::<RenameInformation>();
    parents.verify()?;
    held._parents.verify()?;
    unsafe {
        (*pointer).replace = 0;
        (*pointer).root = std::ptr::null_mut();
        (*pointer).length = (name.len() * 2) as u32;
        std::ptr::copy_nonoverlapping(name.as_ptr(), (*pointer).name.as_mut_ptr(), name.len());
        if SetFileInformationByHandle(held.file.as_raw_handle(), 3, pointer.cast(), bytes as u32)
            == 0
        {
            return Err(error());
        }
    }
    let verify = (|| {
        parents.verify()?;
        verify_path(&held.file, &context.target)?;
        let (id, digest) = snapshot(&context.target, receipt.directory)?;
        if id != receipt.identity || digest != receipt.digest || !missing(&held.payload)? {
            return Err("Restored original identity or contents could not be verified".into());
        }
        Ok::<_, String>(())
    })();
    verify.map_err(|e| format!("Original backup may have moved but verification failed; retained evidence needs review: {e}"))?;
    // Stale $I metadata is safer than reporting a proven restore as failed.
    let _ = cleanup(&held._info);
    Ok(Restored { restored: true })
}
pub fn restore(target: &str, receipt: &Receipt) -> Result<Restored, String> {
    restore_in(&Context::production(target)?, receipt, cleanup_info)
}
// Reconcile a crash after the exact original moved but before its completion
// checkpoint. Its identity remains proof even after the bin metadata was cleaned.
pub fn original_at_target(target: &str, receipt: &Receipt) -> Result<bool, String> {
    let context = Context::production(target)?;
    context.paths(receipt)?;
    if missing(&context.target)? {
        return Ok(false);
    }
    let (id, digest) = snapshot(&context.target, receipt.directory)?;
    Ok(id == receipt.identity && digest == receipt.digest)
}
pub(crate) fn rename_no_replace(file: &File, destination: &Path) -> Result<(), String> {
    let name: Vec<u16> = destination.as_os_str().encode_wide().collect();
    let offset = std::mem::offset_of!(RenameInformation, name);
    let bytes = offset
        .checked_add(name.len() * 2 + 2)
        .ok_or("Undo path is too long")?;
    let mut buffer = vec![0u64; bytes.div_ceil(8)];
    let pointer = buffer.as_mut_ptr().cast::<RenameInformation>();
    unsafe {
        (*pointer).replace = 0;
        (*pointer).root = std::ptr::null_mut();
        (*pointer).length = (name.len() * 2) as u32;
        std::ptr::copy_nonoverlapping(name.as_ptr(), (*pointer).name.as_mut_ptr(), name.len());
        if SetFileInformationByHandle(file.as_raw_handle(), 3, pointer.cast(), bytes as u32) == 0 {
            return Err(error());
        }
    }
    Ok(())
}
fn cleanup_info(file: &File) -> Result<(), String> {
    cleanup_held(file)
}
pub(crate) fn cleanup_held(file: &File) -> Result<(), String> {
    let information = DispositionInformation { delete: 1 };
    if unsafe {
        SetFileInformationByHandle(
            file.as_raw_handle(),
            4,
            (&information as *const DispositionInformation).cast(),
            std::mem::size_of::<DispositionInformation>() as u32,
        )
    } == 0
    {
        return Err(error());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct Fixture {
        root: PathBuf,
        context: Context,
    }
    impl Fixture {
        fn new(directory: bool) -> Self {
            let root = std::env::temp_dir().join(format!(
                "purgeon-transfer-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&root).unwrap();
            let root = PathBuf::from(
                fs::canonicalize(root)
                    .unwrap()
                    .to_string_lossy()
                    .trim_start_matches("\\\\?\\"),
            );
            let target = root.join(if directory {
                "settings"
            } else {
                "settings.ini"
            });
            if directory {
                fs::create_dir(&target).unwrap();
                fs::write(target.join("data.ini"), b"original A").unwrap();
            } else {
                fs::write(&target, b"original A").unwrap();
            }
            let bin = root.join("scratch-bin");
            fs::create_dir(&bin).unwrap();
            Self {
                root,
                context: Context {
                    target,
                    bin,
                    sid: "S-1-5-21-fixture".into(),
                    machine: "fixture-machine".into(),
                },
            }
        }
        fn recycle(&self, name: &str) -> Result<(), String> {
            fs::rename(
                &self.context.target,
                self.context.bin.join(format!("$R{name}")),
            )
            .map_err(|e| e.to_string())?;
            fs::write(
                self.context.bin.join(format!("$I{name}")),
                info_bytes(&self.context.target, 2),
            )
            .map_err(|e| e.to_string())
        }
        fn capture(&self) -> Receipt {
            capture_in(&self.context, |_| self.recycle("original.ini")).unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.root).unwrap();
        }
    }
    fn info_bytes(path: &Path, version: u64) -> Vec<u8> {
        let mut name: Vec<u16> = path.as_os_str().encode_wide().collect();
        name.push(0);
        let mut bytes = Vec::new();
        bytes.extend(version.to_le_bytes());
        bytes.extend(10u64.to_le_bytes());
        bytes.extend(123u64.to_le_bytes());
        if version == 2 {
            bytes.extend((name.len() as u32).to_le_bytes());
        }
        for unit in name {
            bytes.extend(unit.to_le_bytes());
        }
        if version == 1 {
            bytes.resize(544, 0);
        }
        bytes
    }
    #[test]
    fn exact_file_and_directory_receipts_survive_reload_and_ignore_newer_same_path_items() {
        for directory in [false, true] {
            let f = Fixture::new(directory);
            // Ancestor verification must allow observation/pinning of drive roots.
            Parents::open(&f.context.target).unwrap().verify().unwrap();
            let receipt = f.capture();
            let receipt: Receipt =
                serde_json::from_str(&serde_json::to_string(&receipt).unwrap()).unwrap();
            checked(&f.context, &receipt, ATTR).unwrap();
            if directory {
                fs::create_dir(&f.context.target).unwrap();
                fs::write(f.context.target.join("data.ini"), b"imported B").unwrap();
            } else {
                fs::write(&f.context.target, b"imported B").unwrap();
            }
            f.recycle("newer.ini").unwrap();
            assert!(
                restore_in(&f.context, &receipt, cleanup_info)
                    .unwrap()
                    .restored
            );
            let file = if directory {
                f.context.target.join("data.ini")
            } else {
                f.context.target.clone()
            };
            assert_eq!(fs::read(file).unwrap(), b"original A");
            assert!(f.context.bin.join("$Rnewer.ini").exists());
            assert!(!f.context.bin.join("$Ioriginal.ini").exists());
        }
    }
    #[test]
    fn missing_changed_foreign_and_malformed_receipts_never_restore() {
        let f = Fixture::new(false);
        let receipt = f.capture();
        for mode in [
            "version", "sid", "machine", "target", "name", "hash", "identity", "kind", "digest",
        ] {
            let mut r = receipt.clone();
            match mode {
                "version" => r.version = 2,
                "sid" => r.sid.push('x'),
                "machine" => r.machine.push('x'),
                "target" => r.target.push('x'),
                "name" => r.info_name = "..\\$Ioriginal.ini".into(),
                "hash" => r.info_sha256 = "0".repeat(64),
                "identity" => r.identity.low ^= 1,
                "kind" => r.directory = true,
                _ => r.digest = "0".repeat(64),
            }
            assert!(restore_in(&f.context, &r, cleanup_info).is_err(), "{mode}");
            assert!(missing(&f.context.target).unwrap());
        }
        fs::write(f.context.bin.join("$Roriginal.ini"), b"changed").unwrap();
        assert!(restore_in(&f.context, &receipt, cleanup_info).is_err());
        fs::remove_file(f.context.bin.join("$Ioriginal.ini")).unwrap();
        assert!(restore_in(&f.context, &receipt, cleanup_info).is_err());
    }
    #[test]
    fn metadata_parser_refuses_bad_lengths_versions_encoding_and_wrong_original_paths() {
        let f = Fixture::new(false);
        for version in [1, 2] {
            assert_eq!(
                original_path(&info_bytes(&f.context.target, version)).unwrap(),
                f.context.target
            );
        }
        let valid = info_bytes(&f.context.target, 2);
        for size in 0..28 {
            assert!(original_path(&valid[..size]).is_err());
        }
        let mut broken = valid.clone();
        broken[0] = 3;
        assert!(original_path(&broken).is_err());
        let mut broken = valid.clone();
        broken[24..28].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(original_path(&broken).is_err());
        let mut broken = valid.clone();
        broken[28..30].copy_from_slice(&0xD800u16.to_le_bytes());
        assert!(original_path(&broken).is_err());
        let mut broken = valid.clone();
        let end = broken.len();
        broken[end - 2..].copy_from_slice(&1u16.to_le_bytes());
        assert!(original_path(&broken).is_err());
        assert!(original_path(&vec![0; 65565]).is_err());
        let receipt = f.capture();
        fs::write(
            f.context.bin.join(&receipt.info_name),
            info_bytes(&f.root.join("other.ini"), 2),
        )
        .unwrap();
        assert!(checked(&f.context, &receipt, ATTR).is_err());
    }
    #[test]
    fn capture_failures_do_not_bind_unrelated_or_unchanged_items() {
        let f = Fixture::new(false);
        assert!(capture_in(&f.context, |_| Err("trash failed".into())).is_err());
        assert_eq!(fs::read(&f.context.target).unwrap(), b"original A");
        assert!(capture_in(&f.context, |_| Ok(())).is_err());
        let result = capture_in(&f.context, |_| {
            fs::rename(&f.context.target, f.root.join("retained-original")).unwrap();
            fs::write(f.context.bin.join("$Runrelated.ini"), b"original A").unwrap();
            fs::write(
                f.context.bin.join("$Iunrelated.ini"),
                info_bytes(&f.context.target, 2),
            )
            .unwrap();
            Ok(())
        });
        assert!(result.is_err());
        assert!(f.root.join("retained-original").exists());
    }
    #[test]
    fn nooverwrite_and_cleanup_failure_preserve_correct_original_outcome() {
        let f = Fixture::new(false);
        let receipt = f.capture();
        fs::write(&f.context.target, b"concurrent occupant").unwrap();
        assert!(restore_in(&f.context, &receipt, cleanup_info).is_err());
        assert_eq!(fs::read(&f.context.target).unwrap(), b"concurrent occupant");
        assert!(f.context.bin.join("$Roriginal.ini").exists());
        fs::remove_file(&f.context.target).unwrap();
        assert!(
            restore_in(&f.context, &receipt, |_| Err(
                "metadata cleanup denied".into()
            ))
            .unwrap()
            .restored
        );
        assert_eq!(fs::read(&f.context.target).unwrap(), b"original A");
        assert!(f.context.bin.join("$Ioriginal.ini").exists());
    }
    #[test]
    fn hardlinks_and_size_depth_limits_refuse_before_capture_mutation() {
        let f = Fixture::new(false);
        fs::hard_link(&f.context.target, f.root.join("alias.ini")).unwrap();
        let called = std::cell::Cell::new(false);
        assert!(capture_in(&f.context, |_| {
            called.set(true);
            Ok(())
        })
        .is_err());
        assert!(!called.get());
        fs::remove_file(f.root.join("alias.ini")).unwrap();
        File::options()
            .write(true)
            .open(&f.context.target)
            .unwrap()
            .set_len(MAX_BYTES + 1)
            .unwrap();
        assert!(capture_in(&f.context, |_| {
            called.set(true);
            Ok(())
        })
        .is_err());
        assert!(!called.get());
        let f = Fixture::new(true);
        let mut deep = f.context.target.clone();
        for _ in 0..65 {
            deep.push("d");
            fs::create_dir(&deep).unwrap();
        }
        assert!(capture_in(&f.context, |_| {
            called.set(true);
            Ok(())
        })
        .is_err());
        assert!(!called.get());
    }
    #[test]
    fn unicode_receipt_names_and_expected_kind_are_checked_before_displacement() {
        let mut f = Fixture::new(false);
        let unicode = f.root.join("settings.配置");
        fs::rename(&f.context.target, &unicode).unwrap();
        f.context.target = unicode;
        let receipt = capture_in(&f.context, |_| f.recycle("original.配置")).unwrap();
        assert!(
            restore_in(&f.context, &receipt, cleanup_info)
                .unwrap()
                .restored
        );
        assert_eq!(fs::read(&f.context.target).unwrap(), b"original A");
        let f = Fixture::new(true);
        let called = std::cell::Cell::new(false);
        assert!(capture_expected(&f.context, false, |_| {
            called.set(true);
            Ok(())
        })
        .is_err());
        assert!(!called.get());
        assert!(f.context.target.exists());
    }
    #[test]
    fn reparse_metadata_hardlink_and_global_entry_budget_fail_without_mutation() {
        use std::os::windows::process::CommandExt;
        let f = Fixture::new(true);
        let outside = f.root.join("outside");
        fs::create_dir(&outside).unwrap();
        let link = f.context.target.join("link");
        let output = std::process::Command::new("cmd.exe")
            .args(["/c", "mklink", "/J"])
            .arg(&link)
            .arg(&outside)
            .creation_flags(0x08000000)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let called = std::cell::Cell::new(false);
        assert!(capture_in(&f.context, |_| {
            called.set(true);
            Ok(())
        })
        .is_err());
        assert!(!called.get());
        fs::remove_dir(&link).unwrap();
        for index in 0..MAX_ENTRIES {
            fs::write(f.context.target.join(format!("entry{index}")), b"").unwrap();
        }
        assert!(capture_in(&f.context, |_| {
            called.set(true);
            Ok(())
        })
        .is_err());
        assert!(!called.get());
        let f = Fixture::new(false);
        let receipt = f.capture();
        fs::hard_link(
            f.context.bin.join(&receipt.info_name),
            f.root.join("metadata-alias"),
        )
        .unwrap();
        assert!(restore_in(&f.context, &receipt, cleanup_info).is_err());
        assert!(missing(&f.context.target).unwrap());
    }
}
