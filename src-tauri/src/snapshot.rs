// System snapshots: folders and files (size, modified time) under chosen roots, and registry
// keys and values (with their data) under chosen keys. Snapshots are gzip-compressed text, one
// entry per line, tab-separated:
//   D <path>
//   F <path> <size> <modified-ms>
//   K <key>
//   V <key> <value name> <type> <data>
// Text fields escape \ as \\, tab as \t, newline as \n and NUL as \0. Binary data is hex; data
// over 4 KB is stored as "#<hash>" (comparable, but not restorable).
use flate2::{read::GzDecoder, write::GzEncoder, Compression};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Instant, UNIX_EPOCH};
use winreg::enums::*;
use winreg::RegKey;

const MAX_DATA: usize = 4096;

// Cancellation for the long walks below: the frontend sets this through the
// cancel_snapshot command, and take/compare poll it as they go. A cancelled
// operation reports Err("cancelled") — the backend maps that exact word to a
// calm "cancelled" result instead of an error.
static CANCELLED: AtomicBool = AtomicBool::new(false);

pub fn request_cancel() {
    CANCELLED.store(true, Ordering::SeqCst);
}

fn cancel_requested() -> bool {
    CANCELLED.load(Ordering::SeqCst)
}

const CANCELLED_MSG: &str = "cancelled";

#[derive(Deserialize)]
pub struct RegRoot {
    pub hive: String, // "HKLM" or "HKCU"
    pub path: String,
    pub depth: u32,
}

#[derive(Serialize, Default)]
pub struct SnapshotStats {
    pub dirs: u64,
    pub files: u64,
    pub keys: u64,
    pub values: u64,
    pub ms: u64,
    pub bytes: u64,
}

fn esc(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '\\' => o.push_str("\\\\"),
            '\t' => o.push_str("\\t"),
            '\n' => o.push_str("\\n"),
            '\r' => o.push_str("\\r"),
            '\0' => o.push_str("\\0"),
            _ => o.push(c),
        }
    }
    o
}

pub fn unesc(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    let mut it = s.chars();
    while let Some(c) = it.next() {
        if c == '\\' {
            match it.next() {
                Some('t') => o.push('\t'),
                Some('n') => o.push('\n'),
                Some('r') => o.push('\r'),
                Some('0') => o.push('\0'),
                Some(x) => o.push(x),
                None => o.push('\\'),
            }
        } else {
            o.push(c);
        }
    }
    o
}

fn excluded(lower: &str, excludes: &[String]) -> bool {
    excludes.iter().any(|e| lower.contains(e.as_str()))
}

fn fnv(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in bytes {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

// Registry UTF-16LE decoding keeps the existing behavior for malformed data:
// discard a trailing byte, replace unpaired surrogates, and trim terminal NULs.
pub(crate) fn utf16(bytes: &[u8]) -> String {
    let words: Vec<u16> = bytes
        .as_chunks::<2>()
        .0
        .iter()
        .map(|c| u16::from_le_bytes(*c))
        .collect();
    String::from_utf16_lossy(&words)
        .trim_end_matches('\0')
        .to_string()
}

// Value data as text: strings as-is, numbers in decimal, everything else hex.
fn value_text(vtype: u32, bytes: &[u8]) -> String {
    match vtype {
        1 | 2 | 7 => {
            if bytes.len() > MAX_DATA * 2 {
                format!("#{:016x}", fnv(bytes))
            } else {
                esc(&utf16(bytes))
            }
        }
        4 if bytes.len() >= 4 => {
            u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]).to_string()
        }
        11 if bytes.len() >= 8 => u64::from_le_bytes(bytes[..8].try_into().unwrap()).to_string(),
        _ => {
            if bytes.len() > MAX_DATA {
                format!("#{:016x}", fnv(bytes))
            } else {
                bytes.iter().map(|b| format!("{b:02x}")).collect()
            }
        }
    }
}

