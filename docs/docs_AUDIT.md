# Audit notes

What has been checked in Purgeon, and how. This page is a summary of
the standing checks, not a one-time certificate: every change re-runs
them, and every release re-checks the shipped files.

## Safety of changes

- Every destructive job (program removal, leftover clean-up, junk
  clean, tweaks) routes through the backup-first operations layer; the
  test suite covers backup creation, restore, and the undo paths.
- Jobs that cannot be undone must say so before running — covered by
  tests on the plan and results views.
- A dry-run mode exercises every job without changing the machine, and
  is part of the normal test pass.

## Input and data

- Command-line arguments, settings files and stored records are
  validated before use; a settings file from an older version is
  upgraded through its versioned migration, never silently discarded.
- Files Purgeon keeps are written atomically, so an interrupted save
  leaves the previous good copy in place.
- Backups record what was taken and when, and restores verify hashes
  where the backup format provides them.

## Network surface

- Purgeon has no server, no account system and no telemetry.
- The only outbound request is the optional update check to GitHub,
  gated by its Settings switch, and it downloads nothing without the
  user asking. This is covered by tests with the network replaced by
  local stand-ins.

## Release checks

- The full test suite and production build pass before any release.
- Published downloads are re-downloaded after release and their SHA-256
  hashes compared with the release page.
- Releases are unsigned; the hashes on the release page are the
  integrity check (see [SECURITY.md](SECURITY.md)).

## Known limits

- Purgeon can only restore what it backed up. A program's own
  uninstaller can change things outside Purgeon's control; the results
  view reports what it can verify.
- Windows behaviour is confirmed on a real Windows PC for each release;
  automated checks cover the logic, not the live operating system.
