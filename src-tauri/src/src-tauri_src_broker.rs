//! First typed privilege-broker slice: process controls only.
//! The elevated helper has no webview and accepts no script or executable payload.
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::ffi::c_void;
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

pub(crate) type Handle = *mut c_void;
const INVALID: Handle = -1isize as Handle;
const QUERY: u32 = 0x1000;
const MAX_MESSAGE: usize = 256 * 1024;
const PIPE_PREFIX: &str = "\\\\.\\pipe\\Purgeon-";
const TIMEOUT: u32 = 60000;

#[repr(C)]
struct FileTime {
    low: u32,
    high: u32,
}
#[repr(C)]
struct Overlapped {
    internal: usize,
    internal_high: usize,
    offset: u64,
    event: Handle,
}
#[repr(C)]
struct SecurityAttributes {
    size: u32,
    descriptor: Handle,
    inherit: i32,
}
#[repr(C)]
struct ShellInfo {
    size: u32,
    mask: u32,
    window: Handle,
    verb: *const u16,
    file: *const u16,
    parameters: *const u16,
    directory: *const u16,
    show: i32,
    instance: Handle,
    item_list: Handle,
    class: *const u16,
    class_key: Handle,
    hot_key: u32,
    icon: Handle,
    process: Handle,
}

#[link(name = "kernel32")]
extern "system" {
    fn CloseHandle(handle: Handle) -> i32;
    fn OpenProcess(access: u32, inherit: i32, pid: u32) -> Handle;
    fn GetCurrentProcess() -> Handle;
    fn GetProcessId(handle: Handle) -> u32;
    fn GetProcessTimes(
        handle: Handle,
        created: *mut FileTime,
        exit: *mut FileTime,
        kernel: *mut FileTime,
        user: *mut FileTime,
    ) -> i32;
    fn QueryFullProcessImageNameW(
        handle: Handle,
        flags: u32,
        name: *mut u16,
        size: *mut u32,
    ) -> i32;
    fn IsProcessCritical(handle: Handle, critical: *mut i32) -> i32;
    fn TerminateProcess(handle: Handle, exit: u32) -> i32;
    fn GetPriorityClass(handle: Handle) -> u32;
    fn SetPriorityClass(handle: Handle, priority: u32) -> i32;
    fn SetProcessAffinityMask(handle: Handle, mask: usize) -> i32;
    fn CreateNamedPipeW(
        name: *const u16,
        open: u32,
        mode: u32,
        instances: u32,
        out_size: u32,
        in_size: u32,
        timeout: u32,
        attributes: *const SecurityAttributes,
    ) -> Handle;
    fn ConnectNamedPipe(pipe: Handle, overlapped: *mut Overlapped) -> i32;
    fn GetNamedPipeClientProcessId(pipe: Handle, pid: *mut u32) -> i32;
    fn GetNamedPipeServerProcessId(pipe: Handle, pid: *mut u32) -> i32;
    fn WaitNamedPipeW(name: *const u16, timeout: u32) -> i32;
    fn CreateFileW(
        name: *const u16,
        access: u32,
        share: u32,
        attributes: Handle,
        creation: u32,
        flags: u32,
        template: Handle,
    ) -> Handle;
    fn CreateEventW(attributes: Handle, manual: i32, initial: i32, name: *const u16) -> Handle;
    fn ReadFile(
        file: Handle,
        buffer: *mut u8,
        count: u32,
        read: *mut u32,
        overlapped: *mut Overlapped,
    ) -> i32;
    fn WriteFile(
        file: Handle,
        buffer: *const u8,
        count: u32,
        written: *mut u32,
        overlapped: *mut Overlapped,
    ) -> i32;
    fn GetOverlappedResult(
        file: Handle,
        overlapped: *mut Overlapped,
        transferred: *mut u32,
        wait: i32,
    ) -> i32;
    fn CancelIoEx(file: Handle, overlapped: *mut Overlapped) -> i32;
    fn WaitForSingleObject(handle: Handle, timeout: u32) -> u32;
    fn CreateMutexExW(
        attributes: *const SecurityAttributes,
        name: *const u16,
        flags: u32,
        access: u32,
    ) -> Handle;
    fn ReleaseMutex(handle: Handle) -> i32;
    fn LocalFree(memory: Handle) -> Handle;
}
#[link(name = "advapi32")]
extern "system" {
    fn OpenProcessToken(process: Handle, access: u32, token: *mut Handle) -> i32;
    fn GetTokenInformation(
        token: Handle,
        class: u32,
        info: Handle,
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
}
#[link(name = "bcrypt")]
extern "system" {
    fn BCryptGenRandom(algorithm: Handle, buffer: *mut u8, size: u32, flags: u32) -> i32;
}
#[link(name = "shell32")]
extern "system" {
    fn ShellExecuteExW(info: *mut ShellInfo) -> i32;
}
#[link(name = "user32")]
extern "system" {
    fn MessageBoxW(window: Handle, text: *const u16, title: *const u16, kind: u32) -> i32;
}
#[link(name = "ntdll")]
extern "system" {
    fn NtSuspendProcess(process: Handle) -> i32;
    fn NtResumeProcess(process: Handle) -> i32;
}

pub(crate) struct Owned(pub(crate) Handle);
impl Owned {
    fn new(handle: Handle) -> Result<Self, String> {
        if handle.is_null() || handle == INVALID {
            Err(last_error())
        } else {
            Ok(Self(handle))
        }
    }
}
impl Drop for Owned {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}
fn last_error() -> String {
    std::io::Error::last_os_error().to_string()
}
fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(Some(0)).collect()
}
fn bool_result(ok: i32) -> Result<(), String> {
    if ok == 0 {
        Err(last_error())
    } else {
        Ok(())
    }
}
pub(crate) fn random_id() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    if unsafe { BCryptGenRandom(std::ptr::null_mut(), bytes.as_mut_ptr(), 16, 2) } < 0 {
        return Err("Windows random generator failed".into());
    }
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

