//! Bounded observations and same-volume conditional staging for resumable undo.
//! Registry observations are guards/readback, not a CAS against external writers.
use crate::transfer_recovery as files;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::os::windows::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use winreg::{enums::*, RegKey};
#[link(name = "advapi32")]
extern "system" {
    fn RegQueryValueExW(
        key: *mut std::ffi::c_void,
        name: *const u16,
        reserved: *mut u32,
        kind: *mut u32,
        data: *mut u8,
        length: *mut u32,
    ) -> i32;
    fn RegEnumValueW(
        key: *mut std::ffi::c_void,
        index: u32,
        name: *mut u16,
        name_length: *mut u32,
        reserved: *mut u32,
        kind: *mut u32,
        data: *mut u8,
        length: *mut u32,
    ) -> i32;
}
fn raw_value(key: &RegKey, name: &str, remaining: usize) -> Result<Option<(u32, Vec<u8>)>, String> {
    let name: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
    let mut kind = 0;
    let mut length = 0;
    let code = unsafe {
        RegQueryValueExW(
            key.raw_handle().cast(),
            name.as_ptr(),
            std::ptr::null_mut(),
            &mut kind,
            std::ptr::null_mut(),
            &mut length,
        )
    };
    if code == 2 {
        return Ok(None);
    }
    if code != 0 {
        return Err(format!("Registry undo observation failed ({code})"));
    }
    if length as usize > remaining.min(8 * 1024 * 1024) {
        return Err("Undo registry value exceeds byte limit".into());
    }
    let mut bytes = vec![0u8; length as usize];
    let code = unsafe {
        RegQueryValueExW(
            key.raw_handle().cast(),
            name.as_ptr(),
            std::ptr::null_mut(),
            &mut kind,
            bytes.as_mut_ptr(),
            &mut length,
        )
    };
    if code != 0 || length as usize > bytes.len() {
        return Err("Registry changed during bounded undo observation".into());
    }
    bytes.truncate(length as usize);
    Ok(Some((kind, bytes)))
}
fn value_names(key: &RegKey, remaining: usize) -> Result<Vec<String>, String> {
    let mut names = Vec::new();
    let started = Instant::now();
    for index in 0u32.. {
        if started.elapsed() > Duration::from_secs(30) {
            return Err("Undo registry enumeration timed out".into());
        }
        let mut name = [0u16; 16384];
        let mut length = name.len() as u32;
        let code = unsafe {
            RegEnumValueW(
                key.raw_handle().cast(),
                index,
                name.as_mut_ptr(),
                &mut length,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        };
        if code == 259 {
            break;
        }
        if code != 0 || length as usize >= name.len() {
            return Err("Registry value names changed or exceed limits".into());
        }
        if names.len() >= remaining {
            return Err("Undo registry entry limit".into());
        }
        names.push(String::from_utf16(&name[..length as usize]).map_err(|e| e.to_string())?);
    }
    names.sort();
    Ok(names)
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct State {
    version: u32,
    exists: bool,
    digest: Option<String>,
    identity: Option<files::Identity>,
}
impl State {
    fn absent() -> Self {
        Self {
            version: 1,
            exists: false,
            digest: None,
            identity: None,
        }
    }
    fn valid(&self, filesystem: bool) -> bool {
        self.version == 1
            && if self.exists {
                self.digest
                    .as_ref()
                    .is_some_and(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()))
                    && self.identity.is_some() == filesystem
            } else {
                self.digest.is_none() && self.identity.is_none()
            }
    }
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Target {
    pub kind: String,
    pub path: String,
    pub name: Option<String>,
}
fn filesystem(target: &Target) -> Result<bool, String> {
    match target.kind.as_str() {
        "file" | "dir" if target.name.is_none() => Ok(true),
        "key" if target.name.is_none() => Ok(false),
        "value"
            if target
                .name
                .as_ref()
                .is_some_and(|n| n.len() <= 16383 && !n.contains('\0')) =>
        {
            Ok(false)
        }
        _ => Err("Invalid undo target kind/name".into()),
    }
}
fn file_state(path: &Path, directory: bool) -> Result<State, String> {
    if files::missing(path)? {
        return Ok(State::absent());
    }
    let (identity, digest) = files::snapshot(path, directory)?;
    Ok(State {
        version: 1,
        exists: true,
        digest: Some(digest),
        identity: Some(identity),
    })
}
fn registry(path: &str) -> Result<(RegKey, String), String> {
    if path.len() > 4096 || path.chars().any(char::is_control) || path.contains('/') {
        return Err("Invalid registry undo path".into());
    }
    let (hive, tail) = path
        .split_once('\\')
        .ok_or("Registry undo path has no key")?;
    if tail
        .split('\\')
        .any(|s| s.is_empty() || s == "." || s == "..")
    {
        return Err("Invalid registry undo components".into());
    }
    let hive = match hive.to_ascii_uppercase().as_str() {
        "HKCU" | "HKEY_CURRENT_USER" => HKEY_CURRENT_USER,
        "HKLM" | "HKEY_LOCAL_MACHINE" => HKEY_LOCAL_MACHINE,
        "HKCR" | "HKEY_CLASSES_ROOT" => HKEY_CLASSES_ROOT,
        "HKU" | "HKEY_USERS" => HKEY_USERS,
        "HKCC" | "HKEY_CURRENT_CONFIG" => HKEY_CURRENT_CONFIG,
        _ => return Err("Invalid registry undo hive".into()),
    };
    Ok((RegKey::predef(hive), tail.to_owned()))
}
fn optional_key(root: &RegKey, path: &str) -> Result<Option<RegKey>, String> {
    match root.open_subkey_with_flags(path, KEY_READ | KEY_WOW64_64KEY) {
        Ok(key) => Ok(Some(key)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}
fn finish(hash: Sha256) -> String {
    hash.finalize().iter().map(|b| format!("{b:02x}")).collect()
}
fn add(hash: &mut Sha256, bytes: &[u8]) {
    hash.update((bytes.len() as u64).to_le_bytes());
    hash.update(bytes);
}
fn raw_hash(hash: &mut Sha256, name: &str, kind: u32, bytes: &[u8]) {
    add(hash, name.as_bytes());
    hash.update(kind.to_le_bytes());
    add(hash, bytes);
}
fn registry_state(target: &Target) -> Result<State, String> {
    let (root, path) = registry(&target.path)?;
    let Some(key) = optional_key(&root, &path)? else {
        return Ok(State::absent());
    };
    let mut hash = Sha256::new();
    if target.kind == "value" {
        let name = target.name.as_deref().ok_or("Missing undo value name")?;
        match raw_value(&key, name, 8 * 1024 * 1024)? {
            Some((kind, bytes)) => raw_hash(&mut hash, name, kind, &bytes),
            None => return Ok(State::absent()),
        }
    } else {
        let started = Instant::now();
        let mut count = 0usize;
        let mut bytes = 0usize;
        let mut stack = vec![(String::new(), key, 0usize)];
        while let Some((relative, key, depth)) = stack.pop() {
            count += 1;
            if count > 10000 || depth > 64 || started.elapsed() > Duration::from_secs(30) {
                return Err("Undo registry tree exceeds limits".into());
            }
            add(&mut hash, relative.as_bytes());
            let names = value_names(&key, 10000usize.saturating_sub(count + stack.len()))?;
            count += names.len();
            hash.update((names.len() as u64).to_le_bytes());
            for name in names {
                let (kind, value) =
                    raw_value(&key, &name, (8 * 1024 * 1024usize).saturating_sub(bytes))?
                        .ok_or("Registry changed during undo observation")?;
                bytes += value.len();
                if started.elapsed() > Duration::from_secs(30) {
                    return Err("Undo registry time limit".into());
                }
                raw_hash(&mut hash, &name, kind, &value);
            }
            let mut children = Vec::new();
            for name in key.enum_keys() {
                if count + stack.len() + children.len() >= 10000
                    || started.elapsed() > Duration::from_secs(30)
                {
                    return Err("Undo registry entry/time limit".into());
                }
                children.push(name.map_err(|e| e.to_string())?);
            }
            children.sort();
            hash.update((children.len() as u64).to_le_bytes());
            for name in children.into_iter().rev() {
                let child =
                    optional_key(&key, &name)?.ok_or("Registry changed during undo observation")?;
                stack.push((format!("{relative}\\{name}"), child, depth + 1));
            }
        }
    }
    Ok(State {
        version: 1,
        exists: true,
        digest: Some(finish(hash)),
        identity: None,
    })
}
pub fn observe(target: &Target) -> Result<State, String> {
    if filesystem(target)? {
        file_state(&files::canonical(&target.path)?, target.kind == "dir")
    } else {
        registry_state(target)
    }
}

struct Lease {
    id: String,
    _file: File,
    parents: files::Parents,
}
static LEASES: OnceLock<Mutex<HashMap<String, Lease>>> = OnceLock::new();
fn leases() -> &'static Mutex<HashMap<String, Lease>> {
    LEASES.get_or_init(|| Mutex::new(HashMap::new()))
}
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 32
        && !id.starts_with('0')
        && id.bytes().all(|b| b.is_ascii_digit())
}
#[derive(Serialize)]
pub struct Reservation {
    id: String,
    token: String,
}
fn reserve_at(root: &Path, start: u64) -> Result<Reservation, String> {
    crate::security::checked_path(root.to_str().ok_or("Invalid transfer root")?)?;
    std::fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let root = files::canonical(
        root.join("reservation")
            .to_str()
            .ok_or("Invalid reservation path")?,
    )?
    .parent()
    .ok_or("Missing transfer root")?
    .to_path_buf();
    let parents = files::Parents::open(&root.join("reservation"))?;
    for offset in 0..64u64 {
        let id = start
            .checked_add(offset)
            .ok_or("Restore id overflow")?
            .to_string();
        if !valid_id(&id) {
            return Err("Invalid restore clock".into());
        }
        match std::fs::create_dir(root.join(&id)) {
            Ok(()) => {
                parents.verify()?;
                let token = acquire(&root, &id)?;
                return Ok(Reservation { id, token });
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.to_string()),
        }
    }
    Err("Restore id collision limit reached; prior journals were retained".into())
}
pub fn reserve(root: &Path) -> Result<Reservation, String> {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis();
    reserve_at(root, u64::try_from(stamp).map_err(|e| e.to_string())?)
}
pub fn acquire(root: &Path, id: &str) -> Result<String, String> {
    if !valid_id(id) {
        return Err("Invalid transfer undo id".into());
    }
    let path = files::canonical(
        root.join(id)
            .join("undo.lock")
            .to_str()
            .ok_or("Invalid lock path")?,
    )?;
    let parents = files::Parents::open(&path)?;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .share_mode(0)
        .custom_flags(0x00200000)
        .open(&path)
        .map_err(|e| format!("Undo journal is busy or cannot be locked: {e}"))?;
    files::identity(&file, false)?;
    files::verify_path(&file, &path)?;
    parents.verify()?;
    let token = crate::broker::random_id()?;
    leases()
        .lock()
        .map_err(|_| "Undo lease state unavailable")?
        .insert(
            token.clone(),
            Lease {
                id: id.to_owned(),
                _file: file,
                parents,
            },
        );
    Ok(token)
}
pub fn release(token: &str) -> Result<(), String> {
    leases()
        .lock()
        .map_err(|_| "Undo lease state unavailable")?
        .remove(token)
        .ok_or("Unknown undo lease")?;
    Ok(())
}
fn require(token: &str, id: &str) -> Result<(), String> {
    let leases = leases()
        .lock()
        .map_err(|_| "Undo lease state unavailable")?;
    let held = leases.get(token).ok_or("Unknown undo lease")?;
    if held.id != id {
        return Err("Undo lease belongs to another journal".into());
    }
    held.parents.verify()
}
fn stage_path(target: &Path, id: &str, step: u32) -> Result<PathBuf, String> {
    if !valid_id(id) || step >= 10000 {
        return Err("Invalid undo staging identity".into());
    }
    Ok(target
        .parent()
        .ok_or("Undo target has no parent")?
        .join(format!(".purgeon-undo-{id}-{step}")))
}
fn stage_in(
    target: &Target,
    id: &str,
    step: u32,
    expected: &State,
    apply: bool,
) -> Result<bool, String> {
    if !filesystem(target)? || !expected.valid(true) || !expected.exists {
        return Err("Invalid undo staging state".into());
    }
    let path = files::canonical(&target.path)?;
    let stage = stage_path(&path, id, step)?;
    if path == stage {
        return Err("Undo target collides with its staging path".into());
    }
    let directory = target.kind == "dir";
    let parents = files::Parents::open(&path)?;
    let current = file_state(&path, directory)?;
    let saved = file_state(&stage, directory)?;
    if !current.exists && saved == *expected {
        return Ok(true);
    }
    if current != *expected || saved.exists {
        return Err("Undo conflict: target or retained staging copy changed".into());
    }
    if !apply {
        return Ok(false);
    }
    let held = files::open(
        &path,
        directory,
        if directory {
            0x80 | 0x10000
        } else {
            0x80000000 | 0x10000
        },
        1,
    )?;
    let (identity, digest, nodes) = files::snapshot_pinned(&path, directory, true)?;
    if files::identity(&held, directory)?
        != expected
            .identity
            .clone()
            .ok_or("Missing undo file identity")?
        || identity
            != expected
                .identity
                .clone()
                .ok_or("Missing undo file identity")?
        || Some(digest) != expected.digest
    {
        return Err("Undo target changed before staging".into());
    }
    // Windows refuses directory renames while descendant handles are open.
    // The exact root remains held; child membership/content is checked again
    // after the move. A concurrent child writer can require manual recovery,
    // but the whole staged copy is retained and is never blindly rolled back.
    if directory {
        drop(nodes);
    }
    parents.verify()?;
    files::rename_no_replace(&held, &stage)?;
    parents.verify()?;
    files::verify_path(&held, &stage)?;
    if !files::missing(&path)? || file_state(&stage, directory)? != *expected {
        return Err("Undo staging outcome needs review".into());
    }
    Ok(true)
}
pub fn stage(
    token: &str,
    id: &str,
    step: u32,
    target: &Target,
    expected: &State,
    apply: bool,
) -> Result<bool, String> {
    require(token, id)?;
    stage_in(target, id, step, expected, apply)
}
pub fn staged(
    token: &str,
    id: &str,
    step: u32,
    target: &Target,
    expected: &State,
) -> Result<bool, String> {
    require(token, id)?;
    if !filesystem(target)? || !expected.valid(true) || !expected.exists {
        return Err("Invalid staged undo proof".into());
    }
    let target_path = files::canonical(&target.path)?;
    let saved = stage_path(&target_path, id, step)?;
    let parents = files::Parents::open(&saved)?;
    let matched = file_state(&saved, target.kind == "dir")? == *expected;
    parents.verify()?;
    Ok(matched)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    #[test]
    fn states_and_raw_value_hashes_are_strict_and_type_sensitive() {
        assert!(State::absent().valid(true));
        assert!(State::absent().valid(false));
        let mut one = Sha256::new();
        let mut two = Sha256::new();
        raw_hash(&mut one, "x", REG_SZ as u32, &[1, 2]);
        raw_hash(&mut two, "x", REG_BINARY as u32, &[1, 2]);
        assert_ne!(finish(one), finish(two));
    }
    #[test]
    fn same_volume_staging_retains_exact_file_and_reconciles_without_replay() {
        let root = std::env::temp_dir().join(format!(
            "purgeon-undo-{}",
            crate::broker::random_id().unwrap()
        ));
        fs::create_dir(&root).unwrap();
        let path = root.join("data.ini");
        fs::write(&path, b"imported").unwrap();
        let target = Target {
            kind: "file".into(),
            path: path.to_str().unwrap().into(),
            name: None,
        };
        let expected = observe(&target).unwrap();
        assert!(!stage_in(&target, "123", 0, &expected, false).unwrap());
        assert!(stage_in(&target, "123", 0, &expected, true).unwrap());
        assert!(stage_in(&target, "123", 0, &expected, false).unwrap());
        assert_eq!(
            fs::read(root.join(".purgeon-undo-123-0")).unwrap(),
            b"imported"
        );
        fs::write(&path, b"new user data").unwrap();
        assert!(stage_in(&target, "123", 0, &expected, true).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"new user data");
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn journal_lock_is_exclusive_reusable_and_bound_to_id() {
        let root = std::env::temp_dir().join(format!(
            "purgeon-lock-{}",
            crate::broker::random_id().unwrap()
        ));
        fs::create_dir_all(root.join("123")).unwrap();
        let token = acquire(&root, "123").unwrap();
        assert!(acquire(&root, "123").is_err());
        assert!(require(&token, "456").is_err());
        release(&token).unwrap();
        let token = acquire(&root, "123").unwrap();
        release(&token).unwrap();
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn atomic_restore_reservation_preserves_existing_journals_and_same_clock_collisions() {
        let root = std::env::temp_dir().join(format!(
            "purgeon-reserve-{}",
            crate::broker::random_id().unwrap()
        ));
        fs::create_dir_all(root.join("123")).unwrap();
        fs::write(root.join("123/restore.json"), b"existing journal").unwrap();
        let first = reserve_at(&root, 123).unwrap();
        assert_eq!(first.id, "124");
        let second = reserve_at(&root, 123).unwrap();
        assert_eq!(second.id, "125");
        assert_eq!(
            fs::read(root.join("123/restore.json")).unwrap(),
            b"existing journal"
        );
        assert!(acquire(&root, &first.id).is_err());
        release(&first.token).unwrap();
        release(&second.token).unwrap();
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn directory_staging_preserves_tree_and_refuses_changed_content() {
        let root = std::env::temp_dir().join(format!(
            "purgeon-undo-dir-{}",
            crate::broker::random_id().unwrap()
        ));
        let path = root.join("settings");
        fs::create_dir_all(path.join("nested")).unwrap();
        fs::write(path.join("nested/value.ini"), b"original").unwrap();
        let target = Target {
            kind: "dir".into(),
            path: path.to_str().unwrap().into(),
            name: None,
        };
        let expected = observe(&target).unwrap();
        fs::write(path.join("nested/value.ini"), b"changed").unwrap();
        assert!(stage_in(&target, "123", 0, &expected, true).is_err());
        fs::write(path.join("nested/value.ini"), b"original").unwrap();
        assert!(stage_in(&target, "123", 0, &expected, true).unwrap());
        assert_eq!(
            fs::read(root.join(".purgeon-undo-123-0/nested/value.ini")).unwrap(),
            b"original"
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn journal_lock_rejects_another_process_and_releases_on_process_exit() {
        const ENV: &str = "PURGEON_UNDO_LOCK_TEST_ROOT";
        if let Ok(root) = std::env::var(ENV) {
            let expected = std::env::var("PURGEON_UNDO_LOCK_TEST_MODE").unwrap();
            let result = acquire(Path::new(&root), "123");
            if expected == "blocked" {
                assert!(result.is_err());
            } else {
                assert!(result.is_ok()); /* Deliberately held until process exit. */
            }
            return;
        }
        let root = std::env::temp_dir().join(format!(
            "purgeon-undo-process-{}",
            crate::broker::random_id().unwrap()
        ));
        fs::create_dir_all(root.join("123")).unwrap();
        let run = |mode: &str| {
            std::process::Command::new(std::env::current_exe().unwrap()).args(["--exact", "transfer_undo::tests::journal_lock_rejects_another_process_and_releases_on_process_exit", "--nocapture"]).env(ENV, &root).env("PURGEON_UNDO_LOCK_TEST_MODE", mode).output().unwrap()
        };
        let token = acquire(&root, "123").unwrap();
        let child = run("blocked");
        assert!(
            child.status.success(),
            "{}",
            String::from_utf8_lossy(&child.stderr)
        );
        release(&token).unwrap();
        let child = run("held");
        assert!(
            child.status.success(),
            "{}",
            String::from_utf8_lossy(&child.stderr)
        );
        let token = acquire(&root, "123").unwrap();
        release(&token).unwrap();
        fs::remove_dir_all(root).unwrap();
    }
}
