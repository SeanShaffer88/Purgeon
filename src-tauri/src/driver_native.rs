//! Closed unused-driver removal and protected, stage-only recovery. No renderer
//! INF/path/tool flags become elevated authority. Uncertain intent is retained.
use crate::{
    broker, driver_inventory as inventory, protected_driver_package as package,
    state_store::{self, Authority, Domain},
};
use package::Manifest;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    os::windows::process::CommandExt,
    path::Path,
    process::Command,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
const TTL_MS: u64 = 120_000;
const STORE_SID: &str = "S-1-5-32-545";
const PIPE_PREFIX: &str = "\\\\.\\pipe\\Purgeon-Drivers-";
fn id(value: &str) -> bool {
    value.len() == 32 && value.bytes().all(|c| c.is_ascii_hexdigit())
}
fn now() -> Result<u64, String> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis() as u64)
}
fn deadline() -> Instant {
    Instant::now() + Duration::from_secs(40)
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Snapshot {
    row: inventory::Row,
    manifest: Manifest,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Selection {
    row: inventory::Row,
    fingerprint: String,
}
impl Selection {
    fn validate(&self) -> Result<(), String> {
        self.row.eligible()?;
        if self.fingerprint.len() != 64 || !self.fingerprint.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err("Invalid native driver content fingerprint".into());
        }
        Ok(())
    }
}
impl Snapshot {
    fn validate(&self) -> Result<(), String> {
        self.row.eligible()?;
        self.manifest.validate()?;
        let original = Path::new(&self.row.original)
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or("Invalid native original INF")?;
        if !self.manifest.inf.eq_ignore_ascii_case(original) {
            return Err("Driver manifest INF does not match native identity".into());
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Inventory {
    rows: Vec<inventory::Row>,
    snapshots: Vec<Selection>,
    errors: HashMap<String, String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriverView {
    #[serde(rename = "PublishedName")]
    published: String,
    #[serde(rename = "OriginalName")]
    original: String,
    #[serde(rename = "InfFile")]
    inf: String,
    #[serde(rename = "Date")]
    date: String,
    #[serde(rename = "Version")]
    version: String,
    #[serde(rename = "Provider")]
    provider: String,
    #[serde(rename = "DriverClass")]
    class_name: String,
    driver_id: Option<String>,
    eligible: bool,
    reason: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Request {
    Remove { driver_id: String },
    Recover { journal_id: String },
}
impl Request {
    fn validate(&self) -> Result<(), String> {
        if !id(match self {
            Self::Remove { driver_id } => driver_id,
            Self::Recover { journal_id } => journal_id,
        }) {
            return Err("Refresh the driver inventory or select a native recovery journal".into());
        }
        Ok(())
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Envelope {
    request: Request,
    snapshot: Snapshot,
    backup_id: String,
    backup_manifest: Option<Manifest>,
    plan_id: String,
    caller_sid: String,
    parent_pid: u32,
    deadline_utc_ms: u64,
}
struct Grant {
    snapshot: Selection,
    sid: String,
    created: Instant,
}
struct Pending {
    envelope: Envelope,
    created: Instant,
}
#[derive(Default)]
struct State {
    grants: HashMap<String, Grant>,
    plans: HashMap<String, Pending>,
}
static STATE: OnceLock<Mutex<State>> = OnceLock::new();
fn state() -> &'static Mutex<State> {
    STATE.get_or_init(|| Mutex::new(State::default()))
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
    staged_only: bool,
    detail: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Journal {
    version: u8,
    id: String,
    caller_sid: String,
    request: Request,
    snapshot: Snapshot,
    backup_id: String,
    backup_manifest: Manifest,
    completed: bool,
    recovered: bool,
}
impl Journal {
    fn validate(&self, key: &str) -> Result<(), String> {
        self.request.validate()?;
        self.snapshot.validate()?;
        self.backup_manifest.validate()?;
        if self.version != 1
            || self.id != key
            || !id(&self.id)
            || !id(&self.backup_id)
            || !self.caller_sid.starts_with("S-1-")
            || self.caller_sid.len() > 184
            || (self.recovered
                && (!self.completed || matches!(self.request, Request::Recover { .. })))
        {
            return Err("Invalid protected driver journal; retained for review".into());
        }
        if matches!(self.request, Request::Remove { .. }) && self.backup_id != self.id {
            return Err("Driver backup identity is not bound to removal".into());
        }
        normalized_backup(&self.snapshot.manifest, &self.backup_manifest)?;
        Ok(())
    }
}
fn normalized_backup(source: &Manifest, backup: &Manifest) -> Result<(), String> {
    if source == backup {
        return Ok(());
    }
    let (wrapper, rest) = backup
        .inf
        .split_once('/')
        .ok_or("Driver backup is not the exact source package")?;
    if rest != source.inf {
        return Err("Driver backup INF differs from original".into());
    }
    let mut expected = source.clone();
    for f in &mut expected.files {
        f.name = format!("{wrapper}/{}", f.name);
    }
    for d in &mut expected.directories {
        *d = format!("{wrapper}/{d}");
    }
    expected.directories.push(wrapper.into());
    expected.directories.sort();
    expected.inf = format!("{wrapper}/{}", source.inf);
    expected.catalog = format!("{wrapper}/{}", source.catalog);
    if expected != *backup {
        return Err("Driver backup member set or content differs from source".into());
    }
    Ok(())
}
pub fn query_recovery(journal_id: &str) -> Result<serde_json::Value, String> {
    if !id(journal_id) {
        return Err("Invalid native driver journal".into());
    }
    let mut executor = NativeExecutor::default();
    let journal = executor
        .read(journal_id)?
        .ok_or("Native driver recovery record missing")?;
    journal.validate(journal_id)?;
    if journal.caller_sid != broker::current_sid()? {
        return Err("Driver journal belongs to another caller".into());
    }
    Ok(
        serde_json::json!({"journalId":journal.id,"completed":journal.completed,"recovered":journal.recovered,"publishedName":journal.snapshot.row.published,"provider":journal.snapshot.row.provider,"version":journal.snapshot.row.version,"stagedOnly":true,"recoveryLimits":"Stages the verified package only. Does not reinstall devices, bind hardware or restart Windows. Uncertain records cannot be replayed."}),
    )
}
fn capture(
    row: &inventory::Row,
    guards: &inventory::Guards,
) -> Result<(Snapshot, package::Pinned), String> {
    row.eligible()?;
    let (root, inf, catalog) = inventory::location(row)?;
    let mut held = package::source(&root, &inf, &catalog, deadline())?;
    inventory::unused(row, &held.manifest, guards)?;
    held.trusted_catalog()?;
    let snapshot = Snapshot {
        row: row.clone(),
        manifest: held.manifest.clone(),
    };
    snapshot.validate()?;
    Ok((snapshot, held))
}
fn native_inventory() -> Result<Inventory, String> {
    let rows = inventory::rows()?;
    let guards = inventory::guards()?;
    let mut snapshots = Vec::new();
    let mut errors = HashMap::new();
    let until = deadline();
    let mut names = std::collections::HashSet::new();
    for row in &rows {
        if !names.insert(row.published.to_ascii_lowercase()) {
            return Err("Ambiguous native driver published identity".into());
        }
        if Instant::now() >= until {
            return Err("Driver inventory verification deadline expired".into());
        }
        match capture(row, &guards) {
            Ok((snapshot, _)) => match preflight_snapshot(&snapshot) {
                Ok(()) => snapshots.push(Selection {
                    row: snapshot.row.clone(),
                    fingerprint: snapshot.manifest.fingerprint()?,
                }),
                Err(error) => {
                    errors.insert(row.published.clone(), error);
                }
            },
            Err(error) => {
                errors.insert(row.published.clone(), error);
            }
        }
    }
    let result = Inventory {
        rows,
        snapshots,
        errors,
    };
    if serde_json::to_vec(&result)
        .map_err(|e| e.to_string())?
        .len()
        > 240 * 1024
    {
        return Err("Structured driver inventory exceeds the native response budget; no inventory or removal authority was issued".into());
    }
    Ok(result)
}
fn preflight_snapshot(snapshot: &Snapshot) -> Result<(), String> {
    let wrapper = "w".repeat(255);
    let mut backup = snapshot.manifest.clone();
    for f in &mut backup.files {
        f.name = format!("{wrapper}/{}", f.name);
    }
    for d in &mut backup.directories {
        *d = format!("{wrapper}/{d}");
    }
    backup.directories.push(wrapper.clone());
    backup.inf = format!("{wrapper}/{}", backup.inf);
    backup.catalog = format!("{wrapper}/{}", backup.catalog);
    let journal = Journal {
        version: 1,
        id: "a".repeat(32),
        caller_sid: format!("S-1-{}", "1".repeat(178)),
        request: Request::Remove {
            driver_id: "b".repeat(32),
        },
        snapshot: snapshot.clone(),
        backup_id: "a".repeat(32),
        backup_manifest: backup,
        completed: false,
        recovered: false,
    };
    if serde_json::to_vec(&journal)
        .map_err(|e| e.to_string())?
        .len()
        > 32768
    {
        return Err("Complete driver source/backup manifest exceeds the protected journal budget; package is not removable".into());
    }
    Ok(())
}
fn native_inspect(selection: &Selection) -> Result<Snapshot, String> {
    selection.validate()?;
    let rows = inventory::rows()?;
    let found: Vec<_> = rows
        .iter()
        .filter(|r| r.published.eq_ignore_ascii_case(&selection.row.published))
        .collect();
    if found.len() != 1 || *found[0] != selection.row {
        return Err("Driver identity changed or OEM name was reused".into());
    }
    let (snapshot, _) = capture(found[0], &inventory::guards()?)?;
    preflight_snapshot(&snapshot)?;
    if snapshot.manifest.fingerprint() != Ok(selection.fingerprint.clone()) {
        return Err("Driver content changed after inventory; refresh and review again".into());
    }
    Ok(snapshot)
}
fn inspect(selection: Selection) -> Result<Snapshot, String> {
    native_route(
        broker::is_elevated()?,
        || native_inspect(&selection),
        || match transport(HelperRequest::Inspect {
            selection: Box::new(selection.clone()),
            caller_sid: broker::current_sid()?,
            parent_pid: std::process::id(),
            deadline_utc_ms: now()?.saturating_add(TTL_MS),
        })? {
            Message::Inspection {
                snapshot: Some(value),
                error: None,
            } => {
                value.validate()?;
                if value.row != selection.row
                    || value.manifest.fingerprint() != Ok(selection.fingerprint.clone())
                {
                    return Err("Driver inspection reply does not match native grant".into());
                }
                Ok(value)
            }
            Message::Inspection { error, .. } => {
                Err(error.unwrap_or("Driver native inspection unavailable".into()))
            }
            _ => Err("Unexpected driver inspection helper phase".into()),
        },
    )
}
fn native_route<T>(
    elevated: bool,
    local: impl FnOnce() -> Result<T, String>,
    helper: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    if elevated {
        local()
    } else {
        helper()
    }
}
fn read_inventory() -> Result<Inventory, String> {
    native_route(
        broker::is_elevated()?,
        native_inventory,
        || match transport(HelperRequest::Inventory {
            caller_sid: broker::current_sid()?,
            parent_pid: std::process::id(),
            deadline_utc_ms: now()?.saturating_add(TTL_MS),
        })? {
            Message::Inventory {
                inventory: Some(value),
                error: None,
            } => Ok(value),
            Message::Inventory { error, .. } => {
                Err(error.unwrap_or("Native driver inventory unavailable".into()))
            }
            _ => Err("Unexpected driver inventory helper phase".into()),
        },
    )
}
pub fn list() -> Result<Vec<DriverView>, String> {
    let inventory = read_inventory()?;
    if inventory.rows.len() > 8192 || inventory.snapshots.len() > 8192 {
        return Err("Driver inventory exceeds bounds".into());
    }
    let caller = broker::current_sid()?;
    let mut state = state().lock().map_err(|e| e.to_string())?;
    state
        .grants
        .retain(|_, g| g.created.elapsed() < Duration::from_secs(300));
    if state.grants.len() + inventory.snapshots.len() > 8192 {
        return Err("Driver grant budget exceeded; restart and refresh inventory".into());
    }
    let mut output = Vec::new();
    for row in inventory.rows {
        row.validate()?;
        let snapshot = inventory.snapshots.iter().find(|s| s.row == row);
        let driver_id = if let Some(snapshot) = snapshot {
            snapshot.validate()?;
            let grant = broker::random_id()?;
            state.grants.insert(
                grant.clone(),
                Grant {
                    snapshot: snapshot.clone(),
                    sid: caller.clone(),
                    created: Instant::now(),
                },
            );
            Some(grant)
        } else {
            None
        };
        output.push(DriverView {
            published: row.published.clone(),
            original: Path::new(&row.original)
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .into(),
            inf: Path::new(&row.original)
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .into(),
            date: row.date,
            version: row.version,
            provider: row.provider,
            class_name: row.class_name,
            eligible: driver_id.is_some(),
            driver_id,
            reason: inventory.errors.get(&row.published).cloned(),
        });
    }
    Ok(output)
}
fn validate_envelope(e: &Envelope) -> Result<(), String> {
    e.request.validate()?;
    e.snapshot.validate()?;
    let time = now()?;
    if !id(&e.plan_id)
        || !id(&e.backup_id)
        || !e.caller_sid.starts_with("S-1-")
        || e.parent_pid == 0
        || e.deadline_utc_ms < time
        || e.deadline_utc_ms > time.saturating_add(TTL_MS)
    {
        return Err("Driver plan expired or caller identity invalid".into());
    }
    match &e.request {
        Request::Remove { .. } if e.backup_id != e.plan_id || e.backup_manifest.is_some() => {
            Err("Driver removal backup binding invalid".into())
        }
        Request::Recover { .. } => normalized_backup(
            &e.snapshot.manifest,
            e.backup_manifest
                .as_ref()
                .ok_or("Driver recovery backup manifest missing")?,
        ),
        _ => Ok(()),
    }
}
fn summary(e: &Envelope) -> String {
    format!("{} driver package {}\nProvider: {}\nVersion/date: {} / {}\nClass: {} ({})\nNative catalog: {}\nSource manifest SHA256: {}\nNative protected backup: {}\n{}",if matches!(e.request,Request::Remove{..}){"Remove unused"}else{"Stage recovery of"},e.snapshot.row.published,e.snapshot.row.provider,e.snapshot.row.version,e.snapshot.row.date,e.snapshot.row.class_name,e.snapshot.row.class_guid,e.snapshot.row.catalog,e.snapshot.manifest.fingerprint().unwrap_or_default(),e.backup_id,if matches!(e.request,Request::Remove{..}){"A complete verified package backup is required before plain removal. No force, device uninstall or restart is requested. Recovery stages the package only."}else{"Stages only the exact native-retained package; no device install/binding or restart. An existing reused OEM name is never removed."})
}
pub fn prepare(request: Request) -> Result<PlanView, String> {
    request.validate()?;
    let sid = broker::current_sid()?;
    let mut executor = NativeExecutor::default();
    available(&mut executor)?;
    let (snapshot, backup_id, backup_manifest) = match &request {
        Request::Remove { driver_id } => {
            let state = state().lock().map_err(|e| e.to_string())?;
            let grant = state
                .grants
                .get(driver_id)
                .ok_or("Driver grant is missing; refresh inventory")?;
            if grant.sid != sid || grant.created.elapsed() >= Duration::from_secs(300) {
                return Err("Driver grant expired or belongs to another caller".into());
            }
            let selection = grant.snapshot.clone();
            drop(state);
            (inspect(selection)?, None, None)
        }
        Request::Recover { journal_id } => {
            let journal = owned_removal(&mut executor, journal_id, &sid)?;
            executor.verify_backup(&journal.backup_id, &journal.backup_manifest)?;
            (
                journal.snapshot,
                Some(journal.backup_id),
                Some(journal.backup_manifest),
            )
        }
    };
    preflight_snapshot(&snapshot)?;
    let plan_id = broker::reserve_plan()?;
    let envelope = Envelope {
        request,
        snapshot,
        backup_id: backup_id.unwrap_or_else(|| plan_id.clone()),
        backup_manifest,
        plan_id: plan_id.clone(),
        caller_sid: sid,
        parent_pid: std::process::id(),
        deadline_utc_ms: now()?.saturating_add(TTL_MS),
    };
    let view = PlanView {
        id: plan_id.clone(),
        summary: summary(&envelope),
        requires_elevation: !broker::is_elevated()?,
    };
    let mut state = state().lock().map_err(|e| e.to_string())?;
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
trait Executor {
    fn authorize(&mut self) -> Result<(), String>;
    fn read(&mut self, id: &str) -> Result<Option<Journal>, String>;
    fn save(&mut self, id: &str, journal: &Journal) -> Result<(), String>;
    fn check(&mut self, snapshot: &Snapshot) -> Result<(), String>;
    fn confirm(&mut self, envelope: &Envelope) -> Result<(), String>;
    fn backup(&mut self, snapshot: &Snapshot, id: &str) -> Result<Manifest, String>;
    fn verify_backup(&mut self, id: &str, manifest: &Manifest) -> Result<(), String>;
    fn remove(&mut self, snapshot: &Snapshot) -> Result<i32, String>;
    fn absent(&mut self, snapshot: &Snapshot) -> Result<bool, String>;
    fn equivalent(&mut self, snapshot: &Snapshot) -> Result<bool, String>;
    fn stage(&mut self, id: &str, manifest: &Manifest) -> Result<i32, String>;
}
fn available(executor: &mut impl Executor) -> Result<(), String> {
    if let Some(head) = executor.read("head")? {
        head.validate(&head.id)?;
        if !head.completed {
            return Err(format!("An earlier driver operation is uncertain; native journal {} is retained and all driver changes are blocked",head.id));
        }
    }
    Ok(())
}
fn owned_removal(executor: &mut impl Executor, id: &str, sid: &str) -> Result<Journal, String> {
    let journal = executor
        .read(id)?
        .ok_or("Protected driver recovery record missing")?;
    journal.validate(id)?;
    if journal.caller_sid != sid
        || !journal.completed
        || journal.recovered
        || !matches!(journal.request, Request::Remove { .. })
    {
        return Err("Driver recovery record is unowned, uncertain or already consumed".into());
    }
    Ok(journal)
}
fn perform(
    e: &Envelope,
    executor: &mut impl Executor,
    commit: impl FnOnce() -> Result<(), String>,
) -> Result<ResultView, String> {
    validate_envelope(e)?;
    available(executor)?;
    if executor.read(&e.plan_id)?.is_some() {
        return Err("Driver plan was already used".into());
    }
    let recovering = matches!(e.request, Request::Recover { .. });
    if let Request::Recover { journal_id } = &e.request {
        let source = owned_removal(executor, journal_id, &e.caller_sid)?;
        if source.snapshot != e.snapshot
            || source.backup_id != e.backup_id
            || Some(&source.backup_manifest) != e.backup_manifest.as_ref()
        {
            return Err("Driver recovery plan binding changed".into());
        }
        executor.verify_backup(&e.backup_id, &source.backup_manifest)?;
    } else {
        executor.check(&e.snapshot)?;
    }
    executor.confirm(e)?;
    validate_envelope(e)?;
    if !recovering {
        executor.check(&e.snapshot)?;
    }
    validate_envelope(e)?;
    let manifest = if recovering {
        e.backup_manifest
            .clone()
            .ok_or("Missing driver recovery manifest")?
    } else {
        executor.backup(&e.snapshot, &e.backup_id)?
    };
    normalized_backup(&e.snapshot.manifest, &manifest)?;
    executor.verify_backup(&e.backup_id, &manifest)?;
    if !recovering {
        executor.check(&e.snapshot)?;
    }
    validate_envelope(e)?;
    commit()?;
    validate_envelope(e)?;
    let mut journal = Journal {
        version: 1,
        id: e.plan_id.clone(),
        caller_sid: e.caller_sid.clone(),
        request: e.request.clone(),
        snapshot: e.snapshot.clone(),
        backup_id: e.backup_id.clone(),
        backup_manifest: manifest.clone(),
        completed: false,
        recovered: false,
    };
    journal.validate(&journal.id)?;
    executor.save(&journal.id, &journal)?;
    executor.save("head", &journal)?;
    let result = (|| -> Result<(), String> {
        executor.authorize()?;
        if recovering {
            if !executor.equivalent(&e.snapshot)? {
                executor.verify_backup(&e.backup_id, &manifest)?;
                let code = executor.stage(&e.backup_id, &manifest)?;
                if code != 0 {
                    return Err(format!(
                        "Driver staging returned {code}; no automatic retry"
                    ));
                }
            }
            if !executor.equivalent(&e.snapshot)? {
                return Err("Driver staging could not be verified by exact package content".into());
            }
            if let Request::Recover { journal_id } = &e.request {
                let mut source = owned_removal(executor, journal_id, &e.caller_sid)?;
                source.recovered = true;
                executor.save(journal_id, &source)?;
            }
        } else {
            let code = executor.remove(&e.snapshot)?;
            if code != 0 {
                return Err(format!(
                    "Driver removal returned {code}; restart or completion is not assumed"
                ));
            }
            if !executor.absent(&e.snapshot)? {
                return Err("Driver package absence could not be verified".into());
            }
        }
        executor.authorize()?;
        journal.completed = true;
        executor.save(&journal.id, &journal)?;
        executor.save("head", &journal)?;
        Ok(())
    })();
    result.map_err(|error|format!("Driver operation failed or is uncertain. Native backup {} and journal {} are retained; further driver changes are blocked: {error}",e.backup_id,e.plan_id))?;
    Ok(ResultView{ok:true,journal_id:e.plan_id.clone(),staged_only:recovering,detail:if recovering{"Verified package staged only; device installation, binding and restart were not requested."}else{"Unused driver package removed after complete verified native backup."}.into()})
}

type NativeAuthority = (u64, u32, Option<(broker::Handle, String)>);
#[derive(Default)]
struct NativeExecutor {
    backup: Option<(package::Backup, package::Pinned)>,
    authority: Option<NativeAuthority>,
}
impl NativeExecutor {
    fn remaining(&self) -> Result<Duration, String> {
        let (until, _, _) = self
            .authority
            .as_ref()
            .ok_or("No native driver command authority")?;
        let millis = until.saturating_sub(now()?);
        if millis == 0 {
            return Err("Driver command deadline expired".into());
        }
        Ok(Duration::from_millis(millis.min(40_000)))
    }
}
fn journal_hash() -> String {
    Sha256::digest(b"Purgeon unused driver journal v1")
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
fn pnputil(args: &[&std::ffi::OsStr], timeout: Duration) -> Result<i32, String> {
    let mut command = Command::new(crate::windows_tools::system_file("pnputil.exe")?);
    command.args(args).creation_flags(0x0800_0000);
    let output = crate::process_io::execute(&mut command, None, timeout)?;
    output
        .status
        .code()
        .ok_or("Driver tool exited without a completion code".into())
}
fn same_package(a: &inventory::Row, b: &inventory::Row) -> bool {
    Path::new(&a.original).file_name() == Path::new(&b.original).file_name()
        && Path::new(&a.catalog).file_name() == Path::new(&b.catalog).file_name()
        && a.provider == b.provider
        && a.version == b.version
        && a.date == b.date
        && a.class_guid == b.class_guid
        && a.class_name == b.class_name
        && a.signature == b.signature
        && a.inbox == b.inbox
        && a.boot_critical == b.boot_critical
}
impl Executor for NativeExecutor {
    fn authorize(&mut self) -> Result<(), String> {
        let (until, pid, channel) = self
            .authority
            .as_ref()
            .ok_or("No native driver mutation authority")?;
        if now()? >= *until {
            return Err(
                "Driver operation deadline expired; no further tool launch is allowed".into(),
            );
        }
        broker::require_live_parent(*pid)?;
        if let Some((pipe, digest)) = channel {
            broker::require_connected(*pipe)?;
            reply(*pipe, digest, Message::Progress)?;
        }
        Ok(())
    }
    fn read(&mut self, id: &str) -> Result<Option<Journal>, String> {
        if id != "head" && !crate::driver_native::id(id) {
            return Err("Invalid native driver journal key".into());
        }
        state_store::read(
            Domain::Drivers,
            Authority::Machine,
            STORE_SID,
            &journal_hash(),
            id,
        )?
        .map(|bytes| {
            let journal: Journal = serde_json::from_slice(&bytes)
                .map_err(|e| format!("Driver journal unreadable; retained: {e}"))?;
            journal.validate(if id == "head" { &journal.id } else { id })?;
            Ok(journal)
        })
        .transpose()
    }
    fn save(&mut self, id: &str, journal: &Journal) -> Result<(), String> {
        journal.validate(&journal.id)?;
        state_store::write(
            Domain::Drivers,
            Authority::Machine,
            STORE_SID,
            &journal_hash(),
            id,
            &serde_json::to_vec(journal).map_err(|e| e.to_string())?,
        )
    }
    fn check(&mut self, snapshot: &Snapshot) -> Result<(), String> {
        let rows = inventory::rows()?;
        let matching: Vec<_> = rows
            .iter()
            .filter(|r| r.published.eq_ignore_ascii_case(&snapshot.row.published))
            .collect();
        if matching.len() != 1 || *matching[0] != snapshot.row {
            return Err("Driver published identity is stale, ambiguous or reused".into());
        }
        let (fresh, mut held) = capture(matching[0], &inventory::guards()?)?;
        if fresh != *snapshot {
            return Err("Driver package content changed; refresh and review".into());
        }
        if self.authority.is_some() {
            self.authorize()?;
        }
        held.verify(deadline())?;
        if self.authority.is_some() {
            self.authorize()?;
        }
        Ok(())
    }
    fn confirm(&mut self, envelope: &Envelope) -> Result<(), String> {
        broker::confirm_native(&summary(envelope))
    }
    fn backup(&mut self, snapshot: &Snapshot, id: &str) -> Result<Manifest, String> {
        self.check(snapshot)?;
        let backup = package::Backup::reserve(id)?;
        self.authorize()?;
        let code = pnputil(
            &[
                std::ffi::OsStr::new("/export-driver"),
                std::ffi::OsStr::new(&snapshot.row.published),
                backup.path().as_os_str(),
            ],
            self.remaining()?,
        )?;
        if code != 0 {
            return Err(format!(
                "Driver export failed ({code}); retained at {}. No driver removal was attempted",
                backup.path().display()
            ));
        }
        self.authorize()?;
        let pinned = backup.verify(&snapshot.manifest, true, deadline())?;
        let manifest = pinned.manifest.clone();
        self.backup = Some((backup, pinned));
        self.authorize()?;
        Ok(manifest)
    }
    fn verify_backup(&mut self, id: &str, manifest: &Manifest) -> Result<(), String> {
        // Reopen while existing pins remain held. Rechecks ACLs, exact set,
        // bytes and native catalog trust immediately before authority is used.
        let backup = package::Backup::open(id)?;
        let mut pinned = backup.verify(manifest, false, deadline())?;
        if self.authority.is_some() {
            self.authorize()?;
        }
        pinned.verify(deadline())?;
        self.backup = Some((backup, pinned));
        if self.authority.is_some() {
            self.authorize()?;
        }
        Ok(())
    }
    fn remove(&mut self, snapshot: &Snapshot) -> Result<i32, String> {
        // The final fresh package snapshot is held until immediately before the
        // OS delete tool; keeping its file handles would prevent OS deletion.
        self.check(snapshot)?;
        self.authorize()?;
        pnputil(
            &[
                std::ffi::OsStr::new("/delete-driver"),
                std::ffi::OsStr::new(&snapshot.row.published),
            ],
            self.remaining()?,
        )
    }
    fn absent(&mut self, snapshot: &Snapshot) -> Result<bool, String> {
        Ok(!inventory::rows()?
            .iter()
            .any(|row| row.published.eq_ignore_ascii_case(&snapshot.row.published)))
    }
    fn equivalent(&mut self, snapshot: &Snapshot) -> Result<bool, String> {
        for row in inventory::rows()?
            .iter()
            .filter(|row| same_package(row, &snapshot.row))
        {
            let (root, inf, catalog) = inventory::location(row)?;
            let mut held = package::source(&root, &inf, &catalog, deadline())?;
            held.trusted_catalog()?;
            if held.manifest == snapshot.manifest {
                return Ok(true);
            }
        }
        Ok(false)
    }
    fn stage(&mut self, id: &str, manifest: &Manifest) -> Result<i32, String> {
        self.verify_backup(id, manifest)?;
        let (_, held) = self
            .backup
            .as_ref()
            .ok_or("Verified driver recovery package is missing")?;
        let inf = held.inf_path()?;
        self.authorize()?;
        pnputil(
            &[std::ffi::OsStr::new("/add-driver"), inf.as_os_str()],
            self.remaining()?,
        )
    }
}
pub fn execute(id: &str) -> Result<ResultView, String> {
    broker::consume_plan(id)?;
    let pending = state()
        .lock()
        .map_err(|e| e.to_string())?
        .plans
        .remove(id)
        .ok_or("Driver plan is missing or already consumed")?;
    if pending.created.elapsed() >= Duration::from_millis(TTL_MS)
        || broker::current_sid()? != pending.envelope.caller_sid
    {
        return Err("Driver plan expired or caller changed".into());
    }
    if broker::is_elevated()? {
        return execute_native(&pending.envelope, None, || Ok(()));
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
            Err(error.unwrap_or("Driver helper returned no result".into()))
        }
        _ => Err("Unexpected driver helper phase".into()),
    }
}
fn execute_native(
    envelope: &Envelope,
    channel: Option<(broker::Handle, String)>,
    commit: impl FnOnce() -> Result<(), String>,
) -> Result<ResultView, String> {
    if !broker::is_elevated()? {
        return Err("Driver mutation requires the native administrator helper".into());
    }
    let _lease = broker::domain_lease(&envelope.caller_sid)?;
    let mut executor = NativeExecutor {
        backup: None,
        authority: Some((envelope.deadline_utc_ms, envelope.parent_pid, channel)),
    };
    perform(envelope, &mut executor, || {
        broker::require_live_parent(envelope.parent_pid)?;
        commit()?;
        broker::require_live_parent(envelope.parent_pid)
    })
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "phase", rename_all = "camelCase", deny_unknown_fields)]
enum Message {
    Ready,
    Progress,
    Inspection {
        snapshot: Option<Snapshot>,
        error: Option<String>,
    },
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
    Inspect {
        selection: Box<Selection>,
        caller_sid: String,
        parent_pid: u32,
        deadline_utc_ms: u64,
    },
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
fn receive_reply(pipe: broker::Handle, expected: &str, until: Instant) -> Result<Message, String> {
    loop {
        let reply: Reply = broker::receive_until(pipe, until)?;
        if reply.digest != expected {
            return Err("Driver helper reply binding mismatch".into());
        }
        if matches!(reply.message, Message::Progress) {
            if Instant::now() >= until {
                return Err("Driver helper operation deadline expired".into());
            }
            continue;
        }
        return Ok(reply.message);
    }
}
fn transport(request: HelperRequest) -> Result<Message, String> {
    let deadline_ms = match &request {
        HelperRequest::Inventory {
            deadline_utc_ms, ..
        }
        | HelperRequest::Inspect {
            deadline_utc_ms, ..
        } => *deadline_utc_ms,
        HelperRequest::Change { envelope } => envelope.deadline_utc_ms,
    };
    let until = Instant::now() + Duration::from_millis(deadline_ms.saturating_sub(now()?));
    let hash = digest(&request)?;
    let changing = matches!(request, HelperRequest::Change { .. });
    let name = format!(
        "{PIPE_PREFIX}{}-{}",
        std::process::id(),
        broker::random_id()?
    );
    let pipe = broker::server_pipe(&name)?;
    let helper = broker::launch_domain_helper(broker::HelperKind::Drivers, &name)?;
    broker::accept_pipe(pipe.0)?;
    broker::authenticate_client(pipe.0, helper.0)?;
    broker::send(
        pipe.0,
        &Dispatch {
            request,
            digest: hash.clone(),
        },
    )?;
    match receive_reply(pipe.0, &hash, until)? {
        Message::Ready if changing => {
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
        Message::Ready => Err("Read-only driver helper attempted mutation handshake".into()),
        response => Ok(response),
    }
}
pub(crate) fn helper(name: &str) -> Result<(), String> {
    if !broker::is_elevated()? {
        return Err("Driver helper is not elevated".into());
    }
    let (pid, nonce) = name
        .strip_prefix(PIPE_PREFIX)
        .ok_or("Invalid driver pipe")?
        .split_once('-')
        .ok_or("Invalid driver pipe")?;
    let pid = pid.parse::<u32>().map_err(|e| e.to_string())?;
    if !id(nonce) {
        return Err("Invalid driver pipe nonce".into());
    }
    let pipe = broker::client_pipe(name, pid)?;
    let dispatch: Dispatch = broker::receive(pipe.0)?;
    if digest(&dispatch.request)? != dispatch.digest {
        return Err("Driver helper binding mismatch".into());
    }
    let (parent, sid, until) = match &dispatch.request {
        HelperRequest::Inventory {
            caller_sid,
            parent_pid,
            deadline_utc_ms,
        }
        | HelperRequest::Inspect {
            parent_pid,
            caller_sid,
            deadline_utc_ms,
            ..
        } => (*parent_pid, caller_sid, *deadline_utc_ms),
        HelperRequest::Change { envelope } => (
            envelope.parent_pid,
            &envelope.caller_sid,
            envelope.deadline_utc_ms,
        ),
    };
    let time = now()?;
    if parent != pid
        || *sid != broker::process_sid(pid)?
        || until < time
        || until > time.saturating_add(TTL_MS)
    {
        return Err("Driver caller authentication or deadline mismatch".into());
    }
    broker::require_live_parent(pid)?;
    let message = match dispatch.request {
        HelperRequest::Inspect { selection, .. } => match native_inspect(&selection) {
            Ok(snapshot) => Message::Inspection {
                snapshot: Some(snapshot),
                error: None,
            },
            Err(error) => Message::Inspection {
                snapshot: None,
                error: Some(error),
            },
        },
        HelperRequest::Inventory { .. } => match native_inventory() {
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
            let result = execute_native(&envelope, Some((pipe.0, dispatch.digest.clone())), || {
                reply(pipe.0, &dispatch.digest, Message::Ready)?;
                let commit: Commit = broker::receive(pipe.0)?;
                if !commit.approved || commit.digest != dispatch.digest {
                    return Err("Parent refused driver commit or binding changed".into());
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
    reply(pipe.0, &dispatch.digest, message)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn as_invoker_inspection_uses_only_the_closed_helper_and_privilege_failure_never_falls_back() {
        assert_eq!(
            native_route(
                false,
                || panic!("local DISM must not run as invoker"),
                || Ok(42)
            )
            .unwrap(),
            42
        );
        let result: Result<(), String> = native_route(
            false,
            || panic!("no shell fallback"),
            || Err("USER_CANCELLED: native UAC denied".into()),
        );
        assert!(result.unwrap_err().contains("UAC denied"));
        assert_eq!(
            native_route(true, || Ok(7), || panic!("no unnecessary helper")).unwrap(),
            7
        );
    }
    fn snapshot() -> Snapshot {
        Snapshot {
            row: inventory::Row {
                published: "oem12.inf".into(),
                original: r"C:\Windows\System32\DriverStore\FileRepository\fixture\fixture.inf"
                    .into(),
                catalog: "fixture.cat".into(),
                provider: "Fixture Corp".into(),
                class_name: "Fixture".into(),
                class_guid: "{11111111-2222-3333-4444-555555555555}".into(),
                date: "2026-01-02".into(),
                version: "1.2.3.4".into(),
                signature: 0,
                inbox: false,
                boot_critical: false,
            },
            manifest: Manifest {
                files: vec![
                    package::Member {
                        name: "fixture.cat".into(),
                        bytes: 4,
                        digest: "1".repeat(64),
                    },
                    package::Member {
                        name: "fixture.inf".into(),
                        bytes: 5,
                        digest: "2".repeat(64),
                    },
                    package::Member {
                        name: "nested/driver.sys".into(),
                        bytes: 8,
                        digest: "3".repeat(64),
                    },
                ],
                directories: vec!["nested".into()],
                inf: "fixture.inf".into(),
                catalog: "fixture.cat".into(),
            },
        }
    }
    fn plan() -> Envelope {
        Envelope {
            request: Request::Remove {
                driver_id: "d".repeat(32),
            },
            snapshot: snapshot(),
            backup_id: "a".repeat(32),
            backup_manifest: None,
            plan_id: "a".repeat(32),
            caller_sid: "S-1-5-21-1".into(),
            parent_pid: 1,
            deadline_utc_ms: now().unwrap() + TTL_MS,
        }
    }
    #[derive(Default)]
    struct Fake {
        journals: HashMap<String, Journal>,
        trace: Vec<String>,
        mode: &'static str,
        checks: usize,
        writes: usize,
        removed: bool,
        staged: bool,
        late: bool,
    }
    impl Executor for Fake {
        fn authorize(&mut self) -> Result<(), String> {
            self.trace.push("authorize".into());
            if self.late {
                Err("parent closed or absolute deadline expired".into())
            } else {
                Ok(())
            }
        }
        fn read(&mut self, id: &str) -> Result<Option<Journal>, String> {
            Ok(self.journals.get(id).cloned())
        }
        fn save(&mut self, id: &str, journal: &Journal) -> Result<(), String> {
            self.trace
                .push(format!("journal:{id}:{}", journal.completed));
            if (self.mode == "intent" && !journal.completed)
                || (self.mode == "complete" && journal.completed)
                || (self.mode == "head-complete" && id == "head" && journal.completed)
            {
                return Err("durable journal unavailable".into());
            }
            self.journals.insert(id.into(), journal.clone());
            Ok(())
        }
        fn check(&mut self, _: &Snapshot) -> Result<(), String> {
            self.checks += 1;
            self.trace.push("check-unused-identity-content".into());
            if (self.mode == "stale" && self.checks == 1)
                || (self.mode == "after-consent" && self.checks == 2)
                || (self.mode == "predelete" && self.checks >= 3)
            {
                Err("OEM identity, content or active-use guard changed".into())
            } else {
                Ok(())
            }
        }
        fn confirm(&mut self, _: &Envelope) -> Result<(), String> {
            self.trace.push("consent".into());
            if self.mode == "cancel" {
                Err("USER_CANCELLED".into())
            } else {
                Ok(())
            }
        }
        fn backup(&mut self, snapshot: &Snapshot, _: &str) -> Result<Manifest, String> {
            self.trace.push("export".into());
            if self.mode == "export" {
                return Err("export failed".into());
            }
            let mut result = snapshot.manifest.clone();
            if self.mode == "missing-catalog" {
                result.files.remove(0);
            }
            if self.mode == "extra" {
                result.files.push(package::Member {
                    name: "extra".into(),
                    bytes: 1,
                    digest: "0".repeat(64),
                });
            }
            if self.mode == "corrupt" {
                result.files[0].digest = "0".repeat(64);
            }
            Ok(result)
        }
        fn verify_backup(&mut self, _: &str, manifest: &Manifest) -> Result<(), String> {
            self.trace.push("verify-backup".into());
            manifest.validate()?;
            if self.mode == "backup-tamper" {
                Err("backup ACL, identity or content changed".into())
            } else {
                Ok(())
            }
        }
        fn remove(&mut self, _: &Snapshot) -> Result<i32, String> {
            self.trace.push("final-source-check".into());
            if self.mode == "late" {
                self.late = true;
            }
            self.authorize()?;
            self.trace.push("plain-delete".into());
            self.writes += 1;
            self.removed = true;
            if self.mode == "timeout" {
                return Err("tool timeout".into());
            }
            if self.mode == "after-delete" {
                return Err("failure after delete".into());
            }
            Ok(if self.mode == "3010" { 3010 } else { 0 })
        }
        fn absent(&mut self, _: &Snapshot) -> Result<bool, String> {
            self.trace.push("verify-absence".into());
            if self.mode == "readback" {
                return Err("inventory unknown".into());
            }
            Ok(self.mode != "still-present" && self.removed)
        }
        fn equivalent(&mut self, _: &Snapshot) -> Result<bool, String> {
            self.trace.push("verify-staged-content".into());
            if self.mode == "stage-readback" {
                return Ok(false);
            }
            Ok(self.staged || self.mode == "already-staged")
        }
        fn stage(&mut self, _: &str, _: &Manifest) -> Result<i32, String> {
            self.trace.push("final-backup-check".into());
            if self.mode == "late-stage" {
                self.late = true;
            }
            self.authorize()?;
            self.trace.push("plain-add-no-install".into());
            self.writes += 1;
            self.staged = true;
            Ok(if self.mode == "stage3010" { 3010 } else { 0 })
        }
    }
    fn recovery(plan: &Envelope) -> Envelope {
        Envelope {
            request: Request::Recover {
                journal_id: plan.plan_id.clone(),
            },
            backup_manifest: Some(plan.snapshot.manifest.clone()),
            plan_id: "b".repeat(32),
            ..plan.clone()
        }
    }
    #[test]
    fn closed_schema_identity_and_journal_budget_fail_before_side_effects() {
        for value in [
            serde_json::json!({"kind":"remove","inf":"oem12.inf"}),
            serde_json::json!({"kind":"remove","driverId":"a".repeat(32),"force":true}),
            serde_json::json!({"kind":"recover","journalId":"a".repeat(32),"path":"C:\\caller"}),
        ] {
            assert!(serde_json::from_value::<Request>(value).is_err());
        }
        assert!(Request::Remove {
            driver_id: "oem12.inf".into()
        }
        .validate()
        .is_err());
        let good = snapshot();
        good.validate().unwrap();
        preflight_snapshot(&good).unwrap();
        let mut large = good.clone();
        for n in 0..100 {
            large.manifest.files.push(package::Member {
                name: format!("payload-{n:04}.bin"),
                bytes: 1,
                digest: "1".repeat(64),
            });
        }
        assert!(preflight_snapshot(&large)
            .unwrap_err()
            .contains("journal budget"));
        let compact = Selection {
            row: large.row.clone(),
            fingerprint: large.manifest.fingerprint().unwrap(),
        };
        assert!(serde_json::to_vec(&compact).unwrap().len() < 2048);
        assert!(!String::from_utf8(serde_json::to_vec(&compact).unwrap())
            .unwrap()
            .contains("payload-"));
        let mut expired = plan();
        expired.deadline_utc_ms = 0;
        let mut fake = Fake::default();
        assert!(perform(&expired, &mut fake, || Ok(())).is_err());
        assert_eq!(fake.writes, 0);
    }
    #[test]
    fn complete_backup_intent_plain_delete_absence_completion_order() {
        let plan = plan();
        let mut fake = Fake::default();
        assert!(perform(&plan, &mut fake, || Ok(())).unwrap().ok);
        let position = |needle: &str| fake.trace.iter().position(|s| s == needle).unwrap();
        assert!(position("verify-backup") < position("journal:head:false"));
        assert!(position("journal:head:false") < position("plain-delete"));
        assert!(position("plain-delete") < position("verify-absence"));
        assert!(position("verify-absence") < position("journal:head:true"));
        assert!(fake.journals["head"].completed);
        assert_eq!(fake.writes, 1);
        assert!(perform(&plan, &mut fake, || Ok(())).is_err());
        assert_eq!(fake.writes, 1);
    }
    #[test]
    fn unsafe_or_changed_source_cancelled_parent_and_incomplete_backups_never_delete() {
        for mode in [
            "stale",
            "after-consent",
            "predelete",
            "cancel",
            "export",
            "missing-catalog",
            "extra",
            "corrupt",
            "backup-tamper",
            "intent",
        ] {
            let mut fake = Fake {
                mode,
                ..Fake::default()
            };
            assert!(perform(&plan(), &mut fake, || Ok(())).is_err(), "{mode}");
            assert_eq!(fake.writes, 0, "{mode}");
        }
        let mut fake = Fake::default();
        assert!(perform(&plan(), &mut fake, || Err(
            "parent cancelled or pipe closed".into()
        ))
        .is_err());
        assert_eq!(fake.writes, 0);
        for change in ["inbox", "boot", "unsigned"] {
            let mut plan = plan();
            match change {
                "inbox" => plan.snapshot.row.inbox = true,
                "boot" => plan.snapshot.row.boot_critical = true,
                _ => plan.snapshot.row.signature = 1,
            };
            let mut fake = Fake::default();
            assert!(perform(&plan, &mut fake, || Ok(())).is_err());
            assert_eq!(fake.writes, 0);
        }
    }
    #[test]
    fn uncertain_tool_codes_unknown_absence_and_completion_failures_block_other_callers() {
        for mode in [
            "after-delete",
            "3010",
            "timeout",
            "still-present",
            "readback",
            "complete",
            "head-complete",
        ] {
            let plan = plan();
            let mut fake = Fake {
                mode,
                ..Fake::default()
            };
            assert!(perform(&plan, &mut fake, || Ok(()))
                .unwrap_err()
                .contains("uncertain"));
            assert_eq!(fake.writes, 1);
            assert!(!fake.journals["head"].completed);
            fake.mode = "";
            let mut next = plan;
            next.plan_id = "c".repeat(32);
            next.backup_id = next.plan_id.clone();
            next.caller_sid = "S-1-5-21-99".into();
            assert!(perform(&next, &mut fake, || Ok(()))
                .unwrap_err()
                .contains("earlier driver"));
            assert_eq!(fake.writes, 1);
        }
    }
    #[test]
    fn late_absolute_deadline_or_disconnected_parent_prevents_actual_tool_launch() {
        let mut fake = Fake {
            mode: "late",
            ..Fake::default()
        };
        assert!(perform(&plan(), &mut fake, || Ok(()))
            .unwrap_err()
            .contains("deadline"));
        assert_eq!(fake.writes, 0);
        assert!(!fake.journals["head"].completed);
        let plan = plan();
        let mut fake = Fake::default();
        perform(&plan, &mut fake, || Ok(())).unwrap();
        fake.mode = "late-stage";
        let before = fake.writes;
        assert!(perform(&recovery(&plan), &mut fake, || Ok(()))
            .unwrap_err()
            .contains("deadline"));
        assert_eq!(fake.writes, before);
        assert!(!fake.journals["head"].completed);
    }
    #[test]
    fn recovery_is_stage_only_exact_content_and_consumes_original_authority() {
        for mode in ["", "already-staged"] {
            let plan = plan();
            let mut fake = Fake::default();
            perform(&plan, &mut fake, || Ok(())).unwrap();
            fake.mode = mode;
            let result = perform(&recovery(&plan), &mut fake, || Ok(())).unwrap();
            assert!(result.staged_only);
            assert!(fake.journals[&plan.plan_id].recovered);
            assert_eq!(fake.writes, if mode.is_empty() { 2 } else { 1 });
            assert!(!fake
                .trace
                .iter()
                .any(|s| s.contains("uninstall") || s.contains("force")));
            let mut repeated = recovery(&plan);
            repeated.plan_id = "c".repeat(32);
            assert!(perform(&repeated, &mut fake, || Ok(())).is_err());
        }
    }
    #[test]
    fn recovery_refuses_wrong_owner_tamper_uncertainty_and_unverified_staging() {
        for mode in [
            "owner",
            "tamper",
            "uncertain",
            "backup-tamper",
            "stage3010",
            "stage-readback",
        ] {
            let plan = plan();
            let mut fake = Fake::default();
            perform(&plan, &mut fake, || Ok(())).unwrap();
            let mut request = recovery(&plan);
            match mode {
                "owner" => request.caller_sid = "S-1-5-21-2".into(),
                "tamper" => {
                    fake.journals
                        .get_mut(&plan.plan_id)
                        .unwrap()
                        .backup_manifest
                        .files[0]
                        .digest = "f".repeat(64)
                }
                "uncertain" => fake.journals.get_mut(&plan.plan_id).unwrap().completed = false,
                _ => fake.mode = mode,
            };
            assert!(perform(&request, &mut fake, || Ok(())).is_err(), "{mode}");
            if ["owner", "tamper", "uncertain", "backup-tamper"].contains(&mode) {
                assert_eq!(fake.writes, 1);
            } else {
                assert!(!fake.journals["head"].completed);
            }
        }
    }
    #[test]
    fn helper_schema_and_digest_bind_exact_native_selection_and_parent() {
        let selection = Selection {
            row: snapshot().row,
            fingerprint: snapshot().manifest.fingerprint().unwrap(),
        };
        let request = HelperRequest::Inspect {
            selection: Box::new(selection),
            caller_sid: "S-1-5-21-1".into(),
            parent_pid: 1,
            deadline_utc_ms: now().unwrap() + TTL_MS,
        };
        let original = digest(&request).unwrap();
        let mut changed = serde_json::to_value(&request).unwrap();
        changed["parent_pid"] = serde_json::json!(2);
        let changed: HelperRequest = serde_json::from_value(changed).unwrap();
        assert_ne!(original, digest(&changed).unwrap());
        let mut hostile = serde_json::to_value(&request).unwrap();
        hostile["script"] = serde_json::json!("caller shell");
        assert!(serde_json::from_value::<HelperRequest>(hostile).is_err());
    }
}