pub fn take(
    out: &str,
    name: &str,
    file_roots: &[String],
    file_depth: u32,
    reg_roots: &[RegRoot],
    excludes: &[String],
) -> Result<SnapshotStats, String> {
    CANCELLED.store(false, Ordering::SeqCst);
    let start = Instant::now();
    let excludes: Vec<String> = excludes.iter().map(|e| e.to_lowercase()).collect();
    let mut st = crate::atomic_file::write_stream(out, |file| {
        let mut w = BufWriter::new(GzEncoder::new(file, Compression::fast()));
        let mut st = SnapshotStats::default();
        let created = std::time::SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        writeln!(w, "#SWEEPSNAP\t1\t{}\t{created}", esc(name)).map_err(|e| e.to_string())?;

        // Files and folders.
        for root in file_roots {
            let mut stack = vec![(root.clone(), 1u32)];
            while let Some((dir, depth)) = stack.pop() {
                if cancel_requested() {
                    return Err(CANCELLED_MSG.to_string());
                }
                let Ok(rd) = fs::read_dir(&dir) else { continue };
                for e in rd.flatten() {
                    let Ok(t) = e.file_type() else { continue };
                    if t.is_symlink() {
                        continue;
                    }
                    let p = e.path().display().to_string();
                    if excluded(&p.to_lowercase(), &excludes) {
                        continue;
                    }
                    if t.is_dir() {
                        st.dirs += 1;
                        writeln!(w, "D\t{}", esc(&p)).map_err(|e| e.to_string())?;
                        if depth < file_depth {
                            stack.push((p, depth + 1));
                        }
                    } else if t.is_file() {
                        let (size, modified) = e
                            .metadata()
                            .map(|m| {
                                (
                                    m.len(),
                                    m.modified()
                                        .ok()
                                        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                                        .map(|d| d.as_millis())
                                        .unwrap_or(0),
                                )
                            })
                            .unwrap_or((0, 0));
                        st.files += 1;
                        writeln!(w, "F\t{}\t{size}\t{modified}", esc(&p))
                            .map_err(|e| e.to_string())?;
                    }
                }
            }
        }

        // Registry keys and values (64-bit view).
        for root in reg_roots {
            let (hkey, hive_name) = match root.hive.as_str() {
                "HKLM" => (HKEY_LOCAL_MACHINE, "HKEY_LOCAL_MACHINE"),
                "HKCU" => (HKEY_CURRENT_USER, "HKEY_CURRENT_USER"),
                _ => continue,
            };
            let base = RegKey::predef(hkey);
            let mut stack = vec![(root.path.clone(), 1u32)];
            while let Some((path, depth)) = stack.pop() {
                if cancel_requested() {
                    return Err(CANCELLED_MSG.to_string());
                }
                let Ok(key) = base.open_subkey_with_flags(&path, KEY_READ | KEY_WOW64_64KEY) else {
                    continue;
                };
                let full = format!("{hive_name}\\{path}");
                if excluded(&full.to_lowercase(), &excludes) {
                    continue;
                }
                st.keys += 1;
                writeln!(w, "K\t{}", esc(&full)).map_err(|e| e.to_string())?;
                for (vname, value) in key.enum_values().flatten() {
                    st.values += 1;
                    let vtype = value.vtype as u32;
                    writeln!(
                        w,
                        "V\t{}\t{}\t{vtype}\t{}",
                        esc(&full),
                        esc(&vname),
                        value_text(vtype, &value.bytes)
                    )
                    .map_err(|e| e.to_string())?;
                }
                if depth < root.depth {
                    for sub in key.enum_keys().flatten() {
                        stack.push((format!("{path}\\{sub}"), depth + 1));
                    }
                }
            }
        }

        w.flush().map_err(|e| e.to_string())?;
        w.into_inner()
            .map_err(|e| e.to_string())?
            .finish()
            .map_err(|e| e.to_string())?;
        Ok(st)
    })?;
    st.bytes = fs::metadata(out).map(|m| m.len()).unwrap_or(0);
    st.ms = start.elapsed().as_millis() as u64;
    Ok(st)
}

type FileEntry = (String, u64, u64); // Original path, size, modified time.
type ValueEntry = (String, String, u32, String); // Key, name, registry type, data.

