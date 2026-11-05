//! Native security-software inventory and guarded vendor removal utilities.
use crate::updater_native::{self, Pin};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::Write,
    os::windows::{fs::OpenOptionsExt, process::CommandExt},
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const TTL: Duration = Duration::from_secs(300);
const RECOVERY: &str = "Purgeon cannot undo vendor removal. The utility may request a restart.";
const SOURCE_IDS: [&str; 7] = [
    "SecurityCenter2/AntiVirusProduct",
    "SecurityCenter2/AntiSpywareProduct",
    "SecurityCenter2/FirewallProduct",
    "LocalMachine/Registry64/Uninstall",
    "LocalMachine/Registry32/Uninstall",
    "CurrentUser/Registry64/Uninstall",
    "CurrentUser/Registry32/Uninstall",
];

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrepareRequest {
    pub product_id: String,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Product {
    id: String,
    name: String,
    publisher: String,
    version: String,
    sources: Vec<String>,
    category: String,
    tool_id: Option<String>,
    unsupported_reason: Option<String>,
    built_in: bool,
    help_url: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Source {
    id: String,
    status: String,
    detail: String,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Inventory {
    products: Vec<Product>,
    sources: Vec<Source>,
    complete: bool,
    observed_at: String,
    reviews: Vec<RemovalReview>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    id: String,
    product_id: String,
    tool_id: String,
    product_name: String,
    tool_name: String,
    recovery_limits: String,
    expires_at: String,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    id: String,
    phase: String,
    bytes_received: u64,
    cancellation_requested: bool,
    cleanup: String,
    detail: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelResult {
    accepted: bool,
    status: Status,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchResult {
    id: String,
    outcome: String,
    detail: String,
}

const ESET_HELP: &str =
    "https://support.eset.com/en/kb2289-uninstall-eset-manually-using-the-eset-uninstaller-tool";
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemovalReview {
    review_id: String,
    tool_id: Option<String>,
    plan_id: Option<String>,
    state: String,
    detail: String,
    can_acknowledge: bool,
}
#[derive(Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Acknowledgment {
    ReviewedUtilityClosed,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AcknowledgeRequest {
    pub review_id: String,
    pub acknowledgment: Acknowledgment,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcknowledgeResult {
    review_id: String,
    outcome: String,
}
struct HeldReview {
    dto: RemovalReview,
    pin: Pin,
    bytes: Vec<u8>,
    _parents: Vec<Pin>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Checkpoint {
    schema_version: u32,
    id: String,
    tool_id: String,
    phase: String,
    detail: String,
    payload: PathBuf,
}

struct Policy {
    file_name: &'static str,
    name: &'static str,
    url: &'static str,
    host: &'static str,
    subject: &'static str,
    product: &'static str,
    description: &'static str,
}
fn policy(id: &str) -> Result<Policy, String> {
    let gen = "4d39e593f8ee815667c95851bcab984296d2f3d3e8c13ea0b3b191edb1063e75";
    let (file_name, name, url, host, subject, product, description) = match id {
        "avg" => (
            "avg_av_clear.exe",
            "AVG Clear",
            "https://honzik.avcdn.net/setup/avg-av/release/avg_av_clear.exe?alt=en-us",
            "honzik.avcdn.net",
            gen,
            "AVG Installer",
            "AVG Self-Extract Package",
        ),
        "avast" => (
            "avast_av_clear.exe",
            "Avast Clear",
            "https://honzik.avcdn.net/setup/avast-av/release/avast_av_clear.exe",
            "honzik.avcdn.net",
            gen,
            "Avast Installer",
            "Avast Self-Extract Package",
        ),
        "norton" => (
            "norton_360_remover.exe",
            "Norton 360 Remover",
            "https://honzik.avcdn.net/setup/norton-suite/release/norton_360_remover.exe",
            "honzik.avcdn.net",
            gen,
            "Norton Installer",
            "Norton Self-Extract Package",
        ),
        "mcafee" => (
            "MCPR.exe",
            "McAfee Consumer Product Removal",
            "https://download.mcafee.com/molbin/iss-loc/SupportTools/MCPR/MCPR.exe",
            "download.mcafee.com",
            "c4e73ead0e39f40e10c7d896f6660e01673bcbc56f5259b1d46a7f7a36e32a19",
            "McAfee ESD Package",
            "McAfee ESD Package",
        ),
        _ => return Err("Unsupported removal utility".into()),
    };
    Ok(Policy {
        file_name,
        name,
        url,
        host,
        subject,
        product,
        description,
    })
}
fn check_signer(p: &Policy, subject: &str, product: &str, description: &str) -> Result<(), String> {
    if subject != p.subject || product != p.product || description != p.description {
        Err("Authenticode publisher or product metadata does not match reviewed policy".into())
    } else {
        Ok(())
    }
}
fn match_tool(name: &str, publisher: &str) -> Option<&'static str> {
    let n = name.trim().to_ascii_lowercase();
    let p = publisher.trim().to_ascii_lowercase();
    let gen = ["gen digital inc.", "gen digital inc", "nortonlifelock inc."];
    if [
        "avg antivirus free",
        "avg antivirus",
        "avg internet security",
        "avg ultimate",
    ]
    .contains(&n.as_str())
        && (gen.contains(&p.as_str())
            || ["avg technologies", "avg technologies cz, s.r.o."].contains(&p.as_str()))
    {
        Some("avg")
    } else if [
        "avast free antivirus",
        "avast premium security",
        "avast antivirus",
    ]
    .contains(&n.as_str())
        && (gen.contains(&p.as_str())
            || ["avast software", "avast software s.r.o."].contains(&p.as_str()))
    {
        Some("avast")
    } else if [
        "norton 360",
        "norton security",
        "norton antivirus plus",
        "norton internet security",
    ]
    .contains(&n.as_str())
        && (gen.contains(&p.as_str()) || p == "symantec corporation")
    {
        Some("norton")
    } else if [
        "mcafee total protection",
        "mcafee livesafe",
        "mcafee antivirus",
        "mcafee internet security",
    ]
    .contains(&n.as_str())
        && ["mcafee, llc", "mcafee, inc."].contains(&p.as_str())
    {
        Some("mcafee")
    } else {
        None
    }
}
fn valid_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit())
}
fn timestamp(seconds: u64) -> Result<String, String> {
    #[repr(C)]
    struct Date {
        year: u16,
        month: u16,
        weekday: u16,
        day: u16,
        hour: u16,
        minute: u16,
        second: u16,
        millis: u16,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn FileTimeToSystemTime(file: *const u64, date: *mut Date) -> i32;
    }
    let ticks = seconds
        .checked_add(11644473600)
        .and_then(|v| v.checked_mul(10_000_000))
        .ok_or("Timestamp overflow")?;
    let mut d: Date = unsafe { std::mem::zeroed() };
    if unsafe { FileTimeToSystemTime(&ticks, &mut d) } == 0 {
        return Err("Invalid timestamp".into());
    }
    Ok(format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        d.year, d.month, d.day, d.hour, d.minute, d.second
    ))
}
fn now() -> Result<u64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|v| v.as_secs())
        .map_err(|e| e.to_string())
}

fn script(
    script: &str,
    input: serde_json::Value,
    timeout: Duration,
    cancelled: &AtomicBool,
) -> Result<Vec<u8>, String> {
    let executable = crate::windows_tools::system_file("powershell.exe")?;
    let modules = executable
        .parent()
        .ok_or("Missing fixed PowerShell directory")?
        .join("Modules");
    let mut command = Command::new(executable);
    // Only encoding setup may run before stdin admission. All module loading
    // and helper effects remain behind the first blocking JSON read.
    let script = format!("$ErrorActionPreference='Stop'; [Console]::InputEncoding = [Text.UTF8Encoding]::new($false); [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false);\n{script}");
    command.env("PSModulePath", modules);
    command
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .creation_flags(0x08000000);
    let output = crate::process_io::execute_in_job_cancellable(
        &mut command,
        Some(input.to_string()),
        timeout,
        4 * 1024 * 1024,
        None,
        |_| Ok(()),
        || cancelled.load(Ordering::Acquire),
    )?;
    if !output.status.success() {
        return Err("Fixed native helper failed; operation did not complete".into());
    }
    Ok(output.stdout)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    name: String,
    publisher: String,
    version: String,
    source: String,
    state: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Snapshot {
    records: Vec<Record>,
    sources: Vec<Source>,
}
fn normalize(snapshot: Snapshot, previous: &[Product]) -> Result<Inventory, String> {
    if snapshot.records.len() > 16640 || snapshot.sources.len() != 7 {
        return Err("Inventory exceeds bounds or misses sources".into());
    }
    for expected in SOURCE_IDS {
        if snapshot.sources.iter().filter(|s| s.id == expected).count() != 1 {
            return Err("Inventory source identity invalid".into());
        }
    }
    if snapshot.sources.iter().any(|s| {
        !matches!(s.status.as_str(), "ok" | "error" | "unavailable") || s.detail.len() > 512
    }) {
        return Err("Invalid source outcome".into());
    }
    let mut products: Vec<Product> = Vec::new();
    // Registry evidence first: matching WMI display names can corroborate it.
    let mut records = snapshot.records;
    records.sort_by_key(|r| r.source.starts_with("SecurityCenter2/"));
    for r in records {
        if r.name.len() > 512
            || r.publisher.len() > 512
            || r.version.len() > 128
            || r.state.len() > 64
            || !SOURCE_IDS.contains(&r.source.as_str())
        {
            return Err("Invalid inventory record".into());
        }
        let n = r.name.trim();
        if n.is_empty() {
            continue;
        }
        let lower = n.to_ascii_lowercase();
        let built_in = [
            "windows defender",
            "microsoft defender",
            "windows defender antivirus",
            "microsoft defender antivirus",
        ]
        .contains(&lower.as_str())
            && (r.source.starts_with("SecurityCenter2/")
                || r.publisher.eq_ignore_ascii_case("Microsoft Corporation"));
        let matched = match_tool(n, &r.publisher);
        let security_name = matched.is_some()
            || [
                "avast one",
                "eset security",
                "eset smart security",
                "eset smart security premium",
                "eset nod32 antivirus",
                "eset internet security",
                "eset endpoint antivirus",
                "eset endpoint security",
                "kaspersky",
                "kaspersky standard",
                "kaspersky plus",
                "kaspersky premium",
                "kaspersky antivirus",
                "kaspersky anti-virus",
                "kaspersky internet security",
                "kaspersky total security",
                "bitdefender antivirus free",
                "bitdefender antivirus plus",
                "bitdefender internet security",
                "bitdefender total security",
                "malwarebytes",
                "malwarebytes version",
                "avast business security",
                "avg business security",
                "norton security ultra",
                "mcafee endpoint security",
                "sophos endpoint agent",
                "trend micro maximum security",
                "webroot secureanywhere",
                "avira security",
            ]
            .contains(&lower.as_str());
        if !r.source.starts_with("SecurityCenter2/") && !security_name && !built_in {
            continue;
        }
        if let Some(p) = products.iter_mut().find(|p| {
            p.name.eq_ignore_ascii_case(n)
                && (r.publisher.is_empty() || p.publisher.eq_ignore_ascii_case(&r.publisher))
                && (r.version.is_empty() || p.version == r.version)
        }) {
            if !p.sources.contains(&r.source) {
                p.sources.push(r.source);
            }
            continue;
        }
        let reason = if built_in {
            Some("Built-in Windows protection; removal is not supported".into())
        } else if lower.starts_with("eset ") {
            Some("Instructions only: ESET removal requires the vendor Safe Mode procedure; Purgeon never changes boot settings".into())
        } else if matched.is_none() {
            Some("No reviewed consumer utility mapping; enterprise and unknown variants are unsupported".into())
        } else {
            None
        };
        let id = previous
            .iter()
            .find(|p| p.name == n && p.publisher == r.publisher && p.version == r.version)
            .map(|p| Ok(p.id.clone()))
            .unwrap_or_else(crate::broker::random_id)?;
        products.push(Product {
            id,
            name: n.into(),
            publisher: r.publisher,
            version: r.version,
            sources: vec![r.source],
            category: if built_in {
                "builtIn"
            } else {
                "securitySoftware"
            }
            .into(),
            tool_id: matched.map(str::to_owned),
            unsupported_reason: reason,
            built_in,
            help_url: lower.starts_with("eset ").then(|| ESET_HELP.into()),
        });
        if products.len() > 1024 {
            return Err("Security product inventory exceeds bounds".into());
        }
    }
    Ok(Inventory {
        products,
        complete: snapshot.sources.iter().all(|s| s.status == "ok"),
        sources: snapshot.sources,
        observed_at: timestamp(now()?)?,
        reviews: vec![],
    })
}
#[derive(Clone)]
struct OperationState {
    phase: &'static str,
    cancelled: bool,
}
impl OperationState {
    fn new() -> Self {
        Self {
            phase: "prepared",
            cancelled: false,
        }
    }
    fn cancel(&mut self) -> bool {
        if matches!(self.phase, "prepared" | "downloading" | "verifying") {
            self.cancelled = true;
            if self.phase == "prepared" {
                self.phase = "cancelled";
            }
            true
        } else {
            false
        }
    }
    fn begin_launch(&mut self) -> Result<(), String> {
        if self.cancelled || !matches!(self.phase, "prepared" | "verifying") {
            Err("Plan cancelled or already consumed".into())
        } else {
            self.phase = "launching";
            Ok(())
        }
    }
}
struct Operation {
    plan: Plan,
    created: Instant,
    state: Mutex<OperationState>,
    cancelled: AtomicBool,
    view: Mutex<Status>,
}
impl Operation {
    fn snapshot(&self) -> Result<Status, String> {
        let s = self.state.lock().map_err(|_| "Operation unavailable")?;
        let mut v = self
            .view
            .lock()
            .map_err(|_| "Operation unavailable")?
            .clone();
        v.phase = s.phase.into();
        v.cancellation_requested = s.cancelled;
        Ok(v)
    }
    fn stage(&self, phase: &'static str) -> Result<(), String> {
        let mut s = self.state.lock().map_err(|_| "Operation unavailable")?;
        if s.cancelled {
            return Err("Operation cancelled".into());
        }
        s.phase = phase;
        Ok(())
    }
}
#[derive(Default)]
struct Manager {
    products: Vec<Product>,
    operations: HashMap<String, Arc<Operation>>,
    reviews: HashMap<String, HeldReview>,
}
fn manager() -> &'static Mutex<Manager> {
    static VALUE: OnceLock<Mutex<Manager>> = OnceLock::new();
    VALUE.get_or_init(|| Mutex::new(Manager::default()))
}
pub fn inventory() -> Result<Inventory, String> {
    static REFRESH: Mutex<()> = Mutex::new(());
    inventory_with(
        manager(),
        &REFRESH,
        || {
            script(
                include_str!("security_software/inventory.ps1"),
                serde_json::json!({}),
                Duration::from_secs(40),
                &AtomicBool::new(false),
            )
        },
        |m| discover_reviews(&native_root()?, m),
    )
}
fn inventory_with(
    manager: &Mutex<Manager>,
    gate: &Mutex<()>,
    helper: impl FnOnce() -> Result<Vec<u8>, String>,
    discover: impl FnOnce(&mut Manager) -> Result<Vec<RemovalReview>, String>,
) -> Result<Inventory, String> {
    let _refresh = gate.try_lock().map_err(|error| match error {
        std::sync::TryLockError::WouldBlock => "Inventory refresh already in progress",
        std::sync::TryLockError::Poisoned(_) => "Inventory unavailable",
    })?;
    let previous = {
        let mut m = manager.lock().map_err(|_| "Inventory unavailable")?;
        std::mem::take(&mut m.products)
    };
    let raw = helper();
    let mut m = manager.lock().map_err(|_| "Inventory unavailable")?;
    let mut result = match raw {
        Ok(bytes) => normalize(
            serde_json::from_slice(&bytes).map_err(|_| "Invalid inventory helper response")?,
            &previous,
        )?,
        Err(_) => Inventory {
            products: vec![],
            sources: SOURCE_IDS
                .iter()
                .map(|id| Source {
                    id: (*id).into(),
                    status: "error".into(),
                    detail: "Native inventory helper did not complete".into(),
                })
                .collect(),
            complete: false,
            observed_at: timestamp(now()?)?,
            reviews: vec![],
        },
    };
    result.reviews = discover(&mut m)?;
    m.products = result.products.clone();
    Ok(result)
}
fn native_root() -> Result<PathBuf, String> {
    let root = crate::portable_dir()
        .or_else(|| {
            std::env::var_os("APPDATA")
                .map(|v| PathBuf::from(v).join("com.seanshaffer.sweepuninstall"))
        })
        .ok_or("No native application data directory")?;
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let root = updater_native::canonical_temp(&root)?;
    let _pins = pin_ancestors(&root)?;
    let av = root.join("SecuritySoftware");
    match fs::create_dir(&av) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(e.to_string()),
    }
    updater_native::canonical_temp(&av)
}
fn pin_ancestors(path: &Path) -> Result<Vec<Pin>, String> {
    path.ancestors()
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .map(|p| {
            Pin::open(p, true, 0x80000000, 3)
                .map_err(|e| format!("Ancestor pin {}: {e}", p.display()))
        })
        .collect()
}
fn has_marker(root: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(root.join("launch-intent")) {
        Ok(_) => return Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.to_string()),
    }
    for id in ["avg", "avast", "norton", "mcafee"] {
        match fs::symlink_metadata(root.join(format!("{id}.launch-intent"))) {
            Ok(_) => return Ok(true),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(false)
}
fn validated_checkpoint(root: &Path, path: &Path, bytes: &[u8]) -> Result<Checkpoint, String> {
    let c: Checkpoint = serde_json::from_slice(bytes).map_err(|_| "Malformed checkpoint")?;
    if c.schema_version != 1
        || !valid_id(&c.id)
        || policy(&c.tool_id).is_err()
        || c.phase != "reviewRequired"
        || c.detail != "Utility may have started; no automatic retry"
        || !(path == root.join("launch-intent")
            || path == root.join(format!("{}.launch-intent", c.tool_id)))
    {
        return Err("Unsupported checkpoint".into());
    }
    let parent = c.payload.parent().ok_or("Invalid checkpoint payload")?;
    let name = parent
        .file_name()
        .and_then(|v| v.to_str())
        .ok_or("Invalid payload directory")?;
    if c.payload.file_name().and_then(|v| v.to_str()) != Some(policy(&c.tool_id)?.file_name)
        || parent.parent() != Some(root)
        || !name.strip_prefix("removal-").is_some_and(valid_id)
    {
        return Err("Checkpoint payload does not belong to native root".into());
    }
    Ok(c)
}
fn discover_reviews(root: &Path, m: &mut Manager) -> Result<Vec<RemovalReview>, String> {
    let mut result = Vec::new();
    // Preserve issued identities and retained pins until explicit acknowledgment.
    for name in [
        "launch-intent",
        "avg.launch-intent",
        "avast.launch-intent",
        "norton.launch-intent",
        "mcafee.launch-intent",
    ] {
        let path = root.join(name);
        match fs::symlink_metadata(&path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e.to_string()),
            Ok(_) => {}
        }
        if let Some(held) = m.reviews.values().find(|r| {
            r.pin.read_bounded(4096).is_ok_and(|b| b == r.bytes)
                && validated_checkpoint(root, &path, &r.bytes).is_ok()
        }) {
            // Match the actual path as well: two tools may contain identical bytes.
            if Pin::open(&path, false, 0x80000000, 7).is_ok_and(|p| p.same_identity(&held.pin)) {
                result.push(held.dto.clone());
                continue;
            }
        }
        let review_id = crate::broker::random_id()?;
        let inspected = (|| {
            let parents = pin_ancestors(root)?;
            // READ + DELETE; share read only denies writers and substitutions.
            let pin = Pin::open(&path, false, 0x80010000, 1)?;
            let bytes = pin.read_bounded(4096)?;
            let checkpoint = validated_checkpoint(root, &path, &bytes)?;
            let dto = RemovalReview { review_id: review_id.clone(), tool_id: Some(checkpoint.tool_id),
                plan_id: Some(checkpoint.id), state: "reviewRequired".into(),
                detail: "Check that the previous vendor utility has finished or closed, including any elevation prompt. Purgeon cannot determine whether removal completed.".into(), can_acknowledge: true };
            Ok::<_, String>(HeldReview {
                dto,
                pin,
                bytes,
                _parents: parents,
            })
        })();
        match inspected {
            Ok(held) => { result.push(held.dto.clone()); m.reviews.insert(review_id, held); }
            Err(_) => result.push(RemovalReview { review_id, tool_id: name.strip_suffix(".launch-intent").filter(|tool| policy(tool).is_ok()).map(str::to_owned), plan_id: None,
                state: "unreadable".into(), detail: "Checkpoint ownership or contents could not be validated; retained for manual review.".into(), can_acknowledge: false }),
        }
    }
    Ok(result)
}
pub fn acknowledge(request: AcknowledgeRequest) -> Result<AcknowledgeResult, String> {
    if !valid_id(&request.review_id)
        || request.acknowledgment != Acknowledgment::ReviewedUtilityClosed
    {
        return Err("Invalid review acknowledgment".into());
    }
    let mut m = manager()
        .lock()
        .map_err(|_| "Removal manager unavailable")?;
    if m.operations.values().any(|op| {
        op.state.lock().map_or(true, |s| {
            matches!(s.phase, "downloading" | "verifying" | "launching")
        })
    }) {
        return Err("A removal operation is active".into());
    }
    let held = m
        .reviews
        .get(&request.review_id)
        .ok_or("Unknown or stale review ID")?;
    held.pin.retire_checkpoint(&held.bytes)?;
    let plan_id = held.dto.plan_id.clone();
    // No launch, process termination, or payload cleanup is performed here.
    m.reviews.remove(&request.review_id);
    if let Some(op) = plan_id.and_then(|id| m.operations.get(&id)) {
        op.state.lock().map_err(|_| "Operation unavailable")?.phase = "acknowledged";
    }
    Ok(AcknowledgeResult {
        review_id: request.review_id,
        outcome: "acknowledged".into(),
    })
}

