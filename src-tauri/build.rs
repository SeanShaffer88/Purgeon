mod build_support;

fn main() {
    // Use profile ancestry, not optimization/debug-info settings: optimized dev builds
    // must still run unelevated, and release builds with debug symbols must still elevate.
    let profile = std::env::var("PROFILE").expect("Cargo must set PROFILE");
    let windows = tauri_build::WindowsAttributes::new()
        .app_manifest(build_support::application_manifest(&profile));
    tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows))
        .expect("failed to run tauri-build");
}
