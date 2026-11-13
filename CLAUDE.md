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

## Who does the work

The main session is the orchestrator and lead of this project, not necessarily the coder. The
goal is to spend fewer tokens without lowering the quality of the work. Pick by difficulty:

- **Easy** (a contained change with an obvious solution: copy, a style tweak, a small field, a
  rename, a simple test) → launch a **Sonnet** agent.
- **Medium** (a feature inside one view, a refactor of one module, a bug with a known cause) →
  launch an **Opus** agent.
- **Hard** (architecture, the data shape and migrations, recall scheduling, the native shell,
  the updater and release pipeline, anything spanning several modules, any bug whose cause is
  unknown) → the main session codes it itself.

How to delegate so it actually saves tokens:

- An agent starts with no memory of the conversation. Give it a brief that stands on its own:
  the goal, the exact files to touch, the conventions that apply, what "done" means, and what
  to report back (a short summary, not file dumps).
- If writing that brief would cost more than making the change, the main session makes the
  change. A one-line edit in a file already open is never delegated.
- The main session stays responsible for the result: it reviews the diff, runs `npm test`, and
  checks the screen when the change is visual, before telling the user it is done.
- Agents never commit, push or deploy. The main session does that.

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
- A lecture can carry one PDF: `item.pdf` is `{ id, name, size, addedAt }` or `null`. The file is
  Bloom's own copy, `pdfs/<id>.pdf` beside the data file (IndexedDB in the browser preview), all
  through `ui/js/files.js`. PDFs are not part of the daily backups or the exported backup copy.
- Slides (`.ppt`, `.pptx`, `.key`) are accepted wherever a PDF is and turned into one first:
  `convert_to_pdf` in the native shell drives Keynote through `osascript` (hence
  `NSAppleEventsUsageDescription` in `src-tauri/Info.plist` and the apple-events entitlement), and
  `POST /api/convert` of `scripts/preview.mjs` uses PowerPoint on Windows/WSL in the preview.
- "Attach slides" in Courses takes many files at once: matched to lectures by original file name
  (`LECTURE_FILES` in `seed.js`), then by title (`ui/js/attach-core.js`); unmatched files can
  become new lectures, in a new module if needed.
- The Notebook makes a study guide and a quiz from a lecture's PDF, kept in `D.notebook[itemId]`.
  It calls the Claude Code CLI installed on her Mac, with her own account, as a hidden background
  process: `ask_claude` in the native shell, `POST /api/ask` of `scripts/preview.mjs` in the
  browser preview. Prompts and answer checking are in `ui/js/notebook-core.js`.
- A lecture's quiz is a question bank (at most 60), not a fixed set: each question has an `id`, a
  `level` (recall / understanding / application) and its own history (`seen`, `right`, `lastSeen`,
  `lastRight`); the quiz also keeps `best` and the last 10 `sessions`. The full shape is at the
  top of the quiz section of `notebook-core.js`. A session draws a few questions (never asked and
  missed last time first) and shuffles their options; the stored option order never changes.
- A notebook entry may also hold `cards` (flashcards, shape at the top of `ui/js/cards-core.js`)
  and `chat` (the Ask tab, `ui/js/chat-core.js`).
- The Planner asks the assistant once a week for a tickable list of goals, each linked to a
  lecture, recall, deadline or to-do; kept in `D.planner` (shape at the top of `ui/js/planner-core.js`).
- Assistants: Claude Code first; Codex (OpenAI's CLI, her ChatGPT account) is the backup while
  Claude's usage limit lasts or when Claude is not set up (`ui/js/assistant-core.js`). The native
  shell has the same commands for both (`ask_*`, `*_status`, `*_install`, `*_login`, ...).
