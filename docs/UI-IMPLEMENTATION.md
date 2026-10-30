# English-only interface hardening

> Historical implementation/validation snapshot. Its counts and deferred-work
> instructions describe that earlier revision. See [QUALITY.md](../QUALITY.md)
> for current executed evidence and remaining gates. VM checks, hypervisor
> installation and VM boot are explicitly prohibited by the user. Any VM scenario
> retained below is historical planning, not an authorized instruction to run it.


Status: local, unvalidated implementation. The user explicitly deferred all tests,
builds, lint/type checks, app launches, accessibility checks, and penetration work.
No runtime outcome is inferred from the source edits below.

## Scope and capability decisions

- The user changed the language requirement to **English only**. The UI no longer
  offers language selection or cycles through other languages. The compatibility
  language API lists only `en` and rejects other codes. Startup normalizes an
  existing non-English language setting without changing other settings or data
  identity. No foreign-language catalog or translation dependency is shipped.
- `t` retains stable English named keys, interpolation, and English plurals.
  `tx` preserves English presentation literals and interpolation. React renders
  ordinary text; `tHtml` escapes output intended for an HTML string. No user text
  is interpreted as markup by these helpers.
- The React performance skill's `rerender-dependencies`,
  `rerender-use-ref-transient-values`, `js-index-maps`, and rendering guidance
  informed windowed rendering, bounded navigation state, and listener ownership.
  The skill was read before this work; no new runtime package was introduced.
- The separate interface mockup shows the simplified toolbar, labeled navigation,
  evidence-based cleanup review, and conservative confirmation placement.

## Implemented source changes

- `ActionToolbar` keeps inspection and uninstall prominent. Advanced operations
  remain available under a native `details`/`summary` More menu. Escape closes the
  menu and returns focus to its summary. Explicit action IDs map to named labels.
- Navigation has an accessible compact/label toggle. Styling accounts for light
  and dark themes, narrow windows, longer evidence labels, and visible focus.
- Double-click opens inspection rather than uninstall, restore, undo, or reinstall.
  Enter also opens inspection. A second mouse-down in a double-click does not
  toggle the selection away before the inspection action runs. Snapshot comparison
  remains a read-only double-click action.
- The main list has its sorting controls outside its listbox. Options expose
  selection and absolute positions/counts. The focused offscreen option remains
  available to assistive technology without expanding the visible row window.
- Windowing clamps ranges after shorter filters, resets for dataset/view/sort
  changes, reattaches listeners after a loading/remount cycle, and measures the
  row height governed by the shared scaled CSS geometry. Scroll listeners are
  passive and animation-frame coalesced; observers/listeners clean up on unmount.
- Ref-owned, bounded Back/Forward history replaces an effect that depended on the
  history index it incremented. Navigation no longer references an updater-local
  variable outside its scope.
- Dialog, Busy, and command-palette layers share modal ownership. Only the top
  layer responds to Escape/Tab; background siblings are inert while a modal is
  active. Original inert state is restored after the last layer closes. Focus
  returns only to a connected, non-inert opener or the remaining top modal.
  Generic Enter no longer automatically activates a destructive primary button.
- Busy progress has progressbar semantics and an elapsed-time ticker with cleanup.
  Existing Pause/Resume callback handling and conservative confirmation focus are
  retained from the main hardening work.
- Preference sync has explicit status, errors, first-connection/conflict text, and
  separately confirmed Pull/Push choices. Successful application refreshes theme,
  grid, text scale, and the fixed English language state. These controls use the
  existing backend API; they do not copy programs, backups, or secrets.
- Uncertain recovery records show the operation, target, and backup ID. Automatic
  rollback/replay is not offered. Dismiss uses the backend's no-mutation action,
  which retains the journal and backup evidence.
- Cleanup displays ownership evidence instead of percentages. Name matches and
  unattributed snapshot changes remain visibly reviewable. Help and onboarding no
  longer promise universal backup, complete trial reversal, or probability-based
  certainty; recovery depends on the operation and retained payloads/Recycle Bin.

## Source authoring evidence

`UI-LOCALIZATION-INVENTORY.json` records current English presentation call sites
and named keys. It is an inventory, not a translation deficit, test result,
coverage metric, or proof of rendered behavior. Existing repository Rolldown
parser interfaces were read and used by an intermediate source-editing utility;
no application build or validation gate was executed.

One intermediate edit left an obsolete Dialog cleanup fragment; the editing
utility reported `Unexpected token` and exit 1. That exact fragment was removed,
and the subsequent editing operations exited 0. This is recorded as an editing
failure and correction, not as a passing syntax/build test.

## Interrupted Debloat recovery presentation

The interface mockup was updated before recovery UI implementation at
`outputs/Purgeon-interface-mockup.html` (workspace output directory, outside this
repository). Its source-edit command exited 0. The Debloat view presents retained
resource summaries for captured before, planned target, current value, and native
classification. Ordinary toggles are blocked while a recovery record remains.
Inspect / Reconcile and Accept current state explicitly disclose metadata-only
behavior; eligible rollback discloses registry writes, ownership checks, and
retained empty keys. Legacy journals cannot roll back; CurrentControlSet mapping
mismatches block automatic reconciliation and rollback. No automatic replay is
offered. Native safe-decision lists constrain controls, and native consent remains
the authority for execution. Errors release busy state and reload retained status.

Source patches provide no process exit code. Backend interface wiring and
independent source audit are tracked in the task handoff; no runtime recovery,
keyboard, accessibility, build, lint, typecheck, or penetration checks were run.

## Deferred validation

Keyboard-only flows, NVDA behavior, theme contrast, display scaling, stacked-modal
unmounts, 1,000/10,000-item lists, scroll retention, sync conflict workflows, and
elapsed/progress behavior have **not** been executed. Application performance
budgets and accessibility claims must remain unverified until those checks are
authorized. This UI slice does not complete the separately tracked privileged
broker architecture.
