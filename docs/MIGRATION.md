# Moving between versions and copies

## Upgrading

Install the new version over the old one — with Setup, or by replacing
the portable folder's program file. Settings, backups, snapshots and
monitor records are kept: the settings file carries a version number
and Purgeon upgrades it in place on first run, keeping your choices
(including which monitors are on).

## Setup ↔ portable

Both copies keep the same data layout. To move:

1. Find the data folder: the portable copy keeps a `data` folder beside
   `Purgeon.exe`; the installed copy keeps its folder under your Windows
   app-data folder (Purgeon Health names the exact path).
2. Close Purgeon, copy the whole data folder to the new copy's data
   location, and start the new copy.

Backups move with the data folder and stay restorable.

## Downgrading

Older versions cannot always read newer data. The settings upgrade only
moves forward, and a downgrade may reset settings to defaults; backups
made by a newer version should be restored by that version or newer.
If you must go back, export or copy the data folder first so nothing is
lost.
