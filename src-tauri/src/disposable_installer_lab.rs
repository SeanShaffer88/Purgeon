//! Prepare files for a manually opened Windows Sandbox. Never execute installers.
use crate::{security, transfer_recovery as files, updater_native::Pin};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    ffi::c_void,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::windows::{ffi::OsStrExt, fs::OpenOptionsExt},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri_plugin_dialog::DialogExt;

const READ: u32 = 0x8000_0000;
const DELETE: u32 = 0x0001_0000;
const ATTR: u32 = 0x80;
const OPEN_REPARSE: u32 = 0x0020_0000;
const MAX_BYTES: u64 = 1024 * 1024 * 1024;
const LIMIT: Duration = Duration::from_secs(120);
const CONFIG_PENDING: &str = "Lab.wsb.pending";
const START: &str = include_str!("disposable_installer_lab/Start.ps1");
const FINISH: &str = include_str!("disposable_installer_lab/Finish.ps1");
const INVENTORY: &str = include_str!("disposable_installer_lab/Inventory.ps1");
static GENERATING: Mutex<()> = Mutex::new(());
static LAST: Mutex<Option<Published>> = Mutex::new(None);

#[link(name = "kernel32")]
extern "system" {
    fn GetDriveTypeW(root: *const u16) -> u32;
}
#[link(name = "shell32")]
extern "system" {
    fn ShellExecuteW(
        hwnd: *mut c_void,
        operation: *const u16,
        file: *const u16,
        parameters: *const u16,
        directory: *const u16,
        show: i32,
    ) -> isize;
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct View {
    id: String,
    folder: String,
    installer_name: String,
    sha256: String,
}

struct Published {
    id: String,
    path: PathBuf,
    identity: files::Identity,
}

fn wide(path: &Path) -> Vec<u16> {
    path.as_os_str().encode_wide().chain(Some(0)).collect()
}

fn text(path: &Path) -> Result<&str, String> {
    path.to_str().ok_or("Lab path must be Unicode".into())
}

fn valid_id(id: &str) -> bool {
    id.len() == 12
        && id
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

fn local_path(path: &Path, cap: usize) -> Result<(), String> {
    let value = text(path)?;
    let bytes = value.as_bytes();
    if bytes.len() <= 3
        || !bytes[0].is_ascii_alphabetic()
        || bytes.get(1..3) != Some(b":\\")
        || value.encode_utf16().count() > cap
        || value.chars().any(char::is_control)
        || value[3..].contains(['%', ':', '/', '*', '?', '"', '<', '>', '|'])
    {
        return Err("Choose a local Windows path without aliases or percent expansion.".into());
    }
    for segment in value[3..].split('\\') {
        let stem = segment
            .split('.')
            .next()
            .unwrap_or("")
            .trim_end()
            .to_ascii_uppercase();
        let reserved = matches!(
            stem.as_str(),
            "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
        ) || matches!(
            stem.strip_prefix("COM")
                .or_else(|| stem.strip_prefix("LPT")),
            Some("0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³")
        );
        if segment.is_empty() || segment.ends_with(['.', ' ']) || reserved {
            return Err("Lab paths cannot use Windows device or traversal aliases.".into());
        }
    }
    if unsafe { GetDriveTypeW(wide(Path::new(&value[..3])).as_ptr()) } != 3 {
        return Err("Choose a folder or installer on a fixed local drive.".into());
    }
    Ok(())
}

fn pin_dirs(path: &Path) -> Result<Vec<Pin>, String> {
    let parents: Vec<_> = path.ancestors().collect();
    parents
        .into_iter()
        .rev()
        .map(|p| Pin::open(p, true, READ, 3))
        .collect()
}

fn xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn config(input: &Path) -> Result<String, String> {
    let folder = xml(text(input)?);
    Ok(format!(concat!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<Configuration>\n",
        "  <vGPU>Disable</vGPU>\n  <Networking>Disable</Networking>\n",
        "  <AudioInput>Disable</AudioInput>\n  <VideoInput>Disable</VideoInput>\n",
        "  <ProtectedClient>Enable</ProtectedClient>\n  <PrinterRedirection>Disable</PrinterRedirection>\n",
        "  <ClipboardRedirection>Disable</ClipboardRedirection>\n  <MappedFolders>\n    <MappedFolder>\n",
        "      <HostFolder>{}</HostFolder>\n      <SandboxFolder>C:\\PurgeonLab</SandboxFolder>\n",
        "      <ReadOnly>true</ReadOnly>\n    </MappedFolder>\n  </MappedFolders>\n</Configuration>\n"
    ), folder))
}

struct Stage {
    path: PathBuf,
    root: File,
    entries: Vec<(PathBuf, files::Identity, bool, File)>,
    digests: Vec<(PathBuf, u64, String)>,
    published: bool,
}

impl Stage {
    fn new(path: PathBuf) -> Result<Self, String> {
        fs::create_dir(&path).map_err(|e| e.to_string())?;
        let root = files::open(&path, true, ATTR | DELETE, 3)?;
        Ok(Self {
            path,
            root,
            entries: Vec::new(),
            digests: Vec::new(),
            published: false,
        })
    }

    fn add(&mut self, name: &str, directory: bool) -> Result<&mut File, String> {
        let path = self.path.join(name);
        files::verify_path(&self.root, &self.path)?;
        let file = if directory {
            fs::create_dir(&path).map_err(|e| e.to_string())?;
            files::open(&path, true, ATTR | DELETE, 3)?
        } else {
            OpenOptions::new()
                .create_new(true)
                .write(true)
                .access_mode(READ | 0x4000_0000 | DELETE)
                .share_mode(1)
                .custom_flags(OPEN_REPARSE)
                .open(&path)
                .map_err(|e| e.to_string())?
        };
        let identity = files::identity(&file, directory)?;
        files::verify_path(&file, &path)?;
        self.entries.push((path, identity, directory, file));
        Ok(&mut self.entries.last_mut().unwrap().3)
    }

    fn write(&mut self, name: &str, bytes: &[u8]) -> Result<(), String> {
        let file = self.add(name, false)?;
        file.write_all(bytes)
            .and_then(|()| file.sync_all())
            .map_err(|e| e.to_string())?;
        self.digests.push((
            name.into(),
            bytes.len() as u64,
            hex(Sha256::digest(bytes).as_ref()),
        ));
        Ok(())
    }

    fn publish(
        &mut self,
        path: &Path,
        deadline: Instant,
        after_move: impl FnOnce(&Path),
    ) -> Result<files::Identity, String> {
        files::verify_path(&self.root, &self.path)?;
        verify_members(
            &self.path,
            &self
                .entries
                .iter()
                .map(|(path, _, _, _)| path.clone())
                .collect::<Vec<_>>(),
        )?;
        for (path, identity, directory, file) in &self.entries {
            files::verify_path(file, path)?;
            if files::identity(file, *directory)? != *identity {
                return Err("A staged lab entry changed.".into());
            }
        }
        let identity = files::identity(&self.root, true)?;
        // Windows directory rename requires closing the descendant handles first.
        let entries: Vec<_> = self
            .entries
            .drain(..)
            .map(|(p, i, d, _)| (p, i, d))
            .collect();
        if let Err(error) = files::rename_no_replace(&self.root, path) {
            for (path, identity, directory) in entries.into_iter().rev() {
                if let Ok(file) = files::open(&path, directory, ATTR | DELETE, 3) {
                    if files::identity(&file, directory).ok().as_ref() == Some(&identity) {
                        let _ = files::cleanup_held(&file);
                    }
                }
            }
            return Err(format!(
                "Lab could not be published without replacing an existing item: {error}"
            ));
        }
        self.published = true;
        after_move(path);
        self.complete_publication(path, entries, deadline)
            .map_err(|error| {
                format!(
                    "Lab preparation stopped after moving the folder to {}: {error}",
                    path.display()
                )
            })?;
        Ok(identity)
    }

    fn complete_publication(
        &self,
        path: &Path,
        entries: Vec<(PathBuf, files::Identity, bool)>,
        deadline: Instant,
    ) -> Result<(), String> {
        files::verify_path(&self.root, path)?;
        let mut pins = Vec::new();
        for (previous, identity, directory) in entries {
            let name = previous
                .strip_prefix(&self.path)
                .map_err(|e| e.to_string())?;
            let moved = path.join(name);
            let access = if name == Path::new(CONFIG_PENDING) {
                READ | DELETE
            } else {
                READ
            };
            let file = files::open(&moved, directory, access, 1)?;
            if files::identity(&file, directory)? != identity {
                return Err("A moved lab entry was replaced.".into());
            }
            pins.push((moved, file));
        }
        for (name, size, expected) in &self.digests {
            let current = path.join(name);
            let (_, file) = pins
                .iter_mut()
                .find(|(p, _)| *p == current)
                .ok_or("Missing moved lab entry.")?;
            let actual = stream_hash(file, std::io::sink(), *size, deadline)?;
            if &actual != expected {
                return Err("A moved lab entry's contents changed.".into());
            }
        }
        verify_members(
            path,
            &pins.iter().map(|(p, _)| p.clone()).collect::<Vec<_>>(),
        )?;
        let pending = path.join(CONFIG_PENDING);
        let (_, config) = pins
            .iter()
            .find(|(p, _)| *p == pending)
            .ok_or("Missing prepared Sandbox configuration.")?;
        // The only runnable configuration is published after all exact entries
        // are re-opened and held against replacement and content changes.
        files::rename_no_replace(config, &path.join("Lab.wsb"))
    }
}

fn verify_members(root: &Path, paths: &[PathBuf]) -> Result<(), String> {
    for directory in [root.to_path_buf(), root.join("Input")] {
        let expected = paths
            .iter()
            .filter(|path| path.parent() == Some(directory.as_path()))
            .count();
        let mut count = 0;
        for entry in fs::read_dir(directory).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            if !paths.contains(&entry.path()) {
                return Err("An unexpected item appeared in the lab folder.".into());
            }
            count += 1;
        }
        if count != expected {
            return Err("A staged lab entry is missing.".into());
        }
    }
    Ok(())
}

