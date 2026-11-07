//! Read-only advice from two DISM snapshots and an all-device SetupAPI sample.
use crate::{broker, driver_inventory, process_io, recovery_worker};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    ffi::c_void,
    ptr::{null, null_mut},
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

pub(crate) const MODE: &str = "--driver-advisor-worker";
pub(crate) const FAILURE: &str = "Driver retirement advice is unavailable";
const VERSION: u32 = 1;
const TIMEOUT: Duration = Duration::from_secs(30);
const MAX_FRAME: usize = 240 * 1024;
const MAX_PACKAGES: usize = 512;
const MAX_DEVICES: u32 = 32_768;
static BUSY: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
enum Request {
    Collect { version: u32 },
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Reply {
    version: u32,
    report: Report,
}
#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum Status {
    Complete,
    Partial,
    DeviceOnly,
    Unavailable,
}
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Counts {
    present: u32,
    non_present: u32,
    unknown: u32,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Package {
    published: String,
    provider: String,
    class_name: String,
    version: String,
    boot_critical: bool,
    signature: u32,
    bindings: Option<Counts>,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct DeviceBinding {
    inf: String,
    counts: Counts,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Report {
    status: Status,
    packages: Vec<Package>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    device_bindings: Vec<DeviceBinding>,
}
impl Report {
    fn unavailable() -> Self {
        Self {
            status: Status::Unavailable,
            packages: Vec::new(),
            device_bindings: Vec::new(),
        }
    }
}

#[derive(Default)]
struct Sample {
    counts: BTreeMap<String, Counts>,
    partial: bool,
    unavailable: bool,
}
impl Sample {
    fn record(&mut self, inf: String, present: Option<bool>) {
        let row = self.counts.entry(inf.to_ascii_lowercase()).or_default();
        match present {
            Some(true) => row.present += 1,
            Some(false) => row.non_present += 1,
            None => {
                row.unknown += 1;
                self.partial = true;
            }
        }
    }
}

type Inventory = BTreeMap<String, (driver_inventory::Row, bool)>;
fn inventory(rows: Vec<driver_inventory::Row>) -> Inventory {
    let mut inventory: Inventory = BTreeMap::new();
    for row in rows {
        inventory
            .entry(row.published.to_ascii_lowercase())
            .and_modify(|entry| entry.1 = true)
            .or_insert((row, false));
    }
    inventory
}

fn display_field(value: &str, max: usize) -> String {
    let mut result = String::new();
    let mut units = 0;
    for c in value.chars().filter(|c| !c.is_control()) {
        units += c.len_utf16();
        if units > max {
            break;
        }
        result.push(c);
    }
    if result.trim().is_empty() {
        "Unknown".into()
    } else {
        result
    }
}

fn advice(
    first: Vec<driver_inventory::Row>,
    sample: Sample,
    second: Vec<driver_inventory::Row>,
) -> Report {
    let first = inventory(first);
    let second = inventory(second);
    let mut packages = Vec::new();
    let mut partial = sample.partial
        || sample.unavailable
        || sample
            .counts
            .keys()
            .any(|key| !first.contains_key(key) && !second.contains_key(key));
    let mut frame_bytes = 128; // Reply fields, brackets and separators beyond each row.
    for key in first
        .keys()
        .chain(second.keys().filter(|key| !first.contains_key(*key)))
    {
        let row = second.get(key).or_else(|| first.get(key)).unwrap();
        let stable = matches!((first.get(key), second.get(key)), (Some((a, false)), Some((b, false))) if a == b);
        partial |= !stable;
        let package = Package {
            published: row.0.published.clone(),
            provider: display_field(&row.0.provider, 120),
            class_name: display_field(&row.0.class_name, 80),
            version: row.0.version.clone(),
            boot_critical: row.0.boot_critical,
            signature: row.0.signature,
            bindings: (stable && !sample.unavailable)
                .then(|| sample.counts.get(key).copied().unwrap_or_default()),
        };
        frame_bytes += 1 + serde_json::to_vec(&package).map_or(MAX_FRAME, |bytes| bytes.len());
        if packages.len() == MAX_PACKAGES || frame_bytes > MAX_FRAME {
            partial = true;
            break;
        }
        packages.push(package);
    }
    Report {
        status: if partial {
            Status::Partial
        } else {
            Status::Complete
        },
        packages,
        device_bindings: Vec::new(),
    }
}

fn inventory_or_device_only(
    inventory: Result<Report, driver_inventory::DismError>,
    sample: impl FnOnce() -> Sample,
) -> Report {
    match inventory {
        Ok(report) => report,
        Err(driver_inventory::DismError::ElevationRequired) => {
            let sample = sample();
            if sample.unavailable {
                return Report::unavailable();
            }
            Report {
                status: Status::DeviceOnly,
                packages: Vec::new(),
                device_bindings: sample
                    .counts
                    .into_iter()
                    .take(MAX_PACKAGES)
                    .map(|(inf, counts)| DeviceBinding { inf, counts })
                    .collect(),
            }
        }
        Err(_) => Report::unavailable(),
    }
}

type DeviceHandle = *mut c_void;
#[repr(C)]
struct Guid(u32, u16, u16, [u8; 8]);
#[repr(C)]
struct PropertyKey {
    id: Guid,
    pid: u32,
}
#[repr(C)]
struct DeviceInfo {
    size: u32,
    class: Guid,
    instance: u32,
    reserved: usize,
}
// The Windows SDK defines these in devpkey.h; both reads use the same DeviceInfo.
const DRIVER_INF: PropertyKey = PropertyKey {
    id: Guid(
        0xa8b865dd,
        0x2e3d,
        0x4094,
        [0xad, 0x97, 0xe5, 0x93, 0xa7, 0x0c, 0x75, 0xd6],
    ),
    pid: 5,
};
const IS_PRESENT: PropertyKey = PropertyKey {
    id: Guid(
        0x540b947e,
        0x8b40,
        0x45bc,
        [0xa8, 0xa2, 0x6a, 0x0b, 0x89, 0x4c, 0xbd, 0xa2],
    ),
    pid: 5,
};
const DIGCF_ALLCLASSES: u32 = 4;
const ERROR_NO_MORE_ITEMS: i32 = 259;
const ERROR_NOT_FOUND: i32 = 1168;
const DEVPROP_TYPE_BOOLEAN: u32 = 0x11;
const DEVPROP_TYPE_STRING: u32 = 0x12;
type GetClass =
    unsafe extern "system" fn(*const Guid, *const u16, DeviceHandle, u32) -> DeviceHandle;
type Enumerate = unsafe extern "system" fn(DeviceHandle, u32, *mut DeviceInfo) -> i32;
type ReadProperty = unsafe extern "system" fn(
    DeviceHandle,
    *mut DeviceInfo,
    *const PropertyKey,
    *mut u32,
    *mut u8,
    u32,
    *mut u32,
    u32,
) -> i32;
type Destroy = unsafe extern "system" fn(DeviceHandle) -> i32;
struct DeviceApi {
    open: GetClass,
    next: Enumerate,
    property: ReadProperty,
    destroy: Destroy,
}
#[link(name = "setupapi")]
extern "system" {
    fn SetupDiGetClassDevsW(
        class: *const Guid,
        enumerator: *const u16,
        window: DeviceHandle,
        flags: u32,
    ) -> DeviceHandle;
    fn SetupDiEnumDeviceInfo(set: DeviceHandle, index: u32, info: *mut DeviceInfo) -> i32;
    fn SetupDiGetDevicePropertyW(
        set: DeviceHandle,
        info: *mut DeviceInfo,
        key: *const PropertyKey,
        kind: *mut u32,
        buffer: *mut u8,
        size: u32,
        required: *mut u32,
        flags: u32,
    ) -> i32;
    fn SetupDiDestroyDeviceInfoList(set: DeviceHandle) -> i32;
}
static WINDOWS: DeviceApi = DeviceApi {
    open: SetupDiGetClassDevsW,
    next: SetupDiEnumDeviceInfo,
    property: SetupDiGetDevicePropertyW,
    destroy: SetupDiDestroyDeviceInfoList,
};

struct DeviceSet<'a> {
    api: &'a DeviceApi,
    handle: DeviceHandle,
}
impl Drop for DeviceSet<'_> {
    fn drop(&mut self) {
        unsafe { (self.api.destroy)(self.handle) };
    }
}
fn os_error() -> i32 {
    std::io::Error::last_os_error().raw_os_error().unwrap_or(-1)
}
impl DeviceSet<'_> {
    fn get<const N: usize>(
        &self,
        info: &mut DeviceInfo,
        key: &PropertyKey,
        buffer: &mut [u8; N],
    ) -> Result<(u32, usize), i32> {
        let mut kind = 0;
        let mut size = 0;
        // The SDK requires an initialized DeviceInfo and writes at most buffer.len() bytes.
        let ok = unsafe {
            (self.api.property)(
                self.handle,
                info,
                key,
                &mut kind,
                buffer.as_mut_ptr(),
                N as u32,
                &mut size,
                0,
            )
        };
        if ok == 0 {
            return Err(os_error());
        }
        if size as usize > N {
            return Err(-1);
        }
        Ok((kind, size as usize))
    }

    fn inf(&self, info: &mut DeviceInfo) -> Result<Option<String>, ()> {
        let mut buffer = [0; 520];
        let size = match self.get(info, &DRIVER_INF, &mut buffer) {
            Ok((DEVPROP_TYPE_STRING, size)) if size >= 4 && size % 2 == 0 => size,
            Err(ERROR_NOT_FOUND) => return Ok(None),
            _ => return Err(()),
        };
        let mut text: Vec<u16> = buffer[..size]
            .as_chunks::<2>()
            .0
            .iter()
            .copied()
            .map(u16::from_le_bytes)
            .collect();
        if text.pop() != Some(0) || text.contains(&0) {
            return Err(());
        }
        let inf = String::from_utf16(&text).map_err(|_| ())?;
        if inf.chars().any(char::is_control)
            || inf.contains(['\\', '/', ':'])
            || !inf.to_ascii_lowercase().ends_with(".inf")
        {
            return Err(());
        }
        Ok(Some(inf))
    }

    fn present(&self, info: &mut DeviceInfo) -> Option<bool> {
        let mut buffer = [0];
        match (self.get(info, &IS_PRESENT, &mut buffer), buffer[0]) {
            (Ok((DEVPROP_TYPE_BOOLEAN, 1)), 0xff) => Some(true),
            (Ok((DEVPROP_TYPE_BOOLEAN, 1)), 0) => Some(false),
            _ => None,
        }
    }
}

