//! Keep Windows helpers in the OS-native view even when Purgeon itself is x86.
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Native-only helpers must not derive privileged executable/DLL locations from
/// caller environment variables or search the working directory.
pub fn system_file(name: &str) -> Result<PathBuf, String> {
    if name.is_empty() || name.contains(['\\', '/', ':', '\0']) {
        return Err("Expected a Windows system filename".into());
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetSystemDirectoryW(buffer: *mut u16, size: u32) -> u32;
    }
    let mut buffer = vec![0u16; 32768];
    let length = unsafe { GetSystemDirectoryW(buffer.as_mut_ptr(), buffer.len() as u32) } as usize;
    if length == 0 || length >= buffer.len() {
        return Err("Could not resolve Windows system directory".into());
    }
    let directory =
        PathBuf::from(String::from_utf16(&buffer[..length]).map_err(|e| e.to_string())?);
    Ok(if name.eq_ignore_ascii_case("powershell.exe") {
        directory.join(r"WindowsPowerShell\v1.0\powershell.exe")
    } else {
        directory.join(name)
    })
}

fn tool_under(root: &Path, file: &str, wow64: bool) -> PathBuf {
    let directory = root.join(if wow64 { "Sysnative" } else { "System32" });
    match file.to_ascii_lowercase().as_str() {
        "powershell.exe" => directory.join(r"WindowsPowerShell\v1.0\powershell.exe"),
        // regedt32 is the native launcher for Registry Editor.
        "regedit.exe" => directory.join("regedt32.exe"),
        "explorer.exe" => root.join("explorer.exe"),
        "rstrui.exe" => directory.join("rstrui.exe"),
        "cmd.exe" | "reg.exe" | "schtasks.exe" | "net.exe" | "sc.exe" | "dism.exe"
        | "cleanmgr.exe" | "msiexec.exe" => directory.join(file),
        _ => PathBuf::from(file),
    }
}

pub fn command(file: &str) -> PathBuf {
    let Some(root) = std::env::var_os("SystemRoot").map(PathBuf::from) else {
        return PathBuf::from(file);
    };
    // Sysnative is visible only to a 32-bit process on a 64-bit Windows OS.
    let wow64 = cfg!(target_pointer_width = "32") && root.join("Sysnative").is_dir();
    tool_under(&root, file, wow64)
}

fn normalize_program_folders(env: &mut HashMap<String, String>) {
    for (native, generic) in [
        ("ProgramW6432", "ProgramFiles"),
        ("CommonProgramW6432", "CommonProgramFiles"),
    ] {
        if let Some(value) = env
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(native))
            .map(|(_, value)| value.clone())
        {
            env.insert(generic.into(), value);
        }
    }
}

pub fn environment() -> HashMap<String, String> {
    let mut env = std::env::vars().collect();
    normalize_program_folders(&mut env);
    env
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    #[test]
    fn selects_native_tools_without_rewriting_user_program_paths() {
        let root = Path::new(r"D:\Windows");
        for wow64 in [false, true] {
            let directory = root.join(if wow64 { "Sysnative" } else { "System32" });
            assert_eq!(
                tool_under(root, "reg.exe", wow64),
                directory.join("reg.exe")
            );
            assert_eq!(
                tool_under(root, "powershell.exe", wow64),
                directory.join(r"WindowsPowerShell\v1.0\powershell.exe")
            );
            assert_eq!(
                tool_under(root, "regedit.exe", wow64),
                directory.join("regedt32.exe")
            );
            for file in ["winget", r"C:\Tools\reg.exe", r".\cmd.exe"] {
                assert_eq!(tool_under(root, file, wow64), PathBuf::from(file));
            }
        }
    }

    #[test]
    fn exposes_both_program_folders_to_the_backend() {
        let mut env = HashMap::from([
            ("ProgramFiles".into(), "32-bit programs".into()),
            ("ProgramFiles(x86)".into(), "32-bit programs".into()),
            ("ProgramW6432".into(), "64-bit programs".into()),
        ]);
        normalize_program_folders(&mut env);
        assert_eq!(env["ProgramFiles"], "64-bit programs");
        assert_eq!(env["ProgramFiles(x86)"], "32-bit programs");
        let mut native32 = HashMap::from([("ProgramFiles".into(), "programs".into())]);
        normalize_program_folders(&mut native32);
        assert_eq!(native32["ProgramFiles"], "programs");
    }

    #[test]
    fn powershell_runs_in_the_os_native_architecture() {
        let output = Command::new(command("powershell.exe"))
            .env_remove("PSModulePath")
            .args(["-NoProfile", "-NonInteractive", "-Command",
                "if ([Environment]::Is64BitProcess -ne [Environment]::Is64BitOperatingSystem) { exit 9 }; Write-Output 'native-view'"])
            .creation_flags(0x0800_0000)
            .output()
            .expect("Windows PowerShell must be installed");
        assert!(
            output.status.success(),
            "PowerShell used the redirected architecture"
        );
        assert_eq!(
            String::from_utf8_lossy(&output.stdout).trim(),
            "native-view"
        );
    }
}