pub fn prepare(request: PrepareRequest) -> Result<Plan, String> {
    if !valid_id(&request.product_id) {
        return Err("Invalid native product ID".into());
    }
    let root = native_root()?;
    let _pins = pin_ancestors(&root)?;
    if has_marker(&root)? {
        return Err("A vendor utility may have started; review open windows and retained recovery metadata before retrying".into());
    }
    let mut m = manager()
        .lock()
        .map_err(|_| "Removal manager unavailable")?;
    prepare_cached(&mut m, request)
}
fn prepare_cached(m: &mut Manager, request: PrepareRequest) -> Result<Plan, String> {
    if !valid_id(&request.product_id) {
        return Err("Invalid native product ID".into());
    }
    for op in m.operations.values() {
        let mut s = op.state.lock().map_err(|_| "Operation unavailable")?;
        if s.phase == "prepared" && op.created.elapsed() >= TTL {
            s.phase = "failed";
        }
        if matches!(
            s.phase,
            "prepared" | "downloading" | "verifying" | "launching" | "launched" | "reviewRequired"
        ) {
            return Err("A removal operation is already active or requires review".into());
        }
    }
    if m.operations.len() >= 64 {
        return Err("Removal plan session limit reached".into());
    }
    let product = m
        .products
        .iter()
        .find(|p| p.id == request.product_id)
        .ok_or("Product is absent from native inventory")?;
    let tool = product
        .tool_id
        .as_deref()
        .ok_or("Product has no reviewed removal utility")?;
    let p = policy(tool)?;
    let plan = Plan {
        id: crate::broker::random_id()?,
        product_id: product.id.clone(),
        tool_id: tool.into(),
        product_name: product.name.clone(),
        tool_name: p.name.into(),
        recovery_limits: RECOVERY.into(),
        expires_at: timestamp(now()?.checked_add(300).ok_or("Expiry overflow")?)?,
    };
    let op = Operation {
        plan: plan.clone(),
        created: Instant::now(),
        state: Mutex::new(OperationState::new()),
        cancelled: AtomicBool::new(false),
        view: Mutex::new(Status {
            id: plan.id.clone(),
            phase: "prepared".into(),
            bytes_received: 0,
            cancellation_requested: false,
            cleanup: "none".into(),
            detail: RECOVERY.into(),
        }),
    };
    m.operations.insert(plan.id.clone(), Arc::new(op));
    Ok(plan)
}
fn operation(id: &str) -> Result<Arc<Operation>, String> {
    if !valid_id(id) {
        return Err("Invalid native plan ID".into());
    }
    manager()
        .lock()
        .map_err(|_| "Removal manager unavailable")?
        .operations
        .get(id)
        .cloned()
        .ok_or("Unknown native plan ID".into())
}
pub fn status(id: &str) -> Result<Status, String> {
    if !valid_id(id) {
        return Err("Invalid native plan ID".into());
    }
    if let Some(op) = manager()
        .lock()
        .map_err(|_| "Removal manager unavailable")?
        .operations
        .get(id)
        .cloned()
    {
        return op.snapshot();
    }
    let root = native_root()?;
    let _parents = pin_ancestors(&root)?;
    read_restart_status(&root, id)
}
fn read_restart_status(root: &Path, id: &str) -> Result<Status, String> {
    let path = root.join("launch-intent");
    let held = Pin::open(&path, false, 0x80000000, 1)?;
    if fs::metadata(&path).map_err(|e| e.to_string())?.len() > 4096 {
        return Err("Recovery checkpoint exceeds bounds".into());
    }
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    if bytes.len() > 4096 {
        return Err("Recovery checkpoint exceeds bounds".into());
    }
    let marker: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|_| "Recovery checkpoint needs manual review")?;
    held.verify(false)?;
    if marker.get("schemaVersion") != Some(&serde_json::json!(1))
        || marker.get("id").and_then(|v| v.as_str()) != Some(id)
    {
        return Err("Unknown native plan ID; retained checkpoint needs review".into());
    }
    Ok(Status{id:id.into(),phase:"reviewRequired".into(),bytes_received:0,cancellation_requested:false,cleanup:"retained".into(),detail:"The utility may have started before Purgeon closed; review open windows before retrying. No automatic relaunch or cleanup was attempted.".into()})
}
pub fn cancel(id: &str) -> Result<CancelResult, String> {
    let op = operation(id)?;
    let accepted = {
        let mut s = op.state.lock().map_err(|_| "Operation unavailable")?;
        let accepted = s.cancel();
        if accepted {
            op.cancelled.store(true, Ordering::Release);
        }
        accepted
    };
    Ok(CancelResult {
        accepted,
        status: op.snapshot()?,
    })
}

