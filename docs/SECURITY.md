# Security and privacy

## What Purgeon never does

- No account, no sign-in, no telemetry. Purgeon does not track usage and
  does not send your data anywhere.
- It works fully offline. The one optional exception is the update
  check, which asks GitHub for the newest release version — only when
  update checks are switched on in Settings, and it downloads nothing
  without asking you first.
- Purgeon never sells or shares data. There is no data to share: your
  program lists, backups and records stay in Purgeon's data folder on
  your PC.

## How changes stay safe

- Every program removal, leftover clean-up and tweak writes a backup
  first, and can be undone from the Backups page.
- Before bulk jobs Purgeon offers a Windows restore point.
- A change that cannot be undone says so on screen before it runs.
- Purgeon runs with your own rights. It asks Windows for administrator
  rights only for a specific job that needs them, at the moment you run
  it, and the job is marked **Admin** beforehand.
- Dry-run mode shows exactly what a job would do without doing it.

## About the unsigned installer

Releases are not code-signed, so Windows shows a SmartScreen warning on
first run (see [TROUBLESHOOTING.md](TROUBLESHOOTING.md)). Every release
page lists the file sizes and SHA-256 hashes of the downloads, so you
can check a file you downloaded is the file that was published.

## Reporting a security problem

Please do not open a public issue for a security problem. Contact the
maintainer through GitHub (see [MAINTAINERS.md](MAINTAINERS.md)) with
the details and the Purgeon version from the title bar.