#[derive(Default)]
struct Snap {
    name: String,
    created: u64,
    dirs: HashMap<String, String>,
    files: HashMap<String, FileEntry>,
    keys: HashMap<String, String>,
    values: HashMap<String, ValueEntry>,
}

fn load(path: &str) -> Result<Snap, String> {
    let f = File::open(path).map_err(|e| format!("{path}: {e}"))?;
    let mut s = Snap::default();
    let mut lines = 0u64;
    for line in BufReader::new(GzDecoder::new(f)).lines() {
        lines += 1;
        if lines.is_multiple_of(8192) && cancel_requested() {
            return Err(CANCELLED_MSG.to_string());
        }
        let line = line.map_err(|e| e.to_string())?;
        let mut p = line.split('\t');
        match p.next() {
            Some("#SWEEPSNAP") => {
                let _ = p.next();
                s.name = unesc(p.next().unwrap_or(""));
                s.created = p.next().and_then(|x| x.parse().ok()).unwrap_or(0);
            }
            Some("D") => {
                let path = unesc(p.next().unwrap_or(""));
                s.dirs.insert(path.to_lowercase(), path);
            }
            Some("F") => {
                let path = unesc(p.next().unwrap_or(""));
                let size = p.next().and_then(|x| x.parse().ok()).unwrap_or(0);
                let modified = p.next().and_then(|x| x.parse().ok()).unwrap_or(0);
                s.files.insert(path.to_lowercase(), (path, size, modified));
            }
            Some("K") => {
                let key = unesc(p.next().unwrap_or(""));
                s.keys.insert(key.to_lowercase(), key);
            }
            Some("V") => {
                let key = unesc(p.next().unwrap_or(""));
                let name = unesc(p.next().unwrap_or(""));
                let vtype = p.next().and_then(|x| x.parse().ok()).unwrap_or(0);
                let data = p.next().unwrap_or("").to_string();
                s.values.insert(
                    format!("{}|{}", key.to_lowercase(), name.to_lowercase()),
                    (key, name, vtype, data),
                );
            }
            _ => {}
        }
    }
    Ok(s)
}

#[derive(Serialize)]
pub struct Change {
    kind: &'static str, // dir | file | key | value
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "valueType")]
    value_type: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    before: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    after: Option<String>,
}

#[derive(Serialize)]
pub struct Comparison {
    before: String,
    after: String,
    before_created: u64,
    after_created: u64,
    added: Vec<Change>,
    removed: Vec<Change>,
    changed: Vec<Change>,
    truncated: bool,
    ms: u64,
}

// Keeps only top-most paths: entries inside an already-kept folder/key are implied by it.
fn topmost(mut items: Vec<(String, String)>) -> Vec<String> {
    items.sort_by_key(|(l, _)| l.len());
    let mut kept: HashSet<String> = HashSet::new();
    let mut out = vec![];
    for (lower, orig) in items {
        let mut parent = lower.as_str();
        let mut implied = false;
        while let Some(i) = parent.rfind('\\') {
            parent = &parent[..i];
            if kept.contains(parent) {
                implied = true;
                break;
            }
        }
        if !implied {
            kept.insert(lower);
            out.push(orig);
        }
    }
    out.sort_by_key(|s| s.to_lowercase());
    out
}

fn under_any(lower: &str, set: &HashSet<String>) -> bool {
    let mut parent = lower;
    while let Some(i) = parent.rfind('\\') {
        parent = &parent[..i];
        if set.contains(parent) {
            return true;
        }
    }
    false
}

// Entries present in `a` but not in `b`, collapsed to top-most folders and keys.
fn append_change(
    out: &mut Vec<Change>,
    limit: usize,
    truncated: &mut bool,
    build: impl FnOnce() -> Change,
) {
    if out.len() < limit {
        out.push(build());
    } else {
        *truncated = true;
    }
}