struct Payload {
    path: PathBuf,
    pins: Vec<Pin>,
    original: Option<Pin>,
    sealed: Option<Pin>,
}
impl Payload {
    fn create(root: &Path, tool_id: &str) -> Result<Self, String> {
        let policy = policy(tool_id)?;
        let mut pins = pin_ancestors(root)?;
        let dir = root.join(format!("removal-{}", crate::broker::random_id()?));
        fs::create_dir(&dir).map_err(|e| e.to_string())?;
        pins.push(Pin::open(&dir, true, 0x80000000, 3)?);
        let path = dir.join(policy.file_name);
        let original = Pin::create_placeholder(&path).map_err(|e| format!("Placeholder: {e}"))?;
        Ok(Self {
            path,
            pins,
            original: Some(original),
            sealed: None,
        })
    }
    fn seal(&mut self) -> Result<(), String> {
        self.recheck()?;
        let sealed = Pin::open(&self.path, false, 0x80000000, 1)?;
        if !sealed.same_identity(self.original.as_ref().ok_or("Missing original identity")?) {
            return Err("Download identity changed".into());
        }
        let size = fs::metadata(&self.path).map_err(|e| e.to_string())?.len();
        if size == 0 || size > 134217728 {
            return Err("Download size rejected".into());
        }
        self.sealed = Some(sealed);
        self.recheck()
    }
    fn recheck(&self) -> Result<(), String> {
        for p in &self.pins {
            p.verify(true)?;
        }
        self.original
            .as_ref()
            .ok_or("Missing original identity")?
            .verify(false)?;
        if let Some(p) = &self.sealed {
            p.verify(false)?;
        }
        Ok(())
    }
    fn cleanup(mut self) -> Result<(), String> {
        self.recheck()?;
        self.sealed.take();
        self.original
            .take()
            .ok_or("Missing original identity")?
            .remove_matching(false)?;
        self.pins
            .pop()
            .ok_or("Missing owned directory")?
            .remove_matching(true)
    }
}
trait Effects {
    fn download(&mut self, op: &Operation) -> Result<u64, String>;
    fn verify(&mut self, op: &Operation) -> Result<(), String>;
    fn persist(&mut self, op: &Operation) -> Result<(), String>;
    fn launch(&mut self) -> Result<(), String>;
    fn cleanup(&mut self) -> Result<(), String>;
}
struct NativeEffects {
    root: PathBuf,
    payload: Option<Payload>,
    checkpoint: Option<fs::File>,
}
impl NativeEffects {
    fn download_with<F>(&mut self, op: &Operation, runner: F) -> Result<u64, String>
    where
        F: FnOnce(&str, serde_json::Value, Duration, &AtomicBool) -> Result<Vec<u8>, String>,
    {
        let p = policy(&op.plan.tool_id)?;
        self.payload = Some(Payload::create(&self.root, &op.plan.tool_id)?);
        let payload = self.payload.as_mut().ok_or("Payload unavailable")?;
        let bytes = runner(
            include_str!("security_software/download.ps1"),
            serde_json::json!({"url":p.url,"hostName":p.host,"path":payload.path}),
            Duration::from_secs(180),
            &op.cancelled,
        )?;
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Downloaded {
            bytes: u64,
        }
        let result: Downloaded =
            serde_json::from_slice(&bytes).map_err(|_| "Invalid download response")?;
        if result.bytes == 0 || result.bytes > 134217728 {
            return Err("Download byte limit rejected".into());
        }
        payload.seal()?;
        if fs::metadata(&payload.path)
            .map_err(|e| e.to_string())?
            .len()
            != result.bytes
        {
            return Err("Download byte count mismatch".into());
        }
        Ok(result.bytes)
    }
    fn verify_with<F>(&mut self, op: &Operation, runner: F) -> Result<(), String>
    where
        F: FnOnce(&str, serde_json::Value, Duration, &AtomicBool) -> Result<Vec<u8>, String>,
    {
        let payload = self.payload.as_ref().ok_or("Payload unavailable")?;
        payload.recheck()?;
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Verified {
            subject: String,
            product: String,
            description: String,
        }
        let bytes = runner(
            include_str!("security_software/verify.ps1"),
            serde_json::json!({"path":payload.path}),
            Duration::from_secs(60),
            &op.cancelled,
        )?;
        let v: Verified =
            serde_json::from_slice(&bytes).map_err(|_| "Invalid signature helper response")?;
        let p = policy(&op.plan.tool_id)?;
        check_signer(&p, &v.subject, &v.product, &v.description)?;
        payload.recheck()
    }
}
impl Effects for NativeEffects {
    fn download(&mut self, op: &Operation) -> Result<u64, String> {
        self.download_with(op, script)
    }
    fn verify(&mut self, op: &Operation) -> Result<(), String> {
        self.verify_with(op, script)
    }
    fn persist(&mut self, op: &Operation) -> Result<(), String> {
        let payload = self.payload.as_ref().ok_or("Payload unavailable")?;
        payload.recheck()?;
        let path = self.root.join("launch-intent");
        // Exclusive durable checkpoint is intentionally never automatically removed.
        // Even a partial checkpoint blocks a restart; unknown state never authorizes retry.
        self.checkpoint = Some(
            OpenOptions::new()
                .write(true)
                .create_new(true)
                .share_mode(1) // FILE_SHARE_READ: deny writers and checkpoint retirement.
                .open(path)
                .map_err(|e| e.to_string())?,
        );
        let file = self.checkpoint.as_mut().unwrap();
        let bytes=serde_json::to_vec(&serde_json::json!({"schemaVersion":1,"id":op.plan.id,"toolId":op.plan.tool_id,"phase":"reviewRequired","detail":"Utility may have started; no automatic retry","payload":payload.path})).map_err(|e|e.to_string())?;
        file.write_all(&bytes)
            .and_then(|()| file.sync_all())
            .map_err(|e| e.to_string())?;
        payload.recheck()
    }
    fn launch(&mut self) -> Result<(), String> {
        let p = self.payload.as_ref().ok_or("Payload unavailable")?;
        p.recheck()?;
        updater_native::shell_launch(&p.path)?;
        p.recheck()
    }
    fn cleanup(&mut self) -> Result<(), String> {
        match self.payload.take() {
            Some(p) => p.cleanup(),
            None => Ok(()),
        }
    }
}
#[cfg(test)]
fn run(op: &Operation, effects: &mut impl Effects) -> Result<LaunchResult, String> {
    run_with_setup(op, effects, |_| Ok(()))
}
fn run_with_setup<E: Effects, G>(
    op: &Operation,
    effects: &mut E,
    setup: impl FnOnce(&mut E) -> Result<G, String>,
) -> Result<LaunchResult, String> {
    let result = (|| {
        let _guard = setup(effects)?;
        op.stage("downloading")?;
        let bytes = effects.download(op)?;
        op.view
            .lock()
            .map_err(|_| "Operation unavailable")?
            .bytes_received = bytes;
        op.stage("verifying")?;
        effects.verify(op)?;
        effects.persist(op)?;
        op.state
            .lock()
            .map_err(|_| "Operation unavailable")?
            .begin_launch()?;
        // No cancellation and no downloader job applies after this boundary.
        effects.launch()
    })();
    let mut state = op.state.lock().map_err(|_| "Operation unavailable")?;
    let crossed = state.phase == "launching";
    let (phase, detail) = match result {
        Ok(()) => (
            "launched",
            "Vendor utility launched. Complete its steps, then refresh this list.".into(),
        ),
        Err(e) if crossed => (
            "reviewRequired",
            format!("The utility may have started; review open windows before retrying. {e}"),
        ),
        Err(_) if state.cancelled => (
            "cancelled",
            "Operation cancelled before vendor launch".into(),
        ),
        Err(e) => ("failed", e),
    };
    state.phase = phase;
    drop(state);
    let cleanup = if crossed {
        "retained"
    } else {
        match effects.cleanup() {
            Ok(()) => "removed",
            Err(_) => "retained",
        }
    };
    let mut view = op.view.lock().map_err(|_| "Operation unavailable")?;
    view.cleanup = cleanup.into();
    view.detail = detail.clone();
    Ok(LaunchResult {
        id: op.plan.id.clone(),
        outcome: phase.into(),
        detail,
    })
}
pub fn launch(id: &str) -> Result<LaunchResult, String> {
    launch_with(
        manager(),
        id,
        &mut NativeEffects {
            root: PathBuf::new(),
            payload: None,
            checkpoint: None,
        },
        |effects| {
            let (root, pins) = launch_root(native_root, pin_ancestors, has_marker)?;
            effects.root = root;
            Ok(pins)
        },
    )
}
fn launch_with<E: Effects, G>(
    manager: &Mutex<Manager>,
    id: &str,
    effects: &mut E,
    setup: impl FnOnce(&mut E) -> Result<G, String>,
) -> Result<LaunchResult, String> {
    let op = admit_cached(manager, id)?;
    run_with_setup(&op, effects, setup)
}
fn admit_cached(manager: &Mutex<Manager>, id: &str) -> Result<Arc<Operation>, String> {
    if !valid_id(id) {
        return Err("Invalid native plan ID".into());
    }
    let m = manager.lock().map_err(|_| "Removal manager unavailable")?;
    let op = m.operations.get(id).ok_or("Unknown native plan ID")?;
    admit(op, &m.products)?;
    Ok(Arc::clone(op))
}
fn launch_root<G>(
    root: impl FnOnce() -> Result<PathBuf, String>,
    pin: impl FnOnce(&Path) -> Result<G, String>,
    marker: impl FnOnce(&Path) -> Result<bool, String>,
) -> Result<(PathBuf, G), String> {
    let root = root()?;
    let pins = pin(&root)?;
    if marker(&root)? {
        return Err("Prior utility launch requires review".into());
    }
    Ok((root, pins))
}
fn admit(op: &Operation, products: &[Product]) -> Result<(), String> {
    let mut state = op.state.lock().map_err(|_| "Operation unavailable")?;
    if state.phase != "prepared" || state.cancelled {
        return Err("Plan is cancelled or already consumed".into());
    }
    if op.created.elapsed() >= TTL {
        state.phase = "failed";
        return Err("Removal plan expired".into());
    }
    if !products.iter().any(|product| {
        product.id == op.plan.product_id && product.tool_id.as_deref() == Some(&op.plan.tool_id)
    }) {
        let detail = "Current inventory no longer confirms this product and utility. Refresh inventory and prepare a new plan.";
        let mut view = op.view.lock().map_err(|_| "Operation unavailable")?;
        view.detail = detail.into();
        state.phase = "failed";
        return Err(detail.into());
    }
    state.phase = "downloading";
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    static ACK_TEST: Mutex<()> = Mutex::new(());

    #[test]
    fn actual_checkpoint_blocks_independent_review_until_owner_finalizes() {
        let (ready, paused) = std::sync::mpsc::channel();
        let (resume, resumed) = std::sync::mpsc::channel();
        let owner = std::thread::spawn(move || {
            struct PausedOwner {
                fixture: AdapterFixture,
                ready: std::sync::mpsc::Sender<PathBuf>,
                resumed: std::sync::mpsc::Receiver<()>,
                launches: usize,
            }
            impl Effects for PausedOwner {
                fn download(&mut self, op: &Operation) -> Result<u64, String> {
                    self.fixture.populate_inert(op);
                    Ok(5)
                }
                fn verify(&mut self, _: &Operation) -> Result<(), String> {
                    Ok(())
                }
                fn persist(&mut self, op: &Operation) -> Result<(), String> {
                    self.fixture.effects.persist(op)?;
                    self.ready.send(self.fixture.effects.root.clone()).unwrap();
                    self.resumed
                        .recv_timeout(Duration::from_secs(15))
                        .map_err(|e| e.to_string())
                }
                fn launch(&mut self) -> Result<(), String> {
                    self.launches += 1;
                    assert!(self.fixture.effects.root.join("launch-intent").exists());
                    Ok(())
                }
                fn cleanup(&mut self) -> Result<(), String> {
                    self.fixture.effects.cleanup()
                }
            }
            let mut effects = PausedOwner {
                fixture: AdapterFixture::new(),
                ready,
                resumed,
                launches: 0,
            };
            let mut m = cached();
            let op = planned(&mut m);
            admit(&op, &m.products).unwrap();
            let result = run(&op, &mut effects).unwrap();
            assert_eq!(result.outcome, "launched", "{}", result.detail);
            assert_eq!(op.snapshot().unwrap().cleanup, "retained");
            assert_eq!(effects.launches, 1);
            // Return ownership so the parent can inspect the finalized checkpoint before drop.
            effects.fixture
        });
        let root = paused.recv_timeout(Duration::from_secs(15)).unwrap();
        let marker = root.join("launch-intent");
        let bytes = fs::read(&marker).unwrap();
        let mut independent = Manager::default();
        let reviews = discover_reviews(&root, &mut independent).unwrap();
        let protected = !reviews[0].can_acknowledge
            && independent.reviews.is_empty()
            && Pin::open(&marker, false, 0x80010000, 1).is_err();
        drop(independent);
        resume.send(()).unwrap();
        let mut fixture = owner.join().unwrap();
        assert!(
            protected,
            "another instance can retire the active owner's checkpoint"
        );
        assert!(fs::remove_file(&marker).is_err());
        assert!(OpenOptions::new().write(true).open(&marker).is_err());
        assert_eq!(fs::read(&marker).unwrap(), bytes);
        let payload = fixture.effects.payload.as_ref().unwrap().path.clone();
        let payload_bytes = fs::read(&payload).unwrap();
        // Drop the actual owner while retaining this fixture's directory for review.
        drop(std::mem::replace(
            &mut fixture.effects,
            NativeEffects {
                root: root.clone(),
                payload: None,
                checkpoint: None,
            },
        ));
        let mut independent = Manager::default();
        let review = discover_reviews(&root, &mut independent).unwrap().remove(0);
        assert!(
            review.can_acknowledge,
            "post-release ancestor validation unavailable in this execution context"
        );
        let held = independent.reviews.remove(&review.review_id).unwrap();
        let _ack_guard = ACK_TEST.lock().unwrap();
        manager()
            .lock()
            .unwrap()
            .reviews
            .insert(review.review_id.clone(), held);
        assert_eq!(
            acknowledge(AcknowledgeRequest {
                review_id: review.review_id,
                acknowledgment: Acknowledgment::ReviewedUtilityClosed,
            })
            .unwrap()
            .outcome,
            "acknowledged"
        );
        assert_eq!(fs::read(payload).unwrap(), payload_bytes);
    }

    struct AdapterFixture {
        effects: NativeEffects,
    }
    impl AdapterFixture {
        fn inert(op: &Operation) -> Self {
            let mut fixture = Self::new();
            fixture.populate_inert(op);
            fixture
        }
        fn populate_inert(&mut self, op: &Operation) {
            let dir = self
                .effects
                .root
                .join(format!("removal-{}", crate::broker::random_id().unwrap()));
            fs::create_dir(&dir).unwrap();
            let path = dir.join(policy(&op.plan.tool_id).unwrap().file_name);
            let original = Pin::create_placeholder(&path).unwrap();
            fs::write(&path, b"inert").unwrap();
            let mut payload = Payload {
                path,
                pins: vec![Pin::open(&dir, true, 0x80000000, 3).unwrap()],
                original: Some(original),
                sealed: None,
            };
            payload.seal().unwrap();
            self.effects.payload = Some(payload);
        }
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "purgeon-adapter-{}",
                crate::broker::random_id().unwrap()
            ));
            fs::create_dir(&root).unwrap();
            let root = crate::updater_native::canonical_temp(&root).unwrap();
            Self {
                effects: NativeEffects {
                    root,
                    payload: None,
                    checkpoint: None,
                },
            }
        }
    }
    impl Drop for AdapterFixture {
        fn drop(&mut self) {
            // Release every pin before removing only this fixture's owned root.
            self.effects.payload.take();
            self.effects.checkpoint.take();
            fs::remove_dir_all(&self.effects.root).unwrap();
        }
    }

    #[test]
    fn actual_checkpoint_handle_survives_failure_and_cleanup_finalization() {
        struct Attempt {
            fixture: AdapterFixture,
            failure: &'static str,
            launches: usize,
        }
        impl Effects for Attempt {
            fn download(&mut self, _: &Operation) -> Result<u64, String> {
                Ok(5)
            }
            fn verify(&mut self, _: &Operation) -> Result<(), String> {
                Ok(())
            }
            fn persist(&mut self, op: &Operation) -> Result<(), String> {
                self.fixture.effects.persist(op)?;
                match self.failure {
                    "persist" => self.fixture.effects.persist(op),
                    "partial" => {
                        self.fixture
                            .effects
                            .checkpoint
                            .as_ref()
                            .unwrap()
                            .set_len(1)
                            .unwrap();
                        Err("simulated interrupted write after checkpoint creation".into())
                    }
                    "cancel" | "cleanup" => {
                        assert!(op.state.lock().unwrap().cancel());
                        op.cancelled.store(true, Ordering::Release);
                        Ok(())
                    }
                    _ => Ok(()),
                }
            }
            fn launch(&mut self) -> Result<(), String> {
                self.launches += 1;
                assert!(fs::remove_file(self.fixture.effects.root.join("launch-intent")).is_err());
                Err("inert launch failure".into())
            }
            fn cleanup(&mut self) -> Result<(), String> {
                assert!(fs::remove_file(self.fixture.effects.root.join("launch-intent")).is_err());
                if self.failure == "cleanup" {
                    Err("inert cleanup failure".into())
                } else {
                    self.fixture.effects.cleanup()
                }
            }
        }
        for failure in ["persist", "partial", "cancel", "launch", "cleanup"] {
            let mut m = cached();
            let op = planned(&mut m);
            let mut attempt = Attempt {
                fixture: AdapterFixture::inert(&op),
                failure,
                launches: 0,
            };
            admit(&op, &m.products).unwrap();
            let result = run(&op, &mut attempt).unwrap();
            assert_eq!(
                result.outcome,
                match failure {
                    "cancel" | "cleanup" => "cancelled",
                    "launch" => "reviewRequired",
                    _ => "failed",
                }
            );
            assert_eq!(attempt.launches, usize::from(failure == "launch"));
            assert_eq!(
                op.snapshot().unwrap().cleanup,
                if ["launch", "cleanup"].contains(&failure) {
                    "retained"
                } else {
                    "removed"
                }
            );
            let marker = attempt.fixture.effects.root.join("launch-intent");
            let bytes = fs::read(&marker).unwrap();
            assert!(fs::remove_file(&marker).is_err());
            assert!(Pin::open(&marker, false, 0x80010000, 1).is_err());
            attempt.fixture.effects.checkpoint.take();
            assert_eq!(fs::read(&marker).unwrap(), bytes);
            let pin = Pin::open(&marker, false, 0x80010000, 1).unwrap();
            if failure == "partial" {
                assert!(
                    validated_checkpoint(&attempt.fixture.effects.root, &marker, &bytes).is_err()
                );
                drop(pin);
                let reviews =
                    discover_reviews(&attempt.fixture.effects.root, &mut cached()).unwrap();
                assert!(!reviews[0].can_acknowledge);
                assert!(has_marker(&attempt.fixture.effects.root).unwrap());
            } else {
                assert!(
                    validated_checkpoint(&attempt.fixture.effects.root, &marker, &bytes).is_ok()
                );
                pin.retire_checkpoint(&bytes).unwrap();
            }
        }
    }

    #[test]
    fn actual_checkpoint_owner_panic_releases_handle_and_preserves_payload() {
        let op = planned(&mut cached());
        let mut fixture = AdapterFixture::inert(&op);
        fixture.effects.persist(&op).unwrap();
        let marker = fixture.effects.root.join("launch-intent");
        let bytes = fs::read(&marker).unwrap();
        let payload = fixture.effects.payload.as_ref().unwrap().path.clone();
        let root = fixture.effects.root.clone();
        let effects = std::mem::replace(
            &mut fixture.effects,
            NativeEffects {
                root,
                payload: None,
                checkpoint: None,
            },
        );
        assert!(std::panic::catch_unwind(move || {
            let _owner = effects;
            panic!("inert owner panic");
        })
        .is_err());
        assert_eq!(fs::read(&marker).unwrap(), bytes);
        assert_eq!(fs::read(payload).unwrap(), b"inert");
        Pin::open(&marker, false, 0x80010000, 1)
            .unwrap()
            .retire_checkpoint(&bytes)
            .unwrap();
    }

    #[test]
    fn actual_checkpoint_child_fixture() {
        let Some(root) = std::env::var_os("PURGEON_CHECKPOINT_CHILD_ROOT") else {
            return;
        };
        let root = PathBuf::from(root);
        let op = planned(&mut cached());
        let mut fixture = AdapterFixture {
            effects: NativeEffects {
                root: root.clone(),
                payload: None,
                checkpoint: None,
            },
        };
        fixture.populate_inert(&op);
        fixture.effects.persist(&op).unwrap();
        fs::write(root.join("ready"), b"ready").unwrap();
        let deadline = Instant::now() + Duration::from_secs(30);
        while Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        panic!("parent did not terminate its checkpoint fixture within 30 seconds");
    }

    #[test]
    fn actual_checkpoint_process_exit_releases_handle_without_changing_bytes() {
        struct ChildGuard(std::process::Child);
        impl Drop for ChildGuard {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let deadline = Instant::now() + Duration::from_secs(10);
                while matches!(self.0.try_wait(), Ok(None)) {
                    if Instant::now() >= deadline {
                        eprintln!("owned checkpoint child cleanup timed out");
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(10));
                }
            }
        }
        let fixture = AdapterFixture::new();
        let root = &fixture.effects.root;
        let mut child = ChildGuard(
            Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "security_software_native::tests::actual_checkpoint_child_fixture",
                    "--nocapture",
                ])
                .env("PURGEON_CHECKPOINT_CHILD_ROOT", root)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .unwrap(),
        );
        let deadline = Instant::now() + Duration::from_secs(15);
        while !root.join("ready").exists() {
            assert!(
                child.0.try_wait().unwrap().is_none(),
                "checkpoint child exited before readiness"
            );
            assert!(
                Instant::now() < deadline,
                "checkpoint child readiness timed out"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        let marker = root.join("launch-intent");
        let bytes = fs::read(&marker).unwrap();
        assert!(Pin::open(&marker, false, 0x80010000, 1).is_err());
        assert!(fs::remove_file(&marker).is_err());
        child.0.kill().unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        while child.0.try_wait().unwrap().is_none() {
            assert!(
                Instant::now() < deadline,
                "owned checkpoint child termination timed out"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(fs::read(&marker).unwrap(), bytes);
        let pin = Pin::open(&marker, false, 0x80010000, 1).unwrap();
        assert!(validated_checkpoint(root, &marker, &bytes).is_ok());
        pin.retire_checkpoint(&bytes).unwrap();
    }

    #[test]
    fn actual_adapter_download_contract_and_rejections() {
        let mut manager = cached();
        let op = planned(&mut manager);
        let p = policy(&op.plan.tool_id).unwrap();
        for (response, contents, expected) in [
            (Ok(r#"{"bytes":3}"#), &b"abc"[..], Ok(3)),
            (
                Err("fixture runner failure"),
                &b"abc"[..],
                Err("fixture runner failure"),
            ),
            (Ok("invalid"), &b"abc"[..], Err("Invalid download response")),
            (
                Ok(r#"{"bytes":3,"extra":true}"#),
                &b"abc"[..],
                Err("Invalid download response"),
            ),
            (Ok("{}"), &b"abc"[..], Err("Invalid download response")),
            (
                Ok(r#"{"bytes":0}"#),
                &b"abc"[..],
                Err("Download byte limit rejected"),
            ),
            (
                Ok(r#"{"bytes":134217729}"#),
                &b"abc"[..],
                Err("Download byte limit rejected"),
            ),
            (
                Ok(r#"{"bytes":3}"#),
                &b""[..],
                Err("Download size rejected"),
            ),
            (
                Ok(r#"{"bytes":4}"#),
                &b"abc"[..],
                Err("Download byte count mismatch"),
            ),
        ] {
            let mut fixture = AdapterFixture::new();
            let root = fixture.effects.root.clone();
            let mut called = false;
            let result = fixture
                .effects
                .download_with(&op, |source, input, timeout, cancel| {
                    called = true;
                    assert_eq!(source, include_str!("security_software/download.ps1"));
                    assert_eq!(timeout, Duration::from_secs(180));
                    assert!(std::ptr::eq(cancel, &op.cancelled));
                    let path = PathBuf::from(input["path"].as_str().unwrap());
                    assert_eq!(
                        input,
                        serde_json::json!({"url":p.url,"hostName":p.host,"path":path})
                    );
                    assert_eq!(path.file_name().unwrap(), "avg_av_clear.exe");
                    assert_eq!(path.parent().unwrap().parent().unwrap(), root);
                    assert!(path
                        .parent()
                        .unwrap()
                        .file_name()
                        .unwrap()
                        .to_str()
                        .unwrap()
                        .starts_with("removal-"));
                    assert!(path.is_file());
                    assert_eq!(fs::metadata(&path).unwrap().len(), 0);
                    fs::write(path, contents).unwrap();
                    response
                        .map(|v| v.as_bytes().to_vec())
                        .map_err(str::to_owned)
                });
            assert!(called, "download runner was not reached: {result:?}");
            assert_eq!(
                result.as_ref().map(|v| *v).map_err(String::as_str),
                expected
            );
            if result.is_ok() {
                let payload = fixture.effects.payload.as_ref().unwrap();
                assert!(payload.sealed.is_some());
                payload.recheck().unwrap();
            }
            fixture.effects.cleanup().unwrap();
            assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
            drop(fixture);
            assert!(!root.exists());
        }
    }

    #[test]
    fn actual_adapter_verify_contract_tampering_and_rejections() {
        let mut manager = cached();
        let op = planned(&mut manager);
        let p = policy(&op.plan.tool_id).unwrap();
        let accepted = serde_json::json!({"subject":p.subject,"product":p.product,"description":p.description});
        let mut absent = AdapterFixture::new();
        assert_eq!(
            absent.effects.verify_with(&op, |_, _, _, _| panic!(
                "absent payload must not call runner"
            )),
            Err("Payload unavailable".into())
        );
        for mode in [
            "success",
            "runner",
            "json",
            "unknown",
            "missing",
            "signer",
            "product",
            "description",
        ] {
            let mut fixture = AdapterFixture::new();
            fixture
                .effects
                .download_with(&op, |_, input, _, _| {
                    fs::write(input["path"].as_str().unwrap(), b"abc").unwrap();
                    Ok(br#"{"bytes":3}"#.to_vec())
                })
                .unwrap();
            let path = fixture.effects.payload.as_ref().unwrap().path.clone();
            let mut called = false;
            let result = fixture
                .effects
                .verify_with(&op, |source, input, timeout, cancel| {
                    called = true;
                    assert_eq!(source, include_str!("security_software/verify.ps1"));
                    assert_eq!(input, serde_json::json!({"path":path}));
                    assert_eq!(timeout, Duration::from_secs(60));
                    assert!(std::ptr::eq(cancel, &op.cancelled));
                    assert!(fs::write(&path, b"tampered").is_err());
                    assert!(fs::rename(&path, path.with_extension("moved")).is_err());
                    assert!(fs::remove_file(&path).is_err());
                    assert_eq!(fs::read(&path).unwrap(), b"abc");
                    let mut response = accepted.clone();
                    match mode {
                        "runner" => return Err("fixture runner failure".into()),
                        "json" => return Ok(b"invalid".to_vec()),
                        "unknown" => response["extra"] = serde_json::json!(true),
                        "missing" => {
                            response.as_object_mut().unwrap().remove("subject");
                        }
                        "signer" => response["subject"] = serde_json::json!("untrusted"),
                        "product" => response["product"] = serde_json::json!("wrong"),
                        "description" => response["description"] = serde_json::json!("wrong"),
                        "success" => (),
                        _ => unreachable!(),
                    }
                    Ok(serde_json::to_vec(&response).unwrap())
                });
            assert!(called, "verify runner was not reached: {result:?}");
            let expected = match mode {
                "success" => Ok(()),
                "runner" => Err("fixture runner failure".into()),
                "json" | "unknown" | "missing" => Err("Invalid signature helper response".into()),
                "signer" => check_signer(&p, "untrusted", p.product, p.description),
                "product" => check_signer(&p, p.subject, "wrong", p.description),
                "description" => check_signer(&p, p.subject, p.product, "wrong"),
                _ => unreachable!(),
            };
            assert_eq!(result, expected, "{mode}");
            fixture.effects.payload.as_ref().unwrap().recheck().unwrap();
            fixture.effects.cleanup().unwrap();
            assert!(!path.exists());
        }
    }

    #[test]
    fn actual_fixed_downloader_guards_and_streams_inert_http_fixtures() {
        let fixture = r#"
Microsoft.PowerShell.Utility\Add-Type -ReferencedAssemblies System.Net.Http -TypeDefinition @'
using System;
using System.Net;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
public sealed class FixtureHandler : HttpMessageHandler {
    public static string Mode;
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token) {
        if (Mode == "timeout") return Task.FromCanceled<HttpResponseMessage>(new CancellationToken(true));
        var response = new HttpResponseMessage(HttpStatusCode.OK);
        response.Content = new ByteArrayContent(Mode == "empty" ? new byte[0] : new byte[] {65,66,67});
        if (Mode == "truncated") response.Content.Headers.ContentLength = 9;
        if (Mode == "oversized") response.Content.Headers.ContentLength = 134217729;
        if (Mode == "redirect" || Mode == "foreign") {
            response.StatusCode = HttpStatusCode.Redirect;
            response.Headers.Location = new Uri(Mode == "foreign" ? "https://foreign.invalid/file" : "https://fixture.invalid/again");
        }
        return Task.FromResult(response);
    }
}
'@
[FixtureHandler]::Mode = '__MODE__'
"#;
        let source = include_str!("security_software/download.ps1");
        for mode in [
            "success",
            "empty",
            "truncated",
            "oversized",
            "redirect",
            "foreign",
            "timeout",
            "endpoint",
        ] {
            let path = std::env::temp_dir().join(format!(
                "purgeon-http-{}",
                crate::broker::random_id().unwrap()
            ));
            fs::write(&path, b"").unwrap();
            // Only the transport is injected. Guard, stream and count code is unchanged.
            let test_script = source.replace(
                "$client = New-Object Net.Http.HttpClient($handler)",
                &format!(
                    "{}\n$client = New-Object Net.Http.HttpClient((New-Object FixtureHandler))",
                    fixture.replace("__MODE__", mode)
                ),
            );
            assert_ne!(test_script, source);
            let url = if mode == "endpoint" {
                "http://fixture.invalid/file"
            } else {
                "https://fixture.invalid/file"
            };
            let output = script(
                &test_script,
                serde_json::json!({"url":url,"hostName":"fixture.invalid","path":path}),
                Duration::from_secs(20),
                &AtomicBool::new(false),
            );
            if mode == "success" {
                let response: serde_json::Value = serde_json::from_slice(&output.unwrap()).unwrap();
                assert_eq!(response["bytes"], 3);
                assert_eq!(fs::read(&path).unwrap(), b"ABC");
            } else {
                assert!(output.is_err(), "{mode}");
            }
            fs::remove_file(path).unwrap();
        }
    }

    fn checkpoint_bytes(root: &Path, id: &str) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({"schemaVersion":1,"id":id,"toolId":"avg","phase":"reviewRequired","detail":"Utility may have started; no automatic retry","payload":root.join(format!("removal-{id}")).join("avg_av_clear.exe")})).unwrap()
    }
    #[test]
    fn checkpoint_payload_basename_is_bound_to_tool() {
        let root = Path::new(r"C:\native-root");
        let id = "a".repeat(32);
        for (tool, filename) in [
            ("avg", "avg_av_clear.exe"),
            ("avast", "avast_av_clear.exe"),
            ("norton", "norton_360_remover.exe"),
            ("mcafee", "MCPR.exe"),
        ] {
            let mut value: serde_json::Value =
                serde_json::from_slice(&checkpoint_bytes(root, &id)).unwrap();
            value["toolId"] = serde_json::json!(tool);
            value["payload"] = serde_json::json!(root.join(format!("removal-{id}")).join(filename));
            assert!(
                validated_checkpoint(
                    root,
                    &root.join("launch-intent"),
                    &serde_json::to_vec(&value).unwrap()
                )
                .is_ok(),
                "{tool}"
            );
            for invalid in [
                "VendorRemoval.exe",
                "arbitrary.exe",
                "../avg_av_clear.exe",
                if tool == "avg" {
                    "avast_av_clear.exe"
                } else {
                    "avg_av_clear.exe"
                },
            ] {
                value["payload"] =
                    serde_json::json!(root.join(format!("removal-{id}")).join(invalid));
                assert!(
                    validated_checkpoint(
                        root,
                        &root.join("launch-intent"),
                        &serde_json::to_vec(&value).unwrap()
                    )
                    .is_err(),
                    "{tool}: {invalid}"
                );
            }
        }
    }
    #[test]
    fn registry_names_exclude_nonsecurity_products_and_preserve_help() {
        let inventory = normalize(
            snapshot(vec![
                record("AVG TuneUp", "AVG Technologies", SOURCE_IDS[3]),
                record("Avast Secure Browser", "Avast Software", SOURCE_IDS[3]),
                record("Norton Password Manager", "Gen Digital Inc.", SOURCE_IDS[3]),
                record("ESET NOD32 Antivirus", "ESET", SOURCE_IDS[3]),
                record("Avast One", "Avast Software", SOURCE_IDS[3]),
                record("Unknown protection", "", SOURCE_IDS[0]),
            ]),
            &[],
        )
        .unwrap();
        assert_eq!(inventory.products.len(), 3);
        assert_eq!(
            inventory
                .products
                .iter()
                .find(|p| p.name.starts_with("ESET"))
                .unwrap()
                .help_url
                .as_deref(),
            Some(ESET_HELP)
        );
        assert!(inventory
            .products
            .iter()
            .filter(|p| !p.name.starts_with("ESET"))
            .all(|p| p.help_url.is_none() && p.tool_id.is_none()));
    }
    #[test]
    fn checkpoint_contract_rejects_self_attested_foreign_paths_and_schema() {
        let root = Path::new(r"C:\native-root");
        let id = "a".repeat(32);
        let bytes = checkpoint_bytes(root, &id);
        assert!(validated_checkpoint(root, &root.join("launch-intent"), &bytes).is_ok());
        assert!(validated_checkpoint(root, &root.join("norton.launch-intent"), &bytes).is_err());
        for (field, value) in [
            ("schemaVersion", serde_json::json!(2)),
            ("id", serde_json::json!("bad")),
            ("toolId", serde_json::json!("unknown")),
            ("phase", serde_json::json!("launched")),
            ("payload", serde_json::json!("C:/foreign/VendorRemoval.exe")),
            ("extra", serde_json::json!(true)),
        ] {
            let mut changed: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            changed[field] = value;
            assert!(
                validated_checkpoint(
                    root,
                    &root.join("launch-intent"),
                    &serde_json::to_vec(&changed).unwrap()
                )
                .is_err(),
                "{field}"
            );
        }
    }
    #[test]
    fn retained_checkpoint_handle_rejects_stale_bytes_and_deletes_only_marker() {
        let root = std::env::temp_dir().join(format!(
            "purgeon-ack-{}",
            crate::broker::random_id().unwrap()
        ));
        fs::create_dir(&root).unwrap();
        let root = crate::updater_native::canonical_temp(&root).unwrap();
        let path = root.join("launch-intent");
        let payload = root.join("retained-payload");
        fs::write(&payload, b"inert fixture").unwrap();
        fs::write(&path, b"checkpoint").unwrap();
        let held = Pin::open(&path, false, 0x80010000, 1).unwrap();
        assert!(held.retire_checkpoint(b"stale").is_err());
        assert!(fs::write(&path, b"substitute").is_err());
        assert!(fs::remove_file(&path).is_err());
        assert!(held.read_bounded(2).is_err());
        assert_eq!(held.read_bounded(4096).unwrap(), b"checkpoint");
        held.retire_checkpoint(b"checkpoint").unwrap();
        drop(held);
        assert!(!path.exists());
        assert_eq!(fs::read(&payload).unwrap(), b"inert fixture");
        fs::remove_file(payload).unwrap();
        fs::remove_dir(root).unwrap();
    }
    #[test]
    fn actual_acknowledgment_retires_consumed_plan_without_touching_payload() {
        let _ack_guard = ACK_TEST.lock().unwrap();
        let root = std::env::temp_dir().join(format!(
            "purgeon-ack-state-{}",
            crate::broker::random_id().unwrap()
        ));
        fs::create_dir(&root).unwrap();
        let root = crate::updater_native::canonical_temp(&root).unwrap();
        let mut local = cached();
        let op = planned(&mut local);
        op.state.lock().unwrap().phase = "launched";
        let bytes = checkpoint_bytes(&root, &op.plan.id);
        let path = root.join("launch-intent");
        fs::write(&path, &bytes).unwrap();
        let payload = root.join("inert-payload");
        fs::write(&payload, b"retain").unwrap();
        let review_id = crate::broker::random_id().unwrap();
        let held = HeldReview {
            dto: RemovalReview {
                review_id: review_id.clone(),
                tool_id: Some("avg".into()),
                plan_id: Some(op.plan.id.clone()),
                state: "reviewRequired".into(),
                detail: RECOVERY.into(),
                can_acknowledge: true,
            },
            pin: Pin::open(&path, false, 0x80010000, 1).unwrap(),
            bytes,
            _parents: vec![],
        };
        {
            let mut global = manager().lock().unwrap();
            global.operations.insert(op.plan.id.clone(), op.clone());
            global.reviews.insert(review_id.clone(), held);
        }
        op.state.lock().unwrap().phase = "verifying";
        assert!(acknowledge(AcknowledgeRequest {
            review_id: review_id.clone(),
            acknowledgment: Acknowledgment::ReviewedUtilityClosed
        })
        .is_err());
        assert!(path.exists());
        op.state.lock().unwrap().phase = "reviewRequired";
        let result = acknowledge(AcknowledgeRequest {
            review_id: review_id.clone(),
            acknowledgment: Acknowledgment::ReviewedUtilityClosed,
        })
        .unwrap();
        assert_eq!(result.outcome, "acknowledged");
        assert_eq!(op.snapshot().unwrap().phase, "acknowledged");
        assert_eq!(
            admit(&op, &[]).unwrap_err(),
            "Plan is cancelled or already consumed"
        );
        assert!(!path.exists());
        assert_eq!(fs::read(&payload).unwrap(), b"retain");
        assert!(acknowledge(AcknowledgeRequest {
            review_id,
            acknowledgment: Acknowledgment::ReviewedUtilityClosed
        })
        .is_err());
        manager().lock().unwrap().operations.remove(&op.plan.id);
        let product_id = local.products[0].id.clone();
        assert!(prepare_cached(&mut local, PrepareRequest { product_id }).is_ok());
        fs::remove_file(payload).unwrap();
        fs::remove_dir(root).unwrap();
    }
    #[test]
    fn malformed_global_checkpoint_has_no_vendor_and_blocks_launch() {
        let root = std::env::temp_dir().join(format!(
            "purgeon-unreadable-{}",
            crate::broker::random_id().unwrap()
        ));
        fs::create_dir(&root).unwrap();
        let root = crate::updater_native::canonical_temp(&root).unwrap();
        let path = root.join("launch-intent");
        fs::write(&path, b"malformed checkpoint").unwrap();
        let mut session = cached();
        let reviews = discover_reviews(&root, &mut session).unwrap();
        assert_eq!(reviews.len(), 1);
        assert!(reviews[0].tool_id.is_none());
        assert_eq!(reviews[0].state, "unreadable");
        assert!(!reviews[0].can_acknowledge);
        assert!(session.reviews.is_empty());
        assert!(has_marker(&root).unwrap());
        assert!(launch_root(|| Ok(root.clone()), |_| Ok(()), has_marker).is_err());
        fs::remove_file(path).unwrap();
        fs::remove_dir(root).unwrap();
    }

    #[test]
    fn restart_discovery_preserves_identity_until_explicit_review() {
        let root = std::env::temp_dir().join(format!(
            "purgeon-review-{}",
            crate::broker::random_id().unwrap()
        ));
        fs::create_dir(&root).unwrap();
        let root = crate::updater_native::canonical_temp(&root).unwrap();
        let id = crate::broker::random_id().unwrap();
        let path = root.join("launch-intent");
        fs::write(&path, checkpoint_bytes(&root, &id)).unwrap();
        let mut session = Manager::default();
        let first = discover_reviews(&root, &mut session).unwrap();
        // Restricted-worker ancestor denial must fail this gate, never be waived.
        assert!(
            first[0].can_acknowledge,
            "ancestor validation unavailable in this execution context"
        );
        let second = discover_reviews(&root, &mut session).unwrap();
        assert_eq!(first[0].review_id, second[0].review_id);
        drop(session);
        let mut restarted = Manager::default();
        let after_restart = discover_reviews(&root, &mut restarted).unwrap();
        assert!(after_restart[0].can_acknowledge);
        assert_ne!(first[0].review_id, after_restart[0].review_id);
        assert_eq!(after_restart[0].plan_id.as_deref(), Some(id.as_str()));
        drop(restarted);
        fs::remove_file(path).unwrap();
        fs::remove_dir(root).unwrap();
    }

    #[test]
    fn acknowledgment_request_is_closed_and_literal_required() {
        assert!(serde_json::from_value::<AcknowledgeRequest>(serde_json::json!({"reviewId":"a".repeat(32),"acknowledgment":"reviewedUtilityClosed","extra":true})).is_err());
        assert!(serde_json::from_value::<AcknowledgeRequest>(
            serde_json::json!({"reviewId":"a".repeat(32),"acknowledgment":"reviewedUtilityClosed"})
        )
        .is_ok());
        for acknowledgment in [serde_json::json!("removed"), serde_json::Value::Null] {
            assert!(serde_json::from_value::<AcknowledgeRequest>(
                serde_json::json!({"reviewId":"a".repeat(32),"acknowledgment":acknowledgment})
            )
            .is_err());
        }
        assert!(acknowledge(AcknowledgeRequest {
            review_id: "a".repeat(32),
            acknowledgment: Acknowledgment::ReviewedUtilityClosed
        })
        .is_err());
    }

    fn snapshot(records: Vec<Record>) -> Snapshot {
        Snapshot {
            records,
            sources: SOURCE_IDS
                .iter()
                .map(|id| Source {
                    id: (*id).into(),
                    status: "ok".into(),
                    detail: String::new(),
                })
                .collect(),
        }
    }
    fn record(name: &str, publisher: &str, source: &str) -> Record {
        Record {
            name: name.into(),
            publisher: publisher.into(),
            version: String::new(),
            source: source.into(),
            state: "unknown".into(),
        }
    }
    fn cached() -> Manager {
        Manager {
            products: normalize(
                snapshot(vec![record(
                    "AVG AntiVirus FREE",
                    "AVG Technologies",
                    SOURCE_IDS[3],
                )]),
                &[],
            )
            .unwrap()
            .products,
            operations: HashMap::new(),
            reviews: HashMap::new(),
        }
    }
    fn planned(m: &mut Manager) -> Arc<Operation> {
        let id = m.products[0].id.clone();
        let plan = prepare_cached(m, PrepareRequest { product_id: id }).unwrap();
        m.operations.get(&plan.id).unwrap().clone()
    }
    fn finalize_inventory(
        manager: &Mutex<Manager>,
        raw: Result<Vec<u8>, String>,
        discover: impl FnOnce(&mut Manager) -> Result<Vec<RemovalReview>, String>,
    ) -> Result<Inventory, String> {
        let gate = Mutex::new(());
        let result = inventory_with(manager, &gate, || raw, discover);
        assert!(
            gate.try_lock().is_ok(),
            "completed refresh retained its gate"
        );
        result
    }

    #[test]
    fn launch_admission_orders_with_inventory_invalidation() {
        for launch_first in [false, true] {
            let mutex = Mutex::new(cached());
            let op = planned(&mut mutex.lock().unwrap());
            let gate = Mutex::new(());
            let (entered_tx, entered_rx) = std::sync::mpsc::channel();
            let (release_tx, release_rx) = std::sync::mpsc::channel();
            std::thread::scope(|scope| {
                if launch_first {
                    assert!(Arc::ptr_eq(
                        &admit_cached(&mutex, &op.plan.id).unwrap(),
                        &op
                    ));
                }
                let (manager, gate) = (&mutex, &gate);
                let refresh = scope.spawn(move || {
                    inventory_with(
                        manager,
                        gate,
                        || {
                            entered_tx.send(()).unwrap();
                            release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
                            Ok(inventory_bytes(vec![], "ok"))
                        },
                        |_| Ok(vec![]),
                    )
                });
                entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
                let mut effects = Fake::default();
                let mut setup_calls = 0;
                let admission = (!launch_first).then(|| {
                    launch_with(&mutex, &op.plan.id, &mut effects, |_| {
                        setup_calls += 1;
                        Ok(())
                    })
                });
                release_tx.send(()).unwrap();
                refresh.join().unwrap().unwrap();
                if let Some(admission) = admission {
                    assert_eq!(setup_calls, 0);
                    assert!(effects.calls.is_empty());
                    let detail = admission.err().expect("stale launch was admitted");
                    let status = op.snapshot().unwrap();
                    assert_eq!(status.phase, "failed");
                    assert_eq!(status.detail, detail);
                    assert!(detail.contains("prepare a new plan"));
                    assert_eq!(status.cleanup, "none");
                    assert_eq!(status.bytes_received, 0);
                } else {
                    assert_eq!(op.snapshot().unwrap().phase, "downloading");
                }
            });
        }
    }

    #[test]
    fn launch_admission_requires_exact_published_product_and_tool() {
        for (id, tool) in [
            (Some("replacement"), Some("avg")),
            (None, Some("avast")),
            (None, None),
        ] {
            let mut m = cached();
            let op = planned(&mut m);
            if let Some(id) = id {
                m.products[0].id = id.into();
            }
            m.products[0].tool_id = tool.map(str::to_owned);
            let mutex = Mutex::new(m);
            assert!(admit_cached(&mutex, &op.plan.id).is_err());
            assert_eq!(op.snapshot().unwrap().phase, "failed");
        }
        let mutex = Mutex::new(cached());
        let op = planned(&mut mutex.lock().unwrap());
        finalize_inventory(&mutex, Ok(inventory_bytes(vec![], "ok")), |_| Ok(vec![])).unwrap();
        assert!(admit_cached(&mutex, &op.plan.id).is_err());
        assert_eq!(op.snapshot().unwrap().phase, "failed");
    }

    #[test]
    fn launch_admission_accepts_unchanged_complete_or_partial_inventory() {
        for source_status in ["ok", "error"] {
            let mutex = Mutex::new(cached());
            let op = planned(&mut mutex.lock().unwrap());
            let raw = inventory_bytes(
                vec![record(
                    "AVG AntiVirus FREE",
                    "AVG Technologies",
                    SOURCE_IDS[3],
                )],
                source_status,
            );
            let view = finalize_inventory(&mutex, Ok(raw), |_| Ok(vec![])).unwrap();
            assert_eq!(view.complete, source_status == "ok");
            assert!(Arc::ptr_eq(
                &admit_cached(&mutex, &op.plan.id).unwrap(),
                &op
            ));
            assert_eq!(op.snapshot().unwrap().phase, "downloading");
        }
    }

    #[test]
    fn inventory_refresh_admission_blocks_stale_preparation() {
        let mutex = Mutex::new(cached());
        let gate = Mutex::new(());
        let product_id = mutex.lock().unwrap().products[0].id.clone();
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        std::thread::scope(|scope| {
            let manager = &mutex;
            let refresh_gate = &gate;
            let refresh = scope.spawn(move || {
                inventory_with(
                    manager,
                    refresh_gate,
                    || {
                        entered_tx.send(()).unwrap();
                        release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
                        Ok(inventory_bytes(
                            vec![record(
                                "AVG AntiVirus FREE",
                                "AVG Technologies",
                                SOURCE_IDS[3],
                            )],
                            "ok",
                        ))
                    },
                    |_| Ok(vec![]),
                )
            });
            entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            let preparation = prepare_cached(
                &mut mutex.try_lock().unwrap(),
                PrepareRequest {
                    product_id: product_id.clone(),
                },
            );
            let overlap = inventory_with(
                &mutex,
                &gate,
                || panic!("overlapping helper ran"),
                |_| panic!("overlapping discovery ran"),
            );
            release_tx.send(()).unwrap();
            let result = refresh.join().unwrap().unwrap();
            assert!(
                preparation.is_err(),
                "refresh admitted stale product preparation"
            );
            assert_eq!(
                overlap.unwrap_err(),
                "Inventory refresh already in progress"
            );
            assert_eq!(result.products[0].id, product_id);
        });
    }
    #[test]
    fn inventory_refresh_public_entry() {
        let job = crate::security::ProcessJob::create(None).unwrap();
        let temp = crate::updater_native::canonical_temp(&std::env::temp_dir()).unwrap();
        let root = temp.join(format!(
            "purgeon-inventory-entry-{}",
            crate::broker::random_id().unwrap()
        ));
        fs::create_dir(&root).unwrap();
        let owned = crate::updater_native::canonical_temp(&root).unwrap();
        let result = std::panic::catch_unwind(|| {
            let mut command = Command::new(std::env::current_exe().unwrap());
            command
                .args([
                    "--exact",
                    "security_software_native::tests::inventory_refresh_public_entry_child",
                    "--test-threads=1",
                ])
                .env("APPDATA", &owned)
                .env("PURGEON_INVENTORY_ENTRY_ROOT", &owned)
                .creation_flags(0x08000000);
            let output = crate::process_io::execute_in_job(
                &mut command,
                None,
                Duration::from_secs(90),
                64 * 1024,
                Some(&job),
                |_| Ok(()),
            );
            assert!(output.is_ok(), "public inventory child execution failed");
            assert!(
                output.unwrap().status.success(),
                "public inventory child assertions failed"
            );
        });
        // Never remove a fixture while its child may still be using it, even after a panic.
        assert!(
            job.terminate_and_confirm(Instant::now() + Duration::from_secs(5))
                .is_ok(),
            "child containment unconfirmed; owned fixture retained"
        );
        use std::os::windows::fs::MetadataExt;
        // Check the exact exclusively created root and every descendant before deletion.
        assert_eq!(root.parent(), Some(temp.as_path()));
        assert_eq!(crate::updater_native::canonical_temp(&root).unwrap(), owned);
        let mut pending = vec![root.clone()];
        while let Some(path) = pending.pop() {
            let metadata = fs::symlink_metadata(&path).unwrap();
            assert_eq!(metadata.file_attributes() & 0x400, 0);
            if metadata.is_dir() {
                for entry in fs::read_dir(path).unwrap() {
                    pending.push(entry.unwrap().path());
                }
            }
        }
        fs::remove_dir_all(&root).unwrap();
        if let Err(panic) = result {
            std::panic::resume_unwind(panic);
        }
    }

    #[test]
    fn inventory_refresh_public_entry_child() {
        let Some(root) = std::env::var_os("PURGEON_INVENTORY_ENTRY_ROOT") else {
            return;
        };
        use std::os::windows::fs::MetadataExt;
        let root = PathBuf::from(root);
        assert!(root.is_absolute());
        let metadata = fs::symlink_metadata(&root).unwrap();
        assert!(metadata.is_dir());
        assert_eq!(metadata.file_attributes() & 0x400, 0);
        let root = crate::updater_native::canonical_temp(&root).unwrap();
        assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
        assert_eq!(std::env::var_os("APPDATA").unwrap(), root.as_os_str());
        let exe = std::env::current_exe().unwrap();
        assert!(!exe
            .file_stem()
            .unwrap()
            .to_string_lossy()
            .to_lowercase()
            .contains("portable"));
        assert!(matches!(
            fs::symlink_metadata(exe.parent().unwrap().join("portable")),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound
        ));
        let before = now().unwrap();
        let result = inventory();
        assert!(result.is_ok(), "public inventory failed");
        let view = result.unwrap();
        assert_eq!(view.sources.len(), SOURCE_IDS.len());
        for id in SOURCE_IDS {
            assert_eq!(
                view.sources.iter().filter(|source| source.id == id).count(),
                1
            );
        }
        assert!(view
            .sources
            .iter()
            .all(|source| matches!(source.status.as_str(), "ok" | "error" | "unavailable")));
        assert_eq!(
            view.complete,
            view.sources.iter().all(|source| source.status == "ok")
        );
        assert!(
            (before..=now().unwrap()).any(|second| timestamp(second).unwrap() == view.observed_at)
        );
        assert!(view.reviews.is_empty());
        let manager = manager().lock().unwrap();
        assert!(manager
            .products
            .iter()
            .map(|p| &p.id)
            .eq(view.products.iter().map(|p| &p.id)));
        drop(manager);
        let app = root.join("com.seanshaffer.sweepuninstall");
        let native = app.join("SecuritySoftware");
        assert_eq!(
            crate::updater_native::canonical_temp(&native).unwrap(),
            native
        );
        assert_eq!(
            native_root().unwrap(),
            crate::updater_native::canonical_temp(&native).unwrap()
        );
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        assert_eq!(fs::read_dir(&app).unwrap().count(), 1);
        assert_eq!(fs::read_dir(&native).unwrap().count(), 0);
        for path in [&app, &native] {
            assert_eq!(
                fs::symlink_metadata(path).unwrap().file_attributes() & 0x400,
                0
            );
        }
    }

    #[test]
    fn inventory_refresh_poisoned_gate_rejects_before_helper() {
        let mutex = Mutex::new(cached());
        let gate = Mutex::new(());
        let _ = std::panic::catch_unwind(|| {
            let _guard = gate.lock().unwrap();
            panic!("poison fixture");
        });
        assert_eq!(
            inventory_with(
                &mutex,
                &gate,
                || panic!("poisoned gate ran helper"),
                |_| panic!("poisoned gate ran discovery")
            )
            .unwrap_err(),
            "Inventory unavailable"
        );
    }

    #[test]
    fn inventory_refresh_helper_panic_keeps_cache_ineligible_and_gate_closed() {
        let mutex = Mutex::new(cached());
        let gate = Mutex::new(());
        let mut m = mutex.lock().unwrap();
        let op = planned(&mut m);
        let product_id = m.products[0].id.clone();
        drop(m);
        assert!(std::panic::catch_unwind(|| inventory_with(
            &mutex,
            &gate,
            || panic!("helper fixture panic"),
            |_| panic!("panic reached discovery")
        ))
        .is_err());
        let mut m = mutex.try_lock().unwrap();
        assert!(m.products.is_empty());
        assert!(prepare_cached(&mut m, PrepareRequest { product_id }).is_err());
        assert!(Arc::ptr_eq(&m.operations[&op.plan.id], &op));
        assert_eq!(op.snapshot().unwrap().phase, "prepared");
        op.state.lock().unwrap().cancel();
        assert_eq!(op.snapshot().unwrap().phase, "cancelled");
        drop(m);
        assert!(gate.is_poisoned());
        assert_eq!(
            inventory_with(
                &mutex,
                &gate,
                || panic!("poisoned gate retried helper"),
                |_| Ok(vec![])
            )
            .unwrap_err(),
            "Inventory unavailable"
        );
    }

    #[test]
    fn inventory_refresh_manager_poisoned_during_helper_rejects_publication() {
        let mutex = Mutex::new(cached());
        let gate = Mutex::new(());
        let result = inventory_with(
            &mutex,
            &gate,
            || {
                let _ = std::panic::catch_unwind(|| {
                    let m = mutex.lock().unwrap();
                    assert!(m.products.is_empty());
                    panic!("manager fixture panic");
                });
                Ok(inventory_bytes(vec![], "ok"))
            },
            |_| panic!("poisoned manager reached discovery"),
        );
        assert_eq!(result.unwrap_err(), "Inventory unavailable");
        assert!(!gate.is_poisoned());
        assert!(gate.try_lock().is_ok());
    }

    #[test]
    fn inventory_refresh_discovery_panic_rejects_future_refresh() {
        let mutex = Mutex::new(cached());
        let gate = Mutex::new(());
        assert!(std::panic::catch_unwind(|| inventory_with(
            &mutex,
            &gate,
            || Ok(inventory_bytes(vec![], "ok")),
            |m| {
                assert!(m.products.is_empty());
                panic!("discovery fixture panic");
            }
        ))
        .is_err());
        assert!(mutex.is_poisoned());
        assert!(gate.is_poisoned());
        assert_eq!(
            inventory_with(
                &mutex,
                &gate,
                || panic!("poisoned refresh ran helper"),
                |_| Ok(vec![])
            )
            .unwrap_err(),
            "Inventory unavailable"
        );
    }
    #[test]
    fn inventory_refresh_poisoned_manager_rejects_before_discovery() {
        let mutex = Mutex::new(cached());
        let _ = std::panic::catch_unwind(|| {
            let _guard = mutex.lock().unwrap();
            panic!("poison fixture");
        });
        assert_eq!(
            inventory_with(
                &mutex,
                &Mutex::new(()),
                || panic!("poisoned manager reached helper"),
                |_| { panic!("poisoned manager reached discovery") }
            )
            .unwrap_err(),
            "Inventory unavailable"
        );
        assert!(mutex.is_poisoned());
        assert!(matches!(
            mutex.try_lock(),
            Err(std::sync::TryLockError::Poisoned(_))
        ));
    }
    #[test]
    fn inventory_refresh_rejects_stale_preparation_after_invalid_json() {
        let mutex = Mutex::new(cached());
        let m = mutex.lock().unwrap();
        let product_id = m.products[0].id.clone();
        drop(m);
        assert_eq!(
            finalize_inventory(&mutex, Ok(b"invalid".to_vec()), |_| panic!(
                "invalid JSON reached discovery"
            ))
            .unwrap_err(),
            "Invalid inventory helper response"
        );
        let mut m = mutex.try_lock().unwrap();
        assert!(m.products.is_empty());
        assert_eq!(
            prepare_cached(&mut m, PrepareRequest { product_id }).unwrap_err(),
            "Product is absent from native inventory"
        );
    }
    fn inventory_bytes(records: Vec<Record>, source_status: &str) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "records": records.into_iter().map(|r| serde_json::json!({
                "name": r.name, "publisher": r.publisher, "version": r.version,
                "source": r.source, "state": r.state
            })).collect::<Vec<_>>(),
            "sources": SOURCE_IDS.iter().map(|id| serde_json::json!({
                "id": id, "status": source_status, "detail": ""
            })).collect::<Vec<_>>()
        }))
        .unwrap()
    }
    #[test]
    fn inventory_refresh_invalid_snapshots_clear_eligibility() {
        let mut duplicate_source: serde_json::Value =
            serde_json::from_slice(&inventory_bytes(vec![], "ok")).unwrap();
        duplicate_source["sources"][0]["id"] = SOURCE_IDS[1].into();
        for (raw, expected) in [
            (
                serde_json::to_vec(&duplicate_source).unwrap(),
                "Inventory source identity invalid",
            ),
            (inventory_bytes(vec![], "invalid"), "Invalid source outcome"),
            (
                inventory_bytes(vec![record(&"x".repeat(513), "", SOURCE_IDS[0])], "ok"),
                "Invalid inventory record",
            ),
            (
                br#"{"records":[],"sources":[]}"#.to_vec(),
                "Inventory exceeds bounds or misses sources",
            ),
        ] {
            let mutex = Mutex::new(cached());
            let m = mutex.lock().unwrap();
            let product_id = m.products[0].id.clone();
            drop(m);
            assert_eq!(
                finalize_inventory(&mutex, Ok(raw), |_| panic!(
                    "invalid snapshot reached recovery"
                ))
                .unwrap_err(),
                expected
            );
            let mut m = mutex.try_lock().unwrap();
            assert!(m.products.is_empty());
            assert_eq!(
                prepare_cached(&mut m, PrepareRequest { product_id }).unwrap_err(),
                "Product is absent from native inventory"
            );
        }
    }
    #[test]
    fn inventory_refresh_recovery_failure_publishes_no_replacement() {
        let mutex = Mutex::new(cached());
        let m = mutex.lock().unwrap();
        let product_id = m.products[0].id.clone();
        let raw = inventory_bytes(
            vec![record(
                "Avast Free Antivirus",
                "Avast Software",
                SOURCE_IDS[3],
            )],
            "ok",
        );
        drop(m);
        assert_eq!(
            finalize_inventory(&mutex, Ok(raw), |m| {
                assert!(m.products.is_empty());
                assert!(matches!(
                    mutex.try_lock(),
                    Err(std::sync::TryLockError::WouldBlock)
                ));
                Err("recovery fixture failure".into())
            })
            .unwrap_err(),
            "recovery fixture failure"
        );
        let mut m = mutex.try_lock().unwrap();
        assert!(m.products.is_empty());
        assert_eq!(
            prepare_cached(&mut m, PrepareRequest { product_id }).unwrap_err(),
            "Product is absent from native inventory"
        );
    }
    #[test]
    fn inventory_refresh_helper_failure_retains_incomplete_sources() {
        let mutex = Mutex::new(cached());
        let m = mutex.lock().unwrap();
        let product_id = m.products[0].id.clone();
        drop(m);
        let view = finalize_inventory(&mutex, Err("helper fixture failure".into()), |_| Ok(vec![]))
            .unwrap();
        assert!(!view.complete);
        assert_eq!(view.sources.len(), 7);
        for (source, expected) in view.sources.iter().zip(SOURCE_IDS) {
            assert_eq!(source.id, expected);
            assert_eq!(source.status, "error");
            assert_eq!(source.detail, "Native inventory helper did not complete");
        }
        assert!(view.products.is_empty());
        let mut m = mutex.try_lock().unwrap();
        assert!(m.products.is_empty());
        assert_eq!(
            prepare_cached(&mut m, PrepareRequest { product_id }).unwrap_err(),
            "Product is absent from native inventory"
        );
    }
    #[test]
    fn inventory_refresh_success_preserves_ids_partial_and_empty_transitions() {
        for status in ["ok", "error", "unavailable"] {
            let mutex = Mutex::new(cached());
            let m = mutex.lock().unwrap();
            let product_id = m.products[0].id.clone();
            let raw = inventory_bytes(
                vec![record(
                    "AVG AntiVirus FREE",
                    "AVG Technologies",
                    SOURCE_IDS[3],
                )],
                status,
            );
            drop(m);
            let view = finalize_inventory(&mutex, Ok(raw), |m| {
                assert!(m.products.is_empty());
                assert!(matches!(
                    mutex.try_lock(),
                    Err(std::sync::TryLockError::WouldBlock)
                ));
                Ok(vec![])
            })
            .unwrap();
            let mut m = mutex.try_lock().unwrap();
            assert_eq!(
                serde_json::to_value(&m.products).unwrap(),
                serde_json::to_value(&view.products).unwrap()
            );
            assert_eq!(view.complete, status == "ok");
            assert_eq!(view.products[0].id, product_id);
            let plan = prepare_cached(
                &mut m,
                PrepareRequest {
                    product_id: product_id.clone(),
                },
            )
            .unwrap();
            m.operations[&plan.id].state.lock().unwrap().cancel();
            drop(m);
            let view =
                finalize_inventory(&mutex, Ok(inventory_bytes(vec![], "ok")), |_| Ok(vec![]))
                    .unwrap();
            assert!(view.complete);
            assert!(view.products.is_empty());
            let mut m = mutex.try_lock().unwrap();
            assert!(m.products.is_empty());
            assert_eq!(
                prepare_cached(&mut m, PrepareRequest { product_id }).unwrap_err(),
                "Product is absent from native inventory"
            );
        }
    }
    #[test]
    fn inventory_refresh_failure_preserves_prepared_operation_and_review_pin() {
        let fixture = AdapterFixture::new();
        let path = fixture.effects.root.join("retained-review");
        fs::write(&path, b"retained checkpoint").unwrap();
        let mutex = Mutex::new(cached());
        let mut m = mutex.lock().unwrap();
        let op = planned(&mut m);
        let review_id = crate::broker::random_id().unwrap();
        m.reviews.insert(
            review_id.clone(),
            HeldReview {
                dto: RemovalReview {
                    review_id: review_id.clone(),
                    tool_id: Some("avg".into()),
                    plan_id: Some(op.plan.id.clone()),
                    state: "reviewRequired".into(),
                    detail: RECOVERY.into(),
                    can_acknowledge: true,
                },
                pin: Pin::open(&path, false, 0x80010000, 1).unwrap(),
                bytes: b"retained checkpoint".to_vec(),
                _parents: vec![],
            },
        );
        drop(m);
        assert_eq!(
            finalize_inventory(&mutex, Ok(b"invalid".to_vec()), |_| panic!(
                "invalid JSON reached discovery"
            ))
            .unwrap_err(),
            "Invalid inventory helper response"
        );
        assert_eq!(op.snapshot().unwrap().phase, "prepared");
        let detail = admit_cached(&mutex, &op.plan.id).err().unwrap();
        assert_eq!(op.snapshot().unwrap().detail, detail);
        let mut m = mutex.try_lock().unwrap();
        assert_eq!(m.operations.len(), 1);
        assert!(Arc::ptr_eq(&m.operations[&op.plan.id], &op));
        assert_eq!(op.snapshot().unwrap().phase, "failed");
        assert_eq!(m.reviews.len(), 1);
        let held = m.reviews.get_mut(&review_id).unwrap();
        assert_eq!(held.bytes, b"retained checkpoint");
        assert_eq!(held.pin.read_bounded(4096).unwrap(), b"retained checkpoint");
        assert!(fs::remove_file(&path).is_err());
        drop(m);
        let raw = inventory_bytes(
            vec![record(
                "AVG AntiVirus FREE",
                "AVG Technologies",
                SOURCE_IDS[3],
            )],
            "ok",
        );
        finalize_inventory(&mutex, Ok(raw), |_| Ok(vec![])).unwrap();
        let fresh = planned(&mut mutex.lock().unwrap());
        assert_ne!(fresh.plan.id, op.plan.id);
        assert!(admit_cached(&mutex, &fresh.plan.id).is_ok());
    }
    #[derive(Default)]
    struct Fake {
        fail: &'static str,
        cleanup_fails: bool,
        cancel_at: &'static str,
        calls: Vec<&'static str>,
    }
    impl Fake {
        fn effect(&mut self, step: &'static str, op: Option<&Operation>) -> Result<(), String> {
            self.calls.push(step);
            if step == self.cancel_at {
                let op = op.unwrap();
                assert!(op.state.lock().unwrap().cancel());
                op.cancelled.store(true, Ordering::Release);
            }
            if step == self.fail || (step == "cleanup" && self.cleanup_fails) {
                Err(format!("{step} failure"))
            } else {
                Ok(())
            }
        }
    }
    impl Effects for Fake {
        fn download(&mut self, op: &Operation) -> Result<u64, String> {
            self.effect("download", Some(op))?;
            Ok(100)
        }
        fn verify(&mut self, op: &Operation) -> Result<(), String> {
            self.effect("verify", Some(op))
        }
        fn persist(&mut self, op: &Operation) -> Result<(), String> {
            self.effect("persist", Some(op))
        }
        fn launch(&mut self) -> Result<(), String> {
            self.effect("launch", None)
        }
        fn cleanup(&mut self) -> Result<(), String> {
            self.effect("cleanup", None)
        }
    }
    #[test]
    fn closed_input_denies_unknown_fields_and_non_native_ids() {
        for field in [
            "url",
            "path",
            "publisher",
            "flags",
            "script",
            "approved",
            "toolId",
        ] {
            let value = serde_json::json!({"productId":"a".repeat(32),field:"attacker"});
            assert!(serde_json::from_value::<PrepareRequest>(value).is_err());
        }
        let mut m = cached();
        for id in ["", "..\\tool.exe", "https://example.test", &"a".repeat(32)] {
            assert!(prepare_cached(
                &mut m,
                PrepareRequest {
                    product_id: id.into()
                }
            )
            .is_err());
        }
        for id in ["", "../invalid", &"f".repeat(32)] {
            if !valid_id(id) {
                assert!(status(id).is_err());
            }
            assert!(cancel(id).is_err());
            assert!(launch(id).is_err());
        }
    }
    #[test]
    fn inventory_preserves_unknown_defender_and_partial_sources() {
        let mut data = snapshot(vec![
            record("AVG AntiVirus FREE", "AVG Technologies", SOURCE_IDS[3]),
            record("AVG AntiVirus FREE", "", SOURCE_IDS[0]),
            record("Unknown firewall", "", SOURCE_IDS[2]),
            record("Windows Defender", "", SOURCE_IDS[0]),
            record("Ordinary editor", "Other", SOURCE_IDS[4]),
            record("ESET Endpoint Security", "ESET", SOURCE_IDS[5]),
        ]);
        data.sources[1].status = "unavailable".into();
        data.sources[6].status = "error".into();
        let view = normalize(data, &[]).unwrap();
        assert!(!view.complete);
        assert_eq!(view.sources.len(), 7);
        assert_eq!(view.products.len(), 4);
        let avg = view
            .products
            .iter()
            .find(|p| p.tool_id.as_deref() == Some("avg"))
            .unwrap();
        assert_eq!(avg.sources.len(), 2);
        assert!(view
            .products
            .iter()
            .any(|p| p.built_in && p.tool_id.is_none()));
        assert!(view
            .products
            .iter()
            .any(|p| p.name == "Unknown firewall" && p.tool_id.is_none()));
        assert!(view.products.iter().any(|p| p.name.starts_with("ESET")
            && p.unsupported_reason.as_ref().unwrap().contains("Safe Mode")));
        assert!(normalize(snapshot(vec![]), &[]).unwrap().complete);
        let mut bad = snapshot(vec![]);
        bad.sources.pop();
        assert!(normalize(bad, &[]).is_err());
        let mut bad = snapshot(vec![]);
        bad.sources[0].id = SOURCE_IDS[1].into();
        assert!(normalize(bad, &[]).is_err());
        let mut bad = snapshot(vec![]);
        bad.sources[0].status = "clean".into();
        assert!(normalize(bad, &[]).is_err());
        assert!(normalize(
            snapshot(vec![record(&"x".repeat(513), "", SOURCE_IDS[0])]),
            &[]
        )
        .is_err());
    }
    #[test]
    fn preparation_is_metadata_only_singleflight_and_expiry_is_not_replay() {
        let mut m = cached();
        let op = planned(&mut m);
        assert_eq!(op.snapshot().unwrap().phase, "prepared");
        assert_eq!(op.plan.tool_id, "avg");
        assert!(op.plan.expires_at.ends_with('Z'));
        let id = m.products[0].id.clone();
        assert!(prepare_cached(
            &mut m,
            PrepareRequest {
                product_id: id.clone()
            }
        )
        .is_err());
        assert!(op.state.lock().unwrap().cancel());
        let next = prepare_cached(&mut m, PrepareRequest { product_id: id }).unwrap();
        assert_ne!(next.id, op.plan.id);
        assert!(op.state.lock().unwrap().begin_launch().is_err());
    }
    #[test]
    fn earlier_failure_and_cleanup_failure_retain_payload_without_replaying_plan() {
        for cancel in [false, true] {
            let mut m = cached();
            let op = planned(&mut m);
            let mut effects = Fake {
                fail: "download",
                cleanup_fails: true,
                cancel_at: if cancel { "download" } else { "" },
                ..Fake::default()
            };
            let result = run(&op, &mut effects).unwrap();
            assert_eq!(result.outcome, if cancel { "cancelled" } else { "failed" });
            let status = op.snapshot().unwrap();
            assert_eq!(status.phase, result.outcome);
            assert_eq!(status.cleanup, "retained");
            assert_eq!(effects.calls, ["download", "cleanup"]);
            assert!(admit(&op, &m.products).is_err());
            let next = planned(&mut m);
            assert_ne!(next.plan.id, op.plan.id);
            assert_eq!(next.snapshot().unwrap().phase, "prepared");
            assert!(admit(&next, &m.products).is_ok());
        }
    }
    #[test]
    fn injected_failures_prevent_later_effects_and_ambiguous_launch_stays_active() {
        for failure in ["download", "verify", "persist", "launch", ""] {
            let mut m = cached();
            let op = planned(&mut m);
            let mut effects = Fake {
                fail: failure,
                ..Fake::default()
            };
            let result = run(&op, &mut effects).unwrap();
            if failure == "launch" {
                assert_eq!(result.outcome, "reviewRequired");
                assert!(!effects.calls.contains(&"cleanup"));
                assert!(!op.state.lock().unwrap().cancel());
            } else if failure.is_empty() {
                assert_eq!(result.outcome, "launched");
                assert!(!effects.calls.contains(&"cleanup"));
            } else {
                assert_eq!(result.outcome, "failed");
                assert!(!effects.calls.contains(&"launch"));
                assert_eq!(effects.calls.last(), Some(&"cleanup"));
            }
            let id = m.products[0].id.clone();
            if ["launch", ""].contains(&failure) {
                assert!(prepare_cached(&mut m, PrepareRequest { product_id: id }).is_err());
            }
        }
        for cancellation in ["download", "verify", "persist"] {
            let mut m = cached();
            let op = planned(&mut m);
            let mut effects = Fake {
                cancel_at: cancellation,
                ..Fake::default()
            };
            assert_eq!(run(&op, &mut effects).unwrap().outcome, "cancelled");
            assert!(!effects.calls.contains(&"launch"));
            assert!(op.snapshot().unwrap().cancellation_requested);
        }
    }
    #[test]
    fn payload_creation_preserves_fixed_vendor_basenames() {
        let root = std::env::temp_dir().join(format!(
            "purgeon-basename-{}",
            crate::broker::random_id().unwrap()
        ));
        fs::create_dir(&root).unwrap();
        let root = crate::updater_native::canonical_temp(&root).unwrap();
        for (tool, filename) in [
            ("avg", "avg_av_clear.exe"),
            ("avast", "avast_av_clear.exe"),
            ("norton", "norton_360_remover.exe"),
            ("mcafee", "MCPR.exe"),
        ] {
            let payload = Payload::create(&root, tool).unwrap();
            assert_eq!(payload.path.file_name().unwrap(), filename);
            assert_eq!(
                payload.path.parent().unwrap().parent(),
                Some(root.as_path())
            );
            payload.cleanup().unwrap();
        }
        assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
        fs::remove_dir(root).unwrap();
    }
    #[test]
    fn payload_creation_rejects_unknown_and_traversal_tools_before_filesystem_effects() {
        let root = std::env::temp_dir().join(format!(
            "purgeon-invalid-tool-{}",
            crate::broker::random_id().unwrap()
        ));
        for tool in ["unknown", "../avg", "avg/../../arbitrary.exe", "MCPR.exe"] {
            assert!(Payload::create(&root, tool).is_err());
            assert!(!root.exists());
        }
    }
    #[test]
    fn original_identity_survives_writer_exit_and_sealed_pin_blocks_mutation() {
        let root = std::env::temp_dir().join(format!(
            "purgeon-av-pin-{}",
            crate::broker::random_id().unwrap()
        ));
        fs::create_dir(&root).unwrap();
        let root = crate::updater_native::canonical_temp(&root).unwrap();
        let mut payload = Payload::create(&root, "avg").unwrap();
        fs::write(&payload.path, b"inert fixture").unwrap();
        assert!(fs::remove_file(&payload.path).is_err());
        assert!(fs::rename(&payload.path, payload.path.with_extension("moved")).is_err());
        payload.seal().unwrap();
        assert!(fs::write(&payload.path, b"changed").is_err());
        assert!(fs::remove_file(&payload.path).is_err());
        payload.cleanup().unwrap();
        assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
        fs::remove_dir(root).unwrap();
    }
    #[test]
    fn restart_marker_any_tool_blocks_all_launches() {
        let root = std::env::temp_dir().join(format!(
            "purgeon-av-marker-{}",
            crate::broker::random_id().unwrap()
        ));
        fs::create_dir(&root).unwrap();
        let root = crate::updater_native::canonical_temp(&root).unwrap();
        assert!(!has_marker(&root).unwrap());
        fs::write(root.join("launch-intent"), b"partial crash checkpoint").unwrap();
        assert!(has_marker(&root).unwrap());
        fs::remove_file(root.join("launch-intent")).unwrap();
        fs::remove_dir(root).unwrap();
    }

    #[test]
    fn primitive_writer_pin_remains_until_sealed_pin_and_cleanup_checks_identity() {
        let root = std::env::temp_dir().join(format!(
            "purgeon-av-primitive-{}",
            crate::broker::random_id().unwrap()
        ));
        fs::create_dir(&root).unwrap();
        let root = crate::updater_native::canonical_temp(&root).unwrap();
        let path = root.join("fixture.exe");
        let original = Pin::create_placeholder(&path).unwrap();
        fs::write(&path, b"inert bytes").unwrap();
        assert!(fs::remove_file(&path).is_err());
        let sealed = Pin::open(&path, false, 0x80000000, 1).unwrap();
        assert!(original.same_identity(&sealed));
        assert!(fs::write(&path, b"wrong").is_err());
        drop(sealed);
        original.remove_matching(false).unwrap();
        assert!(!path.exists());
        fs::remove_dir(root).unwrap();
    }

    #[test]
    fn restart_status_is_review_only_and_malformed_checkpoint_never_authorizes() {
        let root = std::env::temp_dir().join(format!(
            "purgeon-av-restart-{}",
            crate::broker::random_id().unwrap()
        ));
        fs::create_dir(&root).unwrap();
        let root = crate::updater_native::canonical_temp(&root).unwrap();
        let path = root.join("launch-intent");
        let id = "a".repeat(32);
        fs::write(
            &path,
            serde_json::to_vec(&serde_json::json!({"schemaVersion":1,"id":id})).unwrap(),
        )
        .unwrap();
        let status = read_restart_status(&root, &id).unwrap();
        assert_eq!(status.phase, "reviewRequired");
        assert_eq!(status.cleanup, "retained");
        assert!(read_restart_status(&root, &"b".repeat(32)).is_err());
        fs::write(&path, b"{").unwrap();
        assert!(read_restart_status(&root, &id).is_err());
        assert!(has_marker(&root).unwrap());
        fs::write(&path, vec![0; 4097]).unwrap();
        assert!(read_restart_status(&root, &id).is_err());
        fs::remove_file(path).unwrap();
        fs::remove_dir(root).unwrap();
    }

    #[test]
    fn matching_requires_exact_consumer_product_and_publisher() {
        assert_eq!(
            match_tool("AVG AntiVirus FREE", "AVG Technologies"),
            Some("avg")
        );
        assert_eq!(match_tool("Avast One", "Avast Software"), None);
        assert_eq!(
            match_tool("Norton 360", "NortonLifeLock Inc."),
            Some("norton")
        );
        assert_eq!(
            match_tool("McAfee Total Protection", "McAfee, LLC"),
            Some("mcafee")
        );
        for (name, publisher) in [
            ("AVG AntiVirus FREE evil", "AVG Technologies"),
            ("AVG AntiVirus FREE", "attacker"),
            ("McAfee Endpoint Security", "McAfee, LLC"),
            ("Norton Password Manager", "Gen Digital Inc."),
            ("ESET Security", "ESET"),
            ("Microsoft Defender", "Microsoft Corporation"),
        ] {
            assert_eq!(match_tool(name, publisher), None);
        }
    }

    #[test]
    fn cancellation_and_launch_have_one_winner() {
        let mut state = OperationState::new();
        assert!(state.cancel());
        assert!(state.begin_launch().is_err());
        let mut state = OperationState::new();
        assert!(state.begin_launch().is_ok());
        assert!(!state.cancel());
        assert!(state.begin_launch().is_err());
    }
    #[test]
    fn cancellation_and_launch_forced_thread_interleavings() {
        for cancel_first in [true, false] {
            let state = Arc::new(Mutex::new(OperationState::new()));
            let first = state.clone();
            let second = state.clone();
            let (sent, received) = std::sync::mpsc::channel();
            let winner = std::thread::spawn(move || {
                let mut s = first.lock().unwrap();
                let accepted = if cancel_first {
                    s.cancel()
                } else {
                    s.begin_launch().is_ok()
                };
                drop(s);
                sent.send(()).unwrap();
                accepted
            });
            let loser = std::thread::spawn(move || {
                received.recv().unwrap();
                let mut s = second.lock().unwrap();
                if cancel_first {
                    s.begin_launch().is_ok()
                } else {
                    s.cancel()
                }
            });
            assert!(winner.join().unwrap());
            assert!(!loser.join().unwrap());
        }
    }
    #[test]
    fn actual_persist_is_exclusive_durable_and_does_not_launch() {
        let root = std::env::temp_dir().join(format!(
            "purgeon-persist-{}",
            crate::broker::random_id().unwrap()
        ));
        fs::create_dir(&root).unwrap();
        let root = crate::updater_native::canonical_temp(&root).unwrap();
        let dir = root.join(format!("removal-{}", crate::broker::random_id().unwrap()));
        fs::create_dir(&dir).unwrap();
        let path = dir.join("avg_av_clear.exe");
        let original = Pin::create_placeholder(&path).unwrap();
        fs::write(&path, b"inert executable-shaped fixture; never run").unwrap();
        let mut payload = Payload {
            path,
            pins: vec![Pin::open(&dir, true, 0x80000000, 3).unwrap()],
            original: Some(original),
            sealed: None,
        };
        payload.seal().unwrap();
        let mut effects = NativeEffects {
            root: root.clone(),
            payload: Some(payload),
            checkpoint: None,
        };
        let mut m = cached();
        let op = planned(&mut m);
        effects.persist(&op).unwrap();
        let checkpoint = root.join("launch-intent");
        let bytes = fs::read(&checkpoint).unwrap();
        assert!(validated_checkpoint(&root, &checkpoint, &bytes).is_ok());
        assert!(effects.persist(&op).is_err());
        assert_eq!(fs::read(&checkpoint).unwrap(), bytes);
        assert_eq!(op.snapshot().unwrap().phase, "prepared");
        effects.cleanup().unwrap();
        drop(effects);
        fs::remove_file(checkpoint).unwrap();
        fs::remove_dir(root).unwrap();
    }
    #[test]
    fn independent_managers_race_different_tools_through_one_global_checkpoint() {
        struct Contender {
            native: NativeEffects,
            barrier: Arc<std::sync::Barrier>,
            launches: Arc<std::sync::atomic::AtomicUsize>,
        }
        impl Effects for Contender {
            fn download(&mut self, _: &Operation) -> Result<u64, String> {
                Ok(10)
            }
            fn verify(&mut self, _: &Operation) -> Result<(), String> {
                Ok(())
            }
            fn persist(&mut self, op: &Operation) -> Result<(), String> {
                self.barrier.wait();
                self.native.persist(op)
            }
            fn launch(&mut self) -> Result<(), String> {
                self.launches.fetch_add(1, Ordering::SeqCst);
                Ok(())
            }
            fn cleanup(&mut self) -> Result<(), String> {
                self.native.cleanup()
            }
        }
        let root = std::env::temp_dir().join(format!(
            "purgeon-race-{}",
            crate::broker::random_id().unwrap()
        ));
        fs::create_dir(&root).unwrap();
        let root = crate::updater_native::canonical_temp(&root).unwrap();
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let launches = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let mut workers = vec![];
        for tool in ["avg", "avast"] {
            let mut m = cached();
            m.products[0].tool_id = Some(tool.into());
            let op = planned(&mut m);
            let dir = root.join(format!("removal-{}", crate::broker::random_id().unwrap()));
            fs::create_dir(&dir).unwrap();
            let path = dir.join(policy(tool).unwrap().file_name);
            let original = Pin::create_placeholder(&path).unwrap();
            fs::write(&path, b"inert data; never executed").unwrap();
            let mut payload = Payload {
                path,
                pins: vec![Pin::open(&dir, true, 0x80000000, 3).unwrap()],
                original: Some(original),
                sealed: None,
            };
            payload.seal().unwrap();
            let mut effects = Contender {
                native: NativeEffects {
                    root: root.clone(),
                    payload: Some(payload),
                    checkpoint: None,
                },
                barrier: barrier.clone(),
                launches: launches.clone(),
            };
            workers.push(std::thread::spawn(move || {
                admit(&op, &m.products).unwrap();
                let result = run(&op, &mut effects).unwrap();
                if result.outcome == "launched" {
                    effects.cleanup().unwrap();
                }
                result
            }));
        }
        let outcomes = workers
            .into_iter()
            .map(|w| w.join().unwrap().outcome)
            .collect::<Vec<_>>();
        assert_eq!(launches.load(Ordering::SeqCst), 1);
        assert_eq!(outcomes.iter().filter(|o| *o == "launched").count(), 1);
        assert_eq!(outcomes.iter().filter(|o| *o == "failed").count(), 1);
        let marker = root.join("launch-intent");
        let bytes = fs::read(&marker).unwrap();
        let checkpoint = validated_checkpoint(&root, &marker, &bytes).unwrap();
        assert!(["avg", "avast"].contains(&checkpoint.tool_id.as_str()));
        assert!(has_marker(&root).unwrap());
        fs::remove_file(marker).unwrap();
        fs::remove_dir(root).unwrap();
    }
    #[test]
    fn admitted_setup_failures_and_cancel_races_always_finalize() {
        for failing in ["root", "pin", "marker"] {
            for cancel in [false, true] {
                let mut m = cached();
                let op = planned(&mut m);
                admit(&op, &m.products).unwrap();
                let mut effects = Fake::default();
                let failure = || -> String {
                    if cancel {
                        assert!(op.state.lock().unwrap().cancel());
                        op.cancelled.store(true, Ordering::Release);
                    }
                    format!("forced {failing} failure")
                };
                let result = run_with_setup(&op, &mut effects, |_| {
                    launch_root(
                        || {
                            if failing == "root" {
                                Err(failure())
                            } else {
                                Ok(PathBuf::from("owned-root"))
                            }
                        },
                        |_| {
                            if failing == "pin" {
                                Err(failure())
                            } else {
                                Ok(())
                            }
                        },
                        |_| {
                            if failing == "marker" {
                                Err(failure())
                            } else {
                                Ok(false)
                            }
                        },
                    )
                })
                .unwrap();
                assert_eq!(result.outcome, if cancel { "cancelled" } else { "failed" });
                let status = op.snapshot().unwrap();
                assert_eq!(status.phase, result.outcome);
                assert!(!status.detail.is_empty());
                assert_eq!(status.cleanup, "removed");
                assert_eq!(effects.calls, ["cleanup"]);
                assert!(admit(&op, &m.products).is_err());
                assert!(prepare_cached(
                    &mut m,
                    PrepareRequest {
                        product_id: op.plan.product_id.clone()
                    }
                )
                .is_ok());
            }
        }
    }
    #[test]
    fn actual_system_helper_roundtrips_unicode_json_and_owned_path() {
        let directory = std::env::temp_dir().join(format!(
            "purgeon-unicode-{}",
            crate::broker::random_id().unwrap()
        ));
        fs::create_dir(&directory).unwrap();
        let directory = crate::updater_native::canonical_temp(&directory).unwrap();
        let path = directory.join("résumé-安全-😀.txt");
        let input = serde_json::json!({"path": path, "name": "Sécurité 安全 😀"});
        let output = script(
            "$request = [Console]::In.ReadToEnd() | Microsoft.PowerShell.Utility\\ConvertFrom-Json; [IO.File]::WriteAllText([string]$request.path, [string]$request.name, [Text.UTF8Encoding]::new($false)); $request | Microsoft.PowerShell.Utility\\ConvertTo-Json -Compress",
            input.clone(), Duration::from_secs(20), &AtomicBool::new(false),
        );
        let result = output.and_then(|bytes| {
            serde_json::from_slice::<serde_json::Value>(&bytes).map_err(|e| e.to_string())
        });
        let contents = fs::read_to_string(&path);
        let _ = fs::remove_file(&path);
        fs::remove_dir(&directory).unwrap();
        assert_eq!(result.unwrap(), input);
        assert_eq!(contents.unwrap(), "Sécurité 安全 😀");
    }
    #[test]
    fn actual_admission_rejects_expiry_replay_and_cancelled_plans() {
        assert_eq!(launch("invalid").unwrap_err(), "Invalid native plan ID");
        let mut m = cached();
        let op = planned(&mut m);
        assert_eq!(
            admit_cached(&Mutex::new(Manager::default()), &op.plan.id)
                .err()
                .unwrap(),
            "Unknown native plan ID"
        );
        admit(&op, &m.products).unwrap();
        assert!(admit(&op, &m.products).is_err());
        let mut m = cached();
        let op = planned(&mut m);
        op.state.lock().unwrap().cancel();
        assert!(admit(&op, &m.products).is_err());
        let mut m = cached();
        let op = planned(&mut m);
        let id = op.plan.id.clone();
        drop(op);
        let mut op = Arc::try_unwrap(m.operations.remove(&id).unwrap())
            .ok()
            .unwrap();
        op.created = Instant::now() - TTL;
        assert!(admit(&op, &m.products).is_err());
        assert_eq!(op.snapshot().unwrap().phase, "failed");
    }
    #[test]
    fn exact_signer_subject_der_and_both_metadata_fields_are_required() {
        for id in ["avg", "avast", "norton", "mcafee"] {
            let p = policy(id).unwrap();
            assert!(check_signer(&p, p.subject, p.product, p.description).is_ok());
            assert!(check_signer(&p, "untrusted", p.product, p.description).is_err());
            assert!(check_signer(&p, p.subject, "wrong", p.description).is_err());
            assert!(check_signer(&p, p.subject, p.product, "wrong").is_err());
        }
        assert!(policy("eset").is_err());
        assert!(policy("defender").is_err());
        assert!(timestamp(u64::MAX).is_err());
        assert_eq!(timestamp(0).unwrap(), "1970-01-01T00:00:00Z");
    }
    #[test]
    fn hardlinked_downloads_are_rejected_before_verification() {
        let root = std::env::temp_dir().join(format!(
            "purgeon-av-hardlink-{}",
            crate::broker::random_id().unwrap()
        ));
        fs::create_dir(&root).unwrap();
        let root = crate::updater_native::canonical_temp(&root).unwrap();
        let first = root.join("first");
        let second = root.join("second");
        fs::write(&first, b"inert").unwrap();
        fs::hard_link(&first, &second).unwrap();
        assert!(Pin::open(&first, false, 0x80000000, 1).is_err());
        fs::remove_file(first).unwrap();
        fs::remove_file(second).unwrap();
        fs::remove_dir(root).unwrap();
    }
}