fn sample_devices(api: &DeviceApi, deadline: Instant, cap: u32) -> Sample {
    // DIGCF_PRESENT is intentionally absent so disconnected devices are included.
    let handle = unsafe { (api.open)(null(), null(), null_mut(), DIGCF_ALLCLASSES) };
    if handle.is_null() || handle as isize == -1 {
        return Sample {
            unavailable: true,
            ..Sample::default()
        };
    }
    let set = DeviceSet { api, handle };
    let mut sample = Sample::default();
    for index in 0..=cap {
        if Instant::now() >= deadline {
            sample.partial = true;
            break;
        }
        let mut info = DeviceInfo {
            size: std::mem::size_of::<DeviceInfo>() as u32,
            class: Guid(0, 0, 0, [0; 8]),
            instance: 0,
            reserved: 0,
        };
        if unsafe { (api.next)(set.handle, index, &mut info) } == 0 {
            sample.partial |= os_error() != ERROR_NO_MORE_ITEMS;
            break;
        }
        if index == cap {
            sample.partial = true;
            break;
        }
        match set.inf(&mut info) {
            Ok(Some(inf)) if driver_inventory::oem(&inf) => {
                let present = set.present(&mut info);
                if matches!(set.inf(&mut info), Ok(Some(rechecked)) if rechecked.eq_ignore_ascii_case(&inf))
                {
                    sample.record(inf, present);
                } else {
                    sample.partial = true;
                }
            }
            Ok(_) => {}
            Err(()) => sample.partial = true,
        }
    }
    sample
}

