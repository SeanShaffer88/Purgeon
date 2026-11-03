//! Updater-only reservations. Pins cover verification through synchronous process
//! creation, not installer lifetime or later self-extracted installer payloads.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    ffi::c_void,
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom},
    os::windows::{fs::OpenOptionsExt, io::AsRawHandle},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};
const ATTR: u32 = 0x80;
const DELETE: u32 = 0x10000;
const OPEN_REPARSE: u32 = 0x00200000;
const DIRECTORY: u32 = 0x02000000;
const TTL: Duration = Duration::from_secs(900);
const MAX_BYTES: u64 = 512 * 1024 * 1024;
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Expected {
    sha256: String,
    size: u64,
}
impl Expected {
    fn validate(&self) -> Result<(), String> {
        if self.sha256.len() != 64
            || !self.sha256.bytes().all(|b| b.is_ascii_hexdigit())
            || self.size > MAX_BYTES
        {
            return Err("Invalid update digest or size".into());
        }
        Ok(())
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Download {
    id: String,
    path: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Cancelled {
    removed: bool,
    detail: String,
}
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
struct Identity {
    volume: u32,
    index_high: u32,
    index_low: u32,
}
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
    fn CloseHandle(handle: *mut c_void) -> i32;
    fn GetProcessId(handle: *mut c_void) -> u32;
    fn QueryFullProcessImageNameW(
        handle: *mut c_void,
        flags: u32,
        path: *mut u16,
        length: *mut u32,
    ) -> i32;
}
fn error() -> String {
    std::io::Error::last_os_error().to_string()
}
fn info(file: &File, directory: bool) -> Result<Identity, String> {
    let mut v: Information = unsafe { std::mem::zeroed() };
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut v) } == 0 {
        return Err(error());
    }
    if v.attributes & 0x400 != 0
        || (v.attributes & 0x10 != 0) != directory
        || (!directory && v.links != 1)
    {
        return Err("Update path must not be a reparse point or hardlink".into());
    }
    Ok(Identity {
        volume: v.volume,
        index_high: v.index_high,
        index_low: v.index_low,
    })
}
fn handle_path(file: &File) -> Result<PathBuf, String> {
    let mut buffer = vec![0u16; 32768];
    let n = unsafe {
        GetFinalPathNameByHandleW(
            file.as_raw_handle(),
            buffer.as_mut_ptr(),
            buffer.len() as u32,
            0,
        )
    } as usize;
    if n == 0 || n >= buffer.len() {
        return Err("Cannot resolve update handle".into());
    }
    let p = String::from_utf16(&buffer[..n]).map_err(|e| e.to_string())?;
    let p = p.trim_start_matches("\\\\?\\");
    if p.len() < 3
        || p.as_bytes()[1] != b':'
        || p.as_bytes()[2] != b'\\'
        || !p.as_bytes()[0].is_ascii_alphabetic()
        || p[2..].contains(':')
    {
        return Err("Update path must be a local drive path without alternate streams".into());
    }
    Ok(PathBuf::from(p))
}
fn same_path(a: &Path, b: &Path) -> bool {
    a.as_os_str()
        .to_string_lossy()
        .eq_ignore_ascii_case(&b.as_os_str().to_string_lossy())
}
struct Pin {
    path: PathBuf,
    file: File,
    identity: Identity,
}
impl Pin {
    fn open(path: &Path, directory: bool, access: u32, sharing: u32) -> Result<Self, String> {
        let file = OpenOptions::new()
            .access_mode(access)
            .share_mode(sharing)
            .custom_flags(OPEN_REPARSE | if directory { DIRECTORY } else { 0 })
            .open(path)
            .map_err(|e| e.to_string())?;
        let identity = info(&file, directory)?;
        let resolved = handle_path(&file)?;
        if !same_path(&resolved, path) {
            return Err("Update path changed or uses an unresolved alias".into());
        }
        Ok(Self {
            path: path.to_path_buf(),
            file,
            identity,
        })
    }
    fn verify(&self, directory: bool) -> Result<(), String> {
        if info(&self.file, directory)? != self.identity
            || !same_path(&handle_path(&self.file)?, &self.path)
        {
            return Err("Update identity changed".into());
        }
        Ok(())
    }
}
fn canonical_temp(root: &Path) -> Result<PathBuf, String> {
    // Inspect the supplied spelling first: canonicalization must not hide a junction.
    for p in root.ancestors() {
        let m = fs::symlink_metadata(p).map_err(|e| e.to_string())?;
        use std::os::windows::fs::MetadataExt;
        if m.file_attributes() & 0x400 != 0 {
            return Err("Update temporary path crosses a reparse point".into());
        }
    }
    let canonical = fs::canonicalize(root).map_err(|e| e.to_string())?;
    let text = canonical
        .to_str()
        .ok_or("Invalid update temporary path")?
        .trim_start_matches("\\\\?\\");
    if text.len() < 3
        || text.as_bytes()[1] != b':'
        || text.as_bytes()[2] != b'\\'
        || text[2..].contains(':')
    {
        return Err("Update temporary path must be local".into());
    }
    Ok(PathBuf::from(text))
}
struct Reservation {
    expected: Expected,
    path: PathBuf,
    directory: PathBuf,
    pins: Vec<Pin>,
    placeholder: Option<Pin>,
    created: Instant,
}
impl Reservation {
    fn create(root: &Path, expected: Expected) -> Result<Self, String> {
        expected.validate()?;
        let root = canonical_temp(root)?;
        let mut pins = Vec::new();
        for p in root.ancestors().collect::<Vec<_>>().into_iter().rev() {
            pins.push(Pin::open(p, true, ATTR, 3)?);
        }
        let directory = root.join(format!("Purgeon-Update-{}", crate::broker::random_id()?));
        fs::create_dir(&directory).map_err(|e| e.to_string())?;
        let retained = directory.clone();
        let result: Result<Self, String> = (|| {
            pins.push(Pin::open(&directory, true, ATTR, 3)?);
            let path = directory.join("Purgeon-Setup-x64.exe");
            // Attribute-only access permits an OutFile writer even with FileShare.None,
            // while omitting delete sharing prevents replacement of this file identity.
            let file = OpenOptions::new()
                .write(true)
                .access_mode(ATTR)
                .create_new(true)
                .share_mode(3)
                .custom_flags(OPEN_REPARSE)
                .open(&path)
                .map_err(|e| e.to_string())?;
            let placeholder = Pin {
                identity: info(&file, false)?,
                path: path.clone(),
                file,
            };
            placeholder.verify(false)?;
            Ok(Self {
                expected,
                path,
                directory,
                pins,
                placeholder: Some(placeholder),
                created: Instant::now(),
            })
        })();
        result.map_err(|e| {
            format!(
                "Native update reservation retained at {}: {e}",
                retained.display()
            )
        })
    }
    fn verify(&self) -> Result<(), String> {
        if self.created.elapsed() > TTL {
            return Err("Update reservation expired; download is retained for review".into());
        }
        for pin in &self.pins {
            pin.verify(true)?;
        }
        self.placeholder
            .as_ref()
            .ok_or("Update reservation was consumed")?
            .verify(false)
    }
    fn verified_launch(
        &mut self,
        launch: impl FnOnce(&Path) -> Result<(), String>,
    ) -> Result<(), String> {
        self.verify()?;
        let mut held = Pin::open(&self.path, false, 0x80000000, 1)?;
        if held.identity
            != self
                .placeholder
                .as_ref()
                .ok_or("Update reservation missing")?
                .identity
        {
            return Err("Update file was replaced".into());
        }
        let length = held.file.metadata().map_err(|e| e.to_string())?.len();
        if length == 0
            || length > MAX_BYTES
            || self.expected.size > 0 && length != self.expected.size
        {
            return Err("Update download size does not match the expected installer".into());
        }
        let mut hasher = Sha256::new();
        let mut buffer = [0u8; 65536];
        let deadline = Instant::now() + Duration::from_secs(120);
        loop {
            if Instant::now() > deadline {
                return Err("Update verification timed out".into());
            }
            let n = held.file.read(&mut buffer).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            hasher.update(&buffer[..n]);
        }
        let digest: String = hasher
            .finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        if !digest.eq_ignore_ascii_case(&self.expected.sha256) {
            return Err("Update SHA-256 does not match the expected installer".into());
        }
        held.file
            .seek(SeekFrom::Start(0))
            .map_err(|e| e.to_string())?;
        held.verify(false)?;
        self.verify()?;
        // All file/directory pins remain alive inside launch, including UAC and
        // synchronous real-process-handle acceptance. They release after this boundary.
        launch(&self.path)?;
        held.verify(false)?;
        Ok(())
    }
    fn cancel(mut self) -> Cancelled {
        let result: Result<(), String> = (|| {
            self.verify()?;
            let identity = self
                .placeholder
                .take()
                .ok_or("Update reservation missing")?
                .identity;
            let file = Pin::open(&self.path, false, ATTR | DELETE, 1)?;
            if file.identity != identity {
                return Err("Update cleanup identity changed".into());
            }
            mark_delete(&file.file)?;
            drop(file);
            let own = self.pins.pop().ok_or("Update directory pin missing")?;
            let identity = own.identity;
            drop(own);
            let directory = Pin::open(&self.directory, true, ATTR | DELETE, 3)?;
            if directory.identity != identity {
                return Err("Update cleanup directory changed".into());
            }
            mark_delete(&directory.file)?;
            Ok(())
        })();
        match result {
            Ok(()) => Cancelled {
                removed: true,
                detail: "Native-owned update reservation removed".into(),
            },
            Err(e) => Cancelled {
                removed: false,
                detail: format!(
                    "Update reservation retained at {}: {e}",
                    self.directory.display()
                ),
            },
        }
    }
}
fn mark_delete(file: &File) -> Result<(), String> {
    let delete = 1u8;
    if unsafe {
        SetFileInformationByHandle(file.as_raw_handle(), 4, (&delete as *const u8).cast(), 1)
    } == 0
    {
        return Err(error());
    }
    Ok(())
}
fn manager() -> &'static Mutex<HashMap<String, Reservation>> {
    static STATE: OnceLock<Mutex<HashMap<String, Reservation>>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(HashMap::new()))
}
pub fn reserve(expected: Expected) -> Result<Download, String> {
    if portable_install(&std::env::current_exe().map_err(|e| e.to_string())?) {
        return Err("Portable copies cannot launch an installed update".into());
    }
    expected.validate()?;
    let mut state = manager().lock().map_err(|e| e.to_string())?;
    state.retain(|_, value| value.created.elapsed() <= TTL);
    if state.len() >= 4 {
        return Err("Too many pending update downloads".into());
    }
    let reservation = Reservation::create(&std::env::temp_dir(), expected)?;
    let id = crate::broker::random_id()?;
    let path = reservation
        .path
        .to_str()
        .ok_or("Invalid update path")?
        .to_owned();
    state.insert(id.clone(), reservation);
    Ok(Download { id, path })
}
fn portable_install(exe: &Path) -> bool {
    exe.file_stem()
        .is_some_and(|name| name.to_string_lossy().to_lowercase().contains("portable"))
        || exe
            .parent()
            .is_some_and(|parent| parent.join("portable").exists())
}
fn consume(id: &str) -> Result<Reservation, String> {
    if id.len() != 32 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("Invalid update reservation".into());
    }
    manager()
        .lock()
        .map_err(|e| e.to_string())?
        .remove(id)
        .ok_or("Update reservation is unknown or already consumed".into())
}
pub fn cancel(id: &str) -> Result<Cancelled, String> {
    Ok(consume(id)?.cancel())
}
pub fn launch(id: &str) -> Result<(), String> {
    let mut reservation = consume(id)?;
    reservation.verified_launch(shell_launch).map_err(|e| {
        format!(
            "Verified update launch failed; download retained at {}: {e}",
            reservation.path.display()
        )
    })
}
#[repr(C)]
struct ShellInfo {
    size: u32,
    mask: u32,
    window: *mut c_void,
    verb: *const u16,
    file: *const u16,
    parameters: *const u16,
    directory: *const u16,
    show: i32,
    instance: *mut c_void,
    item_list: *mut c_void,
    class: *const u16,
    class_key: *mut c_void,
    hot_key: u32,
    icon: *mut c_void,
    process: *mut c_void,
}
#[link(name = "shell32")]
extern "system" {
    fn ShellExecuteExW(info: *mut ShellInfo) -> i32;
}
fn wide(value: &std::ffi::OsStr) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    value.encode_wide().chain(Some(0)).collect()
}
struct Process(*mut c_void);
impl Drop for Process {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { CloseHandle(self.0) };
        }
    }
}
fn direct_command(command: &str, isolated: Option<&str>) -> Result<(), String> {
    let command = command.trim();
    if ![r#""%1""#, r#""%1" %*"#].contains(&command)
        || isolated.is_some_and(|value| value.trim() != command)
    {
        return Err(
            "Machine executable elevation command is not a supported direct file launch".into(),
        );
    }
    Ok(())
}
fn class_handlers(values: &[String], children: &[String], command: bool) -> Result<(), String> {
    let forbidden = |name: &str| {
        let n = name.to_ascii_lowercase();
        n.contains("delegateexecute")
            || n.contains("explorercommandhandler")
            || n.contains("droptarget")
            || n.contains("ddeexec")
            || n.contains("commandstatehandler")
    };
    if values.iter().chain(children).any(|name| forbidden(name))
        || command
            && (!children.is_empty()
                || values
                    .iter()
                    .any(|name| !name.is_empty() && !name.eq_ignore_ascii_case("IsolatedCommand")))
    {
        return Err("Machine executable class uses an unsupported handler".into());
    }
    Ok(())
}
fn machine_executable_class() -> Result<winreg::RegKey, String> {
    use winreg::{
        enums::{HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_64KEY, REG_EXPAND_SZ, REG_SZ},
        RegKey,
    };
    fn names(key: &RegKey) -> Result<(Vec<String>, Vec<String>), String> {
        let values = key
            .enum_values()
            .take(65)
            .map(|r| r.map(|(name, _)| name).map_err(|e| e.to_string()))
            .collect::<Result<Vec<_>, _>>()?;
        let children = key
            .enum_keys()
            .take(65)
            .map(|r| r.map_err(|e| e.to_string()))
            .collect::<Result<Vec<_>, _>>()?;
        if values.len() > 64 || children.len() > 64 {
            return Err("Machine executable class exceeds bounds".into());
        }
        Ok((values, children))
    }
    fn text(key: &RegKey, name: &str) -> Result<String, String> {
        let raw = key.get_raw_value(name).map_err(|e| e.to_string())?;
        if ![REG_SZ, REG_EXPAND_SZ].contains(&raw.vtype) {
            return Err("Unsupported executable class command type".into());
        }
        key.get_value(name).map_err(|e| e.to_string())
    }
    let flags = KEY_READ | KEY_WOW64_64KEY;
    let class = RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey_with_flags(r"Software\Classes\exefile", flags)
        .map_err(|e| e.to_string())?;
    let shell = class
        .open_subkey_with_flags("shell", flags)
        .map_err(|e| e.to_string())?;
    let runas = shell
        .open_subkey_with_flags("runas", flags)
        .map_err(|e| e.to_string())?;
    let command = runas
        .open_subkey_with_flags("command", flags)
        .map_err(|e| e.to_string())?;
    for key in [&class, &shell, &runas] {
        let (v, c) = names(key)?;
        class_handlers(&v, &c, false)?;
    }
    let (v, c) = names(&runas)?;
    if c.iter().any(|name| !name.eq_ignore_ascii_case("command"))
        || v.iter().any(|name| {
            ![
                "",
                "HasLUAShield",
                "Extended",
                "NoWorkingDirectory",
                "Icon",
                "MUIVerb",
                "CommandFlags",
            ]
            .iter()
            .any(|allowed| name.eq_ignore_ascii_case(allowed))
        })
    {
        return Err("Machine executable elevation uses a custom handler".into());
    }
    let (v, c) = names(&command)?;
    class_handlers(&v, &c, true)?;
    let template = text(&command, "")?;
    let isolated = match command.get_raw_value("IsolatedCommand") {
        Ok(_) => Some(text(&command, "IsolatedCommand")?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e.to_string()),
    };
    direct_command(&template, isolated.as_deref())?;
    Ok(class)
}
fn shell_launch(path: &Path) -> Result<(), String> {
    let class = machine_executable_class()?;
    let file = wide(path.as_os_str());
    let verb = wide(std::ffi::OsStr::new("runas"));
    let directory = wide(path.parent().ok_or("Update parent missing")?.as_os_str());
    let mut info: ShellInfo = unsafe { std::mem::zeroed() };
    info.size = std::mem::size_of::<ShellInfo>() as u32;
    info.mask = 0x3 | 0x40 | 0x100;
    info.verb = verb.as_ptr();
    info.file = file.as_ptr();
    info.class_key = class.raw_handle().cast();
    info.directory = directory.as_ptr();
    info.show = 1;
    let result = unsafe { ShellExecuteExW(&mut info) };
    let process = Process(info.process);
    if result == 0 {
        return Err(error());
    }
    if process.0.is_null() || unsafe { GetProcessId(process.0) } == 0 {
        return Err(
            "Windows did not return an actual installer process; launch outcome requires review"
                .into(),
        );
    }
    let mut image = vec![0u16; 32768];
    let mut length = image.len() as u32;
    if unsafe { QueryFullProcessImageNameW(process.0, 0, image.as_mut_ptr(), &mut length) } == 0 {
        return Err(format!(
            "Installer process may have started; image identity could not be checked: {}",
            error()
        ));
    }
    let image =
        PathBuf::from(String::from_utf16(&image[..length as usize]).map_err(|e| e.to_string())?);
    if !same_path(&image, path) {
        return Err(
            "Installer process may have started with an unexpected image; review the launch".into(),
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    const DATA: &[u8] = b"neutral update fixture bytes";
    fn expected() -> Expected {
        Expected {
            sha256: Sha256::digest(DATA)
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect(),
            size: DATA.len() as u64,
        }
    }
    fn scratch() -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "purgeon-updater-test-{}",
            crate::broker::random_id().unwrap()
        ));
        fs::create_dir(&root).unwrap();
        root
    }
    fn reservation(root: &Path) -> Reservation {
        let r = Reservation::create(root, expected()).unwrap();
        fs::write(&r.path, DATA).unwrap();
        r
    }
    fn clear(r: Reservation, root: &Path) {
        let result = r.cancel();
        assert!(result.removed, "{}", result.detail);
        fs::remove_dir(root).unwrap();
    }
    #[test]
    fn closed_metadata_and_opaque_one_use_requests() {
        for source in [
            r#"{"sha256":"bad","size":1}"#,
            r#"{"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","size":1073741825}"#,
        ] {
            assert!(serde_json::from_str::<Expected>(source)
                .unwrap()
                .validate()
                .is_err());
        }
        assert!(serde_json::from_str::<Expected>(
            r#"{"sha256":"a","size":1,"path":"arbitrary.exe"}"#
        )
        .is_err());
        assert!(consume("arbitrary-path").is_err());
        let root = scratch();
        let r = reservation(&root);
        let id = crate::broker::random_id().unwrap();
        manager().lock().unwrap().insert(id.clone(), r);
        let r = consume(&id).unwrap();
        assert!(consume(&id).is_err());
        clear(r, &root);
    }
    #[test]
    fn verified_callback_holds_exact_file_and_all_ancestors_through_creation() {
        let root = scratch();
        let mut r = reservation(&root);
        let path = r.path.clone();
        let directory = r.directory.clone();
        r.verified_launch(|actual| {
            assert_eq!(actual, path);
            assert!(OpenOptions::new().write(true).open(actual).is_err());
            assert!(fs::remove_file(actual).is_err());
            assert!(fs::rename(actual, actual.with_extension("swapped")).is_err());
            assert!(fs::rename(&directory, directory.with_extension("swapped")).is_err());
            assert!(fs::rename(&root, root.with_extension("swapped")).is_err());
            Ok(())
        })
        .unwrap();
        fs::write(&path, DATA).unwrap();
        clear(r, &root);
    }
    #[test]
    fn wrong_hash_size_active_writer_and_expiry_never_invoke_launch() {
        for case in 0..4 {
            let root = scratch();
            let mut r = reservation(&root);
            let writer = if case == 2 {
                Some(
                    OpenOptions::new()
                        .write(true)
                        .share_mode(3)
                        .open(&r.path)
                        .unwrap(),
                )
            } else {
                None
            };
            match case {
                0 => r.expected.sha256 = "0".repeat(64),
                1 => r.expected.size += 1,
                3 => r.created = Instant::now() - TTL - Duration::from_secs(1),
                _ => {}
            }
            let mut called = false;
            assert!(r
                .verified_launch(|_| {
                    called = true;
                    Ok(())
                })
                .is_err());
            assert!(!called);
            drop(writer);
            r.created = Instant::now();
            clear(r, &root);
        }
    }
    #[test]
    fn late_cancel_or_spawn_error_is_reported_without_success_or_unchecked_cleanup() {
        let root = scratch();
        let mut r = reservation(&root);
        assert!(r
            .verified_launch(|_| Err("USER_CANCELLED".into()))
            .unwrap_err()
            .contains("USER_CANCELLED"));
        assert!(r.path.exists());
        clear(r, &root);
        let root = scratch();
        let r = reservation(&root);
        let writer = OpenOptions::new()
            .write(true)
            .share_mode(3)
            .open(&r.path)
            .unwrap();
        let path = r.path.clone();
        let directory = r.directory.clone();
        let result = r.cancel();
        assert!(!result.removed);
        assert!(result.detail.contains("retained"));
        assert!(path.exists());
        drop(writer);
        fs::remove_file(path).unwrap();
        fs::remove_dir(directory).unwrap();
        fs::remove_dir(root).unwrap();
    }
    #[test]
    fn metadata_reservation_accepts_actual_powershell_exclusive_writer_and_outfile() {
        let root = scratch();
        let mut r = Reservation::create(&root, expected()).unwrap();
        let script = r#"$ErrorActionPreference='Stop';$p=[Console]::In.ReadToEnd()|ConvertFrom-Json;$f=[IO.File]::Open($p,[IO.FileMode]::Create,[IO.FileAccess]::Write,[IO.FileShare]::None);try{$b=[Text.Encoding]::ASCII.GetBytes('neutral update fixture bytes');$f.Write($b,0,$b.Length)}finally{$f.Dispose()}"#;
        let mut command = std::process::Command::new(
            crate::windows_tools::system_file("powershell.exe").unwrap(),
        );
        command.args(["-NoProfile", "-NonInteractive", "-Command", script]);
        let output = crate::process_io::execute(
            &mut command,
            Some(serde_json::to_string(&r.path).unwrap()),
            Duration::from_secs(15),
        )
        .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        r.verified_launch(|_| Ok(())).unwrap();
        // Only a loopback fixture serves neutral bytes. No external URL, actual
        // installer, ShellExecute, UAC or installation is invoked by this test.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let until = Instant::now() + Duration::from_secs(15);
            loop {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        stream.set_nonblocking(false).unwrap();
                        stream
                            .set_read_timeout(Some(Duration::from_secs(3)))
                            .unwrap();
                        stream
                            .set_write_timeout(Some(Duration::from_secs(3)))
                            .unwrap();
                        let mut request = Vec::new();
                        while !request.ends_with(b"\r\n\r\n") {
                            assert!(request.len() < 8192, "Loopback request exceeds limit");
                            assert!(Instant::now() < until, "Loopback request timed out");
                            let mut byte = [0u8; 1];
                            match stream.read(&mut byte) {
                                Ok(1) => request.push(byte[0]),
                                Ok(_) => panic!("Loopback client disconnected before headers"),
                                Err(e) => panic!("Loopback request read failed: {e}"),
                            }
                        }
                        write!(
                            stream,
                            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: application/octet-stream\r\nConnection: close\r\n\r\n",
                            DATA.len()
                        )
                        .unwrap();
                        stream.write_all(DATA).unwrap();
                        return;
                    }
                    Err(e)
                        if e.kind() == std::io::ErrorKind::WouldBlock && Instant::now() < until =>
                    {
                        std::thread::sleep(Duration::from_millis(10))
                    }
                    Err(e) => panic!("Loopback fixture request failed: {e}"),
                }
            }
        });
        let script=format!("$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';[Net.WebRequest]::DefaultWebProxy=$null;$p=[Console]::In.ReadToEnd()|ConvertFrom-Json;try{{Invoke-WebRequest -Uri 'http://{address}/neutral-fixture' -OutFile $p -UseBasicParsing -TimeoutSec 10 -ErrorAction Stop}}catch{{throw $_.Exception.ToString()}}");
        let mut command = std::process::Command::new(
            crate::windows_tools::system_file("powershell.exe").unwrap(),
        );
        command.args(["-NoProfile", "-NonInteractive", "-Command", &script]);
        let output = crate::process_io::execute(
            &mut command,
            Some(serde_json::to_string(&r.path).unwrap()),
            Duration::from_secs(15),
        );
        server.join().unwrap();
        let output = output.unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        r.verified_launch(|_| Ok(())).unwrap();
        clear(r, &root);
    }
    #[test]
    fn hardlinked_payload_and_junction_temp_roots_are_refused() {
        let root = scratch();
        let mut r = reservation(&root);
        let alias = r.directory.join("alias");
        fs::hard_link(&r.path, &alias).unwrap();
        assert!(r.verified_launch(|_| panic!("must not launch")).is_err());
        fs::remove_file(alias).unwrap();
        clear(r, &root);
        let root = scratch();
        let real = root.join("real");
        fs::create_dir(&real).unwrap();
        let junction = root.join("junction");
        let source=format!("$ErrorActionPreference='Stop';New-Item -ItemType Junction -Path '{}' -Target '{}' | Out-Null",junction.display().to_string().replace('\'',"''"),real.display().to_string().replace('\'',"''"));
        let mut command = std::process::Command::new(
            crate::windows_tools::system_file("powershell.exe").unwrap(),
        );
        command.args(["-NoProfile", "-NonInteractive", "-Command", &source]);
        let output =
            crate::process_io::execute(&mut command, None, Duration::from_secs(15)).unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(Reservation::create(&junction, expected()).is_err());
        fs::remove_dir(junction).unwrap();
        fs::remove_dir(real).unwrap();
        fs::remove_dir(root).unwrap();
    }
    #[test]
    fn machine_class_templates_refuse_custom_execution_and_native_portable_is_guarded() {
        for template in [r#""%1""#, r#""%1" %*"#] {
            direct_command(template, None).unwrap();
            direct_command(template, Some(template)).unwrap();
        }
        for template in [
            "%1 %*",
            r#"cmd /c "%1""#,
            r#""other.exe" "%1""#,
            r#""%1" /extra"#,
        ] {
            assert!(direct_command(template, None).is_err());
        }
        assert!(direct_command(r#""%1" %*"#, Some("other")).is_err());
        for name in [
            "DelegateExecute",
            "ExplorerCommandHandler",
            "DropTarget",
            "ddeexec",
            "CommandStateHandler",
        ] {
            assert!(class_handlers(&[name.into()], &[], false).is_err());
            assert!(class_handlers(&[], &[name.into()], false).is_err());
        }
        assert!(class_handlers(&["".into(), "IsolatedCommand".into()], &[], true).is_ok());
        assert!(class_handlers(&["Custom".into()], &[], true).is_err());
        assert!(portable_install(Path::new(
            r"C:\Fixture\Purgeon-Portable.exe"
        )));
        let root = scratch();
        let exe = root.join("Purgeon.exe");
        assert!(!portable_install(&exe));
        fs::write(root.join("portable"), "").unwrap();
        assert!(portable_install(&exe));
        fs::remove_file(root.join("portable")).unwrap();
        fs::remove_dir(root).unwrap();
    }
    #[test]
    fn native_temporary_short_spelling_is_canonicalized_before_pinning() {
        #[link(name = "kernel32")]
        extern "system" {
            fn GetShortPathNameW(long: *const u16, short: *mut u16, size: u32) -> u32;
        }
        let root = scratch();
        let long = wide(root.as_os_str());
        let mut short = vec![0u16; 32768];
        let n = unsafe { GetShortPathNameW(long.as_ptr(), short.as_mut_ptr(), short.len() as u32) }
            as usize;
        assert!(n > 0 && n < short.len());
        let alias = PathBuf::from(String::from_utf16(&short[..n]).unwrap());
        let mut r = Reservation::create(&alias, expected()).unwrap();
        assert!(r.path.starts_with(canonical_temp(&root).unwrap()));
        fs::write(&r.path, DATA).unwrap();
        r.verified_launch(|_| Ok(())).unwrap();
        clear(r, &root);
    }
}
