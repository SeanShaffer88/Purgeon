//! One-shot Windows Event Log reads for the two closed persistence targets.
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::ffi::c_void;
use std::mem::size_of;
use std::ptr::null_mut;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const LOOKBACK_DAYS: u64 = 7;
const LOOKBACK_MS: u64 = LOOKBACK_DAYS * 86_400_000;
const MAX_CANDIDATES: usize = 1024;
const MAX_EVENTS: usize = 24;
const MAX_RENDER_BYTES: usize = 16 * 1024;
const MAX_RENDER_TOTAL: usize = 2 * 1024 * 1024;
const DEADLINE: Duration = Duration::from_secs(4);
const FILETIME_EPOCH: u64 = 116_444_736_000_000_000;
const SECURITY: &str = "Security";
const TASK_LOG: &str = "Microsoft-Windows-TaskScheduler/Operational";
const AUDIT_PROVIDER: &str = "Microsoft-Windows-Security-Auditing";
const TASK_PROVIDER: &str = "Microsoft-Windows-TaskScheduler";
const RUN_SUFFIX: &str = r"Microsoft\Windows\CurrentVersion\Run";
static QUERY: AtomicBool = AtomicBool::new(false);

#[derive(Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RunSource {
    HkcuRun,
    HklmRun,
    HklmRun32,
}
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Request {
    Run { source: RunSource, name: String },
    Task { path: String },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum Status {
    Matches,
    NoMatch,
    Disabled,
    Denied,
    Unsupported,
    Partial,
    Unavailable,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum Action {
    Created,
    Registered,
    Updated,
    Deleted,
    Disabled,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Evidence {
    record_id: String,
    at_ms: u64,
    action: Action,
    writer_process: Option<String>,
    writer_pid: Option<u32>,
    account: Option<String>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Trace {
    status: Status,
    lookback_days: u64,
    events: Vec<Evidence>,
}
impl Trace {
    fn empty(status: Status) -> Self {
        Self {
            status,
            lookback_days: LOOKBACK_DAYS,
            events: Vec::new(),
        }
    }
}

enum Target {
    Run { object: String, name: String },
    Task(String),
}
impl RunSource {
    fn object(&self, sid: impl FnOnce() -> Result<String, String>) -> Result<String, String> {
        Ok(match self {
            Self::HkcuRun => format!(r"\REGISTRY\USER\{}\SOFTWARE\{RUN_SUFFIX}", sid()?),
            Self::HklmRun => format!(r"\REGISTRY\MACHINE\SOFTWARE\{RUN_SUFFIX}"),
            Self::HklmRun32 => format!(r"\REGISTRY\MACHINE\SOFTWARE\WOW6432Node\{RUN_SUFFIX}"),
        })
    }
}
impl Target {
    fn new(request: Request) -> Result<Self, String> {
        match request {
            Request::Run { source, name } => {
                if name.is_empty() || name.len() > 1024 || name.chars().any(char::is_control) {
                    return Err("Unsupported Run value name".into());
                }
                Ok(Self::Run {
                    object: source.object(crate::broker::current_sid)?,
                    name,
                })
            }
            Request::Task { path } => {
                crate::task_platform::task_path(&path)?;
                Ok(Self::Task(path))
            }
        }
    }
    fn channel(&self) -> &'static str {
        match self {
            Self::Run { .. } => SECURITY,
            Self::Task(_) => TASK_LOG,
        }
    }
    fn query(&self) -> String {
        let (provider, ids) = match self {
            Self::Run { .. } => (AUDIT_PROVIDER, "EventID=4657"),
            Self::Task(_) => (
                TASK_PROVIDER,
                "EventID=106 or EventID=140 or EventID=141 or EventID=142",
            ),
        };
        format!("*[System[Provider[@Name='{provider}'] and ({ids}) and TimeCreated[timediff(@SystemTime) <= {LOOKBACK_MS}]]]")
    }
    fn render_paths(&self) -> Vec<&'static str> {
        let mut paths = vec![
            "Event/System/Provider/@Name",
            "Event/System/EventID",
            "Event/System/Version",
            "Event/System/EventRecordID",
            "Event/System/TimeCreated/@SystemTime",
            "Event/System/Channel",
        ];
        match self {
            Self::Run { .. } => paths.extend([
                "Event/EventData/Data[@Name='ObjectName']",
                "Event/EventData/Data[@Name='ObjectValueName']",
                "Event/EventData/Data[@Name='OperationType']",
                "Event/EventData/Data[@Name='ProcessName']",
                "Event/EventData/Data[@Name='ProcessId']",
            ]),
            Self::Task(_) => paths.extend([
                "Event/EventData/Data[@Name='TaskName']",
                "Event/EventData/Data[@Name='UserContext']",
                "Event/EventData/Data[@Name='UserName']",
            ]),
        }
        paths
    }
}

type Handle = *mut c_void;
#[repr(C)]
struct Variant {
    data: u64,
    count: u32,
    kind: u32,
}

#[link(name = "wevtapi")]
extern "system" {
    fn EvtQuery(session: Handle, path: *const u16, query: *const u16, flags: u32) -> Handle;
    fn EvtNext(
        query: Handle,
        count: u32,
        events: *mut Handle,
        timeout: u32,
        flags: u32,
        returned: *mut u32,
    ) -> i32;
    fn EvtCreateRenderContext(count: u32, paths: *const *const u16, flags: u32) -> Handle;
    fn EvtRender(
        context: Handle,
        event: Handle,
        flags: u32,
        size: u32,
        buffer: *mut c_void,
        used: *mut u32,
        count: *mut u32,
    ) -> i32;
    fn EvtOpenChannelConfig(session: Handle, path: *const u16, flags: u32) -> Handle;
    fn EvtGetChannelConfigProperty(
        config: Handle,
        property: u32,
        flags: u32,
        size: u32,
        buffer: *mut Variant,
        used: *mut u32,
    ) -> i32;
    fn EvtClose(handle: Handle) -> i32;
}
#[link(name = "kernel32")]
extern "system" {
    fn CompareStringOrdinal(
        left: *const u16,
        left_len: i32,
        right: *const u16,
        right_len: i32,
        ignore_case: i32,
    ) -> i32;
}
struct EventApi {
    query: unsafe extern "system" fn(Handle, *const u16, *const u16, u32) -> Handle,
    next: unsafe extern "system" fn(Handle, u32, *mut Handle, u32, u32, *mut u32) -> i32,
    render_context: unsafe extern "system" fn(u32, *const *const u16, u32) -> Handle,
    render:
        unsafe extern "system" fn(Handle, Handle, u32, u32, *mut c_void, *mut u32, *mut u32) -> i32,
    channel: unsafe extern "system" fn(Handle, *const u16, u32) -> Handle,
    channel_property:
        unsafe extern "system" fn(Handle, u32, u32, u32, *mut Variant, *mut u32) -> i32,
    close: unsafe extern "system" fn(Handle) -> i32,
}
static WINDOWS: EventApi = EventApi {
    query: EvtQuery,
    next: EvtNext,
    render_context: EvtCreateRenderContext,
    render: EvtRender,
    channel: EvtOpenChannelConfig,
    channel_property: EvtGetChannelConfigProperty,
    close: EvtClose,
};
struct Owned(Handle, &'static EventApi);
impl Owned {
    fn new(handle: Handle, api: &'static EventApi) -> Result<Self, i32> {
        if handle.is_null() {
            Err(error_code())
        } else {
            Ok(Self(handle, api))
        }
    }
}
impl Drop for Owned {
    fn drop(&mut self) {
        unsafe { (self.1.close)(self.0) };
    }
}
fn error_code() -> i32 {
    std::io::Error::last_os_error().raw_os_error().unwrap_or(-1)
}
fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(Some(0)).collect()
}
fn windows_equal(left: &str, right: &str) -> bool {
    let left = wide(left);
    let right = wide(right);
    unsafe {
        CompareStringOrdinal(
            left.as_ptr(),
            (left.len() - 1) as i32,
            right.as_ptr(),
            (right.len() - 1) as i32,
            1,
        ) == 2
    }
}
fn status_for_error(code: i32) -> Status {
    match code {
        5 | 1314 => Status::Denied,
        50 | 15007 => Status::Unsupported,
        1460 | 15011 => Status::Partial,
        _ => Status::Unavailable,
    }
}
fn enabled(channel: &[u16], api: &'static EventApi) -> Result<bool, i32> {
    let config = Owned::new(
        unsafe { (api.channel)(null_mut(), channel.as_ptr(), 0) },
        api,
    )?;
    let mut value = Variant {
        data: 0,
        count: 0,
        kind: 0,
    };
    let mut used = 0;
    if unsafe {
        (api.channel_property)(
            config.0,
            0,
            0,
            size_of::<Variant>() as u32,
            &mut value,
            &mut used,
        )
    } == 0
    {
        return Err(error_code());
    }
    if value.kind != 13 {
        return Err(-1);
    }
    Ok(value.data as u32 != 0)
}

// The Windows render buffer is aligned for EVT_VARIANT. String pointers may only
// reference the returned buffer and are read with both byte and character limits.
struct Rendered {
    storage: Vec<u64>,
    used: usize,
    count: usize,
}
impl Rendered {
    fn variant(&self, index: usize) -> Option<&Variant> {
        if index >= self.count {
            return None;
        }
        Some(unsafe { &*self.storage.as_ptr().cast::<Variant>().add(index) })
    }
    fn number(&self, index: usize, kinds: &[u32]) -> Option<u64> {
        let variant = self.variant(index)?;
        if !kinds.contains(&variant.kind) {
            return None;
        }
        Some(match variant.kind {
            4 => variant.data & 0xff,
            6 => variant.data & 0xffff,
            8 | 20 => variant.data & 0xffff_ffff,
            _ => variant.data,
        })
    }
    fn text(&self, index: usize) -> Option<String> {
        let variant = self.variant(index)?;
        if variant.kind != 1 {
            return None;
        }
        let start = self.storage.as_ptr() as usize;
        let offset = (variant.data as usize).checked_sub(start)?;
        if offset < self.count * size_of::<Variant>()
            || offset >= self.used
            || !offset.is_multiple_of(2)
        {
            return None;
        }
        let length = ((self.used - offset) / 2).min(2049);
        let pointer = unsafe { self.storage.as_ptr().cast::<u8>().add(offset).cast::<u16>() };
        let wide = unsafe { std::slice::from_raw_parts(pointer, length) };
        let end = wide.iter().position(|c| *c == 0)?;
        String::from_utf16(&wide[..end]).ok()
    }
}
fn render(
    context: &Owned,
    event: &Owned,
    expected: usize,
    remaining_bytes: &mut usize,
) -> Option<Rendered> {
    let mut used = 0;
    let mut count = 0;
    let ok =
        unsafe { (context.1.render)(context.0, event.0, 0, 0, null_mut(), &mut used, &mut count) };
    if ok != 0
        || error_code() != 122
        || !(expected * size_of::<Variant>()..=MAX_RENDER_BYTES).contains(&(used as usize))
    {
        return None;
    }
    if used as usize > *remaining_bytes {
        *remaining_bytes = 0;
        return None;
    }
    *remaining_bytes -= used as usize;
    let mut storage = vec![0u64; (used as usize).div_ceil(size_of::<u64>())];
    let size = used;
    if unsafe {
        (context.1.render)(
            context.0,
            event.0,
            0,
            size,
            storage.as_mut_ptr().cast(),
            &mut used,
            &mut count,
        )
    } == 0
        || used > size
        || count as usize != expected
        || (used as usize) < expected * size_of::<Variant>()
    {
        return None;
    }
    Some(Rendered {
        storage,
        used: used as usize,
        count: count as usize,
    })
}

enum Match {
    Skip,
    Unsupported,
    Partial,
    Event(Evidence),
}
fn matched(target: &Target, event: &Rendered, now: u64) -> Match {
    let provider = match target {
        Target::Run { .. } => AUDIT_PROVIDER,
        Target::Task(_) => TASK_PROVIDER,
    };
    let Some(id) = event.number(1, &[6]) else {
        return Match::Partial;
    };
    if event.text(0).as_deref() != Some(provider)
        || event.text(5).as_deref() != Some(target.channel())
    {
        return Match::Partial;
    }
    let Some(at_ms) = event
        .number(4, &[17])
        .and_then(|n| n.checked_sub(FILETIME_EPOCH))
        .map(|n| n / 10_000)
    else {
        return Match::Partial;
    };
    if at_ms > now || at_ms < now.saturating_sub(LOOKBACK_MS) {
        return Match::Skip;
    }
    let Some(object) = event.text(6) else {
        return Match::Partial;
    };
    let action = match target {
        Target::Run {
            object: expected,
            name,
        } => {
            if id != 4657 || !windows_equal(&object, expected) {
                return Match::Skip;
            }
            let Some(value) = event.text(7) else {
                return Match::Partial;
            };
            if !windows_equal(&value, name) {
                return Match::Skip;
            }
            if event.number(2, &[4]) != Some(0) {
                return Match::Unsupported;
            }
            match event.text(8).as_deref() {
                Some("%%1904") => Action::Created,
                Some("%%1905" | "%%1906") => return Match::Skip,
                _ => return Match::Unsupported,
            }
        }
        Target::Task(expected) => {
            if !windows_equal(&object, expected) {
                return Match::Skip;
            }
            if event.number(2, &[4]) != Some(0) {
                return Match::Unsupported;
            }
            match id {
                106 => Action::Registered,
                140 => Action::Updated,
                141 => Action::Deleted,
                142 => Action::Disabled,
                _ => return Match::Unsupported,
            }
        }
    };
    let Some(record_id) = event.number(3, &[10]).filter(|id| *id > 0) else {
        return Match::Partial;
    };
    let safe_text = |index| {
        event
            .text(index)
            .filter(|s| !s.is_empty() && s.len() <= 1024 && !s.chars().any(char::is_control))
    };
    let mut evidence = Evidence {
        record_id: record_id.to_string(),
        at_ms,
        action,
        writer_process: None,
        writer_pid: None,
        account: None,
    };
    match target {
        Target::Run { .. } => {
            evidence.writer_process = safe_text(9);
            evidence.writer_pid = event
                .number(10, &[8, 10, 16, 20, 21])
                .and_then(|pid| u32::try_from(pid).ok())
                .or_else(|| {
                    event
                        .text(10)
                        .and_then(|pid| u32::from_str_radix(pid.strip_prefix("0x")?, 16).ok())
                })
                .filter(|pid| *pid > 0);
        }
        Target::Task(_) => evidence.account = safe_text(if id == 106 { 7 } else { 8 }),
    }
    Match::Event(evidence)
}

fn read(request: Request, deadline: Instant, api: &'static EventApi) -> Trace {
    let Ok(target) = Target::new(request) else {
        return Trace::empty(Status::Unsupported);
    };
    let channel = wide(target.channel());
    if Instant::now() >= deadline {
        return Trace::empty(Status::Partial);
    }
    match enabled(&channel, api) {
        Ok(false) => return Trace::empty(Status::Disabled),
        Err(code) => return Trace::empty(status_for_error(code)),
        Ok(true) => {}
    }
    if Instant::now() >= deadline {
        return Trace::empty(Status::Partial);
    }
    let query = match Owned::new(
        unsafe {
            (api.query)(
                null_mut(),
                channel.as_ptr(),
                wide(&target.query()).as_ptr(),
                0x201,
            )
        },
        api,
    ) {
        Ok(query) => query,
        Err(code) => return Trace::empty(status_for_error(code)),
    };
    if Instant::now() >= deadline {
        return Trace::empty(Status::Partial);
    }
    let paths: Vec<_> = target
        .render_paths()
        .iter()
        .map(|path| wide(path))
        .collect();
    let pointers: Vec<_> = paths.iter().map(|path| path.as_ptr()).collect();
    let context = match Owned::new(
        unsafe { (api.render_context)(pointers.len() as u32, pointers.as_ptr(), 0) },
        api,
    ) {
        Ok(context) => context,
        Err(code) => return Trace::empty(status_for_error(code)),
    };
    let Ok(now) = SystemTime::now().duration_since(UNIX_EPOCH) else {
        return Trace::empty(Status::Unavailable);
    };
    let mut output = Trace::empty(Status::Partial);
    let mut seen = HashSet::new();
    let mut incomplete = false;
    let mut unsupported = false;
    let mut remaining_bytes = MAX_RENDER_TOTAL;
    for _ in 0..MAX_CANDIDATES {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() || remaining_bytes == 0 {
            break;
        }
        let mut event = null_mut();
        let mut returned = 0;
        let ok = unsafe {
            (api.next)(
                query.0,
                1,
                &mut event,
                remaining.as_millis().clamp(1, 200) as u32,
                0,
                &mut returned,
            )
        };
        let next_error = if ok == 0 { Some(error_code()) } else { None };
        let event = if event.is_null() {
            None
        } else {
            Some(Owned(event, api))
        };
        if let Some(code) = next_error {
            output.status = if code == 259 {
                if incomplete || (unsupported && !output.events.is_empty()) {
                    Status::Partial
                } else if unsupported {
                    Status::Unsupported
                } else if output.events.is_empty() {
                    Status::NoMatch
                } else {
                    Status::Matches
                }
            } else if output.events.is_empty() {
                status_for_error(code)
            } else {
                Status::Partial
            };
            break;
        }
        let Some(event) = event.filter(|_| returned == 1) else {
            break;
        };
        let Some(rendered) = render(&context, &event, pointers.len(), &mut remaining_bytes) else {
            incomplete = true;
            continue;
        };
        if Instant::now() >= deadline {
            break;
        }
        match matched(&target, &rendered, now.as_millis() as u64) {
            Match::Skip => {}
            Match::Unsupported => unsupported = true,
            Match::Partial => incomplete = true,
            Match::Event(event) => {
                if seen.insert(event.record_id.clone()) {
                    output.events.push(event);
                }
                if output.events.len() == MAX_EVENTS {
                    break;
                }
            }
        }
    }
    output
        .events
        .sort_by_key(|event| std::cmp::Reverse(event.at_ms));
    output
}

struct QueryAdmission<'a>(&'a AtomicBool);
impl<'a> QueryAdmission<'a> {
    fn acquire(busy: &'a AtomicBool) -> Option<Self> {
        busy.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .ok()
            .map(|_| Self(busy))
    }
}
impl Drop for QueryAdmission<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

fn bounded_query(
    busy: &'static AtomicBool,
    timeout: Duration,
    query: impl FnOnce(Instant) -> Trace + Send + 'static,
) -> Trace {
    let Some(admission) = QueryAdmission::acquire(busy) else {
        return Trace::empty(Status::Unavailable);
    };
    let deadline = Instant::now() + timeout;
    let (sender, receiver) = mpsc::sync_channel(1);
    if std::thread::Builder::new()
        .name("persistence-trace".into())
        .spawn(move || {
            let result = query(deadline);
            drop(admission);
            let _ = sender.send(result);
        })
        .is_err()
    {
        return Trace::empty(Status::Unavailable);
    }
    // A provider call has no cancellation handle before EvtQuery returns. Return
    // at the deadline, while the one admitted worker owns and releases its handles.
    match receiver.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
        Ok(result) => result,
        Err(mpsc::RecvTimeoutError::Timeout) => Trace::empty(Status::Partial),
        Err(mpsc::RecvTimeoutError::Disconnected) => Trace::empty(Status::Unavailable),
    }
}