static PLAN_BUDGET: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();
pub(crate) fn reserve_plan() -> Result<String, String> {
    let mut entries = PLAN_BUDGET
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .map_err(|e| e.to_string())?;
    entries.retain(|_, instant| instant.elapsed() < Duration::from_secs(120));
    if entries.len() >= 32 {
        return Err("Too many pending native operations".into());
    }
    let id = random_id()?;
    entries.insert(id.clone(), Instant::now());
    Ok(id)
}
pub(crate) fn consume_plan(id: &str) -> Result<(), String> {
    let instant = PLAN_BUDGET
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .map_err(|e| e.to_string())?
        .remove(id)
        .ok_or("Native plan is missing or already used")?;
    if instant.elapsed() >= Duration::from_secs(120) {
        return Err("Native plan expired".into());
    }
    Ok(())
}
pub(crate) fn current_sid() -> Result<String, String> {
    sid_for_process(unsafe { GetCurrentProcess() })
}
pub(crate) fn process_sid(pid: u32) -> Result<String, String> {
    let process = open_process(pid, QUERY)?;
    sid_for_process(process.0)
}
pub(crate) fn require_live_parent(pid: u32) -> Result<(), String> {
    let parent = open_process(pid, 0x100000)?;
    if unsafe { WaitForSingleObject(parent.0, 0) } != 258 {
        return Err("Broker parent is no longer running".into());
    }
    Ok(())
}
pub(crate) struct DomainLease(Owned);
impl Drop for DomainLease {
    fn drop(&mut self) {
        unsafe {
            ReleaseMutex(self.0 .0);
        }
    }
}
pub(crate) fn domain_lease(sid: &str) -> Result<DomainLease, String> {
    if !sid.starts_with("S-") || !sid[2..].bytes().all(|b| b.is_ascii_digit() || b == b'-') {
        return Err("Invalid operation-lock identity".into());
    }
    // Coordination only, never an authorization source. All authenticated callers
    // share one lease because different users can affect the same HKLM resource.
    let sddl = wide("D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;0x00100001;;;AU)");
    let mut descriptor = std::ptr::null_mut();
    bool_result(unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            1,
            &mut descriptor,
            std::ptr::null_mut(),
        )
    })?;
    let attributes = SecurityAttributes {
        size: std::mem::size_of::<SecurityAttributes>() as u32,
        descriptor,
        inherit: 0,
    };
    let name = wide("Global\\Purgeon-NativeMutation-v1");
    let mutex = Owned::new(unsafe { CreateMutexExW(&attributes, name.as_ptr(), 0, 0x00100001) });
    unsafe {
        LocalFree(descriptor);
    }
    let mutex = mutex?;
    match unsafe { WaitForSingleObject(mutex.0, 0) } {
        0 | 128 => Ok(DomainLease(mutex)),
        258 => Err("Another native mutation is active; try again after it finishes".into()),
        _ => Err(std::io::Error::last_os_error().to_string()),
    }
}
fn sid_for_process(process: Handle) -> Result<String, String> {
    let token = token(process)?;
    let mut needed = 0;
    unsafe {
        GetTokenInformation(token.0, 1, std::ptr::null_mut(), 0, &mut needed);
    }
    if needed == 0 || needed > 65536 {
        return Err("Could not read caller identity".into());
    }
    let mut bytes = vec![0usize; (needed as usize).div_ceil(std::mem::size_of::<usize>())];
    bool_result(unsafe {
        GetTokenInformation(token.0, 1, bytes.as_mut_ptr().cast(), needed, &mut needed)
    })?;
    #[repr(C)]
    struct TokenUser {
        sid: Handle,
        attributes: u32,
    }
    let user = unsafe { &*(bytes.as_ptr().cast::<TokenUser>()) };
    let mut text = std::ptr::null_mut();
    bool_result(unsafe { ConvertSidToStringSidW(user.sid, &mut text) })?;
    let mut len = 0;
    while len < 256 && unsafe { *text.add(len) } != 0 {
        len += 1;
    }
    let sid = String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(text, len) });
    unsafe {
        LocalFree(text.cast());
    }
    if len >= 256 || !sid.starts_with("S-") {
        return Err("Invalid caller identity".into());
    }
    Ok(sid)
}
pub(crate) fn is_elevated() -> Result<bool, String> {
    elevated(unsafe { GetCurrentProcess() })
}
pub(crate) fn confirm_native(text: &str) -> Result<(), String> {
    let text = wide(text);
    let title = wide("Purgeon — confirm exact system changes");
    if unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            text.as_ptr(),
            title.as_ptr(),
            4 | 0x100 | 0x30,
        )
    } != 6
    {
        return Err("USER_CANCELLED: operation was cancelled".into());
    }
    Ok(())
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub enum Priority {
    Idle,
    BelowNormal,
    Normal,
    AboveNormal,
    High,
}
impl Priority {
    fn value(&self) -> u32 {
        match self {
            Self::Idle => 0x40,
            Self::BelowNormal => 0x4000,
            Self::Normal => 0x20,
            Self::AboveNormal => 0x8000,
            Self::High => 0x80,
        }
    }
    fn name(value: u32) -> Option<String> {
        match value {
            0x40 => Some("Idle"),
            0x4000 => Some("BelowNormal"),
            0x20 => Some("Normal"),
            0x8000 => Some("AboveNormal"),
            0x80 => Some("High"),
            _ => None,
        }
        .map(str::to_string)
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum ProcessAction {
    End,
    Suspend,
    Resume,
    Priority { level: Priority },
    Affinity { mask: String },
}
impl ProcessAction {
    fn access(&self) -> u32 {
        match self {
            Self::End => 1,
            Self::Suspend | Self::Resume => 0x800,
            Self::Priority { .. } | Self::Affinity { .. } => 0x200,
        }
    }
    fn description(&self) -> String {
        match self {
            Self::End => "End this process immediately; unsaved work can be lost".into(),
            Self::Suspend => "Suspend this process until resumed".into(),
            Self::Resume => "Resume this process".into(),
            Self::Priority { level } => format!(
                "Set priority to {}",
                Priority::name(level.value()).unwrap_or_default()
            ),
            Self::Affinity { mask } => format!("Set processor affinity mask to {mask}"),
        }
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProcessRequest {
    pub pid: u32,
    pub creation_time: String,
    pub action: ProcessAction,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessPlan {
    pub id: String,
    pub pid: u32,
    pub creation_time: String,
    pub image: String,
    pub summary: String,
    pub requires_elevation: bool,
    pub expires_in_seconds: u32,
}
struct Pending {
    request: ProcessRequest,
    image: String,
    prepared: Instant,
}
static PLANS: OnceLock<Mutex<HashMap<String, Pending>>> = OnceLock::new();
fn plans() -> &'static Mutex<HashMap<String, Pending>> {
    PLANS.get_or_init(|| Mutex::new(HashMap::new()))
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Envelope {
    request: ProcessRequest,
    image: String,
    parent_pid: u32,
    deadline_utc_ms: u64,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProcessResult {
    pub ok: bool,
    pub previous_priority: Option<String>,
    pub error: Option<String>,
}
#[derive(Serialize, Deserialize)]
#[serde(tag = "phase", rename_all = "camelCase", deny_unknown_fields)]
enum HelperMessage {
    Ready,
    Result { result: ProcessResult },
}

fn validate(request: &ProcessRequest) -> Result<(), String> {
    if request.pid <= 4
        || request.pid == std::process::id()
        || request.creation_time.len() > 20
        || !request.creation_time.bytes().all(|b| b.is_ascii_digit())
        || request.creation_time.parse::<u64>().unwrap_or(0) == 0
    {
        return Err("Invalid or protected process identity".into());
    }
    if let ProcessAction::Affinity { mask } = &request.action {
        if mask.len() > 20 || mask.parse::<u64>().unwrap_or(0) == 0 {
            return Err("Invalid affinity mask".into());
        }
    }
    if serde_json::to_vec(request)
        .map_err(|e| e.to_string())?
        .len()
        > MAX_MESSAGE
    {
        return Err("Process request exceeds size limit".into());
    }
    Ok(())
}
fn open_process(pid: u32, access: u32) -> Result<Owned, String> {
    Owned::new(unsafe { OpenProcess(access | QUERY, 0, pid) })
}
fn image_name(process: Handle) -> Result<String, String> {
    let mut buffer = vec![0u16; 32768];
    let mut size = buffer.len() as u32;
    bool_result(unsafe { QueryFullProcessImageNameW(process, 0, buffer.as_mut_ptr(), &mut size) })?;
    if size == 0 || size as usize >= buffer.len() {
        return Err("Invalid process image identity".into());
    }
    Ok(String::from_utf16_lossy(&buffer[..size as usize]))
}
fn creation_time(process: Handle) -> Result<u64, String> {
    let mut created = FileTime { low: 0, high: 0 };
    let mut exit = FileTime { low: 0, high: 0 };
    let mut kernel = FileTime { low: 0, high: 0 };
    let mut user = FileTime { low: 0, high: 0 };
    bool_result(unsafe {
        GetProcessTimes(process, &mut created, &mut exit, &mut kernel, &mut user)
    })?;
    Ok(((created.high as u64) << 32) | created.low as u64)
}
fn verify_process(
    process: Handle,
    request: &ProcessRequest,
    expected_image: Option<&str>,
    parent_pid: u32,
) -> Result<String, String> {
    if request.pid == parent_pid || request.pid == std::process::id() {
        return Err("Purgeon cannot act on itself".into());
    }
    if unsafe { GetProcessId(process) } != request.pid
        || creation_time(process)?.to_string() != request.creation_time
    {
        return Err("The process identity changed. Refresh the process list.".into());
    }
    let mut critical = 0;
    bool_result(unsafe { IsProcessCritical(process, &mut critical) })?;
    if critical != 0 {
        return Err("Windows critical processes cannot be changed".into());
    }
    let image = image_name(process)?;
    let name = Path::new(&image)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if name.starts_with("purgeon")
        || [
            "system",
            "registry",
            "smss",
            "csrss",
            "wininit",
            "winlogon",
            "services",
            "lsass",
            "svchost",
            "fontdrvhost",
            "dwm",
            "memcompression",
        ]
        .contains(&name.as_str())
    {
        return Err("Protected Windows or Purgeon process".into());
    }
    if expected_image.is_some_and(|expected| !image.eq_ignore_ascii_case(expected)) {
        return Err("The process image changed".into());
    }
    Ok(image)
}
pub fn prepare(request: ProcessRequest) -> Result<ProcessPlan, String> {
    validate(&request)?;
    let process = open_process(request.pid, QUERY)?;
    let image = verify_process(process.0, &request, None, std::process::id())?;
    let requires_elevation = open_process(request.pid, request.action.access()).is_err();
    let id = reserve_plan()?;
    let result = ProcessPlan {
        id: id.clone(),
        pid: request.pid,
        creation_time: request.creation_time.clone(),
        image: image.clone(),
        summary: request.action.description(),
        requires_elevation,
        expires_in_seconds: 120,
    };
    let mut pending = plans().lock().map_err(|e| e.to_string())?;
    pending.retain(|_, plan| plan.prepared.elapsed() < Duration::from_secs(120));
    if pending.len() >= 32 {
        return Err("Too many pending operations; close unused reviews or wait for expiry".into());
    }
    pending.insert(
        id,
        Pending {
            request,
            image,
            prepared: Instant::now(),
        },
    );
    Ok(result)
}
fn consent(request: &ProcessRequest, image: &str) -> Result<(), String> {
    let text = wide(&format!(
        "{}\n\n{}\nPID: {}\nCreation identity: {}\n\nContinue with exactly this operation?",
        request.action.description(),
        image,
        request.pid,
        request.creation_time
    ));
    let title = wide("Purgeon — confirm process operation");
    if unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            text.as_ptr(),
            title.as_ptr(),
            4 | 0x100 | 0x30,
        )
    } != 6
    {
        return Err("USER_CANCELLED: process operation was cancelled".into());
    }
    Ok(())
}
fn execute_request(
    envelope: &Envelope,
    before_commit: impl FnOnce() -> Result<(), String>,
) -> Result<ProcessResult, String> {
    validate(&envelope.request)?;
    let process = open_process(envelope.request.pid, envelope.request.action.access())?;
    verify_process(
        process.0,
        &envelope.request,
        Some(&envelope.image),
        envelope.parent_pid,
    )?;
    consent(&envelope.request, &envelope.image)?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis() as u64;
    if now > envelope.deadline_utc_ms || envelope.deadline_utc_ms.saturating_sub(now) > 120000 {
        return Err("Operation plan expired during consent".into());
    }
    before_commit()?; // Never commit after the authenticated parent timed out.
                      // The same opened handle is reverified after consent and used for the mutation.
    verify_process(
        process.0,
        &envelope.request,
        Some(&envelope.image),
        envelope.parent_pid,
    )?;
    let previous_priority = Priority::name(unsafe { GetPriorityClass(process.0) });
    match &envelope.request.action {
        ProcessAction::End => bool_result(unsafe { TerminateProcess(process.0, 1) })?,
        ProcessAction::Suspend => {
            if unsafe { NtSuspendProcess(process.0) } < 0 {
                return Err("Windows refused to suspend the process".into());
            }
        }
        ProcessAction::Resume => {
            if unsafe { NtResumeProcess(process.0) } < 0 {
                return Err("Windows refused to resume the process".into());
            }
        }
        ProcessAction::Priority { level } => {
            bool_result(unsafe { SetPriorityClass(process.0, level.value()) })?
        }
        ProcessAction::Affinity { mask } => bool_result(unsafe {
            SetProcessAffinityMask(
                process.0,
                mask.parse::<u64>().map_err(|e| e.to_string())? as usize,
            )
        })?,
    }
    Ok(ProcessResult {
        ok: true,
        previous_priority,
        error: None,
    })
}

fn token(process: Handle) -> Result<Owned, String> {
    let mut handle = std::ptr::null_mut();
    bool_result(unsafe { OpenProcessToken(process, 8, &mut handle) })?;
    Owned::new(handle)
}
fn elevated(process: Handle) -> Result<bool, String> {
    let token = token(process)?;
    let mut elevation = 0u32;
    let mut needed = 0;
    bool_result(unsafe {
        GetTokenInformation(
            token.0,
            20,
            (&mut elevation as *mut u32).cast(),
            4,
            &mut needed,
        )
    })?;
    Ok(elevation != 0)
}
fn pipe_security() -> Result<Handle, String> {
    let token = token(unsafe { GetCurrentProcess() })?;
    let mut needed = 0;
    unsafe {
        GetTokenInformation(token.0, 28, std::ptr::null_mut(), 0, &mut needed);
    }
    if needed == 0 || needed > 65536 {
        return Err("Could not obtain logon identity".into());
    }
    // Vec<usize> preserves native pointer alignment for TOKEN_GROUPS.
    let mut data = vec![0usize; (needed as usize).div_ceil(std::mem::size_of::<usize>())];
    bool_result(unsafe {
        GetTokenInformation(token.0, 28, data.as_mut_ptr().cast(), needed, &mut needed)
    })?;
    #[repr(C)]
    struct SidAndAttributes {
        sid: Handle,
        attributes: u32,
    }
    #[repr(C)]
    struct Groups {
        count: u32,
        groups: [SidAndAttributes; 1],
    }
    let groups = unsafe { &*(data.as_ptr().cast::<Groups>()) };
    if groups.count != 1 {
        return Err("Expected one Windows logon SID".into());
    }
    let mut sid_text = std::ptr::null_mut();
    bool_result(unsafe { ConvertSidToStringSidW(groups.groups[0].sid, &mut sid_text) })?;
    let mut len = 0;
    while len < 256 && unsafe { *sid_text.add(len) } != 0 {
        len += 1;
    }
    let sid = String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(sid_text, len) });
    unsafe {
        LocalFree(sid_text.cast());
    }
    if len >= 256 || !sid.starts_with("S-1-5-5-") {
        return Err("Unexpected Windows logon SID".into());
    }
    let sddl = wide(&format!("D:P(A;;GA;;;{sid})"));
    let mut descriptor = std::ptr::null_mut();
    bool_result(unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            1,
            &mut descriptor,
            std::ptr::null_mut(),
        )
    })?;
    Ok(descriptor)
}
fn event() -> Result<Owned, String> {
    Owned::new(unsafe { CreateEventW(std::ptr::null_mut(), 1, 0, std::ptr::null()) })
}
fn finish_io(pipe: Handle, overlapped: &mut Overlapped, pending: bool) -> Result<u32, String> {
    finish_io_until(
        pipe,
        overlapped,
        pending,
        Instant::now() + Duration::from_millis(TIMEOUT as u64),
    )
}
fn finish_io_until(
    pipe: Handle,
    overlapped: &mut Overlapped,
    pending: bool,
    deadline: Instant,
) -> Result<u32, String> {
    let timeout = deadline
        .saturating_duration_since(Instant::now())
        .as_millis()
        .min(TIMEOUT as u128) as u32;
    if pending && unsafe { WaitForSingleObject(overlapped.event, timeout) } != 0 {
        unsafe {
            CancelIoEx(pipe, overlapped);
        }
        let mut ignored = 0;
        unsafe {
            GetOverlappedResult(pipe, overlapped, &mut ignored, 1);
        }
        return Err("Broker connection timed out".into());
    }
    let mut transferred = 0;
    bool_result(unsafe { GetOverlappedResult(pipe, overlapped, &mut transferred, 0) })?;
    Ok(transferred)
}
fn transfer(
    pipe: Handle,
    bytes: &mut [u8],
    writing: bool,
    deadline: Instant,
) -> Result<(), String> {
    let mut offset = 0;
    while offset < bytes.len() {
        if Instant::now() >= deadline {
            return Err("Broker operation deadline exceeded".into());
        }
        let ready = event()?;
        let mut overlapped = Overlapped {
            internal: 0,
            internal_high: 0,
            offset: 0,
            event: ready.0,
        };
        let mut amount = 0;
        let ok = unsafe {
            if writing {
                WriteFile(
                    pipe,
                    bytes[offset..].as_ptr(),
                    (bytes.len() - offset) as u32,
                    &mut amount,
                    &mut overlapped,
                )
            } else {
                ReadFile(
                    pipe,
                    bytes[offset..].as_mut_ptr(),
                    (bytes.len() - offset) as u32,
                    &mut amount,
                    &mut overlapped,
                )
            }
        };
        let pending = ok == 0;
        if pending && std::io::Error::last_os_error().raw_os_error() != Some(997) {
            return Err(last_error());
        }
        let amount = finish_io_until(pipe, &mut overlapped, pending, deadline)? as usize;
        if amount == 0 || amount > bytes.len() - offset {
            return Err("Broker pipe closed or returned invalid length".into());
        }
        offset += amount;
    }
    Ok(())
}
pub(crate) fn send<T: Serialize>(pipe: Handle, value: &T) -> Result<(), String> {
    send_until(
        pipe,
        value,
        Instant::now() + Duration::from_millis(TIMEOUT as u64),
    )
}
pub(crate) fn send_until<T: Serialize>(
    pipe: Handle,
    value: &T,
    deadline: Instant,
) -> Result<(), String> {
    let mut data = serde_json::to_vec(value).map_err(|e| e.to_string())?;
    if data.len() > MAX_MESSAGE {
        return Err("Broker payload exceeds limit".into());
    }
    transfer(pipe, &mut (data.len() as u32).to_le_bytes(), true, deadline)?;
    transfer(pipe, &mut data, true, deadline)
}
pub(crate) fn receive<T: for<'de> Deserialize<'de>>(pipe: Handle) -> Result<T, String> {
    receive_until(pipe, Instant::now() + Duration::from_millis(TIMEOUT as u64))
}
pub(crate) fn receive_until<T: for<'de> Deserialize<'de>>(
    pipe: Handle,
    deadline: Instant,
) -> Result<T, String> {
    let mut length = [0u8; 4];
    transfer(pipe, &mut length, false, deadline)?;
    let size = u32::from_le_bytes(length) as usize;
    if size == 0 || size > MAX_MESSAGE {
        return Err("Broker payload exceeds limit".into());
    }
    let mut data = vec![0u8; size];
    transfer(pipe, &mut data, false, deadline)?;
    serde_json::from_slice(&data).map_err(|e| e.to_string())
}
fn launch_elevated(parameters: &str) -> Result<Owned, String> {
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    let file = wide(&executable.to_string_lossy());
    let verb = wide("runas");
    let parameters = wide(parameters);
    let directory = wide(
        &executable
            .parent()
            .ok_or("Executable has no directory")?
            .to_string_lossy(),
    );
    let mut info: ShellInfo = unsafe { std::mem::zeroed() };
    info.size = std::mem::size_of::<ShellInfo>() as u32;
    info.mask = 0x40 | 0x100;
    info.verb = verb.as_ptr();
    info.file = file.as_ptr();
    info.parameters = parameters.as_ptr();
    info.directory = directory.as_ptr();
    info.show = 0;
    if unsafe { ShellExecuteExW(&mut info) } == 0 {
        return Err(
            if std::io::Error::last_os_error().raw_os_error() == Some(1223) {
                "USER_CANCELLED: administrator permission was cancelled".into()
            } else {
                last_error()
            },
        );
    }
    Owned::new(info.process)
}
pub(crate) enum HelperKind {
    Debloat,
    Restore,
    EventLogs,
}
pub(crate) fn launch_domain_helper(kind: HelperKind, pipe_name: &str) -> Result<Owned, String> {
    let mode = match kind {
        HelperKind::Debloat => "--debloat-broker",
        HelperKind::Restore => "--restore-broker",
        HelperKind::EventLogs => "--operation-broker",
    };
    launch_elevated(&format!("{mode} {pipe_name}"))
}
pub(crate) fn server_pipe(pipe_name: &str) -> Result<Owned, String> {
    let name = wide(pipe_name);
    let descriptor = pipe_security()?;
    let attributes = SecurityAttributes {
        size: std::mem::size_of::<SecurityAttributes>() as u32,
        descriptor,
        inherit: 0,
    };
    let pipe = Owned::new(unsafe {
        CreateNamedPipeW(
            name.as_ptr(),
            3 | 0x40000000 | 0x80000,
            8,
            1,
            65536,
            65536,
            TIMEOUT,
            &attributes,
        )
    });
    unsafe {
        LocalFree(descriptor);
    }
    pipe
}
pub(crate) fn accept_pipe(pipe: Handle) -> Result<(), String> {
    let ready = event()?;
    let mut overlapped = Overlapped {
        internal: 0,
        internal_high: 0,
        offset: 0,
        event: ready.0,
    };
    if unsafe { ConnectNamedPipe(pipe, &mut overlapped) } == 0 {
        match std::io::Error::last_os_error().raw_os_error() {
            Some(535) => {}
            Some(997) => {
                finish_io(pipe, &mut overlapped, true)?;
            }
            _ => return Err(last_error()),
        }
    }
    Ok(())
}
pub(crate) fn authenticate_client(pipe: Handle, helper: Handle) -> Result<(), String> {
    let mut pid = 0;
    bool_result(unsafe { GetNamedPipeClientProcessId(pipe, &mut pid) })?;
    if pid != unsafe { GetProcessId(helper) } || !elevated(helper)? {
        return Err("Broker helper authentication failed".into());
    }
    Ok(())
}
pub(crate) fn client_pipe(pipe_name: &str, expected_pid: u32) -> Result<Owned, String> {
    let name = wide(pipe_name);
    bool_result(unsafe { WaitNamedPipeW(name.as_ptr(), TIMEOUT) })?;
    let pipe = Owned::new(unsafe {
        CreateFileW(
            name.as_ptr(),
            0xC0000000,
            0,
            std::ptr::null_mut(),
            3,
            0x40000000,
            std::ptr::null_mut(),
        )
    })?;
    let mut pid = 0;
    bool_result(unsafe { GetNamedPipeServerProcessId(pipe.0, &mut pid) })?;
    if pid != expected_pid {
        return Err("Broker parent PID mismatch".into());
    }
    let parent = open_process(pid, QUERY)?;
    let own = std::env::current_exe().map_err(|e| e.to_string())?;
    if !image_name(parent.0)?.eq_ignore_ascii_case(&own.to_string_lossy()) {
        return Err("Broker parent executable mismatch".into());
    }
    Ok(pipe)
}
fn journal(data: &Path, id: &str, suffix: &str, value: &impl Serialize) -> Result<(), String> {
    use std::io::Write;
    let directory = data.join("broker-journals");
    crate::security::checked_path(&directory.to_string_lossy())?;
    std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let target = directory.join(format!("{id}-{suffix}.json"));
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(target)
        .map_err(|e| e.to_string())?;
    file.write_all(&serde_json::to_vec(value).map_err(|e| e.to_string())?)
        .and_then(|_| file.sync_all())
        .map_err(|e| e.to_string())
}
pub fn execute(id: &str, data: &Path) -> Result<ProcessResult, String> {
    if id.len() != 32 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("Invalid operation plan ID".into());
    }
    consume_plan(id)?;
    let plan = plans()
        .lock()
        .map_err(|e| e.to_string())?
        .remove(id)
        .ok_or("Operation plan is missing or already used")?;
    if plan.prepared.elapsed() > Duration::from_secs(120) {
        return Err("Operation plan expired. Prepare it again.".into());
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis() as u64;
    let remaining = 120000u64.saturating_sub(plan.prepared.elapsed().as_millis() as u64);
    let envelope = Envelope {
        request: plan.request,
        image: plan.image,
        parent_pid: std::process::id(),
        deadline_utc_ms: now.saturating_add(remaining),
    };
    journal(data, id, "intent", &envelope)?;
    let result = execute_envelope(&envelope);
    match &result {
        Ok(reply) => journal(data, id, "result", reply)?,
        Err(error) => journal(
            data,
            id,
            "uncertain-or-cancelled",
            &serde_json::json!({ "error": error, "reviewRequired": true }),
        )?,
    }
    result
}
fn execute_envelope(envelope: &Envelope) -> Result<ProcessResult, String> {
    if open_process(envelope.request.pid, envelope.request.action.access()).is_ok() {
        return execute_request(envelope, || Ok(()));
    }
    let pipe_name = format!("{PIPE_PREFIX}{}-{}", std::process::id(), random_id()?);
    let pipe = server_pipe(&pipe_name)?;
    let helper = launch_elevated(&format!("--broker {pipe_name}"))?;
    accept_pipe(pipe.0)?;
    authenticate_client(pipe.0, helper.0)?;
    send(pipe.0, envelope)?;
    let reply = match receive::<HelperMessage>(pipe.0)? {
        HelperMessage::Result { result } => result,
        HelperMessage::Ready => {
            authenticate_client(pipe.0, helper.0)?;
            send(pipe.0, &true)?;
            match receive::<HelperMessage>(pipe.0)? {
                HelperMessage::Result { result } => result,
                _ => return Err("Unexpected broker commit phase".into()),
            }
        }
    };
    if !reply.ok {
        return Err(reply
            .error
            .unwrap_or_else(|| "Broker operation failed".into()));
    }
    Ok(reply)
}

