//! Closed, capability-based operation dispatch. Opaque grants and immutable
//! single-use plans remain native; the renderer supplies no privileged paths,
//! shell commands, scripts, XML, registry payloads or executable authority.
use crate::{
    atomic_file::ExportDestination,
    broker,
    eventlogs_native::{self as logs, ChannelConfig},
    protected_artifacts::{self, ArtifactInfo, Capture},
    state_store::{self, Authority, Domain},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, AtomicU8, Ordering},
    Arc, Mutex, OnceLock,
};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri_plugin_dialog::DialogExt;

const GRANT_TTL: Duration = Duration::from_secs(300);
const PLAN_TTL: Duration = Duration::from_secs(120);
const EXECUTION_TTL: Duration = Duration::from_secs(1800);
const MAX_CHANNELS: usize = 4096;
const MAX_PLANS: usize = 64;
const PIPE_PREFIX: &str = "\\\\.\\pipe\\Purgeon-Operations-";

#[derive(Clone, Debug, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum QueryRequest {
    #[serde(rename = "eventLogChannels")]
    Channels,
    #[serde(rename = "eventLogConfig")]
    Config { channel_id: String },
    #[serde(rename = "eventLogRecovery")]
    Recovery { journal_id: String },
}
#[derive(Clone, Debug, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum SelectionKind {
    EventLogExportDestination { channel_id: String },
}
#[derive(Clone, Debug, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum OperationRequest {
    #[serde(rename = "eventLogClear")]
    Clear { channel_id: String },
    #[serde(rename = "eventLogSetEnabled")]
    SetEnabled { channel_id: String, enabled: bool },
    #[serde(rename = "eventLogExport")]
    Export {
        channel_id: String,
        destination_grant: String,
    },
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecoveryRequest {
    pub journal_id: String,
    pub decision: RecoveryDecision,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RecoveryDecision {
    AcknowledgeObserved,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelView {
    pub name: String,
    pub records: Option<u64>,
    pub size_bytes: Option<u64>,
    pub enabled: Option<bool>,
    pub guarded: bool,
    pub channel_id: Option<String>,
    pub metadata_error: Option<String>,
    pub config_error: Option<String>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigView {
    pub channel_id: String,
    pub name: String,
    pub enabled: bool,
    pub guarded: bool,
}
#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum QueryResult {
    #[serde(rename = "eventLogChannels")]
    Channels { channels: Vec<ChannelView> },
    #[serde(rename = "eventLogConfig")]
    Config { config: ConfigView },
    #[serde(rename = "eventLogRecovery")]
    Recovery { recovery: Option<RecoveryView> },
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectionView {
    pub id: String,
    pub display_path: String,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanView {
    pub id: String,
    pub summary: String,
    pub requires_elevation: bool,
    pub recovery_limits: String,
}
#[derive(Clone, Debug, Serialize)]
pub struct CancelResult {
    pub cancelled: bool,
    pub phase: &'static str,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum OperationResult {
    #[serde(rename = "eventLogClear")]
    Clear {
        ok: bool,
        backup: String,
        journal_id: String,
    },
    #[serde(rename = "eventLogSetEnabled")]
    SetEnabled {
        ok: bool,
        previous_enabled: bool,
        journal_id: String,
    },
    #[serde(rename = "eventLogExport")]
    Export {
        ok: bool,
        path: String,
        journal_id: String,
    },
    #[serde(rename = "eventLogRecoveryAcknowledged")]
    RecoveryAcknowledged { ok: bool, journal_id: String },
}

#[derive(Clone)]
struct ChannelGrant {
    name: String,
    reviewed: Option<ChannelConfig>,
    sid: String,
    session: String,
    created: Instant,
}
struct DestinationGrant {
    destination: Arc<ExportDestination>,
    sid: String,
    session: String,
    channel_name: String,
    created: Instant,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum ResolvedOperation {
    Clear,
    SetEnabled {
        enabled: bool,
    },
    Export,
    AcknowledgeObserved {
        journal_id: String,
        expected_transaction: String,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Envelope {
    operation: ResolvedOperation,
    before: ChannelConfig,
    caller_sid: String,
    session: String,
    plan_id: String,
    transaction_id: String,
    artifact_id: Option<String>,
    authorization_expires_utc: u64,
    execution_deadline_utc: u64,
    parent_pid: u32,
}
struct Pending {
    envelope: Envelope,
    destination: Option<Arc<ExportDestination>>,
    destination_id: Option<String>,
    created: Instant,
    cancelled: Arc<AtomicBool>,
    phase: Arc<AtomicU8>,
}
struct Active {
    cancelled: Arc<AtomicBool>,
    phase: Arc<AtomicU8>,
    started: Instant,
    sid: String,
    session: String,
}
struct Manager {
    session: String,
    channels: HashMap<String, ChannelGrant>,
    destinations: HashMap<String, DestinationGrant>,
    plans: HashMap<String, Pending>,
    active: HashMap<String, Active>,
}
impl Manager {
    fn new() -> Result<Self, String> {
        Ok(Self {
            session: broker::random_id()?,
            channels: HashMap::new(),
            destinations: HashMap::new(),
            plans: HashMap::new(),
            active: HashMap::new(),
        })
    }
    fn prune(&mut self) {
        self.channels
            .retain(|_, value| value.created.elapsed() < GRANT_TTL);
        self.destinations
            .retain(|_, value| value.created.elapsed() < GRANT_TTL);
        self.plans
            .retain(|_, value| value.created.elapsed() < PLAN_TTL);
        self.active.retain(|_, value| {
            value.phase.load(Ordering::SeqCst) != 2 && value.started.elapsed() < EXECUTION_TTL
        });
    }
    fn channel(&self, id: &str, sid: &str) -> Result<ChannelGrant, String> {
        valid_id(id, 32)?;
        let grant = self
            .channels
            .get(id)
            .ok_or("Event channel selection expired; refresh the list")?;
        if grant.sid != sid || grant.session != self.session || grant.created.elapsed() >= GRANT_TTL
        {
            return Err("Event channel selection expired or belongs to a different session".into());
        }
        Ok(grant.clone())
    }
}
static MANAGER: OnceLock<Mutex<Manager>> = OnceLock::new();
fn manager() -> Result<&'static Mutex<Manager>, String> {
    if MANAGER.get().is_none() {
        let _ = MANAGER.set(Mutex::new(Manager::new()?));
        static CLEANER: OnceLock<()> = OnceLock::new();
        CLEANER.get_or_init(|| {
            std::thread::spawn(|| loop {
                std::thread::sleep(Duration::from_secs(30));
                if let Some(manager) = MANAGER.get() {
                    if let Ok(mut state) = manager.lock() {
                        state.prune();
                    }
                }
            });
        });
    }
    MANAGER
        .get()
        .ok_or_else(|| "Native operation manager is unavailable".into())
}
fn valid_id(id: &str, length: usize) -> Result<(), String> {
    if id.len() != length || !id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Invalid opaque native operation identity".into());
    }
    Ok(())
}
fn now_ms() -> Result<u64, String> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis() as u64)
}
fn hash(value: &[u8]) -> String {
    Sha256::digest(value)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
fn channel_key(name: &str) -> String {
    hash(name.as_bytes())
}
fn journal_domain() -> String {
    hash(b"Purgeon EventLogs native journal v1")
}

pub fn query(request: QueryRequest) -> Result<QueryResult, String> {
    let sid = broker::current_sid()?;
    match request {
        QueryRequest::Channels => {
            let inventory = logs::inventory()?;
            if inventory.len() > MAX_CHANNELS {
                return Err("Too many event channels".into());
            }
            let mut state = manager()?.lock().map_err(|e| e.to_string())?;
            state.prune();
            state.channels.clear();
            let session = state.session.clone();
            let mut channels = Vec::with_capacity(inventory.len());
            for row in inventory {
                let enabled = row.enabled;
                let channel_id = if enabled.is_some() {
                    let id = broker::random_id()?;
                    state.channels.insert(
                        id.clone(),
                        ChannelGrant {
                            name: row.name.clone(),
                            reviewed: None,
                            sid: sid.clone(),
                            session: session.clone(),
                            created: Instant::now(),
                        },
                    );
                    Some(id)
                } else {
                    None
                };
                channels.push(ChannelView {
                    guarded: logs::guarded(&row.name),
                    name: row.name,
                    records: row.records,
                    size_bytes: row.size_bytes,
                    enabled,
                    channel_id,
                    metadata_error: row.metadata_error,
                    config_error: row.config_error,
                });
            }
            Ok(QueryResult::Channels { channels })
        }
        QueryRequest::Config { channel_id } => {
            let grant = {
                let mut state = manager()?.lock().map_err(|e| e.to_string())?;
                state.prune();
                state.channel(&channel_id, &sid)?
            };
            let config = logs::capture(&grant.name)?;
            let view = ConfigView {
                channel_id: channel_id.clone(),
                guarded: logs::guarded(&config.name),
                name: config.name.clone(),
                enabled: config.enabled()?,
            };
            let mut state = manager()?.lock().map_err(|e| e.to_string())?;
            state.channel(&channel_id, &sid)?;
            let session = state.session.clone();
            state.channels.insert(
                channel_id,
                ChannelGrant {
                    name: config.name.clone(),
                    reviewed: Some(config),
                    sid,
                    session,
                    created: Instant::now(),
                },
            );
            Ok(QueryResult::Config { config: view })
        }
        QueryRequest::Recovery { journal_id } => Ok(QueryResult::Recovery {
            recovery: load_journal(&sid, &journal_id)?.map(recovery_view),
        }),
    }
}
pub fn select(
    app: &tauri::AppHandle,
    selection: SelectionKind,
) -> Result<Option<SelectionView>, String> {
    let sid = broker::current_sid()?;
    let SelectionKind::EventLogExportDestination { channel_id } = selection;
    let grant = {
        let mut state = manager()?.lock().map_err(|e| e.to_string())?;
        state.prune();
        state.channel(&channel_id, &sid)?
    };
    let filename: String = grant
        .name
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || ['-', '_'].contains(&c) {
                c
            } else {
                '_'
            }
        })
        .take(100)
        .collect();
    let path = app
        .dialog()
        .file()
        .set_title("Save Event Log Copy")
        .add_filter("Windows Event Log", &["evtx"])
        .set_file_name(format!("{filename}.evtx"))
        .blocking_save_file();
    let Some(path) = path else {
        return Ok(None);
    };
    let path = path.into_path().map_err(|e| e.to_string())?;
    let destination = Arc::new(ExportDestination::selected(path)?);
    let mut state = manager()?.lock().map_err(|e| e.to_string())?;
    state.prune();
    state.channel(&channel_id, &sid)?;
    if state.destinations.len() >= MAX_PLANS {
        return Err(
            "Too many pending export destinations; finish or cancel an operation first".into(),
        );
    }
    let id = broker::random_id()?;
    let view = SelectionView {
        id: id.clone(),
        display_path: destination.display_path(),
    };
    let session = state.session.clone();
    state.destinations.insert(
        id,
        DestinationGrant {
            destination,
            sid,
            session,
            channel_name: grant.name,
            created: Instant::now(),
        },
    );
    Ok(Some(view))
}
fn store_plan(
    sid: String,
    before: ChannelConfig,
    operation: ResolvedOperation,
    destination: Option<Arc<ExportDestination>>,
    destination_id: Option<String>,
    channel_id: Option<String>,
) -> Result<PlanView, String> {
    before.validate()?;
    let mut state = manager()?.lock().map_err(|e| e.to_string())?;
    state.prune();
    if let Some(id) = &channel_id {
        let channel = state.channel(id, &sid)?;
        if channel.name != before.name
            || channel
                .reviewed
                .as_ref()
                .is_some_and(|reviewed| reviewed != &before)
        {
            return Err("Native event channel authority changed during preparation".into());
        }
    }
    if state.plans.len() + state.active.len() >= MAX_PLANS {
        return Err("Too many pending native plans".into());
    }
    let id = broker::random_id()?;
    let description = match &operation {
        ResolvedOperation::Clear => format!("Clear {} after Windows saves its events to a protected EVTX recovery capture", before.name),
        ResolvedOperation::SetEnabled { enabled } => format!("{} event channel {}", if *enabled { "Enable" } else { "Disable" }, before.name),
        ResolvedOperation::Export => format!("Save an EVTX copy of {} to {}", before.name, destination.as_ref().ok_or("Missing native export destination")?.display_path()),
        ResolvedOperation::AcknowledgeObserved { .. } => format!("Review and acknowledge the retained uncertain operation for {} without repeating or undoing it", before.name),
    };
    let now = now_ms()?;
    let artifact_id = if matches!(
        operation,
        ResolvedOperation::Clear | ResolvedOperation::Export
    ) {
        Some(broker::random_id()?)
    } else {
        None
    };
    let envelope = Envelope {
        operation,
        before,
        caller_sid: sid,
        session: state.session.clone(),
        plan_id: id.clone(),
        transaction_id: broker::random_id()?,
        artifact_id,
        authorization_expires_utc: now + PLAN_TTL.as_millis() as u64,
        execution_deadline_utc: now + EXECUTION_TTL.as_millis() as u64,
        parent_pid: std::process::id(),
    };
    state.plans.insert(
        id.clone(),
        Pending {
            envelope,
            destination,
            destination_id,
            created: Instant::now(),
            cancelled: Arc::new(AtomicBool::new(false)),
            phase: Arc::new(AtomicU8::new(0)),
        },
    );
    Ok(PlanView { id, summary: description, requires_elevation: !broker::is_elevated()?, recovery_limits: "Cleared events cannot be restored into the active channel. EVTX captures and uncertain journals are retained. Recovery acknowledgement never repeats or rolls back an operation.".into() })
}
fn fresh_before(
    grant: &ChannelGrant,
    capture: impl FnOnce(&str) -> Result<ChannelConfig, String>,
) -> Result<ChannelConfig, String> {
    let before = capture(&grant.name)?;
    before.validate()?;
    if before.name != grant.name
        || grant
            .reviewed
            .as_ref()
            .is_some_and(|reviewed| reviewed != &before)
    {
        return Err("Event channel configuration changed; refresh and review it again".into());
    }
    Ok(before)
}
pub fn prepare(request: OperationRequest) -> Result<PlanView, String> {
    let sid = broker::current_sid()?;
    let channel_id = match &request {
        OperationRequest::Clear { channel_id }
        | OperationRequest::SetEnabled { channel_id, .. }
        | OperationRequest::Export { channel_id, .. } => channel_id,
    };
    let selected_channel_id = channel_id.clone();
    let grant = {
        let mut state = manager()?.lock().map_err(|e| e.to_string())?;
        state.prune();
        state.channel(channel_id, &sid)?
    };
    let before = fresh_before(&grant, logs::capture)?;
    let (operation, destination, destination_id) = match request {
        OperationRequest::Clear { .. } => {
            logs::validate_change(&before.name, false)?;
            (ResolvedOperation::Clear, None, None)
        }
        OperationRequest::SetEnabled { enabled, .. } => {
            logs::validate_change(&before.name, true)?;
            (ResolvedOperation::SetEnabled { enabled }, None, None)
        }
        OperationRequest::Export {
            destination_grant, ..
        } => {
            logs::validate_tool_operand(&before.name)?;
            valid_id(&destination_grant, 32)?;
            let state = manager()?.lock().map_err(|e| e.to_string())?;
            let selected = state
                .destinations
                .get(&destination_grant)
                .ok_or("Export destination expired; choose it again")?;
            if selected.sid != sid
                || selected.session != state.session
                || selected.channel_name != before.name
                || selected.created.elapsed() >= GRANT_TTL
            {
                return Err(
                    "Export destination does not belong to this channel and native session".into(),
                );
            }
            (
                ResolvedOperation::Export,
                Some(selected.destination.clone()),
                Some(destination_grant),
            )
        }
    };
    if load_journal(&sid, &channel_key(&before.name))?
        .is_some_and(|journal| !journal.state.resolved())
    {
        return Err("An uncertain event-log operation is retained. Review its native recovery record before changing or exporting this channel again".into());
    }
    store_plan(
        sid,
        before,
        operation,
        destination,
        destination_id,
        Some(selected_channel_id),
    )
}
pub fn cancel(plan_id: &str) -> Result<CancelResult, String> {
    valid_id(plan_id, 32)?;
    let sid = broker::current_sid()?;
    let mut state = manager()?.lock().map_err(|e| e.to_string())?;
    state.prune();
    if state.plans.get(plan_id).is_some_and(|plan| {
        plan.envelope.caller_sid != sid || plan.envelope.session != state.session
    }) || state
        .active
        .get(plan_id)
        .is_some_and(|active| active.sid != sid || active.session != state.session)
    {
        return Err("Cancellation plan belongs to another native caller/session".into());
    }
    if let Some(plan) = state.plans.remove(plan_id) {
        plan.phase.store(3, Ordering::SeqCst);
        plan.cancelled.store(true, Ordering::SeqCst);
        return Ok(CancelResult {
            cancelled: true,
            phase: "prepared",
        });
    }
    if let Some(active) = state.active.get(plan_id) {
        if active
            .phase
            .compare_exchange(0, 3, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
            || active.phase.load(Ordering::SeqCst) == 3
        {
            active.cancelled.store(true, Ordering::SeqCst);
            return Ok(CancelResult {
                cancelled: true,
                phase: "prepared",
            });
        }
        return Ok(CancelResult {
            cancelled: false,
            phase: "committed",
        });
    }
    Ok(CancelResult {
        cancelled: false,
        phase: "missing",
    })
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum JournalState {
    Intent,
    Uncertain,
    DeliveryPending,
    UncertainDelivery,
    Verified,
    Acknowledged,
}
impl JournalState {
    fn resolved(&self) -> bool {
        matches!(self, Self::Verified | Self::Acknowledged)
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Journal {
    schema_version: u32,
    transaction_id: String,
    caller_sid: String,
    operation: ResolvedOperation,
    canonical_channel: String,
    before_config: ChannelConfig,
    backup_artifact_id: Option<String>,
    artifact: Option<ArtifactInfo>,
    state: JournalState,
    error: Option<String>,
    created_utc: u64,
    finished_utc: Option<u64>,
    acknowledgement: Option<Acknowledgement>,
    #[serde(default)]
    previous_archive_id: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Acknowledgement {
    observed_config: Option<ChannelConfig>,
    observation_error: Option<String>,
    at_utc: u64,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryView {
    pub journal_id: String,
    pub transaction_id: String,
    pub channel: String,
    pub state: String,
    pub backup: Option<String>,
    pub error: Option<String>,
    pub created_utc: u64,
    pub finished_utc: Option<u64>,
    pub can_acknowledge: bool,
}
fn recovery_view(journal: Journal) -> RecoveryView {
    RecoveryView {
        journal_id: channel_key(&journal.canonical_channel),
        transaction_id: journal.transaction_id,
        channel: journal.canonical_channel,
        can_acknowledge: !journal.state.resolved(),
        state: match journal.state {
            JournalState::Intent => "intent",
            JournalState::Uncertain => "uncertain",
            JournalState::DeliveryPending => "deliveryPending",
            JournalState::UncertainDelivery => "uncertainDelivery",
            JournalState::Verified => "verified",
            JournalState::Acknowledged => "acknowledged",
        }
        .into(),
        backup: journal.artifact.map(|artifact| artifact.path),
        error: journal.error,
        created_utc: journal.created_utc,
        finished_utc: journal.finished_utc,
    }
}
fn load_journal(sid: &str, key: &str) -> Result<Option<Journal>, String> {
    valid_id(key, 64)?;
    let Some(bytes) = state_store::read(
        Domain::EventLogs,
        Authority::Machine,
        sid,
        &journal_domain(),
        key,
    )?
    else {
        return Ok(None);
    };
    decode_journal(sid, key, &bytes).map(Some)
}
fn decode_journal(sid: &str, key: &str, bytes: &[u8]) -> Result<Journal, String> {
    if bytes.len() > 32768 {
        return Err("Native recovery journal exceeds its bounded schema; evidence retained".into());
    }
    let journal: Journal = serde_json::from_slice(bytes).map_err(|e| {
        format!("Native event recovery journal is unreadable; evidence retained: {e}")
    })?;
    journal.before_config.validate()?;
    if journal.schema_version != 1
        || journal.caller_sid != sid
        || journal.canonical_channel != journal.before_config.name
        || channel_key(&journal.canonical_channel) != key
    {
        return Err("Native event recovery journal identity is invalid; evidence retained".into());
    }
    valid_id(&journal.transaction_id, 32)?;
    if let Some(id) = &journal.backup_artifact_id {
        valid_id(id, 32)?;
    }
    if let Some(artifact) = &journal.artifact {
        valid_id(&artifact.id, 32)?;
        valid_id(&artifact.digest, 64)?;
    }
    Ok(journal)
}
trait JournalStore {
    fn read(&mut self, key: &str) -> Result<Option<Vec<u8>>, String>;
    fn write(&mut self, key: &str, bytes: &[u8]) -> Result<(), String>;
}
struct ProtectedJournalStore<'a> {
    sid: &'a str,
}
impl JournalStore for ProtectedJournalStore<'_> {
    fn read(&mut self, key: &str) -> Result<Option<Vec<u8>>, String> {
        state_store::read(
            Domain::EventLogs,
            Authority::Machine,
            self.sid,
            &journal_domain(),
            key,
        )
    }
    fn write(&mut self, key: &str, bytes: &[u8]) -> Result<(), String> {
        state_store::write(
            Domain::EventLogs,
            Authority::Machine,
            self.sid,
            &journal_domain(),
            key,
            bytes,
        )
    }
}
fn persist_record(store: &mut impl JournalStore, journal: &Journal) -> Result<(), String> {
    let key = channel_key(&journal.canonical_channel);
    let mut next = journal.clone();
    if let Some(original) = store.read(&key)? {
        let previous = decode_journal(&journal.caller_sid, &key, &original)?;
        let archive = format!(
            "history-{}-{}",
            previous.transaction_id,
            &hash(&original)[..32]
        );
        match store.read(&archive)? {
            Some(bytes) if bytes != original => {
                return Err(
                    "Native recovery archive identity collision; active evidence was not changed"
                        .into(),
                )
            }
            Some(_) => {}
            None => store.write(&archive, &original)?,
        }
        if store.read(&archive)?.as_deref() != Some(original.as_slice()) {
            return Err(
                "Native recovery archive readback failed; active evidence was not changed".into(),
            );
        }
        next.previous_archive_id = Some(archive);
    }
    let bytes = serde_json::to_vec(&next).map_err(|e| e.to_string())?;
    if bytes.len() > 32768 {
        return Err(
            "Native event recovery journal exceeds its size limit; no next mutation is authorized"
                .into(),
        );
    }
    store.write(&key, &bytes)
}
fn save_journal(journal: &Journal) -> Result<(), String> {
    persist_record(
        &mut ProtectedJournalStore {
            sid: &journal.caller_sid,
        },
        journal,
    )
}
pub fn recover(request: RecoveryRequest) -> Result<PlanView, String> {
    let sid = broker::current_sid()?;
    let journal = load_journal(&sid, &request.journal_id)?
        .ok_or("Native event recovery journal is missing")?;
    if journal.state.resolved() {
        return Err("This native event operation has no unresolved outcome to acknowledge".into());
    }
    match request.decision {
        RecoveryDecision::AcknowledgeObserved => store_plan(
            sid,
            journal.before_config,
            ResolvedOperation::AcknowledgeObserved {
                journal_id: request.journal_id,
                expected_transaction: journal.transaction_id,
            },
            None,
            None,
            None,
        ),
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Dispatch {
    envelope: Envelope,
    digest: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "phase",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum ServerMessage {
    Heartbeat {
        stage: String,
        bytes: Option<u64>,
    },
    Ready,
    Captured {
        artifact: ArtifactInfo,
    },
    Result {
        result: Option<OperationResult>,
        error: Option<String>,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Reply {
    digest: String,
    message: ServerMessage,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "phase",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum ClientMessage {
    Commit {
        digest: String,
        approved: bool,
    },
    DeliveryProgress {
        digest: String,
        bytes: u64,
    },
    DeliveryResult {
        digest: String,
        delivered: bool,
        error: Option<String>,
    },
}
fn envelope_digest(envelope: &Envelope) -> Result<String, String> {
    Ok(hash(
        &serde_json::to_vec(envelope).map_err(|e| e.to_string())?,
    ))
}
fn remaining(deadline_utc: u64) -> Result<Instant, String> {
    let remaining = deadline_utc
        .checked_sub(now_ms()?)
        .ok_or("Native event operation deadline exceeded")?;
    if remaining == 0 || remaining > EXECUTION_TTL.as_millis() as u64 {
        return Err("Invalid native event operation deadline".into());
    }
    Ok(Instant::now() + Duration::from_millis(remaining))
}
fn send_reply(
    pipe: broker::Handle,
    digest: &str,
    message: ServerMessage,
    deadline: Instant,
) -> Result<(), String> {
    broker::send_until(
        pipe,
        &Reply {
            digest: digest.into(),
            message,
        },
        deadline,
    )
}
fn receive_reply(
    pipe: broker::Handle,
    digest: &str,
    deadline: Instant,
) -> Result<ServerMessage, String> {
    let reply: Reply = broker::receive_until(pipe, deadline)?;
    if reply.digest != digest {
        return Err("Native operation reply binding changed".into());
    }
    Ok(reply.message)
}
fn check_authorization(envelope: &Envelope) -> Result<(), String> {
    valid_id(&envelope.plan_id, 32)?;
    valid_id(&envelope.session, 32)?;
    valid_id(&envelope.transaction_id, 32)?;
    if let Some(id) = &envelope.artifact_id {
        valid_id(id, 32)?;
    }
    let now = now_ms()?;
    if envelope.authorization_expires_utc < now
        || envelope.authorization_expires_utc > now.saturating_add(PLAN_TTL.as_millis() as u64)
    {
        return Err("Native operation authorization expired; prepare and review again".into());
    }
    remaining(envelope.execution_deadline_utc)?;
    envelope.before.validate()?;
    match &envelope.operation {
        ResolvedOperation::Clear => {
            logs::validate_change(&envelope.before.name, false)?;
            if envelope.artifact_id.is_none() {
                return Err("Clear operation has no native backup identity".into());
            }
        }
        ResolvedOperation::SetEnabled { .. } => {
            logs::validate_change(&envelope.before.name, true)?;
            if envelope.artifact_id.is_some() {
                return Err("Unexpected artifact in channel configuration operation".into());
            }
        }
        ResolvedOperation::Export => {
            logs::validate_tool_operand(&envelope.before.name)?;
            if envelope.artifact_id.is_none() {
                return Err("Export operation has no native capture identity".into());
            }
        }
        ResolvedOperation::AcknowledgeObserved {
            journal_id,
            expected_transaction,
        } => {
            valid_id(journal_id, 64)?;
            valid_id(expected_transaction, 32)?;
            if channel_key(&envelope.before.name) != *journal_id {
                return Err("Recovery journal/channel binding changed".into());
            }
        }
    }
    Ok(())
}
pub fn execute(plan_id: &str) -> Result<OperationResult, String> {
    valid_id(plan_id, 32)?;
    let sid = broker::current_sid()?;
    let pending = {
        let mut state = manager()?.lock().map_err(|e| e.to_string())?;
        state.prune();
        let plan = state
            .plans
            .remove(plan_id)
            .ok_or("Native operation plan is missing, expired or already used")?;
        if plan.envelope.caller_sid != sid
            || plan.envelope.session != state.session
            || plan.created.elapsed() >= PLAN_TTL
            || plan.cancelled.load(Ordering::SeqCst)
        {
            return Err(
                "Native operation plan belongs to another session or was cancelled/expired".into(),
            );
        }
        if let Some(id) = &plan.destination_id {
            let selected = state
                .destinations
                .remove(id)
                .ok_or("Native export destination was already consumed or expired")?;
            if selected.created.elapsed() >= GRANT_TTL
                || selected.sid != sid
                || selected.session != state.session
                || !plan
                    .destination
                    .as_ref()
                    .is_some_and(|destination| Arc::ptr_eq(destination, &selected.destination))
            {
                return Err("Native export destination identity changed".into());
            }
        }
        state.active.insert(
            plan_id.into(),
            Active {
                cancelled: plan.cancelled.clone(),
                phase: plan.phase.clone(),
                started: Instant::now(),
                sid: plan.envelope.caller_sid.clone(),
                session: plan.envelope.session.clone(),
            },
        );
        plan
    };
    let result = transport(&pending);
    pending.phase.store(2, Ordering::SeqCst);
    if let Ok(mut state) = manager()?.lock() {
        state.active.remove(plan_id);
    }
    result
}
fn transport(pending: &Pending) -> Result<OperationResult, String> {
    check_authorization(&pending.envelope)?;
    let deadline = remaining(pending.envelope.execution_deadline_utc)?;
    let digest = envelope_digest(&pending.envelope)?;
    let pipe_name = format!(
        "{PIPE_PREFIX}{}-{}",
        std::process::id(),
        broker::random_id()?
    );
    let pipe = broker::server_pipe(&pipe_name)?;
    let helper = broker::launch_domain_helper(broker::HelperKind::EventLogs, &pipe_name)?;
    broker::accept_pipe(pipe.0)?;
    broker::authenticate_client(pipe.0, helper.0)?;
    broker::send_until(
        pipe.0,
        &Dispatch {
            envelope: pending.envelope.clone(),
            digest: digest.clone(),
        },
        deadline,
    )?;
    let mut committed = false;
    let mut captured = false;
    loop {
        if Instant::now() >= deadline {
            return Err(
                "Native event operation deadline exceeded; retained journal/capture require review"
                    .into(),
            );
        }
        match receive_reply(pipe.0, &digest, deadline)? {
            ServerMessage::Heartbeat { .. } => {}
            ServerMessage::Ready if !committed => {
                broker::authenticate_client(pipe.0, helper.0)?;
                let approved = !pending.cancelled.load(Ordering::SeqCst)
                    && now_ms()? <= pending.envelope.authorization_expires_utc
                    && pending
                        .phase
                        .compare_exchange(0, 1, Ordering::SeqCst, Ordering::SeqCst)
                        .is_ok();
                broker::send_until(
                    pipe.0,
                    &ClientMessage::Commit {
                        digest: digest.clone(),
                        approved,
                    },
                    deadline,
                )?;
                if !approved {
                    return Err(
                        "USER_CANCELLED: native operation was cancelled before commit".into(),
                    );
                }
                committed = true;
            }
            ServerMessage::Captured { artifact }
                if committed
                    && !captured
                    && matches!(pending.envelope.operation, ResolvedOperation::Export) =>
            {
                captured = true;
                if pending.envelope.artifact_id.as_deref() != Some(artifact.id.as_str()) {
                    return Err("Native export artifact identity changed".into());
                }
                let mut last_progress = Instant::now()
                    .checked_sub(Duration::from_secs(1))
                    .ok_or("Invalid copy progress clock")?;
                let delivery = (|| {
                    let source =
                        protected_artifacts::read(&pending.envelope.caller_sid, &artifact)?;
                    let destination = pending
                        .destination
                        .as_ref()
                        .ok_or("Native export destination is unavailable")?;
                    destination.deliver(source, &artifact.digest, deadline, |bytes| {
                        if last_progress.elapsed() >= Duration::from_secs(1)
                            || bytes == artifact.bytes
                        {
                            broker::send_until(
                                pipe.0,
                                &ClientMessage::DeliveryProgress {
                                    digest: digest.clone(),
                                    bytes,
                                },
                                deadline,
                            )?;
                            last_progress = Instant::now();
                        }
                        Ok(())
                    })
                })();
                let error = delivery
                    .as_ref()
                    .err()
                    .map(|error| error.chars().take(1024).collect());
                broker::send_until(
                    pipe.0,
                    &ClientMessage::DeliveryResult {
                        digest: digest.clone(),
                        delivered: delivery.is_ok(),
                        error,
                    },
                    deadline,
                )?;
            }
            ServerMessage::Result {
                result: Some(mut result),
                error: None,
            } if committed
                && (!matches!(pending.envelope.operation, ResolvedOperation::Export)
                    || captured) =>
            {
                if let OperationResult::Export { path, .. } = &mut result {
                    *path = pending
                        .destination
                        .as_ref()
                        .ok_or("Missing native export destination")?
                        .display_path();
                }
                return validate_result(&pending.envelope, result);
            }
            ServerMessage::Result {
                error: Some(error), ..
            } => return Err(error),
            _ => {
                return Err(
                    "Unexpected native event operation phase; retained evidence needs review"
                        .into(),
                )
            }
        }
    }
}
fn validate_result(
    envelope: &Envelope,
    result: OperationResult,
) -> Result<OperationResult, String> {
    let key = channel_key(&envelope.before.name);
    let valid = match (&envelope.operation, &result) {
        (
            ResolvedOperation::Clear,
            OperationResult::Clear {
                ok: true,
                journal_id,
                ..
            },
        )
        | (
            ResolvedOperation::SetEnabled { .. },
            OperationResult::SetEnabled {
                ok: true,
                journal_id,
                ..
            },
        )
        | (
            ResolvedOperation::Export,
            OperationResult::Export {
                ok: true,
                journal_id,
                ..
            },
        )
        | (
            ResolvedOperation::AcknowledgeObserved { .. },
            OperationResult::RecoveryAcknowledged {
                ok: true,
                journal_id,
            },
        ) => *journal_id == key,
        _ => false,
    };
    if !valid {
        return Err("Native operation result does not match its prepared request".into());
    }
    Ok(result)
}

trait EventExecutor {
    fn config(&mut self, name: &str) -> Result<ChannelConfig, String>;
    fn load(&mut self, sid: &str, key: &str) -> Result<Option<Journal>, String>;
    fn persist(&mut self, journal: &Journal) -> Result<(), String>;
    fn confirm(&mut self, text: &str) -> Result<(), String>;
    fn capture(&mut self, envelope: &Envelope) -> Result<ArtifactInfo, String>;
    fn set_enabled(&mut self, name: &str, enabled: bool) -> Result<(), String>;
    fn verify_artifact(&mut self, sid: &str, artifact: &ArtifactInfo) -> Result<(), String>;
}
struct NativeExecutor<'a> {
    pipe: broker::Handle,
    digest: &'a str,
    deadline: Instant,
    parent_pid: u32,
}
impl NativeExecutor<'_> {
    fn heartbeat(&self, stage: &str, bytes: Option<u64>) -> Result<(), String> {
        broker::require_live_parent(self.parent_pid)?;
        send_reply(
            self.pipe,
            self.digest,
            ServerMessage::Heartbeat {
                stage: stage.into(),
                bytes,
            },
            self.deadline,
        )
    }
}
impl EventExecutor for NativeExecutor<'_> {
    fn config(&mut self, name: &str) -> Result<ChannelConfig, String> {
        logs::capture(name)
    }
    fn load(&mut self, sid: &str, key: &str) -> Result<Option<Journal>, String> {
        load_journal(sid, key)
    }
    fn persist(&mut self, journal: &Journal) -> Result<(), String> {
        save_journal(journal)
    }
    fn confirm(&mut self, text: &str) -> Result<(), String> {
        broker::confirm_native(text)
    }
    fn capture(&mut self, envelope: &Envelope) -> Result<ArtifactInfo, String> {
        let capture = Capture::reserve(
            &envelope.caller_sid,
            envelope
                .artifact_id
                .as_deref()
                .ok_or("Missing native capture ID")?,
        )?;
        let path = capture.path().to_string_lossy().into_owned();
        let arguments = match envelope.operation {
            ResolvedOperation::Clear => vec![
                "cl".into(),
                envelope.before.name.clone(),
                format!("/bu:{path}"),
            ],
            ResolvedOperation::Export => vec!["epl".into(), envelope.before.name.clone(), path],
            _ => return Err("This operation does not capture event logs".into()),
        };
        logs::run_tool(&arguments, self.deadline, || {
            self.heartbeat("capturing", None)
        })?;
        let mut last = Instant::now()
            .checked_sub(Duration::from_secs(1))
            .ok_or("Invalid verification clock")?;
        capture
            .verify(self.deadline, |bytes| {
                if last.elapsed() >= Duration::from_secs(1) {
                    self.heartbeat("verifyingCapture", Some(bytes))?;
                    last = Instant::now();
                }
                Ok(())
            })
            .map_err(|error| {
                format!(
                    "{error}. Native EVTX evidence retained at {}",
                    capture.path().display()
                )
            })
    }
    fn set_enabled(&mut self, name: &str, enabled: bool) -> Result<(), String> {
        logs::run_tool(
            &[
                "sl".into(),
                name.into(),
                format!("/e:{}", if enabled { "true" } else { "false" }),
            ],
            self.deadline,
            || self.heartbeat("settingChannel", None),
        )
    }
    fn verify_artifact(&mut self, sid: &str, artifact: &ArtifactInfo) -> Result<(), String> {
        use std::io::Read;
        let mut file = protected_artifacts::read(sid, artifact)?;
        let mut buffer = vec![0u8; 1024 * 1024];
        let mut value = Sha256::new();
        let mut bytes = 0u64;
        let mut last = Instant::now()
            .checked_sub(Duration::from_secs(1))
            .ok_or("Invalid recovery clock")?;
        loop {
            if Instant::now() >= self.deadline {
                return Err("Recovery capture verification deadline exceeded".into());
            }
            let length = file.read(&mut buffer).map_err(|e| e.to_string())?;
            if length == 0 {
                break;
            }
            value.update(&buffer[..length]);
            bytes += length as u64;
            if bytes > artifact.bytes {
                return Err("Retained event capture grew after verification".into());
            }
            if last.elapsed() >= Duration::from_secs(1) {
                self.heartbeat("reviewingCapture", Some(bytes))?;
                last = Instant::now();
            }
        }
        let digest: String = value
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        if bytes != artifact.bytes || digest != artifact.digest {
            return Err("Retained event capture integrity no longer matches its protected journal; evidence kept".into());
        }
        Ok(())
    }
}
fn persist_uncertain(
    executor: &mut impl EventExecutor,
    journal: &mut Journal,
    error: &str,
    delivery: bool,
) -> String {
    journal.state = if delivery {
        JournalState::UncertainDelivery
    } else {
        JournalState::Uncertain
    };
    journal.error = Some(error.chars().take(2048).collect());
    match executor.persist(journal) {
        Ok(()) => format!("{error}. Native journal {} and any EVTX capture are retained; inspect them before retrying", channel_key(&journal.canonical_channel)),
        Err(record_error) => format!("{error}. Recovery-result write also failed ({record_error}); the previously persisted intent/capture remains unresolved"),
    }
}
fn perform(
    envelope: &Envelope,
    executor: &mut impl EventExecutor,
    commit: impl FnOnce() -> Result<(), String>,
    mut deliver: impl FnMut(&ArtifactInfo) -> Result<(), String>,
) -> Result<OperationResult, String> {
    check_authorization(envelope)?;
    let key = channel_key(&envelope.before.name);
    let existing = executor.load(&envelope.caller_sid, &key)?;
    if let ResolvedOperation::AcknowledgeObserved {
        expected_transaction,
        ..
    } = &envelope.operation
    {
        let mut journal = existing.ok_or("Native recovery record disappeared")?;
        if journal.transaction_id != *expected_transaction || journal.state.resolved() {
            return Err("Native recovery record changed after review; prepare again".into());
        }
        if let Some(artifact) = &journal.artifact {
            executor.verify_artifact(&envelope.caller_sid, artifact)?;
        }
        let (observed_config, observation_error) = match executor.config(&journal.canonical_channel)
        {
            Ok(config) => (Some(config), None),
            Err(error) => (None, Some(error.chars().take(1024).collect())),
        };
        executor.confirm(&format!("Acknowledge the retained uncertain operation for {}?\n\nOriginal result: {:?}\nCurrent enabled state: {}\nPrior error: {}\nCurrent observation error: {}\n\nThis only records your review and permits future operations. It does not establish whether the earlier operation completed, replay it, undo it, or delete any evidence.", journal.canonical_channel, journal.state, observed_config.as_ref().and_then(|config| config.enabled().ok()).map(|value| value.to_string()).unwrap_or("unknown".into()), journal.error.as_deref().unwrap_or("none recorded"), observation_error.as_deref().unwrap_or("none")))?;
        check_authorization(envelope)?;
        commit()?;
        check_authorization(envelope)?;
        journal.state = JournalState::Acknowledged;
        let now = now_ms()?;
        journal.finished_utc = Some(now);
        journal.acknowledgement = Some(Acknowledgement {
            observed_config,
            observation_error,
            at_utc: now,
        });
        executor.persist(&journal)?;
        return Ok(OperationResult::RecoveryAcknowledged {
            ok: true,
            journal_id: key,
        });
    }
    if existing.is_some_and(|journal| !journal.state.resolved()) {
        return Err("An earlier native operation has an unresolved outcome; review it before this operation".into());
    }
    if executor.config(&envelope.before.name)? != envelope.before {
        return Err("Event channel configuration changed since preparation".into());
    }
    let explanation = match &envelope.operation {
        ResolvedOperation::Clear => format!("Clear event channel {}?\n\nWindows will save and clear it in one operation. A protected EVTX capture is retained. Cleared events cannot be put back into the active channel. No automatic retry or rollback is performed.", envelope.before.name),
        ResolvedOperation::SetEnabled { enabled } => format!("{} event channel {}?\n\nCurrent enabled state: {}\nRequested state: {}\nThe before-state and any uncertain outcome are retained. Review errors before attempting another operation.", if *enabled { "Enable" } else { "Disable" }, envelope.before.name, envelope.before.enabled()?, enabled),
        ResolvedOperation::Export => format!("Export event channel {}?\n\nA protected EVTX capture will be made and then copied to the destination selected in Purgeon's native save dialog. Existing destination files are never overwritten. Failed delivery retains the capture.", envelope.before.name),
        ResolvedOperation::AcknowledgeObserved { .. } => unreachable!(),
    };
    executor.confirm(&explanation)?;
    check_authorization(envelope)?;
    if executor.config(&envelope.before.name)? != envelope.before {
        return Err("Event channel changed during confirmation; prepare again".into());
    }
    commit()?;
    check_authorization(envelope)?;
    let mut journal = Journal {
        schema_version: 1,
        transaction_id: envelope.transaction_id.clone(),
        caller_sid: envelope.caller_sid.clone(),
        operation: envelope.operation.clone(),
        canonical_channel: envelope.before.name.clone(),
        before_config: envelope.before.clone(),
        backup_artifact_id: envelope.artifact_id.clone(),
        artifact: None,
        state: JournalState::Intent,
        error: None,
        created_utc: now_ms()?,
        finished_utc: None,
        acknowledgement: None,
        previous_archive_id: None,
    };
    executor.persist(&journal)?;
    let result = match &envelope.operation {
        ResolvedOperation::Clear | ResolvedOperation::Export => {
            let artifact = match executor.capture(envelope) {
                Ok(artifact) => artifact,
                Err(error) => return Err(persist_uncertain(executor, &mut journal, &error, false)),
            };
            journal.artifact = Some(artifact.clone());
            if executor.config(&envelope.before.name).as_ref() != Ok(&envelope.before) {
                return Err(persist_uncertain(
                    executor,
                    &mut journal,
                    "Event channel configuration changed or became unreadable after capture",
                    false,
                ));
            }
            if matches!(envelope.operation, ResolvedOperation::Export) {
                journal.state = JournalState::DeliveryPending;
                executor.persist(&journal)?;
                if let Err(error) = deliver(&artifact) {
                    return Err(persist_uncertain(
                        executor,
                        &mut journal,
                        &format!(
                            "Capture succeeded but delivery failed: {error}. EVTX retained at {}",
                            artifact.path
                        ),
                        true,
                    ));
                }
                OperationResult::Export {
                    ok: true,
                    path: String::new(),
                    journal_id: key,
                }
            } else {
                OperationResult::Clear {
                    ok: true,
                    backup: artifact.path,
                    journal_id: key,
                }
            }
        }
        ResolvedOperation::SetEnabled { enabled } => {
            if let Err(error) = executor.set_enabled(&envelope.before.name, *enabled) {
                return Err(persist_uncertain(executor, &mut journal, &error, false));
            }
            let mut expected = envelope.before.clone();
            expected.properties[0] = logs::Property::Boolean(*enabled);
            if executor.config(&envelope.before.name).as_ref() != Ok(&expected) {
                return Err(persist_uncertain(
                    executor,
                    &mut journal,
                    "Windows channel configuration does not match the requested enabled state",
                    false,
                ));
            }
            OperationResult::SetEnabled {
                ok: true,
                previous_enabled: envelope.before.enabled()?,
                journal_id: key,
            }
        }
        ResolvedOperation::AcknowledgeObserved { .. } => unreachable!(),
    };
    journal.state = JournalState::Verified;
    journal.finished_utc = Some(now_ms()?);
    executor.persist(&journal).map_err(|error| format!("Native completion journal could not be saved: {error}. The prior intent/capture remains unresolved; inspect it before retrying"))?;
    Ok(result)
}
pub(crate) fn helper(pipe_name: &str) -> Result<(), String> {
    if !broker::is_elevated()? {
        return Err("Native event helper is not elevated".into());
    }
    let (pid, nonce) = pipe_name
        .strip_prefix(PIPE_PREFIX)
        .ok_or("Invalid native operation pipe")?
        .split_once('-')
        .ok_or("Invalid native operation pipe")?;
    let pid = pid.parse::<u32>().map_err(|e| e.to_string())?;
    valid_id(nonce, 32)?;
    let pipe = broker::client_pipe(pipe_name, pid)?;
    let dispatch: Dispatch = broker::receive(pipe.0)?;
    if dispatch.digest != envelope_digest(&dispatch.envelope)?
        || dispatch.envelope.parent_pid != pid
        || dispatch.envelope.caller_sid != broker::process_sid(pid)?
    {
        return Err("Native event request authentication/binding mismatch".into());
    }
    check_authorization(&dispatch.envelope)?;
    let deadline = remaining(dispatch.envelope.execution_deadline_utc)?;
    let _lease = broker::domain_lease(&dispatch.envelope.caller_sid)?;
    let mut executor = NativeExecutor {
        pipe: pipe.0,
        digest: &dispatch.digest,
        deadline,
        parent_pid: pid,
    };
    let result = perform(
        &dispatch.envelope,
        &mut executor,
        || {
            broker::require_live_parent(pid)?;
            send_reply(pipe.0, &dispatch.digest, ServerMessage::Ready, deadline)?;
            match broker::receive_until::<ClientMessage>(pipe.0, deadline)? {
                ClientMessage::Commit {
                    digest,
                    approved: true,
                } if digest == dispatch.digest => broker::require_live_parent(pid),
                _ => Err("USER_CANCELLED: parent refused or mismatched native commit".into()),
            }
        },
        |artifact| {
            send_reply(
                pipe.0,
                &dispatch.digest,
                ServerMessage::Captured {
                    artifact: artifact.clone(),
                },
                deadline,
            )?;
            let mut previous = 0u64;
            loop {
                broker::require_live_parent(pid)?;
                match broker::receive_until::<ClientMessage>(pipe.0, deadline)? {
                    ClientMessage::DeliveryProgress { digest, bytes }
                        if digest == dispatch.digest
                            && bytes >= previous
                            && bytes <= artifact.bytes =>
                    {
                        previous = bytes
                    }
                    ClientMessage::DeliveryResult {
                        digest,
                        delivered: true,
                        error: None,
                    } if digest == dispatch.digest && previous == artifact.bytes => return Ok(()),
                    ClientMessage::DeliveryResult {
                        digest,
                        delivered: false,
                        error,
                    } if digest == dispatch.digest => {
                        return Err(error
                            .unwrap_or("Parent could not deliver the EVTX capture".into())
                            .chars()
                            .take(1024)
                            .collect())
                    }
                    _ => {
                        return Err(
                            "Native EVTX delivery acknowledgement binding/phase changed".into()
                        )
                    }
                }
                if Instant::now() >= deadline {
                    return Err("Native EVTX delivery deadline exceeded".into());
                }
            }
        },
    );
    let message = match result {
        Ok(result) => ServerMessage::Result {
            result: Some(result),
            error: None,
        },
        Err(error) => ServerMessage::Result {
            result: None,
            error: Some(error.chars().take(4096).collect()),
        },
    };
    send_reply(pipe.0, &dispatch.digest, message, deadline)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    fn config() -> ChannelConfig {
        let mut properties = vec![logs::Property::Null; 21];
        properties[0] = logs::Property::Boolean(true);
        ChannelConfig {
            name: "Purgeon-Fixture/Operational".into(),
            properties,
        }
    }
    fn envelope(operation: ResolvedOperation) -> Envelope {
        let now = now_ms().unwrap();
        Envelope {
            artifact_id: if matches!(
                operation,
                ResolvedOperation::Clear | ResolvedOperation::Export
            ) {
                Some("b".repeat(32))
            } else {
                None
            },
            operation,
            before: config(),
            caller_sid: "S-1-5-21-123".into(),
            session: "d".repeat(32),
            plan_id: "e".repeat(32),
            transaction_id: "a".repeat(32),
            authorization_expires_utc: now + 120000,
            execution_deadline_utc: now + 1800000,
            parent_pid: 1,
        }
    }
    fn artifact() -> ArtifactInfo {
        ArtifactInfo { id: "b".repeat(32), path: r"C:\ProgramData\Purgeon\Broker\EventLogs\S-1-5-21-123\payload\bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.evtx".into(), bytes: 4096, digest: "f".repeat(64) }
    }
    fn journal(state: JournalState) -> Journal {
        Journal {
            schema_version: 1,
            transaction_id: "a".repeat(32),
            caller_sid: "S-1-5-21-123".into(),
            operation: ResolvedOperation::Clear,
            canonical_channel: config().name.clone(),
            before_config: config(),
            backup_artifact_id: Some("b".repeat(32)),
            artifact: Some(artifact()),
            state,
            error: Some("original uncertain outcome".into()),
            created_utc: 1,
            finished_utc: None,
            acknowledgement: None,
            previous_archive_id: None,
        }
    }
    struct FakeExecutor {
        current: ChannelConfig,
        configs: VecDeque<Result<ChannelConfig, String>>,
        existing: Option<Journal>,
        records: Vec<Journal>,
        calls: Vec<String>,
        persist_count: usize,
        fail_persist: Option<usize>,
        deny_consent: bool,
        fail_capture: bool,
        fail_enable: bool,
        bad_artifact: bool,
    }
    impl Default for FakeExecutor {
        fn default() -> Self {
            Self {
                current: config(),
                configs: VecDeque::new(),
                existing: None,
                records: Vec::new(),
                calls: Vec::new(),
                persist_count: 0,
                fail_persist: None,
                deny_consent: false,
                fail_capture: false,
                fail_enable: false,
                bad_artifact: false,
            }
        }
    }
    impl EventExecutor for FakeExecutor {
        fn config(&mut self, _: &str) -> Result<ChannelConfig, String> {
            self.calls.push("config".into());
            self.configs
                .pop_front()
                .unwrap_or_else(|| Ok(self.current.clone()))
        }
        fn load(&mut self, _: &str, _: &str) -> Result<Option<Journal>, String> {
            self.calls.push("load".into());
            Ok(self.existing.clone())
        }
        fn persist(&mut self, journal: &Journal) -> Result<(), String> {
            self.calls.push(format!("persist:{:?}", journal.state));
            self.persist_count += 1;
            if self.fail_persist == Some(self.persist_count) {
                return Err("injected durable-write failure".into());
            }
            self.records.push(journal.clone());
            Ok(())
        }
        fn confirm(&mut self, _: &str) -> Result<(), String> {
            self.calls.push("consent".into());
            if self.deny_consent {
                Err("USER_CANCELLED".into())
            } else {
                Ok(())
            }
        }
        fn capture(&mut self, _: &Envelope) -> Result<ArtifactInfo, String> {
            self.calls.push("capture".into());
            if self.fail_capture {
                Err("injected Windows capture failure".into())
            } else {
                Ok(artifact())
            }
        }
        fn set_enabled(&mut self, _: &str, enabled: bool) -> Result<(), String> {
            self.calls.push("setEnabled".into());
            if self.fail_enable {
                return Err("injected Windows configuration failure".into());
            }
            self.current.properties[0] = logs::Property::Boolean(enabled);
            Ok(())
        }
        fn verify_artifact(&mut self, _: &str, _: &ArtifactInfo) -> Result<(), String> {
            self.calls.push("verifyArtifact".into());
            if self.bad_artifact {
                Err("capture integrity failure".into())
            } else {
                Ok(())
            }
        }
    }
    #[test]
    fn schemas_do_not_accept_renderer_paths_code_or_unknown_operations() {
        for value in [
            serde_json::json!({"kind":"eventLogClear","channelId":"a","script":"not allowed"}),
            serde_json::json!({"kind":"eventLogExport","channelId":"a","destinationGrant":"b","path":"C:\\Windows\\target"}),
            serde_json::json!({"kind":"shell","commandLine":"anything"}),
        ] {
            assert!(serde_json::from_value::<OperationRequest>(value).is_err());
        }
        assert!(serde_json::from_value::<SelectionKind>(serde_json::json!({"kind":"eventLogExportDestination","channelId":"a","path":"C:\\destination.evtx"})).is_err());
        assert!(serde_json::from_value::<QueryRequest>(
            serde_json::json!({"kind":"eventLogConfig","channelId":"a","name":"Security"})
        )
        .is_err());
        assert!(serde_json::from_value::<RecoveryRequest>(
            serde_json::json!({"journalId":"a","decision":"replay"})
        )
        .is_err());
    }
    #[test]
    fn channel_grants_are_session_caller_and_expiry_bound() {
        let mut state = Manager::new().unwrap();
        let id = "a".repeat(32);
        state.channels.insert(
            id.clone(),
            ChannelGrant {
                name: config().name,
                reviewed: Some(config()),
                sid: "sid-one".into(),
                session: state.session.clone(),
                created: Instant::now(),
            },
        );
        assert!(state.channel(&id, "sid-one").is_ok());
        assert!(state.channel(&id, "sid-two").is_err());
        state.channels.get_mut(&id).unwrap().created = Instant::now() - GRANT_TTL;
        assert!(state.channel(&id, "sid-one").is_err());
        state.prune();
        assert!(state.channels.is_empty());
    }
    #[test]
    fn lightweight_inventory_never_authorizes_a_mutation_before_fresh_full_capture() {
        let grant = ChannelGrant {
            name: config().name,
            sid: "sid".into(),
            session: "session".into(),
            created: Instant::now(),
            reviewed: None,
        };
        let called = std::cell::Cell::new(false);
        let before = fresh_before(&grant, |name| {
            assert_eq!(name, grant.name);
            called.set(true);
            Ok(config())
        })
        .unwrap();
        assert!(called.get());
        assert_eq!(before.properties.len(), 21);
        assert!(fresh_before(&grant, |_| Err("full configuration unavailable".into())).is_err());
        let mut incomplete = config();
        incomplete.properties.truncate(1);
        assert!(fresh_before(&grant, |_| Ok(incomplete)).is_err());
        let mut different = config();
        different.name = "Different/Channel".into();
        assert!(fresh_before(&grant, |_| Ok(different)).is_err());
        let reviewed = ChannelGrant {
            reviewed: Some(config()),
            ..grant
        };
        let mut changed = config();
        changed.properties[20] = logs::Property::Unsigned32(1);
        assert!(fresh_before(&reviewed, |_| Ok(changed)).is_err());
    }
    #[test]
    fn security_immutable_channels_and_expired_plans_never_reach_mutation() {
        for name in ["Security", "Application", "System"] {
            let mut request = envelope(ResolvedOperation::SetEnabled { enabled: false });
            request.before.name = name.into();
            let mut fake = FakeExecutor::default();
            assert!(perform(&request, &mut fake, || Ok(()), |_| Ok(())).is_err());
            assert!(fake.calls.is_empty());
        }
        let mut request = envelope(ResolvedOperation::Clear);
        request.authorization_expires_utc = 0;
        let mut fake = FakeExecutor::default();
        assert!(perform(&request, &mut fake, || Ok(()), |_| Ok(())).is_err());
        assert!(fake.calls.is_empty());
    }
    #[test]
    fn missing_intent_or_denied_consent_prevents_all_windows_mutations() {
        let request = envelope(ResolvedOperation::Clear);
        let mut fake = FakeExecutor {
            fail_persist: Some(1),
            ..FakeExecutor::default()
        };
        assert!(perform(&request, &mut fake, || Ok(()), |_| Ok(())).is_err());
        assert!(!fake.calls.iter().any(|call| call == "capture"));
        let mut fake = FakeExecutor {
            deny_consent: true,
            ..FakeExecutor::default()
        };
        assert!(perform(&request, &mut fake, || Ok(()), |_| Ok(()))
            .unwrap_err()
            .contains("USER_CANCELLED"));
        assert!(fake.records.is_empty());
        assert!(!fake.calls.iter().any(|call| call == "capture"));
    }
    #[test]
    fn stale_confirmation_and_parent_commit_refusal_preserve_external_state() {
        let request = envelope(ResolvedOperation::Clear);
        let mut changed = config();
        changed.properties[0] = logs::Property::Boolean(false);
        let mut fake = FakeExecutor {
            configs: VecDeque::from([Ok(config()), Ok(changed)]),
            ..FakeExecutor::default()
        };
        assert!(perform(&request, &mut fake, || Ok(()), |_| Ok(())).is_err());
        assert!(fake.records.is_empty());
        let mut fake = FakeExecutor::default();
        assert!(perform(
            &request,
            &mut fake,
            || Err("parent disconnected".into()),
            |_| Ok(())
        )
        .is_err());
        assert!(fake.records.is_empty());
    }
    #[test]
    fn clear_persists_intent_then_capture_then_verified_completion() {
        let mut fake = FakeExecutor::default();
        assert!(matches!(
            perform(
                &envelope(ResolvedOperation::Clear),
                &mut fake,
                || Ok(()),
                |_| panic!("clear must never run user delivery")
            ),
            Ok(OperationResult::Clear { ok: true, .. })
        ));
        let intent = fake
            .calls
            .iter()
            .position(|call| call == "persist:Intent")
            .unwrap();
        let capture = fake
            .calls
            .iter()
            .position(|call| call == "capture")
            .unwrap();
        assert!(intent < capture);
        assert!(matches!(
            fake.records.last().unwrap().state,
            JournalState::Verified
        ));
        assert_eq!(
            fake.records
                .last()
                .unwrap()
                .artifact
                .as_ref()
                .unwrap()
                .digest,
            artifact().digest
        );
    }
    #[test]
    fn windows_capture_failure_retains_uncertain_native_artifact_identity() {
        let mut fake = FakeExecutor {
            fail_capture: true,
            ..FakeExecutor::default()
        };
        assert!(perform(
            &envelope(ResolvedOperation::Clear),
            &mut fake,
            || Ok(()),
            |_| Ok(())
        )
        .is_err());
        let final_record = fake.records.last().unwrap();
        assert!(matches!(final_record.state, JournalState::Uncertain));
        assert_eq!(
            final_record.backup_artifact_id.as_deref(),
            Some("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
        );
        assert!(final_record.artifact.is_none());
    }
    #[test]
    fn exports_distinguish_capture_delivery_and_delivery_failure() {
        let request = envelope(ResolvedOperation::Export);
        let mut fake = FakeExecutor::default();
        let delivered = std::cell::Cell::new(false);
        assert!(matches!(
            perform(
                &request,
                &mut fake,
                || Ok(()),
                |_| {
                    delivered.set(true);
                    Ok(())
                }
            ),
            Ok(OperationResult::Export { ok: true, .. })
        ));
        assert!(delivered.get());
        assert!(matches!(
            fake.records[1].state,
            JournalState::DeliveryPending
        ));
        assert!(matches!(fake.records[2].state, JournalState::Verified));
        let mut fake = FakeExecutor::default();
        assert!(perform(
            &request,
            &mut fake,
            || Ok(()),
            |_| Err("destination disk full".into())
        )
        .is_err());
        let final_record = fake.records.last().unwrap();
        assert!(matches!(
            final_record.state,
            JournalState::UncertainDelivery
        ));
        assert!(final_record.artifact.is_some());
    }
    #[test]
    fn enabled_state_undo_uses_actual_before_state_and_verifies_completion() {
        let mut fake = FakeExecutor::default();
        assert!(matches!(
            perform(
                &envelope(ResolvedOperation::SetEnabled { enabled: false }),
                &mut fake,
                || Ok(()),
                |_| Ok(())
            ),
            Ok(OperationResult::SetEnabled {
                previous_enabled: true,
                ok: true,
                ..
            })
        ));
        assert!(matches!(
            fake.records.last().unwrap().state,
            JournalState::Verified
        ));
        let mut fake = FakeExecutor {
            fail_enable: true,
            ..FakeExecutor::default()
        };
        assert!(perform(
            &envelope(ResolvedOperation::SetEnabled { enabled: false }),
            &mut fake,
            || Ok(()),
            |_| Ok(())
        )
        .is_err());
        assert!(matches!(
            fake.records.last().unwrap().state,
            JournalState::Uncertain
        ));
    }
    #[test]
    fn unresolved_operations_block_replay_and_recovery_only_acknowledges() {
        let original = journal(JournalState::Uncertain);
        let mut fake = FakeExecutor {
            existing: Some(original.clone()),
            ..FakeExecutor::default()
        };
        assert!(perform(
            &envelope(ResolvedOperation::Clear),
            &mut fake,
            || Ok(()),
            |_| Ok(())
        )
        .is_err());
        assert_eq!(fake.calls, ["load"]);
        let mut fake = FakeExecutor {
            existing: Some(original.clone()),
            ..FakeExecutor::default()
        };
        let request = envelope(ResolvedOperation::AcknowledgeObserved {
            journal_id: channel_key(&config().name),
            expected_transaction: original.transaction_id.clone(),
        });
        assert!(matches!(
            perform(
                &request,
                &mut fake,
                || Ok(()),
                |_| panic!("acknowledgement never delivers")
            ),
            Ok(OperationResult::RecoveryAcknowledged { ok: true, .. })
        ));
        assert!(!fake
            .calls
            .iter()
            .any(|call| ["capture", "setEnabled"].contains(&call.as_str())));
        assert!(matches!(fake.records[0].state, JournalState::Acknowledged));
        assert_eq!(fake.records[0].error, original.error);
        assert_eq!(fake.records[0].artifact, original.artifact);
    }
    #[test]
    fn completion_persistence_failure_never_reports_success() {
        let mut fake = FakeExecutor {
            fail_persist: Some(2),
            ..FakeExecutor::default()
        };
        assert!(perform(
            &envelope(ResolvedOperation::Clear),
            &mut fake,
            || Ok(()),
            |_| Ok(())
        )
        .unwrap_err()
        .contains("completion journal"));
        assert!(matches!(
            fake.records.last().unwrap().state,
            JournalState::Intent
        ));
    }
    #[derive(Default)]
    struct MemoryStore {
        data: HashMap<String, Vec<u8>>,
        fail_archive: bool,
        corrupt_readback: bool,
    }
    impl JournalStore for MemoryStore {
        fn read(&mut self, key: &str) -> Result<Option<Vec<u8>>, String> {
            if self.corrupt_readback && key.starts_with("history-") && self.data.contains_key(key) {
                return Ok(Some(b"corrupt".to_vec()));
            }
            Ok(self.data.get(key).cloned())
        }
        fn write(&mut self, key: &str, bytes: &[u8]) -> Result<(), String> {
            if self.fail_archive && key.starts_with("history-") {
                return Err("archive disk failure".into());
            }
            self.data.insert(key.into(), bytes.to_vec());
            Ok(())
        }
    }
    #[test]
    fn archive_preserves_original_raw_uncertainty_across_acknowledgement_and_new_intent() {
        let original = journal(JournalState::Uncertain);
        let key = channel_key(&original.canonical_channel);
        let original_bytes = serde_json::to_vec_pretty(&original).unwrap();
        let mut store = MemoryStore::default();
        store.data.insert(key.clone(), original_bytes.clone());
        let mut acknowledged = original.clone();
        acknowledged.state = JournalState::Acknowledged;
        persist_record(&mut store, &acknowledged).unwrap();
        let archive = format!(
            "history-{}-{}",
            original.transaction_id,
            &hash(&original_bytes)[..32]
        );
        assert_eq!(store.data.get(&archive), Some(&original_bytes));
        let mut next = journal(JournalState::Intent);
        next.transaction_id = "c".repeat(32);
        persist_record(&mut store, &next).unwrap();
        assert_eq!(store.data.get(&archive), Some(&original_bytes));
        assert_eq!(
            store
                .data
                .keys()
                .filter(|key| key.starts_with("history-"))
                .count(),
            2
        );
        assert!(store.data.get(&key).unwrap() != &original_bytes);
    }
    #[test]
    fn archive_failure_collision_and_bad_readback_leave_active_evidence_byte_identical() {
        let original = journal(JournalState::Uncertain);
        let key = channel_key(&original.canonical_channel);
        let bytes = serde_json::to_vec_pretty(&original).unwrap();
        let mut next = original.clone();
        next.state = JournalState::Acknowledged;
        let mut store = MemoryStore {
            fail_archive: true,
            ..MemoryStore::default()
        };
        store.data.insert(key.clone(), bytes.clone());
        assert!(persist_record(&mut store, &next).is_err());
        assert_eq!(store.data.get(&key), Some(&bytes));
        let archive = format!(
            "history-{}-{}",
            original.transaction_id,
            &hash(&bytes)[..32]
        );
        store.fail_archive = false;
        store
            .data
            .insert(archive.clone(), b"conflicting evidence".to_vec());
        assert!(persist_record(&mut store, &next).is_err());
        assert_eq!(store.data.get(&key), Some(&bytes));
        store.data.remove(&archive);
        store.corrupt_readback = true;
        assert!(persist_record(&mut store, &next).is_err());
        assert_eq!(store.data.get(&key), Some(&bytes));
        store.corrupt_readback = false;
        store.data.insert(archive.clone(), bytes.clone());
        persist_record(&mut store, &next).unwrap();
        assert_eq!(store.data.get(&archive), Some(&bytes));
    }
    #[test]
    #[ignore = "read-only native Event Logs inventory probe, no capture or configuration mutation"]
    fn eventlog_inventory_read_only_probe() {
        let result = query(QueryRequest::Channels).expect("Native event-channel enumeration must report errors instead of silently returning an empty list");
        let QueryResult::Channels { channels } = result else {
            panic!("unexpected query result");
        };
        assert!(!channels.is_empty());
        assert!(channels.len() <= MAX_CHANNELS);
        let configured = channels
            .iter()
            .filter(|channel| channel.channel_id.is_some())
            .count();
        let metadata_unknown = channels
            .iter()
            .filter(|channel| channel.records.is_none())
            .count();
        println!("Read-only native event inventory: {} rows, {configured} configuration grants, {metadata_unknown} rows with unavailable count/size. No export, clear, enabled-state change, protected artifact or journal creation was requested.", channels.len());
        for channel in channels {
            if let Some(id) = channel.channel_id {
                valid_id(&id, 32).unwrap();
                assert!(channel.enabled.is_some());
            } else {
                assert!(channel.config_error.is_some());
            }
        }
    }
}
