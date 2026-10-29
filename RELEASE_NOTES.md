# Purgeon 1.1.0

## Debloat grows to 129 tweaks

- **New Microsoft Edge section — 36 toggles.** Each one is a documented Microsoft Edge policy: Strict tracking prevention, no personalised ads/search/news, diagnostic data limited to required, no feedback, no payment-method checks by websites, card and address autofill off, address-bar suggestions off, no page preloading, no password saving, shopping assistant and sidebar off, a quiet new tab page, no first-run experience, no automatic sign-in, no default-browser prompts, startup boost off, and the AI features (built-in AI APIs, AI themes, Copilot, inline Compose, AI history search) off or hidden. SmartScreen and the typosquatting checker are deliberately not offered — they protect against malicious sites.
- **Two sections are back.** The App Privacy (32 toggles) and Settings sync (6) sections were missing from the Debloat view — the header counted them, but they never appeared. They render again, and the view can no longer lose a section that way.

## Fixes and polish

- **The installer now updates in place.** Installing over an existing copy no longer stops to offer an uninstall of the old version first; it updates over the top, the same way the in-app updater already did.
- **Menu flyouts display properly.** Flyouts such as Tools › Advanced Tools opened behind the menu dropdown; they now open clear of it, fully visible and clickable.
- **Every scan and progress task has a Cancel button.** The leftover and orphan scans (which keep what they found so far), the pre-uninstall check (cancelling it stops the uninstall), program analysis, restores and undo, the Cleaner scan, and the Games, Relationship Graph and Recovery Packages windows while they load, verify or restore.
- **The view rail's icons are evenly aligned** — every icon now shares one size and centre.
