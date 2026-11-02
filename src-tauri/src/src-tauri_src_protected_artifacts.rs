//! Retained EVTX capture storage. Only native-generated IDs and authenticated
//! SIDs enter the protected store; user export destinations remain native grants.
use crate::state_store::ArtifactSlot;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::ffi::c_void;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use std::time::Instant;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArtifactInfo {
    pub id: String,
    pub path: String,
    pub bytes: u64,
    pub digest: String,
}
pub struct Capture {
    slot: ArtifactSlot,
    id: String,
}
impl Capture {
    pub fn reserve(sid: &str, id: &str) -> Result<Self, String> {
        let slot = ArtifactSlot::open(sid, id, true)?;
        slot.require_absent()?;
        Ok(Self {
            slot,
            id: id.into(),
        })
    }
    pub fn path(&self) -> &Path {
        self.slot.path()
    }
    pub fn verify(
        &self,
        deadline: Instant,
        mut progress: impl FnMut(u64) -> Result<(), String>,
    ) -> Result<ArtifactInfo, String> {
        let mut file = self.slot.seal()?;
        let bytes = file.metadata().map_err(|e| e.to_string())?.len();
        let mut signature = [0u8; 8];
        file.read_exact(&mut signature)
            .map_err(|e| format!("EVTX capture is incomplete: {e}"))?;
        if &signature != b"ElfFile\0" {
            return Err("Retained event capture is not an EVTX file".into());
        }
        verify_evtx(self.path())?;
        file.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
        let mut buffer = vec![0u8; 1024 * 1024];
        let mut read = 0u64;
        let mut digest = Sha256::new();
        loop {
            if Instant::now() >= deadline {
                return Err(
                    "Event capture verification deadline exceeded; artifact retained".into(),
                );
            }
            let length = file.read(&mut buffer).map_err(|e| e.to_string())?;
            if length == 0 {
                break;
            }
            digest.update(&buffer[..length]);
            read = read
                .checked_add(length as u64)
                .ok_or("EVTX size overflow")?;
            if read > bytes {
                return Err("Event capture changed while verifying".into());
            }
            progress(read)?;
        }
        if read != bytes || bytes < 4096 {
            return Err("Event capture is truncated".into());
        }
        self.slot.recheck()?;
        let digest = digest
            .finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        Ok(ArtifactInfo {
            id: self.id.clone(),
            path: self.path().to_string_lossy().into_owned(),
            bytes,
            digest,
        })
    }
}
pub fn read(sid: &str, info: &ArtifactInfo) -> Result<File, String> {
    if info.digest.len() != 64
        || !info.digest.bytes().all(|b| b.is_ascii_hexdigit())
        || info.bytes < 4096
    {
        return Err("Invalid native event capture integrity record".into());
    }
    let slot = ArtifactSlot::open(sid, &info.id, false)?;
    if slot.path().to_string_lossy() != info.path {
        return Err("Event artifact path is not native-derived".into());
    }
    let file = slot.read()?;
    if file.metadata().map_err(|e| e.to_string())?.len() != info.bytes {
        return Err("Retained event artifact size changed".into());
    }
    // The caller retains the verified source file with write/delete sharing
    // denied; every delivery hashes its bytes against the protected journal.
    Ok(file)
}
fn verify_evtx(path: &Path) -> Result<(), String> {
    #[link(name = "wevtapi")]
    extern "system" {
        fn EvtOpenLog(session: *mut c_void, path: *const u16, flags: u32) -> *mut c_void;
        fn EvtClose(handle: *mut c_void) -> i32;
    }
    let path: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let log = unsafe { EvtOpenLog(std::ptr::null_mut(), path.as_ptr(), 2) };
    if log.is_null() {
        return Err(format!(
            "Windows could not validate the retained EVTX: {}",
            std::io::Error::last_os_error()
        ));
    }
    unsafe {
        EvtClose(log);
    }
    Ok(())
}