fn collect(
    deadline: Instant,
    mut rows: impl FnMut() -> Result<Vec<driver_inventory::Row>, String>,
    devices: impl FnOnce(Instant) -> Sample,
) -> Report {
    let Ok(first) = rows() else {
        return Report::unavailable();
    };
    if Instant::now() >= deadline {
        return Report::unavailable();
    }
    let sample = devices(deadline);
    if Instant::now() >= deadline {
        return Report::unavailable();
    }
    let Ok(second) = rows() else {
        return Report::unavailable();
    };
    advice(first, sample, second)
}

pub(crate) fn serve(pipe: broker::Handle, parent: u32) -> Result<(), String> {
    let deadline = Instant::now() + TIMEOUT;
    let request: Request = broker::receive_bounded_until(pipe, deadline, 128)?;
    broker::require_live_parent(parent)?;
    if !matches!(request, Request::Collect { version: VERSION }) {
        return Err(FAILURE.into());
    }
    let collect_live = || {
        let devices = |deadline| sample_devices(&WINDOWS, deadline, MAX_DEVICES);
        let inventory = driver_inventory::with_rows(|read| Ok(collect(deadline, read, devices)));
        inventory_or_device_only(inventory, || devices(deadline))
    };
    #[cfg(not(test))]
    let report = collect_live();
    #[cfg(test)]
    let report = if std::env::var_os("PURGEON_TEST_DRIVER_ADVISOR_WORKER").is_some() {
        tests::worker_fixture(deadline)
    } else {
        collect_live()
    };
    let reply = Reply {
        version: VERSION,
        report,
    };
    if serde_json::to_vec(&reply).map_err(|_| FAILURE)?.len() > MAX_FRAME {
        return Err(FAILURE.into());
    }
    broker::send_until(pipe, &reply, deadline)
}

