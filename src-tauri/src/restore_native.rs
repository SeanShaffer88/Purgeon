//! Closed restore-point deletion by sequence identity. The elevated helper has
//! no webview, evaluates no caller code, and keeps uncertain deletion evidence.
use crate::{
    broker,
    state_store::{self, Authority, Domain},
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::ffi::c_void;
use std::io::Read;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::process::CommandExt;
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const PIPE_PREFIX: &str = "\\\\.\\pipe\\Purgeon-Restore-";
const INVENTORY: &str = r"$ErrorActionPreference='Stop';$PSModuleAutoloadingPreference='None';[Console]::OutputEncoding=[Text.Encoding]::UTF8
Import-Module -Name ($PSHOME+'\Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop
Import-Module -Name ($PSHOME+'\Modules\CimCmdlets\CimCmdlets.psd1') -ErrorAction Stop
$points=@(CimCmdlets\Get-CimInstance -Namespace root/default -ClassName SystemRestore -ErrorAction Stop | ForEach-Object {
  $time=if ($_.CreationTime -is [datetime]) { $_.CreationTime } else { [System.Management.ManagementDateTimeConverter]::ToDateTime([string]$_.CreationTime) }
  [pscustomobject]@{ sequence=[uint32]$_.SequenceNumber; description=[string]$_.Description; created=$time.ToUniversalTime().ToString('o',[Globalization.CultureInfo]::InvariantCulture) }
});Microsoft.PowerShell.Utility\ConvertTo-Json -InputObject $points -Compress -Depth 3";
const TTL_MS: u64 = 120000;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Point {
    pub sequence: u32,
    pub description: String,
    pub created: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub sequence: u32,
    pub expected_creation_time: String,
    pub expected_description: String,
}
impl Request {
    fn validate(&self) -> Result<(), String> {
        if self.sequence == 0
            || self.expected_creation_time.is_empty()
            || self.expected_creation_time.len() > 128
            || self.expected_description.len() > 1024
            || self.expected_creation_time.contains('\0')
            || self.expected_description.contains('\0')
        {
            return Err(
                "Invalid restore-point identity; refresh the list and select the point again"
                    .into(),
            );
        }
        Ok(())
    }
}
fn matched(points: &[Point], request: &Request) -> Result<(), String> {
    request.validate()?;
    let same: Vec<_> = points
        .iter()
        .filter(|point| point.sequence == request.sequence)
        .collect();
    if same.len() != 1
        || same[0].created != request.expected_creation_time
        || same[0].description != request.expected_description
    {
        return Err("Restore point changed or is missing; refresh and review it again".into());
    }
    Ok(())
}
fn now_ms() -> Result<u64, String> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis() as u64)
}

