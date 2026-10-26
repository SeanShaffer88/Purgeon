#[path = "../build_support.rs"]
mod build_support;

#[test]
fn development_manifest_runs_without_requesting_elevation() {
    let manifest = build_support::application_manifest("debug");
    assert!(manifest.contains("requestedExecutionLevel level=\"asInvoker\" uiAccess=\"false\""));
    assert!(!manifest.contains("requireAdministrator"));
    assert!(manifest.contains("Microsoft.Windows.Common-Controls"));
    assert!(manifest.contains("PerMonitorV2"));
    assert!(manifest.contains("supportedOS"));
}

#[test]
fn release_and_unknown_profiles_preserve_the_shipped_manifest_exactly() {
    for profile in ["release", "", "custom"] {
        assert_eq!(
            build_support::application_manifest(profile),
            include_str!("../app.manifest")
        );
    }
}
