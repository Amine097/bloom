# Bloom

A study tracker for macOS: the current study week, lectures with spaced recalls, deadlines and a
to-do list. Everything is stored on the Mac it runs on.

- **Install:** download the `.dmg` from the [latest release](https://github.com/Amine097/bloom/releases/latest),
  open it and drag Bloom into Applications. The app is not signed with an Apple developer
  certificate, so the first launch needs *System Settings → Privacy & Security → Open Anyway*.
- **Updates:** Bloom checks for a new release when it starts and asks before installing it.
- **Develop:** `npm install`, then `npm run preview` and open http://localhost:4173. `npm test`
  runs the logic tests. See `CLAUDE.md` for the layout.
- **Release:** `git push origin main:deploy` publishes a new version.
