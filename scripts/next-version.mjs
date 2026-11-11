// Works out the version and the notes of the next release. Used by the deploy workflow.
//
//   node scripts/next-version.mjs           print what the next release would be
//   node scripts/next-version.mjs --apply   also write the version into the three files that carry it
//
// Version: one patch step above the latest v* tag (0.1.4 -> 0.1.5). To jump further, set a higher
// "version" in package.json and that one is used instead.
// Notes (shown to her in the "update ready" dialog): release-notes.md when it was edited since the
// last release, otherwise the commit subjects since then.
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const parts = v => v.split(".").map(Number);
const newer = (a, b) => { // is a > b ?
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};

const latest = git("tag", "--list", "v*", "--sort=-v:refname").split("\n")[0].replace(/^v/, "") || null;
const declared = JSON.parse(readFileSync("package.json", "utf8")).version;
let version = declared;
if (latest && !newer(declared, latest)) {
  const [a, b, c] = parts(latest);
  version = `${a}.${b}.${c + 1}`;
}

const written = readFileSync("release-notes.md", "utf8").trim();
const notesEdited = !latest || git("diff", "--name-only", `v${latest}`, "HEAD", "--", "release-notes.md") !== "";
const commits = latest ? git("log", "--no-merges", "--format=• %s", `v${latest}..HEAD`) : "";
const notes = notesEdited ? written : commits || "Small improvements.";

console.log(`latest release: ${latest ?? "none"}\nnext version:   ${version}\nnotes:\n${notes}`);

if (process.argv.includes("--apply")) {
  const set = (file, pattern, replacement) => {
    const text = readFileSync(file, "utf8");
    if (!pattern.test(text)) throw new Error(`no version found in ${file}`);
    writeFileSync(file, text.replace(pattern, replacement));
  };
  set("package.json", /"version": "[^"]+"/, `"version": "${version}"`);
  set("src-tauri/tauri.conf.json", /"version": "[^"]+"/, `"version": "${version}"`);
  set("src-tauri/Cargo.toml", /^version = "[^"]+"/m, `version = "${version}"`);
}

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\nnotes<<BLOOM_NOTES_EOF\n${notes}\nBLOOM_NOTES_EOF\n`);
}
