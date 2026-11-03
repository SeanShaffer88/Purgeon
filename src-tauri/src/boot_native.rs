//! Closed Boot operations. Native snapshots and protected journals are the only
//! authority for changes and undo; no renderer-supplied BCD identity is trusted.
use crate::{
    broker,
    state_store::{self, Authority, Domain},
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    os::windows::process::CommandExt,
    process::Command,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const PIPE_PREFIX: &str = "\\\\.\\pipe\\Purgeon-Boot-";
const TTL_MS: u64 = 120_000;
// Storage scope only. The authenticated caller SID is bound separately in every
// envelope/journal. Users may read this shared machine gate, never write it.
const STORE_SID: &str = "S-1-5-32-545";
const CURRENT: &str = "{fa926493-6f1c-4193-a414-58f0b2456d1e}";
const MANAGER: &str = "{9dea862c-5cdd-4e70-acc1-f32b344d4795}";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Core {
    loader_id: String,
    loader_type: u32,
    manager_id: String,
    manager_type: u32,
    #[serde(deserialize_with = "required_option")]
    safe_boot: Option<u64>,
    #[serde(deserialize_with = "required_option")]
    alternate_shell: Option<bool>,
    #[serde(deserialize_with = "required_option")]
    timeout: Option<u64>,
}
fn required_option<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}
fn valid_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit())
}
fn valid_guid(id: &str) -> bool {
    id.len() == 38
        && id.starts_with('{')
        && id.ends_with('}')
        && id[1..37].bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
}
impl Core {
    fn validate(&self) -> Result<(), String> {
        if !valid_guid(&self.loader_id)
            || self.loader_id.eq_ignore_ascii_case(CURRENT)
            || self.loader_id.eq_ignore_ascii_case(MANAGER)
            || self.loader_type != 0x1020_0003
            || !self.manager_id.eq_ignore_ascii_case(MANAGER)
            || self.manager_type != 0x1010_0002
        {
            return Err("Windows did not resolve a supported current boot-loader identity".into());
        }
        Ok(())
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Entry {
    id: String,
    name: String,
    is_current: bool,
    is_default: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Inventory {
    core: Core,
    entries: Vec<Entry>,
}
impl Inventory {
    fn validate(&self) -> Result<(), String> {
        self.core.validate()?;
        if self.entries.is_empty()
            || self.entries.len() > 128
            || self
                .entries
                .iter()
                .any(|e| !valid_guid(&e.id) || e.name.len() > 1024 || e.name.contains('\0'))
            || self
                .entries
                .iter()
                .filter(|e| e.is_current && e.id == self.core.loader_id)
                .count()
                != 1
        {
            return Err("Invalid structured Boot inventory".into());
        }
        let mut ids = std::collections::HashSet::new();
        if self.entries.iter().any(|e| !ids.insert(&e.id)) {
            return Err("Duplicate boot-loader identity".into());
        }
        Ok(())
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct State {
    timeout: Option<u64>,
    safeboot: &'static str,
    entries: Vec<Entry>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Mode {
    None,
    Minimal,
    Network,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Request {
    SafeBoot { mode: Mode },
    Timeout { seconds: u16 },
    Undo { journal_id: String },
}
impl Request {
    fn validate(&self) -> Result<(), String> {
        match self {
            Self::Timeout { seconds } if *seconds > 999 => {
                Err("The boot menu wait must be between 0 and 999 seconds".into())
            }
            Self::Undo { journal_id } if !valid_id(journal_id) => {
                Err("Invalid native Boot journal identity".into())
            }
            _ => Ok(()),
        }
    }
    fn target(&self, before: &Core) -> Result<Core, String> {
        self.validate()?;
        before.validate()?;
        let mut after = before.clone();
        match self {
            Self::SafeBoot { mode } => {
                if before.alternate_shell == Some(true) || before.safe_boot.is_some_and(|v| v > 1) {
                    return Err(
                        "This specialist or alternate-shell start mode is not changed by Purgeon"
                            .into(),
                    );
                }
                after.safe_boot = match mode {
                    Mode::None => None,
                    Mode::Minimal => Some(0),
                    Mode::Network => Some(1),
                };
            }
            Self::Timeout { seconds } => after.timeout = Some(u64::from(*seconds)),
            Self::Undo { .. } => {
                return Err("Undo requires an owned completed native journal".into())
            }
        }
        Ok(after)
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Envelope {
    request: Request,
    before: Core,
    after: Core,
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
    id: String,
    summary: String,
    requires_elevation: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResultView {
    ok: bool,
    journal_id: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Journal {
    version: u8,
    id: String,
    caller_sid: String,
    request: Request,
    before: Core,
    after: Core,
    completed: bool,
    undone: bool,
}
impl Journal {
    fn validate(&self, id: &str) -> Result<(), String> {
        self.before.validate()?;
        self.after.validate()?;
        self.request.validate()?;
        if self.version != 1
            || self.id != id
            || !valid_id(&self.id)
            || !valid_sid(&self.caller_sid)
            || self.before.loader_id != self.after.loader_id
            || self.before.manager_id != self.after.manager_id
            || self.before.alternate_shell != self.after.alternate_shell
            || self.before.loader_type != self.after.loader_type
            || self.before.manager_type != self.after.manager_type
        {
            return Err("Invalid native Boot journal; retained for review".into());
        }
        if !matches!(self.request, Request::Undo { .. })
            && self.request.target(&self.before)? != self.after
        {
            return Err("Boot journal target does not match its closed operation".into());
        }
        if self.undone && (!self.completed || matches!(self.request, Request::Undo { .. })) {
            return Err("Invalid Boot undo journal state".into());
        }
        Ok(())
    }
}
fn valid_sid(sid: &str) -> bool {
    sid.starts_with("S-")
        && sid.len() <= 184
        && sid[2..].bytes().all(|b| b.is_ascii_digit() || b == b'-')
}
fn now_ms() -> Result<u64, String> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis() as u64)
}
fn deadline(envelope: &Envelope) -> Result<(), String> {
    let now = now_ms()?;
    if !valid_id(&envelope.plan_id)
        || !valid_sid(&envelope.caller_sid)
        || envelope.parent_pid == 0
        || envelope.deadline_utc_ms < now
        || envelope.deadline_utc_ms > now.saturating_add(TTL_MS)
    {
        return Err("Boot plan expired or identity is invalid; refresh and review again".into());
    }
    Ok(())
}
fn summary(request: &Request) -> String {
    match request {
        Request::SafeBoot { mode } => format!("Change the current Windows loader to {mode:?}. Safe Mode persists across restarts until changed back. This does not restart the PC. If Windows cannot start, use Windows Recovery to inspect the correct loader before clearing its safeboot element."),
        Request::Timeout { seconds } => format!("Set the Windows boot-menu wait to {seconds} seconds. This is persistent and does not restart the PC."),
        Request::Undo { .. } => "Restore the exact native-recorded previous Boot setting, including original absence. This may re-enable persistent Safe Mode or an indefinite boot-menu wait; it does not restart the PC.".into(),
    }
}
trait Executor {
    fn inventory(&mut self) -> Result<Inventory, String>;
    fn confirm(&mut self, envelope: &Envelope) -> Result<(), String>;
    fn read(&mut self, id: &str) -> Result<Option<Journal>, String>;
    fn save(&mut self, id: &str, journal: &Journal) -> Result<(), String>;
    fn apply(&mut self, before: &Core, after: &Core) -> Result<(), String>;
}
struct NativeExecutor;
fn journal_hash() -> String {
    Sha256::digest(b"Purgeon Boot journal v1")
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
impl Executor for NativeExecutor {
    fn inventory(&mut self) -> Result<Inventory, String> {
        local_inventory()
    }
    fn confirm(&mut self, envelope: &Envelope) -> Result<(), String> {
        broker::confirm_native(&format!("{}\n\nCurrent loader: {}\nBoot manager: {}\nSafeBoot: {:?} -> {:?}\nAlternate shell (preserved): {:?}\nBoot-menu timeout: {:?} -> {:?}\nNone means the element is absent; absent timeout means indefinite waiting.\n\nNative recovery journal: {}",summary(&envelope.request),envelope.before.loader_id,envelope.before.manager_id,envelope.before.safe_boot,envelope.after.safe_boot,envelope.before.alternate_shell,envelope.before.timeout,envelope.after.timeout,envelope.plan_id))
    }
    fn read(&mut self, id: &str) -> Result<Option<Journal>, String> {
        if id != "head" && !valid_id(id) {
            return Err("Invalid Boot journal key".into());
        }
        state_store::read(
            Domain::Boot,
            Authority::Machine,
            STORE_SID,
            &journal_hash(),
            id,
        )?
        .map(|bytes| {
            let journal: Journal = serde_json::from_slice(&bytes)
                .map_err(|e| format!("Boot journal is unreadable; evidence retained: {e}"))?;
            journal.validate(if id == "head" { &journal.id } else { id })?;
            Ok(journal)
        })
        .transpose()
    }
    fn save(&mut self, id: &str, journal: &Journal) -> Result<(), String> {
        journal.validate(&journal.id)?;
        state_store::write(
            Domain::Boot,
            Authority::Machine,
            STORE_SID,
            &journal_hash(),
            id,
            &serde_json::to_vec(journal).map_err(|e| e.to_string())?,
        )
    }
    fn apply(&mut self, before: &Core, after: &Core) -> Result<(), String> {
        run_bcd(Some((before, after))).map(|_| ())
    }
}
fn available(executor: &mut impl Executor) -> Result<(), String> {
    if let Some(head) = executor.read("head")? {
        head.validate(&head.id)?;
        if !head.completed {
            return Err(format!("An earlier Boot operation has an uncertain result. Native journal {} is retained; review it before further Boot changes",head.id));
        }
    }
    Ok(())
}
fn resolve(
    request: &Request,
    before: &Core,
    caller: &str,
    executor: &mut impl Executor,
) -> Result<Core, String> {
    if let Request::Undo { journal_id } = request {
        request.validate()?;
        let journal = executor
            .read(journal_id)?
            .ok_or("Native Boot undo record is missing")?;
        journal.validate(journal_id)?;
        if journal.caller_sid != caller
            || !journal.completed
            || journal.undone
            || matches!(journal.request, Request::Undo { .. })
            || journal.after != *before
        {
            return Err(
                "Boot undo is no longer owned, available or unchanged; no settings changed".into(),
            );
        }
        Ok(journal.before)
    } else {
        request.target(before)
    }
}
fn perform(
    envelope: &Envelope,
    executor: &mut impl Executor,
    before_commit: impl FnOnce() -> Result<(), String>,
) -> Result<ResultView, String> {
    deadline(envelope)?;
    available(executor)?;
    if executor.read(&envelope.plan_id)?.is_some() {
        return Err("Boot plan has already been used".into());
    }
    if resolve(
        &envelope.request,
        &envelope.before,
        &envelope.caller_sid,
        executor,
    )? != envelope.after
    {
        return Err("Boot plan target binding changed".into());
    }
    if executor.inventory()?.core != envelope.before {
        return Err("Boot settings or current loader changed; refresh and review again".into());
    }
    executor.confirm(envelope)?;
    deadline(envelope)?;
    if executor.inventory()?.core != envelope.before {
        return Err("Boot settings changed after consent; nothing changed".into());
    }
    before_commit()?;
    deadline(envelope)?;
    if executor.inventory()?.core != envelope.before {
        return Err("Boot settings changed before commit; nothing changed".into());
    }
    let mut journal = Journal {
        version: 1,
        id: envelope.plan_id.clone(),
        caller_sid: envelope.caller_sid.clone(),
        request: envelope.request.clone(),
        before: envelope.before.clone(),
        after: envelope.after.clone(),
        completed: false,
        undone: false,
    };
    executor.save(&journal.id, &journal)?;
    executor.save("head", &journal)?;
    let outcome: Result<ResultView, String> = (|| {
        executor.apply(&envelope.before, &envelope.after)?;
        if executor.inventory()?.core != envelope.after {
            return Err("Boot readback did not match the exact target".into());
        }
        if let Request::Undo { journal_id } = &envelope.request {
            let mut original = executor
                .read(journal_id)?
                .ok_or("Boot undo source disappeared")?;
            original.validate(journal_id)?;
            if original.caller_sid != envelope.caller_sid
                || original.undone
                || !original.completed
                || original.before != envelope.after
                || original.after != envelope.before
            {
                return Err("Boot undo source changed".into());
            }
            original.undone = true;
            executor.save(journal_id, &original)?;
        }
        journal.completed = true;
        executor.save(&journal.id, &journal)?;
        executor.save("head", &journal)?;
        Ok(ResultView {
            ok: true,
            journal_id: journal.id.clone(),
        })
    })();
    outcome.map_err(|error|format!("Boot operation failed or is uncertain; native journal {} is retained and further changes are blocked until reviewed: {error}",journal.id))
}

pub fn state() -> Result<State, String> {
    let inventory = list()?;
    inventory.validate()?;
    let safeboot = if inventory.core.alternate_shell == Some(true) {
        "other"
    } else {
        match inventory.core.safe_boot {
            None => "none",
            Some(0) => "minimal",
            Some(1) => "network",
            _ => "other",
        }
    };
    Ok(State {
        timeout: inventory.core.timeout.filter(|n| *n <= 999),
        safeboot,
        entries: inventory.entries,
    })
}
pub fn prepare(request: Request) -> Result<PlanView, String> {
    request.validate()?;
    let before = list()?.core;
    let caller_sid = broker::current_sid()?;
    let mut executor = NativeExecutor;
    available(&mut executor)?;
    let after = resolve(&request, &before, &caller_sid, &mut executor)?;
    let id = broker::reserve_plan()?;
    let view = PlanView {
        id: id.clone(),
        summary: summary(&request),
        requires_elevation: !broker::is_elevated()?,
    };
    let envelope = Envelope {
        request,
        before,
        after,
        plan_id: id.clone(),
        caller_sid,
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
fn execute_native(
    envelope: &Envelope,
    before_commit: impl FnOnce() -> Result<(), String>,
) -> Result<ResultView, String> {
    if !broker::is_elevated()? {
        return Err("Boot changes require the native administrator helper".into());
    }
    let _lease = broker::domain_lease(&envelope.caller_sid)?;
    perform(envelope, &mut NativeExecutor, || {
        broker::require_live_parent(envelope.parent_pid)?;
        before_commit()?;
        broker::require_live_parent(envelope.parent_pid)
    })
}
pub fn execute(id: &str) -> Result<ResultView, String> {
    broker::consume_plan(id)?;
    let pending = plans()
        .lock()
        .map_err(|e| e.to_string())?
        .remove(id)
        .ok_or("Boot plan is missing or already used")?;
    if pending.prepared.elapsed() >= Duration::from_millis(TTL_MS)
        || broker::current_sid()? != pending.envelope.caller_sid
    {
        return Err("Boot plan expired or caller changed".into());
    }
    if broker::is_elevated()? {
        return execute_native(&pending.envelope, || Ok(()));
    }
    let expected = pending.envelope.plan_id.clone();
    match transport(HelperRequest::Change {
        envelope: Box::new(pending.envelope),
    })? {
        Message::Result {
            result: Some(result),
            error: None,
        } if result.ok && result.journal_id == expected => Ok(result),
        Message::Result { error, .. } => {
            Err(error.unwrap_or("Boot helper returned no result".into()))
        }
        _ => Err("Unexpected Boot helper phase".into()),
    }
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "phase", rename_all = "camelCase", deny_unknown_fields)]
enum Message {
    Ready,
    Inventory {
        inventory: Option<Inventory>,
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
    Change {
        envelope: Box<Envelope>,
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
        return Err("Boot helper reply binding mismatch".into());
    }
    Ok(reply.message)
}
fn transport(request: HelperRequest) -> Result<Message, String> {
    let hash = digest(&request)?;
    let changing = matches!(request, HelperRequest::Change { .. });
    let pipe_name = format!(
        "{PIPE_PREFIX}{}-{}",
        std::process::id(),
        broker::random_id()?
    );
    let pipe = broker::server_pipe(&pipe_name)?;
    let helper = broker::launch_domain_helper(broker::HelperKind::Boot, &pipe_name)?;
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
        Message::Ready if changing => {
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
        Message::Ready => Err("Read-only Boot request attempted mutation handshake".into()),
        response => Ok(response),
    }
}
fn list() -> Result<Inventory, String> {
    inventory_with_fallback(local_inventory, || {
        if broker::is_elevated()? {
            return Err("Windows denied native BCD access".into());
        }
        match transport(HelperRequest::Inventory {
            caller_sid: broker::current_sid()?,
            parent_pid: std::process::id(),
            deadline_utc_ms: now_ms()?.saturating_add(TTL_MS),
        })? {
            Message::Inventory {
                inventory: Some(value),
                error: None,
            } => {
                value.validate()?;
                Ok(value)
            }
            Message::Inventory { error, .. } => {
                Err(error.unwrap_or("Boot helper returned no inventory".into()))
            }
            _ => Err("Unexpected Boot inventory helper phase".into()),
        }
    })
}
fn inventory_with_fallback(
    local: impl FnOnce() -> Result<Inventory, String>,
    elevated: impl FnOnce() -> Result<Inventory, String>,
) -> Result<Inventory, String> {
    let value = match local() {
        Ok(value) => value,
        Err(error) if error.starts_with("BOOT_ACCESS_DENIED:") => elevated()?,
        Err(error) => return Err(error),
    };
    value.validate()?;
    Ok(value)
}
pub(crate) fn helper(pipe_name: &str) -> Result<(), String> {
    if !broker::is_elevated()? {
        return Err("Boot helper is not elevated".into());
    }
    let (pid, nonce) = pipe_name
        .strip_prefix(PIPE_PREFIX)
        .ok_or("Invalid Boot pipe")?
        .split_once('-')
        .ok_or("Invalid Boot pipe")?;
    let pid = pid.parse::<u32>().map_err(|e| e.to_string())?;
    if !valid_id(nonce) {
        return Err("Invalid Boot nonce".into());
    }
    let pipe = broker::client_pipe(pipe_name, pid)?;
    let dispatch: Dispatch = broker::receive(pipe.0)?;
    if digest(&dispatch.request)? != dispatch.digest {
        return Err("Boot request binding mismatch".into());
    }
    let (parent, sid, deadline_ms) = match &dispatch.request {
        HelperRequest::Inventory {
            caller_sid,
            parent_pid,
            deadline_utc_ms,
        } => (*parent_pid, caller_sid, *deadline_utc_ms),
        HelperRequest::Change { envelope } => (
            envelope.parent_pid,
            &envelope.caller_sid,
            envelope.deadline_utc_ms,
        ),
    };
    let now = now_ms()?;
    if parent != pid
        || *sid != broker::process_sid(pid)?
        || deadline_ms < now
        || deadline_ms > now.saturating_add(TTL_MS)
    {
        return Err("Boot caller authentication or deadline mismatch".into());
    }
    broker::require_live_parent(pid)?;
    let response = match dispatch.request {
        HelperRequest::Inventory { .. } => match local_inventory() {
            Ok(inventory) => Message::Inventory {
                inventory: Some(inventory),
                error: None,
            },
            Err(error) => Message::Inventory {
                inventory: None,
                error: Some(error),
            },
        },
        HelperRequest::Change { envelope } => {
            let result = execute_native(&envelope, || {
                reply(pipe.0, &dispatch.digest, Message::Ready)?;
                let commit: Commit = broker::receive(pipe.0)?;
                if !commit.approved || commit.digest != dispatch.digest {
                    return Err("Parent refused Boot commit or binding changed".into());
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

fn local_inventory() -> Result<Inventory, String> {
    run_bcd(None)
}
fn run_bcd(change: Option<(&Core, &Core)>) -> Result<Inventory, String> {
    let payload = match change {
        Some((before, after)) => serde_json::json!({"before":before,"after":after}),
        None => serde_json::json!(null),
    };
    let encoded: Vec<u8> = BCD_SCRIPT
        .encode_utf16()
        .flat_map(u16::to_le_bytes)
        .collect();
    let mut command = Command::new(crate::windows_tools::system_file("powershell.exe")?);
    command
        .env_remove("PSModulePath")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-OutputFormat",
            "Text",
            "-EncodedCommand",
            &STANDARD.encode(encoded),
        ])
        .creation_flags(0x0800_0000);
    let output = crate::process_io::execute(
        &mut command,
        Some(payload.to_string()),
        Duration::from_secs(20),
    )?;
    if output.stdout.len() > 512 * 1024 || output.stderr.len() > 64 * 1024 {
        return Err("BCD provider output exceeds supported bounds".into());
    }
    if !output.status.success() {
        return Err(if output.status.code() == Some(5) {
            "BOOT_ACCESS_DENIED: Windows denied native BCD access".into()
        } else {
            format!(
                "Windows BCD provider failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            )
        });
    }
    let value: Inventory = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("Invalid structured BCD provider response: {e}"))?;
    value.validate()?;
    Ok(value)
}

// All provider class names, scope, keys, methods and element numbers are native
// constants. Embedded WMI outputs are rebound using validated default-store keys,
// never a returned __PATH (which could introduce another host/namespace/store).
const BCD_SCRIPT: &str = r#"
$ErrorActionPreference='Stop'
$PSModuleAutoloadingPreference='None'
[Console]::OutputEncoding=[Text.Encoding]::UTF8
Import-Module -Name ($PSHOME+'\Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop
try {
  $scope=[System.Management.ManagementScope]::new('\\.\root\WMI')
  $scope.Options.Impersonation=[System.Management.ImpersonationLevel]::Impersonate
  $scope.Options.EnablePrivileges=$true
  $scope.Connect()
  function Invoke-Bcd($object,[string]$method,[hashtable]$arguments) {
    $parameters=$object.GetMethodParameters($method)
    foreach($key in $arguments.Keys){$parameters[$key]=$arguments[$key]}
    $result=$object.InvokeMethod($method,$parameters,$null)
    if($null -eq $result -or $result['ReturnValue'] -isnot [bool] -or -not $result['ReturnValue']){throw "BCD provider $method failed"}
    return $result
  }
  function Bind-Bcd([string]$path) {
    $bound=[System.Management.ManagementObject]::new($scope,[System.Management.ManagementPath]::new($path),$null)
    $bound.Get()
    return $bound
  }
  function Guid-Text($value) {
    $text=[string]$value
    if($text -notmatch '^\{[a-fA-F0-9]{8}(-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}\}$'){throw 'Invalid BCD object identifier'}
    return $text.ToLowerInvariant()
  }
  $class=[System.Management.ManagementClass]::new($scope,[System.Management.ManagementPath]::new('BcdStore'),$null)
  $class.Get()
  $opened=Invoke-Bcd $class 'OpenStore' @{File=''}
  if($null -eq $opened['Store'] -or $null -eq $opened['Store'].Properties['FilePath'] -or [string]$opened['Store']['FilePath'] -cne ''){throw 'BCD default store did not resolve'}
  $store=Bind-Bcd 'BcdStore.FilePath=""'
  function Open-Bcd([string]$id,[uint32]$type) {
    $out=Invoke-Bcd $store 'OpenObject' @{Id=$id}
    $embedded=$out['Object']
    if($null -eq $embedded -or $null -eq $embedded.Properties['StoreFilePath'] -or [string]$embedded['StoreFilePath'] -cne '' -or $null -eq $embedded.Properties['Type'] -or [uint32]$embedded['Type'] -ne $type){throw 'BCD object type or store changed'}
    $actual=Guid-Text $embedded['Id']
    if($actual -eq '{fa926493-6f1c-4193-a414-58f0b2456d1e}'){throw 'BCD current loader alias was not resolved'}
    $bound=Bind-Bcd ('BcdObject.Id="'+$actual+'",StoreFilePath=""')
    if((Guid-Text $bound['Id']) -cne $actual -or [uint32]$bound['Type'] -ne $type -or [string]$bound['StoreFilePath'] -cne ''){throw 'BCD rebound identity changed'}
    [pscustomobject]@{Id=$actual;Type=$type;Object=$bound}
  }
  function Elements($object) {
    $result=Invoke-Bcd $object 'EnumerateElements' @{}
    $map=@{}
    foreach($element in @($result['Elements'])) {
      if($null -eq $element -or $null -eq $element.Properties['Type']){throw 'BCD returned an invalid element'}
      $type=[uint32]$element['Type']
      if($map.ContainsKey($type)){throw 'BCD returned duplicate elements'}
      $map[$type]=$element
    }
    return $map
  }
  function Integer($elements,[uint32]$type) {
    if(-not $elements.ContainsKey($type)){return $null}
    $element=$elements[$type]
    if($null -eq $element.Properties['Integer']){throw 'BCD element is not an integer'}
    $text=[string]$element['Integer'];$number=[uint64]0
    if(-not [uint64]::TryParse($text,[Globalization.NumberStyles]::None,[Globalization.CultureInfo]::InvariantCulture,[ref]$number)){throw 'BCD integer is invalid'}
    return $number
  }
  function Boolean($elements,[uint32]$type) {
    if(-not $elements.ContainsKey($type)){return $null}
    if($elements[$type]['Boolean'] -isnot [bool]){throw 'BCD alternate-shell element is not boolean'}
    return $elements[$type]['Boolean']
  }
  function Read-Core {
    $script:loader=Open-Bcd '{fa926493-6f1c-4193-a414-58f0b2456d1e}' 0x10200003
    $script:manager=Open-Bcd '{9dea862c-5cdd-4e70-acc1-f32b344d4795}' 0x10100002
    if($script:manager.Id -cne '{9dea862c-5cdd-4e70-acc1-f32b344d4795}'){throw 'BCD boot-manager identity changed'}
    $script:loaderElements=Elements $script:loader.Object
    $script:managerElements=Elements $script:manager.Object
    [pscustomobject][ordered]@{loaderId=$script:loader.Id;loaderType=$script:loader.Type;managerId=$script:manager.Id;managerType=$script:manager.Type;safeBoot=(Integer $script:loaderElements 0x25000080);alternateShell=(Boolean $script:loaderElements 0x26000081);timeout=(Integer $script:managerElements 0x25000004)}
  }
  function Same-Core($actual,$expected) {
    foreach($key in @('loaderId','loaderType','managerId','managerType','safeBoot','alternateShell','timeout')) {
      if(($null -eq $actual.$key) -ne ($null -eq $expected.$key)){return $false}
      if($null -ne $actual.$key -and [string]$actual.$key -cne [string]$expected.$key){return $false}
    }
    return $true
  }
  $inputText=[Console]::In.ReadToEnd()
  $request=Microsoft.PowerShell.Utility\ConvertFrom-Json -InputObject $inputText -ErrorAction Stop
  $core=Read-Core
  if($null -ne $request) {
    if(-not (Same-Core $core $request.before)){throw 'BCD state changed before native write'}
    $target=$request.after
    foreach($key in @('loaderId','loaderType','managerId','managerType','alternateShell')){if([string]$core.$key -cne [string]$target.$key -or ($null -eq $core.$key) -ne ($null -eq $target.$key)){throw 'BCD mutation attempted to change unsupported identity or element'}}
    $safeChanged=([string]$core.safeBoot -cne [string]$target.safeBoot) -or (($null -eq $core.safeBoot) -ne ($null -eq $target.safeBoot))
    $timeoutChanged=([string]$core.timeout -cne [string]$target.timeout) -or (($null -eq $core.timeout) -ne ($null -eq $target.timeout))
    if($safeChanged -and $timeoutChanged){throw 'BCD operation must change one element only'}
    if($safeChanged){
      if($core.alternateShell -eq $true -or ($null -ne $core.safeBoot -and [uint64]$core.safeBoot -gt 1) -or ($null -ne $target.safeBoot -and [uint64]$target.safeBoot -gt 1)){throw 'Unsupported SafeBoot state'}
      $object=$script:loader.Object;$type=[uint32]0x25000080;$value=$target.safeBoot
    } elseif($timeoutChanged){$object=$script:manager.Object;$type=[uint32]0x25000004;$value=$target.timeout}
    if($safeChanged -or $timeoutChanged){
      if($null -eq $value){$null=Invoke-Bcd $object 'DeleteElement' @{Type=$type}}
      else{$null=Invoke-Bcd $object 'SetIntegerElement' @{Type=$type;Integer=[uint64]$value}}
      $actual=Read-Core
      if(-not (Same-Core $actual $target)){throw 'BCD mutation readback failed'}
      $core=$actual
    }
  }
  $objects=Invoke-Bcd $store 'EnumerateObjects' @{Type=[uint32]0x10200003}
  $entries=@();$default=$null
  if($script:managerElements.ContainsKey([uint32]0x23000003)){$default=Guid-Text $script:managerElements[[uint32]0x23000003]['Id']}
  foreach($embedded in @($objects['Objects'])){
    if($entries.Count -ge 128){throw 'Too many BCD loaders'}
    $id=Guid-Text $embedded['Id']
    $entry=Open-Bcd $id 0x10200003
    $elements=Elements $entry.Object
    $name='Windows'
    if($elements.ContainsKey([uint32]0x12000004)){
      if($elements[[uint32]0x12000004]['String'] -isnot [string]){throw 'Invalid BCD description'}
      $name=$elements[[uint32]0x12000004]['String']
    }
    if($name.Length -gt 512 -or $name.Contains([string][char]0)){throw 'BCD description exceeds supported bounds'}
    $entries += [pscustomobject]@{id=$id;name=$name;isCurrent=($id -ceq $core.loaderId);isDefault=($id -ceq $default)}
  }
  Microsoft.PowerShell.Utility\ConvertTo-Json -InputObject ([pscustomobject]@{core=$core;entries=@($entries)}) -Depth 6 -Compress
} catch {
  if($_.Exception.HResult -eq -2147024891 -or $_.Exception.HResult -eq -2147217405 -or $_.Exception.InnerException.HResult -eq -2147024891 -or $_.Exception.InnerException.HResult -eq -2147217405){[Console]::Error.WriteLine('Windows denied native BCD access');exit 5}
  [Console]::Error.WriteLine($_.Exception.Message);exit 1
}
"#;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_native_access_denial_uses_read_only_helper_and_cancellation_does_not_mutate() {
        assert!(inventory_with_fallback(
            || Err("BOOT_ACCESS_DENIED: native denial".into()),
            || Ok(inventory(core()))
        )
        .is_ok());
        assert_eq!(
            inventory_with_fallback(
                || Err("provider failed".into()),
                || panic!("must not elevate")
            )
            .unwrap_err(),
            "provider failed"
        );
        assert_eq!(
            inventory_with_fallback(
                || Err("BOOT_ACCESS_DENIED: native denial".into()),
                || Err("USER_CANCELLED".into())
            )
            .unwrap_err(),
            "USER_CANCELLED"
        );
        let mut malformed = inventory(core());
        malformed.entries.clear();
        assert!(inventory_with_fallback(|| Ok(malformed), || panic!("must not elevate")).is_err());
    }
    fn core() -> Core {
        Core {
            loader_id: "{11111111-2222-3333-4444-555555555555}".into(),
            loader_type: 0x1020_0003,
            manager_id: MANAGER.into(),
            manager_type: 0x1010_0002,
            safe_boot: None,
            alternate_shell: None,
            timeout: Some(30),
        }
    }
    fn inventory(core: Core) -> Inventory {
        Inventory {
            entries: vec![Entry {
                id: core.loader_id.clone(),
                name: "Fixture Windows".into(),
                is_current: true,
                is_default: true,
            }],
            core,
        }
    }
    fn envelope(request: Request, before: Core) -> Envelope {
        let after = request.target(&before).unwrap();
        Envelope {
            request,
            before,
            after,
            plan_id: "a".repeat(32),
            caller_sid: "S-1-5-21-1".into(),
            parent_pid: 1,
            deadline_utc_ms: now_ms().unwrap() + TTL_MS,
        }
    }
    struct Fake {
        core: Core,
        journals: HashMap<String, Journal>,
        trace: Vec<String>,
        fail: &'static str,
        reads: usize,
        change_at: usize,
        writes: usize,
    }
    impl Fake {
        fn new(core: Core) -> Self {
            Self {
                core,
                journals: HashMap::new(),
                trace: vec![],
                fail: "",
                reads: 0,
                change_at: usize::MAX,
                writes: 0,
            }
        }
    }
    impl Executor for Fake {
        fn inventory(&mut self) -> Result<Inventory, String> {
            self.trace.push("read".into());
            self.reads += 1;
            if self.reads == self.change_at {
                self.core.loader_id = "{66666666-2222-3333-4444-555555555555}".into();
            }
            if self.writes > 0 && self.fail == "readback" {
                return Err("provider failed".into());
            }
            Ok(inventory(self.core.clone()))
        }
        fn confirm(&mut self, _: &Envelope) -> Result<(), String> {
            self.trace.push("consent".into());
            if self.fail == "cancel" {
                Err("USER_CANCELLED".into())
            } else {
                Ok(())
            }
        }
        fn read(&mut self, id: &str) -> Result<Option<Journal>, String> {
            Ok(self.journals.get(id).cloned())
        }
        fn save(&mut self, id: &str, journal: &Journal) -> Result<(), String> {
            self.trace.push(format!("save:{id}:{}", journal.completed));
            if (self.fail == "intent" && !journal.completed)
                || (self.fail == "head-intent" && id == "head" && !journal.completed)
                || (self.fail == "complete" && journal.completed)
                || (self.fail == "head-complete" && id == "head" && journal.completed)
            {
                return Err("journal write failed".into());
            }
            self.journals.insert(id.into(), journal.clone());
            Ok(())
        }
        fn apply(&mut self, before: &Core, after: &Core) -> Result<(), String> {
            assert_eq!(self.core, *before);
            self.writes += 1;
            self.trace.push("write".into());
            self.core = after.clone();
            if self.fail == "after-write" {
                return Err("provider failed after write".into());
            }
            if self.fail == "mismatch" {
                self.core.safe_boot = Some(2);
            }
            Ok(())
        }
    }
    #[test]
    fn requests_are_closed_and_bounded_and_unresolved_provider_values_fail_closed() {
        for key in ["safeBoot", "alternateShell", "timeout"] {
            let mut value = serde_json::to_value(core()).unwrap();
            value.as_object_mut().unwrap().remove(key);
            assert!(serde_json::from_value::<Core>(value).is_err());
        }
        for value in [
            serde_json::json!({"kind":"safeBoot","mode":"minimal","previous":"none"}),
            serde_json::json!({"kind":"safeBoot","mode":"dsrepair"}),
            serde_json::json!({"kind":"timeout","seconds":-1}),
            serde_json::json!({"kind":"undo","journalId":"../caller","script":"x"}),
        ] {
            assert!(serde_json::from_value::<Request>(value).is_err());
        }
        assert!(Request::Timeout { seconds: 1000 }.validate().is_err());
        assert!(Request::Undo {
            journal_id: "x".into()
        }
        .validate()
        .is_err());
        for bad in [CURRENT, "{current}", "arbitrary-path"] {
            let mut v = core();
            v.loader_id = bad.into();
            assert!(v.validate().is_err());
        }
        let mut value = serde_json::to_value(core()).unwrap();
        value["alternateShell"] = serde_json::json!("unknown");
        assert!(serde_json::from_value::<Core>(value).is_err());
        let mut value = serde_json::to_value(core()).unwrap();
        value["safeBoot"] = serde_json::json!("unreadable");
        assert!(serde_json::from_value::<Core>(value).is_err());
        let mut value = core();
        value.loader_type = 1;
        assert!(value.validate().is_err());
        let mut value = inventory(core());
        value.entries.clear();
        assert!(value.validate().is_err());
        let mut value = inventory(core());
        value.entries.push(value.entries[0].clone());
        assert!(value.validate().is_err());
    }
    #[test]
    fn persistent_safeboot_only_handles_known_modes_and_never_clears_alternate_shell() {
        for request in [
            Request::SafeBoot { mode: Mode::None },
            Request::SafeBoot {
                mode: Mode::Minimal,
            },
            Request::SafeBoot {
                mode: Mode::Network,
            },
        ] {
            let mut before = core();
            before.safe_boot = Some(2);
            assert!(request.target(&before).is_err());
            before.safe_boot = None;
            before.alternate_shell = Some(true);
            assert!(request.target(&before).is_err());
            before.alternate_shell = Some(false);
            assert_eq!(
                request.target(&before).unwrap().alternate_shell,
                Some(false)
            );
        }
    }
    #[test]
    fn intent_precedes_write_and_verified_completion_precedes_success() {
        let plan = envelope(
            Request::SafeBoot {
                mode: Mode::Network,
            },
            core(),
        );
        let mut fake = Fake::new(plan.before.clone());
        assert!(perform(&plan, &mut fake, || Ok(())).unwrap().ok);
        let relevant: Vec<_> = fake
            .trace
            .iter()
            .filter(|s| s.starts_with("save:") || *s == "write")
            .cloned()
            .collect();
        assert_eq!(
            relevant,
            vec![
                format!("save:{}:false", plan.plan_id),
                "save:head:false".into(),
                "write".into(),
                format!("save:{}:true", plan.plan_id),
                "save:head:true".into()
            ]
        );
        assert_eq!(fake.core, plan.after);
        assert!(fake.journals["head"].completed);
        assert!(perform(&plan, &mut fake, || Ok(())).is_err());
        assert_eq!(fake.writes, 1);
    }
    #[test]
    fn stale_identity_consent_cancellation_commit_rejection_and_expiry_never_write() {
        let plan = envelope(Request::Timeout { seconds: 5 }, core());
        for read in [1, 2, 3] {
            let mut fake = Fake::new(plan.before.clone());
            fake.change_at = read;
            assert!(perform(&plan, &mut fake, || Ok(())).is_err());
            assert_eq!(fake.writes, 0);
            assert!(fake.journals.is_empty());
        }
        let mut fake = Fake::new(plan.before.clone());
        fake.fail = "cancel";
        assert!(perform(&plan, &mut fake, || Ok(())).is_err());
        assert_eq!(fake.writes, 0);
        let mut fake = Fake::new(plan.before.clone());
        assert!(perform(&plan, &mut fake, || Err(
            "parent died or refused commit".into()
        ))
        .is_err());
        assert_eq!(fake.writes, 0);
        let mut expired = plan.clone();
        expired.deadline_utc_ms = 0;
        assert!(perform(&expired, &mut fake, || Ok(())).is_err());
        assert_eq!(fake.writes, 0);
        let mut rebound = plan;
        rebound.after.loader_id = "{77777777-2222-3333-4444-555555555555}".into();
        assert!(perform(&rebound, &mut fake, || Ok(())).is_err());
        assert_eq!(fake.writes, 0);
    }
    #[test]
    fn failed_intent_never_writes_and_uncertain_outcomes_block_every_caller() {
        for failure in ["intent", "head-intent"] {
            let plan = envelope(Request::Timeout { seconds: 5 }, core());
            let mut fake = Fake::new(plan.before.clone());
            fake.fail = failure;
            assert!(perform(&plan, &mut fake, || Ok(())).is_err());
            assert_eq!(fake.writes, 0);
        }
        for failure in [
            "after-write",
            "readback",
            "mismatch",
            "complete",
            "head-complete",
        ] {
            let plan = envelope(
                Request::SafeBoot {
                    mode: Mode::Minimal,
                },
                core(),
            );
            let mut fake = Fake::new(plan.before.clone());
            fake.fail = failure;
            let error = perform(&plan, &mut fake, || Ok(())).unwrap_err();
            assert!(error.contains("uncertain"));
            assert_eq!(fake.writes, 1);
            assert!(!fake.journals["head"].completed);
            let mut next = envelope(Request::Timeout { seconds: 1 }, fake.core.clone());
            next.plan_id = "b".repeat(32);
            next.caller_sid = "S-1-5-21-999".into();
            fake.fail = "";
            assert!(perform(&next, &mut fake, || Ok(()))
                .unwrap_err()
                .contains("earlier Boot"));
            assert_eq!(fake.writes, 1);
        }
    }
    #[test]
    fn protected_undo_restores_exact_presence_and_values_and_refuses_replay() {
        for request in [
            Request::SafeBoot {
                mode: Mode::Minimal,
            },
            Request::Timeout { seconds: 0 },
        ] {
            for absent in [true, false] {
                let mut before = core();
                if absent {
                    before.timeout = None;
                } else {
                    before.safe_boot = Some(1);
                }
                let plan = envelope(request.clone(), before.clone());
                let mut fake = Fake::new(before.clone());
                perform(&plan, &mut fake, || Ok(())).unwrap();
                let undo = Envelope {
                    request: Request::Undo {
                        journal_id: plan.plan_id.clone(),
                    },
                    before: plan.after.clone(),
                    after: before.clone(),
                    plan_id: "b".repeat(32),
                    ..plan.clone()
                };
                perform(&undo, &mut fake, || Ok(())).unwrap();
                assert_eq!(fake.core, before);
                assert!(fake.journals[&plan.plan_id].undone);
                let mut replay = undo;
                replay.plan_id = "c".repeat(32);
                assert!(perform(&replay, &mut fake, || Ok(())).is_err());
                assert_eq!(fake.writes, 2);
            }
        }
    }
    #[test]
    fn undo_rejects_wrong_owner_tampered_record_stale_poststate_and_undo_of_undo() {
        let plan = envelope(Request::Timeout { seconds: 10 }, core());
        for fault in ["owner", "tamper", "stale", "undo"] {
            let mut fake = Fake::new(plan.before.clone());
            perform(&plan, &mut fake, || Ok(())).unwrap();
            let mut caller = plan.caller_sid.clone();
            let mut before = plan.after.clone();
            match fault {
                "owner" => caller = "S-1-5-21-88".into(),
                "tamper" => fake.journals.get_mut(&plan.plan_id).unwrap().version = 99,
                "stale" => before.timeout = Some(25),
                "undo" => {
                    fake.journals.get_mut(&plan.plan_id).unwrap().request = Request::Undo {
                        journal_id: "d".repeat(32),
                    }
                }
                _ => unreachable!(),
            }
            assert!(resolve(
                &Request::Undo {
                    journal_id: plan.plan_id.clone()
                },
                &before,
                &caller,
                &mut fake
            )
            .is_err());
            assert_eq!(fake.writes, 1);
        }
    }
    #[test]
    fn helper_binding_and_native_budget_reject_replay_without_launching_a_helper() {
        let request = HelperRequest::Change {
            envelope: Box::new(envelope(Request::Timeout { seconds: 1 }, core())),
        };
        let hash = digest(&request).unwrap();
        let mut changed = serde_json::to_value(&request).unwrap();
        changed["envelope"]["parentPid"] = serde_json::json!(42);
        assert_ne!(
            hash,
            digest(&serde_json::from_value(changed).unwrap()).unwrap()
        );
        let mut hostile = serde_json::to_value(&request).unwrap();
        hostile["script"] = serde_json::json!("x");
        assert!(serde_json::from_value::<HelperRequest>(hostile).is_err());
        let plan = broker::reserve_plan().unwrap();
        broker::consume_plan(&plan).unwrap();
        assert!(broker::consume_plan(&plan).is_err());
    }
}
