//! Structured DISM inventory and native SetupAPI package resolution. No localized
//! tool output, caller path or inferred catalog filename is authoritative.
use crate::{protected_driver_package as package, windows_tools};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::{
    ffi::c_void,
    os::windows::ffi::OsStrExt,
    path::{Path, PathBuf},
    ptr::{addr_of, read_unaligned},
    sync::Mutex,
    time::Duration,
};
use std::{os::windows::process::CommandExt, process::Command};
static DISM: Mutex<()> = Mutex::new(());
#[repr(C, packed)]
struct RawPackage {
    published: *const u16,
    original: *const u16,
    inbox: i32,
    catalog: *const u16,
    class_name: *const u16,
    class_guid: *const u16,
    class_description: *const u16,
    boot_critical: i32,
    signature: u32,
    provider: *const u16,
    date: [u16; 8],
    major: u32,
    minor: u32,
    build: u32,
    revision: u32,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Row {
    pub published: String,
    pub original: String,
    pub catalog: String,
    pub provider: String,
    pub class_name: String,
    pub class_guid: String,
    pub date: String,
    pub version: String,
    pub signature: u32,
    pub inbox: bool,
    pub boot_critical: bool,
}
impl Row {
    pub fn validate(&self) -> Result<(), String> {
        if !oem(&self.published)
            || self.original.is_empty()
            || self.original.len() > 32767
            || self.catalog.is_empty()
            || self.catalog.len() > 32767
            || self.provider.trim().is_empty()
            || self.provider.len() > 1024
            || !class_guid(&self.class_guid)
            || self.class_name.trim().is_empty()
            || self.class_name.len() > 256
            || !driver_date(&self.date)
            || !driver_version(&self.version)
            || self.signature > 2
            || [
                &self.original,
                &self.catalog,
                &self.provider,
                &self.class_name,
                &self.class_guid,
            ]
            .iter()
            .any(|s| s.contains('\0'))
        {
            return Err("Incomplete or unsupported native driver identity".into());
        }
        Ok(())
    }
    pub fn eligible(&self) -> Result<(), String> {
        self.validate()?;
        if self.inbox || self.boot_critical || self.signature == 1 {
            return Err(
                "Inbox, boot-critical or unsigned driver packages are not removable".into(),
            );
        }
        Ok(())
    }
}
pub fn oem(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    lower
        .strip_prefix("oem")
        .and_then(|s| s.strip_suffix(".inf"))
        .is_some_and(|n| !n.is_empty() && n.len() <= 10 && n.bytes().all(|b| b.is_ascii_digit()))
}
fn class_guid(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 38
        && bytes[0] == b'{'
        && bytes[37] == b'}'
        && bytes[1..37].iter().enumerate().all(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) {
                *c == b'-'
            } else {
                c.is_ascii_hexdigit()
            }
        })
}
fn driver_date(value: &str) -> bool {
    let b = value.as_bytes();
    if b.len() != 10
        || b[4] != b'-'
        || b[7] != b'-'
        || b.iter()
            .enumerate()
            .any(|(i, c)| i != 4 && i != 7 && !c.is_ascii_digit())
    {
        return false;
    }
    let year = value[..4].parse::<u32>().unwrap_or(0);
    let month = value[5..7].parse::<u32>().unwrap_or(0);
    let day = value[8..].parse::<u32>().unwrap_or(0);
    let leap = year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400));
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => 0,
    };
    year > 0 && day > 0 && day <= days
}
fn driver_version(value: &str) -> bool {
    let parts = value.split('.').collect::<Vec<_>>();
    parts.len() == 4
        && parts.iter().all(|p| {
            !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()) && p.parse::<u32>().is_ok()
        })
}
unsafe fn text(pointer: *const u16) -> Result<String, String> {
    if pointer.is_null() {
        return Err("Missing DISM driver identity field".into());
    }
    let mut length = 0;
    while length < 32768 && unsafe { *pointer.add(length) } != 0 {
        length += 1;
    }
    if length == 32768 {
        return Err("DISM driver identity exceeds bounds".into());
    }
    String::from_utf16(unsafe { std::slice::from_raw_parts(pointer, length) })
        .map_err(|e| e.to_string())
}
struct Library(*mut c_void);
#[link(name = "kernel32")]
extern "system" {
    fn LoadLibraryExW(path: *const u16, file: *mut c_void, flags: u32) -> *mut c_void;
    fn GetProcAddress(module: *mut c_void, name: *const u8) -> *mut c_void;
    fn FreeLibrary(module: *mut c_void) -> i32;
}
impl Drop for Library {
    fn drop(&mut self) {
        unsafe {
            FreeLibrary(self.0);
        }
    }
}
impl Library {
    fn address(&self, name: &std::ffi::CStr) -> Result<*mut c_void, String> {
        let p = unsafe { GetProcAddress(self.0, name.as_ptr().cast()) };
        if p.is_null() {
            Err("Required native DISM API unavailable".into())
        } else {
            Ok(p)
        }
    }
}
type Initialize = unsafe extern "system" fn(u32, *const u16, *const u16) -> i32;
type Open = unsafe extern "system" fn(*const u16, *const u16, *const u16, *mut u32) -> i32;
type Get = unsafe extern "system" fn(u32, i32, *mut *mut RawPackage, *mut u32) -> i32;
type Close = unsafe extern "system" fn(u32) -> i32;
type Shutdown = unsafe extern "system" fn() -> i32;
type Delete = unsafe extern "system" fn(*mut c_void) -> i32;
struct Session {
    handle: Option<u32>,
    close: Close,
    shutdown: Shutdown,
    active: bool,
}
impl Drop for Session {
    fn drop(&mut self) {
        if let Some(h) = self.handle {
            unsafe {
                (self.close)(h);
            }
        }
        if self.active {
            unsafe {
                (self.shutdown)();
            }
        }
    }
}
pub fn rows() -> Result<Vec<Row>, String> {
    let _lock = DISM.lock().map_err(|e| e.to_string())?;
    let path = windows_tools::system_file("DismApi.dll")?;
    let path: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let library =
        Library(unsafe { LoadLibraryExW(path.as_ptr(), std::ptr::null_mut(), 0x100 | 0x800) });
    if library.0.is_null() {
        return Err("Windows DISM API unavailable".into());
    }
    let initialize: Initialize =
        unsafe { std::mem::transmute(library.address(c"DismInitialize")?) };
    let open: Open = unsafe { std::mem::transmute(library.address(c"DismOpenSession")?) };
    let get: Get = unsafe { std::mem::transmute(library.address(c"DismGetDrivers")?) };
    let close: Close = unsafe { std::mem::transmute(library.address(c"DismCloseSession")?) };
    let shutdown: Shutdown = unsafe { std::mem::transmute(library.address(c"DismShutdown")?) };
    let delete: Delete = unsafe { std::mem::transmute(library.address(c"DismDelete")?) };
    let status = unsafe { initialize(0, std::ptr::null(), std::ptr::null()) };
    if status != 0 {
        return Err(format!("Native DISM initialization failed: {status:#x}"));
    }
    let mut session = Session {
        handle: None,
        close,
        shutdown,
        active: true,
    };
    let mut handle = 0;
    let online: Vec<u16> = "DISM_{53BFAE52-B167-4E2F-A258-0A37B57FF845}"
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let status = unsafe {
        open(
            online.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            &mut handle,
        )
    };
    if status != 0 {
        return Err(format!("Native DISM online session failed: {status:#x}"));
    }
    session.handle = Some(handle);
    let mut pointer = std::ptr::null_mut();
    let mut count = 0;
    let status = unsafe { get(handle, 1, &mut pointer, &mut count) };
    struct Buffer {
        pointer: *mut c_void,
        delete: Delete,
    }
    impl Drop for Buffer {
        fn drop(&mut self) {
            if !self.pointer.is_null() {
                unsafe {
                    (self.delete)(self.pointer);
                }
            }
        }
    }
    let mut buffer = Buffer {
        pointer: pointer.cast(),
        delete,
    };
    if status != 0 {
        return Err(format!("Native DISM inventory failed: {status:#x}"));
    }
    if count > 8192 || (count > 0 && pointer.is_null()) {
        return Err("Native driver inventory exceeds bounds".into());
    }
    let mut output = Vec::new();
    for index in 0..count as usize {
        let p = unsafe { pointer.add(index) };
        macro_rules! field {
            ($name:ident) => {
                unsafe { read_unaligned(addr_of!((*p).$name)) }
            };
        }
        macro_rules! string_field {
            ($name:ident) => {{
                let value = field!($name);
                unsafe { text(value) }?
            }};
        }
        let inbox = field!(inbox);
        let boot = field!(boot_critical);
        if ![0, 1].contains(&inbox) || ![0, 1].contains(&boot) {
            return Err("Invalid native DISM boolean".into());
        }
        if inbox == 1 {
            continue;
        }
        let date = field!(date);
        let row = Row {
            published: string_field!(published),
            original: string_field!(original),
            catalog: string_field!(catalog),
            provider: string_field!(provider),
            class_name: string_field!(class_name),
            class_guid: string_field!(class_guid),
            date: format!("{:04}-{:02}-{:02}", date[0], date[1], date[3]),
            version: format!(
                "{}.{}.{}.{}",
                field!(major),
                field!(minor),
                field!(build),
                field!(revision)
            ),
            signature: field!(signature),
            inbox: inbox == 1,
            boot_critical: boot == 1,
        };
        row.validate()?;
        output.push(row);
    }
    if !buffer.pointer.is_null() {
        let freed = unsafe { delete(buffer.pointer) };
        buffer.pointer = std::ptr::null_mut();
        if freed != 0 {
            return Err(format!("DISM inventory release failed: {freed:#x}"));
        }
    }
    let closed = unsafe { close(handle) };
    session.handle = None;
    let stopped = unsafe { shutdown() };
    session.active = false;
    if closed != 0 || stopped != 0 {
        return Err("DISM session cleanup failed".into());
    }
    Ok(output)
}
pub fn location(row: &Row) -> Result<(PathBuf, String, String), String> {
    row.validate()?;
    #[link(name = "setupapi")]
    extern "system" {
        fn SetupGetInfDriverStoreLocationW(
            file: *const u16,
            platform: *const c_void,
            locale: *const u16,
            out: *mut u16,
            size: u32,
            required: *mut u32,
        ) -> i32;
    }
    let system = windows_tools::system_file("pnputil.exe")?;
    let windows = system
        .parent()
        .and_then(Path::parent)
        .ok_or("Could not resolve Windows root")?;
    let published = windows.join("INF").join(&row.published);
    let name: Vec<u16> = published.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut out = vec![0u16; 32768];
    let mut required = 0;
    if unsafe {
        SetupGetInfDriverStoreLocationW(
            name.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            out.as_mut_ptr(),
            out.len() as u32,
            &mut required,
        )
    } == 0
    {
        return Err(format!(
            "Native driver source resolution failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    let len = out
        .iter()
        .position(|c| *c == 0)
        .ok_or("Driver store path exceeds bounds")?;
    let inf = PathBuf::from(String::from_utf16(&out[..len]).map_err(|e| e.to_string())?);
    if !inf.to_string_lossy().eq_ignore_ascii_case(&row.original) {
        return Err("DISM and SetupAPI package source identities disagree".into());
    }
    let root = inf
        .parent()
        .ok_or("Driver source has no package root")?
        .to_path_buf();
    let repository = system
        .parent()
        .ok_or("No system directory")?
        .join("DriverStore")
        .join("FileRepository");
    if root.parent().is_none_or(|p| {
        !p.to_string_lossy()
            .eq_ignore_ascii_case(&repository.to_string_lossy())
    }) {
        return Err("Driver source is outside the native FileRepository".into());
    }
    let inf_name = inf
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or("Invalid native INF name")?
        .to_string();
    package::relative(&inf_name)?;
    let catalog_path = Path::new(&row.catalog);
    let catalog = if catalog_path.components().count() == 1 {
        row.catalog.clone()
    } else {
        if catalog_path.parent().is_none_or(|p| {
            !p.to_string_lossy()
                .eq_ignore_ascii_case(&root.to_string_lossy())
        }) {
            return Err("Native catalog is outside driver package".into());
        }
        catalog_path
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or("Invalid native catalog filename")?
            .into()
    };
    package::relative(&catalog)?;
    Ok((root, inf_name, catalog))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Guards {
    pub bound: Vec<String>,
    pub running: Vec<String>,
}
// PathName is a complete system-driver image path, not a command line. Keep the
// entire basename (including spaces); extracting a regex suffix can miss a
// running package such as "vendor filter.sys" by turning it into "filter.sys".
fn running_basename(value: &str) -> Result<String, String> {
    let value = value.trim();
    let path = if let Some(quoted) = value.strip_prefix('"') {
        quoted
            .strip_suffix('"')
            .ok_or("A running system driver path is ambiguous")?
    } else {
        value
    };
    if path.is_empty() || path.len() > 32767 || path.chars().any(|c| c == '"' || c.is_control()) {
        return Err("A running system driver path is unknown".into());
    }
    if path
        .to_ascii_lowercase()
        .match_indices(".sys")
        .any(|(i, _)| {
            path.as_bytes()
                .get(i + 4)
                .is_some_and(u8::is_ascii_whitespace)
        })
    {
        return Err("A running system driver path is ambiguous".into());
    }
    let name = path
        .rsplit(['\\', '/'])
        .next()
        .ok_or("A running system driver path is unknown")?;
    if name.len() > 255
        || name.contains(':')
        || !name.to_ascii_lowercase().ends_with(".sys")
        || name.len() == 4
    {
        return Err("A running system driver path is unknown".into());
    }
    Ok(name.into())
}
fn checked_guards(mut guards: Guards) -> Result<Guards, String> {
    if guards.bound.len() > 32768
        || guards.running.len() > 8192
        || guards.bound.iter().any(|s| {
            s.len() <= 4
                || s.len() > 255
                || s.contains(['\\', '/', ':'])
                || s.chars().any(char::is_control)
                || !s.to_ascii_lowercase().ends_with(".inf")
        })
    {
        return Err("Invalid native driver-use guards".into());
    }
    guards.running = guards
        .running
        .iter()
        .map(|path| running_basename(path))
        .collect::<Result<_, _>>()?;
    Ok(guards)
}
pub fn guards() -> Result<Guards, String> {
    const SCRIPT: &str = r#"$ErrorActionPreference='Stop';$PSModuleAutoloadingPreference='None';[Console]::OutputEncoding=[Text.Encoding]::UTF8
Import-Module ($PSHOME+'\Modules\CimCmdlets\CimCmdlets.psd1') -ErrorAction Stop
Import-Module ($PSHOME+'\Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop
$bound=@(CimCmdlets\Get-CimInstance -ClassName Win32_PnPSignedDriver -ErrorAction Stop | ForEach-Object {if([string]::IsNullOrWhiteSpace([string]$_.InfName)){throw 'A device driver association is unknown'};[string]$_.InfName})
$running=@(CimCmdlets\Get-CimInstance -ClassName Win32_SystemDriver -ErrorAction Stop | ForEach-Object {if($_.Started -isnot [bool]){throw 'A system driver running state is unknown'};if($_.Started){if([string]::IsNullOrWhiteSpace([string]$_.PathName)){throw 'A running system driver path is unknown'};[string]$_.PathName}})
Microsoft.PowerShell.Utility\ConvertTo-Json -InputObject ([pscustomobject]@{bound=@($bound);running=@($running)}) -Depth 3 -Compress"#;
    let bytes: Vec<u8> = SCRIPT.encode_utf16().flat_map(u16::to_le_bytes).collect();
    let mut command = Command::new(windows_tools::system_file("powershell.exe")?);
    command
        .env_remove("PSModulePath")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            &STANDARD.encode(bytes),
        ])
        .creation_flags(0x0800_0000);
    let out = crate::process_io::execute(&mut command, None, Duration::from_secs(20))?;
    if !out.status.success() {
        return Err(format!(
            "Native driver active-use guards unavailable: {}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    if out.stdout.len() > 2 * 1024 * 1024 {
        return Err("Driver guard inventory exceeds bounds".into());
    }
    checked_guards(serde_json::from_slice(&out.stdout).map_err(|e| e.to_string())?)
}
pub fn unused(row: &Row, manifest: &package::Manifest, guards: &Guards) -> Result<(), String> {
    row.eligible()?;
    if guards
        .bound
        .iter()
        .any(|name| name.eq_ignore_ascii_case(&row.published))
        || manifest
            .files
            .iter()
            .filter(|m| m.name.to_ascii_lowercase().ends_with(".sys"))
            .any(|m| {
                guards.running.iter().any(|name| {
                    m.name
                        .rsplit('/')
                        .next()
                        .is_some_and(|base| base.eq_ignore_ascii_case(name))
                })
            })
    {
        return Err("Driver package is device-associated or has a running system driver".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn row() -> Row {
        Row {
            published: "oem1.inf".into(),
            original:
                r"C:\Windows\System32\DriverStore\FileRepository\example.inf_amd64_123\example.inf"
                    .into(),
            catalog: "example.cat".into(),
            provider: "Example provider".into(),
            class_name: "Net".into(),
            class_guid: "{4d36e972-e325-11ce-bfc1-08002be10318}".into(),
            date: "2024-02-29".into(),
            version: "1.2.3.4294967295".into(),
            signature: 0,
            inbox: false,
            boot_critical: false,
        }
    }
    fn manifest() -> package::Manifest {
        package::Manifest {
            files: vec![
                package::Member {
                    name: "example.inf".into(),
                    bytes: 1,
                    digest: "a".repeat(64),
                },
                package::Member {
                    name: "example.cat".into(),
                    bytes: 1,
                    digest: "b".repeat(64),
                },
                package::Member {
                    name: "nested/vendor filter.sys".into(),
                    bytes: 1,
                    digest: "c".repeat(64),
                },
            ],
            directories: vec!["nested".into()],
            inf: "example.inf".into(),
            catalog: "example.cat".into(),
        }
    }
    #[test]
    fn packed_sdk_layout_and_closed_oem_names() {
        assert_eq!(std::mem::size_of::<RawPackage>(), 100);
        assert_eq!(std::mem::align_of::<RawPackage>(), 1);
        for (actual, expected) in [
            (std::mem::offset_of!(RawPackage, published), 0),
            (std::mem::offset_of!(RawPackage, original), 8),
            (std::mem::offset_of!(RawPackage, inbox), 16),
            (std::mem::offset_of!(RawPackage, catalog), 20),
            (std::mem::offset_of!(RawPackage, class_name), 28),
            (std::mem::offset_of!(RawPackage, class_guid), 36),
            (std::mem::offset_of!(RawPackage, class_description), 44),
            (std::mem::offset_of!(RawPackage, boot_critical), 52),
            (std::mem::offset_of!(RawPackage, signature), 56),
            (std::mem::offset_of!(RawPackage, provider), 60),
            (std::mem::offset_of!(RawPackage, date), 68),
            (std::mem::offset_of!(RawPackage, major), 84),
            (std::mem::offset_of!(RawPackage, minor), 88),
            (std::mem::offset_of!(RawPackage, build), 92),
            (std::mem::offset_of!(RawPackage, revision), 96),
        ] {
            assert_eq!(actual, expected);
        }
        for value in ["oem1.inf", "OEM234.inf"] {
            assert!(oem(value));
        }
        for value in [
            "../oem1.inf",
            "C:\\oem1.inf",
            "oem.inf",
            "oem1.inf /force",
            "oem1.inf:stream",
            "oem-1.inf",
            "oem12345678901.inf",
        ] {
            assert!(!oem(value));
        }
    }
    #[test]
    fn metadata_and_unknown_safety_fields_fail_closed() {
        assert!(row().eligible().is_ok()); // Unknown signature requires catalog trust at capture, not inferred signing.
        let mut signed = row();
        signed.signature = 2;
        assert!(signed.eligible().is_ok());
        for value in [
            "0000-00-00",
            "2023-02-29",
            "2024-02-30",
            "2026-13-01",
            "2026-01-00",
            "2026/01/01",
        ] {
            let mut r = row();
            r.date = value.into();
            assert!(r.validate().is_err(), "{value}");
        }
        for value in [
            "1.2.3",
            "1.2.3.4.5",
            "1.2.3.4294967296",
            "1.2.3.-1",
            "1.2.3.+1",
        ] {
            let mut r = row();
            r.version = value.into();
            assert!(r.validate().is_err(), "{value}");
        }
        for value in [
            "{4d36e972-e325-11ce-bfc1-08002be1031z}",
            "x4d36e972-e325-11ce-bfc1-08002be10318x",
            "{4d36e972xe325-11ce-bfc1-08002be10318}",
        ] {
            let mut r = row();
            r.class_guid = value.into();
            assert!(r.validate().is_err());
        }
        for field in [
            "inbox",
            "bootCritical",
            "signature",
            "catalog",
            "original",
            "provider",
            "className",
            "classGuid",
            "date",
            "version",
        ] {
            let mut value = serde_json::to_value(row()).unwrap();
            value.as_object_mut().unwrap().remove(field);
            assert!(
                serde_json::from_value::<Row>(value).is_err(),
                "missing {field}"
            );
        }
        for (inbox, boot, signature) in [
            (true, false, 2),
            (false, true, 2),
            (false, false, 1),
            (false, false, 3),
        ] {
            let mut r = row();
            r.inbox = inbox;
            r.boot_critical = boot;
            r.signature = signature;
            assert!(r.eligible().is_err());
        }
    }
    #[test]
    fn running_path_keeps_spaces_and_rejects_command_suffixes() {
        for input in [
            r"C:\Windows\System32\drivers\vendor filter.sys",
            r#""C:\Windows\System32\drivers\vendor filter.sys""#,
            r"\SystemRoot\System32\drivers\vendor filter.sys",
            r"\??\C:\Windows\System32\drivers\vendor filter.sys",
        ] {
            assert_eq!(running_basename(input).unwrap(), "vendor filter.sys");
        }
        for input in [
            "",
            r#""C:\drivers\vendor filter.sys" /arg"#,
            r"C:\drivers\vendor filter.sys /arg",
            r"C:\drivers\vendor.sys other.sys",
            r"C:\drivers\vendor.sys /arg C:\other\other.sys",
            r#""C:\drivers\vendor filter.sys"#,
            r#"C:\drivers\bad"name.sys"#,
            r"C:\drivers\file:stream.sys",
            r"C:\drivers\.sys",
        ] {
            assert!(running_basename(input).is_err(), "{input}");
        }
    }
    #[test]
    fn guards_refuse_bound_and_running_packages_including_spaced_names() {
        let r = row();
        let manifest = manifest();
        manifest.validate().unwrap();
        let clean = checked_guards(Guards {
            bound: vec!["other.inf".into()],
            running: vec![r"C:\drivers\other.sys".into()],
        })
        .unwrap();
        assert!(unused(&r, &manifest, &clean).is_ok());
        let bound = checked_guards(Guards {
            bound: vec!["OEM1.INF".into()],
            running: vec![],
        })
        .unwrap();
        assert!(unused(&r, &manifest, &bound).is_err());
        let running = checked_guards(Guards {
            bound: vec![],
            running: vec![r#""C:\drivers\VENDOR FILTER.SYS""#.into()],
        })
        .unwrap();
        assert!(unused(&r, &manifest, &running).is_err());
        for bound in ["", ".inf", "../oem1.inf", "oem1.inf:stream", "oem1.inf\n"] {
            assert!(checked_guards(Guards {
                bound: vec![bound.into()],
                running: vec![]
            })
            .is_err());
        }
        for value in [
            serde_json::json!({"bound":[]}),
            serde_json::json!({"running":[]}),
            serde_json::json!({"bound":[],"running":[],"force":true}),
        ] {
            assert!(serde_json::from_value::<Guards>(value).is_err());
        }
    }
}
