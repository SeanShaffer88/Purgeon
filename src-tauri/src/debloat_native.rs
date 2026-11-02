//! Closed, catalog-resolved Debloat operations. No registry path is renderer input.
use crate::broker;
use crate::registry_native::{self as registry, RawValue};
use crate::state_store::{self, Authority};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use winreg::enums::{KEY_READ, KEY_SET_VALUE};

const CATALOG: &str = include_str!("../../src/backend/debloat-catalog.json");
const PIPE_PREFIX: &str = "\\\\.\\pipe\\Purgeon-Debloat-";
const STATE_LIMIT: usize = 32768;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Tweak {
    id: String,
    category: String,
    title: String,
    detail: String,
    effect: String,
    values: Vec<Resource>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Resource {
    key: String,
    name: String,
    #[serde(rename = "type")]
    kind: String,
    on: serde_json::Value,
    off: Option<serde_json::Value>,
    delete_key_on_revert: Option<String>,
}
struct Catalog {
    tweaks: Vec<Tweak>,
    digest: String,
}
static PARSED: OnceLock<Result<Catalog, String>> = OnceLock::new();
fn hash(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
fn catalog() -> Result<&'static Catalog, String> {
    PARSED
        .get_or_init(|| {
            let tweaks: Vec<Tweak> = serde_json::from_str(CATALOG).map_err(|e| e.to_string())?;
            let mut ids = HashSet::new();
            if tweaks.is_empty() || tweaks.len() > 256 {
                return Err("Invalid Debloat catalog size".into());
            }
            for tweak in &tweaks {
                if tweak.id.is_empty()
                    || tweak.id.len() > 64
                    || !tweak.id.bytes().all(|c| {
                        c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-' || c == b'_'
                    })
                    || !ids.insert(tweak.id.clone())
                    || tweak.values.is_empty()
                    || tweak.values.len() > 16
                    || !["immediate", "explorer", "reboot"].contains(&tweak.effect.as_str())
                {
                    return Err("Invalid compiled Debloat catalog".into());
                }
                let mut resources = HashSet::new();
                for resource in &tweak.values {
                    if !(resource.key.starts_with("HKCU\\Software\\")
                        || resource.key.starts_with("HKCU\\Control Panel\\")
                        || resource.key.starts_with("HKLM\\SOFTWARE\\")
                        || resource
                            .key
                            .starts_with("HKLM\\SYSTEM\\CurrentControlSet\\Control\\"))
                        || resource.key.len() > 1024
                        || resource.name.len() > 256
                        || resource
                            .key
                            .split('\\')
                            .any(|part| part.is_empty() || [".", ".."].contains(&part))
                        || resource.key.contains('\0')
                        || resource.name.contains('\0')
                        || !resources
                            .insert((resource.key.to_lowercase(), resource.name.to_lowercase()))
                    {
                        return Err("Invalid compiled Debloat resource".into());
                    }
                    target_raw(resource, true)?;
                    target_raw(resource, false)?;
                    if let Some(parent) = &resource.delete_key_on_revert {
                        if !resource
                            .key
                            .to_lowercase()
                            .starts_with(&(parent.to_lowercase() + "\\"))
                        {
                            return Err("Invalid empty-key cleanup scope".into());
                        }
                    }
                }
            }
            Ok(Catalog {
                tweaks,
                digest: hash(CATALOG.as_bytes()),
            })
        })
        .as_ref()
        .map_err(Clone::clone)
}
fn tweak(id: &str) -> Result<&'static Tweak, String> {
    catalog()?
        .tweaks
        .iter()
        .find(|t| t.id == id)
        .ok_or_else(|| "Unknown Debloat tweak".into())
}
fn target_raw(resource: &Resource, enabled: bool) -> Result<Option<RawValue>, String> {
    let value = if enabled {
        Some(&resource.on)
    } else {
        resource.off.as_ref()
    };
    let Some(value) = value else {
        return Ok(None);
    };
    let (kind, bytes) = match resource.kind.as_str() {
        "REG_DWORD" => {
            let number = value
                .as_u64()
                .filter(|n| *n <= u32::MAX as u64)
                .ok_or("Invalid catalog DWORD")? as u32;
            (4, number.to_le_bytes().to_vec())
        }
        "REG_SZ" | "REG_EXPAND_SZ" => {
            let text = value.as_str().ok_or("Invalid catalog string")?;
            if text.contains('\0') || text.len() > 4096 {
                return Err("Invalid catalog string".into());
            }
            (
                if resource.kind == "REG_SZ" { 1 } else { 2 },
                text.encode_utf16()
                    .chain(Some(0))
                    .flat_map(u16::to_le_bytes)
                    .collect(),
            )
        }
        _ => return Err("Unsupported catalog value type".into()),
    };
    Ok(Some(RawValue { kind, bytes }))
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Snapshot {
    key: String,
    resolved_key: String,
    name: String,
    key_existed: bool,
    cleanup_parent_existed: Option<bool>,
    raw: Option<RawValue>,
}
fn capture(tweak: &Tweak, sid: &str) -> Result<Vec<Snapshot>, String> {
    let mut values = Vec::new();
    for resource in &tweak.values {
        let resolved_key = registry::resolve_compiled_path(&resource.key)?;
        let key = registry::open(&resolved_key, sid, KEY_READ)?;
        let raw = match &key {
            Some(key) => registry::read_value(key, &resource.name)?,
            None => None,
        };
        if raw.as_ref().is_some_and(|v| v.kind == 6) {
            return Err("Registry link originals are not safe to restore".into());
        }
        let cleanup_parent_existed = match &resource.delete_key_on_revert {
            Some(parent) => Some(registry::open(parent, sid, KEY_READ)?.is_some()),
            None => None,
        };
        values.push(Snapshot {
            key: resource.key.clone(),
            resolved_key,
            name: resource.name.clone(),
            key_existed: key.is_some(),
            cleanup_parent_existed,
            raw,
        });
    }
    encoded(&values)?;
    Ok(values)
}
fn encoded(value: &impl Serialize) -> Result<Vec<u8>, String> {
    let bytes = serde_json::to_vec(value).map_err(|e| e.to_string())?;
    if bytes.len() > STATE_LIMIT {
        return Err(
            "Native Debloat snapshot exceeds the recovery-store limit; nothing was changed".into(),
        );
    }
    Ok(bytes)
}
fn fingerprint(value: &impl Serialize) -> Result<String, String> {
    Ok(hash(&encoded(value)?))
}
fn now_ms() -> Result<u64, String> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis() as u64)
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub tweak_id: String,
    pub enabled: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanView {
    pub id: String,
    pub tweak_id: String,
    pub enabled: bool,
    pub summary: String,
    pub effect: String,
    pub requires_elevation: bool,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Envelope {
    request: Request,
    caller_sid: String,
    catalog_digest: String,
    expected_fingerprint: String,
    deadline_utc_ms: u64,
    parent_pid: u32,
    #[serde(default)]
    recovery: Option<RecoveryRequest>,
    #[serde(default)]
    recovery_fingerprint: Option<String>,
}
struct Pending {
    envelope: Envelope,
    prepared: Instant,
}
static PLANS: OnceLock<Mutex<HashMap<String, Pending>>> = OnceLock::new();
fn plans() -> &'static Mutex<HashMap<String, Pending>> {
    PLANS.get_or_init(|| Mutex::new(HashMap::new()))
}
pub fn prepare(request: Request) -> Result<PlanView, String> {
    let tweak = tweak(&request.tweak_id)?;
    let sid = broker::current_sid()?;
    let snapshot = capture(tweak, &sid)?;
    let requires_elevation = broker::is_elevated()?
        || tweak.values.iter().any(|resource| {
            resource.key.starts_with("HKLM\\") || registry::can_mutate(&resource.key, &sid).is_err()
        });
    let id = broker::reserve_plan()?;
    let view = PlanView {
        id: id.clone(),
        tweak_id: tweak.id.clone(),
        enabled: request.enabled,
        summary: format!(
            "{}: {}",
            if request.enabled {
                "Apply"
            } else {
                "Restore or apply documented defaults for"
            },
            tweak.title
        ),
        effect: tweak.effect.clone(),
        requires_elevation,
    };
    let envelope = Envelope {
        request,
        caller_sid: sid,
        catalog_digest: catalog()?.digest.clone(),
        expected_fingerprint: fingerprint(&snapshot)?,
        deadline_utc_ms: now_ms()?.saturating_add(120000),
        parent_pid: std::process::id(),
        recovery: None,
        recovery_fingerprint: None,
    };
    let mut pending = plans().lock().map_err(|e| e.to_string())?;
    pending.retain(|_, item| item.prepared.elapsed() < Duration::from_secs(120));
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
struct Transaction {
    #[serde(default)]
    version: u32,
    id: String,
    before: Vec<Snapshot>,
    enabled: bool,
    completed: Vec<usize>,
    in_flight: Option<usize>,
    finished: bool,
    #[serde(default)]
    targets: Option<Vec<Option<RawValue>>>,
    #[serde(default)]
    recovery: Option<Rollback>,
    #[serde(default)]
    outcome: Option<String>,
    #[serde(default)]
    acknowledged: Option<Vec<Snapshot>>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Rollback {
    completed: Vec<usize>,
    in_flight: Option<usize>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct State {
    schema_version: u32,
    authority: String,
    caller_sid: String,
    catalog_digest: String,
    tweak_id: String,
    originals: Option<Vec<Snapshot>>,
    transaction: Option<Transaction>,
}
fn authority_name(authority: Authority) -> &'static str {
    match authority {
        Authority::User => "user-original-v1",
        Authority::Machine => "machine-original-v1",
    }
}
fn validate_snapshots(values: &[Snapshot], tweak: &Tweak) -> Result<(), String> {
    if values.len() != tweak.values.len() {
        return Err("Recovery resource count does not match the compiled catalog".into());
    }
    for (value, resource) in values.iter().zip(&tweak.values) {
        if value.key != resource.key
            || !valid_recorded_mapping(&resource.key, &value.resolved_key)
            || (!value.key_existed && value.raw.is_some())
            || value.name != resource.name
            || value.cleanup_parent_existed.is_some() != resource.delete_key_on_revert.is_some()
            || value
                .raw
                .as_ref()
                .is_some_and(|raw| raw.bytes.len() > STATE_LIMIT || raw.kind > 11 || raw.kind == 6)
        {
            return Err("Recovery data does not match the compiled resource".into());
        }
    }
    encoded(&values)?;
    Ok(())
}
fn load_state(authority: Authority, sid: &str, tweak: &Tweak) -> Result<State, String> {
    let digest = &catalog()?.digest;
    let state = match state_store::read(
        state_store::Domain::Debloat,
        authority,
        sid,
        digest,
        &tweak.id,
    )? {
        Some(bytes) => serde_json::from_slice::<State>(&bytes)
            .map_err(|e| format!("Native recovery state is damaged: {e}"))?,
        None => State {
            schema_version: 1,
            authority: authority_name(authority).into(),
            caller_sid: sid.into(),
            catalog_digest: digest.clone(),
            tweak_id: tweak.id.clone(),
            originals: None,
            transaction: None,
        },
    };
    if state.schema_version != 1
        || state.authority != authority_name(authority)
        || state.caller_sid != sid
        || state.catalog_digest != *digest
        || state.tweak_id != tweak.id
    {
        return Err("Recovery authority, identity or catalog binding does not match".into());
    }
    if let Some(originals) = &state.originals {
        validate_snapshots(originals, tweak)?;
    }
    if let Some(transaction) = &state.transaction {
        validate_snapshots(&transaction.before, tweak)?;
        if transaction.version > 1
            || transaction.id.len() != 32
            || !transaction.id.bytes().all(|b| b.is_ascii_hexdigit())
            || transaction
                .completed
                .iter()
                .any(|index| *index >= tweak.values.len())
            || transaction
                .in_flight
                .is_some_and(|index| index >= tweak.values.len())
        {
            return Err("Invalid native recovery transaction".into());
        }
        if transaction
            .completed
            .windows(2)
            .any(|pair| pair[0] >= pair[1])
            || transaction
                .in_flight
                .is_some_and(|index| transaction.completed.contains(&index))
        {
            return Err("Invalid ordered completion evidence".into());
        }
        if transaction.version == 1 && transaction.targets.is_none() {
            return Err("Missing persisted native targets".into());
        }
        if let Some(targets) = &transaction.targets {
            if targets.len() != tweak.values.len()
                || targets
                    .iter()
                    .flatten()
                    .any(|raw| raw.kind > 11 || raw.kind == 6 || raw.bytes.len() > STATE_LIMIT)
            {
                return Err("Invalid persisted targets".into());
            }
            let expected: Vec<Option<RawValue>> =
                if !transaction.enabled && state.originals.is_some() {
                    state
                        .originals
                        .as_ref()
                        .ok_or("Missing originals")?
                        .iter()
                        .map(|value| value.raw.clone())
                        .collect()
                } else {
                    tweak
                        .values
                        .iter()
                        .map(|resource| target_raw(resource, transaction.enabled))
                        .collect::<Result<_, _>>()?
                };
            if *targets != expected {
                return Err(
                    "Persisted targets do not match compiled action or trusted originals".into(),
                );
            }
        }
        if let Some(rollback) = &transaction.recovery {
            if rollback
                .completed
                .iter()
                .any(|index| *index >= tweak.values.len())
                || rollback.completed.windows(2).any(|p| p[0] >= p[1])
                || rollback.in_flight.is_some_and(|index| {
                    index >= tweak.values.len() || rollback.completed.contains(&index)
                })
            {
                return Err("Invalid recovery completion evidence".into());
            }
        }
        if let Some(values) = &transaction.acknowledged {
            validate_snapshots(values, tweak)?;
        }
    }
    Ok(state)
}
fn valid_recorded_mapping(logical: &str, physical: &str) -> bool {
    const ALIAS: &str = "HKLM\\SYSTEM\\CurrentControlSet\\";
    if let Some(suffix) = logical.strip_prefix(ALIAS) {
        let Some(rest) = physical.strip_prefix("HKLM\\SYSTEM\\ControlSet") else {
            return false;
        };
        let Some((number, actual_suffix)) = rest.split_once('\\') else {
            return false;
        };
        number.len() == 3
            && number.bytes().all(|b| b.is_ascii_digit())
            && number.parse::<u32>().is_ok_and(|n| (1..=999).contains(&n))
            && actual_suffix == suffix
    } else {
        physical == logical
    }
}
fn read_state(authority: Authority, sid: &str, tweak: &Tweak) -> Result<State, String> {
    let state = load_state(authority, sid, tweak)?;
    if state
        .transaction
        .as_ref()
        .is_some_and(|transaction| !transaction.finished)
    {
        return Err("A native Debloat transaction is uncertain. Inspect and resolve recovery before another mutation.".into());
    }
    if let Some(originals) = &state.originals {
        for value in originals {
            if value.resolved_key != registry::resolve_compiled_path(&value.key)? {
                return Err(
                    "Original control-set mapping differs; manual review is required".into(),
                );
            }
        }
    }
    Ok(state)
}
fn save(authority: Authority, state: &State) -> Result<(), String> {
    state_store::write(
        state_store::Domain::Debloat,
        authority,
        &state.caller_sid,
        &state.catalog_digest,
        &state.tweak_id,
        &encoded(state)?,
    )
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResultView {
    pub ok: bool,
    pub restored_original: bool,
    pub applied_defaults: bool,
    pub outcome: String,
}
fn execute_envelope(
    envelope: &Envelope,
    authority: Authority,
    before_commit: impl FnOnce() -> Result<(), String>,
) -> Result<ResultView, String> {
    let _lease = broker::domain_lease(&envelope.caller_sid)?;
    if now_ms()? > envelope.deadline_utc_ms
        || envelope.deadline_utc_ms > now_ms()?.saturating_add(120000)
    {
        return Err("Invalid or expired Debloat deadline".into());
    }
    let tweak = tweak(&envelope.request.tweak_id)?;
    if envelope.recovery.is_some() {
        return Err("Recovery plans require the recovery executor".into());
    }
    if envelope.catalog_digest != catalog()?.digest {
        return Err("Parent/helper catalog versions do not match".into());
    }
    let current = capture(tweak, &envelope.caller_sid)?;
    if fingerprint(&current)? != envelope.expected_fingerprint {
        return Err("Registry state changed after preparation; review again".into());
    }
    if authority == Authority::User
        && (broker::is_elevated()?
            || tweak
                .values
                .iter()
                .any(|resource| resource.key.starts_with("HKLM\\")))
    {
        return Err("A user original cannot authorize an elevated or machine write".into());
    }
    for resource in &tweak.values {
        registry::can_mutate(&resource.key, &envelope.caller_sid)?;
    }
    let mut state = read_state(authority, &envelope.caller_sid, tweak)?;
    let restore_original = !envelope.request.enabled && state.originals.is_some();
    let apply_defaults = !envelope.request.enabled && state.originals.is_none();
    let explanation = if restore_original {
        "Restores the first original values captured by this native authority. Empty registry keys created by Purgeon are retained to avoid deleting concurrent data."
    } else if apply_defaults {
        "No trusted original exists in this authority. This applies compiled catalog defaults, not a recovered old state. Legacy or user-only originals are not promoted into administrator writes. Empty created registry keys are retained."
    } else {
        "Applies compiled catalog values; the first original values are retained before writing. Restore preserves original value types and absence, but retains empty created keys."
    };
    let resources = tweak
        .values
        .iter()
        .map(|resource| {
            format!(
                "{} [{}]",
                resource.key,
                if resource.name.is_empty() {
                    "(Default)"
                } else {
                    &resource.name
                }
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    broker::confirm_native(&format!(
        "{}\n\n{}\n\nEffect: {}\nCaller SID: {}\n\n{}\n\nContinue with exactly these resources?",
        tweak.title, explanation, tweak.effect, envelope.caller_sid, resources
    ))?;
    if now_ms()? > envelope.deadline_utc_ms {
        return Err("Debloat plan expired during consent".into());
    }
    before_commit()?;
    broker::require_live_parent(envelope.parent_pid)?;
    if now_ms()? > envelope.deadline_utc_ms {
        return Err("Debloat commit expired".into());
    }
    if fingerprint(&capture(tweak, &envelope.caller_sid)?)? != envelope.expected_fingerprint {
        return Err("Registry state changed during consent; nothing was written".into());
    }
    if envelope.request.enabled && state.originals.is_none() {
        state.originals = Some(current.clone());
    }
    let targets: Vec<Option<RawValue>> = if restore_original {
        state
            .originals
            .as_ref()
            .ok_or("Missing original state")?
            .iter()
            .map(|value| value.raw.clone())
            .collect()
    } else {
        tweak
            .values
            .iter()
            .map(|resource| target_raw(resource, envelope.request.enabled))
            .collect::<Result<_, _>>()?
    };
    state.transaction = Some(Transaction {
        version: 1,
        id: broker::random_id()?,
        before: current,
        enabled: envelope.request.enabled,
        completed: Vec::new(),
        in_flight: None,
        finished: false,
        targets: Some(targets.clone()),
        recovery: None,
        outcome: None,
        acknowledged: None,
    });
    save(authority, &state)?;
    for (index, (resource, target)) in tweak.values.iter().zip(&targets).enumerate() {
        let resolved_key = state
            .transaction
            .as_ref()
            .ok_or("Missing native transaction")?
            .before[index]
            .resolved_key
            .clone();
        if registry::resolve_compiled_path(&resource.key)? != resolved_key {
            return Err("Control-set selection changed; recovery journal retained".into());
        }
        state
            .transaction
            .as_mut()
            .ok_or("Missing native transaction")?
            .in_flight = Some(index);
        save(authority, &state)?;
        let key = registry::open(&resolved_key, &envelope.caller_sid, KEY_SET_VALUE)?;
        match (key, target) {
            (Some(key), _) => registry::write(&key, &resource.name, target.as_ref())?,
            (None, Some(_)) => registry::write(
                &registry::create(&resolved_key, &envelope.caller_sid)?,
                &resource.name,
                target.as_ref(),
            )?,
            (None, None) => {}
        }
        let checked = registry::open(&resolved_key, &envelope.caller_sid, KEY_READ)?;
        let actual = match checked {
            Some(key) => registry::read_value(&key, &resource.name)?,
            None => None,
        };
        if actual != *target {
            return Err(
                "Native Debloat write could not be verified; recovery journal retained".into(),
            );
        }
        let transaction = state
            .transaction
            .as_mut()
            .ok_or("Missing native transaction")?;
        transaction.completed.push(index);
        transaction.in_flight = None;
        save(authority, &state)?;
    }
    state
        .transaction
        .as_mut()
        .ok_or("Missing native transaction")?
        .finished = true;
    save(authority, &state)?;
    Ok(ResultView {
        ok: true,
        restored_original: restore_original,
        applied_defaults: apply_defaults,
        outcome: if restore_original {
            "restoredOriginal"
        } else if apply_defaults {
            "appliedDefaults"
        } else {
            "applied"
        }
        .into(),
    })
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "phase", rename_all = "camelCase", deny_unknown_fields)]
enum Message {
    Ready,
    Result {
        result: Option<ResultView>,
        error: Option<String>,
    },
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RecoveryDecision {
    Reconcile,
    RollbackOwned,
    AcceptCurrent,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecoveryRequest {
    pub tweak_id: String,
    pub transaction_id: String,
    pub decision: RecoveryDecision,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ResourceReview {
    key: String,
    name: String,
    before: String,
    target: String,
    current: String,
    classification: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RecoveryReview {
    transaction_id: String,
    legacy: bool,
    mapping_mismatch: bool,
    outcome: Option<String>,
    resources: Vec<ResourceReview>,
    safe_decisions: Vec<String>,
}
fn raw_summary(value: &Option<RawValue>) -> String {
    match value {
        None => "Absent".into(),
        Some(raw) => format!(
            "Raw type {}, {} bytes, SHA-256 {}",
            raw.kind,
            raw.bytes.len(),
            hash(&raw.bytes)
        ),
    }
}
fn at_recorded_paths(values: &[Snapshot], sid: &str) -> Result<Vec<Snapshot>, String> {
    values
        .iter()
        .map(|before| {
            let mut current = before.clone();
            let key = registry::open(&before.resolved_key, sid, KEY_READ)?;
            current.key_existed = key.is_some();
            current.raw = match key {
                Some(key) => registry::read_value(&key, &before.name)?,
                None => None,
            };
            Ok(current)
        })
        .collect()
}
fn mapping_matches(values: &[Snapshot]) -> Result<bool, String> {
    for value in values {
        if registry::resolve_compiled_path(&value.key)? != value.resolved_key {
            return Ok(false);
        }
    }
    Ok(true)
}
fn recovery_fingerprint(state: &State, current: &[Snapshot]) -> Result<String, String> {
    let resolved: Vec<String> = current
        .iter()
        .map(|value| registry::resolve_compiled_path(&value.key))
        .collect::<Result<_, _>>()?;
    fingerprint(&(state, current, resolved))
}
fn review_recovery(state: &State) -> Result<Option<RecoveryReview>, String> {
    let Some(transaction) = state
        .transaction
        .as_ref()
        .filter(|transaction| !transaction.finished)
    else {
        return Ok(None);
    };
    let current = at_recorded_paths(&transaction.before, &state.caller_sid)?;
    let mapping_mismatch = !mapping_matches(&transaction.before)?;
    let legacy = transaction.targets.is_none();
    let resources = transaction
        .before
        .iter()
        .zip(&current)
        .enumerate()
        .map(|(index, (before, current))| {
            let target = transaction.targets.as_ref().map(|targets| &targets[index]);
            let classification = if current.raw == before.raw {
                "before"
            } else if target.is_some_and(|target| *target == current.raw) {
                "target"
            } else {
                "other"
            };
            ResourceReview {
                key: before.resolved_key.clone(),
                name: before.name.clone(),
                before: raw_summary(&before.raw),
                target: target
                    .map(raw_summary)
                    .unwrap_or_else(|| "Not recorded by this journal version".into()),
                current: raw_summary(&current.raw),
                classification: classification.into(),
            }
        })
        .collect();
    let mut safe_decisions = vec!["acceptCurrent".into()];
    if !mapping_mismatch && !legacy {
        safe_decisions.push("reconcile".into());
        safe_decisions.push("rollbackOwned".into());
    }
    Ok(Some(RecoveryReview {
        transaction_id: transaction.id.clone(),
        legacy,
        mapping_mismatch,
        outcome: transaction.outcome.clone(),
        resources,
        safe_decisions,
    }))
}
fn authority_for(tweak: &Tweak, sid: &str) -> Result<Authority, String> {
    Ok(
        if broker::is_elevated()?
            || tweak.values.iter().any(|resource| {
                resource.key.starts_with("HKLM\\")
                    || registry::can_mutate(&resource.key, sid).is_err()
            })
        {
            Authority::Machine
        } else {
            Authority::User
        },
    )
}
pub fn prepare_recovery(request: RecoveryRequest) -> Result<PlanView, String> {
    let tweak = tweak(&request.tweak_id)?;
    let sid = broker::current_sid()?;
    let authority = authority_for(tweak, &sid)?;
    let state = load_state(authority, &sid, tweak)?;
    let review = review_recovery(&state)?.ok_or("No unfinished native transaction exists")?;
    if review.transaction_id != request.transaction_id {
        return Err("Recovery transaction changed".into());
    }
    let decision = match request.decision {
        RecoveryDecision::Reconcile => "reconcile",
        RecoveryDecision::RollbackOwned => "rollbackOwned",
        RecoveryDecision::AcceptCurrent => "acceptCurrent",
    };
    if !review.safe_decisions.iter().any(|safe| safe == decision) {
        return Err("This recovery decision is not safe for the recorded state".into());
    }
    let current = at_recorded_paths(
        &state
            .transaction
            .as_ref()
            .ok_or("Missing transaction")?
            .before,
        &sid,
    )?;
    let id = broker::reserve_plan()?;
    let envelope = Envelope {
        request: Request {
            tweak_id: request.tweak_id.clone(),
            enabled: false,
        },
        caller_sid: sid,
        catalog_digest: catalog()?.digest.clone(),
        expected_fingerprint: fingerprint(&current)?,
        deadline_utc_ms: now_ms()?.saturating_add(120000),
        parent_pid: std::process::id(),
        recovery: Some(request),
        recovery_fingerprint: Some(recovery_fingerprint(&state, &current)?),
    };
    let view = PlanView {
        id: id.clone(),
        tweak_id: tweak.id.clone(),
        enabled: false,
        summary: format!("Review native recovery for {}", tweak.title),
        effect: tweak.effect.clone(),
        requires_elevation: authority == Authority::Machine,
    };
    let mut pending = plans().lock().map_err(|e| e.to_string())?;
    pending.retain(|_, item| item.prepared.elapsed() < Duration::from_secs(120));
    pending.insert(
        id,
        Pending {
            envelope,
            prepared: Instant::now(),
        },
    );
    Ok(view)
}
fn recover_envelope(
    envelope: &Envelope,
    authority: Authority,
    before_commit: impl FnOnce() -> Result<(), String>,
) -> Result<ResultView, String> {
    let _lease = broker::domain_lease(&envelope.caller_sid)?;
    let request = envelope
        .recovery
        .as_ref()
        .ok_or("Missing recovery request")?;
    if request.tweak_id != envelope.request.tweak_id
        || envelope.catalog_digest != catalog()?.digest
        || now_ms()? > envelope.deadline_utc_ms
        || envelope.deadline_utc_ms > now_ms()?.saturating_add(120000)
    {
        return Err("Invalid recovery plan binding or deadline".into());
    }
    let tweak = tweak(&request.tweak_id)?;
    if authority == Authority::User
        && (broker::is_elevated()?
            || tweak
                .values
                .iter()
                .any(|resource| resource.key.starts_with("HKLM\\")))
    {
        return Err("User recovery cannot authorize privileged writes".into());
    }
    let mut state = load_state(authority, &envelope.caller_sid, tweak)?;
    let transaction = state
        .transaction
        .as_ref()
        .ok_or("Missing recovery transaction")?
        .clone();
    if transaction.id != request.transaction_id || transaction.finished {
        return Err("Recovery transaction is no longer pending".into());
    }
    let current = at_recorded_paths(&transaction.before, &envelope.caller_sid)?;
    if Some(recovery_fingerprint(&state, &current)?) != envelope.recovery_fingerprint {
        return Err("Recovery evidence changed; inspect again".into());
    }
    let mapping_ok = mapping_matches(&transaction.before)?;
    if !matches!(request.decision, RecoveryDecision::AcceptCurrent)
        && (!mapping_ok || transaction.targets.is_none())
    {
        return Err("Only Accept current is available for this legacy or remapped journal".into());
    }
    let description = match request.decision { RecoveryDecision::Reconcile => "Compare before/target/current and record the observed result. This makes no registry changes.", RecoveryDecision::RollbackOwned => "Restore only operation-owned writes still holding the recorded target. Concurrent unrelated values cause the entire rollback to be refused before any write. Empty created keys remain.", RecoveryDecision::AcceptCurrent => "Acknowledge the current values and close this uncertain journal without changing the registry. First originals and operation evidence remain. This is not a rollback." };
    let paths = transaction
        .before
        .iter()
        .map(|value| format!("{} [{}]", value.resolved_key, value.name))
        .collect::<Vec<_>>()
        .join("\n");
    broker::confirm_native(&format!(
        "Native Debloat recovery: {}\nTransaction: {}\n\n{}\n\n{}",
        tweak.title, transaction.id, description, paths
    ))?;
    before_commit()?;
    broker::require_live_parent(envelope.parent_pid)?;
    if now_ms()? > envelope.deadline_utc_ms {
        return Err("Recovery consent expired".into());
    }
    let after = at_recorded_paths(&transaction.before, &envelope.caller_sid)?;
    if Some(recovery_fingerprint(&state, &after)?) != envelope.recovery_fingerprint {
        return Err("Recovery state changed during consent; nothing was written".into());
    }
    let outcome = match request.decision {
        RecoveryDecision::AcceptCurrent => {
            let item = state.transaction.as_mut().ok_or("Missing transaction")?;
            item.acknowledged = Some(after);
            item.finished = true;
            "acceptedCurrent"
        }
        RecoveryDecision::Reconcile => {
            let targets = transaction.targets.as_ref().ok_or("Missing targets")?;
            let all_before = after
                .iter()
                .zip(&transaction.before)
                .all(|(current, before)| current.raw == before.raw);
            let all_target = after
                .iter()
                .zip(targets)
                .all(|(current, target)| current.raw == *target);
            let mixed = after.iter().zip(&transaction.before).zip(targets).all(
                |((current, before), target)| current.raw == before.raw || current.raw == *target,
            );
            let outcome = if all_before {
                if transaction.recovery.is_some() {
                    "rolledBack"
                } else {
                    "noChanges"
                }
            } else if all_target {
                "applied"
            } else if mixed {
                "interruptedPartial"
            } else {
                "conflict"
            };
            if all_before || all_target {
                state
                    .transaction
                    .as_mut()
                    .ok_or("Missing transaction")?
                    .finished = true;
            }
            outcome
        }
        RecoveryDecision::RollbackOwned => {
            let targets = transaction.targets.as_ref().ok_or("Missing targets")?;
            // Validate every resource before recording or executing any rollback.
            for (index, ((current, before), target)) in after
                .iter()
                .zip(&transaction.before)
                .zip(targets)
                .enumerate()
            {
                let owned =
                    transaction.completed.contains(&index) || transaction.in_flight == Some(index);
                if current.raw != before.raw && (!owned || current.raw != *target) {
                    return Err("Rollback conflict: a resource differs from both its owned target and before-state; no rollback writes were started".into());
                }
                if current.raw != before.raw
                    && transaction
                        .recovery
                        .as_ref()
                        .is_some_and(|rollback| rollback.completed.contains(&index))
                {
                    return Err("A previously rolled-back resource changed again; no rollback writes were started".into());
                }
                if owned && current.raw != before.raw {
                    registry::can_mutate(&before.resolved_key, &envelope.caller_sid)?;
                }
            }
            if state
                .transaction
                .as_ref()
                .and_then(|item| item.recovery.as_ref())
                .is_none()
            {
                state
                    .transaction
                    .as_mut()
                    .ok_or("Missing transaction")?
                    .recovery = Some(Rollback {
                    completed: Vec::new(),
                    in_flight: None,
                });
            }
            save(authority, &state)?;
            for (index, ((current, before), target)) in after
                .iter()
                .zip(&transaction.before)
                .zip(targets)
                .enumerate()
            {
                if current.raw == before.raw {
                    let rollback = state
                        .transaction
                        .as_mut()
                        .and_then(|item| item.recovery.as_mut())
                        .ok_or("Missing rollback journal")?;
                    if rollback.in_flight == Some(index) {
                        rollback.in_flight = None;
                        if !rollback.completed.contains(&index) {
                            rollback.completed.push(index);
                        }
                        save(authority, &state)?;
                    }
                    continue;
                }
                if registry::resolve_compiled_path(&before.key)? != before.resolved_key {
                    return Err(
                        "Control-set mapping changed during rollback; journal retained".into(),
                    );
                }
                let key =
                    registry::open(&before.resolved_key, &envelope.caller_sid, KEY_SET_VALUE)?
                        .ok_or("Rollback resource disappeared")?;
                if registry::read_value(&key, &before.name)? != *target {
                    return Err("Rollback target changed; journal retained".into());
                }
                let recovery = state
                    .transaction
                    .as_mut()
                    .and_then(|item| item.recovery.as_mut())
                    .ok_or("Missing rollback journal")?;
                if recovery.completed.contains(&index) {
                    return Err(
                        "Previously completed rollback resource changed again; journal retained"
                            .into(),
                    );
                }
                recovery.in_flight = Some(index);
                save(authority, &state)?;
                if registry::read_value(&key, &before.name)? != *target {
                    return Err("Rollback target changed after intent; journal retained".into());
                }
                registry::write(&key, &before.name, before.raw.as_ref())?;
                if registry::read_value(&key, &before.name)? != before.raw {
                    return Err("Rollback write could not be verified; journal retained".into());
                }
                let recovery = state
                    .transaction
                    .as_mut()
                    .and_then(|item| item.recovery.as_mut())
                    .ok_or("Missing rollback journal")?;
                recovery.completed.push(index);
                recovery.in_flight = None;
                save(authority, &state)?;
            }
            if !at_recorded_paths(&transaction.before, &envelope.caller_sid)?
                .iter()
                .zip(&transaction.before)
                .all(|(current, before)| current.raw == before.raw)
            {
                return Err("Rollback verification changed; journal retained".into());
            }
            state
                .transaction
                .as_mut()
                .ok_or("Missing transaction")?
                .finished = true;
            "rolledBack"
        }
    };
    state
        .transaction
        .as_mut()
        .ok_or("Missing transaction")?
        .outcome = Some(outcome.into());
    save(authority, &state)?;
    Ok(ResultView {
        ok: true,
        restored_original: false,
        applied_defaults: false,
        outcome: outcome.into(),
    })
}
fn dispatch_envelope(
    envelope: &Envelope,
    authority: Authority,
    before_commit: impl FnOnce() -> Result<(), String>,
) -> Result<ResultView, String> {
    if envelope.recovery.is_some() {
        recover_envelope(envelope, authority, before_commit)
    } else {
        execute_envelope(envelope, authority, before_commit)
    }
}
pub fn execute(id: &str) -> Result<ResultView, String> {
    broker::consume_plan(id)?;
    let pending = plans()
        .lock()
        .map_err(|e| e.to_string())?
        .remove(id)
        .ok_or("Debloat plan is missing or used")?;
    if pending.prepared.elapsed() >= Duration::from_secs(120) {
        return Err("Debloat plan expired".into());
    }
    let sid = broker::current_sid()?;
    if sid != pending.envelope.caller_sid {
        return Err("Debloat caller identity changed".into());
    }
    let tweak = tweak(&pending.envelope.request.tweak_id)?;
    let privileged = broker::is_elevated()?
        || tweak.values.iter().any(|resource| {
            resource.key.starts_with("HKLM\\") || registry::can_mutate(&resource.key, &sid).is_err()
        });
    if !privileged {
        return dispatch_envelope(&pending.envelope, Authority::User, || Ok(()));
    }
    let pipe_name = format!(
        "{PIPE_PREFIX}{}-{}",
        std::process::id(),
        broker::random_id()?
    );
    let pipe = broker::server_pipe(&pipe_name)?;
    let helper = broker::launch_domain_helper(broker::HelperKind::Debloat, &pipe_name)?;
    broker::accept_pipe(pipe.0)?;
    broker::authenticate_client(pipe.0, helper.0)?;
    broker::send(pipe.0, &pending.envelope)?;
    let result = match broker::receive::<Message>(pipe.0)? {
        Message::Ready => {
            broker::authenticate_client(pipe.0, helper.0)?;
            broker::send(pipe.0, &true)?;
            broker::receive::<Message>(pipe.0)?
        }
        result => result,
    };
    match result {
        Message::Result {
            result: Some(result),
            error: None,
        } => Ok(result),
        Message::Result { error, .. } => {
            Err(error.unwrap_or_else(|| "Debloat helper returned no result".into()))
        }
        _ => Err("Invalid Debloat commit phase".into()),
    }
}
pub(crate) fn helper(pipe_name: &str) -> Result<(), String> {
    if !broker::is_elevated()? {
        return Err("Debloat helper is not elevated".into());
    }
    let (pid, nonce) = pipe_name
        .strip_prefix(PIPE_PREFIX)
        .ok_or("Invalid Debloat pipe")?
        .split_once('-')
        .ok_or("Invalid Debloat pipe")?;
    let pid = pid.parse::<u32>().map_err(|e| e.to_string())?;
    if nonce.len() != 32 || !nonce.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("Invalid Debloat nonce".into());
    }
    let pipe = broker::client_pipe(pipe_name, pid)?;
    let actual_sid = broker::process_sid(pid)?;
    let envelope: Envelope = broker::receive(pipe.0)?;
    if envelope.parent_pid != pid || envelope.caller_sid != actual_sid {
        return Err("Debloat caller authentication mismatch".into());
    }
    let result = dispatch_envelope(&envelope, Authority::Machine, || {
        broker::send(pipe.0, &Message::Ready)?;
        if !broker::receive::<bool>(pipe.0)? {
            return Err("Parent refused Debloat commit".into());
        }
        Ok(())
    });
    let message = match result {
        Ok(result) => Message::Result {
            result: Some(result),
            error: None,
        },
        Err(error) => Message::Result {
            result: None,
            error: Some(error),
        },
    };
    broker::send(pipe.0, &message)
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    id: String,
    category: String,
    title: String,
    detail: String,
    effect: String,
    admin: bool,
    enabled: bool,
    partial: bool,
    unknown: bool,
    error: Option<String>,
    recovery: Option<RecoveryReview>,
}
pub fn list() -> Result<Vec<Status>, String> {
    let sid = broker::current_sid()?;
    catalog()?
        .tweaks
        .iter()
        .map(|tweak| {
            let state = capture(tweak, &sid);
            let (enabled, partial, unknown, error) = match state {
                Ok(values) => {
                    let matches = values
                        .iter()
                        .zip(&tweak.values)
                        .map(|(value, resource)| {
                            target_raw(resource, true).map(|target| target == value.raw)
                        })
                        .collect::<Result<Vec<_>, _>>()?;
                    let all = matches.iter().all(|value| *value);
                    (all, !all && matches.iter().any(|value| *value), false, None)
                }
                Err(error) => (false, false, true, Some(error)),
            };
            Ok(Status {
                id: tweak.id.clone(),
                category: tweak.category.clone(),
                title: tweak.title.clone(),
                detail: tweak.detail.clone(),
                effect: tweak.effect.clone(),
                admin: tweak
                    .values
                    .iter()
                    .any(|value| value.key.starts_with("HKLM\\")),
                enabled,
                partial,
                unknown,
                error,
                recovery: {
                    let authority = authority_for(tweak, &sid)?;
                    let state = load_state(authority, &sid, tweak)?;
                    review_recovery(&state)?
                },
            })
        })
        .collect()
}
