use std::borrow::Cow;

const MANIFEST: &str = include_str!("app.manifest");

/// Development and default test builds run with the caller's existing rights.
/// Release builds keep the shipped manifest, including its elevation requirement.
pub fn application_manifest(profile: &str) -> Cow<'static, str> {
    if profile == "debug" {
        const ELEVATED: &str = "level=\"requireAdministrator\"";
        assert_eq!(
            MANIFEST.matches(ELEVATED).count(),
            1,
            "unexpected application manifest"
        );
        Cow::Owned(MANIFEST.replacen(ELEVATED, "level=\"asInvoker\"", 1))
    } else {
        // An unrecognized profile must not silently change release privileges.
        Cow::Borrowed(MANIFEST)
    }
}
