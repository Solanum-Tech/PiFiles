## What changes

<!-- One or two sentences. Link the issue if there is one: Fixes #123 -->

## How it was tested

- [ ] `cargo test --lib` passes (CI runs it too)
- [ ] Tried in the app (`cargo tauri dev`) - which screens / files:
- [ ] Installer from the **Dev build** check works (download it from the PR's Checks tab), if packaging changed

## Security checklist (tick what applies)

- [ ] No data (file names, file contents, pack contents) goes into `innerHTML` without `esc()`, and nothing goes into event-handler attributes or `javascript:` URLs
- [ ] New backend commands are only exposed to the windows that need them (capabilities)
- [ ] Anything irreversible or that starts a program is confirmed in `security.rs` (native dialog), not only in the page
- [ ] No new network access; no secrets or personal paths committed
