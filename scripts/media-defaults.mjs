// Writes ui/js/media-defaults.js, the connection to her Jellyfin and Jellyseerr built into the app
// so the Movies page connects by itself. Run by the build with the repo secret BLOOM_MEDIA, JSON:
//   { "jellyfin": "http://<tailscale ip>:8096", "seerr": "http://<tailscale ip>:5055", "user": "<her username>" }
// The file is ignored by git: the addresses and her username never go in this public repo.
// Without BLOOM_MEDIA the file is removed and the page asks for the connection instead.
import { writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readBuiltIn, looseObject } from "../ui/js/media-core.js";

const out = fileURLToPath(new URL("../ui/js/media-defaults.js", import.meta.url));
const raw = process.env.BLOOM_MEDIA || "";
const conn = raw.trim() ? readBuiltIn(raw) : null;
if (raw.trim() && !conn) {
  // says what is wrong without printing the value
  const keys = Object.keys(looseObject(raw) || {});
  console.error(`BLOOM_MEDIA is set (${raw.trim().length} characters) but cannot be read: ${keys.length ? `found ${keys.join(", ")}; jellyfin and user are needed` : "it is neither JSON nor key=value lines"}.`);
  console.error('Expected: {"jellyfin":"http://<ip>:8096","seerr":"http://<ip>:5055","user":"<username>"}');
  process.exit(1);
}
if (!conn) {
  rmSync(out, { force: true });
  console.log("No built-in media connection (BLOOM_MEDIA is empty).");
} else {
  writeFileSync(out, `// Written by scripts/media-defaults.mjs at build time. Not in git.\nexport default ${JSON.stringify(conn)};\n`);
  console.log("Built-in media connection written.");
}