fn only_in(a: &Snap, b: &Snap, limit: usize, truncated: &mut bool) -> Vec<Change> {
    let dirs = topmost(
        a.dirs
            .iter()
            .filter(|(l, _)| !b.dirs.contains_key(*l))
            .map(|(l, o)| (l.clone(), o.clone()))
            .collect(),
    );
    let dir_set: HashSet<String> = dirs.iter().map(|d| d.to_lowercase()).collect();
    let keys = topmost(
        a.keys
            .iter()
            .filter(|(l, _)| !b.keys.contains_key(*l))
            .map(|(l, o)| (l.clone(), o.clone()))
            .collect(),
    );
    let key_set: HashSet<String> = keys.iter().map(|k| k.to_lowercase()).collect();
    let mut out: Vec<Change> = vec![];
    for d in dirs {
        append_change(&mut out, limit, truncated, || Change {
            kind: "dir",
            path: d,
            name: None,
            value_type: None,
            before: None,
            after: None,
        });
    }
    let mut files: Vec<&FileEntry> = a
        .files
        .iter()
        .filter(|(l, _)| !b.files.contains_key(*l) && !under_any(l, &dir_set))
        .map(|(_, v)| v)
        .collect();
    files.sort_by_key(|f| f.0.to_lowercase());
    for f in files {
        append_change(&mut out, limit, truncated, || Change {
            kind: "file",
            path: f.0.clone(),
            name: None,
            value_type: None,
            before: None,
            after: Some(f.1.to_string()),
        });
    }
    for k in keys {
        append_change(&mut out, limit, truncated, || Change {
            kind: "key",
            path: k,
            name: None,
            value_type: None,
            before: None,
            after: None,
        });
    }
    let mut values: Vec<&ValueEntry> = a
        .values
        .iter()
        .filter(|(id, v)| {
            !b.values.contains_key(*id)
                && !key_set.contains(&v.0.to_lowercase())
                && !under_any(&v.0.to_lowercase(), &key_set)
        })
        .map(|(_, v)| v)
        .collect();
    values.sort_by_key(|v| (v.0.to_lowercase(), v.1.to_lowercase()));
    for v in values {
        append_change(&mut out, limit, truncated, || Change {
            kind: "value",
            path: v.0.clone(),
            name: Some(v.1.clone()),
            value_type: Some(v.2),
            before: None,
            after: Some(v.3.clone()),
        });
    }
    out
}

#[derive(Serialize)]
pub struct Subtree {
    keys: Vec<String>,
    values: Vec<Change>,
}

// Every key and value at or under `key` in a snapshot, for recreating a deleted key.
pub fn subtree(path: &str, key: &str) -> Result<Subtree, String> {
    let s = load(path)?;
    let k = key.to_lowercase();
    let inside = |p: &str| p == k || p.starts_with(&format!("{k}\\"));
    let mut keys: Vec<String> = s
        .keys
        .iter()
        .filter(|(l, _)| inside(l))
        .map(|(_, o)| o.clone())
        .collect();
    keys.sort_by_key(|x| x.len());
    let mut values: Vec<Change> = s
        .values
        .values()
        .filter(|v| inside(&v.0.to_lowercase()))
        .map(|v| Change {
            kind: "value",
            path: v.0.clone(),
            name: Some(v.1.clone()),
            value_type: Some(v.2),
            before: Some(v.3.clone()),
            after: None,
        })
        .collect();
    values.sort_by_key(|v| {
        (
            v.path.to_lowercase(),
            v.name.clone().unwrap_or_default().to_lowercase(),
        )
    });
    Ok(Subtree { keys, values })
}

