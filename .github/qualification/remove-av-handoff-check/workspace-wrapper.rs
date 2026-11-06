use std::{env, ffi::OsString, path::PathBuf, process::Command};
fn run() -> Result<i32, String> {
    let mut args = env::args_os().skip(1);
    let compiler = args.next().ok_or("missing rustc argument")?;
    let expected = PathBuf::from(env::var_os("PURGEON_COVERAGE_RUSTC").ok_or("missing configured rustc")?);
    if std::fs::canonicalize(&compiler).map_err(|e|e.to_string())? != std::fs::canonicalize(&expected).map_err(|e|e.to_string())? {
        return Err("compiler differs from configured rustc".into());
    }
    let mut forwarded: Vec<OsString> = args.collect();
    let build_script = forwarded.windows(2).any(|p| p[0] == "--crate-name" && p[1] == "build_script_build");
    if build_script {
        let manifest = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").ok_or("missing Cargo manifest directory")?);
        let project = PathBuf::from(env::var_os("PURGEON_COVERAGE_MANIFEST_DIR").ok_or("missing configured project")?);
        if std::fs::canonicalize(manifest).map_err(|e|e.to_string())? != std::fs::canonicalize(project).map_err(|e|e.to_string())? {
            return Err("build script is outside configured project".into());
        }
        forwarded.push("-Cinstrument-coverage".into());
    }
    let status = Command::new(expected).args(forwarded).status().map_err(|e|e.to_string())?;
    Ok(status.code().unwrap_or(1))
}
fn main() {
    match run() {
        Ok(code) => std::process::exit(code),
        Err(error) => { eprintln!("coverage workspace wrapper: {error}"); std::process::exit(1) }
    }
}

