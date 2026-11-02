/// Only complete, recognized window requests bypass command-line validation.
/// Everything else goes to the CLI, where invalid requests get an error and exit 1.
pub fn is_help_request(args: &[String]) -> bool {
    // This is the complete help grammar shared with parseCliArgs: a single
    // command alias and no values/options. Extra arguments retain CLI parsing.
    matches!(args, [arg] if ["--help", "-h", "/?"].iter().any(|alias| arg.eq_ignore_ascii_case(alias)))
}

pub fn help_text() -> Result<&'static str, String> {
    static HELP: std::sync::OnceLock<Result<String, String>> = std::sync::OnceLock::new();
    HELP.get_or_init(|| {
        serde_json::from_str(include_str!("../../src/cli-help.json"))
            .map_err(|e| format!("Command help is unreadable: {e}"))
    })
    .as_ref()
    .map(String::as_str)
    .map_err(Clone::clone)
}

pub fn is_window_request(args: &[String]) -> bool {
    let mut index = 0;
    while index < args.len() {
        match args[index].to_ascii_lowercase().as_str() {
            "--tray" | "--resume-queue" | "--started-by-windows" => index += 1,
            "--who-owns" | "--uninstall-target" => {
                let Some(target) = args.get(index + 1) else {
                    return false;
                };
                if target.trim().is_empty() || target.starts_with('-') || target == "/?" {
                    return false;
                }
                index += 2;
            }
            _ => return false,
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::is_window_request;

    fn window(args: &[&str]) -> bool {
        is_window_request(&args.iter().map(|arg| arg.to_string()).collect::<Vec<_>>())
    }
    #[test]
    fn only_complete_help_requests_take_the_native_fast_path() {
        use super::{help_text, is_help_request};
        for alias in ["--help", "--HELP", "-h", "-H", "/?"] {
            assert!(is_help_request(&[alias.into()]));
            for extra in ["--help", "--quiet", "--unknown", "value", ""] {
                assert!(!is_help_request(&[alias.into(), extra.into()]));
            }
        }
        for args in [
            vec![],
            vec!["--help\0".into()],
            vec!["--help=".into()],
            vec!["--snapshot".into(), "--help".into()],
        ] {
            assert!(!is_help_request(&args));
        }
        let shared: String = serde_json::from_str(include_str!("../../src/cli-help.json")).unwrap();
        assert_eq!(help_text().unwrap(), shared);
        assert!(shared.starts_with("Purgeon command line"));
    }

    #[test]
    fn preserves_complete_window_launches() {
        for args in [
            vec![],
            vec!["--tray"],
            vec!["--resume-queue"],
            vec!["--started-by-windows"],
            vec!["--TRAY", "--resume-queue"],
            vec!["--who-owns", r"C:\Program Files\Example"],
            vec!["--uninstall-target", r"C:\Program Files\Example\app.exe"],
            vec!["--tray", "--who-owns", r"C:\example\--help"],
        ] {
            assert!(window(&args), "{args:?}");
        }
    }

    #[test]
    fn sends_cli_commands_and_typos_to_validation() {
        for args in [
            vec!["--help"],
            vec!["-h"],
            vec!["/?"],
            vec!["--snapshot", "Before"],
            vec!["--compare", "Before", "now"],
            vec!["--list-snapshots"],
            vec!["--monitor", r"C:\setup.exe"],
            vec!["--maintenance"],
            vec!["--autostart", "on"],
            vec!["--maintenence"],
            vec!["unexpected"],
            vec!["--tray", "--maintenance"],
            vec!["--who-owns"],
            vec!["--uninstall-target", "--help"],
            vec!["--who-owns", " "],
            vec!["--who-owns", "/?"],
            vec!["--who-owns", r"C:\example", "--unknown"],
        ] {
            assert!(!window(&args), "{args:?}");
        }
    }
}