pub fn compare(before_path: &str, after_path: &str, limit: usize) -> Result<Comparison, String> {
    CANCELLED.store(false, Ordering::SeqCst);
    let start = Instant::now();
    let a = load(before_path)?;
    let b = load(after_path)?;
    let mut truncated = false;
    let added = only_in(&b, &a, limit, &mut truncated);
    let mut removed = only_in(&a, &b, limit, &mut truncated);
    // A removed value's old data is what a revert writes back.
    for r in removed.iter_mut() {
        if r.kind == "value" {
            r.before = r.after.take();
        }
    }
    let mut changed: Vec<Change> = vec![];
    let mut file_changes: Vec<(&FileEntry, &FileEntry)> = a
        .files
        .iter()
        .filter_map(|(l, f)| {
            b.files
                .get(l)
                .filter(|g| g.1 != f.1 || g.2 != f.2)
                .map(|g| (f, g))
        })
        .collect();
    file_changes.sort_by_key(|(f, _)| f.0.to_lowercase());
    for (f, g) in file_changes {
        append_change(&mut changed, limit, &mut truncated, || Change {
            kind: "file",
            path: g.0.clone(),
            name: None,
            value_type: None,
            before: Some(f.1.to_string()),
            after: Some(g.1.to_string()),
        });
    }
    let mut value_changes: Vec<(&ValueEntry, &ValueEntry)> = a
        .values
        .iter()
        .filter_map(|(id, v)| {
            b.values
                .get(id)
                .filter(|w| w.2 != v.2 || w.3 != v.3)
                .map(|w| (v, w))
        })
        .collect();
    value_changes.sort_by_key(|(v, _)| (v.0.to_lowercase(), v.1.to_lowercase()));
    for (v, w) in value_changes {
        append_change(&mut changed, limit, &mut truncated, || Change {
            kind: "value",
            path: w.0.clone(),
            name: Some(w.1.clone()),
            value_type: Some(v.2),
            before: Some(v.3.clone()),
            after: Some(w.3.clone()),
        });
    }
    Ok(Comparison {
        before: a.name,
        after: b.name,
        before_created: a.created,
        after_created: b.created,
        added,
        removed,
        changed,
        truncated,
        ms: start.elapsed().as_millis() as u64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    #[test]
    fn registry_utf16_preserves_unicode_and_embedded_nuls() {
        for text in ["", "Example", "日本語 😀", "first\0second", "trailing\0\0"] {
            let bytes: Vec<u8> = text.encode_utf16().flat_map(u16::to_le_bytes).collect();
            assert_eq!(utf16(&bytes), text.trim_end_matches('\0'));
        }
        assert_eq!(value_text(7, &[65, 0, 0, 0, 66, 0, 0, 0]), "A\\0B");
    }

    #[test]
    fn registry_utf16_keeps_existing_malformed_input_behavior() {
        assert_eq!(utf16(&[65]), "");
        assert_eq!(utf16(&[65, 0, 66]), "A");
        assert_eq!(utf16(&[0, 0xd8]), "\u{fffd}");
        assert_eq!(utf16(&[0, 0xdc]), "\u{fffd}");
    }

    struct Fixture(PathBuf);

    impl Fixture {
        fn new(contents: &str) -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let id = NEXT.fetch_add(1, Ordering::Relaxed);
            let now = std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "purgeon-snapshot-test-{}-{now}-{id}.snap",
                std::process::id()
            ));
            let file = File::create_new(&path).unwrap();
            let mut writer = GzEncoder::new(file, Compression::fast());
            writer.write_all(contents.as_bytes()).unwrap();
            writer.finish().unwrap();
            Self(path)
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.0);
        }
    }

    #[test]
    fn snapshot_comparison_keeps_file_and_value_changes_sorted_and_truncated() {
        let before = Fixture::new(concat!(
            "#SWEEPSNAP\t1\tBefore\t1\n",
            "F\tC:\\\\Z.exe\t10\t1\nF\tC:\\\\a.exe\t20\t1\n",
            "V\tHKCU\\\\Software\\\\Example\tz\t1\told\n",
            "V\tHKCU\\\\Software\\\\Example\ta\t4\t1\n",
        ));
        let after = Fixture::new(concat!(
            "#SWEEPSNAP\t1\tAfter\t2\n",
            "F\tC:\\\\Z.exe\t11\t2\nF\tC:\\\\a.exe\t21\t2\n",
            "V\tHKCU\\\\Software\\\\Example\tz\t1\tnew\n",
            "V\tHKCU\\\\Software\\\\Example\ta\t4\t2\n",
        ));
        let full = compare(before.0.to_str().unwrap(), after.0.to_str().unwrap(), 10).unwrap();
        assert_eq!(full.before, "Before");
        assert_eq!(full.after, "After");
        assert!(full.added.is_empty() && full.removed.is_empty());
        assert_eq!(full.changed.len(), 4);
        assert_eq!(full.changed[0].path, r"C:\a.exe");
        assert_eq!(full.changed[1].path, r"C:\Z.exe");
        assert_eq!(full.changed[0].before.as_deref(), Some("20"));
        assert_eq!(full.changed[0].after.as_deref(), Some("21"));
        assert_eq!(full.changed[2].name.as_deref(), Some("a"));
        assert_eq!(full.changed[2].value_type, Some(4));
        assert_eq!(full.changed[2].before.as_deref(), Some("1"));
        assert_eq!(full.changed[2].after.as_deref(), Some("2"));
        assert_eq!(full.changed[3].name.as_deref(), Some("z"));
        assert!(!full.truncated);
        let limited = compare(before.0.to_str().unwrap(), after.0.to_str().unwrap(), 1).unwrap();
        assert!(limited.truncated);
        assert_eq!(limited.changed.len(), 1);
        assert_eq!(limited.changed[0].path, r"C:\a.exe");
    }

    #[test]
    fn result_caps_preserve_order_types_unicode_and_all_three_prefixes() {
        let before = Fixture::new(concat!(
            "#SWEEPSNAP\t1\tBefore\t1\n",
            "F\tC:\\\\Ä.exe\t1\t1\nF\tc:\\\\ä.exe\t2\t1\n",
            "F\tC:\\\\Removed.exe\t3\t1\n",
            "V\tHKCU\\\\Shared\tZ\t4\t1\nV\tHKCU\\\\Shared\t日本語\t1\told\n",
            "V\tHKCU\\\\Shared\tremoved\t1\tretained old data\n",
        ));
        let after = Fixture::new(concat!(
            "#SWEEPSNAP\t1\tAfter\t2\n",
            "F\tC:\\\\Ä.exe\t4\t1\nF\tC:\\\\Added.exe\t5\t1\n",
            "V\tHKCU\\\\Shared\tz\t1\t1\nV\tHKCU\\\\Shared\t日本語\t1\tnew\n",
            "V\tHKCU\\\\Shared\tadded\t1\tnew data\n",
        ));
        let full = compare(
            before.0.to_str().unwrap(),
            after.0.to_str().unwrap(),
            usize::MAX,
        )
        .unwrap();
        assert_eq!(full.changed.len(), 3);
        assert_eq!(full.changed[1].value_type, Some(4));
        assert_eq!(full.changed[1].before.as_deref(), Some("1"));
        assert_eq!(full.changed[1].after.as_deref(), Some("1"));
        for cap in [0, 1, 2, 3, 10] {
            let actual =
                compare(before.0.to_str().unwrap(), after.0.to_str().unwrap(), cap).unwrap();
            for (expected, limited) in [
                (&full.added, &actual.added),
                (&full.removed, &actual.removed),
                (&full.changed, &actual.changed),
            ] {
                assert_eq!(
                    serde_json::to_value(limited).unwrap(),
                    serde_json::to_value(&expected[..cap.min(expected.len())]).unwrap()
                );
            }
            assert_eq!(
                actual.truncated,
                [full.added.len(), full.removed.len(), full.changed.len()]
                    .iter()
                    .any(|n| *n > cap)
            );
        }
    }

    #[test]
    fn discarded_payloads_are_never_materialized() {
        let count = std::cell::Cell::new(0);
        let mut result = Vec::new();
        let mut truncated = false;
        for _ in 0..1000 {
            append_change(&mut result, 1, &mut truncated, || {
                count.set(count.get() + 1);
                Change {
                    kind: "value",
                    path: "key".into(),
                    name: Some("name".into()),
                    value_type: Some(1),
                    before: None,
                    after: Some("payload".repeat(10000)),
                }
            });
        }
        assert_eq!(count.get(), 1);
        assert_eq!(result.len(), 1);
        assert!(truncated);
    }
}
