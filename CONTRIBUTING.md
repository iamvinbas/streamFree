# Contributing to streamFree

Thank you for helping. streamFree is a Rust core (`src/`) plus a plain
HTML/CSS/JavaScript studio (`web/`) embedded into one binary.

## Set up

```sh
git clone https://github.com/iamvinbas/streamFree && cd streamFree
cargo run -- --app          # the desktop app (macOS/Windows), or `cargo run` for a browser tab
```

Debug builds read `web/` from disk, so studio changes need only a page reload.

## Before a pull request

```sh
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test                                   # includes FFmpeg-oracle tests if ffmpeg is installed
cd tests/e2e && npm install && npm test      # browser tests, needs Google Chrome and ffmpeg
```

- Interface text goes through `t('…')`. Add an Italian entry in
  `web/js/i18n.js`: a test fails when a string has no translation.
- Keep stream keys out of logs, screenshots and issues.
- Describe what you verified, and how, in the pull request.

## Good places to start

- Test on **Windows** or with a **real stream key**, and report what happens.
- Translations into more languages (`web/js/i18n.js`).
- Planned features in [docs/feature-spec.md](docs/feature-spec.md): scenes,
  vertical output, YouTube chat, per-guest recordings, background blur.