impl Drop for Stage {
    fn drop(&mut self) {
        if self.published {
            return;
        }
        for (path, _, _, file) in self.entries.drain(..).rev() {
            if files::verify_path(&file, &path).is_ok() {
                let _ = files::cleanup_held(&file);
            }
        }
        if files::verify_path(&self.root, &self.path).is_ok() {
            let _ = files::cleanup_held(&self.root);
        }
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn stream_hash(
    source: &mut File,
    mut target: impl Write,
    bytes: u64,
    deadline: Instant,
) -> Result<String, String> {
    if bytes == 0 || bytes > MAX_BYTES {
        return Err("Choose a non-empty installer no larger than 1 GiB.".into());
    }
    let mut digest = Sha256::new();
    let mut buffer = vec![0; 64 * 1024];
    let mut copied = 0;
    loop {
        if Instant::now() >= deadline {
            return Err("Installer copy timed out.".into());
        }
        let count = source.read(&mut buffer).map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        copied += count as u64;
        if copied > bytes {
            return Err("The installer changed during the copy.".into());
        }
        target
            .write_all(&buffer[..count])
            .map_err(|e| e.to_string())?;
        digest.update(&buffer[..count]);
    }
    if copied != bytes {
        return Err("The installer changed during the copy.".into());
    }
    let digest = digest.finalize();
    Ok(hex(digest.as_ref()))
}

struct Installer {
    path: PathBuf,
    name: String,
    extension: String,
    file: File,
    identity: files::Identity,
    bytes: u64,
    parents: Vec<Pin>,
}

impl Installer {
    fn open(path: PathBuf) -> Result<Self, String> {
        local_path(&path, 240)?;
        let extension = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if !matches!(extension.as_str(), "exe" | "msi") {
            return Err("Choose one local .exe or .msi installer.".into());
        }
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or("Installer name unavailable.")?
            .to_owned();
        let parents = pin_dirs(path.parent().ok_or("Installer folder is unavailable.")?)?;
        let file = files::open(&path, false, READ, 1)?;
        let identity = files::identity(&file, false)?;
        let bytes = file.metadata().map_err(|e| e.to_string())?.len();
        if bytes == 0 || bytes > MAX_BYTES {
            return Err("Choose a non-empty installer no larger than 1 GiB.".into());
        }
        Ok(Self {
            path,
            name,
            extension,
            file,
            identity,
            bytes,
            parents,
        })
    }
}

fn generate(mut source: Installer, parent: &Path, id: &str) -> Result<(View, Published), String> {
    local_path(parent, 185)?;
    if !valid_id(id) {
        return Err("Invalid lab identity.".into());
    }
    let parent_pins = pin_dirs(parent)?;
    let output = parent.join(format!("Purgeon Lab {id}"));
    security::checked_path(text(&output)?)?;
    let mut stage = Stage::new(parent.join(format!(".purgeon-lab-{id}.pending")))?;
    stage.add("Input", true)?;
    let installer_name = format!("Installer.{}", source.extension);
    let staged_name = format!("Input\\{installer_name}");
    let deadline = Instant::now() + LIMIT;
    let target = stage.add(&staged_name, false)?;
    let sha256 = stream_hash(&mut source.file, &mut *target, source.bytes, deadline)?;
    target.sync_all().map_err(|e| e.to_string())?;
    stage
        .digests
        .push((staged_name.into(), source.bytes, sha256.clone()));
    stage.write("Input\\Start.ps1", START.as_bytes())?;
    stage.write("Input\\Finish.ps1", FINISH.as_bytes())?;
    stage.write("Input\\Inventory.ps1", INVENTORY.as_bytes())?;
    let manifest = serde_json::json!({"version":1,"id":id,"installer":installer_name,"sha256":sha256,"bytes":source.bytes});
    stage.write(
        "Input\\Lab.json",
        &serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?,
    )?;
    stage.write(CONFIG_PENDING, config(&output.join("Input"))?.as_bytes())?;
    stage.write(
        "Read me.txt",
        include_bytes!("disposable_installer_lab/Read me.txt"),
    )?;
    for pin in source.parents.iter().chain(&parent_pins) {
        pin.verify(true)?;
    }
    files::verify_path(&source.file, &source.path)?;
    if files::identity(&source.file, false)? != source.identity
        || source.file.metadata().map_err(|e| e.to_string())?.len() != source.bytes
    {
        return Err("The installer changed before publication.".into());
    }
    let folder = text(&output)?.to_owned();
    let identity = stage.publish(&output, deadline, |_| {})?;
    Ok((
        View {
            id: id.into(),
            folder,
            installer_name: source.name,
            sha256,
        },
        Published {
            id: id.into(),
            path: output,
            identity,
        },
    ))
}

pub(crate) fn select_and_generate(app: &tauri::AppHandle) -> Result<Option<View>, String> {
    let _active = GENERATING
        .try_lock()
        .map_err(|_| "Installer lab preparation is already in progress.")?;
    generate_from_selection(
        &LAST,
        || {
            app.dialog()
                .file()
                .set_title("Choose a Local Installer for the Sandbox")
                .add_filter("Installers", &["exe", "msi"])
                .blocking_pick_file()
                .map(|file| file.into_path().map_err(|e| e.to_string()))
                .transpose()
        },
        || {
            app.dialog()
                .file()
                .set_title("Choose Where to Create the New Lab Folder")
                .blocking_pick_folder()
                .map(|folder| folder.into_path().map_err(|e| e.to_string()))
                .transpose()
        },
    )
}

fn generate_from_selection(
    last: &Mutex<Option<Published>>,
    choose_installer: impl FnOnce() -> Result<Option<PathBuf>, String>,
    choose_parent: impl FnOnce() -> Result<Option<PathBuf>, String>,
) -> Result<Option<View>, String> {
    let Some(source) = choose_installer()? else {
        return Ok(None);
    };
    let source = Installer::open(source)?;
    let Some(folder) = choose_parent()? else {
        return Ok(None);
    };
    let mut last = last
        .lock()
        .map_err(|_| "Could not remember the generated lab folder.")?;
    let id = crate::broker::random_id()?;
    let (view, published) = generate(source, &folder, &id[..12])?;
    *last = Some(published);
    Ok(Some(view))
}

pub(crate) fn open_folder(id: &str) -> Result<(), String> {
    open_folder_with(&LAST, id, show_folder)
}

fn open_folder_with(
    last: &Mutex<Option<Published>>,
    id: &str,
    show: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<(), String> {
    if !valid_id(id) {
        return Err("Invalid lab identity.".into());
    }
    let published = last.lock().map_err(|_| "Lab folder is unavailable.")?;
    let published = published
        .as_ref()
        .filter(|item| item.id == id)
        .ok_or("Lab folder is unavailable.")?;
    let _parents = pin_dirs(
        published
            .path
            .parent()
            .ok_or("Lab folder is unavailable.")?,
    )?;
    let folder = files::open(&published.path, true, READ, 3)?;
    if files::identity(&folder, true)? != published.identity {
        return Err("The generated lab folder changed.".into());
    }
    show(&published.path)
}

fn show_folder(folder: &Path) -> Result<(), String> {
    let operation = wide(Path::new("open"));
    let path = wide(folder);
    let status = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            operation.as_ptr(),
            path.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            1,
        )
    };
    if status <= 32 {
        return Err("Windows could not open the lab folder.".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn generate(input: &Path, parent: &Path, id: &str) -> Result<(View, Published), String> {
        super::generate(Installer::open(input.to_path_buf())?, parent, id)
    }

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let parent = crate::updater_native::canonical_temp(&std::env::temp_dir()).unwrap();
            let path = parent.join(format!("lab-{}", crate::broker::random_id().unwrap()));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    #[test]
    fn generated_lab_has_one_read_only_mapping_and_no_autorun() {
        let fixture = Fixture::new();
        let parent = fixture.0.join("Purge & keep");
        fs::create_dir(&parent).unwrap();
        let source = fixture.0.join("Inert.MSI");
        fs::write(&source, b"abc").unwrap();
        let (view, receipt) = generate(&source, &parent, "aabbccddeeff").unwrap();
        assert_eq!(view.installer_name, "Inert.MSI");
        assert_eq!(
            view.sha256,
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(Path::new(&view.folder), receipt.path);
        let input = receipt.path.join("Input");
        let config = fs::read_to_string(receipt.path.join("Lab.wsb")).unwrap();
        assert!(config.contains("Purge &amp; keep"));
        for tag in [
            "vGPU",
            "Networking",
            "AudioInput",
            "VideoInput",
            "PrinterRedirection",
            "ClipboardRedirection",
        ] {
            assert!(config.contains(&format!("<{tag}>Disable</{tag}>")));
        }
        assert!(config.contains("<ProtectedClient>Enable</ProtectedClient>"));
        assert!(config.contains("<ReadOnly>true</ReadOnly>"));
        assert!(!config.contains("LogonCommand"));
        assert_eq!(config.matches("<MappedFolder>").count(), 1);
        assert_eq!(fs::read(input.join("Installer.msi")).unwrap(), b"abc");
        assert_eq!(fs::read_to_string(input.join("Start.ps1")).unwrap(), START);
        assert_eq!(
            fs::read_to_string(input.join("Finish.ps1")).unwrap(),
            FINISH
        );
        assert_eq!(
            fs::read_to_string(input.join("Inventory.ps1")).unwrap(),
            INVENTORY
        );
        let manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(input.join("Lab.json")).unwrap()).unwrap();
        assert_eq!(
            manifest,
            serde_json::json!({"version":1,"id":view.id,"installer":"Installer.msi","sha256":view.sha256,"bytes":3})
        );
        assert_eq!(fs::read(&source).unwrap(), b"abc");
        assert_eq!(fs::read_dir(&parent).unwrap().count(), 1);
    }

    #[test]
    fn refusal_and_collision_leave_only_the_original_owned_files() {
        let fixture = Fixture::new();
        let id = "aabbccddeeff";
        let source = fixture.0.join("inert.exe");
        let output = fixture.0.join(format!("Purgeon Lab {id}"));
        fs::write(&source, []).unwrap();
        assert!(generate(&source, &fixture.0, id).is_err());
        assert!(!output.exists());
        fs::write(&source, b"inert").unwrap();
        fs::create_dir(&output).unwrap();
        fs::write(output.join("sentinel"), b"unchanged").unwrap();
        assert!(generate(&source, &fixture.0, id).is_err());
        assert_eq!(fs::read(output.join("sentinel")).unwrap(), b"unchanged");
        assert_eq!(fs::read_dir(&fixture.0).unwrap().count(), 2);
        assert!(generate(&source, &fixture.0, "invalid").is_err());
        let alias = fixture.0.join("alias.exe");
        fs::hard_link(&source, &alias).unwrap();
        assert!(generate(&source, &fixture.0, id).is_err());
        assert_eq!(fs::read(&alias).unwrap(), b"inert");
    }

    #[test]
    fn source_and_destination_refuse_aliases_and_percent_expansion() {
        for bad in [
            r"\\host\share\installer.msi",
            r"\\?\C:\installer.msi",
            r"C:\a.exe:stream",
            r"C:\NUL.exe",
            r"C:\COM¹.exe",
            r"C:\dir\..\installer.msi",
            r"C:\%TEMP%\installer.msi",
            r"C:\dir\\installer.msi",
            r"C:\dir.\installer.msi",
        ] {
            assert!(local_path(Path::new(bad), 240).is_err(), "{bad}");
        }
        assert_eq!(xml("<&'\" >"), "&lt;&amp;&apos;&quot; &gt;");
        let fixture = Fixture::new();
        let source = fixture.0.join("installer.msi");
        fs::write(&source, b"inert").unwrap();
        let held = OpenOptions::new().write(true).open(&source).unwrap();
        assert!(generate(&source, &fixture.0, "aabbccddeeff").is_err());
        drop(held);
        assert_eq!(fs::read_dir(&fixture.0).unwrap().count(), 1);
    }

    #[test]
    fn copy_timeout_and_length_mismatch_roll_back_the_staged_file() {
        let fixture = Fixture::new();
        let path = fixture.0.join("inert.msi");
        fs::write(&path, b"abc").unwrap();
        for (size, deadline) in [
            (3, Instant::now()),
            (2, Instant::now() + LIMIT),
            (4, Instant::now() + LIMIT),
        ] {
            let stage_path = fixture.0.join("pending");
            let mut stage = Stage::new(stage_path.clone()).unwrap();
            let target = stage.add("installer.msi", false).unwrap();
            assert!(stream_hash(&mut File::open(&path).unwrap(), target, size, deadline).is_err());
            drop(stage);
            assert!(!stage_path.exists());
        }
    }

    #[test]
    fn folder_open_requires_a_known_id_before_shell_access() {
        assert_eq!(open_folder("bad").unwrap_err(), "Invalid lab identity.");
        assert_eq!(
            open_folder("aabbccddeeff").unwrap_err(),
            "Lab folder is unavailable."
        );
    }

    #[test]
    fn publication_refuses_unexpected_input_and_preserves_the_foreign_file() {
        let fixture = Fixture::new();
        let pending = fixture.0.join("pending");
        let mut stage = Stage::new(pending.clone()).unwrap();
        stage.add("Input", true).unwrap();
        stage.write("Input\\known", b"owned").unwrap();
        let foreign = pending.join("Input\\foreign");
        fs::write(&foreign, b"preserve").unwrap();
        let target = fixture.0.join("published");
        assert!(stage
            .publish(&target, Instant::now() + LIMIT, |_| {})
            .is_err());
        drop(stage);
        assert!(!target.exists());
        assert!(!pending.join("Input\\known").exists());
        assert_eq!(fs::read(foreign).unwrap(), b"preserve");
    }

    #[test]
    fn move_gap_changes_leave_the_configuration_inert_and_replacements_untouched() {
        let fixture = Fixture::new();
        for change in ["replace", "edit", "add"] {
            let mut stage = Stage::new(fixture.0.join("pending")).unwrap();
            stage.add("Input", true).unwrap();
            stage.write("Input\\payload", b"ours").unwrap();
            stage
                .write(CONFIG_PENDING, b"inert config fixture")
                .unwrap();
            let target = fixture.0.join(change);
            let result = stage.publish(&target, Instant::now() + LIMIT, |moved| {
                assert!(!moved.join("Lab.wsb").exists());
                let payload = moved.join("Input\\payload");
                match change {
                    "replace" => {
                        fs::rename(&payload, moved.join("original")).unwrap();
                        fs::write(&payload, b"ours").unwrap();
                    }
                    "edit" => fs::write(&payload, b"edit").unwrap(),
                    _ => fs::write(moved.join("Input\\foreign"), b"extra").unwrap(),
                }
            });
            assert!(result.unwrap_err().contains("stopped after moving"));
            assert!(!target.join("Lab.wsb").exists());
            assert!(target.join(CONFIG_PENDING).is_file());
            if change == "replace" {
                assert_eq!(fs::read(target.join("original")).unwrap(), b"ours");
            } else if change == "edit" {
                assert_eq!(fs::read(target.join("Input\\payload")).unwrap(), b"edit");
            } else {
                assert_eq!(fs::read(target.join("Input\\foreign")).unwrap(), b"extra");
            }
        }
    }

    #[test]
    fn junctions_are_refused_for_source_and_output_ancestors() {
        let fixture = Fixture::new();
        let real = fixture.0.join("real");
        let link = fixture.0.join("junction");
        fs::create_dir(&real).unwrap();
        let source = real.join("inert.msi");
        fs::write(&source, b"not executable").unwrap();
        let tool = crate::windows_tools::system_file("powershell.exe").unwrap();
        let output = std::process::Command::new(tool)
            .args(["-NoProfile", "-NonInteractive", "-Command",
                "$ErrorActionPreference='Stop'; New-Item -ItemType Junction -Path $env:PURGEON_LAB_TEST_LINK -Target $env:PURGEON_LAB_TEST_TARGET | Out-Null"])
            .env("PURGEON_LAB_TEST_LINK", &link)
            .env("PURGEON_LAB_TEST_TARGET", &real)
            .output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(generate(&link.join("inert.msi"), &real, "aabbccddeeff").is_err());
        assert!(generate(&source, &link, "aabbccddeeff").is_err());
        fs::remove_dir(&link).unwrap();
        assert_eq!(fs::read_dir(&real).unwrap().count(), 1);
    }

    #[test]
    fn chooser_cancellation_writes_nothing_and_known_folder_is_identity_bound() {
        let fixture = Fixture::new();
        let source = fixture.0.join("inert.exe");
        fs::write(&source, b"inert").unwrap();
        let last = Mutex::new(None);
        assert!(generate_from_selection(
            &last,
            || Ok(None),
            || panic!("second picker after cancellation")
        )
        .unwrap()
        .is_none());
        assert!(
            generate_from_selection(&last, || Ok(Some(source.clone())), || Ok(None))
                .unwrap()
                .is_none()
        );
        assert_eq!(fs::read_dir(&fixture.0).unwrap().count(), 1);
        let view = generate_from_selection(
            &last,
            || Ok(Some(source.clone())),
            || {
                assert!(OpenOptions::new().write(true).open(&source).is_err());
                assert!(fs::rename(&source, fixture.0.join("moved.exe")).is_err());
                Ok(Some(fixture.0.clone()))
            },
        )
        .unwrap()
        .unwrap();
        let expected = Path::new(&view.folder);
        open_folder_with(&last, &view.id, |path| {
            assert_eq!(path, expected);
            Ok(())
        })
        .unwrap();
        fs::rename(expected, fixture.0.join("old")).unwrap();
        fs::create_dir(expected).unwrap();
        assert!(open_folder_with(&last, &view.id, |_| panic!("replacement opened")).is_err());
    }
}
