//! Scheduled-task authority stays native: opaque grants, exact reviewed
//! definitions/ACLs, immutable one-use plans and protected recovery journals.
use crate::{
    broker,
    state_store::{self, Authority, Domain},
    task_platform as platform,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri_plugin_dialog::DialogExt;
const TTL_MS: u64 = 120_000;
const STORE_SID: &str = "S-1-5-32-545";
const PIPE_PREFIX: &str = "\\\\.\\pipe\\Purgeon-Tasks-";
fn id(value: &str) -> bool {
    value.len() == 32 && value.bytes().all(|c| c.is_ascii_hexdigit())
}
fn now() -> Result<u64, String> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis() as u64)
}
fn required_option<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Request {
    SetEnabled {
        task_id: String,
        enabled: bool,
    },
    Run {
        task_id: String,
    },
    Stop {
        task_id: String,
    },
    Remove {
        task_id: String,
    },
    Create {
        program_grant: String,
        name: String,
        trigger: platform::Trigger,
    },
    ConfigureOwned {
        role: platform::OwnedRole,
        enabled: bool,
        day: String,
        time: String,
        check_startup: bool,
    },
    Recover {
        journal_id: String,
    },
    RecoverDeleted {
        journal_id: String,
    },
}
impl Request {
    fn validate(&self) -> Result<(), String> {
        match self {
            Self::SetEnabled { task_id, .. }
            | Self::Run { task_id }
            | Self::Stop { task_id }
            | Self::Remove { task_id } => {
                if !id(task_id) {
                    return Err("Refresh Scheduled Tasks and select its native identity".into());
                }
            }
            Self::Create {
                program_grant,
                name,
                ..
            } => {
                if !id(program_grant)
                    || name.is_empty()
                    || name.len() > 128
                    || name != name.trim()
                    || !name
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"- _.".contains(&b))
                    || name == "."
                    || name == ".."
                    || name.ends_with('.')
                {
                    return Err("Choose a native EXE and a simple task name".into());
                }
            }
            Self::ConfigureOwned { day, time, .. } => {
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
                    return Err("Choose a valid day and local time HH:MM".into());
                }
            }
            Self::Recover { journal_id } | Self::RecoverDeleted { journal_id } => {
                if !id(journal_id) {
                    return Err("Select a valid native scheduled-task journal".into());
                }
            }
        }
        Ok(())
    }
    fn recovery_id(&self) -> Option<&str> {
        match self {
            Self::Recover { journal_id } | Self::RecoverDeleted { journal_id } => Some(journal_id),
            _ => None,
        }
    }
}
fn valid_time(value: &str) -> bool {
    value.len() == 5
        && value.as_bytes()[2] == b':'
        && value[..2].parse::<u8>().is_ok_and(|n| n < 24)
        && value[3..].parse::<u8>().is_ok_and(|n| n < 60)
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Resolved {
    #[serde(deserialize_with = "required_option")]
    before: Option<platform::Snapshot>,
    #[serde(deserialize_with = "required_option")]
    action: Option<platform::PlatformAction>,
    settled: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Envelope {
    request: Request,
    resolved: Resolved,
    plan_id: String,
    caller_sid: String,
    parent_pid: u32,
    deadline_utc_ms: u64,
}
struct TaskGrant {
    path: String,
    fingerprint: String,
    sid: String,
    created: Instant,
}
struct ProgramGrant {
    program: platform::Program,
    sid: String,
    created: Instant,
}
struct Pending {
    envelope: Envelope,
    created: Instant,
}
#[derive(Default)]
struct Manager {
    tasks: HashMap<String, TaskGrant>,
    programs: HashMap<String, ProgramGrant>,
    plans: HashMap<String, Pending>,
}
static STATE: OnceLock<Mutex<Manager>> = OnceLock::new();
fn manager() -> &'static Mutex<Manager> {
    STATE.get_or_init(|| Mutex::new(Manager::default()))
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskView {
    pub name: String,
    pub path: String,
    pub state: String,
    pub author: String,
    pub last_run: String,
    pub next_run: String,
    pub last_result: Option<i64>,
    pub is_windows: bool,
    pub task_id: Option<String>,
    pub enabled: Option<bool>,
    pub command: String,
    pub arguments: String,
    pub working_directory: String,
    pub instance_guids: Vec<String>,
    pub unsupported_reason: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    rows: Vec<TaskView>,
    next_cursor: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgramView {
    id: String,
    display_path: String,
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
    settled: bool,
    changed: bool,
    #[serde(deserialize_with = "required_option")]
    task: Option<platform::Snapshot>,
    #[serde(deserialize_with = "required_option")]
    instance_guid: Option<String>,
    recoverable: bool,
    detail: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Journal {
    version: u8,
    id: String,
    caller_sid: String,
    request: Request,
    resolved: Resolved,
    #[serde(deserialize_with = "required_option")]
    after: Option<AfterProof>,
    #[serde(deserialize_with = "required_option")]
    instance_guid: Option<String>,
    completed: bool,
    recovered: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AfterProof {
    path: String,
    fingerprint: String,
    enabled: bool,
    instances: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SharedHead {
    version: u8,
    id: String,
    completed: bool,
}
impl SharedHead {
    fn from_journal(journal: &Journal) -> Self {
        Self {
            version: 1,
            id: journal.id.clone(),
            completed: journal.completed,
        }
    }
    fn validate(&self) -> Result<(), String> {
        if self.version != 1 || !id(&self.id) {
            return Err("Invalid shared task gate; evidence retained".into());
        }
        Ok(())
    }
}
impl AfterProof {
    fn capture(snapshot: &platform::Snapshot) -> Result<Self, String> {
        Ok(Self {
            path: snapshot.path.clone(),
            fingerprint: snapshot.fingerprint()?,
            enabled: snapshot.enabled,
            instances: snapshot.instance_guids.clone(),
        })
    }
    fn matches(&self, snapshot: &platform::Snapshot) -> Result<bool, String> {
        Ok(self.path == snapshot.path
            && self.fingerprint == snapshot.fingerprint()?
            && self.enabled == snapshot.enabled
            && self.instances == snapshot.instance_guids)
    }
}
impl Journal {
    fn validate(&self, key: &str) -> Result<(), String> {
        self.request.validate()?;
        validate_resolved(&self.resolved, &self.caller_sid)?;
        if self.version != 1
            || self.id != key
            || !id(&self.id)
            || !self.caller_sid.starts_with("S-1-")
            || self.caller_sid.len() > 184
            || (self.recovered && !self.completed)
        {
            return Err("Invalid protected task journal; evidence retained".into());
        }
        if let Some(proof) = &self.after {
            if proof.path.len() > 512
                || proof.fingerprint.len() != 64
                || !proof.fingerprint.bytes().all(|c| c.is_ascii_hexdigit())
                || proof.instances.len() > 64
            {
                return Err("Invalid native task poststate proof".into());
            }
        }
        if serde_json::to_vec(self).map_err(|e| e.to_string())?.len() > 28 * 1024 {
            return Err("Scheduled-task journal exceeds its supported protected budget".into());
        }
        Ok(())
    }
}
fn validate_resolved(resolved: &Resolved, sid: &str) -> Result<(), String> {
    if let Some(before) = &resolved.before {
        before.validate(sid)?;
    }
    match &resolved.action {
        Some(platform::PlatformAction::Register { definition }) => {
            if resolved.before.is_some() || definition.caller_sid != sid {
                return Err("Task create authority binding invalid".into());
            }
        }
        Some(platform::PlatformAction::Update { definition }) => {
            if resolved.before.is_none() || definition.caller_sid != sid {
                return Err("Task update authority binding invalid".into());
            }
        }
        Some(_) if resolved.before.is_none() => {
            return Err("Task mutation requires a native snapshot".into())
        }
        _ => {}
    }
    Ok(())
}
fn preflight(envelope: &Envelope) -> Result<(), String> {
    envelope.request.validate()?;
    validate_resolved(&envelope.resolved, &envelope.caller_sid)?;
    if !id(&envelope.plan_id)
        || envelope.parent_pid == 0
        || !envelope.caller_sid.starts_with("S-1-")
        || envelope.caller_sid.len() > 184
    {
        return Err("Invalid native scheduled-task identity".into());
    }
    let time = now()?;
    if envelope.deadline_utc_ms < time || envelope.deadline_utc_ms > time.saturating_add(TTL_MS) {
        return Err("Task plan expired; refresh and review again".into());
    }
    // Full before/target and worst supported after are budgeted before consent or
    // platform mutation. Never increase the shared protected-store/message caps.
    let prospective = Journal {
        version: 1,
        id: envelope.plan_id.clone(),
        caller_sid: envelope.caller_sid.clone(),
        request: envelope.request.clone(),
        resolved: envelope.resolved.clone(),
        after: Some(AfterProof {
            path: "p".repeat(512),
            fingerprint: "f".repeat(64),
            enabled: false,
            instances: vec!["{11111111-2222-3333-4444-555555555555}".into(); 64],
        }),
        instance_guid: Some("{11111111-2222-3333-4444-555555555555}".into()),
        completed: false,
        recovered: false,
    };
    if serde_json::to_vec(&prospective)
        .map_err(|e| e.to_string())?
        .len()
        > 26 * 1024
        || serde_json::to_vec(envelope)
            .map_err(|e| e.to_string())?
            .len()
            > 192 * 1024
    {
        return Err(
            "This task definition/ACL exceeds the supported journal budget and is read-only".into(),
        );
    }
    Ok(())
}
fn same(expected: &platform::Snapshot, actual: &platform::Snapshot) -> Result<bool, String> {
    Ok(expected.path == actual.path
        && expected.fingerprint()? == actual.fingerprint()?
        && expected.instance_guids == actual.instance_guids)
}
trait Executor {
    fn read_head(&mut self) -> Result<Option<SharedHead>, String>;
    fn save_head(&mut self, head: &SharedHead) -> Result<(), String>;
    fn read_journal(&mut self, id: &str) -> Result<Option<Journal>, String>;
    fn save(&mut self, id: &str, journal: &Journal) -> Result<(), String>;
    fn read_task(&mut self, path: &str, sid: &str) -> Result<Option<platform::Snapshot>, String>;
    fn confirm(&mut self, envelope: &Envelope) -> Result<(), String>;
    fn authorize(&mut self) -> Result<(), String>;
    fn apply(&mut self, envelope: &Envelope) -> Result<platform::Outcome, String>;
}
fn available(executor: &mut impl Executor) -> Result<(), String> {
    if let Some(head) = executor.read_head()? {
        head.validate()?;
        if !head.completed {
            return Err(format!("An earlier task operation is uncertain; native journal {} is retained and all task changes are blocked",head.id));
        }
    }
    Ok(())
}
fn action_path(resolved: &Resolved) -> Result<&str, String> {
    if let Some(before) = &resolved.before {
        return Ok(&before.path);
    }
    match &resolved.action {
        Some(platform::PlatformAction::Register { definition }) => Ok(&definition.path),
        _ => Err("Native task target is missing".into()),
    }
}
fn check_current(e: &Envelope, executor: &mut impl Executor) -> Result<(), String> {
    let path = if e.resolved.action.is_none() {
        if let Request::ConfigureOwned { role, .. } = &e.request {
            role_path(role)
        } else {
            return Err("Only an exact owned-role no-op is supported".into());
        }
    } else {
        action_path(&e.resolved)?
    };
    let current = executor.read_task(path, &e.caller_sid)?;
    match(&e.resolved.before,current){(None,None)=>Ok(()),(Some(before),Some(actual))if same(before,&actual)?=>Ok(()),_=>Err("Task definition, ACL, enabled state, EXE identity or running instances changed; refresh and review".into())}
}
fn recoverable(action: &Option<platform::PlatformAction>) -> bool {
    matches!(
        action,
        Some(
            platform::PlatformAction::SetEnabled { .. }
                | platform::PlatformAction::Delete
                | platform::PlatformAction::Register { .. }
                | platform::PlatformAction::Update { .. }
        )
    )
}
fn owned_journal(executor: &mut impl Executor, id: &str, sid: &str) -> Result<Journal, String> {
    let source = executor
        .read_journal(id)?
        .ok_or("Native scheduled-task recovery record missing")?;
    source.validate(id)?;
    if source.caller_sid != sid
        || !source.completed
        || source.recovered
        || !recoverable(&source.resolved.action)
        || source.request.recovery_id().is_some()
    {
        return Err(
            "Task recovery record is unowned, uncertain, non-reversible or consumed".into(),
        );
    }
    Ok(source)
}
fn recovery_plan(source: &Journal, executor: &mut impl Executor) -> Result<Resolved, String> {
    let current = executor.read_task(action_path(&source.resolved)?, &source.caller_sid)?;
    match (&source.after, &current) {
        (None, None) => {}
        (Some(proof), Some(actual)) if proof.matches(actual)? => {}
        _ => {
            return Err(
                "Task recovery poststate changed or was replaced; no settings changed".into(),
            )
        }
    }
    let action = match &source.resolved.action {
        Some(platform::PlatformAction::SetEnabled { .. }) => platform::PlatformAction::SetEnabled {
            enabled: source
                .resolved
                .before
                .as_ref()
                .ok_or("Task original state missing")?
                .enabled,
        },
        Some(platform::PlatformAction::Delete) => {
            let before = source
                .resolved
                .before
                .as_ref()
                .ok_or("Task definition backup missing")?;
            platform::PlatformAction::Register {
                definition: platform::NativeDefinition {
                    path: before.path.clone(),
                    xml: before.xml.clone(),
                    sddl: before.sddl.clone(),
                    program: before
                        .actions
                        .first()
                        .ok_or("Task native EXE identity missing")?
                        .program
                        .clone(),
                    caller_sid: source.caller_sid.clone(),
                },
            }
        }
        Some(platform::PlatformAction::Register { .. }) => platform::PlatformAction::Delete,
        Some(platform::PlatformAction::Update { .. }) => {
            let before = source
                .resolved
                .before
                .as_ref()
                .ok_or("Original task definition missing")?;
            platform::PlatformAction::Update {
                definition: platform::NativeDefinition {
                    path: before.path.clone(),
                    xml: before.xml.clone(),
                    sddl: before.sddl.clone(),
                    program: before
                        .actions
                        .first()
                        .ok_or("Task EXE missing")?
                        .program
                        .clone(),
                    caller_sid: source.caller_sid.clone(),
                },
            }
        }
        _ => return Err("Task start/stop side effects cannot be undone".into()),
    };
    Ok(Resolved {
        before: current,
        action: Some(action),
        settled: true,
    })
}
fn summary(e: &Envelope) -> String {
    let target = action_path(&e.resolved).unwrap_or("No task mutation");
    let definition = match &e.resolved.action {
        Some(
            platform::PlatformAction::Register { definition }
            | platform::PlatformAction::Update { definition },
        ) => Some(definition),
        _ => None,
    };
    let program = definition
        .map(|d| d.program.path.as_str())
        .or_else(|| {
            e.resolved
                .before
                .as_ref()
                .and_then(|s| s.actions.first())
                .map(|a| a.program.path.as_str())
        })
        .unwrap_or("No program");
    let target_xml = definition
        .map(|d| d.xml.as_str())
        .or_else(|| e.resolved.before.as_ref().map(|s| s.xml.as_str()))
        .unwrap_or("");
    let target_acl = definition
        .map(|d| d.sddl.as_str())
        .or_else(|| e.resolved.before.as_ref().map(|s| s.sddl.as_str()))
        .unwrap_or("");
    format!("Scheduled task: {target}\nAuthenticated principal: {} (InteractiveToken, least privilege)\nNative action: {:?}\nProgram: {program}\nPrevious enabled: {:?}\nNative recovery journal: {}\n\nCreation/recovery registers disabled and never overwrites a replacement. Run acknowledges only a start request; task completion is not assumed. Stop targets only captured instance GUIDs.\n\nActual target definition (program, arguments and triggers):\n{target_xml}\nTarget owner/group/DACL:\n{target_acl}",e.caller_sid,e.resolved.action.as_ref().map(|action|match action{platform::PlatformAction::SetEnabled{enabled}=>format!("Set enabled={enabled}"),platform::PlatformAction::Run=>"Run with null parameter overrides".into(),platform::PlatformAction::Stop{instance_guids}=>format!("Stop instances {instance_guids:?}"),platform::PlatformAction::Delete=>"Delete disabled nonrunning task".into(),platform::PlatformAction::Register{..}=>"Create disabled, no overwrite".into(),platform::PlatformAction::Update{..}=>"Update exact owned disabled task".into()}),e.resolved.before.as_ref().map(|s|s.enabled),e.plan_id)
}
fn perform(
    e: &Envelope,
    executor: &mut impl Executor,
    commit: impl FnOnce() -> Result<(), String>,
) -> Result<ResultView, String> {
    preflight(e)?;
    available(executor)?;
    if executor.read_journal(&e.plan_id)?.is_some() {
        return Err("Task plan already used".into());
    }
    if let Some(journal_id) = e.request.recovery_id() {
        let source = owned_journal(executor, journal_id, &e.caller_sid)?;
        if matches!(e.request, Request::RecoverDeleted { .. })
            && !matches!(
                source.resolved.action,
                Some(platform::PlatformAction::Delete)
            )
        {
            return Err("Backup task recovery requires a native deletion journal, never a toggle/update journal".into());
        }
        let expected = recovery_plan(&source, executor)?;
        if serde_json::to_value(expected).map_err(|e| e.to_string())?
            != serde_json::to_value(&e.resolved).map_err(|e| e.to_string())?
        {
            return Err("Native task recovery plan binding changed".into());
        }
    }
    check_current(e, executor)?;
    if e.resolved.action.is_none() {
        return Ok(ResultView {
            ok: true,
            journal_id: e.plan_id.clone(),
            settled: true,
            changed: false,
            task: e.resolved.before.clone(),
            instance_guid: None,
            recoverable: false,
            detail: "The native owned task already matches the requested state.".into(),
        });
    }
    executor.confirm(e)?;
    preflight(e)?;
    check_current(e, executor)?;
    commit()?;
    preflight(e)?;
    check_current(e, executor)?;
    executor.authorize()?;
    let mut journal = Journal {
        version: 1,
        id: e.plan_id.clone(),
        caller_sid: e.caller_sid.clone(),
        request: e.request.clone(),
        resolved: e.resolved.clone(),
        after: None,
        instance_guid: None,
        completed: false,
        recovered: false,
    };
    journal.validate(&journal.id)?;
    executor.save(&journal.id, &journal)?;
    executor.save_head(&SharedHead::from_journal(&journal))?;
    let result=(||->Result<platform::Outcome,String>{
        executor.authorize()?;let outcome=executor.apply(e)?;executor.authorize()?;
        if let Some(after)=&outcome.snapshot{after.validate(&e.caller_sid)?;}
        match e.resolved.action.as_ref().ok_or("Missing task mutation")?{
            platform::PlatformAction::Delete=>if outcome.snapshot.is_some()||executor.read_task(action_path(&e.resolved)?,&e.caller_sid)?.is_some(){return Err("Task deletion absence was not verified".into());},
            platform::PlatformAction::Run=>if outcome.instance_guid.is_none(){return Err("Task start has no native instance acknowledgement".into());},
            platform::PlatformAction::Register{..}|platform::PlatformAction::Update{..}=>if outcome.snapshot.as_ref().is_none_or(|task|task.enabled){return Err("Task registration was not verified disabled".into());},
            platform::PlatformAction::SetEnabled{enabled}=>if outcome.snapshot.as_ref().is_none_or(|task|task.enabled!=*enabled){return Err("Task enabled-state readback failed".into());},
            platform::PlatformAction::Stop{instance_guids}=>if outcome.snapshot.as_ref().is_none_or(|task|task.instance_guids.iter().any(|id|instance_guids.contains(id))){return Err("Captured running instances were not verified stopped".into());},
        }
        if let Some(journal_id)=e.request.recovery_id(){let mut source=owned_journal(executor,journal_id,&e.caller_sid)?;source.recovered=true;executor.save(journal_id,&source)?;}
        journal.after=outcome.snapshot.as_ref().map(AfterProof::capture).transpose()?;journal.instance_guid=outcome.instance_guid.clone();journal.completed=true;executor.save(&journal.id,&journal)?;executor.save_head(&SharedHead::from_journal(&journal))?;Ok(outcome)
    })().map_err(|error|format!("Scheduled-task operation failed or is uncertain. Native journal {} is retained and further task changes are blocked: {error}",e.plan_id))?;
    Ok(ResultView {
        ok: true,
        journal_id: e.plan_id.clone(),
        settled: e.resolved.settled,
        changed: true,
        task: result.snapshot,
        instance_guid: result.instance_guid,
        recoverable: recoverable(&e.resolved.action) && e.request.recovery_id().is_none(),
        detail: if matches!(e.resolved.action, Some(platform::PlatformAction::Run)) {
            "Start request acknowledged by native instance GUID; task completion is not assumed."
        } else {
            "Native task action and exact poststate were verified and recorded."
        }
        .into(),
    })
}

fn role_path(role: &platform::OwnedRole) -> &'static str {
    match role {
        platform::OwnedRole::Signin => "\\Purgeon\\Start at Sign-in",
        platform::OwnedRole::Maintenance => "\\Purgeon\\Weekly Maintenance",
        platform::OwnedRole::Background => "\\Purgeon\\Background Monitoring",
    }
}
fn query_read(path: &str, sid: &str) -> Result<Option<platform::Snapshot>, String> {
    platform::read(path, sid)
}
pub fn query(cursor: Option<String>) -> Result<Page, String> {
    let sid = broker::current_sid()?;
    let page = platform::query(cursor.as_deref(), &sid)?;
    if page.rows.len() > 64
        || serde_json::to_vec(&page).map_err(|e| e.to_string())?.len() > 192 * 1024
    {
        return Err("Scheduled-task page exceeds bounded response budget".into());
    }
    let mut state = manager().lock().map_err(|e| e.to_string())?;
    state
        .tasks
        .retain(|_, g| g.created.elapsed() < Duration::from_secs(300));
    let mut rows = Vec::new();
    for row in page.rows {
        let task_id = if let Some(fingerprint) = &row.fingerprint {
            if state.tasks.len() >= 4096 {
                return Err("Too many task grants; refresh after pending reviews expire".into());
            }
            let id = broker::random_id()?;
            state.tasks.insert(
                id.clone(),
                TaskGrant {
                    path: row.path.clone(),
                    fingerprint: fingerprint.clone(),
                    sid: sid.clone(),
                    created: Instant::now(),
                },
            );
            Some(id)
        } else {
            None
        };
        let split = row.path.rfind('\\').ok_or("Invalid native task path")? + 1;
        rows.push(TaskView {
            name: row.name,
            path: row.path[..split].into(),
            state: row.state,
            author: row.author,
            last_run: row.last_run,
            next_run: row.next_run,
            last_result: row.last_result,
            is_windows: row.path.to_ascii_lowercase().starts_with("\\microsoft\\"),
            task_id,
            enabled: row.enabled,
            command: row
                .action
                .as_ref()
                .map(|a| a.program.path.clone())
                .unwrap_or_default(),
            arguments: row
                .action
                .as_ref()
                .map(|a| a.arguments.clone())
                .unwrap_or_default(),
            working_directory: row
                .action
                .as_ref()
                .map(|a| a.working_directory.clone())
                .unwrap_or_default(),
            instance_guids: row.instance_guids,
            unsupported_reason: row.unsupported_reason,
        });
    }
    Ok(Page {
        rows,
        next_cursor: page.next_cursor,
    })
}
pub fn select_program(app: &tauri::AppHandle) -> Result<Option<ProgramView>, String> {
    let selected = app
        .dialog()
        .file()
        .set_title("Choose Native EXE For Scheduled Task")
        .add_filter("Native Windows Program", &["exe"])
        .blocking_pick_file();
    let Some(selected) = selected else {
        return Ok(None);
    };
    let path = selected.into_path().map_err(|e| e.to_string())?;
    let program = platform::inspect_program(&path)?;
    let id = broker::random_id()?;
    let sid = broker::current_sid()?;
    let mut state = manager().lock().map_err(|e| e.to_string())?;
    state
        .programs
        .retain(|_, g| g.created.elapsed() < Duration::from_secs(300));
    if state.programs.len() >= 64 {
        return Err("Too many selected task programs; finish a pending review first".into());
    }
    let display_path = program.path.clone();
    state.programs.insert(
        id.clone(),
        ProgramGrant {
            program,
            sid,
            created: Instant::now(),
        },
    );
    Ok(Some(ProgramView { id, display_path }))
}
pub fn owned_status(role: platform::OwnedRole) -> Result<serde_json::Value, String> {
    let sid = broker::current_sid()?;
    let legacy = role_path(&role).replacen("\\Purgeon\\", "\\SweepUninstall\\", 1);
    if query_read(&legacy, &sid)?.is_some() {
        return Err("A legacy scheduled task remains. Review it manually; Purgeon will not remove a task by name alone".into());
    }
    let Some(snapshot) = query_read(role_path(&role), &sid)? else {
        return Ok(
            serde_json::json!({"registered":false,"enabled":false,"owned":true,"running":false,"nextRun":"","lastRun":"","lastResult":null}),
        );
    };
    let exe = platform::inspect_program(&std::env::current_exe().map_err(|e| e.to_string())?)?;
    if !platform::owned_matches(&snapshot, &role, &exe, &sid) {
        return Err("A task occupies Purgeon's name but does not match its native catalog. Review it manually".into());
    }
    let row = platform::metadata(role_path(&role), &sid)?
        .ok_or("Owned task disappeared while reading runtime status")?;
    if row.fingerprint.as_deref() != Some(snapshot.fingerprint()?.as_str()) {
        return Err("Owned task changed while reading runtime status".into());
    }
    Ok(
        serde_json::json!({"registered":true,"enabled":snapshot.enabled,"owned":true,"running":!row.instance_guids.is_empty(),"nextRun":row.next_run,"lastRun":row.last_run,"lastResult":row.last_result}),
    )
}
pub fn recovery_status(journal_id: &str) -> Result<serde_json::Value, String> {
    if !id(journal_id) {
        return Err("Invalid native task recovery journal".into());
    }
    let sid = broker::current_sid()?;
    let mut executor = NativeExecutor::for_caller(sid.clone());
    let source = executor
        .read_journal(journal_id)?
        .ok_or("Native task journal missing")?;
    source.validate(journal_id)?;
    if source.caller_sid != sid {
        return Err("Task recovery record belongs to another caller".into());
    }
    Ok(
        serde_json::json!({"journalId":journal_id,"completed":source.completed,"recovered":source.recovered,"deleted":matches!(source.resolved.action,Some(platform::PlatformAction::Delete)),"recoverable":source.completed&&!source.recovered&&recoverable(&source.resolved.action)&&source.request.recovery_id().is_none(),"path":action_path(&source.resolved).unwrap_or("")}),
    )
}
fn resolve_task(task_id: &str, sid: &str) -> Result<platform::Snapshot, String> {
    let state = manager().lock().map_err(|e| e.to_string())?;
    let grant = state
        .tasks
        .get(task_id)
        .ok_or("Task grant missing; refresh inventory")?;
    if grant.sid != sid || grant.created.elapsed() >= Duration::from_secs(300) {
        return Err("Task grant expired or caller changed".into());
    }
    let path = grant.path.clone();
    let fingerprint = grant.fingerprint.clone();
    drop(state);
    let snapshot = query_read(&path, sid)?.ok_or("Task disappeared; refresh inventory")?;
    snapshot.validate(sid)?;
    if snapshot.fingerprint()? != fingerprint {
        return Err("Task definition, ACL, state or EXE changed after inventory; refresh".into());
    }
    Ok(snapshot)
}
fn owned_off_action(
    before: Option<&platform::Snapshot>,
) -> Result<Option<platform::PlatformAction>, String> {
    match before {
        None => Ok(None),
        Some(task) if task.enabled => Ok(Some(platform::PlatformAction::SetEnabled {
            enabled: false,
        })),
        Some(task) if !task.instance_guids.is_empty() => Ok(None),
        Some(task) => {
            disabled_idle(task)?;
            Ok(Some(platform::PlatformAction::Delete))
        }
    }
}
fn disabled_idle(snapshot: &platform::Snapshot) -> Result<(), String> {
    if snapshot.enabled || !snapshot.instance_guids.is_empty() {
        return Err("Disable the task and stop its running instances before deletion or definition replacement".into());
    }
    if snapshot
        .path
        .to_ascii_lowercase()
        .starts_with("\\microsoft\\")
    {
        return Err("Windows Microsoft tasks are never deleted or replaced by Purgeon".into());
    }
    Ok(())
}
fn resolved_owned(
    role: &platform::OwnedRole,
    enabled: bool,
    day: &str,
    time: &str,
    check_startup: bool,
    sid: &str,
) -> Result<Resolved, String> {
    let path = role_path(role);
    let legacy = path.replacen("\\Purgeon\\", "\\SweepUninstall\\", 1);
    if query_read(&legacy, sid)?.is_some() {
        return Err("Legacy task requires manual review; no name-only cleanup is permitted".into());
    }
    let exe = platform::inspect_program(&std::env::current_exe().map_err(|e| e.to_string())?)?;
    let before = query_read(path, sid)?;
    if let Some(snapshot) = &before {
        if !platform::owned_matches(snapshot, role, &exe, sid) {
            return Err(
                "Purgeon task name collision or changed native catalog; no task was modified"
                    .into(),
            );
        }
    }
    if !enabled {
        let action = owned_off_action(before.as_ref())?;
        let settled = action.is_none() || matches!(action, Some(platform::PlatformAction::Delete));
        return Ok(Resolved {
            before,
            action,
            settled,
        });
    }
    let definition =
        platform::build_owned_definition(role.clone(), &exe, sid, day, time, check_startup)?;
    let (action, settled) = match &before {
        None => (
            Some(platform::PlatformAction::Register { definition }),
            false,
        ),
        Some(task) => {
            if platform::definition_matches(task, &definition)? {
                if task.enabled {
                    (None, true)
                } else {
                    (
                        Some(platform::PlatformAction::SetEnabled { enabled: true }),
                        true,
                    )
                }
            } else if task.enabled {
                (
                    Some(platform::PlatformAction::SetEnabled { enabled: false }),
                    false,
                )
            } else {
                disabled_idle(task)?;
                (Some(platform::PlatformAction::Update { definition }), false)
            }
        }
    };
    Ok(Resolved {
        before,
        action,
        settled,
    })
}
pub fn prepare(request: Request) -> Result<PlanView, String> {
    request.validate()?;
    let sid = broker::current_sid()?;
    let mut executor = NativeExecutor::for_caller(sid.clone());
    available(&mut executor)?;
    let resolved = match &request {
        Request::SetEnabled { task_id, enabled } => Resolved {
            before: Some(resolve_task(task_id, &sid)?),
            action: Some(platform::PlatformAction::SetEnabled { enabled: *enabled }),
            settled: true,
        },
        Request::Run { task_id } => Resolved {
            before: Some(resolve_task(task_id, &sid)?),
            action: Some(platform::PlatformAction::Run),
            settled: true,
        },
        Request::Stop { task_id } => {
            let before = resolve_task(task_id, &sid)?;
            if before.instance_guids.is_empty() {
                return Err("No captured task instance is running".into());
            }
            let action = platform::PlatformAction::Stop {
                instance_guids: before.instance_guids.clone(),
            };
            Resolved {
                before: Some(before),
                action: Some(action),
                settled: true,
            }
        }
        Request::Remove { task_id } => {
            let before = resolve_task(task_id, &sid)?;
            disabled_idle(&before)?;
            Resolved {
                before: Some(before),
                action: Some(platform::PlatformAction::Delete),
                settled: true,
            }
        }
        Request::Create {
            program_grant,
            name,
            trigger,
        } => {
            let state = manager().lock().map_err(|e| e.to_string())?;
            let grant = state
                .programs
                .get(program_grant)
                .ok_or("Choose the native task program again")?;
            if grant.sid != sid || grant.created.elapsed() >= Duration::from_secs(300) {
                return Err("Native program grant expired or caller changed".into());
            }
            let program = grant.program.clone();
            drop(state);
            platform::recheck_program(&program)?;
            let definition =
                platform::build_definition(&format!("\\{name}"), &program, trigger, &sid, "")?;
            if query_read(&definition.path, &sid)?.is_some() {
                return Err("A task already occupies that name; no overwrite is allowed".into());
            }
            Resolved {
                before: None,
                action: Some(platform::PlatformAction::Register { definition }),
                settled: true,
            }
        }
        Request::ConfigureOwned {
            role,
            enabled,
            day,
            time,
            check_startup,
        } => resolved_owned(role, *enabled, day, time, *check_startup, &sid)?,
        Request::Recover { journal_id } | Request::RecoverDeleted { journal_id } => {
            let source = owned_journal(&mut executor, journal_id, &sid)?;
            if matches!(request, Request::RecoverDeleted { .. })
                && !matches!(
                    source.resolved.action,
                    Some(platform::PlatformAction::Delete)
                )
            {
                return Err("Backup recovery accepts only a native task deletion journal".into());
            }
            let resolved = recovery_plan(&source, &mut executor)?;
            if let Some(
                platform::PlatformAction::Register { definition }
                | platform::PlatformAction::Update { definition },
            ) = &resolved.action
            {
                platform::recheck_program(&definition.program)?;
            }
            if matches!(
                resolved.action,
                Some(platform::PlatformAction::Delete | platform::PlatformAction::Update { .. })
            ) {
                disabled_idle(
                    resolved
                        .before
                        .as_ref()
                        .ok_or("Task recovery current state missing")?,
                )?;
            }
            resolved
        }
    };
    let plan_id = broker::reserve_plan()?;
    let envelope = Envelope {
        request,
        resolved,
        plan_id: plan_id.clone(),
        caller_sid: sid,
        parent_pid: std::process::id(),
        deadline_utc_ms: now()?.saturating_add(TTL_MS),
    };
    preflight(&envelope)?;
    let view = PlanView {
        id: plan_id.clone(),
        summary: summary(&envelope),
        requires_elevation: !broker::is_elevated()?,
    };
    let mut state = manager().lock().map_err(|e| e.to_string())?;
    state
        .plans
        .retain(|_, p| p.created.elapsed() < Duration::from_millis(TTL_MS));
    state.plans.insert(
        plan_id,
        Pending {
            envelope,
            created: Instant::now(),
        },
    );
    Ok(view)
}
type NativeAuthority = (u64, u32, Option<(broker::Handle, String)>);
struct NativeExecutor {
    caller_sid: String,
    authority: Option<NativeAuthority>,
}
impl NativeExecutor {
    fn for_caller(caller_sid: String) -> Self {
        Self {
            caller_sid,
            authority: None,
        }
    }
}
fn journal_hash() -> String {
    Sha256::digest(b"Purgeon Scheduled Tasks native journal v1")
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
impl Executor for NativeExecutor {
    fn read_head(&mut self) -> Result<Option<SharedHead>, String> {
        state_store::read(
            Domain::Tasks,
            Authority::Machine,
            STORE_SID,
            &journal_hash(),
            "head",
        )?
        .map(|bytes| {
            let head: SharedHead = serde_json::from_slice(&bytes)
                .map_err(|e| format!("Shared task gate unreadable; retained: {e}"))?;
            head.validate()?;
            Ok(head)
        })
        .transpose()
    }
    fn save_head(&mut self, head: &SharedHead) -> Result<(), String> {
        head.validate()?;
        state_store::write(
            Domain::Tasks,
            Authority::Machine,
            STORE_SID,
            &journal_hash(),
            "head",
            &serde_json::to_vec(head).map_err(|e| e.to_string())?,
        )
    }
    fn read_journal(&mut self, key: &str) -> Result<Option<Journal>, String> {
        if !id(key) {
            return Err("Invalid scheduled-task journal key".into());
        }
        state_store::read(
            Domain::Tasks,
            Authority::Machine,
            &self.caller_sid,
            &journal_hash(),
            key,
        )?
        .map(|bytes| {
            let journal: Journal = serde_json::from_slice(&bytes)
                .map_err(|e| format!("Task journal is unreadable; retained: {e}"))?;
            journal.validate(key)?;
            if journal.caller_sid != self.caller_sid {
                return Err(
                    "Native task journal is not scoped to the authenticated original caller".into(),
                );
            }
            Ok(journal)
        })
        .transpose()
    }
    fn save(&mut self, key: &str, journal: &Journal) -> Result<(), String> {
        journal.validate(&journal.id)?;
        if !id(key) || journal.id != key || journal.caller_sid != self.caller_sid {
            return Err("Private task journal caller/key mismatch".into());
        }
        state_store::write(
            Domain::Tasks,
            Authority::Machine,
            &self.caller_sid,
            &journal_hash(),
            key,
            &serde_json::to_vec(journal).map_err(|e| e.to_string())?,
        )
    }
    fn read_task(&mut self, path: &str, sid: &str) -> Result<Option<platform::Snapshot>, String> {
        let result = platform::read(path, sid)?;
        if self.authority.is_some() {
            self.authorize()?;
        }
        Ok(result)
    }
    fn confirm(&mut self, envelope: &Envelope) -> Result<(), String> {
        broker::confirm_native(&summary(envelope))
    }
    fn authorize(&mut self) -> Result<(), String> {
        let (until, pid, channel) = self
            .authority
            .as_ref()
            .ok_or("No native task mutation authority")?;
        if now()? >= *until {
            return Err("Task absolute deadline expired; no further action is allowed".into());
        }
        broker::require_live_parent(*pid)?;
        if let Some((pipe, digest)) = channel {
            broker::require_connected(*pipe)?;
            reply(*pipe, digest, Message::Progress)?;
        }
        Ok(())
    }
    fn apply(&mut self, envelope: &Envelope) -> Result<platform::Outcome, String> {
        self.authorize()?;
        platform::apply(
            envelope
                .resolved
                .action
                .as_ref()
                .ok_or("Task action missing")?,
            envelope.resolved.before.as_ref(),
            &envelope.caller_sid,
            envelope.deadline_utc_ms,
            envelope.parent_pid,
            || self.authorize(),
        )
    }
}
pub fn execute(plan_id: &str) -> Result<ResultView, String> {
    broker::consume_plan(plan_id)?;
    let pending = manager()
        .lock()
        .map_err(|e| e.to_string())?
        .plans
        .remove(plan_id)
        .ok_or("Native task plan is missing or consumed")?;
    if pending.created.elapsed() >= Duration::from_millis(TTL_MS)
        || broker::current_sid()? != pending.envelope.caller_sid
    {
        return Err("Native task plan expired or caller changed".into());
    }
    if broker::is_elevated()? {
        return execute_native(&pending.envelope, None, || Ok(()));
    }
    let expected = pending.envelope.plan_id.clone();
    match transport(Dispatch {
        envelope: pending.envelope,
        digest: String::new(),
    })? {
        Message::Result {
            result: Some(result),
            error: None,
        } if result.ok && result.journal_id == expected => Ok(*result),
        Message::Result { error, .. } => {
            Err(error.unwrap_or("Native task helper returned no result".into()))
        }
        _ => Err("Unexpected task helper result phase".into()),
    }
}
fn execute_native(
    e: &Envelope,
    channel: Option<(broker::Handle, String)>,
    commit: impl FnOnce() -> Result<(), String>,
) -> Result<ResultView, String> {
    if !broker::is_elevated()? {
        return Err("Task mutation requires the authenticated native helper".into());
    }
    let _lease = broker::domain_lease(&e.caller_sid)?;
    let mut executor = NativeExecutor {
        caller_sid: e.caller_sid.clone(),
        authority: Some((e.deadline_utc_ms, e.parent_pid, channel)),
    };
    perform(e, &mut executor, || {
        broker::require_live_parent(e.parent_pid)?;
        commit()?;
        broker::require_live_parent(e.parent_pid)
    })
}
#[derive(Serialize, Deserialize)]
#[serde(tag = "phase", rename_all = "camelCase", deny_unknown_fields)]
enum Message {
    Ready,
    Progress,
    Result {
        result: Option<Box<ResultView>>,
        error: Option<String>,
    },
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Dispatch {
    envelope: Envelope,
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
fn digest(e: &Envelope) -> Result<String, String> {
    Ok(
        Sha256::digest(serde_json::to_vec(e).map_err(|e| e.to_string())?)
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
fn receive_reply(pipe: broker::Handle, hash: &str, until: Instant) -> Result<Message, String> {
    loop {
        let reply: Reply = broker::receive_until(pipe, until)?;
        if reply.digest != hash {
            return Err("Task helper reply binding mismatch".into());
        }
        if matches!(reply.message, Message::Progress) {
            if Instant::now() >= until {
                return Err("Task helper deadline expired".into());
            }
            continue;
        }
        return Ok(reply.message);
    }
}
fn transport(mut dispatch: Dispatch) -> Result<Message, String> {
    dispatch.digest = digest(&dispatch.envelope)?;
    let hash = dispatch.digest.clone();
    let until = Instant::now()
        + Duration::from_millis(dispatch.envelope.deadline_utc_ms.saturating_sub(now()?));
    let name = format!(
        "{PIPE_PREFIX}{}-{}",
        std::process::id(),
        broker::random_id()?
    );
    let pipe = broker::server_pipe(&name)?;
    let helper = broker::launch_domain_helper(broker::HelperKind::Tasks, &name)?;
    broker::accept_pipe(pipe.0)?;
    broker::authenticate_client(pipe.0, helper.0)?;
    broker::send(pipe.0, &dispatch)?;
    match receive_reply(pipe.0, &hash, until)? {
        Message::Ready => {
            broker::authenticate_client(pipe.0, helper.0)?;
            broker::send(
                pipe.0,
                &Commit {
                    digest: hash.clone(),
                    approved: true,
                },
            )?;
            receive_reply(pipe.0, &hash, until)
        }
        value => Ok(value),
    }
}
pub(crate) fn helper(name: &str) -> Result<(), String> {
    if !broker::is_elevated()? {
        return Err("Task helper is not elevated".into());
    }
    let (pid, nonce) = name
        .strip_prefix(PIPE_PREFIX)
        .ok_or("Invalid task helper pipe")?
        .split_once('-')
        .ok_or("Invalid task helper pipe")?;
    let pid = pid.parse::<u32>().map_err(|e| e.to_string())?;
    if !id(nonce) {
        return Err("Invalid task helper nonce".into());
    }
    let pipe = broker::client_pipe(name, pid)?;
    let dispatch: Dispatch = broker::receive(pipe.0)?;
    if digest(&dispatch.envelope)? != dispatch.digest
        || dispatch.envelope.parent_pid != pid
        || dispatch.envelope.caller_sid != broker::process_sid(pid)?
    {
        return Err("Task helper caller/binding mismatch".into());
    }
    preflight(&dispatch.envelope)?;
    broker::require_live_parent(pid)?;
    let result = execute_native(
        &dispatch.envelope,
        Some((pipe.0, dispatch.digest.clone())),
        || {
            reply(pipe.0, &dispatch.digest, Message::Ready)?;
            let commit: Commit = broker::receive(pipe.0)?;
            if !commit.approved || commit.digest != dispatch.digest {
                return Err("Parent refused native task commit".into());
            }
            Ok(())
        },
    );
    let message = match result {
        Ok(result) => Message::Result {
            result: Some(Box::new(result)),
            error: None,
        },
        Err(error) => Message::Result {
            result: None,
            error: Some(error),
        },
    };
    broker::require_live_parent(pid)?;
    reply(pipe.0, &dispatch.digest, message)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shared_gate_never_contains_task_secrets_and_private_journals_use_original_caller() {
        let mut e = plan(platform::PlatformAction::Delete);
        e.resolved.before.as_mut().unwrap().actions[0].arguments = "private-token=secret".into();
        let mut fake = fixture();
        fake.task = e.resolved.before.clone();
        perform(&e, &mut fake, || Ok(())).unwrap();
        let private = serde_json::to_string(&fake.journals[&e.plan_id]).unwrap();
        assert!(private.contains("private-token=secret"));
        let shared = serde_json::to_value(fake.head.as_ref().unwrap()).unwrap();
        assert_eq!(shared.as_object().unwrap().len(), 3);
        for key in ["version", "id", "completed"] {
            assert!(shared.get(key).is_some());
        }
        let text = shared.to_string();
        for secret in ["private-token", "Fixture", "sddl", "callerSid", "xml"] {
            assert!(!text.contains(secret));
        }
        let executor = NativeExecutor::for_caller("S-1-5-21-123".into());
        assert_eq!(executor.caller_sid, "S-1-5-21-123");
        assert_ne!(executor.caller_sid, STORE_SID);
        let mut hostile = shared;
        hostile["xml"] = serde_json::json!("secret");
        assert!(serde_json::from_value::<SharedHead>(hostile).is_err());
    }
    #[test]
    fn delete_only_backup_recovery_cannot_replay_a_toggle_journal() {
        let e = plan(platform::PlatformAction::SetEnabled { enabled: true });
        let mut fake = fixture();
        perform(&e, &mut fake, || Ok(())).unwrap();
        let source = owned_journal(&mut fake, &e.plan_id, &e.caller_sid).unwrap();
        let resolved = recovery_plan(&source, &mut fake).unwrap();
        let recovery = Envelope {
            request: Request::RecoverDeleted {
                journal_id: e.plan_id.clone(),
            },
            resolved,
            plan_id: "b".repeat(32),
            ..e
        };
        assert!(perform(&recovery, &mut fake, || Ok(()))
            .unwrap_err()
            .contains("deletion journal"));
        assert_eq!(fake.writes, 1);
    }
    fn snapshot() -> platform::Snapshot {
        platform::Snapshot {
            path: "\\Fixture".into(),
            xml: "<Task><Settings><Enabled>false</Enabled></Settings></Task>".into(),
            sddl: "O:S-1-5-21-1D:P(A;;FA;;;S-1-5-21-1)".into(),
            enabled: false,
            principal_sid: "S-1-5-21-1".into(),
            logon_type: 3,
            run_level: 0,
            actions: vec![platform::ExecAction {
                program: platform::Program {
                    path: r"C:\Fixture\fixture.exe".into(),
                    digest: "a".repeat(64),
                    bytes: 128,
                    modified: "1".into(),
                },
                arguments: String::new(),
                working_directory: String::new(),
            }],
            instance_guids: vec![],
        }
    }
    fn plan(action: platform::PlatformAction) -> Envelope {
        Envelope {
            request: match &action {
                platform::PlatformAction::Run => Request::Run {
                    task_id: "d".repeat(32),
                },
                platform::PlatformAction::Stop { .. } => Request::Stop {
                    task_id: "d".repeat(32),
                },
                platform::PlatformAction::Delete => Request::Remove {
                    task_id: "d".repeat(32),
                },
                _ => Request::SetEnabled {
                    task_id: "d".repeat(32),
                    enabled: true,
                },
            },
            resolved: Resolved {
                before: Some(snapshot()),
                action: Some(action),
                settled: true,
            },
            plan_id: "a".repeat(32),
            caller_sid: "S-1-5-21-1".into(),
            parent_pid: 1,
            deadline_utc_ms: now().unwrap() + TTL_MS,
        }
    }
    #[derive(Default)]
    struct Fake {
        task: Option<platform::Snapshot>,
        journals: HashMap<String, Journal>,
        head: Option<SharedHead>,
        mode: &'static str,
        trace: Vec<String>,
        reads: usize,
        writes: usize,
        late: bool,
    }
    impl Executor for Fake {
        fn read_head(&mut self) -> Result<Option<SharedHead>, String> {
            Ok(self.head.clone())
        }
        fn save_head(&mut self, head: &SharedHead) -> Result<(), String> {
            self.trace.push(format!("save:head:{}", head.completed));
            if self.mode == "head-complete" && head.completed {
                return Err("shared completion save failed".into());
            }
            self.head = Some(head.clone());
            Ok(())
        }
        fn read_journal(&mut self, key: &str) -> Result<Option<Journal>, String> {
            Ok(self.journals.get(key).cloned())
        }
        fn save(&mut self, key: &str, journal: &Journal) -> Result<(), String> {
            self.trace.push(format!("save:{key}:{}", journal.completed));
            if self.mode == "intent" && !journal.completed
                || self.mode == "complete" && journal.completed
            {
                return Err("durable task journal unavailable".into());
            }
            self.journals.insert(key.into(), journal.clone());
            Ok(())
        }
        fn read_task(&mut self, _: &str, _: &str) -> Result<Option<platform::Snapshot>, String> {
            self.reads += 1;
            if self.mode == "stale" && self.reads == 1
                || self.mode == "after-consent" && self.reads == 2
                || self.mode == "precommit" && self.reads == 3
            {
                if let Some(task) = &mut self.task {
                    task.sddl.push('X');
                }
            }
            Ok(self.task.clone())
        }
        fn confirm(&mut self, _: &Envelope) -> Result<(), String> {
            self.trace.push("consent".into());
            if self.mode == "cancel" {
                Err("USER_CANCELLED".into())
            } else {
                Ok(())
            }
        }
        fn authorize(&mut self) -> Result<(), String> {
            if self.late {
                Err("native parent closed or deadline expired".into())
            } else {
                Ok(())
            }
        }
        fn apply(&mut self, e: &Envelope) -> Result<platform::Outcome, String> {
            if self.mode == "late" {
                self.late = true;
            }
            self.authorize()?;
            self.writes += 1;
            self.trace.push("platform-action".into());
            let mut instance_guid = None;
            match e.resolved.action.as_ref().unwrap() {
                platform::PlatformAction::Delete => self.task = None,
                platform::PlatformAction::SetEnabled { enabled } => {
                    let task = self.task.as_mut().unwrap();
                    task.enabled = *enabled;
                    task.xml =
                        format!("<Task><Settings><Enabled>{enabled}</Enabled></Settings></Task>");
                }
                platform::PlatformAction::Run => {
                    instance_guid = Some("{11111111-2222-3333-4444-555555555555}".into())
                }
                platform::PlatformAction::Stop { instance_guids } => self
                    .task
                    .as_mut()
                    .unwrap()
                    .instance_guids
                    .retain(|id| !instance_guids.contains(id)),
                platform::PlatformAction::Register { definition }
                | platform::PlatformAction::Update { definition } => {
                    let mut task = snapshot();
                    task.path = definition.path.clone();
                    task.xml = definition.xml.clone();
                    task.sddl = definition.sddl.clone();
                    task.actions[0].program = definition.program.clone();
                    task.enabled = false;
                    self.task = Some(task);
                }
            }
            if self.mode == "after-write" {
                return Err("unknown after native action".into());
            }
            if self.mode == "enabled-readback" {
                self.task.as_mut().unwrap().enabled = false;
            }
            Ok(platform::Outcome {
                snapshot: self.task.clone(),
                instance_guid,
            })
        }
    }
    fn fixture() -> Fake {
        Fake {
            task: Some(snapshot()),
            ..Fake::default()
        }
    }
    fn definition() -> platform::NativeDefinition {
        let before = snapshot();
        platform::NativeDefinition {
            path: before.path,
            xml: before.xml,
            sddl: before.sddl,
            program: before.actions[0].program.clone(),
            caller_sid: before.principal_sid,
        }
    }
    #[test]
    fn closed_requests_missing_authority_fields_and_foreign_principals_fail_closed() {
        for value in [
            serde_json::json!({"kind":"remove","name":"Fixture","path":"\\"}),
            serde_json::json!({"kind":"run","taskId":"a".repeat(32),"parameters":["override"]}),
            serde_json::json!({"kind":"create","program":"C:\\caller.exe","name":"X","trigger":{"kind":"logon"}}),
        ] {
            assert!(serde_json::from_value::<Request>(value).is_err());
        }
        let e = plan(platform::PlatformAction::Delete);
        for key in ["before", "action"] {
            let mut value = serde_json::to_value(&e.resolved).unwrap();
            value.as_object_mut().unwrap().remove(key);
            assert!(serde_json::from_value::<Resolved>(value).is_err());
        }
        for field in ["sid", "runLevel", "logon"] {
            let mut e = e.clone();
            let before = e.resolved.before.as_mut().unwrap();
            match field {
                "sid" => before.principal_sid = "S-1-5-21-2".into(),
                "runLevel" => before.run_level = 1,
                _ => before.logon_type = 1,
            };
            let mut fake = fixture();
            assert!(perform(&e, &mut fake, || Ok(())).is_err());
            assert_eq!(fake.writes, 0);
        }
    }
    #[test]
    fn native_intent_precedes_action_and_completion_precedes_success() {
        let e = plan(platform::PlatformAction::SetEnabled { enabled: true });
        let mut fake = fixture();
        let result = perform(&e, &mut fake, || Ok(())).unwrap();
        assert!(result.recoverable);
        let positions = |s: &str| fake.trace.iter().position(|v| v == s).unwrap();
        assert!(positions("save:head:false") < positions("platform-action"));
        assert!(positions("platform-action") < positions("save:head:true"));
        assert_eq!(fake.writes, 1);
        assert!(perform(&e, &mut fake, || Ok(())).is_err());
        assert_eq!(fake.writes, 1);
    }
    #[test]
    fn stale_definition_acl_instances_cancelled_commit_and_expiry_never_mutate() {
        for mode in ["stale", "after-consent", "precommit", "cancel", "intent"] {
            let e = plan(platform::PlatformAction::Delete);
            let mut fake = Fake { mode, ..fixture() };
            assert!(perform(&e, &mut fake, || Ok(())).is_err(), "{mode}");
            assert_eq!(fake.writes, 0, "{mode}");
        }
        let e = plan(platform::PlatformAction::Delete);
        let mut fake = fixture();
        assert!(perform(&e, &mut fake, || Err("parent refused".into())).is_err());
        assert_eq!(fake.writes, 0);
        let mut expired = e;
        expired.deadline_utc_ms = 0;
        assert!(perform(&expired, &mut fake, || Ok(())).is_err());
        assert_eq!(fake.writes, 0);
    }
    #[test]
    fn late_parent_loss_and_uncertain_completion_retain_global_gate() {
        for mode in [
            "late",
            "after-write",
            "complete",
            "head-complete",
            "enabled-readback",
        ] {
            let e = plan(platform::PlatformAction::SetEnabled { enabled: true });
            let mut fake = Fake { mode, ..fixture() };
            assert!(perform(&e, &mut fake, || Ok(()))
                .unwrap_err()
                .contains("uncertain"));
            assert!(!fake.head.as_ref().unwrap().completed);
            let writes = fake.writes;
            fake.mode = "";
            fake.late = false;
            let mut next = e;
            next.plan_id = "b".repeat(32);
            next.caller_sid = "S-1-5-21-99".into();
            next.resolved.before.as_mut().unwrap().principal_sid = next.caller_sid.clone();
            assert!(perform(&next, &mut fake, || Ok(())).is_err());
            assert_eq!(fake.writes, writes);
        }
    }
    #[test]
    fn run_ack_and_stop_are_instance_bound_and_never_recoverable() {
        let mut fake = fixture();
        let result = perform(&plan(platform::PlatformAction::Run), &mut fake, || Ok(())).unwrap();
        assert!(result.instance_guid.is_some());
        assert!(!result.recoverable);
        assert!(owned_journal(&mut fake, &"a".repeat(32), "S-1-5-21-1").is_err());
        let guid = "{11111111-2222-3333-4444-555555555555}".to_string();
        let mut e = plan(platform::PlatformAction::Stop {
            instance_guids: vec![guid.clone()],
        });
        e.resolved
            .before
            .as_mut()
            .unwrap()
            .instance_guids
            .push(guid.clone());
        let mut fake = fixture();
        fake.task.as_mut().unwrap().instance_guids.push(guid);
        let result = perform(&e, &mut fake, || Ok(())).unwrap();
        assert!(result.task.unwrap().instance_guids.is_empty());
        assert!(!result.recoverable);
    }
    #[test]
    fn delete_recovery_is_create_only_disabled_and_consumes_owned_journal() {
        let e = plan(platform::PlatformAction::Delete);
        let mut fake = fixture();
        perform(&e, &mut fake, || Ok(())).unwrap();
        assert!(fake.task.is_none());
        let source = owned_journal(&mut fake, &e.plan_id, &e.caller_sid).unwrap();
        let resolved = recovery_plan(&source, &mut fake).unwrap();
        let recover = Envelope {
            request: Request::Recover {
                journal_id: e.plan_id.clone(),
            },
            resolved,
            plan_id: "b".repeat(32),
            ..e.clone()
        };
        let result = perform(&recover, &mut fake, || Ok(())).unwrap();
        assert!(!result.task.unwrap().enabled);
        assert!(fake.journals[&e.plan_id].recovered);
        assert!(owned_journal(&mut fake, &e.plan_id, &e.caller_sid).is_err());
    }
    #[test]
    fn recovery_refuses_foreign_owner_replacement_tamper_and_running_new_task() {
        let e = plan(platform::PlatformAction::Delete);
        for mode in ["owner", "replacement", "tamper"] {
            let mut fake = fixture();
            perform(&e, &mut fake, || Ok(())).unwrap();
            match mode {
                "owner" => {
                    fake.journals.get_mut(&e.plan_id).unwrap().caller_sid = "S-1-5-21-2".into()
                }
                "replacement" => fake.task = Some(snapshot()),
                _ => fake.journals.get_mut(&e.plan_id).unwrap().version = 99,
            };
            let source = owned_journal(&mut fake, &e.plan_id, &e.caller_sid);
            if mode == "replacement" {
                assert!(recovery_plan(&source.unwrap(), &mut fake).is_err());
            } else {
                assert!(source.is_err());
            }
            assert_eq!(fake.writes, 1);
        }
    }
    #[test]
    fn register_and_update_budget_target_and_consent_before_any_side_effect() {
        for update in [false, true] {
            let mut definition = definition();
            definition.xml = "x".repeat(26 * 1024);
            let e = Envelope {
                request: Request::Create {
                    program_grant: "d".repeat(32),
                    name: "Fixture".into(),
                    trigger: platform::Trigger::Logon,
                },
                resolved: Resolved {
                    before: if update { Some(snapshot()) } else { None },
                    action: Some(if update {
                        platform::PlatformAction::Update { definition }
                    } else {
                        platform::PlatformAction::Register { definition }
                    }),
                    settled: true,
                },
                ..plan(platform::PlatformAction::Delete)
            };
            let mut fake = if update { fixture() } else { Fake::default() };
            assert!(perform(&e, &mut fake, || Ok(())).is_err());
            assert_eq!(fake.writes, 0);
        }
        let e = Envelope {
            request: Request::Create {
                program_grant: "d".repeat(32),
                name: "Fixture".into(),
                trigger: platform::Trigger::Logon,
            },
            resolved: Resolved {
                before: None,
                action: Some(platform::PlatformAction::Register {
                    definition: definition(),
                }),
                settled: true,
            },
            ..plan(platform::PlatformAction::Delete)
        };
        let text = summary(&e);
        assert!(text.contains(r"C:\Fixture\fixture.exe"));
        assert!(text.contains("Actual target definition"));
        assert!(text.contains("S-1-5-21-1"));
    }
    #[test]
    fn owned_noop_rechecks_exact_absence_and_never_claims_replacement_matches() {
        let e = Envelope {
            request: Request::ConfigureOwned {
                role: platform::OwnedRole::Signin,
                enabled: false,
                day: "Sunday".into(),
                time: "10:00".into(),
                check_startup: true,
            },
            resolved: Resolved {
                before: None,
                action: None,
                settled: true,
            },
            ..plan(platform::PlatformAction::Delete)
        };
        let mut fake = Fake::default();
        assert!(!perform(&e, &mut fake, || Ok(())).unwrap().changed);
        let mut fake = fixture();
        assert!(perform(&e, &mut fake, || Ok(())).is_err());
        assert_eq!(fake.writes, 0);
    }
    #[test]
    fn owned_off_preserves_running_instance_and_settles_disabled() {
        let mut task = snapshot();
        task.enabled = true;
        task.instance_guids = vec!["{11111111-1111-1111-1111-111111111111}".into()];
        assert!(matches!(
            owned_off_action(Some(&task)).unwrap(),
            Some(platform::PlatformAction::SetEnabled { enabled: false })
        ));
        task.enabled = false;
        assert!(owned_off_action(Some(&task)).unwrap().is_none());
        task.instance_guids.clear();
        assert!(matches!(
            owned_off_action(Some(&task)).unwrap(),
            Some(platform::PlatformAction::Delete)
        ));
    }
}
