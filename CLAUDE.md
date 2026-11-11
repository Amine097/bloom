# Bloom

Study tracker for Sarra (MSc Biomedical Sciences, Bern). macOS app (Apple Silicon), built with
Tauri 2. Public repo: `Amine097/bloom`.

## Rules

- **No co-author line anywhere.** Never add `Co-Authored-By`, "Generated with Claude Code", or any
  other AI attribution to commits, tags, pull requests, release notes, code comments or docs.
- Her data never goes in this repo. It lives on her Mac in the app data folder
  (`~/Library/Application Support/com.amine097.bloom/`). Nothing personal is committed.
- Updates must never touch or reset her data. Any change to the data shape goes through a
  migration in `ui/js/store.js` (`migrate`), with the `version` field bumped.
- The UI is in English.

## Layout

- `ui/` — the whole interface: plain HTML/CSS/ES modules, no build step, no npm dependencies.
  It also runs in a normal browser (data then goes to `localStorage`), which is how it is
  developed on Windows: `npm run preview`, then open http://localhost:4173.
- `src-tauri/` — the native shell: loads/saves the data file, daily backups, updater.
  Rust is not installed on the Windows dev machine; the shell is compiled by GitHub Actions.
- `tests/` — `npm test` (Node's built-in runner) covers the pure logic: recall scheduling,
  week maths, quick-add parsing.
- `.github/workflows/build.yml` — tests and builds every push to `main`; a push to `deploy` also
  publishes a release (`.dmg` + updater files) that installed copies pick up at launch.

## Releasing an update

Pushing to the `deploy` branch publishes a release; nothing else is needed:

    git push origin main:deploy

The workflow tests, builds, tags and publishes. The version is one patch step above the latest
`v*` tag (`scripts/next-version.mjs`; run it without arguments to preview). For a bigger jump, set
a higher `"version"` in `package.json` first. The version files in the repo are only rewritten
inside the build, so they can lag behind the tags; the tags are the source of truth.

The notes she sees in the "update ready" dialog are `release-notes.md` if it was edited since the
last release, otherwise the commit subjects since then, so write those in plain words. The app
only installs after she agrees.

The updater signing key is in `~/.tauri/bloom.key` (never commit it) and in the repo secret
`TAURI_SIGNING_PRIVATE_KEY`. Losing it means installed copies can no longer update.

## Domain

- Weeks: W1 starts Monday 14 Sept 2026 (`settings.semesterStart`).
- A lecture has five states: to do, seen, quizzed, recall 1, recall 2. "Quizzed" is optional.
  Recall 1 is due 7 days after "seen"; recall 2 is due 14 days after recall 1 was done.
  Both shrink when the module's exam is close (`ui/js/recall.js`).
- Recalls and deadlines do not appear in the To-do view.
- Planner and Notebook are placeholders. They will call the Claude Code CLI installed on her Mac,
  with her own account, as a hidden background process.
