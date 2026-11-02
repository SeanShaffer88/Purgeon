//! Bounded raw registry access using held handles and explicit native view.
use serde::{Deserialize, Serialize};
use winreg::enums::*;
use winreg::{RegKey, RegValue};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RawValue {
    pub kind: u32,
    pub bytes: Vec<u8>,
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}
pub fn read_value(key: &RegKey, name: &str) -> Result<Option<RawValue>, String> {
    #[link(name = "advapi32")]
    extern "system" {
        fn RegQueryValueExW(
            key: *mut std::ffi::c_void,
            name: *const u16,
            reserved: *mut u32,
            kind: *mut u32,
            data: *mut u8,
            size: *mut u32,
        ) -> i32;
    }
    let name = wide(name);
    let mut kind = 0;
    let mut size = 0;
    let code = unsafe {
        RegQueryValueExW(
            key.raw_handle(),
            name.as_ptr(),
            std::ptr::null_mut(),
            &mut kind,
            std::ptr::null_mut(),
            &mut size,
        )
    };
    if code == 2 {
        return Ok(None);
    }
    if code != 0 {
        return Err(std::io::Error::from_raw_os_error(code).to_string());
    }
    if size > 32768 || kind > 11 {
        return Err("Registry original is too large or has an unsupported raw type".into());
    }
    let mut bytes = vec![0; size as usize];
    let code = unsafe {
        RegQueryValueExW(
            key.raw_handle(),
            name.as_ptr(),
            std::ptr::null_mut(),
            &mut kind,
            bytes.as_mut_ptr(),
            &mut size,
        )
    };
    if code != 0 || size as usize > bytes.len() || kind > 11 {
        return Err("Registry value changed while being read; prepare again".into());
    }
    bytes.truncate(size as usize);
    Ok(Some(RawValue { kind, bytes }))
}
fn no_link(key: &RegKey) -> Result<(), String> {
    if read_value(key, "SymbolicLinkValue")?.is_some_and(|v| v.kind == 6) {
        return Err("Registry symbolic links cannot be used by privileged operations".into());
    }
    Ok(())
}
pub fn resolve_compiled_path(path: &str) -> Result<String, String> {
    const PREFIX: &str = "HKLM\\SYSTEM\\CurrentControlSet\\";
    let Some(suffix) = path.strip_prefix(PREFIX) else {
        return Ok(path.to_string());
    };
    // CurrentControlSet is an OS registry link. Resolve only this exact compiled
    // alias via the protected selector; all traversal still refuses registry links.
    let select = open("HKLM\\SYSTEM\\Select", "", KEY_READ)?
        .ok_or("System control-set selector is missing")?;
    let raw = read_value(&select, "Current")?.ok_or("Current control-set selector is missing")?;
    if raw.kind != 4 || raw.bytes.len() != 4 {
        return Err("Invalid current control-set selector".into());
    }
    let number = u32::from_le_bytes(
        raw.bytes
            .as_slice()
            .try_into()
            .map_err(|_| "Invalid control-set DWORD")?,
    );
    if !(1..=999).contains(&number) {
        return Err("Current control-set selector is outside the supported range".into());
    }
    Ok(format!("HKLM\\SYSTEM\\ControlSet{number:03}\\{suffix}"))
}
pub fn root_and_parts(path: &str, caller_sid: &str) -> Result<(RegKey, Vec<String>), String> {
    let resolved = resolve_compiled_path(path)?;
    let path = resolved.as_str();
    let (hive, rest) = path
        .split_once('\\')
        .ok_or("Invalid compiled registry resource")?;
    let parts: Vec<String> = rest.split('\\').map(str::to_string).collect();
    if parts.is_empty()
        || parts
            .iter()
            .any(|s| s.is_empty() || [".", ".."].contains(&s.as_str()) || s.contains('\0'))
    {
        return Err("Invalid compiled registry resource".into());
    }
    let root = match hive {
        "HKLM" => RegKey::predef(HKEY_LOCAL_MACHINE),
        "HKCU" => {
            if !caller_sid.starts_with("S-")
                || !caller_sid[2..]
                    .bytes()
                    .all(|b| b.is_ascii_digit() || b == b'-')
            {
                return Err("Invalid caller SID".into());
            }
            let user = RegKey::predef(HKEY_USERS)
                .open_subkey_with_options_flags(
                    caller_sid,
                    REG_OPTION_OPEN_LINK,
                    KEY_READ | KEY_WOW64_64KEY,
                )
                .map_err(|e| e.to_string())?;
            no_link(&user)?;
            user
        }
        _ => return Err("Unsupported compiled registry hive".into()),
    };
    Ok((root, parts))
}
pub fn open(path: &str, caller_sid: &str, access: u32) -> Result<Option<RegKey>, String> {
    let (mut key, parts) = root_and_parts(path, caller_sid)?;
    for (index, part) in parts.iter().enumerate() {
        let rights = KEY_READ | KEY_WOW64_64KEY | if index + 1 == parts.len() { access } else { 0 };
        match key.open_subkey_with_options_flags(part, REG_OPTION_OPEN_LINK, rights) {
            Ok(next) => {
                no_link(&next)?;
                key = next;
            }
            Err(error) if error.raw_os_error() == Some(2) => return Ok(None),
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(Some(key))
}
pub fn can_mutate(path: &str, caller_sid: &str) -> Result<(), String> {
    let (mut key, parts) = root_and_parts(path, caller_sid)?;
    for (index, part) in parts.iter().enumerate() {
        match key.open_subkey_with_options_flags(
            part,
            REG_OPTION_OPEN_LINK,
            KEY_READ
                | KEY_WOW64_64KEY
                | if index + 1 == parts.len() {
                    KEY_SET_VALUE
                } else {
                    0
                },
        ) {
            Ok(next) => {
                no_link(&next)?;
                key = next;
            }
            Err(error) if error.raw_os_error() == Some(2) => {
                key.open_subkey_with_flags("", KEY_CREATE_SUB_KEY | KEY_WOW64_64KEY)
                    .map_err(|e| e.to_string())?;
                return Ok(());
            }
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(())
}
pub fn create(path: &str, caller_sid: &str) -> Result<RegKey, String> {
    let (mut key, parts) = root_and_parts(path, caller_sid)?;
    for (index, part) in parts.iter().enumerate() {
        let rights = KEY_READ
            | KEY_WOW64_64KEY
            | if index + 1 == parts.len() {
                KEY_SET_VALUE
            } else {
                0
            };
        match key.open_subkey_with_options_flags(part, REG_OPTION_OPEN_LINK, rights) {
            Ok(next) => {
                no_link(&next)?;
                key = next;
            }
            Err(error) if error.raw_os_error() == Some(2) => {
                let parent = key
                    .open_subkey_with_flags("", KEY_CREATE_SUB_KEY | KEY_WOW64_64KEY)
                    .map_err(|e| e.to_string())?;
                let (next, disposition) = parent
                    .create_subkey_with_flags(part, rights | KEY_CREATE_SUB_KEY)
                    .map_err(|e| e.to_string())?;
                if disposition != REG_CREATED_NEW_KEY {
                    return Err(
                        "Registry key appeared during creation; review the operation journal"
                            .into(),
                    );
                }
                no_link(&next)?;
                key = next;
            }
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(key)
}
pub fn write(key: &RegKey, name: &str, raw: Option<&RawValue>) -> Result<(), String> {
    if let Some(raw) = raw {
        let kind = match raw.kind {
            0 => REG_NONE,
            1 => REG_SZ,
            2 => REG_EXPAND_SZ,
            3 => REG_BINARY,
            4 => REG_DWORD,
            5 => REG_DWORD_BIG_ENDIAN,
            6 => return Err("Registry link values cannot be restored by this operation".into()),
            7 => REG_MULTI_SZ,
            8 => REG_RESOURCE_LIST,
            9 => REG_FULL_RESOURCE_DESCRIPTOR,
            10 => REG_RESOURCE_REQUIREMENTS_LIST,
            11 => REG_QWORD,
            _ => return Err("Unsupported registry type".into()),
        };
        if raw.bytes.len() > 32768 {
            return Err("Registry value exceeds limit".into());
        }
        key.set_raw_value(
            name,
            &RegValue {
                bytes: raw.bytes.clone().into(),
                vtype: kind,
            },
        )
        .map_err(|e| e.to_string())
    } else {
        match key.delete_value(name) {
            Ok(()) => Ok(()),
            Err(error) if error.raw_os_error() == Some(2) => Ok(()),
            Err(error) => Err(error.to_string()),
        }
    }
}
