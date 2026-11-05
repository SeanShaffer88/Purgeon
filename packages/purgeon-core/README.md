# purgeon-core

Dependency-free ESM extraction of [SeanShaffer88/Purgeon](https://github.com/SeanShaffer88/Purgeon), MIT, copyright Sean Shaffer. The app composes the same canonical implementations through private repository wrappers. No npm registry publication is configured or performed.

Install a locally produced tarball with `npm install --offline --ignore-scripts ./purgeon-core-1.6.0.tgz`. Produce it with `npm pack ./packages/purgeon-core --ignore-scripts`. See [CAPABILITIES.md](./CAPABILITIES.md) for every named operation, channel, dependency and app-only boundary. Package exports are explicit; arbitrary dispatch and raw system access are unsupported. The export map is an API boundary, not a security sandbox against reading installed private files or malicious host adapters.

```js
import { registerRuntime, initializeRuntime } from 'purgeon-core/runtime';
import { list } from 'purgeon-core/programs';
registerRuntime({ host: yourWindowsAdapter, confirm: yourExplicitApprovalUI });
await initializeRuntime();
const programs = await list('desktop');
```

See [examples/inspect.mjs](./examples/inspect.mjs). The host is supplied by the consumer; this package does not include a ready-made Node adapter or standalone native broker. Pure subpaths `winpath`, `contracts`, `confirmation-policy`, `portable-classification`, `lazy-module` and `cli-args` need no host or registration. `contracts.sha256` needs Web Crypto; Windows path helpers operate on strings, and portable classification is a heuristic.

## Runtime and host contract

One host/data identity per JavaScript realm using one canonical loaded package instance. Duplicate installations, alternate URLs and different versions do not share state. Registration validates minimal initialization methods and snapshots `host.info` without host calls or timers. It rejects replacement and conflicts with application ownership. There is no public reset. Runtime states are `unregistered`, `registered`, `initializing`, `ready`, `failed`; concurrent initialization shares a promise, and failed initialization cannot retry.

`host.info.dataDir` is the existing canonical data root. The contract in `src/internal/system-contracts.d.ts` documents the production adapter; each operation needs its transitive host methods listed in the inventory. Registration requires `makeDir`, `readDir`, `readText`, `writeTextAtomic`; initialization also requires settings reads (`readOptionalText`), metadata (`stat`) and logging (`appendText`). Other capabilities need Windows filesystem/registry/PowerShell, task, process, driver, backup, grant and prepared-operation methods. Dialog capabilities need injected `openDialog(options)` and `saveDialog(options)` hooks. Missing methods reject when used. A generic filesystem adapter cannot replace the native identity, authorization, grant, journal and recovery protocols. Windows app support remains x64-only; fake-host tests do not establish real Windows behavior.

Initialization explicitly creates data/feature roots, installs logging wrappers, prunes old command logs, restores configured preference sync and records profiling. Sync restoration may read/write its configured shared folder and settings. Imports and registration do not start those effects. Update-exit watching and DOM language application remain app-owned. App lifecycle operations remain internal; update installation still requires the existing verified native download/installer policy. Scheduling, plugins and sync can cause later effects according to their existing policies.

## Approval

`confirm(request)` must return literal `true`. Missing callbacks, denial and callback errors fail closed. Operation requests contain `{ kind: 'operation', channel, argument }`; existing inner confirmations use `{ kind: 'confirmation', options }`. Arguments accept plain cloneable data, copied before admission and copied separately for approval. Approval and the handler run inside the canonical mutation admission region. Overlapping admitted operations reject; mutations never retry. Existing inner confirmations, restore points, inventory freshness, native preparation, backups and recovery checks still apply.

Approval is conservative: queries may persist caches or migrate damaged/legacy settings, so all operations require approval except static language/profile/damage reads, reviewed security-software inventory/preparation/status, and explicit cancellation controls. Even host dialogs/opening operations require approval. Approval does not authorize bypassing an inner confirmation.

## Verification and limits

`purgeon-core/securitySoftware` exposes `list()`, `acknowledge({ reviewId, acknowledgment: 'reviewedUtilityClosed' })`, `prepare({ productId })`,
`launch({ planId })`, `cancel({ planId })`, and `status({ planId })` using the
five dedicated SystemAdapter methods. List, inert preparation, status and cancel
need no approval and remain available while launch awaits approval or executes.
Preparation neither downloads nor launches. Launch requires one explicit approval;
the consumer's confirmation must use the prepared product/tool names and explain
security removal, possible restart, and no Purgeon rollback. Launch never retries.
`reviewRequired` means the utility may have started: review status and vendor
windows. A launched utility does not establish removal completion or provide undo.
Native policy owns matching, downloads, verification, cancellation and replay
prevention; renderer URLs, paths, signer data and approval booleans are rejected.

`purgeon-core/measure` exports `onMeasured(listener)` after runtime initialization. It returns an unsubscribe function and rejects non-function listeners. Subscribe before calling `measure` or `measureStore`: these operations deliver individual result snapshots (including `key`, `folder` and `sizeKB` when measured) through listeners rather than their return values. Subscription itself needs no approval; measurement operations retain their approval policy.

`npm run test:package` packs the real artifact, installs it offline with scripts disabled into an independent temporary consumer, imports every supported subpath, checks every named operation before initialization and exercises fake-host settings, groups and dialog workflows plus denial, missing approval, failed initialization, ownership, serialization, tampering and no-retry cases. CI runs this check separately from the app regression suite. No new dependency is required.

The root application stays private. The library tarball is a separate development deliverable; the Windows release asset contract remains exactly `Purgeon-Setup-x64.exe` and `Purgeon-Portable-x64.zip`. Native extraction into standalone crates, whole-backend static typing, coverage certification, live installer validation and independent multi-runtime hosts are outside this slice.
