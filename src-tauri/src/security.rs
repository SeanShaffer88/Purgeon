//! Native checks shared by filesystem mutations. Reparse points are rejected,
//! including ancestors, rather than relying on renderer path spelling.
use std::fs;
use std::os::windows::fs::MetadataExt;
use std::path::{Component, Path};

pub fn checked_path(path: &str) -> Result<(), String> {
    let p = Path::new(path);
    if !p.is_absolute()
        || path.starts_with("\\\\")
        || path.contains('\0')
        || path.get(2..3) != Some("\\")
        || p.components()
            .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
        || path.get(2..).unwrap_or("").contains(':')
    {
        return Err("Use an absolute local path without traversal or alternate streams".into());
    }
    let n = path.trim_end_matches('\\').to_lowercase();
    if n.len() <= 3 {
        return Err("Drive roots are protected".into());
    }
    for segment in path.get(3..).unwrap_or("").split('\\') {
        let base = segment.split('.').next().unwrap_or("").to_ascii_lowercase();
        if segment.is_empty()
            || segment.ends_with(['.', ' '])
            || segment.contains('/')
            || ["con", "prn", "aux", "nul", "conin$", "conout$"].contains(&base.as_str())
            || ((base.starts_with("com") || base.starts_with("lpt"))
                && base.len() == 4
                && base.as_bytes()[3].is_ascii_digit())
        {
            return Err("Windows path aliases are not accepted for mutations".into());
        }
    }
    for name in [
        "SystemRoot",
        "windir",
        "USERPROFILE",
        "PUBLIC",
        "ProgramFiles",
        "ProgramFiles(x86)",
        "ProgramData",
        "APPDATA",
        "LOCALAPPDATA",
    ] {
        if let Ok(value) = std::env::var(name) {
            let v = value.trim_end_matches('\\').to_lowercase();
            if n == v
                || (name == "USERPROFILE"
                    && ["\\documents", "\\desktop", "\\appdata"]
                        .iter()
                        .any(|suffix| n == format!("{v}{suffix}")))
                || (["SystemRoot", "windir"].contains(&name) && n.starts_with(&(v + "\\")))
            {
                return Err("Protected Windows location".into());
            }
        }
    }
    if n.get(2..)
        .is_some_and(|s| s == "\\windows" || s.starts_with("\\windows\\"))
    {
        return Err("Protected Windows location".into());
    }
    for ancestor in p.ancestors() {
        match fs::symlink_metadata(ancestor) {
            Ok(m) if m.file_attributes() & 0x400 != 0 => {
                return Err("Reparse points are not accepted for mutations".into())
            }
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(())
}

pub fn verify_handle_path(file: &fs::File, expected: &str) -> Result<(), String> {
    use std::os::windows::io::AsRawHandle;
    #[link(name = "kernel32")]
    extern "system" {
        fn GetFinalPathNameByHandleW(
            handle: *mut std::ffi::c_void,
            path: *mut u16,
            length: u32,
            flags: u32,
        ) -> u32;
    }
    let mut buffer = vec![0u16; 32768];
    let size = unsafe {
        GetFinalPathNameByHandleW(
            file.as_raw_handle(),
            buffer.as_mut_ptr(),
            buffer.len() as u32,
            0,
        )
    };
    if size == 0 || size as usize >= buffer.len() {
        return Err("Could not verify opened file identity".into());
    }
    let final_path = String::from_utf16_lossy(&buffer[..size as usize]);
    if !final_path
        .trim_start_matches("\\\\?\\")
        .eq_ignore_ascii_case(expected)
    {
        return Err("Opened file resolves outside the approved path".into());
    }
    checked_path(expected)
}

#[repr(C)]
struct Blob {
    len: u32,
    data: *mut u8,
}
#[link(name = "crypt32")]
extern "system" {
    fn CryptProtectData(
        input: *const Blob,
        description: *const u16,
        entropy: *const Blob,
        reserved: *mut std::ffi::c_void,
        prompt: *mut std::ffi::c_void,
        flags: u32,
        out: *mut Blob,
    ) -> i32;
    fn CryptUnprotectData(
        input: *const Blob,
        description: *mut *mut u16,
        entropy: *const Blob,
        reserved: *mut std::ffi::c_void,
        prompt: *mut std::ffi::c_void,
        flags: u32,
        out: *mut Blob,
    ) -> i32;
}
#[link(name = "kernel32")]
extern "system" {
    fn LocalFree(memory: *mut std::ffi::c_void) -> *mut std::ffi::c_void;
}

pub fn protect(bytes: &[u8], decrypt: bool) -> Result<Vec<u8>, String> {
    if bytes.len() > 65536 {
        return Err("Secret exceeds size limit".into());
    }
    let input = Blob {
        len: bytes.len() as u32,
        data: bytes.as_ptr() as *mut u8,
    };
    let mut out = Blob {
        len: 0,
        data: std::ptr::null_mut(),
    };
    let ok = unsafe {
        if decrypt {
            CryptUnprotectData(
                &input,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                1,
                &mut out,
            )
        } else {
            CryptProtectData(
                &input,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                1,
                &mut out,
            )
        }
    };
    if ok == 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    let result = if out.len == 0 {
        Vec::new()
    } else if out.data.is_null() {
        return Err("Windows returned invalid protected data".into());
    } else {
        unsafe { std::slice::from_raw_parts(out.data, out.len as usize).to_vec() }
    };
    unsafe {
        LocalFree(out.data.cast());
    }
    Ok(result)
}

/// A kill-on-close job bounds the lifetime of a PowerShell command and descendants.
/// Assignment follows std::process spawn; no claim of sandbox isolation is made.
pub struct ProcessJob(*mut std::ffi::c_void);
impl ProcessJob {
    pub fn assign(child: &std::process::Child) -> Result<Self, String> {
        use std::os::windows::io::AsRawHandle;
        #[repr(C)]
        struct Basic {
            process_time: i64,
            job_time: i64,
            flags: u32,
            min_working_set: usize,
            max_working_set: usize,
            active_processes: u32,
            affinity: usize,
            priority: u32,
            scheduling: u32,
        }
        #[repr(C)]
        struct Limits {
            basic: Basic,
            io: [u64; 6],
            process_memory: usize,
            job_memory: usize,
            peak_process_memory: usize,
            peak_job_memory: usize,
        }
        #[link(name = "kernel32")]
        extern "system" {
            fn CreateJobObjectW(
                attributes: *const std::ffi::c_void,
                name: *const u16,
            ) -> *mut std::ffi::c_void;
            fn SetInformationJobObject(
                job: *mut std::ffi::c_void,
                class: i32,
                info: *const std::ffi::c_void,
                length: u32,
            ) -> i32;
            fn AssignProcessToJobObject(
                job: *mut std::ffi::c_void,
                process: *mut std::ffi::c_void,
            ) -> i32;
        }
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err(std::io::Error::last_os_error().to_string());
        }
        let job = Self(handle);
        let mut limits: Limits = unsafe { std::mem::zeroed() };
        limits.basic.flags = 0x2000;
        if unsafe {
            SetInformationJobObject(
                handle,
                9,
                (&limits as *const Limits).cast(),
                std::mem::size_of::<Limits>() as u32,
            )
        } == 0
            || unsafe { AssignProcessToJobObject(handle, child.as_raw_handle()) } == 0
        {
            return Err(std::io::Error::last_os_error().to_string());
        }
        Ok(job)
    }
}
impl Drop for ProcessJob {
    fn drop(&mut self) {
        #[link(name = "kernel32")]
        extern "system" {
            fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
        }
        unsafe {
            CloseHandle(self.0);
        }
    }
}
