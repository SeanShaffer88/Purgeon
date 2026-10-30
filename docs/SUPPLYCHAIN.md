# Action reference provenance

The release workflow pins each external action to the commit resolved from its existing reference on 2026-10-29. Inline comments preserve the original reference. This freezes the action source selected by that reference; it does not freeze the Rust `stable` toolchain, Node version selectors, runner images, action downloads, or other transitive inputs.

Resolution used read-only Git transport after targeted metadata discovery found no dedicated read-ref or read-tag tool. The connector's generic `github_fetch` can also read approved Git data/ref/tag URLs; it was not invoked for these lookups. Tags take precedence over branches. Each lookup requested the exact tag, its peeled target, and the exact branch:

```powershell
git ls-remote 'https://github.com/OWNER/REPOSITORY.git' 'refs/tags/REF' 'refs/tags/REF^{}' 'refs/heads/REF'
```

All nine individual lookups returned exit code **0**. The encompassing PowerShell command also returned **0**. The discovery command reading git status and the workflow returned **0**. Connector metadata discovery exposes no process exit code. No configured references were missing, substituted, or downgraded.

Exact queries (each exit **0**):

```powershell
git ls-remote 'https://github.com/actions/checkout.git' 'refs/tags/v4' 'refs/tags/v4^{}' 'refs/heads/v4'
git ls-remote 'https://github.com/actions/checkout.git' 'refs/tags/v7' 'refs/tags/v7^{}' 'refs/heads/v7'
git ls-remote 'https://github.com/actions/setup-node.git' 'refs/tags/v4' 'refs/tags/v4^{}' 'refs/heads/v4'
git ls-remote 'https://github.com/actions/setup-node.git' 'refs/tags/v7' 'refs/tags/v7^{}' 'refs/heads/v7'
git ls-remote 'https://github.com/dtolnay/rust-toolchain.git' 'refs/tags/stable' 'refs/tags/stable^{}' 'refs/heads/stable'
git ls-remote 'https://github.com/Swatinem/rust-cache.git' 'refs/tags/v2' 'refs/tags/v2^{}' 'refs/heads/v2'
git ls-remote 'https://github.com/actions/upload-artifact.git' 'refs/tags/v7' 'refs/tags/v7^{}' 'refs/heads/v7'
git ls-remote 'https://github.com/actions/download-artifact.git' 'refs/tags/v8' 'refs/tags/v8^{}' 'refs/heads/v8'
git ls-remote 'https://github.com/softprops/action-gh-release.git' 'refs/tags/v2' 'refs/tags/v2^{}' 'refs/heads/v2'
```

| Original reference and source | Resolved commit | Resolution |
| --- | --- | --- |
| [actions/checkout@v4](https://github.com/actions/checkout/tree/v4) | `11d5960a326750d5838078e36cf38b85af677262` | Tag |
| [actions/checkout@v7](https://github.com/actions/checkout/tree/v7) | `3d3c42e5aac5ba805825da76410c181273ba90b1` | Tag |
| [actions/setup-node@v4](https://github.com/actions/setup-node/tree/v4) | `49933ea5288caeca8642d1e84afbd3f7d6820020` | Tag |
| [actions/setup-node@v7](https://github.com/actions/setup-node/tree/v7) | `949feb2413d6458794dcd2491c4babbbce0c15c1` | Tag |
| [dtolnay/rust-toolchain@stable](https://github.com/dtolnay/rust-toolchain/tree/stable) | `b725eda525362e7cf34af9a7243cac1e3f01a7ec` | Branch; no matching tag returned |
| [Swatinem/rust-cache@v2](https://github.com/Swatinem/rust-cache/tree/v2) | `d1527c8f67ef9af357290475d4af4b0fab8f12e0` | Annotated tag `e9d7b9f1e587218970671bac74e5511ed9506e6a`, peeled by Git to the final commit |
| [actions/upload-artifact@v7](https://github.com/actions/upload-artifact/tree/v7) | `cf430e030ddbb5b0abf93d22962f4752f3646cd9` | Tag |
| [actions/download-artifact@v8](https://github.com/actions/download-artifact/tree/v8) | `9000827ccba6bdab643e8b6fd33ac0654aef8333` | Tag |
| [softprops/action-gh-release@v2](https://github.com/softprops/action-gh-release/tree/v2) | `3bb12739c298aeb8a4eeaf626c5b8d85266b0e65` | Tag |

Only action `uses` references and their comments were changed in `.github/workflows/release.yml`. Existing triggers, permissions, job dependencies, static gates, signing environment variables, package commands, verification, and publication behavior were preserved. The local workflow edit command returned **0**; this document was created with `apply_patch`, which provides no process exit code.

This is reference-pinning provenance, not a complete supply-chain security audit, an SBOM, or evidence of a successful workflow. No tests, build, lint, typecheck, distribution, app launch, or penetration probes were run for this change, as instructed. No remote writes, tags, or releases were created. Before accepting future updates, resolve the intended upstream reference again, review the source change, and run the applicable gates when authorized. Tags and releases require explicit user approval at beta testing; alpha publication is not authorized.
