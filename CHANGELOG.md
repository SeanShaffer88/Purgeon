# Changelog

## Unreleased

- Validate the entire command line before initializing the backend or running an
  operation. Reject unknown or repeated options, conflicting commands, unexpected
  arguments, and missing values instead of ignoring them.
- Route command-line typos to an error and exit code 1 instead of opening the main
  window. Keep tray, sign-in, queue-resume, and Explorer launches available.
- Show help without initializing the application's backend stores and command log.
  The native application and WebView2 still start and may create their runtime data.

Earlier feature history is in [the roadmap](docs/ROADMAP.md).
