//! Fixed local Task Scheduler provider. Renderer text never becomes script,
//! credentials, task XML, a COM class, or registration flags.
use crate::{process_io, state_store, windows_tools};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{File, OpenOptions},
    io::{Read, Seek, SeekFrom},
    os::windows::{fs::OpenOptionsExt, io::AsRawHandle, process::CommandExt},
    path::{Component, Path},
    process::Command,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
const MAX_XML: usize = 16 * 1024;
const MAX_SDDL: usize = 4 * 1024;
const MAX_RECORD: usize = 28 * 1024;
const MAX_PAGE: usize = 192 * 1024;
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Program {
    pub path: String,
    pub digest: String,
    pub bytes: u64,
    pub modified: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExecAction {
    pub program: Program,
    pub arguments: String,
    pub working_directory: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Snapshot {
    pub path: String,
    pub xml: String,
    pub sddl: String,
    pub enabled: bool,
    pub principal_sid: String,
    pub logon_type: u32,
    pub run_level: u32,
    pub actions: Vec<ExecAction>,
    pub instance_guids: Vec<String>,
}
fn sid(value: &str) -> bool {
    value.len() <= 184
        && value.starts_with("S-1-")
        && value[4..].split('-').all(|s| {
            !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()) && s.parse::<u64>().is_ok()
        })
}
fn guid(value: &str) -> bool {
    let b = value.as_bytes();
    b.len() == 38
        && b[0] == b'{'
        && b[37] == b'}'
        && b[1..37].iter().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                *b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
}
fn task_path(value: &str) -> Result<(), String> {
    if value.len() > 512
        || !value.starts_with('\\')
        || value.ends_with('\\')
        || value.contains(['/', ':', '\0'])
        || value.chars().any(char::is_control)
        || value[1..].split('\\').any(|s| {
            s.is_empty()
                || s == "."
                || s == ".."
                || s.trim() != s
                || s.contains(['*', '?', '"', '<', '>', '|'])
        })
    {
        return Err("Unsupported native task path".into());
    }
    Ok(())
}
fn program_fields(program: &Program) -> Result<(), String> {
    let p = Path::new(&program.path);
    let name = p
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or("Invalid task executable")?
        .to_ascii_lowercase();
    if !p.is_absolute()
        || program.path.starts_with("\\\\")
        || program.path.len() > 32767
        || program.path.contains(['\0', '%'])
        || !name.ends_with(".exe")
        || [
            "cmd.exe",
            "powershell.exe",
            "pwsh.exe",
            "wscript.exe",
            "cscript.exe",
            "mshta.exe",
            "rundll32.exe",
            "regsvr32.exe",
            "dotnet.exe",
            "node.exe",
            "python.exe",
            "pythonw.exe",
            "java.exe",
            "javaw.exe",
            "bash.exe",
            "wsl.exe",
        ]
        .contains(&name.as_str())
        || program.bytes < 64
        || program.bytes > 1024 * 1024 * 1024
        || program.digest.len() != 64
        || !program.digest.bytes().all(|b| b.is_ascii_hexdigit())
        || program.modified.is_empty()
        || !program.modified.bytes().all(|b| b.is_ascii_digit())
    {
        return Err(
            "Task action must be a captured regular native executable, not a script interpreter"
                .into(),
        );
    }
    Ok(())
}
impl Snapshot {
    pub fn validate(&self, caller_sid: &str) -> Result<(), String> {
        task_path(&self.path)?;
        if !sid(caller_sid)
            || self.principal_sid != caller_sid
            || self.logon_type != 3
            || self.run_level != 0
            || self.xml.is_empty()
            || self.xml.len() > MAX_XML
            || self.sddl.is_empty()
            || self.sddl.len() > MAX_SDDL
            || self.xml.contains('\0')
            || self.sddl.contains('\0')
            || self.actions.len() != 1
            || self.instance_guids.len() > 64
            || self.instance_guids.iter().any(|s| !guid(s))
            || serde_json::to_vec(self).map_err(|e| e.to_string())?.len() > MAX_RECORD
        {
            return Err(
                "Only bounded caller-owned least-privilege interactive tasks are supported".into(),
            );
        }
        let action = &self.actions[0];
        program_fields(&action.program)?;
        if action.arguments.len() > 2048
            || action.working_directory.len() > 1024
            || action.arguments.contains('\0')
            || action.working_directory.contains('\0')
        {
            return Err("Task action exceeds supported bounds".into());
        }
        let mut instances = self.instance_guids.clone();
        instances.sort();
        instances.dedup();
        if instances.len() != self.instance_guids.len() {
            return Err("Duplicate task instance identity".into());
        }
        Ok(())
    }
    pub fn fingerprint(&self) -> Result<String, String> {
        let mut core = self.clone();
        core.instance_guids.clear();
        Ok(hex(&Sha256::digest(
            serde_json::to_vec(&core).map_err(|e| e.to_string())?,
        )))
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Row {
    pub path: String,
    pub name: String,
    pub state: String,
    pub author: String,
    pub last_run: String,
    pub next_run: String,
    pub last_result: Option<i64>,
    pub fingerprint: Option<String>,
    pub unsupported_reason: Option<String>,
    pub enabled: Option<bool>,
    pub action: Option<ExecAction>,
    pub instance_guids: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Page {
    pub rows: Vec<Row>,
    pub next_cursor: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeDefinition {
    pub path: String,
    pub xml: String,
    pub sddl: String,
    pub program: Program,
    pub caller_sid: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Trigger {
    Logon,
    Daily { time: String },
    Weekly { day: String, time: String },
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OwnedRole {
    Signin,
    Maintenance,
    Background,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum PlatformAction {
    SetEnabled { enabled: bool },
    Run,
    Stop { instance_guids: Vec<String> },
    Delete,
    Register { definition: NativeDefinition },
    Update { definition: NativeDefinition },
}
fn required_option<'de, D, T>(d: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(d)
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Outcome {
    #[serde(deserialize_with = "required_option")]
    pub snapshot: Option<Snapshot>,
    #[serde(deserialize_with = "required_option")]
    pub instance_guid: Option<String>,
}

#[repr(C)]
struct FileInfo {
    attributes: u32,
    created: [u32; 2],
    accessed: [u32; 2],
    modified: [u32; 2],
    volume: u32,
    size_high: u32,
    size_low: u32,
    links: u32,
    index_high: u32,
    index_low: u32,
}
#[link(name = "kernel32")]
extern "system" {
    fn GetFileInformationByHandle(file: *mut std::ffi::c_void, info: *mut FileInfo) -> i32;
    fn GetFinalPathNameByHandleW(
        file: *mut std::ffi::c_void,
        path: *mut u16,
        length: u32,
        flags: u32,
    ) -> u32;
}
struct PinnedProgram {
    program: Program,
    _file: File,
    _ancestors: Vec<File>,
}
fn pin_program(path: &Path) -> Result<PinnedProgram, String> {
    let value = path.to_str().ok_or("Unsupported task executable path")?;
    if !path.is_absolute()
        || value.starts_with("\\\\")
        || value.contains(['\0', '%'])
        || value.get(2..3) != Some("\\")
        || value.get(2..).is_some_and(|s| s.contains(':'))
        || path
            .components()
            .any(|c| matches!(c, Component::CurDir | Component::ParentDir))
    {
        return Err("Choose a local native executable".into());
    }
    let mut ancestors = Vec::new();
    for ancestor in path
        .parent()
        .ok_or("Executable has no parent")?
        .ancestors()
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
    {
        ancestors.push(state_store::pin_driver_ancestor(ancestor)?);
    }
    let mut file = OpenOptions::new()
        .read(true)
        .share_mode(1)
        .custom_flags(0x0020_0000)
        .open(path)
        .map_err(|e| e.to_string())?;
    let mut resolved = vec![0u16; 32768];
    let length = unsafe {
        GetFinalPathNameByHandleW(
            file.as_raw_handle(),
            resolved.as_mut_ptr(),
            resolved.len() as u32,
            0,
        )
    } as usize;
    if length == 0
        || length >= resolved.len()
        || !String::from_utf16(&resolved[..length])
            .map_err(|e| e.to_string())?
            .trim_start_matches("\\\\?\\")
            .eq_ignore_ascii_case(value)
    {
        return Err("Task executable path does not match its opened identity".into());
    }
    let mut info: FileInfo = unsafe { std::mem::zeroed() };
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0
        || info.attributes & 0x410 != 0
        || info.links != 1
    {
        return Err("Task executable is not a unique regular non-reparse file".into());
    }
    let meta = file.metadata().map_err(|e| e.to_string())?;
    let bytes = meta.len();
    if !(64..=1024 * 1024 * 1024).contains(&bytes) {
        return Err("Task executable size exceeds bounds".into());
    }
    let mut dos = [0u8; 64];
    file.read_exact(&mut dos).map_err(|e| e.to_string())?;
    if &dos[..2] != b"MZ" {
        return Err("Task action is not a native PE executable".into());
    }
    let pe = u32::from_le_bytes(dos[60..64].try_into().unwrap()) as u64;
    if pe > 1024 * 1024 || pe + 24 > bytes {
        return Err("Invalid native executable header".into());
    }
    file.seek(SeekFrom::Start(pe)).map_err(|e| e.to_string())?;
    let mut header = [0u8; 24];
    file.read_exact(&mut header).map_err(|e| e.to_string())?;
    let machine = u16::from_le_bytes(header[4..6].try_into().unwrap());
    let flags = u16::from_le_bytes(header[22..24].try_into().unwrap());
    let length = u16::from_le_bytes(header[20..22].try_into().unwrap()) as usize;
    if &header[..4] != b"PE\0\0"
        || ![0x14c, 0x8664].contains(&machine)
        || flags & 2 == 0
        || flags & 0x2000 != 0
        || !(224..=4096).contains(&length)
        || pe + 24 + length as u64 > bytes
    {
        return Err("Unsupported native executable image".into());
    }
    let mut optional = vec![0u8; length];
    file.read_exact(&mut optional).map_err(|e| e.to_string())?;
    let directory = match u16::from_le_bytes(optional[..2].try_into().unwrap()) {
        0x10b => 96,
        0x20b => 112,
        _ => return Err("Unsupported PE optional header".into()),
    };
    if directory + 15 * 8 > optional.len()
        || optional[directory + 14 * 8..directory + 15 * 8]
            .iter()
            .any(|b| *b != 0)
    {
        return Err("Managed executables are outside this task action class".into());
    }
    file.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
    let mut hash = Sha256::new();
    let mut chunk = [0u8; 65536];
    let mut actual = 0u64;
    let started = std::time::Instant::now();
    loop {
        if started.elapsed() > Duration::from_secs(15) {
            return Err("Task executable verification timed out".into());
        }
        let n = file.read(&mut chunk).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        actual += n as u64;
        if actual > bytes {
            return Err("Task executable changed during capture".into());
        }
        hash.update(&chunk[..n]);
    }
    if actual != bytes || file.metadata().map_err(|e| e.to_string())?.len() != bytes {
        return Err("Task executable changed during capture".into());
    }
    let program = Program {
        path: value.into(),
        digest: hex(&hash.finalize()),
        bytes,
        modified: meta
            .modified()
            .map_err(|e| e.to_string())?
            .duration_since(UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_nanos()
            .to_string(),
    };
    program_fields(&program)?;
    Ok(PinnedProgram {
        program,
        _file: file,
        _ancestors: ancestors,
    })
}
pub fn inspect_program(path: &Path) -> Result<Program, String> {
    Ok(pin_program(path)?.program)
}
pub fn recheck_program(program: &Program) -> Result<(), String> {
    if pin_program(Path::new(&program.path))?.program != *program {
        return Err("Task executable changed; select it again".into());
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawAction {
    path: String,
    arguments: String,
    working_directory: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawSnapshot {
    path: String,
    xml: String,
    sddl: String,
    enabled: bool,
    principal_sid: String,
    logon_type: u32,
    run_level: u32,
    actions: Vec<RawAction>,
    instance_guids: Vec<String>,
}
impl RawSnapshot {
    fn capture(self, caller_sid: &str) -> Result<Snapshot, String> {
        let mut actions = Vec::new();
        for action in self.actions {
            actions.push(ExecAction {
                program: inspect_program(Path::new(&action.path))?,
                arguments: action.arguments,
                working_directory: action.working_directory,
            });
        }
        let value = Snapshot {
            path: self.path,
            xml: self.xml,
            sddl: self.sddl,
            enabled: self.enabled,
            principal_sid: self.principal_sid,
            logon_type: self.logon_type,
            run_level: self.run_level,
            actions,
            instance_guids: self.instance_guids,
        };
        value.validate(caller_sid)?;
        Ok(value)
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawRow {
    path: String,
    name: String,
    state: String,
    author: String,
    last_run: String,
    next_run: String,
    last_result: Option<i64>,
    snapshot: Option<RawSnapshot>,
    unsupported_reason: Option<String>,
}
impl RawRow {
    fn capture(self, caller_sid: &str) -> Result<Row, String> {
        task_path(&self.path)?;
        if self.snapshot.as_ref().is_some_and(|s| s.path != self.path) {
            return Err("Task metadata/snapshot identity mismatch".into());
        }
        let captured = self.snapshot.map(|s| s.capture(caller_sid)).transpose();
        let (snapshot, reason) = match captured {
            Ok(value) => (value, self.unsupported_reason),
            Err(e) => (None, Some(e)),
        };
        Ok(Row {
            path: self.path,
            name: self.name,
            state: self.state,
            author: self.author,
            last_run: self.last_run,
            next_run: self.next_run,
            last_result: self.last_result,
            fingerprint: snapshot.as_ref().map(Snapshot::fingerprint).transpose()?,
            unsupported_reason: reason,
            enabled: snapshot.as_ref().map(|s| s.enabled),
            action: snapshot.as_ref().map(|s| s.actions[0].clone()),
            instance_guids: snapshot.map_or(Vec::new(), |s| s.instance_guids),
        })
    }
}
fn invoke(request: &serde_json::Value) -> Result<Vec<u8>, String> {
    let input = serde_json::to_string(request).map_err(|e| e.to_string())?;
    if input.len() > 64 * 1024 {
        return Err("Native task request exceeds bounds".into());
    }
    // Native provider text exceeds the Windows command-line limit once encoded.
    // Request JSON enters only as inert base64, never PowerShell source.
    let script = PROVIDER.replacen(
        "$requestText=[Console]::In.ReadToEnd()",
        &format!(
            "$requestText=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{}'))",
            STANDARD.encode(input.as_bytes())
        ),
        1,
    );
    let system = windows_tools::system_file("powershell.exe")?;
    let mut command = Command::new(&system);
    command
        .env_remove("PSModulePath")
        .current_dir(system.parent().ok_or("No system provider directory")?)
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "[Console]::InputEncoding=[Text.UTF8Encoding]::new($false); & ([scriptblock]::Create([Console]::In.ReadToEnd()))",
        ])
        .creation_flags(0x0800_0000);
    let output = process_io::execute(&mut command, Some(script), Duration::from_secs(45))?;
    if !output.status.success() {
        return Err(format!(
            "Native Task Scheduler provider refused the request: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    if output.stdout.len() > MAX_PAGE {
        return Err("Native task provider page exceeds transport bounds".into());
    }
    Ok(output.stdout)
}
pub fn read(path: &str, caller_sid: &str) -> Result<Option<Snapshot>, String> {
    task_path(path)?;
    if !sid(caller_sid) {
        return Err("Invalid authenticated task caller".into());
    }
    let raw: Option<RawSnapshot> = serde_json::from_slice(&invoke(
        &serde_json::json!({"operation":"read","path":path,"callerSid":caller_sid}),
    )?)
    .map_err(|e| e.to_string())?;
    raw.map(|s| s.capture(caller_sid)).transpose()
}
/// Internal exact native-catalog lookup; this is not a renderer path endpoint.
pub fn metadata(path: &str, caller_sid: &str) -> Result<Option<Row>, String> {
    task_path(path)?;
    if !sid(caller_sid) {
        return Err("Invalid authenticated task caller".into());
    }
    let raw: Option<RawRow> = serde_json::from_slice(&invoke(
        &serde_json::json!({"operation":"metadata","path":path,"callerSid":caller_sid}),
    )?)
    .map_err(|e| e.to_string())?;
    if raw.as_ref().is_some_and(|row| row.path != path) {
        return Err("Exact task metadata identity mismatch".into());
    }
    raw.map(|row| row.capture(caller_sid)).transpose()
}
pub fn query(cursor: Option<&str>, caller_sid: &str) -> Result<Page, String> {
    if !sid(caller_sid) {
        return Err("Invalid authenticated task caller".into());
    }
    if let Some(cursor) = cursor {
        task_path(cursor)?;
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct RawPage {
        rows: Vec<RawRow>,
        next_cursor: Option<String>,
    }
    let raw: RawPage = serde_json::from_slice(&invoke(
        &serde_json::json!({"operation":"query","cursor":cursor,"callerSid":caller_sid}),
    )?)
    .map_err(|e| e.to_string())?;
    if raw.rows.len() > 64 {
        return Err("Task page exceeds record limit".into());
    }
    let rows = raw
        .rows
        .into_iter()
        .map(|row| row.capture(caller_sid))
        .collect::<Result<Vec<_>, _>>()?;
    if let Some(next) = &raw.next_cursor {
        task_path(next)?;
        if cursor.is_some_and(|c| next.as_str() <= c) {
            return Err("Task page cursor did not advance".into());
        }
    }
    let page = Page {
        rows,
        next_cursor: raw.next_cursor,
    };
    if serde_json::to_vec(&page).map_err(|e| e.to_string())?.len() > MAX_PAGE {
        return Err("Task page exceeds transport bounds".into());
    }
    Ok(page)
}
fn escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}
fn valid_time(value: &str) -> bool {
    let b = value.as_bytes();
    b.len() == 5
        && b[2] == b':'
        && b.iter()
            .enumerate()
            .all(|(i, b)| i == 2 || b.is_ascii_digit())
        && value[..2].parse::<u8>().is_ok_and(|h| h < 24)
        && value[3..].parse::<u8>().is_ok_and(|m| m < 60)
}
fn trigger_xml(trigger: &Trigger) -> Result<String, String> {
    Ok(match trigger {
        Trigger::Logon => {
            "<LogonTrigger><Enabled>true</Enabled><UserId>__SID__</UserId></LogonTrigger>".into()
        }
        Trigger::Daily { time } => {
            if !valid_time(time) {
                return Err("Choose a time from 00:00 to 23:59".into());
            }
            format!("<CalendarTrigger><StartBoundary>2000-01-03T{time}:00</StartBoundary><Enabled>true</Enabled><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger>")
        }
        Trigger::Weekly { day, time } => {
            if ![
                "Sunday",
                "Monday",
                "Tuesday",
                "Wednesday",
                "Thursday",
                "Friday",
                "Saturday",
            ]
            .contains(&day.as_str())
                || !valid_time(time)
            {
                return Err("Choose a supported day and time".into());
            }
            format!("<CalendarTrigger><StartBoundary>2000-01-03T{time}:00</StartBoundary><Enabled>true</Enabled><ScheduleByWeek><DaysOfWeek><{day}/></DaysOfWeek><WeeksInterval>1</WeeksInterval></ScheduleByWeek></CalendarTrigger>")
        }
    })
}
pub fn build_definition(
    path: &str,
    program: &Program,
    trigger: &Trigger,
    caller_sid: &str,
    arguments: &str,
) -> Result<NativeDefinition, String> {
    task_path(path)?;
    program_fields(program)?;
    if !sid(caller_sid) || arguments.len() > 2048 || arguments.contains('\0') {
        return Err("Invalid native task definition".into());
    }
    let triggers = trigger_xml(trigger)?.replace("__SID__", &escape(caller_sid));
    let xml = format!(
        r#"<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><RegistrationInfo><Description>Purgeon native task</Description></RegistrationInfo><Triggers>{triggers}</Triggers><Principals><Principal id="Author"><UserId>{}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><Enabled>false</Enabled><ExecutionTimeLimit>PT0S</ExecutionTimeLimit></Settings><Actions Context="Author"><Exec><Command>{}</Command><Arguments>{}</Arguments></Exec></Actions></Task>"#,
        escape(caller_sid),
        escape(&program.path),
        escape(arguments)
    );
    normalize_definition(NativeDefinition {
        path: path.into(),
        xml,
        sddl: format!(
            "O:{caller_sid}G:{caller_sid}D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;{caller_sid})"
        ),
        program: program.clone(),
        caller_sid: caller_sid.into(),
    })
}
fn normalize_definition(definition: NativeDefinition) -> Result<NativeDefinition, String> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Normalized {
        xml: String,
        sddl: String,
    }
    let raw:Normalized=serde_json::from_slice(&invoke(&serde_json::json!({"operation":"normalize","definition":definition,"callerSid":definition.caller_sid}))?).map_err(|e|e.to_string())?;
    Ok(NativeDefinition {
        xml: raw.xml,
        sddl: raw.sddl,
        ..definition
    })
}
pub fn build_owned_definition(
    role: OwnedRole,
    exe: &Program,
    caller_sid: &str,
    day: &str,
    time: &str,
    check_startup: bool,
) -> Result<NativeDefinition, String> {
    let (path, args, trigger) = match role {
        OwnedRole::Signin => (
            "\\Purgeon\\Start at Sign-in",
            "--started-by-windows",
            Trigger::Logon,
        ),
        OwnedRole::Maintenance => (
            "\\Purgeon\\Weekly Maintenance",
            "--maintenance",
            Trigger::Weekly {
                day: day.into(),
                time: time.into(),
            },
        ),
        OwnedRole::Background => (
            "\\Purgeon\\Background Monitoring",
            "--background-scan",
            if check_startup {
                Trigger::Logon
            } else {
                Trigger::Daily {
                    time: "03:00".into(),
                }
            },
        ),
    };
    let definition = build_definition(path, exe, &trigger, caller_sid, args)?;
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Normalized {
        xml: String,
        sddl: String,
    }
    let raw:Normalized=serde_json::from_slice(&invoke(&serde_json::json!({"operation":"normalize","definition":definition,"callerSid":caller_sid,"ownedRole":role}))?).map_err(|e|e.to_string())?;
    Ok(NativeDefinition {
        xml: raw.xml,
        sddl: raw.sddl,
        ..definition
    })
}
pub fn definition_matches(
    snapshot: &Snapshot,
    definition: &NativeDefinition,
) -> Result<bool, String> {
    snapshot.validate(&definition.caller_sid)?;
    #[derive(Deserialize)]
    struct Normalized {
        xml: String,
        sddl: String,
    }
    let expected:Normalized=serde_json::from_slice(&invoke(&serde_json::json!({"operation":"normalize","definition":definition,"callerSid":definition.caller_sid,"disabled":true}))?).map_err(|e|e.to_string())?;
    let actual:Normalized=serde_json::from_slice(&invoke(&serde_json::json!({"operation":"normalize","definition":NativeDefinition{path:snapshot.path.clone(),xml:snapshot.xml.clone(),sddl:snapshot.sddl.clone(),program:snapshot.actions[0].program.clone(),caller_sid:snapshot.principal_sid.clone()},"callerSid":snapshot.principal_sid,"disabled":true}))?).map_err(|e|e.to_string())?;
    Ok(snapshot.path == definition.path
        && snapshot.actions[0].program == definition.program
        && actual.xml == expected.xml
        && actual.sddl == expected.sddl)
}
pub fn equivalent_definition(expected: &Snapshot, actual: &Snapshot) -> Result<bool, String> {
    expected.validate(&expected.principal_sid)?;
    actual.validate(&expected.principal_sid)?;
    let mut a = expected.clone();
    let mut b = actual.clone();
    a.instance_guids.clear();
    b.instance_guids.clear();
    Ok(a == b)
}
pub fn owned_matches(
    snapshot: &Snapshot,
    role: &OwnedRole,
    exe: &Program,
    caller_sid: &str,
) -> bool {
    if snapshot.validate(caller_sid).is_err() || snapshot.actions[0].program != *exe {
        return false;
    }
    let time = snapshot
        .xml
        .split("<StartBoundary>")
        .nth(1)
        .and_then(|s| s.split('T').nth(1))
        .and_then(|s| s.get(..5))
        .filter(|t| valid_time(t))
        .unwrap_or("03:00");
    let day = [
        "Sunday",
        "Monday",
        "Tuesday",
        "Wednesday",
        "Thursday",
        "Friday",
        "Saturday",
    ]
    .into_iter()
    .find(|day| snapshot.xml.contains(&format!("<{day}")))
    .unwrap_or("Sunday");
    let check_startup = snapshot.xml.contains("<LogonTrigger");
    build_owned_definition(role.clone(), exe, caller_sid, day, time, check_startup)
        .and_then(|def| definition_matches(snapshot, &def))
        .unwrap_or(false)
}
pub fn apply(
    action: &PlatformAction,
    expected: Option<&Snapshot>,
    caller_sid: &str,
    expires_utc_ms: u64,
    parent_pid: u32,
    mut authorize: impl FnMut() -> Result<(), String>,
) -> Result<Outcome, String> {
    if !sid(caller_sid)
        || parent_pid == 0
        || SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_millis()
            >= expires_utc_ms as u128
    {
        return Err("Task operation expired or has no live parent".into());
    }
    let path = match action {
        PlatformAction::Register { definition } | PlatformAction::Update { definition } => {
            &definition.path
        }
        _ => {
            &expected
                .ok_or("Task operation has no native before-state")?
                .path
        }
    };
    task_path(path)?;
    if let Some(before) = expected {
        before.validate(caller_sid)?;
        let fresh = read(path, caller_sid)?.ok_or("Task disappeared before mutation")?;
        if !equivalent_definition(before, &fresh)? {
            return Err("Task changed before mutation".into());
        }
    }
    let programs = match action {
        PlatformAction::Register { definition } | PlatformAction::Update { definition } => {
            if definition.caller_sid != caller_sid {
                return Err("Task definition caller mismatch".into());
            }
            vec![&definition.program]
        }
        _ => expected
            .unwrap()
            .actions
            .iter()
            .map(|a| &a.program)
            .collect(),
    };
    let mut pins = Vec::new();
    for program in programs {
        let pin = pin_program(Path::new(&program.path))?;
        if pin.program != *program {
            return Err("Task executable changed before mutation".into());
        }
        pins.push(pin);
    }
    if matches!(action, PlatformAction::Update { .. })
        && expected.is_none_or(|s| s.enabled || !s.instance_guids.is_empty())
    {
        return Err("Owned task update requires a disabled stopped task".into());
    }
    authorize()?;
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct RawOutcome {
        #[serde(deserialize_with = "required_option")]
        snapshot: Option<RawSnapshot>,
        #[serde(deserialize_with = "required_option")]
        instance_guid: Option<String>,
    }
    let raw:RawOutcome=serde_json::from_slice(&invoke(&serde_json::json!({"operation":"apply","action":action,"expected":expected,"path":path,"callerSid":caller_sid,"expiresUtcMs":expires_utc_ms,"parentPid":parent_pid}))?).map_err(|e|e.to_string())?;
    let snapshot = raw.snapshot.map(|s| s.capture(caller_sid)).transpose()?;
    if raw.instance_guid.as_ref().is_some_and(|s| !guid(s)) {
        return Err("Invalid running task identity".into());
    }
    match action {
        PlatformAction::Delete => {
            if snapshot.is_some() {
                return Err("Task deletion was not confirmed".into());
            }
        }
        PlatformAction::Run | PlatformAction::Stop { .. } => {
            if !equivalent_definition(
                expected.unwrap(),
                snapshot
                    .as_ref()
                    .ok_or("Task missing after execution control")?,
            )? {
                return Err("Task definition or security changed during execution control".into());
            }
        }
        PlatformAction::SetEnabled { enabled } => {
            let after = snapshot.as_ref().ok_or("Task missing after state change")?;
            let before = expected.unwrap();
            let definition = NativeDefinition {
                path: before.path.clone(),
                xml: before.xml.clone(),
                sddl: before.sddl.clone(),
                program: before.actions[0].program.clone(),
                caller_sid: caller_sid.into(),
            };
            if after.enabled != *enabled
                || after.actions != before.actions
                || !definition_matches(after, &definition)?
            {
                return Err(
                    "Task definition or security changed during enabled-state operation".into(),
                );
            }
        }
        PlatformAction::Register { definition } | PlatformAction::Update { definition } => {
            let after = snapshot.as_ref().ok_or("Registered task missing")?;
            if after.enabled || !definition_matches(after, definition)? {
                return Err("Registered task differs from native definition".into());
            }
        }
    }
    drop(pins);
    Ok(Outcome {
        snapshot,
        instance_guid: raw.instance_guid,
    })
}

const PROVIDER: &str = r#"
$ErrorActionPreference='Stop';$PSModuleAutoloadingPreference='None';[Console]::OutputEncoding=[Text.Encoding]::UTF8
Import-Module ($PSHOME+'\Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop
function Parse-TaskXml([string]$xml,[string]$path){
 if([Text.Encoding]::UTF8.GetByteCount($xml)-gt 16384){throw 'Task XML exceeds supported bounds'}
 $settings=[Xml.XmlReaderSettings]::new();$settings.DtdProcessing=[Xml.DtdProcessing]::Prohibit;$settings.XmlResolver=$null;$settings.MaxCharactersInDocument=16384
 $reader=[Xml.XmlReader]::Create([IO.StringReader]::new($xml),$settings);$doc=[Xml.XmlDocument]::new();$doc.XmlResolver=$null;$doc.PreserveWhitespace=$false
 try{$doc.Load($reader)}finally{$reader.Dispose()}
 if($doc.DocumentElement.LocalName-ne'Task'-or$doc.DocumentElement.NamespaceURI-ne'http://schemas.microsoft.com/windows/2004/02/mit/task'){throw 'Unsupported task XML root'}
 Assert-XmlDepth $doc.DocumentElement 1
 $ns=[Xml.XmlNamespaceManager]::new($doc.NameTable);$ns.AddNamespace('t',$doc.DocumentElement.NamespaceURI)
 if($doc.SelectNodes('//t:SecurityDescriptor',$ns).Count){throw 'Embedded task security descriptors are unsupported'}
 foreach($uri in @($doc.SelectNodes('/t:Task/t:RegistrationInfo/t:URI',$ns))){if($uri.InnerText-cne$path){throw 'Task URI identity mismatch'};[void]$uri.ParentNode.RemoveChild($uri)}
 foreach($decl in @($doc.ChildNodes|Where-Object{$_.NodeType-eq[Xml.XmlNodeType]::XmlDeclaration})){[void]$doc.RemoveChild($decl)}
 return ,$doc
}
function Assert-XmlDepth($node,[int]$depth){if($depth-gt32){throw 'Task XML exceeds nesting bound'};foreach($child in $node.ChildNodes){if($child.NodeType-eq[Xml.XmlNodeType]::Element){Assert-XmlDepth $child ($depth+1)}}}
function Normalize-Sddl([string]$sddl){if([Text.Encoding]::UTF8.GetByteCount($sddl)-gt4096){throw 'Task security descriptor exceeds bounds'};$raw=[Security.AccessControl.RawSecurityDescriptor]::new($sddl);if($null-eq$raw.Owner-or$null-eq$raw.DiscretionaryAcl-or$null-ne$raw.SystemAcl){throw 'Task owner/DACL missing or unsupported audit descriptor'};return $raw.GetSddlForm([Security.AccessControl.AccessControlSections]::Owner-bor[Security.AccessControl.AccessControlSections]::Group-bor[Security.AccessControl.AccessControlSections]::Access)}
function Resolve-Sid([string]$user){if([string]::IsNullOrWhiteSpace($user)){throw 'Task principal is unknown'};if($user.StartsWith('S-1-')){return([Security.Principal.SecurityIdentifier]::new($user)).Value};return([Security.Principal.NTAccount]::new($user)).Translate([Security.Principal.SecurityIdentifier]).Value}
function Task-Instances($task){$out=@();$instances=$task.GetInstances(0);foreach($instance in $instances){$out+=([string]$instance.InstanceGuid)};return $out}
function Assert-NativeDefinition($native,$definition,[string]$caller){
 if((Resolve-Sid([string]$native.Principal.UserId))-cne$caller-or[int]$native.Principal.LogonType-ne3-or[int]$native.Principal.RunLevel-ne0){throw 'Native definition principal mismatch'}
 if([bool]$native.Settings.Enabled){throw 'Native registration must be disabled'}
 $actions=@($native.Actions);if($actions.Count-ne1-or[int]$actions[0].Type-ne0-or[string]$actions[0].Path-cne[string]$definition.program.path){throw 'Native executable definition identity mismatch'}
 if(([string]$actions[0].Arguments).Length-gt2048-or([string]$actions[0].WorkingDirectory).Length-gt1024){throw 'Native action exceeds bounds'}
 foreach($trigger in @($native.Triggers)){if([int]$trigger.Type-notin@(2,3,9)){throw 'Unsupported native task trigger'}}
}
function Task-Snapshot($task,[string]$caller){
 if([int]$task.State-notin@(1,2,3,4)){throw 'Task runtime state is unknown'}
 $path=[string]$task.Path;$doc=Parse-TaskXml ([string]$task.Xml) $path;$definition=$task.Definition;$p=$definition.Principal;$user=Resolve-Sid ([string]$p.UserId)
 if($user-cne$caller-or[int]$p.LogonType-ne3-or[int]$p.RunLevel-ne0){throw 'Task is not caller-owned InteractiveToken/Limited'}
 $ns=[Xml.XmlNamespaceManager]::new($doc.NameTable);$ns.AddNamespace('t',$doc.DocumentElement.NamespaceURI)
 if($doc.SelectNodes('/t:Task/t:Principals/t:Principal',$ns).Count-ne1){throw 'Ambiguous task principal'}
 $actions=@($definition.Actions);if($actions.Count-ne1-or[int]$actions[0].Type-ne0){throw 'Only one native executable action is supported'}
 foreach($trigger in @($definition.Triggers)){if([int]$trigger.Type-notin@(2,3,9)){throw 'Unsupported task trigger'}}
 $sddl=Normalize-Sddl([string]$task.GetSecurityDescriptor(7));if(([Security.AccessControl.RawSecurityDescriptor]::new($sddl)).Owner.Value-cne$caller){throw 'Task security owner differs from authenticated caller'}
 $action=$actions[0];$result=[pscustomobject]@{path=$path;xml=$doc.OuterXml;sddl=$sddl;enabled=[bool]$task.Enabled;principalSid=$user;logonType=[uint32]$p.LogonType;runLevel=[uint32]$p.RunLevel;actions=@([pscustomobject]@{path=[string]$action.Path;arguments=[string]$action.Arguments;workingDirectory=[string]$action.WorkingDirectory});instanceGuids=@(Task-Instances $task)}
 if([Text.Encoding]::UTF8.GetByteCount((ConvertTo-Json -InputObject $result -Depth 10 -Compress))-gt28672){throw 'Task snapshot exceeds transport record bound'};return $result
}
function Task-Row($task,[string]$caller){
 $path=[string]$task.Path;$snapshot=$null;$reason=$null;try{$snapshot=Task-Snapshot $task $caller}catch{$reason=$_.Exception.Message}
 $state= switch([int]$task.State){0{'Unknown'}1{'Disabled'}2{'Queued'}3{'Ready'}4{'Running'}default{'Unknown'}}
 return [pscustomobject]@{path=$path;name=$path.Substring($path.LastIndexOf('\')+1);state=[string]$state;author=[string]$task.Definition.RegistrationInfo.Author;lastRun=([DateTime]$task.LastRunTime).ToString('o');nextRun=([DateTime]$task.NextRunTime).ToString('o');lastResult=[long]$task.LastTaskResult;snapshot=$snapshot;unsupportedReason=$reason}
}
function Is-NotFound($error){$e=$error.Exception;while($e){if($e.HResult-in@(-2147024894,-2147024893)){return $true};$e=$e.InnerException};return $false}
function Get-TaskExact($service,[string]$path){$at=$path.LastIndexOf('\');$folder=if($at-eq0){'\'}else{$path.Substring(0,$at)};$name=$path.Substring($at+1);try{$f=$service.GetFolder($folder);return $f.GetTask($name)}catch{if(Is-NotFound $_){return $null};throw}}
function Assert-Live($request){if([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()-ge[uint64]$request.expiresUtcMs){throw 'Task operation deadline expired'};if(!$script:boundParent){$script:boundParent=[Diagnostics.Process]::GetProcessById([int]$request.parentPid);[void]$script:boundParent.Handle};if($script:boundParent.Id-ne[int]$request.parentPid-or$script:boundParent.HasExited){throw 'Task parent is no longer alive'}}
function Assert-Expected($actual,$expected){
 if($null-eq$expected){if($null-ne$actual){throw 'Task already exists; overwrite is forbidden'};return}
 if($null-eq$actual){throw 'Task disappeared before mutation'}
 foreach($field in @('path','xml','sddl','enabled','principalSid','logonType','runLevel')){if($actual.$field-cne$expected.$field){throw "Task changed before mutation ($field)"}}
 $expectedPath=if($expected.actions[0].program){[string]$expected.actions[0].program.path}else{[string]$expected.actions[0].path}
 if($actual.actions.Count-ne1-or$expected.actions.Count-ne1-or$actual.actions[0].path-cne$expectedPath-or$actual.actions[0].arguments-cne$expected.actions[0].arguments-or$actual.actions[0].workingDirectory-cne$expected.actions[0].workingDirectory){throw 'Task action changed before mutation'}
}
function Assert-PostState($before,$after,[string]$kind,[bool]$enabled){
 $expected=$before.PSObject.Copy()
 if($kind-eq'setEnabled'){$doc=Parse-TaskXml $before.xml $before.path;$ns=[Xml.XmlNamespaceManager]::new($doc.NameTable);$ns.AddNamespace('t',$doc.DocumentElement.NamespaceURI);$node=$doc.SelectSingleNode('/t:Task/t:Settings/t:Enabled',$ns);if(!$node){throw 'Task enabled-state element missing'};$node.InnerText=$enabled.ToString().ToLowerInvariant();$expected.xml=$doc.OuterXml;$expected.enabled=$enabled}
 Assert-Expected $after $expected
}
function Set-TaskElement($doc,$parent,[string]$name,[string]$value){$children=@($parent.ChildNodes|Where-Object{$_.LocalName-ceq$name});if($children.Count-gt1){throw 'Duplicate native task setting'};if($children.Count){$node=$children[0]}else{$node=$doc.CreateElement($name,$doc.DocumentElement.NamespaceURI);[void]$parent.AppendChild($node)};$node.InnerText=$value}
function Normalize-Definition($service,$definition,[bool]$disabled,[string]$role=''){
 $doc=Parse-TaskXml ([string]$definition.xml) ([string]$definition.path);if($disabled){$ns=[Xml.XmlNamespaceManager]::new($doc.NameTable);$ns.AddNamespace('t',$doc.DocumentElement.NamespaceURI);$enabled=$doc.SelectSingleNode('/t:Task/t:Settings/t:Enabled',$ns);if($null-eq$enabled){throw 'Task enabled state missing'};$enabled.InnerText='false'}
 if($role){$ns=[Xml.XmlNamespaceManager]::new($doc.NameTable);$ns.AddNamespace('t',$doc.DocumentElement.NamespaceURI);$settings=$doc.SelectSingleNode('/t:Task/t:Settings',$ns);if(!$settings){throw 'Native task settings missing'};switch($role){
 'signin'{$trigger=$doc.SelectSingleNode('/t:Task/t:Triggers/t:LogonTrigger',$ns);if(!$trigger){throw 'Native sign-in trigger missing'};Set-TaskElement $doc $trigger 'Delay' 'PT20S'}
 'maintenance'{Set-TaskElement $doc $settings 'ExecutionTimeLimit' 'PT2H';Set-TaskElement $doc $settings 'StartWhenAvailable' 'true';$idle=$doc.SelectSingleNode('/t:Task/t:Settings/t:IdleSettings',$ns);if(!$idle){$idle=$doc.CreateElement('IdleSettings',$doc.DocumentElement.NamespaceURI);[void]$settings.AppendChild($idle)};Set-TaskElement $doc $idle 'StopOnIdleEnd' 'false'}
 'background'{Set-TaskElement $doc $settings 'RunOnlyIfIdle' 'true';$idle=$doc.SelectSingleNode('/t:Task/t:Settings/t:IdleSettings',$ns);if(!$idle){$idle=$doc.CreateElement('IdleSettings',$doc.DocumentElement.NamespaceURI);[void]$settings.AppendChild($idle)};Set-TaskElement $doc $idle 'Duration' 'PT15M';Set-TaskElement $doc $idle 'WaitTimeout' 'PT1H';Set-TaskElement $doc $idle 'StopOnIdleEnd' 'false';Set-TaskElement $doc $idle 'RestartOnIdle' 'false'}
 default{throw 'Unknown native task role'}}}
 $task=$service.NewTask(0);$task.XmlText=$doc.OuterXml;$normalized=Parse-TaskXml ([string]$task.XmlText) ([string]$definition.path)
 return [pscustomobject]@{xml=$normalized.OuterXml;sddl=(Normalize-Sddl([string]$definition.sddl))}
}
function Invoke-TaskProvider($service,$request){
 if($request.operation-eq'normalize'){return Normalize-Definition $service $request.definition ([bool]$request.disabled) ([string]$request.ownedRole)}
 if($request.operation-eq'read'){$task=Get-TaskExact $service ([string]$request.path);if($null-eq$task){return $null};return Task-Snapshot $task ([string]$request.callerSid)}
 if($request.operation-eq'metadata'){$task=Get-TaskExact $service ([string]$request.path);if($null-eq$task){return $null};return Task-Row $task ([string]$request.callerSid)}
 if($request.operation-eq'query'){
  $paths=[Collections.Generic.List[object]]::new();$queue=[Collections.Generic.Queue[object]]::new();$queue.Enqueue($service.GetFolder('\'));$folders=0
  while($queue.Count){$folder=$queue.Dequeue();$folders++;if($folders-gt512){throw 'Task folder inventory exceeds bounds'};foreach($task in $folder.GetTasks(1)){if($paths.Count-ge4096){throw 'Task inventory exceeds bounds'};$paths.Add($task)};foreach($child in $folder.GetFolders(0)){$queue.Enqueue($child)}}
  $paths.Sort([Comparison[object]]{param($a,$b);[string]::CompareOrdinal([string]$a.Path,[string]$b.Path)});$rows=@();$next=$null
  foreach($task in $paths){$path=[string]$task.Path;if($request.cursor-and[string]::CompareOrdinal($path,[string]$request.cursor)-le0){continue};$row=Task-Row $task ([string]$request.callerSid)
   $candidate=@($rows)+@($row);$bytes=[Text.Encoding]::UTF8.GetByteCount((ConvertTo-Json -InputObject ([pscustomobject]@{rows=$candidate;nextCursor=$path}) -Depth 12 -Compress));if($rows.Count-and($candidate.Count-gt6-or$bytes-gt190000)){$next=[string]$rows[-1].path;break};if($bytes-gt190000){throw 'Task inventory record exceeds bounds'};$rows=$candidate
  };return [pscustomobject]@{rows=@($rows);nextCursor=$next}
 }
 if($request.operation-ne'apply'){throw 'Unknown native task provider operation'}
 Assert-Live $request;$task=Get-TaskExact $service ([string]$request.path);$before=if($null-ne$task){Task-Snapshot $task ([string]$request.callerSid)}else{$null};Assert-Expected $before $request.expected;$kind=[string]$request.action.kind;$instanceGuid=$null
 if($kind-eq'register'-or$kind-eq'update'){
  $definition=$request.action.definition;if([string]$definition.callerSid-cne[string]$request.callerSid){throw 'Task definition caller mismatch'}
  $normalized=Normalize-Definition $service $definition $true;$native=$service.NewTask(0);$native.XmlText=$normalized.xml
  Assert-NativeDefinition $native $definition ([string]$request.callerSid)
  $at=([string]$request.path).LastIndexOf('\');$folderPath=if($at-eq0){'\'}else{([string]$request.path).Substring(0,$at)};$name=([string]$request.path).Substring($at+1)
  try{$folder=$service.GetFolder($folderPath)}catch{if((Is-NotFound $_)-and$folderPath-ceq'\Purgeon'){Assert-Live $request;$folder=$service.GetFolder('\').CreateFolder('Purgeon',$normalized.sddl)}else{throw}}
  if($kind-eq'update'-and($null-eq$before-or$before.enabled-or$before.instanceGuids.Count)){throw 'Task update requires disabled stopped native-owned definition'}
  Assert-Live $request;$fresh=Get-TaskExact $service ([string]$request.path);Assert-Expected $(if($fresh){Task-Snapshot $fresh ([string]$request.callerSid)}else{$null}) $request.expected
  $flags=if($kind-eq'register'){2-bor8-bor32}else{4-bor8-bor32};$registered=$folder.RegisterTaskDefinition($name,$native,$flags,[string]$request.callerSid,$null,3,$normalized.sddl)
  $after=Task-Snapshot $registered ([string]$request.callerSid);if($after.enabled){throw 'Registered task was not disabled'}
  if($after.xml-cne$normalized.xml-or$after.sddl-cne$normalized.sddl){throw 'Registered task definition/security readback mismatch'}
 }else{
  if($null-eq$before){throw 'Task missing before mutation'};Assert-Live $request
  switch($kind){
   'setEnabled'{$task.Enabled=[bool]$request.action.enabled}
   'run'{$instance=$task.Run($null);$instanceGuid=[string]$instance.InstanceGuid;if([string]::IsNullOrWhiteSpace($instanceGuid)){throw 'Task run returned no instance identity'}}
   'stop'{$wanted=@($request.action.instanceGuids);$instances=@($task.GetInstances(0));if(!$wanted.Count-or$wanted.Count-gt64){throw 'Stop requires exact running instance identities'};foreach($id in $wanted){$matches=@($instances|Where-Object{[string]$_.InstanceGuid-ceq[string]$id});if($matches.Count-ne1){throw 'Task running instances changed'};Assert-Live $request;$matches[0].Stop(0)}}
   'delete'{$latest=Task-Snapshot (Get-TaskExact $service ([string]$request.path)) ([string]$request.callerSid);Assert-Expected $latest $request.expected;if($latest.enabled-or$latest.instanceGuids.Count-or([string]$latest.path).StartsWith('\Microsoft\',[StringComparison]::OrdinalIgnoreCase)){throw 'Deletion requires a disabled stopped non-Windows task'};$at=([string]$request.path).LastIndexOf('\');$folder=if($at-eq0){'\'}else{([string]$request.path).Substring(0,$at)};Assert-Live $request;$service.GetFolder($folder).DeleteTask(([string]$request.path).Substring($at+1),0)}
   default{throw 'Unsupported native task action'}
  }
  $readback=Get-TaskExact $service ([string]$request.path);$after=if($readback){Task-Snapshot $readback ([string]$request.callerSid)}else{$null}
  if($kind-eq'delete'){if($null-ne$after){throw 'Task deletion was not confirmed'}}elseif($null-eq$after){throw 'Task disappeared after mutation'}
  if($kind-eq'setEnabled'-and$after.enabled-ne[bool]$request.action.enabled){throw 'Task enabled-state readback mismatch'}
  if($kind-eq'stop'){foreach($id in @($request.action.instanceGuids)){if($after.instanceGuids-contains$id){throw 'Task instance stop was not confirmed'}}}
  if($kind-ne'delete'){Assert-PostState $before $after $kind ([bool]$request.action.enabled)}
 }
 return [pscustomobject]@{snapshot=$after;instanceGuid=$instanceGuid}
}
# LIVE_PROVIDER: tests execute only the pure functions above with fake objects.
$requestText=[Console]::In.ReadToEnd();if([Text.Encoding]::UTF8.GetByteCount($requestText)-gt65536){throw 'Task request too large'};$request=ConvertFrom-Json -InputObject $requestText -ErrorAction Stop
$classes=$null;$service=$null;$overridden=$false
Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class PurgeonTaskRegistry{[DllImport("advapi32.dll")]public static extern int RegOverridePredefKey(IntPtr key,IntPtr replacement);[DllImport("ole32.dll")]private static extern int CoInitializeEx(IntPtr reserved,uint mode);[DllImport("ole32.dll")]private static extern void CoUninitialize();[DllImport("ole32.dll")]private static extern int CoCreateInstance(ref Guid clsid,IntPtr outer,uint context,ref Guid iid,out IntPtr value);private static bool initialized;public static object Create(){int init=CoInitializeEx(IntPtr.Zero,2);if(init!=0&&init!=1){throw new COMException("Task provider COM initialization failed",init);}initialized=true;Guid clsid=new Guid("0F87369F-A4E5-4CFC-BD3E-73E6154572DD");Guid iid=new Guid("00020400-0000-0000-C000-000000000046");IntPtr value=IntPtr.Zero;int status=CoCreateInstance(ref clsid,IntPtr.Zero,1,ref iid,out value);try{if(status<0){Marshal.ThrowExceptionForHR(status);}if(value==IntPtr.Zero){throw new InvalidOperationException("Task provider COM returned no interface");}return Marshal.GetObjectForIUnknown(value);}finally{if(value!=IntPtr.Zero){Marshal.Release(value);}}}public static void Close(){if(initialized){CoUninitialize();initialized=false;}}}' -ErrorAction Stop
try{
 $classes=[Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SOFTWARE\Classes',$false);if($null-eq$classes){throw 'Machine COM classes unavailable'}
 $clsid='{0F87369F-A4E5-4CFC-BD3E-73E6154572DD}';$class=$classes.OpenSubKey('CLSID\'+$clsid,$false);if($null-eq$class){throw 'Machine Task Scheduler registration unavailable'}
 try{foreach($key in @('TreatAs','AutoConvertTo','InprocHandler','InprocHandler32','LocalServer','LocalServer32')){$other=$class.OpenSubKey($key,$false);if($other){$other.Dispose();throw 'Unsupported Task Scheduler COM redirection'}};$server=$class.OpenSubKey('InprocServer32',$false);if(!$server){throw 'Task Scheduler in-process registration missing'};try{$value=[string]$server.GetValue('',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames);$system=[Environment]::SystemDirectory;$windows=[IO.Directory]::GetParent($system).FullName;$value=$value.Replace('%SystemRoot%',$windows).Replace('%systemroot%',$windows);if(![IO.Path]::GetFullPath($value).Equals([IO.Path]::Combine($system,'taskschd.dll'),[StringComparison]::OrdinalIgnoreCase)){throw 'Task Scheduler COM server is not the native system DLL'}}finally{$server.Dispose()}}finally{$class.Dispose()}
 $callerOverride=[Microsoft.Win32.Registry]::Users.OpenSubKey(([string]$request.callerSid)+'\Software\Classes\CLSID\'+$clsid,$false);if($callerOverride){$callerOverride.Dispose();throw 'Caller Task Scheduler COM override is unsupported'}
 $code=[PurgeonTaskRegistry]::RegOverridePredefKey([IntPtr](-2147483648),$classes.Handle);if($code-ne0){throw "Machine-only COM registry mapping failed ($code)"};$overridden=$true
 $service=[PurgeonTaskRegistry]::Create();$service.Connect()
 $result=Invoke-TaskProvider $service $request;$json=ConvertTo-Json -InputObject $result -Depth 14 -Compress;if([Text.Encoding]::UTF8.GetByteCount($json)-gt196608){throw 'Task response exceeds transport bound'};[Console]::Out.Write($json)
}finally{
 try{if($service-and[Runtime.InteropServices.Marshal]::IsComObject($service)){[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($service)};$service=$null;[GC]::Collect();[GC]::WaitForPendingFinalizers();[GC]::Collect()}finally{
  try{[PurgeonTaskRegistry]::Close()}finally{try{if($overridden){$code=[PurgeonTaskRegistry]::RegOverridePredefKey([IntPtr](-2147483648),[IntPtr]::Zero);if($code-ne0){throw "COM registry mapping restore failed ($code)"}}}finally{if($classes){$classes.Dispose()};if($script:boundParent){$script:boundParent.Dispose()}}}
 }
}
"#;

#[cfg(test)]
mod tests {
    use super::*;
    fn program() -> Program {
        Program {
            path: r"C:\Tools\example.exe".into(),
            digest: "a".repeat(64),
            bytes: 1024,
            modified: "123".into(),
        }
    }
    fn snapshot() -> Snapshot {
        Snapshot {
            path: "\\Example".into(),
            xml: "<Task/>".into(),
            sddl: "O:S-1-5-21-1G:S-1-5-21-1D:(A;;FA;;;S-1-5-21-1)".into(),
            enabled: false,
            principal_sid: "S-1-5-21-1".into(),
            logon_type: 3,
            run_level: 0,
            actions: vec![ExecAction {
                program: program(),
                arguments: String::new(),
                working_directory: String::new(),
            }],
            instance_guids: vec![],
        }
    }
    #[test]
    fn snapshot_authority_and_program_class_are_closed() {
        let s = snapshot();
        s.validate("S-1-5-21-1").unwrap();
        let mut running = s.clone();
        running
            .instance_guids
            .push("{11111111-1111-1111-1111-111111111111}".into());
        assert_eq!(s.fingerprint().unwrap(), running.fingerprint().unwrap());
        for field in [
            "path",
            "xml",
            "sddl",
            "enabled",
            "principalSid",
            "logonType",
            "runLevel",
            "actions",
            "instanceGuids",
        ] {
            let mut value = serde_json::to_value(&s).unwrap();
            value.as_object_mut().unwrap().remove(field);
            assert!(
                serde_json::from_value::<Snapshot>(value).is_err(),
                "{field}"
            );
        }
        let mut bad = s.clone();
        bad.run_level = 1;
        assert!(bad.validate("S-1-5-21-1").is_err());
        let mut bad = s.clone();
        bad.logon_type = 1;
        assert!(bad.validate("S-1-5-21-1").is_err());
        assert!(s.validate("S-1-5-21-2").is_err());
        for path in [
            r"C:\Windows\System32\cmd.exe",
            r"C:\Tools\script.ps1",
            r"\\server\example.exe",
        ] {
            let mut p = program();
            p.path = path.into();
            assert!(program_fields(&p).is_err());
        }
        for path in [
            "Example",
            "\\Microsoft\\..\\Example",
            "\\Folder\\",
            "\\Example:stream",
            "\\ Example",
        ] {
            assert!(task_path(path).is_err());
        }
        assert!(serde_json::from_str::<Outcome>(r#"{"snapshot":null}"#).is_err());
        assert!(serde_json::from_str::<Outcome>(r#"{"instanceGuid":null}"#).is_err());
    }
    const FAKE: &str = r#"
$script:fixtureSid='S-1-5-21-1';$script:fixtureSddl='O:S-1-5-21-1G:S-1-5-21-1D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;S-1-5-21-1)';$script:effects=@();$script:instances=@();$script:missingCode=-2147024894
$script:fixtureXml='<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><RegistrationInfo><Description>Example</Description></RegistrationInfo><Triggers><LogonTrigger><Enabled>true</Enabled><UserId>S-1-5-21-1</UserId></LogonTrigger></Triggers><Principals><Principal id="Author"><UserId>S-1-5-21-1</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><Enabled>false</Enabled></Settings><Actions Context="Author"><Exec><Command>C:\Tools\example.exe</Command><Arguments></Arguments></Exec></Actions></Task>'
function New-FakeDefinition{
 $d=[pscustomobject]@{StoredXml='';Principal=$null;Settings=$null;Actions=@();Triggers=@()}
 $d|Add-Member ScriptProperty XmlText {$this.StoredXml} {$this.StoredXml=[string]$args[0];$xml=Parse-TaskXml $this.StoredXml '\Example';$ns=[Xml.XmlNamespaceManager]::new($xml.NameTable);$ns.AddNamespace('t',$xml.DocumentElement.NamespaceURI);$this.Principal=[pscustomobject]@{UserId=$xml.SelectSingleNode('//t:Principal/t:UserId',$ns).InnerText;LogonType=3;RunLevel=0};$this.Settings=[pscustomobject]@{Enabled=($xml.SelectSingleNode('/t:Task/t:Settings/t:Enabled',$ns).InnerText-eq'true')};$this.Actions=@($xml.SelectNodes('/t:Task/t:Actions/t:Exec',$ns)|ForEach-Object{[pscustomobject]@{Type=0;Path=$_.Command;Arguments=[string]$_.Arguments;WorkingDirectory=[string]$_.WorkingDirectory}});$this.Triggers=@($xml.SelectNodes('/t:Task/t:Triggers/*',$ns)|ForEach-Object{[pscustomobject]@{Type=$(if($_.LocalName-eq'LogonTrigger'){9}elseif($_.ScheduleByWeek){3}else{2})}})}
 return $d
}
function New-FakeTask([string]$path,[string]$xml){
 $definition=New-FakeDefinition;$definition.XmlText=$xml;$t=[pscustomobject]@{Path=$path;Enabled=$false;StoredXml=$xml;Definition=$definition;State=3;LastRunTime=[DateTime]'2026-01-01';NextRunTime=[DateTime]'2026-01-02';LastTaskResult=0}
 $t|Add-Member ScriptProperty Xml {$doc=Parse-TaskXml $this.StoredXml $this.Path;$ns=[Xml.XmlNamespaceManager]::new($doc.NameTable);$ns.AddNamespace('t',$doc.DocumentElement.NamespaceURI);$doc.SelectSingleNode('/t:Task/t:Settings/t:Enabled',$ns).InnerText=([bool]$this.Enabled).ToString().ToLowerInvariant();$doc.OuterXml}
 $t|Add-Member ScriptMethod GetSecurityDescriptor {param($flags);if($flags-ne7){throw 'fixture wrong security scope'};return $script:fixtureSddl}
 $t|Add-Member ScriptMethod GetInstances {param($flags);foreach($id in $script:instances){$i=[pscustomobject]@{InstanceGuid=$id};$i|Add-Member ScriptMethod Stop {param($flags);$script:effects+='stop';$script:instances=@($script:instances|Where-Object{$_-cne$this.InstanceGuid})};$i}}
 $t|Add-Member ScriptMethod Run {param($args);$script:effects+='run';$id='{11111111-1111-1111-1111-111111111111}';$script:instances+=@($id);[pscustomobject]@{InstanceGuid=$id}}
 return $t
}
$script:fixtureTask=New-FakeTask '\Example' $script:fixtureXml
$script:fixtureFolder=[pscustomobject]@{}
$script:fixtureFolder|Add-Member ScriptMethod GetTask {param($name);if($null-eq$script:fixtureTask){throw [Runtime.InteropServices.COMException]::new('missing fixture',$script:missingCode)};return $script:fixtureTask}
$script:fixtureFolder|Add-Member ScriptMethod DeleteTask {param($name,$flags);$script:effects+='delete';$script:fixtureTask=$null}
$script:fixtureFolder|Add-Member ScriptMethod RegisterTaskDefinition {param($name,$definition,$flags,$user,$password,$logon,$sddl);if($script:fixtureTask){throw 'fixture overwrite'};if($flags-ne42-or$logon-ne3-or$null-ne$password){throw 'fixture unsafe registration'};$script:effects+='register';$script:fixtureSddl=$sddl;$script:fixtureTask=New-FakeTask ('\'+$name) $definition.XmlText;return $script:fixtureTask}
$script:fixtureService=[pscustomobject]@{}
$script:fixtureService|Add-Member ScriptMethod GetFolder {param($path);return $script:fixtureFolder}
$script:fixtureService|Add-Member ScriptMethod NewTask {param($flags);return New-FakeDefinition}
function Fixture-Request($kind,$before){[pscustomobject]@{operation='apply';action=[pscustomobject]@{kind=$kind};expected=$before;path='\Example';callerSid=$script:fixtureSid;expiresUtcMs=([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()+60000);parentPid=$PID}}
function Fixture-Expected{$before=Task-Snapshot $script:fixtureTask $script:fixtureSid;$a=$before.actions[0];$before.actions=@([pscustomobject]@{program=[pscustomobject]@{path=$a.path};arguments=$a.arguments;workingDirectory=$a.workingDirectory});return $before}
"#;
    fn pure_fixture_provider(source: &str) -> Result<&str, &'static str> {
        let (pure, _live) = source
            .split_once("# LIVE_PROVIDER:")
            .ok_or("Pure provider boundary marker missing")?;
        if pure.contains("Add-Type -TypeDefinition")
            || pure.contains("RegOverridePredefKey(")
            || pure.contains("[PurgeonTaskRegistry]::")
            || pure.contains("$requestText=")
        {
            return Err("Live provider activation entered pure fixture prefix");
        }
        Ok(pure)
    }
    #[test]
    fn missing_or_moved_fixture_boundary_fails_before_launch() {
        assert!(pure_fixture_provider(
            &PROVIDER.replace("# LIVE_PROVIDER:", "# RENAMED_BOUNDARY:")
        )
        .is_err());
        assert!(pure_fixture_provider(
            "[PurgeonTaskRegistry]::Create(); # LIVE_PROVIDER: trailing"
        )
        .is_err());
        let pure = pure_fixture_provider(PROVIDER).unwrap();
        assert!(!pure.contains("$requestText="));
        assert!(!pure.contains("RegOverridePredefKey("));
    }
    fn fake(body: &str) -> serde_json::Value {
        let pure = pure_fixture_provider(PROVIDER)
            .expect("Refuse PowerShell launch without a verified pure fixture boundary");
        let source = format!("{pure}\n{FAKE}\n{body}");
        let mut command = Command::new(windows_tools::system_file("powershell.exe").unwrap());
        command
            .env_remove("PSModulePath")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "[Console]::InputEncoding=[Text.UTF8Encoding]::new($false); & ([scriptblock]::Create([Console]::In.ReadToEnd()))",
            ])
            .creation_flags(0x0800_0000);
        let result =
            process_io::execute(&mut command, Some(source), Duration::from_secs(20)).unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        serde_json::from_slice(&result.stdout).unwrap()
    }
    #[test]
    fn provider_parses_and_missing_never_means_access_denied() {
        let code = STANDARD.encode(PROVIDER.as_bytes());
        let result = fake(&format!(
            r#"$source=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{code}'));$tokens=$null;$errors=$null;[void][Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$errors);if($errors.Count){{throw ($errors.Message-join '; ')}};$script:fixtureTask=$null;$missing=@();foreach($number in @(-2147024894,-2147024893)){{$script:missingCode=$number;$missing+=($null-eq(Get-TaskExact $script:fixtureService '\Example'))}};$script:missingCode=-2147024891;$denied=$false;try{{[void](Get-TaskExact $script:fixtureService '\Example')}}catch{{$denied=$true}};[pscustomobject]@{{missing=$missing;denied=$denied}}|ConvertTo-Json -Compress"#
        ));
        assert_eq!(result["missing"], serde_json::json!([true, true]));
        assert_eq!(result["denied"], true);
    }
    #[test]
    fn provider_rejects_dtd_depth_and_corrupt_native_actions_before_registration() {
        let result = fake(
            r#"$refused=0;foreach($xml in @('<!DOCTYPE Task [<!ENTITY x SYSTEM "file:///never-read">]><Task xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">&x;</Task>',('<Task xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">'+('<x>'*33)+('</x>'*33)+'</Task>'))){try{[void](Parse-TaskXml $xml '\Example')}catch{$refused++}};$script:fixtureTask=$null;$q=Fixture-Request 'register' $null;$q.action|Add-Member NoteProperty definition ([pscustomobject]@{path='\Example';xml=$script:fixtureXml;sddl=$script:fixtureSddl;callerSid=$script:fixtureSid;program=[pscustomobject]@{path='C:\Tools\other.exe'}});$invalid=$false;try{[void](Invoke-TaskProvider $script:fixtureService $q)}catch{$invalid=$true};[pscustomobject]@{refused=$refused;invalid=$invalid;effects=@($script:effects)}|ConvertTo-Json -Depth 4 -Compress"#,
        );
        assert_eq!(result["refused"], 2);
        assert_eq!(result["invalid"], true);
        assert_eq!(result["effects"], serde_json::json!([]));
    }
    #[test]
    fn provider_disabled_creation_uses_create_only_and_known_normalization() {
        let result = fake(
            r#"$script:fixtureTask=$null;$q=Fixture-Request 'register' $null;$q.action|Add-Member NoteProperty definition ([pscustomobject]@{path='\Example';xml=$script:fixtureXml;sddl=$script:fixtureSddl;callerSid=$script:fixtureSid;program=[pscustomobject]@{path='C:\Tools\example.exe'}});$out=Invoke-TaskProvider $script:fixtureService $q;$collision=$false;try{[void](Invoke-TaskProvider $script:fixtureService $q)}catch{$collision=$true};$normal=Normalize-Definition $script:fixtureService $q.action.definition $true;$doc=Parse-TaskXml $normal.xml '\Example';$ns=[Xml.XmlNamespaceManager]::new($doc.NameTable);$ns.AddNamespace('t',$doc.DocumentElement.NamespaceURI);[pscustomobject]@{enabled=$out.snapshot.enabled;collision=$collision;trigger=$doc.SelectSingleNode('//t:LogonTrigger/t:Enabled',$ns).InnerText;effects=@($script:effects)}|ConvertTo-Json -Depth 4 -Compress"#,
        );
        assert_eq!(result["enabled"], false);
        assert_eq!(result["collision"], true);
        assert_eq!(result["trigger"], "true");
        assert_eq!(result["effects"], serde_json::json!(["register"]));
    }
    #[test]
    fn provider_delete_rechecks_disabled_stopped_nonwindows_and_expiry() {
        let result = fake(
            r#"$refused=0;foreach($mode in @('enabled','running','windows','expired')){$script:fixtureTask=New-FakeTask '\Example' $script:fixtureXml;$script:instances=@();if($mode-eq'enabled'){$script:fixtureTask.Enabled=$true};if($mode-eq'running'){$script:instances=@('{11111111-1111-1111-1111-111111111111}')};if($mode-eq'windows'){$script:fixtureTask.Path='\Microsoft\Example'};$before=Fixture-Expected;$q=Fixture-Request 'delete' $before;$q.path=$script:fixtureTask.Path;if($mode-eq'expired'){$q.expiresUtcMs=1};try{[void](Invoke-TaskProvider $script:fixtureService $q)}catch{$refused++}};[pscustomobject]@{refused=$refused;effects=@($script:effects)}|ConvertTo-Json -Depth 4 -Compress"#,
        );
        assert_eq!(result["refused"], 4);
        assert_eq!(result["effects"], serde_json::json!([]));
    }
    #[test]
    fn provider_stops_only_selected_instance_and_rejects_stale_state() {
        let result = fake(
            r#"$script:instances=@('{11111111-1111-1111-1111-111111111111}','{22222222-2222-2222-2222-222222222222}');$before=Fixture-Expected;$q=Fixture-Request 'stop' $before;$q.action|Add-Member NoteProperty instanceGuids @('{11111111-1111-1111-1111-111111111111}');$out=Invoke-TaskProvider $script:fixtureService $q;$q=Fixture-Request 'run' (Fixture-Expected);$q.expected.xml+=' ';$stale=$false;try{[void](Invoke-TaskProvider $script:fixtureService $q)}catch{$stale=$true};[pscustomobject]@{instances=@($out.snapshot.instanceGuids);stale=$stale;effects=@($script:effects)}|ConvertTo-Json -Depth 4 -Compress"#,
        );
        assert_eq!(
            result["instances"],
            serde_json::json!(["{22222222-2222-2222-2222-222222222222}"])
        );
        assert_eq!(result["stale"], true);
        assert_eq!(result["effects"], serde_json::json!(["stop"]));
    }
    #[test]
    fn provider_ordinal_paging_never_skips_mixed_case_or_unicode_names() {
        let result = fake(
            r#"$script:inventory=@(foreach($path in @('\éclair','\apple','\Ωmega','\Banana','\delta','\Zoo','\Élan','\cat')){New-FakeTask $path $script:fixtureXml});$script:fixtureFolder|Add-Member ScriptMethod GetTasks {param($flags);return $script:inventory};$script:fixtureFolder|Add-Member ScriptMethod GetFolders {param($flags);return @()};$q=[pscustomobject]@{operation='query';callerSid=$script:fixtureSid;cursor=$null};$first=Invoke-TaskProvider $script:fixtureService $q;$q.cursor=$first.nextCursor;$second=Invoke-TaskProvider $script:fixtureService $q;[pscustomobject]@{paths=@($first.rows.path)+@($second.rows.path);firstCount=$first.rows.Count;next=$second.nextCursor;bytes=[Text.Encoding]::UTF8.GetByteCount((ConvertTo-Json -InputObject $first -Depth 12 -Compress))}|ConvertTo-Json -Depth 4 -Compress"#,
        );
        assert_eq!(
            result["paths"],
            serde_json::json!([
                "\\Banana",
                "\\Zoo",
                "\\apple",
                "\\cat",
                "\\delta",
                "\\Élan",
                "\\éclair",
                "\\Ωmega"
            ])
        );
        assert_eq!(result["firstCount"], 6);
        assert!(result["next"].is_null());
        assert!(result["bytes"].as_u64().unwrap() < MAX_PAGE as u64);
    }
    #[test]
    fn provider_poststate_detects_definition_security_and_action_drift() {
        let result = fake(
            r#"$before=Task-Snapshot $script:fixtureTask $script:fixtureSid;$refused=0;foreach($field in @('xml','sddl','action')){$after=$before.PSObject.Copy();if($field-eq'xml'){$after.xml=$after.xml.Replace('Example','Changed')}elseif($field-eq'sddl'){$after.sddl=$after.sddl+' ' }else{$after.actions=@([pscustomobject]@{path='C:\Tools\other.exe';arguments='';workingDirectory=''})};try{Assert-PostState $before $after 'run' $false}catch{$refused++}};$script:fixtureTask.Enabled=$true;$after=Task-Snapshot $script:fixtureTask $script:fixtureSid;$toggle=$false;try{Assert-PostState $before $after 'setEnabled' $true;$toggle=$true}catch{};[pscustomobject]@{refused=$refused;toggle=$toggle}|ConvertTo-Json -Compress"#,
        );
        assert_eq!(result["refused"], 3);
        assert_eq!(result["toggle"], true);
    }
    #[test]
    fn machine_only_inprocess_activation_compiles_without_activating_com() {
        let csharp = PROVIDER
            .split("Add-Type -TypeDefinition '")
            .nth(1)
            .unwrap()
            .split("' -ErrorAction Stop")
            .next()
            .unwrap();
        assert!(csharp.contains("CoCreateInstance(ref clsid,IntPtr.Zero,1,ref iid,out value)"));
        assert!(csharp.contains("0F87369F-A4E5-4CFC-BD3E-73E6154572DD"));
        assert!(csharp.contains("00020400-0000-0000-C000-000000000046"));
        assert!(PROVIDER.contains("RegOverridePredefKey([IntPtr](-2147483648),$classes.Handle)"));
        let code = STANDARD.encode(csharp.as_bytes());
        let body=format!("$source=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{code}'));Add-Type -TypeDefinition $source -ErrorAction Stop;[pscustomobject]@{{create=($null-ne[PurgeonTaskRegistry].GetMethod('Create'));close=($null-ne[PurgeonTaskRegistry].GetMethod('Close'))}}|ConvertTo-Json -Compress");
        let result = fake(&body);
        assert_eq!(result["create"], true);
        assert_eq!(result["close"], true);
    }
    #[test]
    fn exact_metadata_avoids_enumeration_and_preserves_disabled_running_status() {
        let result = fake(
            r#"$script:fixtureFolder|Add-Member ScriptMethod GetTasks {throw 'Whole inventory must not run'};$script:fixtureFolder|Add-Member ScriptMethod GetFolders {throw 'Whole inventory must not run'};$script:fixtureTask.State=4;$script:fixtureTask.Enabled=$false;$script:instances=@('{11111111-1111-1111-1111-111111111111}');$q=[pscustomobject]@{operation='metadata';path='\Example';callerSid=$script:fixtureSid};$row=Invoke-TaskProvider $script:fixtureService $q;$script:fixtureTask=$null;$missing=($null-eq(Invoke-TaskProvider $script:fixtureService $q));$script:missingCode=-2147024891;$denied=$false;try{[void](Invoke-TaskProvider $script:fixtureService $q)}catch{$denied=$true};[pscustomobject]@{path=$row.path;state=$row.state;enabled=$row.snapshot.enabled;instances=@($row.snapshot.instanceGuids);missing=$missing;denied=$denied}|ConvertTo-Json -Depth 4 -Compress"#,
        );
        assert_eq!(result["path"], "\\Example");
        assert_eq!(result["state"], "Running");
        assert_eq!(result["enabled"], false);
        assert_eq!(
            result["instances"],
            serde_json::json!(["{11111111-1111-1111-1111-111111111111}"])
        );
        assert_eq!(result["missing"], true);
        assert_eq!(result["denied"], true);
    }
}
