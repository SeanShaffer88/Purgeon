use std::borrow::Cow;

const MANIFEST: &str = include_str!("app.manifest");

/// All profiles use the asInvoker manifest. Elevation is an explicit operation,
/// never a requirement merely for opening the program or asking for CLI help.
pub fn application_manifest(_profile: &str) -> Cow<'static, str> {
    Cow::Borrowed(MANIFEST)
}