#[derive(Debug)]
enum InventoryError {
    AccessDenied,
    Other(String),
}
impl From<String> for InventoryError {
    fn from(value: String) -> Self {
        Self::Other(value)
    }
}
impl From<&str> for InventoryError {
    fn from(value: &str) -> Self {
        Self::Other(value.into())
    }
}
impl std::fmt::Display for InventoryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::AccessDenied => {
                f.write_str("Windows denied permission to read System Restore points (0x80041003)")
            }
            Self::Other(error) => f.write_str(error),
        }
    }
}
fn validate_inventory(points: Vec<Point>) -> Result<Vec<Point>, String> {
    if points.len() > 4096
        || points.iter().any(|p| {
            p.sequence == 0
                || p.created.is_empty()
                || p.created.len() > 128
                || p.description.len() > 1024
                || p.created.contains('\0')
                || p.description.contains('\0')
        })
    {
        return Err("Restore inventory exceeds supported bounds".into());
    }
    Ok(points)
}
fn local_inventory() -> Result<Vec<Point>, InventoryError> {
    // Exit 5 is emitted only by the trusted catch block for a native access
    // denial. All other failures are retained; none silently becomes an empty list.
    let script = format!("try {{ {INVENTORY} }} catch {{ if (($_.Exception.GetType().FullName -eq 'Microsoft.Management.Infrastructure.CimException' -and [int]$_.Exception.StatusCode -eq 2) -or $_.Exception.HResult -eq -2147217405 -or $_.Exception.HResult -eq -2147024891) {{ [Console]::Error.WriteLine('Windows denied access to System Restore inventory'); exit 5 }}; [Console]::Error.WriteLine($_.Exception.Message); exit 1 }}");
    let encoded: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    let mut child = Command::new(crate::windows_tools::system_file("powershell.exe")?)
        .env_remove("PSModulePath")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-OutputFormat",
            "Text",
            "-EncodedCommand",
            &STANDARD.encode(encoded),
        ])
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
            return Err(error.into());
        }
    };
    let drain = |pipe: Box<dyn Read + Send>| {
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            pipe.take(512 * 1024 + 1)
                .read_to_end(&mut bytes)
                .map_err(|e| e.to_string())?;
            if bytes.len() > 512 * 1024 {
                return Err("Restore inventory exceeds size limit".to_string());
            }
            Ok(bytes)
        })
    };
    let stdout = drain(Box::new(
        child
            .stdout
            .take()
            .ok_or("Missing restore inventory stdout")?,
    ));
    let stderr = drain(Box::new(
        child
            .stderr
            .take()
            .ok_or("Missing restore inventory stderr")?,
    ));
    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if start.elapsed() < Duration::from_secs(20) => {
                std::thread::sleep(Duration::from_millis(20))
            }
            result => {
                drop(job);
                let _ = child.kill();
                let _ = child.wait();
                return Err(match result {
                    Err(error) => error.to_string(),
                    _ => "Restore inventory timed out".into(),
                }
                .into());
            }
        }
    };
    drop(job);
    let output = stdout
        .join()
        .map_err(|_| "Restore inventory reader failed")??;
    let errors = stderr
        .join()
        .map_err(|_| "Restore inventory error reader failed")??;
    if !status.success() {
        if status.code() == Some(5) {
            return Err(InventoryError::AccessDenied);
        }
        return Err(format!(
            "Windows could not query restore points: {}",
            String::from_utf8_lossy(&errors).trim()
        )
        .into());
    }
    let points: Vec<Point> =
        serde_json::from_slice(&output).map_err(|e| format!("Invalid restore inventory: {e}"))?;
    validate_inventory(points).map_err(InventoryError::Other)
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Envelope {
    request: Request,
    plan_id: String,
    caller_sid: String,
    parent_pid: u32,
    deadline_utc_ms: u64,
}
struct Pending {
    envelope: Envelope,
    prepared: Instant,
}
static PLANS: OnceLock<Mutex<HashMap<String, Pending>>> = OnceLock::new();
fn plans() -> &'static Mutex<HashMap<String, Pending>> {
    PLANS.get_or_init(|| Mutex::new(HashMap::new()))
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanView {
    pub id: String,
    pub summary: String,
    pub requires_elevation: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResultView {
    pub ok: bool,
    pub sequence: u32,
    pub journal_id: String,
}
#[derive(Serialize, Deserialize)]
#[serde(tag = "phase", rename_all = "camelCase", deny_unknown_fields)]
enum Message {
    Ready,
    Inventory {
        points: Option<Vec<Point>>,
        error: Option<String>,
    },
    Result {
        result: Option<ResultView>,
        error: Option<String>,
    },
}
#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum HelperRequest {
    Inventory {
        caller_sid: String,
        parent_pid: u32,
        deadline_utc_ms: u64,
    },
    Remove {
        envelope: Envelope,
    },
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Dispatch {
    request: HelperRequest,
    digest: String,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Reply {
    digest: String,
    message: Message,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Commit {
    digest: String,
    approved: bool,
}
fn digest(request: &HelperRequest) -> Result<String, String> {
    Ok(
        Sha256::digest(serde_json::to_vec(request).map_err(|e| e.to_string())?)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect(),
    )
}
fn reply(pipe: broker::Handle, digest: &str, message: Message) -> Result<(), String> {
    broker::send(
        pipe,
        &Reply {
            digest: digest.into(),
            message,
        },
    )
}
fn receive_reply(pipe: broker::Handle, expected: &str) -> Result<Message, String> {
    let reply: Reply = broker::receive(pipe)?;
    if reply.digest != expected {
        return Err("Restore helper reply binding mismatch".into());
    }
    Ok(reply.message)
}
fn transport(request: HelperRequest) -> Result<Message, String> {
    let hash = digest(&request)?;
    let removing = matches!(request, HelperRequest::Remove { .. });
    let pipe_name = format!(
        "{PIPE_PREFIX}{}-{}",
        std::process::id(),
        broker::random_id()?
    );
    let pipe = broker::server_pipe(&pipe_name)?;
    let helper = broker::launch_domain_helper(broker::HelperKind::Restore, &pipe_name)?;
    broker::accept_pipe(pipe.0)?;
    broker::authenticate_client(pipe.0, helper.0)?;
    broker::send(
        pipe.0,
        &Dispatch {
            request,
            digest: hash.clone(),
        },
    )?;
    match receive_reply(pipe.0, &hash)? {
        Message::Ready if removing => {
            broker::authenticate_client(pipe.0, helper.0)?;
            broker::send(
                pipe.0,
                &Commit {
                    digest: hash.clone(),
                    approved: true,
                },
            )?;
            receive_reply(pipe.0, &hash)
        }
        Message::Ready => Err("Read-only restore request attempted a mutation handshake".into()),
        response => Ok(response),
    }
}
fn inventory_with_fallback(
    local: impl FnOnce() -> Result<Vec<Point>, InventoryError>,
    elevated: impl FnOnce() -> Result<Vec<Point>, String>,
) -> Result<Vec<Point>, String> {
    match local() {
        Ok(points) => validate_inventory(points),
        Err(InventoryError::AccessDenied) => validate_inventory(elevated()?),
        Err(InventoryError::Other(error)) => Err(error),
    }
}
pub fn list() -> Result<Vec<Point>, String> {
    inventory_with_fallback(local_inventory, || {
        if broker::is_elevated()? {
            return Err(InventoryError::AccessDenied.to_string());
        }
        match transport(HelperRequest::Inventory {
            caller_sid: broker::current_sid()?,
            parent_pid: std::process::id(),
            deadline_utc_ms: now_ms()?.saturating_add(TTL_MS),
        })? {
            Message::Inventory {
                points: Some(points),
                error: None,
            } => Ok(points),
            Message::Inventory { error, .. } => {
                Err(error.unwrap_or("Restore helper returned no inventory".into()))
            }
            _ => Err("Unexpected read-only restore helper response".into()),
        }
    })
}
pub fn prepare(request: Request) -> Result<PlanView, String> {
    request.validate()?;
    matched(&list()?, &request)?;
    let id = broker::reserve_plan()?;
    let view = PlanView {
        id: id.clone(),
        summary: format!(
            "Delete restore point #{}: {}. It cannot be recovered.",
            request.sequence, request.expected_description
        ),
        requires_elevation: !broker::is_elevated()?,
    };
    let envelope = Envelope {
        request,
        plan_id: id.clone(),
        caller_sid: broker::current_sid()?,
        parent_pid: std::process::id(),
        deadline_utc_ms: now_ms()?.saturating_add(TTL_MS),
    };
    let mut pending = plans().lock().map_err(|e| e.to_string())?;
    pending.retain(|_, p| p.prepared.elapsed() < Duration::from_millis(TTL_MS));
    pending.insert(
        id,
        Pending {
            envelope,
            prepared: Instant::now(),
        },
    );
    Ok(view)
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Journal {
    plan_id: String,
    request: Request,
    finished: bool,
    outcome: String,
}
trait Executor {
    fn points(&mut self) -> Result<Vec<Point>, String>;
    fn confirm(&mut self, request: &Request) -> Result<(), String>;
    fn journal(&mut self, envelope: &Envelope, outcome: &str, finished: bool)
        -> Result<(), String>;
    fn remove(&mut self, sequence: u32) -> Result<(), String>;
}
struct NativeExecutor;
fn journal_hash() -> String {
    Sha256::digest(b"Purgeon restore-removal journal v1")
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
fn journal_key(sequence: u32) -> String {
    format!("point-{sequence}")
}
impl Executor for NativeExecutor {
    fn points(&mut self) -> Result<Vec<Point>, String> {
        local_inventory().map_err(|e| e.to_string())
    }
    fn confirm(&mut self, request: &Request) -> Result<(), String> {
        broker::confirm_native(&format!("Delete restore point #{}?\n\n{}\nCreated: {}\n\nThis permanently removes this restore point. It cannot be brought back.", request.sequence, request.expected_description, request.expected_creation_time))
    }
    fn journal(
        &mut self,
        envelope: &Envelope,
        outcome: &str,
        finished: bool,
    ) -> Result<(), String> {
        let key = journal_key(envelope.request.sequence);
        let hash = journal_hash();
        if outcome == "intent" {
            if let Some(bytes) = state_store::read(
                Domain::Restore,
                Authority::Machine,
                &envelope.caller_sid,
                &hash,
                &key,
            )? {
                let previous: Journal = serde_json::from_slice(&bytes).map_err(|e| {
                    format!("Restore recovery journal is unreadable; evidence retained: {e}")
                })?;
                if !previous.finished {
                    return Err("An earlier restore-point deletion has an uncertain result; review its retained native journal before changing this point again".into());
                }
            }
        }
        let journal = Journal {
            plan_id: envelope.plan_id.clone(),
            request: envelope.request.clone(),
            finished,
            outcome: outcome.into(),
        };
        state_store::write(
            Domain::Restore,
            Authority::Machine,
            &envelope.caller_sid,
            &hash,
            &key,
            &serde_json::to_vec(&journal).map_err(|e| e.to_string())?,
        )
    }
    fn remove(&mut self, sequence: u32) -> Result<(), String> {
        remove_by_sequence(sequence)
    }
}
fn perform(
    envelope: &Envelope,
    executor: &mut impl Executor,
    before_commit: impl FnOnce() -> Result<(), String>,
) -> Result<ResultView, String> {
    let deadline = || -> Result<(), String> {
        let now = now_ms()?;
        if now > envelope.deadline_utc_ms || envelope.deadline_utc_ms > now.saturating_add(TTL_MS) {
            return Err("Restore removal plan expired; refresh and review again".into());
        }
        Ok(())
    };
    deadline()?;
    matched(&executor.points()?, &envelope.request)?;
    executor.confirm(&envelope.request)?;
    deadline()?;
    matched(&executor.points()?, &envelope.request)?;
    before_commit()?;
    deadline()?;
    executor.journal(envelope, "intent", false)?;
    if let Err(error) = executor.remove(envelope.request.sequence) {
        let saved = executor.journal(envelope, &format!("uncertain: {error}"), false);
        return Err(format!("Restore deletion failed or is uncertain; inspect the retained journal before retrying: {error}{}", saved.err().map(|e| format!("; journal update failed: {e}")).unwrap_or_default()));
    }
    let verified = executor.points().map(|points| {
        !points
            .iter()
            .any(|p| p.sequence == envelope.request.sequence)
    });
    match verified {
        Ok(true) => {
            executor.journal(envelope, "deleted-and-verified", true)?;
            Ok(ResultView {
                ok: true,
                sequence: envelope.request.sequence,
                journal_id: envelope.plan_id.clone(),
            })
        }
        other => {
            let detail = match other {
                Err(e) => e,
                _ => "Restore point is still listed".into(),
            };
            executor.journal(envelope, &format!("uncertain: {detail}"), false)?;
            Err(format!("Restore deletion outcome could not be verified; recovery evidence retained: {detail}"))
        }
    }
}
fn execute_native(
    envelope: &Envelope,
    before_commit: impl FnOnce() -> Result<(), String>,
) -> Result<ResultView, String> {
    if !broker::is_elevated()? {
        return Err("Restore deletion requires the native administrator helper".into());
    }
    let _lease = broker::domain_lease(&envelope.caller_sid)?;
    perform(envelope, &mut NativeExecutor, || {
        broker::require_live_parent(envelope.parent_pid)?;
        before_commit()?;
        broker::require_live_parent(envelope.parent_pid)
    })
}
fn remove_by_sequence(sequence: u32) -> Result<(), String> {
    #[link(name = "kernel32")]
    extern "system" {
        fn LoadLibraryExW(path: *const u16, file: *mut c_void, flags: u32) -> *mut c_void;
        fn GetProcAddress(module: *mut c_void, name: *const u8) -> *mut c_void;
        fn FreeLibrary(module: *mut c_void) -> i32;
    }
    struct Library(*mut c_void);
    impl Drop for Library {
        fn drop(&mut self) {
            unsafe {
                FreeLibrary(self.0);
            }
        }
    }
    let path = crate::windows_tools::system_file("SrClient.dll")?;
    let path: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let library =
        Library(unsafe { LoadLibraryExW(path.as_ptr(), std::ptr::null_mut(), 0x100 | 0x800) });
    if library.0.is_null() {
        return Err(format!(
            "System Restore API unavailable: {}",
            std::io::Error::last_os_error()
        ));
    }
    let address = unsafe { GetProcAddress(library.0, c"SRRemoveRestorePoint".as_ptr().cast()) };
    if address.is_null() {
        return Err("Windows does not provide restore-point deletion".into());
    }
    let remove: unsafe extern "system" fn(u32) -> u32 = unsafe { std::mem::transmute(address) };
    let status = unsafe { remove(sequence) };
    if status != 0 {
        return Err(format!(
            "SRRemoveRestorePoint returned {status}: {}",
            std::io::Error::from_raw_os_error(status as i32)
        ));
    }
    Ok(())
}

pub fn execute(id: &str) -> Result<ResultView, String> {
    broker::consume_plan(id)?;
    let pending = plans()
        .lock()
        .map_err(|e| e.to_string())?
        .remove(id)
        .ok_or("Restore plan is missing or already used")?;
    if pending.prepared.elapsed() >= Duration::from_millis(TTL_MS)
        || broker::current_sid()? != pending.envelope.caller_sid
    {
        return Err("Restore plan expired or caller identity changed".into());
    }
    if broker::is_elevated()? {
        return execute_native(&pending.envelope, || Ok(()));
    }
    let expected_sequence = pending.envelope.request.sequence;
    let expected_journal = pending.envelope.plan_id.clone();
    let response = transport(HelperRequest::Remove {
        envelope: pending.envelope,
    })?;
    match response {
        Message::Result {
            result: Some(result),
            error: None,
        } if result.sequence == expected_sequence
            && result.journal_id == expected_journal
            && result.ok =>
        {
            Ok(result)
        }
        Message::Result { error, .. } => {
            Err(error.unwrap_or("Restore helper returned no result".into()))
        }
        _ => Err("Unexpected restore helper phase".into()),
    }
}
pub(crate) fn helper(pipe_name: &str) -> Result<(), String> {
    if !broker::is_elevated()? {
        return Err("Restore helper is not elevated".into());
    }
    let (pid, nonce) = pipe_name
        .strip_prefix(PIPE_PREFIX)
        .ok_or("Invalid restore pipe")?
        .split_once('-')
        .ok_or("Invalid restore pipe")?;
    let pid = pid.parse::<u32>().map_err(|e| e.to_string())?;
    if nonce.len() != 32 || !nonce.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("Invalid restore nonce".into());
    }
    let pipe = broker::client_pipe(pipe_name, pid)?;
    let dispatch: Dispatch = broker::receive(pipe.0)?;
    if digest(&dispatch.request)? != dispatch.digest {
        return Err("Restore request binding mismatch".into());
    }
    let actual_sid = broker::process_sid(pid)?;
    let (parent, sid, deadline) = match &dispatch.request {
        HelperRequest::Inventory {
            parent_pid,
            caller_sid,
            deadline_utc_ms,
        } => (*parent_pid, caller_sid, *deadline_utc_ms),
        HelperRequest::Remove { envelope } => (
            envelope.parent_pid,
            &envelope.caller_sid,
            envelope.deadline_utc_ms,
        ),
    };
    let now = now_ms()?;
    if parent != pid
        || *sid != actual_sid
        || deadline < now
        || deadline > now.saturating_add(TTL_MS)
    {
        return Err("Restore caller authentication or deadline mismatch".into());
    }
    broker::require_live_parent(pid)?;
    let response = match dispatch.request {
        HelperRequest::Inventory { .. } => match local_inventory() {
            Ok(points) => Message::Inventory {
                points: Some(points),
                error: None,
            },
            Err(error) => Message::Inventory {
                points: None,
                error: Some(error.to_string()),
            },
        },
        HelperRequest::Remove { envelope } => {
            if envelope.plan_id.len() != 32
                || !envelope.plan_id.bytes().all(|b| b.is_ascii_hexdigit())
            {
                return Err("Invalid restore plan identity".into());
            }
            let result = execute_native(&envelope, || {
                reply(pipe.0, &dispatch.digest, Message::Ready)?;
                let commit: Commit = broker::receive(pipe.0)?;
                if !commit.approved || commit.digest != dispatch.digest {
                    return Err("Parent refused restore deletion or commit binding changed".into());
                }
                Ok(())
            });
            match result {
                Ok(result) => Message::Result {
                    result: Some(result),
                    error: None,
                },
                Err(error) => Message::Result {
                    result: None,
                    error: Some(error),
                },
            }
        }
    };
    broker::require_live_parent(pid)?;
    reply(pipe.0, &dispatch.digest, response)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_explicit_inventory_access_denial_uses_the_read_only_helper() {
        let calls = std::cell::Cell::new(0);
        let result = inventory_with_fallback(
            || Err(InventoryError::AccessDenied),
            || {
                calls.set(calls.get() + 1);
                Ok(vec![point()])
            },
        )
        .unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(calls.get(), 1);
        let result = inventory_with_fallback(
            || Err(InventoryError::Other("provider failed".into())),
            || {
                calls.set(calls.get() + 1);
                Ok(vec![])
            },
        );
        assert_eq!(result.unwrap_err(), "provider failed");
        assert_eq!(calls.get(), 1);
        assert_eq!(
            inventory_with_fallback(
                || Err(InventoryError::AccessDenied),
                || Err("USER_CANCELLED".into())
            )
            .unwrap_err(),
            "USER_CANCELLED"
        );
        let mut hostile = point();
        hostile.created.clear();
        assert!(inventory_with_fallback(
            || Err(InventoryError::AccessDenied),
            || Ok(vec![hostile])
        )
        .is_err());
        assert!(validate_inventory(vec![point(); 4097]).is_err());
    }
    #[test]
    fn inventory_request_is_closed_and_bound_to_its_native_dispatch() {
        let request = HelperRequest::Inventory {
            caller_sid: "S-1-5-21-1".into(),
            parent_pid: 1,
            deadline_utc_ms: 100,
        };
        let hash = digest(&request).unwrap();
        let changed = HelperRequest::Inventory {
            caller_sid: "S-1-5-21-1".into(),
            parent_pid: 2,
            deadline_utc_ms: 100,
        };
        assert_ne!(hash, digest(&changed).unwrap());
        let mut hostile = serde_json::to_value(&request).unwrap();
        hostile["script"] = serde_json::json!("caller-selected code");
        assert!(serde_json::from_value::<HelperRequest>(hostile).is_err());
    }
    #[test]
    #[ignore = "read-only probe requires Windows client System Restore provider"]
    fn inventory_read_only() {
        match local_inventory() {
            Ok(points) => println!("Read-only restore inventory returned {} points", points.len()),
            Err(InventoryError::AccessDenied) => println!("Windows denied direct inventory access; precise AccessDenied fallback classification verified. This probe never elevates; elevated inventory contents remain unverified."),
            Err(error) => panic!("Unexpected read-only restore inventory failure: {error}"),
        }
    }
    fn point() -> Point {
        Point {
            sequence: 42,
            created: "20261028143022.123456-300".into(),
            description: "Before testing".into(),
        }
    }
    fn request() -> Request {
        let p = point();
        Request {
            sequence: p.sequence,
            expected_creation_time: p.created,
            expected_description: p.description,
        }
    }
    fn envelope() -> Envelope {
        Envelope {
            request: request(),
            plan_id: "a".repeat(32),
            caller_sid: "S-1-5-21-1".into(),
            parent_pid: 1,
            deadline_utc_ms: now_ms().unwrap() + TTL_MS,
        }
    }
    struct Fake {
        calls: Vec<String>,
        queries: Vec<Vec<Point>>,
        fail_remove: bool,
        fail_journal: bool,
    }
    impl Executor for Fake {
        fn points(&mut self) -> Result<Vec<Point>, String> {
            self.calls.push("query".into());
            Ok(self.queries.remove(0))
        }
        fn confirm(&mut self, _: &Request) -> Result<(), String> {
            self.calls.push("confirm".into());
            Ok(())
        }
        fn journal(&mut self, _: &Envelope, outcome: &str, _: bool) -> Result<(), String> {
            self.calls.push(outcome.into());
            if self.fail_journal {
                Err("disk failed".into())
            } else {
                Ok(())
            }
        }
        fn remove(&mut self, sequence: u32) -> Result<(), String> {
            self.calls.push(format!("remove:{sequence}"));
            if self.fail_remove {
                Err("API failure".into())
            } else {
                Ok(())
            }
        }
    }
    #[test]
    fn refuses_changed_missing_duplicate_and_unbounded_requests() {
        assert!(matched(&[], &request()).is_err());
        assert!(matched(&[point(), point()], &request()).is_err());
        let mut changed = point();
        changed.created.push('x');
        assert!(matched(&[changed], &request()).is_err());
        let mut bad = request();
        bad.sequence = 0;
        assert!(bad.validate().is_err());
        bad = request();
        bad.expected_description = "x".repeat(1025);
        assert!(bad.validate().is_err());
    }
    #[test]
    fn fresh_identity_and_persisted_intent_precede_sequence_deletion() {
        let mut fake = Fake {
            calls: Vec::new(),
            queries: vec![vec![point()], vec![point()], vec![]],
            fail_remove: false,
            fail_journal: false,
        };
        let result = perform(&envelope(), &mut fake, || Ok(())).unwrap();
        assert!(result.ok);
        assert_eq!(
            fake.calls,
            [
                "query",
                "confirm",
                "query",
                "intent",
                "remove:42",
                "query",
                "deleted-and-verified"
            ]
        );
    }
    #[test]
    fn stale_after_consent_and_journal_failure_never_delete() {
        let mut fake = Fake {
            calls: Vec::new(),
            queries: vec![vec![point()], vec![]],
            fail_remove: false,
            fail_journal: false,
        };
        assert!(perform(&envelope(), &mut fake, || Ok(())).is_err());
        assert!(!fake.calls.iter().any(|c| c.starts_with("remove:")));
        let mut fake = Fake {
            calls: Vec::new(),
            queries: vec![vec![point()], vec![point()]],
            fail_remove: false,
            fail_journal: true,
        };
        assert!(perform(&envelope(), &mut fake, || Ok(())).is_err());
        assert!(!fake.calls.iter().any(|c| c.starts_with("remove:")));
    }
    #[test]
    fn api_and_postverification_failures_retain_uncertain_evidence() {
        let mut fake = Fake {
            calls: Vec::new(),
            queries: vec![vec![point()], vec![point()]],
            fail_remove: true,
            fail_journal: false,
        };
        assert!(perform(&envelope(), &mut fake, || Ok(()))
            .unwrap_err()
            .contains("uncertain"));
        assert!(fake.calls.last().unwrap().starts_with("uncertain:"));
        let mut fake = Fake {
            calls: Vec::new(),
            queries: vec![vec![point()], vec![point()], vec![point()]],
            fail_remove: false,
            fail_journal: false,
        };
        assert!(perform(&envelope(), &mut fake, || Ok(())).is_err());
        assert!(fake.calls.last().unwrap().starts_with("uncertain:"));
    }
    #[test]
    fn expired_plan_never_queries_or_mutates() {
        let mut request = envelope();
        request.deadline_utc_ms = 0;
        let mut fake = Fake {
            calls: Vec::new(),
            queries: vec![],
            fail_remove: false,
            fail_journal: false,
        };
        assert!(perform(&request, &mut fake, || Ok(())).is_err());
        assert!(fake.calls.is_empty());
    }
}
