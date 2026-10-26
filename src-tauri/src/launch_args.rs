/// Only complete, recognized window requests bypass command-line validation.
/// Everything else goes to the CLI, where invalid requests get an error and exit 1.
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
