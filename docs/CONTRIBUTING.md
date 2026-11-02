# Contributing

Purgeon is kept by one maintainer, and small, finished contributions
are welcome through pull requests on GitHub.

## Set up

You need Node.js 20 or newer and the Rust toolchain.

```text
npm install
npm test         — run the test suite
npm run build    — build the window
```

For the Rust shell, run `cargo check` inside `src-tauri/`. The full
development notes live in [DEVELOPMENT.md](DEVELOPMENT.md).

## House rules

- **One job, one operation.** New abilities start as a backend operation
  in `src/backend/` that the window and the command line both call. If a
  job can be done in the window, it must work from the command line too.
- **Back up before it breaks.** Anything that deletes or changes
  something writes a backup first, or says plainly that it cannot.
- **Plain words in the window.** Messages say what happened and what to
  do next, without jargon.
- **Tests with the change.** Behaviour changes land with tests; the full
  suite and the production build must pass before a pull request is
  reviewed.
- **Docs with the change.** User-facing changes update
  [FEATURES.md](FEATURES.md) and the changelog's Unreleased section in
  the same pull request.

By contributing you agree your work is shared under the project's MIT
licence (see the `LICENSE` file at the repo root).