fn helper(pipe_name: &str) -> Result<(), String> {
    if !elevated(unsafe { GetCurrentProcess() })? {
        return Err("Broker helper requires administrator permission".into());
    }
    let rest = pipe_name
        .strip_prefix(PIPE_PREFIX)
        .ok_or("Invalid broker pipe name")?;
    let (parent, nonce) = rest.split_once('-').ok_or("Invalid broker pipe name")?;
    let expected_pid = parent.parse::<u32>().map_err(|e| e.to_string())?;
    if nonce.len() != 32 || !nonce.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("Invalid broker pipe nonce".into());
    }
    let pipe = client_pipe(pipe_name, expected_pid)?;
    let envelope: Envelope = receive(pipe.0)?;
    if envelope.parent_pid != expected_pid {
        return Err("Broker request parent mismatch".into());
    }
    let reply = match execute_request(&envelope, || {
        send(pipe.0, &HelperMessage::Ready)?;
        if !receive::<bool>(pipe.0)? {
            return Err("Parent declined process commit".into());
        }
        let parent = open_process(expected_pid, 0x100000)?;
        if unsafe { WaitForSingleObject(parent.0, 0) } != 258 {
            return Err("Broker parent is no longer running".into());
        }
        Ok(())
    }) {
        Ok(reply) => reply,
        Err(error) => ProcessResult {
            ok: false,
            previous_priority: None,
            error: Some(error),
        },
    };
    send(pipe.0, &HelperMessage::Result { result: reply })
}

