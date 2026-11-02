//! Native Windows event-channel inventory. Renderer strings never identify a
//! privileged resource: callers receive opaque grants from native_operations.
use serde::{Deserialize, Serialize};
use std::ffi::c_void;

type Handle = *mut c_void;
const MAX_CHANNELS: usize = 4096;
const MAX_PROPERTY_BYTES: usize = 65536;

#[repr(C)]
struct Variant {
    data: u64,
    count: u32,
    kind: u32,
}
#[link(name = "wevtapi")]
extern "system" {
    fn EvtOpenChannelEnum(session: Handle, flags: u32) -> Handle;
    fn EvtNextChannelPath(enumerator: Handle, size: u32, buffer: *mut u16, used: *mut u32) -> i32;
    fn EvtOpenChannelConfig(session: Handle, path: *const u16, flags: u32) -> Handle;
    fn EvtGetChannelConfigProperty(
        config: Handle,
        property: u32,
        flags: u32,
        size: u32,
        value: *mut Variant,
        used: *mut u32,
    ) -> i32;
    fn EvtOpenLog(session: Handle, path: *const u16, flags: u32) -> Handle;
    fn EvtGetLogInfo(
        log: Handle,
        property: u32,
        size: u32,
        value: *mut Variant,
        used: *mut u32,
    ) -> i32;
    fn EvtClose(handle: Handle) -> i32;
}
struct Owned(Handle);
impl Owned {
    fn new(handle: Handle) -> Result<Self, String> {
        if handle.is_null() {
            Err(std::io::Error::last_os_error().to_string())
        } else {
            Ok(Self(handle))
        }
    }
}
impl Drop for Owned {
    fn drop(&mut self) {
        unsafe {
            EvtClose(self.0);
        }
    }
}
fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(Some(0)).collect()
}
fn error_code() -> i32 {
    std::io::Error::last_os_error().raw_os_error().unwrap_or(-1)
}
fn bounded_error(error: impl std::fmt::Display) -> String {
    error.to_string().chars().take(512).collect()
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    content = "value",
    rename_all = "camelCase",
    deny_unknown_fields
)]
pub enum Property {
    Null,
    Boolean(bool),
    Unsigned32(u32),
    Unsigned64(u64),
    Text(String),
    Guid([u8; 16]),
    TextList(Vec<String>),
    Unsupported(u32),
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChannelConfig {
    pub name: String,
    pub properties: Vec<Property>,
}
impl ChannelConfig {
    pub fn enabled(&self) -> Result<bool, String> {
        match self.properties.first() {
            Some(Property::Boolean(value)) => Ok(*value),
            _ => Err("Channel enabled state is unavailable".into()),
        }
    }
    pub fn validate(&self) -> Result<(), String> {
        validate_name(&self.name)?;
        if self.properties.len() != 21 {
            return Err("Incomplete event-channel configuration".into());
        }
        self.enabled()?;
        if serde_json::to_vec(self).map_err(|e| e.to_string())?.len() > 8192 {
            return Err("Event channel configuration exceeds native recovery bounds".into());
        }
        Ok(())
    }
}
pub fn guarded(name: &str) -> bool {
    name.eq_ignore_ascii_case("Security")
}
pub fn validate_change(name: &str, setting_enabled: bool) -> Result<(), String> {
    validate_name(name)?;
    validate_tool_operand(name)?;
    if guarded(name) {
        return Err("The Security log is view-and-export only; Purgeon never clears it or changes its enabled state".into());
    }
    if setting_enabled
        && ["Application", "System"]
            .iter()
            .any(|value| name.eq_ignore_ascii_case(value))
    {
        return Err(
            "Windows does not allow changing the enabled state of the Application or System log"
                .into(),
        );
    }
    Ok(())
}
pub fn validate_tool_operand(name: &str) -> Result<(), String> {
    validate_name(name)?;
    if name.starts_with(['/', '-']) {
        return Err("This channel name is ambiguous to Windows' event command tool; Purgeon will not use it as an operation target".into());
    }
    Ok(())
}
pub fn validate_name(name: &str) -> Result<(), String> {
    if name.is_empty()
        || name.encode_utf16().count() > 1024
        || name.contains('\0')
        || name.chars().any(char::is_control)
    {
        return Err("Invalid native event-channel name".into());
    }
    Ok(())
}
fn checked_range(
    buffer: &[u64],
    used: usize,
    address: usize,
    length: usize,
) -> Result<usize, String> {
    let base = buffer.as_ptr() as usize;
    let offset = address
        .checked_sub(base)
        .ok_or("Event metadata pointer precedes its buffer")?;
    if used > buffer.len() * 8 || offset.checked_add(length).is_none_or(|end| end > used) {
        return Err("Event metadata pointer exceeds its buffer".into());
    }
    Ok(offset)
}
fn text_in(buffer: &[u64], used: usize, address: usize) -> Result<String, String> {
    checked_range(buffer, used, address, 2)?;
    if !address.is_multiple_of(2) {
        return Err("Unaligned event metadata text".into());
    }
    let base = buffer.as_ptr() as usize;
    let maximum = (used - (address - base)) / 2;
    let units = unsafe { std::slice::from_raw_parts(address as *const u16, maximum) };
    let end = units
        .iter()
        .position(|unit| *unit == 0)
        .ok_or("Unterminated event metadata text")?;
    String::from_utf16(&units[..end]).map_err(|e| e.to_string())
}
fn decode(buffer: &[u64], used: usize) -> Result<Property, String> {
    if used < std::mem::size_of::<Variant>() || used > buffer.len() * 8 {
        return Err("Invalid event metadata buffer length".into());
    }
    let value = unsafe { &*buffer.as_ptr().cast::<Variant>() };
    if value.kind == 0x81 {
        if value.count > 4096 {
            return Err("Too many event publisher identities".into());
        }
        let count = value.count as usize;
        if count == 0 {
            return Ok(Property::TextList(Vec::new()));
        }
        let address = value.data as usize;
        checked_range(buffer, used, address, count * std::mem::size_of::<usize>())?;
        if !address.is_multiple_of(std::mem::align_of::<usize>()) {
            return Err("Unaligned event publisher list".into());
        }
        let pointers = unsafe { std::slice::from_raw_parts(address as *const usize, count) };
        return Ok(Property::TextList(
            pointers
                .iter()
                .map(|p| text_in(buffer, used, *p))
                .collect::<Result<_, _>>()?,
        ));
    }
    if value.count != 0 {
        return Err("Unexpected array in event channel configuration".into());
    }
    match value.kind {
        0 => Ok(Property::Null),
        1 => Ok(Property::Text(text_in(buffer, used, value.data as usize)?)),
        8 => Ok(Property::Unsigned32(value.data as u32)),
        10 => Ok(Property::Unsigned64(value.data)),
        13 => match value.data as u32 {
            0 => Ok(Property::Boolean(false)),
            1 => Ok(Property::Boolean(true)),
            _ => Err("Invalid event metadata boolean".into()),
        },
        15 => {
            let address = value.data as usize;
            checked_range(buffer, used, address, 16)?;
            let mut guid = [0u8; 16];
            unsafe {
                std::ptr::copy_nonoverlapping(address as *const u8, guid.as_mut_ptr(), 16);
            }
            Ok(Property::Guid(guid))
        }
        _ => Err("Unsupported event channel metadata type".into()),
    }
}
fn property(config: &Owned, id: u32) -> Result<Property, String> {
    let mut used = 0;
    let first =
        unsafe { EvtGetChannelConfigProperty(config.0, id, 0, 0, std::ptr::null_mut(), &mut used) };
    if first == 0 {
        let code = error_code();
        if [50, 87].contains(&code) {
            return Ok(Property::Unsupported(code as u32));
        }
        if code != 122 {
            return Err(std::io::Error::from_raw_os_error(code).to_string());
        }
    }
    if used as usize > MAX_PROPERTY_BYTES || (used as usize) < std::mem::size_of::<Variant>() {
        return Err("Event channel metadata exceeds size limit".into());
    }
    let mut buffer = vec![0u64; (used as usize).div_ceil(8)];
    let ok = unsafe {
        EvtGetChannelConfigProperty(
            config.0,
            id,
            0,
            (buffer.len() * 8) as u32,
            buffer.as_mut_ptr().cast(),
            &mut used,
        )
    };
    if ok == 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    decode(&buffer, used as usize)
}
pub fn capture(name: &str) -> Result<ChannelConfig, String> {
    validate_name(name)?;
    let path = wide(name);
    let config =
        Owned::new(unsafe { EvtOpenChannelConfig(std::ptr::null_mut(), path.as_ptr(), 0) })?;
    let properties = (0..21)
        .map(|id| property(&config, id))
        .collect::<Result<Vec<_>, _>>()?;
    let result = ChannelConfig {
        name: name.into(),
        properties,
    };
    result.validate()?;
    Ok(result)
}
fn enabled_summary(name: &str) -> Result<bool, String> {
    validate_name(name)?;
    let path = wide(name);
    let config =
        Owned::new(unsafe { EvtOpenChannelConfig(std::ptr::null_mut(), path.as_ptr(), 0) })?;
    match property(&config, 0)? {
        Property::Boolean(enabled) => Ok(enabled),
        _ => Err("Channel enabled state is unavailable".into()),
    }
}
fn names() -> Result<Vec<String>, String> {
    let enumerator = Owned::new(unsafe { EvtOpenChannelEnum(std::ptr::null_mut(), 0) })?;
    let mut names = Vec::new();
    loop {
        let mut buffer = vec![0u16; 256];
        let mut used = 0;
        let mut ok = unsafe {
            EvtNextChannelPath(
                enumerator.0,
                buffer.len() as u32,
                buffer.as_mut_ptr(),
                &mut used,
            )
        };
        if ok == 0 {
            let code = error_code();
            if code == 259 {
                break;
            }
            if code != 122 {
                return Err(std::io::Error::from_raw_os_error(code).to_string());
            }
            if used == 0 || used > 1025 {
                return Err("Event channel name exceeds size limit".into());
            }
            buffer.resize(used as usize, 0);
            ok = unsafe {
                EvtNextChannelPath(
                    enumerator.0,
                    buffer.len() as u32,
                    buffer.as_mut_ptr(),
                    &mut used,
                )
            };
            if ok == 0 {
                return Err(std::io::Error::last_os_error().to_string());
            }
        }
        let end = buffer
            .iter()
            .position(|unit| *unit == 0)
            .ok_or("Unterminated native channel name")?;
        let name = String::from_utf16(&buffer[..end]).map_err(|e| e.to_string())?;
        validate_name(&name)?;
        names.push(name);
        if names.len() > MAX_CHANNELS {
            return Err("Windows has more than the supported 4096 event channels".into());
        }
    }
    Ok(names)
}
fn log_number(value: &Variant, used: u32) -> Result<u64, String> {
    // EVT_VARIANT.Count is defined only for array types. EvtGetLogInfo can
    // leave it nonzero for a valid scalar; exact UInt64 kind rejects arrays.
    if used as usize != std::mem::size_of::<Variant>() || value.kind != 10 {
        return Err("Unexpected event log count metadata".into());
    }
    Ok(value.data)
}
fn log_numbers(name: &str) -> Result<(u64, u64), String> {
    let path = wide(name);
    let log = Owned::new(unsafe { EvtOpenLog(std::ptr::null_mut(), path.as_ptr(), 1) })?;
    let read = |id| -> Result<u64, String> {
        let mut value = Variant {
            data: 0,
            count: 0,
            kind: 0,
        };
        let mut used = 0;
        let ok = unsafe {
            EvtGetLogInfo(
                log.0,
                id,
                std::mem::size_of::<Variant>() as u32,
                &mut value,
                &mut used,
            )
        };
        if ok == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        log_number(&value, used)
    };
    Ok((read(5)?, read(3)?))
}
#[derive(Clone, Debug)]
pub struct InventoryRow {
    pub name: String,
    pub enabled: Option<bool>,
    pub records: Option<u64>,
    pub size_bytes: Option<u64>,
    pub metadata_error: Option<String>,
    pub config_error: Option<String>,
}
pub fn inventory() -> Result<Vec<InventoryRow>, String> {
    names()?
        .into_iter()
        .map(|name| {
            // Inventory display is not mutation authority. Full configuration
            // is captured lazily when selected/prepared and again in the helper.
            let (enabled, config_error) = match enabled_summary(&name) {
                Ok(enabled) => (Some(enabled), None),
                Err(error) => (None, Some(bounded_error(error))),
            };
            let (records, size_bytes, metadata_error) = match log_numbers(&name) {
                Ok((records, size)) => (Some(records), Some(size), None),
                Err(error) => (None, None, Some(bounded_error(error))),
            };
            Ok(InventoryRow {
                name,
                enabled,
                records,
                size_bytes,
                metadata_error,
                config_error,
            })
        })
        .collect()
}

pub fn run_tool(
    arguments: &[String],
    deadline: std::time::Instant,
    mut progress: impl FnMut() -> Result<(), String>,
) -> Result<(), String> {
    use std::io::Read;
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    use std::time::{Duration, Instant};
    let mut child = Command::new(crate::windows_tools::system_file("wevtutil.exe")?)
        .args(arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(0x0800_0000)
        .spawn()
        .map_err(|e| e.to_string())?;
    let job = match crate::security::ProcessJob::assign(&child) {
        Ok(job) => job,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
    };
    let excessive = Arc::new(AtomicBool::new(false));
    let drain = |pipe: Box<dyn Read + Send>| {
        let excessive = excessive.clone();
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            pipe.take(65537)
                .read_to_end(&mut bytes)
                .map_err(|e| e.to_string())?;
            if bytes.len() > 65536 {
                excessive.store(true, Ordering::SeqCst);
                return Err("Windows event tool output exceeds its limit".to_string());
            }
            Ok(bytes)
        })
    };
    let out = drain(Box::new(
        child.stdout.take().ok_or("Missing Windows tool stdout")?,
    ));
    let err = drain(Box::new(
        child.stderr.take().ok_or("Missing Windows tool stderr")?,
    ));
    let mut last_progress = Instant::now()
        .checked_sub(Duration::from_secs(1))
        .ok_or("Invalid progress clock")?;
    let status = loop {
        if Instant::now() >= deadline || excessive.load(Ordering::SeqCst) {
            drop(job);
            let _ = child.kill();
            let _ = child.wait();
            return Err("Windows event operation exceeded its output/deadline limit; inspect the retained journal before retrying".into());
        }
        if last_progress.elapsed() >= Duration::from_secs(1) {
            if let Err(error) = progress() {
                drop(job);
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
            last_progress = Instant::now();
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => std::thread::sleep(Duration::from_millis(30)),
            Err(error) => {
                drop(job);
                let _ = child.kill();
                let _ = child.wait();
                return Err(error.to_string());
            }
        }
    };
    drop(job);
    let stdout = out
        .join()
        .map_err(|_| "Windows event output reader failed")??;
    let stderr = err
        .join()
        .map_err(|_| "Windows event error reader failed")??;
    if !status.success() {
        let text = if stderr.is_empty() { stdout } else { stderr };
        return Err(format!(
            "Windows event operation exited {}: {}",
            status.code().unwrap_or(-1),
            String::from_utf8_lossy(&text)
                .chars()
                .take(2048)
                .collect::<String>()
                .trim()
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_variant_layout_matches_the_x64_windows_abi() {
        assert_eq!(std::mem::size_of::<Variant>(), 16);
        assert_eq!(std::mem::offset_of!(Variant, count), 8);
        assert_eq!(std::mem::offset_of!(Variant, kind), 12);
        assert!(validate_change("Application", true).is_err());
        assert!(validate_change("System", true).is_err());
        assert!(validate_change("Application", false).is_ok());
        assert!(validate_change("Security", false).is_err());
    }
    #[test]
    fn log_info_scalars_ignore_undefined_count_but_refuse_arrays_or_bad_sizes() {
        let mut value = Variant {
            data: 123,
            count: u32::MAX,
            kind: 10,
        };
        assert_eq!(log_number(&value, 16).unwrap(), 123);
        assert!(log_number(&value, 8).is_err());
        value.kind = 0x80 | 10;
        assert!(log_number(&value, 16).is_err());
        value.kind = 8;
        assert!(log_number(&value, 16).is_err());
    }
    #[test]
    fn malformed_variant_buffers_are_rejected_without_dereferencing_outside_memory() {
        assert!(decode(&[], 0).is_err());
        let mut buffer = vec![0u64; 2];
        let variant = unsafe { &mut *buffer.as_mut_ptr().cast::<Variant>() };
        variant.kind = 1;
        variant.data = 1;
        assert!(decode(&buffer, 16).is_err());
        let variant = unsafe { &mut *buffer.as_mut_ptr().cast::<Variant>() };
        variant.kind = 0x81;
        variant.count = u32::MAX;
        assert!(decode(&buffer, 16).is_err());
    }
    #[test]
    fn scalar_types_and_security_guard_are_explicit() {
        let mut buffer = vec![0u64; 2];
        let variant = unsafe { &mut *buffer.as_mut_ptr().cast::<Variant>() };
        variant.kind = 13;
        variant.data = 1;
        assert_eq!(decode(&buffer, 16).unwrap(), Property::Boolean(true));
        assert!(guarded("sEcUrItY"));
        assert!(!guarded("Security-Other"));
        assert!(validate_name("Microsoft-Windows-Test/Operational").is_ok());
        assert!(validate_name("bad\0name").is_err());
    }
}
