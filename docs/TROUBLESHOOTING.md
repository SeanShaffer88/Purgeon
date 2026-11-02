# Troubleshooting

## "Windows protected your PC" when installing

Purgeon is not code-signed, so Windows shows this screen for the
installer. Choose **More info**, then **Run anyway**. This is expected
for every release.

## The program list is empty or a program is missing

The first scan can take a short while on a full machine. If a program is
still missing, it may be installed for a different Windows user, or it
may be a portable program Windows never registered — portable programs
only appear after Purgeon's installer monitor has seen them run, or when
they register themselves.

## A removal fails

The results list shows a plain next step under each failed item — the
usual causes are the program still running, its own uninstaller asking a
question, or a file being in use. Close the program, run the removal
again, and restart Windows before retrying if a file stays locked.

## Leftovers came back after cleaning

Some programs recreate their folders or registry keys when they next
run or update. Clean them again after the program itself is gone; if the
program is still installed, its leftovers belong to it.

## Purgeon says a change could not be undone

Changes that cannot be backed up say so before they run, and nothing
starts until you confirm. Everything else can be undone from the
**Backups** page.

## Something looks wrong with Purgeon itself

Open **Purgeon Health** from the command bar. It checks Purgeon's own
files, data folder, settings, background tasks and update setting, and
names the fix for anything it finds. If you report a problem, include
what Purgeon Health shows — see [SUPPORT.md](SUPPORT.md).