static HANDOFF: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
pub fn application_args() -> Vec<String> {
    if HANDOFF.load(std::sync::atomic::Ordering::SeqCst) {
        Vec::new()
    } else {
        std::env::args().skip(1).collect()
    }
}
pub fn elevate_handoff() -> Result<(), String> {
    let pipe_name = format!("\\\\.\\pipe\\Purgeon-Handoff-{}", std::process::id());
    let pipe = server_pipe(&pipe_name)?;
    let successor = launch_elevated(&format!("--elevation-handoff {}", std::process::id()))?;
    accept_pipe(pipe.0)?;
    authenticate_client(pipe.0, successor.0)?;
    send(pipe.0, &"handoff")?;
    if receive::<String>(pipe.0)? != "ready" {
        return Err("Elevation successor did not acknowledge readiness".into());
    }
    Ok(())
}
/// Called before Tauri, the webview, and the state-directory lock.
pub fn private_mode() -> Result<bool, String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("--broker") => {
            if args.len() != 2 {
                return Err("Invalid broker arguments".into());
            }
            helper(&args[1])?;
            Ok(true)
        }
        Some("--debloat-broker") => {
            if args.len() != 2 {
                return Err("Invalid Debloat broker arguments".into());
            }
            crate::debloat_native::helper(&args[1])?;
            Ok(true)
        }
        Some("--restore-broker") => {
            if args.len() != 2 {
                return Err("Invalid restore broker arguments".into());
            }
            crate::restore_native::helper(&args[1])?;
            Ok(true)
        }
        Some("--operation-broker") => {
            if args.len() != 2 {
                return Err("Invalid native operation helper arguments".into());
            }
            crate::native_operations::helper(&args[1])?;
            Ok(true)
        }
        Some("--elevation-handoff") => {
            if args.len() != 2 || !elevated(unsafe { GetCurrentProcess() })? {
                return Err("Invalid elevation handoff".into());
            }
            let pid = args[1].parse::<u32>().map_err(|e| e.to_string())?;
            if pid == std::process::id() {
                return Err("Invalid predecessor".into());
            }
            match open_process(pid, 0x100000) {
                Ok(parent) => {
                    let own = std::env::current_exe().map_err(|e| e.to_string())?;
                    if !image_name(parent.0)?.eq_ignore_ascii_case(&own.to_string_lossy()) {
                        return Err("Elevation predecessor executable mismatch".into());
                    }
                    let pipe = client_pipe(&format!("\\\\.\\pipe\\Purgeon-Handoff-{pid}"), pid)?;
                    if receive::<String>(pipe.0)? != "handoff" {
                        return Err("Invalid elevation handoff phase".into());
                    }
                    send(pipe.0, &"ready")?;
                    if unsafe { WaitForSingleObject(parent.0, TIMEOUT) } != 0 {
                        return Err("The previous Purgeon instance did not exit. No new operation was started.".into());
                    }
                }
                Err(_) => return Err("Could not verify the elevation predecessor".into()),
            }
            HANDOFF.store(true, std::sync::atomic::Ordering::SeqCst);
            Ok(false)
        }
        _ => Ok(false),
    }
}