pub fn trace(request: Request) -> Trace {
    bounded_query(&QUERY, DEADLINE, move |deadline| {
        read(request, deadline, &WINDOWS)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    enum Value<'a> {
        Text(&'a str),
        Number(u32, u64),
        Null,
    }

    fn values(fields: &[Value<'_>]) -> Rendered {
        let header = fields.len() * size_of::<Variant>();
        let total = header
            + fields
                .iter()
                .map(|value| match value {
                    Value::Text(text) => wide(text).len() * 2,
                    _ => 0,
                })
                .sum::<usize>();
        let mut storage = vec![0u64; total.div_ceil(8)];
        let mut offset = header;
        for (index, field) in fields.iter().enumerate() {
            let (kind, data) = match field {
                Value::Text(text) => {
                    let text = wide(text);
                    let ptr =
                        unsafe { storage.as_mut_ptr().cast::<u8>().add(offset).cast::<u16>() };
                    unsafe { ptr.copy_from_nonoverlapping(text.as_ptr(), text.len()) };
                    offset += text.len() * 2;
                    (1, ptr as u64)
                }
                Value::Number(kind, value) => (*kind, *value),
                Value::Null => (0, 0),
            };
            unsafe {
                storage
                    .as_mut_ptr()
                    .cast::<Variant>()
                    .add(index)
                    .write(Variant {
                        data,
                        count: 0,
                        kind,
                    })
            };
        }
        Rendered {
            storage,
            used: total,
            count: fields.len(),
        }
    }

    const NOW: u64 = 1_780_000_000_000;
    fn run_event(path: &str, name: &str, op: &str, at: u64) -> Rendered {
        values(&[
            Value::Text(AUDIT_PROVIDER),
            Value::Number(6, 4657),
            Value::Number(4, 0),
            Value::Number(10, 42),
            Value::Number(17, FILETIME_EPOCH + at * 10_000),
            Value::Text(SECURITY),
            Value::Text(path),
            Value::Text(name),
            Value::Text(op),
            Value::Text(r"C:\Fixture\writer.exe"),
            Value::Number(16, 321),
        ])
    }
    fn task_event(path: &str, id: u64, version: u64) -> Rendered {
        task_event_at(path, id, version, NOW, 77)
    }
    fn task_event_at(path: &str, id: u64, version: u64, at: u64, record: u64) -> Rendered {
        values(&[
            Value::Text(TASK_PROVIDER),
            Value::Number(6, id),
            Value::Number(4, version),
            Value::Number(10, record),
            Value::Number(17, FILETIME_EPOCH + at * 10_000),
            Value::Text(TASK_LOG),
            Value::Text(path),
            if id == 106 {
                Value::Text(r"FIXTURE\registrar")
            } else {
                Value::Null
            },
            if id != 106 {
                Value::Text(r"FIXTURE\account")
            } else {
                Value::Null
            },
        ])
    }

    struct Fixture {
        channel: Result<bool, i32>,
        events: Vec<Rendered>,
        position: usize,
        closes: [usize; 5],
        end: i32,
    }
    thread_local! {
        static FIXTURE: std::cell::RefCell<Fixture> = const { std::cell::RefCell::new(Fixture {
            channel: Ok(true), events: Vec::new(), position: 0, closes: [0; 5], end: 259,
        }) };
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn SetLastError(code: u32);
    }
    unsafe extern "system" fn fixture_channel(_: Handle, _: *const u16, _: u32) -> Handle {
        match FIXTURE.with_borrow(|state| state.channel) {
            Ok(_) => 1usize as Handle,
            Err(code) => {
                SetLastError(code as u32);
                null_mut()
            }
        }
    }
    unsafe extern "system" fn fixture_property(
        _: Handle,
        _: u32,
        _: u32,
        _: u32,
        output: *mut Variant,
        used: *mut u32,
    ) -> i32 {
        let enabled = FIXTURE.with_borrow(|state| state.channel.unwrap_or(false));
        output.write(Variant {
            data: u64::from(enabled),
            count: 0,
            kind: 13,
        });
        used.write(size_of::<Variant>() as u32);
        1
    }
    unsafe extern "system" fn fixture_query(
        _: Handle,
        _: *const u16,
        _: *const u16,
        _: u32,
    ) -> Handle {
        2usize as Handle
    }
    unsafe extern "system" fn fixture_context(_: u32, _: *const *const u16, _: u32) -> Handle {
        3usize as Handle
    }
    unsafe extern "system" fn fixture_next(
        _: Handle,
        _: u32,
        event: *mut Handle,
        _: u32,
        _: u32,
        returned: *mut u32,
    ) -> i32 {
        FIXTURE.with_borrow_mut(|state| {
            if state.position == state.events.len() {
                SetLastError(state.end as u32);
                return 0;
            }
            state.position += 1;
            event.write(4usize as Handle);
            returned.write(1);
            1
        })
    }
    unsafe extern "system" fn fixture_render(
        _: Handle,
        _: Handle,
        _: u32,
        size: u32,
        out: *mut c_void,
        used: *mut u32,
        count: *mut u32,
    ) -> i32 {
        FIXTURE.with_borrow(|state| {
            let event = &state.events[state.position - 1];
            used.write(event.used as u32);
            count.write(event.count as u32);
            if size < event.used as u32 {
                SetLastError(122);
                return 0;
            }
            let start = event.storage.as_ptr();
            std::ptr::copy_nonoverlapping(start.cast::<u8>(), out.cast::<u8>(), event.used);
            for index in 0..event.count {
                let variant = &mut *out.cast::<Variant>().add(index);
                if variant.kind == 1 {
                    variant.data = (out as usize + (variant.data as usize - start as usize)) as u64;
                }
            }
            1
        })
    }
    unsafe extern "system" fn fixture_close(handle: Handle) -> i32 {
        FIXTURE.with_borrow_mut(|state| {
            if let Some(closed) = state.closes.get_mut(handle as usize) {
                *closed += 1;
            }
        });
        1
    }
    static FIXTURE_API: EventApi = EventApi {
        query: fixture_query,
        next: fixture_next,
        render_context: fixture_context,
        render: fixture_render,
        channel: fixture_channel,
        channel_property: fixture_property,
        close: fixture_close,
    };
    fn fixture_read(
        channel: Result<bool, i32>,
        events: Vec<Rendered>,
        end: i32,
    ) -> (Trace, [usize; 5]) {
        FIXTURE.replace(Fixture {
            channel,
            events,
            position: 0,
            closes: [0; 5],
            end,
        });
        let result = read(
            Request::Task {
                path: r"\Fixture\Backup".into(),
            },
            Instant::now() + DEADLINE,
            &FIXTURE_API,
        );
        (result, FIXTURE.with_borrow(|state| state.closes))
    }
    fn time_now() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64
    }

    #[test]
    fn scanner_renders_bounds_deduplicates_and_releases_all_handles() {
        let now = time_now() - 1000;
        let current =
            |id, version, at, record| task_event_at(r"\Fixture\Backup", id, version, at, record);
        let events = vec![
            current(140, 0, now - 5000, 10),
            current(140, 0, now - 5000, 10),
            task_event_at(r"\Other\Backup", 106, 0, now - 1000, 11),
            current(106, 0, now - 2000, 12),
            current(106, 1, now - 1000, 13),
        ];
        let (result, closes) = fixture_read(Ok(true), events, 259);
        assert_eq!(result.status, Status::Partial);
        assert_eq!(
            result
                .events
                .iter()
                .map(|event| event.record_id.as_str())
                .collect::<Vec<_>>(),
            ["12", "10"]
        );
        assert_eq!(closes, [0, 1, 1, 1, 5]);

        let (result, closes) = fixture_read(Ok(true), vec![current(106, 0, now, 20)], 259);
        assert_eq!(result.status, Status::Matches);
        assert_eq!(closes, [0, 1, 1, 1, 1]);
        assert_eq!(
            fixture_read(Ok(true), vec![current(106, 1, now, 21)], 259)
                .0
                .status,
            Status::Unsupported
        );
        assert_eq!(
            fixture_read(Ok(true), Vec::new(), 259).0.status,
            Status::NoMatch
        );
        assert_eq!(
            fixture_read(Ok(false), Vec::new(), 259).0.status,
            Status::Disabled
        );
        assert_eq!(
            fixture_read(Err(5), Vec::new(), 259).0.status,
            Status::Denied
        );
        assert_eq!(
            fixture_read(Ok(true), Vec::new(), 1460).0.status,
            Status::Partial
        );
        let mut oversized = current(106, 0, now, 22);
        oversized.used = MAX_RENDER_BYTES + 1;
        assert_eq!(
            fixture_read(Ok(true), vec![oversized], 259).0.status,
            Status::Partial
        );
    }

    #[test]
    fn scanner_marks_result_and_candidate_caps_incomplete() {
        let now = time_now() - 1000;
        let all = (1..=MAX_EVENTS + 1)
            .map(|id| task_event_at(r"\Fixture\Backup", 106, 0, now, id as u64))
            .collect();
        let (rows, closes) = fixture_read(Ok(true), all, 259);
        assert_eq!(rows.status, Status::Partial);
        assert_eq!(rows.events.len(), MAX_EVENTS);
        assert_eq!(closes[4], MAX_EVENTS);

        let all = (1..=MAX_CANDIDATES + 1)
            .map(|id| task_event_at(r"\Other\Backup", 106, 0, now, id as u64))
            .collect();
        let (rows, closes) = fixture_read(Ok(true), all, 259);
        assert_eq!(rows.status, Status::Partial);
        assert!(rows.events.is_empty());
        assert_eq!(closes[4], MAX_CANDIDATES);
    }

    #[test]
    fn run_scope_is_exact_including_sid_and_wow_view() {
        let object = RunSource::HkcuRun
            .object(|| Ok("S-1-5-21-100".into()))
            .unwrap();
        let target = Target::Run {
            object: object.clone(),
            name: "Näme".into(),
        };
        let Match::Event(event) = matched(
            &target,
            &run_event(&object.to_lowercase(), "NÄME", "%%1904", NOW),
            NOW,
        ) else {
            panic!("expected exact registry creation");
        };
        assert_eq!(event.action, Action::Created);
        assert_eq!(
            event.writer_process.as_deref(),
            Some(r"C:\Fixture\writer.exe")
        );
        assert_eq!(event.writer_pid, Some(321));
        assert!(!target
            .render_paths()
            .iter()
            .any(|p| p.contains("Execution") || p.contains("OldValue") || p.contains("NewValue")));
        let wrong_sid = object.replace("S-1-5-21-100", "S-1-5-21-101");
        for (object, value, op, time) in [
            (wrong_sid.as_str(), "Näme", "%%1904", NOW),
            (&object, "Näme-extra", "%%1904", NOW),
            (&object, "Näme", "%%1905", NOW),
            (&object, "Näme", "%%1906", NOW),
            (&object, "Näme", "%%1904", NOW - LOOKBACK_MS - 1),
            (&object, "Näme", "%%1904", NOW + 1),
        ] {
            assert!(matches!(
                matched(&target, &run_event(object, value, op, time), NOW),
                Match::Skip
            ));
        }
        assert!(matches!(
            matched(&target, &run_event(&object, "Näme", "Unknown", NOW), NOW),
            Match::Unsupported
        ));
        let machine = RunSource::HklmRun
            .object(|| panic!("machine view does not use SID"))
            .unwrap();
        let wow = RunSource::HklmRun32
            .object(|| panic!("machine view does not use SID"))
            .unwrap();
        let target = Target::Run {
            object: wow.clone(),
            name: "Fixture".into(),
        };
        assert!(matches!(
            matched(&target, &run_event(&machine, "Fixture", "%%1904", NOW), NOW),
            Match::Skip
        ));
        assert!(matches!(
            matched(&target, &run_event(&wow, "Fixture", "%%1904", NOW), NOW),
            Match::Event(_)
        ));
    }

    #[test]
    fn native_task_events_use_exact_full_path_and_payload_account() {
        let target = Target::new(Request::Task {
            path: r"\Fixture\Backup".into(),
        })
        .unwrap();
        assert!(target.query().contains("EventID=142"));
        assert!(!target.query().contains("Fixture"));
        for (id, action, account) in [
            (106, Action::Registered, r"FIXTURE\registrar"),
            (140, Action::Updated, r"FIXTURE\account"),
            (141, Action::Deleted, r"FIXTURE\account"),
            (142, Action::Disabled, r"FIXTURE\account"),
        ] {
            let Match::Event(event) = matched(&target, &task_event(r"\fixture\backup", id, 0), NOW)
            else {
                panic!("expected supported task event");
            };
            assert_eq!(event.action, action);
            assert_eq!(event.account.as_deref(), Some(account));
            assert_eq!(event.writer_pid, None);
        }
        assert!(matches!(
            matched(&target, &task_event(r"\Other\Backup", 106, 0), NOW),
            Match::Skip
        ));
        assert!(matches!(
            matched(&target, &task_event(r"\Fixture\Backup", 106, 1), NOW),
            Match::Unsupported
        ));
        assert!(Target::new(Request::Task {
            path: r"\Fixture\..\Backup".into()
        })
        .is_err());
        assert!(serde_json::from_str::<Request>(
            r#"{"kind":"task","path":"\\Fixture\\Backup","xpath":"*"}"#
        )
        .is_err());
        assert!(serde_json::from_str::<Request>(
            r#"{"kind":"run","source":"hklm-run32","name":"Fixture"}"#
        )
        .is_ok());
    }

    #[test]
    fn malformed_native_values_and_provider_errors_fail_closed() {
        let mut event = task_event(r"\Fixture\Backup", 106, 0);
        unsafe { (*event.storage.as_mut_ptr().cast::<Variant>().add(6)).data = 1 };
        let target = Target::Task(r"\Fixture\Backup".into());
        assert!(matches!(matched(&target, &event, NOW), Match::Partial));
        assert_eq!(status_for_error(5), Status::Denied);
        assert_eq!(status_for_error(15007), Status::Unsupported);
        assert_eq!(status_for_error(1460), Status::Partial);
        assert_eq!(status_for_error(-1), Status::Unavailable);
        assert_eq!(
            trace(Request::Task {
                path: "not-a-task-path".into()
            })
            .status,
            Status::Unsupported
        );
    }

    #[test]
    fn deadline_returns_partial_and_the_worker_keeps_admission_until_cleanup() {
        static BUSY: AtomicBool = AtomicBool::new(false);
        let (release, wait) = mpsc::channel();
        let result = bounded_query(&BUSY, Duration::from_millis(20), move |_| {
            wait.recv().unwrap();
            Trace::empty(Status::NoMatch)
        });
        assert_eq!(result.status, Status::Partial);
        assert_eq!(
            bounded_query(&BUSY, DEADLINE, |_| panic!("a second worker was admitted")).status,
            Status::Unavailable
        );
        release.send(()).unwrap();
        let stop = Instant::now() + Duration::from_secs(2);
        while BUSY.load(Ordering::Acquire) && Instant::now() < stop {
            std::thread::yield_now();
        }
        assert!(!BUSY.load(Ordering::Acquire));
        assert_eq!(
            bounded_query(&BUSY, DEADLINE, |_| Trace::empty(Status::Disabled)).status,
            Status::Disabled
        );
    }
}