struct Admission;
impl Drop for Admission {
    fn drop(&mut self) {
        BUSY.store(false, Ordering::Release);
    }
}
fn request_report(timeout: Duration) -> Result<Report, String> {
    let deadline = Instant::now() + timeout;
    let (name, pipe) = recovery_worker::new_worker_pipe()?;
    let mut worker = recovery_worker::driver_advisor_command(&name)?;
    let mut reply: Option<Reply> = None;
    let outcome = process_io::execute_in_job_cancellable(
        &mut worker,
        None,
        deadline.saturating_duration_since(Instant::now()),
        1024,
        None,
        |child| {
            broker::accept_pipe_until(pipe.0, deadline)?;
            recovery_worker::authenticate_worker(pipe.0, child)?;
            broker::send_until(pipe.0, &Request::Collect { version: VERSION }, deadline)?;
            reply = Some(broker::receive_bounded_until(pipe.0, deadline, MAX_FRAME)?);
            Ok(())
        },
        || Instant::now() >= deadline,
    )?;
    match reply {
        Some(Reply {
            version: VERSION,
            report,
        }) if outcome.status.success()
            && Instant::now() < deadline
            && report.packages.len() <= MAX_PACKAGES
            && report.device_bindings.len() <= MAX_PACKAGES =>
        {
            Ok(report)
        }
        _ => Err(FAILURE.into()),
    }
}
pub(crate) fn read() -> Result<Report, String> {
    if BUSY
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Err(FAILURE.into());
    }
    let _admission = Admission;
    request_report(TIMEOUT).map_err(|_| FAILURE.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        cell::RefCell,
        os::windows::io::{AsHandle, AsRawHandle},
        rc::Rc,
    };

    fn row(n: u32) -> driver_inventory::Row {
        driver_inventory::Row {
            published: format!("oem{n}.inf"),
            original: r"C:\Private\original.inf".into(),
            catalog: r"C:\Private\catalog.cat".into(),
            provider: "Test Provider".into(),
            class_name: "Net".into(),
            class_guid: "{00000000-0000-0000-0000-000000000000}".into(),
            date: "2024-01-02".into(),
            version: "1.2.3.4".into(),
            signature: 2,
            inbox: false,
            boot_critical: false,
        }
    }

    fn counts(present: u32, non_present: u32, unknown: u32) -> Counts {
        Counts {
            present,
            non_present,
            unknown,
        }
    }

    #[test]
    fn changed_duplicate_removed_and_added_rows_never_inherit_counts() {
        let mut sample = Sample::default();
        for i in 1..=5 {
            sample.record(format!("OEM{i}.INF"), Some(true));
        }
        let mut reused = row(2);
        reused.catalog.push('2'); // Hidden identity still matters.
        let mut duplicate = row(3);
        duplicate.published.make_ascii_uppercase();
        let result = advice(
            vec![row(1), row(2), row(3), duplicate, row(4)],
            sample,
            vec![row(1), reused, row(3), row(5), row(6)],
        );
        assert_eq!(result.status, Status::Partial);
        assert_eq!(
            result
                .packages
                .iter()
                .map(|r| (r.published.as_str(), r.bindings))
                .collect::<Vec<_>>(),
            [
                ("oem1.inf", Some(counts(1, 0, 0))),
                ("oem2.inf", None),
                ("oem3.inf", None),
                ("oem4.inf", None),
                ("oem5.inf", None),
                ("oem6.inf", None)
            ]
        );
        assert!(!serde_json::to_string(&result).unwrap().contains("Private"));
    }

    #[test]
    fn orphaned_sampled_oem_inf_is_partial_and_never_transferred() {
        let mut sample = Sample::default();
        sample.record("oem99.inf".into(), Some(true));
        let result = advice(vec![row(1)], sample, vec![row(1)]);
        assert_eq!(result.status, Status::Partial);
        assert_eq!(result.packages.len(), 1);
        assert_eq!(result.packages[0].bindings, Some(Counts::default()));
    }

    #[test]
    fn reply_limits_preserve_partial_and_no_observation_is_distinct() {
        let all: Vec<_> = (0..=MAX_PACKAGES as u32).map(row).collect();
        let result = advice(all.clone(), Sample::default(), all);
        assert_eq!(result.status, Status::Partial);
        assert_eq!(result.packages.len(), MAX_PACKAGES);
        assert_eq!(result.packages[0].bindings, Some(Counts::default()));
        let mut large: Vec<_> = (0..MAX_PACKAGES as u32).map(row).collect();
        for row in &mut large {
            row.provider = format!("{}\t", "漢".repeat(240));
            row.class_name = "字".repeat(100);
        }
        let result = advice(large.clone(), Sample::default(), large);
        assert_eq!(result.status, Status::Partial);
        assert!(result.packages.len() < MAX_PACKAGES);
        assert_eq!(result.packages[0].provider.encode_utf16().count(), 120);
        assert_eq!(display_field("\t", 120), "Unknown");
        assert!(
            serde_json::to_vec(&Reply {
                version: VERSION,
                report: result
            })
            .unwrap()
            .len()
                <= MAX_FRAME
        );
    }

    #[test]
    fn elevation_refusal_shows_only_device_inf_counts_without_package_claims() {
        use driver_inventory::DismError;
        let result = inventory_or_device_only(Err(DismError::ElevationRequired), || {
            let mut sample = Sample::default();
            for i in 0..=MAX_PACKAGES {
                sample.record(format!("OEM{i}.INF"), Some(false));
            }
            sample
        });
        assert_eq!(result.status, Status::DeviceOnly);
        assert!(result.packages.is_empty());
        assert_eq!(result.device_bindings.len(), MAX_PACKAGES);
        assert_eq!(result.device_bindings[0].inf, "oem0.inf");
        assert_eq!(result.device_bindings[0].counts, counts(0, 1, 0));
        assert_eq!(
            inventory_or_device_only(Err(DismError::Other("private".into())), || panic!(
                "unexpected fallback"
            ))
            .status,
            Status::Unavailable
        );
        assert_eq!(
            inventory_or_device_only(Err(DismError::ElevationRequired), || Sample {
                unavailable: true,
                ..Sample::default()
            })
            .status,
            Status::Unavailable
        );
        let unavailable = Report::unavailable();
        assert_eq!(
            inventory_or_device_only(Ok(unavailable), || panic!("replaced checked inventory"))
                .status,
            Status::Unavailable
        );
    }

    #[test]
    fn snapshot_failure_and_deadline_discard_observations() {
        let deadline = Instant::now() + TIMEOUT;
        let result = collect(
            deadline,
            || Err("private provider failure".into()),
            |_| panic!("ran after failed inventory"),
        );
        assert_eq!(result.status, Status::Unavailable);
        let result = collect(
            Instant::now(),
            || Ok(vec![row(1)]),
            |_| panic!("ran after deadline"),
        );
        assert_eq!(result.status, Status::Unavailable);
        let mut steps = [Ok(vec![row(1)]), Err("private provider failure".into())].into_iter();
        let result = collect(deadline, || steps.next().unwrap(), |_| Sample::default());
        assert_eq!(result.status, Status::Unavailable);
        assert!(result.packages.is_empty());
    }

    #[derive(Default)]
    struct Fixture {
        rows: Vec<(Inf, Presence)>,
        flags: u32,
        calls: Vec<(u32, bool)>,
        closes: u32,
        denied: bool,
        enumeration_failure: bool,
    }
    enum Inf {
        Value(&'static str),
        Missing,
        Denied,
        WrongType,
        InvalidUtf16,
        Changed,
    }
    enum Presence {
        Present,
        Absent,
        Invalid,
    }
    thread_local! {
        static FIXTURE: RefCell<Fixture> = RefCell::new(Fixture::default());
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn SetLastError(code: u32);
        fn WaitForSingleObject(handle: broker::Handle, millis: u32) -> u32;
    }
    fn fail(code: u32) -> i32 {
        unsafe { SetLastError(code) };
        0
    }
    unsafe extern "system" fn open(
        _: *const Guid,
        _: *const u16,
        _: DeviceHandle,
        flags: u32,
    ) -> DeviceHandle {
        FIXTURE.with_borrow_mut(|fixture| {
            fixture.flags = flags;
            if fixture.denied {
                (-1_isize) as DeviceHandle
            } else {
                std::ptr::dangling_mut::<u8>().cast()
            }
        })
    }
    unsafe extern "system" fn next(_: DeviceHandle, index: u32, info: *mut DeviceInfo) -> i32 {
        FIXTURE.with_borrow(|fixture| {
            if index as usize >= fixture.rows.len() {
                return fail(if fixture.enumeration_failure { 5 } else { 259 });
            }
            unsafe {
                (*info).instance = index;
            }
            1
        })
    }
    unsafe extern "system" fn property(
        _: DeviceHandle,
        info: *mut DeviceInfo,
        key: *const PropertyKey,
        kind: *mut u32,
        buffer: *mut u8,
        size: u32,
        required: *mut u32,
        _: u32,
    ) -> i32 {
        FIXTURE.with_borrow_mut(|fixture| {
            let index = unsafe { (*info).instance };
            let present = unsafe { (*key).id.0 == IS_PRESENT.id.0 };
            let reread = fixture.calls.iter().any(|&(i, p)| i == index && !p);
            fixture.calls.push((index, present));
            let Some((inf, presence)) = fixture.rows.get(index as usize) else {
                return fail(1168);
            };
            let (ty, bytes) = if present {
                (
                    DEVPROP_TYPE_BOOLEAN,
                    vec![match presence {
                        Presence::Present => 0xff,
                        Presence::Absent => 0,
                        Presence::Invalid => 1,
                    }],
                )
            } else {
                match inf {
                    Inf::Missing => return fail(1168),
                    Inf::Denied => return fail(5),
                    Inf::WrongType => (DEVPROP_TYPE_BOOLEAN, vec![0xff]),
                    Inf::InvalidUtf16 => (DEVPROP_TYPE_STRING, vec![0, 0xd8, 0, 0]),
                    Inf::Value(value) => (
                        DEVPROP_TYPE_STRING,
                        value
                            .encode_utf16()
                            .chain(Some(0))
                            .flat_map(u16::to_le_bytes)
                            .collect(),
                    ),
                    Inf::Changed => (
                        DEVPROP_TYPE_STRING,
                        (if reread { "oem99.inf" } else { "oem1.inf" })
                            .encode_utf16()
                            .chain(Some(0))
                            .flat_map(u16::to_le_bytes)
                            .collect(),
                    ),
                }
            };
            if bytes.len() > size as usize {
                return fail(122);
            }
            unsafe {
                *kind = ty;
                *required = bytes.len() as u32;
                std::ptr::copy_nonoverlapping(bytes.as_ptr(), buffer, bytes.len());
            }
            1
        })
    }
    unsafe extern "system" fn destroy(_: DeviceHandle) -> i32 {
        FIXTURE.with_borrow_mut(|fixture| fixture.closes += 1);
        1
    }
    const FAKE: DeviceApi = DeviceApi {
        open,
        next,
        property,
        destroy,
    };
    fn fixture(input: Fixture, cap: u32, deadline: Instant) -> (Sample, Fixture) {
        FIXTURE.with(|slot| slot.replace(input));
        let sample = sample_devices(&FAKE, deadline, cap);
        (sample, FIXTURE.with(|slot| slot.take()))
    }

    #[test]
    fn setupapi_reads_exact_typed_properties_on_the_same_all_class_devnode() {
        let input = Fixture {
            rows: vec![
                (Inf::Value("OEM1.INF"), Presence::Present),
                (Inf::Value("oem1.inf"), Presence::Absent),
                (Inf::Value("oem1.inf"), Presence::Invalid),
                (Inf::Value("inbox.inf"), Presence::Present),
                (Inf::Missing, Presence::Present),
                (Inf::Denied, Presence::Present),
                (Inf::WrongType, Presence::Present),
                (Inf::InvalidUtf16, Presence::Present),
                (Inf::Value(r"C:\Windows\inf\oem1.inf"), Presence::Present),
                (Inf::Changed, Presence::Present),
            ],
            ..Fixture::default()
        };
        let (result, fixture) = fixture(input, 10, Instant::now() + TIMEOUT);
        assert!(result.partial);
        assert_eq!(result.counts.len(), 1);
        assert_eq!(result.counts["oem1.inf"], counts(1, 1, 1));
        assert_eq!(fixture.flags, DIGCF_ALLCLASSES);
        assert_eq!(fixture.closes, 1);
        assert_eq!(&fixture.calls[..3], &[(0, false), (0, true), (0, false)]);
        assert!(fixture
            .calls
            .iter()
            .filter(|(_, present)| *present)
            .all(|(idx, _)| [0, 1, 2, 9].contains(idx)));
    }

    #[test]
    fn setupapi_distinguishes_absent_property_and_partial_admission() {
        let deadline = Instant::now() + TIMEOUT;
        let (result, seen) = fixture(
            Fixture {
                rows: vec![(Inf::Missing, Presence::Absent)],
                ..Fixture::default()
            },
            1,
            deadline,
        );
        assert!(!result.partial);
        assert_eq!(seen.closes, 1);
        let (result, seen) = fixture(
            Fixture {
                rows: vec![(Inf::Missing, Presence::Absent)],
                ..Fixture::default()
            },
            0,
            deadline,
        );
        assert!(result.partial && seen.calls.is_empty() && seen.closes == 1);
        let (result, seen) = fixture(Fixture::default(), 2, Instant::now());
        assert!(result.partial && seen.calls.is_empty() && seen.closes == 1);
        let (result, seen) = fixture(
            Fixture {
                enumeration_failure: true,
                ..Fixture::default()
            },
            1,
            deadline,
        );
        assert!(result.partial && seen.closes == 1);
        let (result, seen) = fixture(
            Fixture {
                denied: true,
                ..Fixture::default()
            },
            1,
            deadline,
        );
        assert!(result.unavailable && seen.closes == 0);
        let result = advice(vec![row(1)], result, vec![row(1)]);
        assert_eq!(result.status, Status::Partial);
        assert_eq!(result.packages[0].bindings, None);
    }

    pub(super) fn worker_fixture(deadline: Instant) -> Report {
        collect(
            deadline,
            || Ok(vec![row(7)]),
            |deadline| {
                fixture(
                    Fixture {
                        rows: vec![(Inf::Value("OEM7.INF"), Presence::Absent)],
                        ..Fixture::default()
                    },
                    MAX_DEVICES,
                    deadline,
                )
                .0
            },
        )
    }

    #[test]
    fn authenticated_worker_requires_closed_versioned_request() {
        assert!(serde_json::from_str::<Request>(
            r#"{"operation":"collect","version":1,"path":"C:/private"}"#
        )
        .is_err());
        assert!(serde_json::from_str::<Request>(r#"{"operation":"remove","version":1}"#).is_err());
        for request in [
            serde_json::json!({"operation":"collect","version":2}),
            serde_json::json!({"operation":"collect","version":1,"unknown":"x".repeat(200)}),
        ] {
            let deadline = Instant::now() + TIMEOUT;
            let (name, pipe) = recovery_worker::new_worker_pipe().unwrap();
            let mut worker = recovery_worker::driver_advisor_command(&name).unwrap();
            let output =
                process_io::execute_in_job(&mut worker, None, TIMEOUT, 1024, None, |child| {
                    broker::accept_pipe_until(pipe.0, deadline)?;
                    recovery_worker::authenticate_worker(pipe.0, child)?;
                    broker::send_until(pipe.0, &request, deadline)
                })
                .unwrap();
            assert!(!output.status.success());
        }
    }

    #[test]
    fn denial_and_expired_request_leave_no_worker_and_no_stale_reply() {
        let fixture = request_report(TIMEOUT).unwrap();
        assert_eq!(fixture.status, Status::Complete);
        assert_eq!(fixture.packages[0].bindings, Some(counts(0, 1, 0)));
        for deny in [true, false] {
            let handle = Rc::new(RefCell::new(None));
            let target = handle.clone();
            process_io::AFTER_SPAWN.with(|slot| {
                slot.replace(Some(Box::new(move |child| {
                    target.replace(Some(child.as_handle().try_clone_to_owned().unwrap()));
                    if !deny {
                        std::thread::sleep(Duration::from_millis(80));
                    }
                })))
            });
            recovery_worker::REJECT_NEXT_PEER.with(|flag| flag.set(deny));
            let result = request_report(if deny {
                TIMEOUT
            } else {
                Duration::from_millis(40)
            });
            assert!(result.is_err());
            assert!(!recovery_worker::REJECT_NEXT_PEER.with(|flag| flag.replace(false)));
            let handle = handle.take().unwrap();
            assert_eq!(
                unsafe { WaitForSingleObject(handle.as_raw_handle(), 1_000) },
                0
            );
        }
        assert_eq!(request_report(TIMEOUT).unwrap().status, Status::Complete);
    }

    #[test]
    fn command_boundary_uses_worker_and_serializes_advisory_fields_only() {
        let output = tauri::async_runtime::block_on(crate::driver_retirement_advisor()).unwrap();
        let json = serde_json::to_value(output).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "status":"complete","packages":[{"published":"oem7.inf","provider":"Test Provider",
                  "className":"Net","version":"1.2.3.4","signature":2,"bootCritical":false,
                  "bindings":{"present":0,"nonPresent":1,"unknown":0}}]
            })
        );
    }
}
