//! Native shell for Bloom. The interface (ui/) does all the work; this side only owns the data
//! file (load, atomic save, one backup per day, export to the Downloads folder), the lecture
//! PDFs stored beside it in `pdfs/`, turning slides into PDFs with Keynote, and running the
//! assistants' CLIs: Claude Code, and Codex as its backup (install, sign-in, asking).

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

const DATA: &str = "bloom_data.json";
const KEEP_BACKUPS: usize = 14;

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// `day` comes from the interface and becomes part of a file name, so it must be a plain date.
fn is_day(day: &str) -> bool {
    day.len() == 10 && day.chars().all(|c| c.is_ascii_digit() || c == '-')
}

/// Before the first save of a day, keep yesterday's state as `backups/<day>.json`.
fn backup_once_per_day(dir: &PathBuf, day: &str) -> Result<(), String> {
    let current = dir.join(DATA);
    if !current.exists() {
        return Ok(());
    }
    let backups = dir.join("backups");
    fs::create_dir_all(&backups).map_err(|e| e.to_string())?;
    let target = backups.join(format!("{day}.json"));
    if target.exists() {
        return Ok(());
    }
    fs::copy(&current, &target).map_err(|e| e.to_string())?;

    let mut names: Vec<PathBuf> = fs::read_dir(&backups)
        .map_err(|e| e.to_string())?
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        .filter(|p| p.extension().map(|x| x == "json").unwrap_or(false))
        .collect();
    names.sort();
    while names.len() > KEEP_BACKUPS {
        let _ = fs::remove_file(names.remove(0));
    }
    Ok(())
}

#[tauri::command]
fn load_data(app: AppHandle) -> Result<Option<String>, String> {
    let file = data_dir(&app)?.join(DATA);
    if !file.exists() {
        return Ok(None);
    }
    fs::read_to_string(&file).map(Some).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_data(app: AppHandle, text: String, day: String) -> Result<(), String> {
    serde_json::from_str::<serde_json::Value>(&text).map_err(|e| format!("invalid data: {e}"))?;
    if !is_day(&day) {
        return Err("invalid day".into());
    }
    let dir = data_dir(&app)?;
    backup_once_per_day(&dir, &day)?;
    let tmp = dir.join(format!("{DATA}.tmp"));
    fs::write(&tmp, text).map_err(|e| e.to_string())?;
    fs::rename(&tmp, dir.join(DATA)).map_err(|e| e.to_string())
}

/// Writes a copy of the data to the Downloads folder and returns its path.
#[tauri::command]
fn export_data(app: AppHandle, text: String, day: String) -> Result<String, String> {
    serde_json::from_str::<serde_json::Value>(&text).map_err(|e| format!("invalid data: {e}"))?;
    if !is_day(&day) {
        return Err("invalid day".into());
    }
    let dir = app.path().download_dir().map_err(|e| e.to_string())?;
    let file = dir.join(format!("Bloom-backup-{day}.json"));
    fs::write(&file, text).map_err(|e| e.to_string())?;
    Ok(file.to_string_lossy().into_owned())
}

/// Where the PDF with this id lives. The id comes from the interface and becomes a file name,
/// so it must be plain letters and digits.
fn pdf_path(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    if id.is_empty() || id.len() > 40 || !id.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err("invalid file id".into());
    }
    let dir = data_dir(app)?.join("pdfs");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(format!("{id}.pdf")))
}

/// Stores a lecture PDF. The bytes are the raw request body; the id is in the `x-pdf-id` header.
#[tauri::command]
fn save_pdf(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected the file bytes".into());
    };
    let id = request
        .headers()
        .get("x-pdf-id")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| "missing file id".to_string())?;
    let head = &bytes[..bytes.len().min(1024)];
    if !head.windows(5).any(|w| w == b"%PDF-") {
        return Err("not a PDF".into());
    }
    let file = pdf_path(&app, id)?;
    let tmp = file.with_extension("tmp");
    fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &file).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_pdf(app: AppHandle, id: String) -> Result<tauri::ipc::Response, String> {
    let bytes = fs::read(pdf_path(&app, &id)?).map_err(|e| e.to_string())?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
fn delete_pdf(app: AppHandle, id: String) -> Result<(), String> {
    let file = pdf_path(&app, &id)?;
    if file.exists() {
        fs::remove_file(&file).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ---- the Notebook: asking Claude Code about a lecture PDF

/// Same flags as CLAUDE_ARGS in ui/js/notebook-core.js (used by the browser preview).
const CLAUDE_ARGS: [&str; 9] = [
    "-p",
    "--output-format",
    "json",
    "--no-session-persistence",
    "--strict-mcp-config", // her own MCP servers are not needed, and would only slow the start
    "--allowedTools",
    "Read",
    "--max-turns",
    "8",
];
const CLAUDE_TIMEOUT: Duration = Duration::from_secs(5 * 60);

/// Runs `cmd` with `input` on stdin. Returns None when it ran past `timeout` (it is then killed).
/// stdout and stderr are read on their own threads so a large output cannot block the child.
fn run_with_timeout(
    cmd: Command,
    input: &[u8],
    timeout: Duration,
) -> Result<Option<(ExitStatus, Vec<u8>, Vec<u8>)>, std::io::Error> {
    run_tracked(cmd, input, timeout, None)
}

/// `run_with_timeout`, which also keeps the child's pid in `pid_slot` once it has started, so it
/// can be stopped from elsewhere. The caller clears the slot afterwards.
fn run_tracked(
    mut cmd: Command,
    input: &[u8],
    timeout: Duration,
    pid_slot: Option<&Mutex<Option<u32>>>,
) -> Result<Option<(ExitStatus, Vec<u8>, Vec<u8>)>, std::io::Error> {
    let mut child = cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    if let Some(slot) = pid_slot {
        if let Ok(mut pid) = slot.lock() {
            *pid = Some(child.id());
        }
    }
    let mut out_pipe = child.stdout.take();
    let mut err_pipe = child.stderr.take();
    let out_reader = thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(pipe) = out_pipe.as_mut() {
            let _ = pipe.read_to_end(&mut buf);
        }
        buf
    });
    let err_reader = thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(pipe) = err_pipe.as_mut() {
            let _ = pipe.read_to_end(&mut buf);
        }
        buf
    });
    // A tracked process (the sign-in) keeps its stdin open until it ends, so it waits for the
    // browser instead of reading an empty answer. Otherwise stdin is closed once the input is
    // written, so the CLI knows the prompt is complete.
    let mut held_stdin: Option<std::process::ChildStdin> = None;
    if let Some(mut stdin) = child.stdin.take() {
        // a write error shows up as a failed run below
        let _ = stdin.write_all(input);
        if pid_slot.is_some() {
            held_stdin = Some(stdin);
        }
    }

    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if started.elapsed() > timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Ok(None);
        }
        thread::sleep(Duration::from_millis(250));
    };
    drop(held_stdin);
    let out = out_reader.join().unwrap_or_default();
    let err = err_reader.join().unwrap_or_default();
    Ok(Some((status, out, err)))
}

/// A GUI app does not get the shell PATH, so look where the installers put `claude`, then ask a
/// login shell as a last resort.
fn find_claude() -> Option<PathBuf> {
    let mut places: Vec<PathBuf> = Vec::new();
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        places.push(home.join(".local/bin/claude"));
        places.push(home.join(".claude/local/claude"));
    }
    places.push(PathBuf::from("/opt/homebrew/bin/claude"));
    places.push(PathBuf::from("/usr/local/bin/claude"));
    for place in places {
        if place.is_file() {
            return Some(place);
        }
    }
    find_in_login_shell("claude")
}

/// Asks a login shell where `name` is (it sees her PATH). `name` is one of ours, never hers.
fn find_in_login_shell(name: &str) -> Option<PathBuf> {
    let mut shell = Command::new("/bin/zsh");
    let script = format!("command -v {name}");
    shell.args(["-lc", script.as_str()]);
    let (status, out, _) = run_with_timeout(shell, b"", Duration::from_secs(10)).ok()??;
    if !status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out).into_owned();
    let line = text.lines().last().unwrap_or("").trim().to_string();
    // `command -v` prints a path for a program, but only a name for an alias or a function
    let found = PathBuf::from(line);
    if found.is_absolute() && found.is_file() {
        Some(found)
    } else {
        None
    }
}

/// PATH for the CLI: its own folder first (an npm install needs `node` from there), then the
/// usual places, then whatever the app was given.
fn child_path(bin: &Path) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(dir) = bin.parent() {
        parts.push(dir.to_string_lossy().into_owned());
    }
    for dir in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"] {
        parts.push(dir.to_string());
    }
    if let Ok(existing) = std::env::var("PATH") {
        if !existing.is_empty() {
            parts.push(existing);
        }
    }
    parts.join(":")
}

/// Reads the JSON envelope printed by `claude -p --output-format json` (see readEnvelope in
/// ui/js/notebook-core.js, which does the same for the preview).
fn read_envelope(status: ExitStatus, out: &[u8], err: &[u8]) -> Result<String, String> {
    let text = String::from_utf8_lossy(out).into_owned();
    let mut envelope: Option<serde_json::Value> = serde_json::from_str::<serde_json::Value>(text.trim())
        .ok()
        .filter(|v| v.is_object());
    if envelope.is_none() {
        for line in text.lines().rev() {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(line.trim()) {
                if v.is_object() {
                    envelope = Some(v);
                    break;
                }
            }
        }
    }
    let Some(env) = envelope else {
        let err_text = String::from_utf8_lossy(err).into_owned();
        let tail: Vec<&str> = err_text.lines().rev().take(3).collect();
        let mut detail: String = tail.into_iter().rev().collect::<Vec<&str>>().join(" ");
        let cut = detail.char_indices().nth(300).map(|(i, _)| i).unwrap_or(detail.len());
        detail.truncate(cut);
        let code = status.code().map(|c| format!(" (exit code {c})")).unwrap_or_default();
        return Err(format!("Claude Code did not answer{code}. {detail}").trim().to_string());
    };
    let result = env
        .get("result")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let is_error = env.get("is_error").and_then(|v| v.as_bool()).unwrap_or(false);
    if is_error || !status.success() {
        let subtype = env.get("subtype").and_then(|v| v.as_str()).unwrap_or("");
        if subtype == "error_max_turns" {
            return Err("Claude needed more steps than allowed (the PDF may be very long). Try again.".into());
        }
        let detail = if !result.is_empty() {
            result
        } else if !subtype.is_empty() {
            subtype.to_string()
        } else {
            "unknown error".to_string()
        };
        return Err(format!("Claude Code: {detail}"));
    }
    if result.is_empty() {
        return Err("Claude's answer was empty. Try again.".into());
    }
    Ok(result)
}

// ---- turning slides (PowerPoint, Keynote) into a PDF, with Keynote

const SLIDE_TYPES: [&str; 3] = ["ppt", "pptx", "key"];
const CONVERT_TIMEOUT: Duration = Duration::from_secs(4 * 60);

/// Opens the slides in Keynote and exports them as a PDF. The two paths are arguments, never
/// part of the script. Keynote is quit afterwards only if it was not open before.
const KEYNOTE_EXPORT: &str = r#"on run argv
	set inFile to POSIX file (item 1 of argv)
	set outFile to POSIX file (item 2 of argv)
	set wasRunning to application id "com.apple.iWork.Keynote" is running
	tell application id "com.apple.iWork.Keynote"
		set doc to open inFile
		try
			export doc to outFile as PDF
		on error msg number n
			close doc saving no
			if not wasRunning then quit
			error msg number n
		end try
		close doc saving no
		if not wasRunning then quit
	end tell
end run"#;

/// Whether Keynote is installed. Checked first: a script naming a missing app would make macOS
/// ask her where it is.
fn keynote_installed() -> bool {
    let mut places = vec![PathBuf::from("/Applications/Keynote.app")];
    if let Some(home) = std::env::var_os("HOME") {
        places.push(PathBuf::from(home).join("Applications/Keynote.app"));
    }
    if places.iter().any(|p| p.is_dir()) {
        return true;
    }
    Command::new("/usr/bin/mdfind")
        .arg("kMDItemCFBundleIdentifier == 'com.apple.iWork.Keynote'")
        .output()
        .map(|o| !String::from_utf8_lossy(&o.stdout).trim().is_empty())
        .unwrap_or(false)
}

fn is_pdf(bytes: &[u8]) -> bool {
    bytes[..bytes.len().min(1024)].windows(5).any(|w| w == b"%PDF-")
}

/// Converts the slides in `dir` (a fresh folder, removed by the caller) and returns the PDF.
fn keynote_to_pdf(dir: &Path, ext: &str, bytes: &[u8]) -> Result<Vec<u8>, String> {
    if !keynote_installed() {
        return Err("Bloom uses Keynote to turn slides into a PDF, and Keynote is not on this Mac. Install it (free, from the App Store), or save the slides as a PDF from PowerPoint.".into());
    }
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let input = dir.join(format!("slides.{ext}"));
    let output = dir.join("slides.pdf");
    fs::write(&input, bytes).map_err(|e| e.to_string())?;
    // an existing target file is easier for Keynote (a sandboxed app) to write to
    fs::write(&output, b"").map_err(|e| e.to_string())?;
    let script = dir.join("export.applescript");
    fs::write(&script, KEYNOTE_EXPORT).map_err(|e| e.to_string())?;
    let mut cmd = Command::new("/usr/bin/osascript");
    cmd.arg(&script).arg(&input).arg(&output);
    match run_with_timeout(cmd, b"", CONVERT_TIMEOUT) {
        Err(e) => Err(format!("Could not start Keynote: {e}")),
        Ok(None) => Err("Keynote took longer than 4 minutes and was stopped. Save the slides as a PDF from PowerPoint instead.".into()),
        Ok(Some((status, _out, err))) => {
            let pdf = fs::read(&output).unwrap_or_default();
            if status.success() && is_pdf(&pdf) {
                return Ok(pdf);
            }
            let detail = tail_text(&err, 200);
            if detail.contains("-1743") {
                return Err("Bloom is not allowed to use Keynote. Allow it in System Settings → Privacy & Security → Automation → Bloom, then try again.".into());
            }
            if detail.is_empty() {
                Err("Keynote could not turn this file into a PDF. Save the slides as a PDF from PowerPoint instead.".into())
            } else {
                Err(format!("Keynote could not turn this file into a PDF ({detail}). Save the slides as a PDF from PowerPoint instead."))
            }
        }
    }
}

/// Turns slides into a PDF with Keynote and returns the PDF's bytes. The slides are the raw
/// request body; their type (ppt, pptx or key) is in the `x-file-ext` header.
#[tauri::command]
async fn convert_to_pdf(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<tauri::ipc::Response, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected the file bytes".into());
    };
    let ext = request
        .headers()
        .get("x-file-ext")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !SLIDE_TYPES.contains(&ext.as_str()) {
        return Err("Bloom can turn PowerPoint (.ppt, .pptx) and Keynote files into a PDF, not this kind of file.".into());
    }
    let bytes = bytes.to_vec();
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let dir = data_dir(&app)?.join("convert").join(stamp.to_string());
    tauri::async_runtime::spawn_blocking(move || {
        let result = keynote_to_pdf(&dir, &ext, &bytes);
        let _ = fs::remove_dir_all(&dir);
        result.map(tauri::ipc::Response::new)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Runs Claude Code, on one lecture PDF when `pdf_id` is given: `prompt` then holds `{{PDF}}`,
/// replaced here by the PDF's absolute path. Without a PDF the prompt is sent as it is, from an
/// empty temporary folder. Returns Claude's final text, or an error she can read; "no-claude"
/// means the CLI could not be found.
#[tauri::command]
async fn ask_claude(app: AppHandle, pdf_id: Option<String>, prompt: String) -> Result<String, String> {
    let (dir, prompt) = ask_place(&app, pdf_id, prompt)?;
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let bin = find_claude().ok_or_else(|| "no-claude".to_string())?;
        let mut cmd = Command::new(&bin);
        cmd.args(CLAUDE_ARGS)
            .current_dir(&dir)
            .env("PATH", child_path(&bin));
        match run_with_timeout(cmd, prompt.as_bytes(), CLAUDE_TIMEOUT) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err("no-claude".into()),
            Err(e) => Err(format!("Could not start Claude Code: {e}")),
            Ok(None) => Err("Claude took longer than 5 minutes and was stopped. Try again.".into()),
            Ok(Some((status, out, err))) => read_envelope(status, &out, &err),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Where an assistant runs, and its prompt: beside the lecture PDF, with `{{PDF}}` replaced by the
/// PDF's absolute path, or, without a PDF, in an empty temporary folder.
fn ask_place(app: &AppHandle, pdf_id: Option<String>, prompt: String) -> Result<(PathBuf, String), String> {
    Ok(match pdf_id {
        Some(id) => {
            let file = pdf_path(app, &id)?;
            if !file.is_file() {
                return Err("The PDF of this lecture is missing. Attach it again from Courses.".into());
            }
            let dir = match file.parent() {
                Some(d) => d.to_path_buf(),
                None => return Err("invalid file path".into()),
            };
            (dir, prompt.replace("{{PDF}}", &file.to_string_lossy()))
        }
        None => {
            // nothing of hers to read: the assistant starts in a folder that holds no file
            let dir = std::env::temp_dir().join("bloom-ask");
            fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            (dir, prompt)
        }
    })
}

// ---- setting up Claude Code from Settings: install, sign in, status

const STATUS_TIMEOUT: Duration = Duration::from_secs(15);
const INSTALL_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const LOGIN_TIMEOUT: Duration = Duration::from_secs(5 * 60);

/// The pid of the running `claude auth login`, so the sign-in can be cancelled.
static LOGIN_PID: Mutex<Option<u32>> = Mutex::new(None);

/// Drops terminal colour codes (ESC ... letter) from a process's output.
fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            for d in chars.by_ref() {
                if d.is_ascii_alphabetic() {
                    break;
                }
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// The last few lines of a process's output, at most `max` characters, for an error message.
fn tail_text(bytes: &[u8], max: usize) -> String {
    let text = strip_ansi(&String::from_utf8_lossy(bytes));
    let lines: Vec<&str> = text.lines().map(|l| l.trim()).filter(|l| !l.is_empty()).collect();
    let start = lines.len().saturating_sub(3);
    let detail = lines[start..].join(" ");
    let count = detail.chars().count();
    if count > max {
        // keep the end, where the reason usually is
        detail.chars().skip(count - max).collect()
    } else {
        detail
    }
}

/// Reads what `claude auth status` printed. Anything that is not its JSON counts as signed out.
fn read_auth_status(out: &[u8]) -> serde_json::Value {
    let text = String::from_utf8_lossy(out).into_owned();
    let parsed: serde_json::Value = serde_json::from_str::<serde_json::Value>(text.trim())
        .ok()
        .filter(|v| v.is_object())
        .unwrap_or(serde_json::Value::Null);
    let logged_in = parsed.get("loggedIn").and_then(|v| v.as_bool()).unwrap_or(false);
    let email: Option<String> = parsed.get("email").and_then(|v| v.as_str()).map(|s| s.to_string());
    let plan: Option<String> = parsed
        .get("subscriptionType")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    serde_json::json!({
        "installed": true,
        "loggedIn": logged_in,
        "email": email,
        "plan": plan
    })
}

/// `{"installed": false}`, or `{"installed": true, "loggedIn", "email", "plan"}`.
#[tauri::command]
async fn claude_status() -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<serde_json::Value, String> {
        let Some(bin) = find_claude() else {
            return Ok(serde_json::json!({ "installed": false }));
        };
        let mut cmd = Command::new(&bin);
        cmd.args(["auth", "status"]).env("PATH", child_path(&bin));
        // signed out may end with a non-zero exit code, so only the printed JSON counts
        match run_with_timeout(cmd, b"", STATUS_TIMEOUT) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(serde_json::json!({ "installed": false })),
            Err(e) => Err(format!("Could not start Claude Code: {e}")),
            Ok(None) => Err("Claude Code did not answer in time. Try again.".into()),
            Ok(Some((_status, out, _err))) => Ok(read_auth_status(&out)),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Installs Claude Code with Anthropic's official installer (into ~/.local/bin).
#[tauri::command]
async fn claude_install() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let mut cmd = Command::new("/bin/bash");
        cmd.args(["-lc", "curl -fsSL https://claude.ai/install.sh | bash"])
            .env("PATH", child_path(Path::new("/bin/bash")));
        match run_with_timeout(cmd, b"", INSTALL_TIMEOUT) {
            Err(e) => Err(format!("Could not start the installer: {e}")),
            Ok(None) => Err("The installation took longer than 10 minutes and was stopped. Check the internet connection and try again.".into()),
            Ok(Some((status, out, err))) => {
                if status.success() && find_claude().is_some() {
                    return Ok(());
                }
                let mut detail = tail_text(&err, 300);
                if detail.is_empty() {
                    detail = tail_text(&out, 300);
                }
                let code = status.code().map(|c| format!(" (exit code {c})")).unwrap_or_default();
                Err(format!("Claude could not be installed{code}. {detail}").trim().to_string())
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Signs in with her Claude subscription: the CLI opens the browser and waits for it.
#[tauri::command]
async fn claude_login() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let bin = find_claude().ok_or_else(|| "no-claude".to_string())?;
        let mut cmd = Command::new(&bin);
        cmd.args(["auth", "login", "--claudeai"]).env("PATH", child_path(&bin));
        let result = run_tracked(cmd, b"", LOGIN_TIMEOUT, Some(&LOGIN_PID));
        if let Ok(mut pid) = LOGIN_PID.lock() {
            *pid = None;
        }
        match result {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err("no-claude".into()),
            Err(e) => Err(format!("Could not start the sign-in: {e}")),
            Ok(None) => Err("The sign-in was not finished within 5 minutes and was stopped. Try again.".into()),
            Ok(Some((status, out, err))) => {
                if status.success() {
                    return Ok(());
                }
                let mut detail = tail_text(&err, 300);
                if detail.is_empty() {
                    detail = tail_text(&out, 300);
                }
                Err(format!("The sign-in did not finish. {detail}").trim().to_string())
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Stops the process kept in `slot` (a running sign-in). Does nothing when none is running.
async fn stop_tracked(slot: &'static Mutex<Option<u32>>) -> Result<(), String> {
    let pid: Option<u32> = match slot.lock() {
        Ok(guard) => *guard,
        Err(_) => None,
    };
    if let Some(pid) = pid {
        tauri::async_runtime::spawn_blocking(move || {
            let _ = Command::new("/bin/kill").arg(pid.to_string()).status();
        })
        .await
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// The fallback sign-in: a small script opened in Terminal, which runs `bin` with `args` (plain
/// words of ours). `name` names the script file.
fn sign_in_with_terminal(bin: &Path, args: &str, name: &str) -> Result<(), String> {
    // single-quoted for the shell, with any ' inside written as '\''
    let quoted = format!("'{}'", bin.to_string_lossy().replace('\'', "'\\''"));
    let script = format!(
        "#!/bin/zsh\n{quoted} {args}\necho\necho \"Done. You can close this window and go back to Bloom.\"\n"
    );
    let file = std::env::temp_dir().join(format!("{name}.command"));
    fs::write(&file, script).map_err(|e| format!("Could not prepare the sign-in: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&file, fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("Could not prepare the sign-in: {e}"))?;
    }
    let status = Command::new("/usr/bin/open")
        .arg(&file)
        .status()
        .map_err(|e| format!("Could not open Terminal: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err("Could not open Terminal.".into())
    }
}

/// Stops a running `claude_login`. Does nothing when none is running.
#[tauri::command]
async fn claude_login_cancel() -> Result<(), String> {
    stop_tracked(&LOGIN_PID).await
}

/// The fallback sign-in, in Terminal: the CLI's own sign-in.
#[tauri::command]
async fn claude_login_terminal() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let bin = find_claude().ok_or_else(|| "no-claude".to_string())?;
        sign_in_with_terminal(&bin, "auth login --claudeai", "bloom-sign-in")
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---- Codex (OpenAI's CLI), the backup assistant: asking, status, install, sign-in

/// Same flags as CODEX_ARGS in ui/js/assistant-core.js (used by the browser preview): the prompt on
/// stdin, events as JSON lines, nothing saved, her own config and rules ignored, read-only.
const CODEX_ARGS: &[&str] = &[
    "exec",
    "--json",
    "--color",
    "never",
    "--ephemeral",
    "--skip-git-repo-check",
    "--ignore-user-config",
    "--ignore-rules",
    "--sandbox",
    "read-only",
    "-c",
    "approval_policy=never",
    "-",
];

/// The pid of the running `codex login`, so the sign-in can be cancelled.
static CODEX_LOGIN_PID: Mutex<Option<u32>> = Mutex::new(None);

/// Where Codex is: where Bloom installs it, Homebrew, npm, then her login shell.
fn find_codex() -> Option<PathBuf> {
    let mut places: Vec<PathBuf> = Vec::new();
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        places.push(home.join(".local/bin/codex"));
        places.push(home.join(".npm-global/bin/codex"));
    }
    places.push(PathBuf::from("/opt/homebrew/bin/codex"));
    places.push(PathBuf::from("/usr/local/bin/codex"));
    for place in places {
        if place.is_file() {
            return Some(place);
        }
    }
    find_in_login_shell("codex")
}

/// Reads the JSON lines printed by `codex exec --json` and returns Codex's last message (see
/// readCodexEvents in ui/js/assistant-core.js, which does the same for the preview).
fn read_codex_events(status: ExitStatus, out: &[u8], err: &[u8]) -> Result<String, String> {
    let text = String::from_utf8_lossy(out).into_owned();
    let mut answer = String::new();
    let mut failed = String::new();
    let mut error = String::new();
    let mut events = 0usize;
    for line in text.lines() {
        let Ok(e) = serde_json::from_str::<serde_json::Value>(line.trim()) else {
            continue;
        };
        if !e.is_object() {
            continue;
        }
        events += 1;
        match e.get("type").and_then(|v| v.as_str()).unwrap_or("") {
            "item.completed" => {
                let item = e.get("item");
                if item.and_then(|i| i.get("type")).and_then(|v| v.as_str()) == Some("agent_message") {
                    if let Some(t) = item.and_then(|i| i.get("text")).and_then(|v| v.as_str()) {
                        answer = t.trim().to_string();
                    }
                }
            }
            "turn.failed" => {
                failed = e
                    .get("error")
                    .and_then(|x| x.get("message"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("the request failed")
                    .to_string();
            }
            "error" => {
                error = e.get("message").and_then(|v| v.as_str()).unwrap_or("").to_string();
            }
            _ => {}
        }
    }
    if !failed.is_empty() {
        return Err(format!("Codex: {failed}"));
    }
    if !answer.is_empty() && status.success() {
        return Ok(answer);
    }
    if !error.is_empty() {
        return Err(format!("Codex: {error}"));
    }
    if events == 0 || !status.success() {
        let detail = tail_text(err, 300);
        let code = status.code().filter(|c| *c != 0).map(|c| format!(" (exit code {c})")).unwrap_or_default();
        return Err(format!("Codex did not answer{code}. {detail}").trim().to_string());
    }
    Err("Codex's answer was empty. Try again.".into())
}

/// Reads what `codex login status` printed ("Logged in using ChatGPT", "Logged in using an API
/// key - …", "Not logged in"), like readCodexLogin in ui/js/assistant-core.js.
fn read_codex_login(status: ExitStatus, out: &[u8], err: &[u8]) -> serde_json::Value {
    let text = strip_ansi(&format!("{}\n{}", String::from_utf8_lossy(out), String::from_utf8_lossy(err))).to_lowercase();
    let logged_in = status.success() && text.contains("logged in") && !text.contains("not logged in");
    let method = if !logged_in {
        serde_json::Value::Null
    } else if text.contains("chatgpt") {
        serde_json::json!("ChatGPT")
    } else if text.contains("api key") {
        serde_json::json!("API key")
    } else {
        serde_json::Value::Null
    };
    serde_json::json!({ "installed": true, "loggedIn": logged_in, "method": method })
}

/// Runs Codex like `ask_claude` runs Claude Code. "no-codex" means the CLI could not be found.
#[tauri::command]
async fn ask_codex(app: AppHandle, pdf_id: Option<String>, prompt: String) -> Result<String, String> {
    let (dir, prompt) = ask_place(&app, pdf_id, prompt)?;
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let bin = find_codex().ok_or_else(|| "no-codex".to_string())?;
        let mut cmd = Command::new(&bin);
        cmd.args(CODEX_ARGS).current_dir(&dir).env("PATH", child_path(&bin));
        match run_with_timeout(cmd, prompt.as_bytes(), CLAUDE_TIMEOUT) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err("no-codex".into()),
            Err(e) => Err(format!("Could not start Codex: {e}")),
            Ok(None) => Err("Codex took longer than 5 minutes and was stopped. Try again.".into()),
            Ok(Some((status, out, err))) => read_codex_events(status, &out, &err),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// `{"installed": false}`, or `{"installed": true, "loggedIn", "method"}`.
#[tauri::command]
async fn codex_status() -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<serde_json::Value, String> {
        let Some(bin) = find_codex() else {
            return Ok(serde_json::json!({ "installed": false }));
        };
        let mut cmd = Command::new(&bin);
        cmd.args(["login", "status"]).env("PATH", child_path(&bin));
        match run_with_timeout(cmd, b"", STATUS_TIMEOUT) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(serde_json::json!({ "installed": false })),
            Err(e) => Err(format!("Could not start Codex: {e}")),
            Ok(None) => Err("Codex did not answer in time. Try again.".into()),
            Ok(Some((status, out, err))) => Ok(read_codex_login(status, &out, &err)),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Downloads OpenAI's own build of Codex for this Mac from its GitHub releases, into
/// ~/.local/bin/codex. No Node.js needed.
const CODEX_INSTALL: &str = r#"set -euo pipefail
arch="$(uname -m)"; [ "$arch" = "arm64" ] && arch="aarch64"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
curl -fsSL "https://github.com/openai/codex/releases/latest/download/codex-${arch}-apple-darwin.tar.gz" -o "$tmp/codex.tar.gz"
tar -xzf "$tmp/codex.tar.gz" -C "$tmp"
bin="$(find "$tmp" -type f -name 'codex*' ! -name '*.tar.gz' | head -n 1)"
[ -n "$bin" ] || { echo "The download held no Codex program." >&2; exit 1; }
mkdir -p "$HOME/.local/bin"
mv -f "$bin" "$HOME/.local/bin/codex"
chmod +x "$HOME/.local/bin/codex"
"$HOME/.local/bin/codex" --version"#;

#[tauri::command]
async fn codex_install() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let mut cmd = Command::new("/bin/bash");
        cmd.args(["-c", CODEX_INSTALL]).env("PATH", child_path(Path::new("/bin/bash")));
        match run_with_timeout(cmd, b"", INSTALL_TIMEOUT) {
            Err(e) => Err(format!("Could not start the installer: {e}")),
            Ok(None) => Err("The installation took longer than 10 minutes and was stopped. Check the internet connection and try again.".into()),
            Ok(Some((status, out, err))) => {
                if status.success() && find_codex().is_some() {
                    return Ok(());
                }
                let mut detail = tail_text(&err, 300);
                if detail.is_empty() {
                    detail = tail_text(&out, 300);
                }
                let code = status.code().map(|c| format!(" (exit code {c})")).unwrap_or_default();
                Err(format!("Codex could not be installed{code}. {detail}").trim().to_string())
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Signs in with her ChatGPT account: the CLI opens the browser and waits for it.
#[tauri::command]
async fn codex_login() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let bin = find_codex().ok_or_else(|| "no-codex".to_string())?;
        let mut cmd = Command::new(&bin);
        cmd.arg("login").env("PATH", child_path(&bin));
        let result = run_tracked(cmd, b"", LOGIN_TIMEOUT, Some(&CODEX_LOGIN_PID));
        if let Ok(mut pid) = CODEX_LOGIN_PID.lock() {
            *pid = None;
        }
        match result {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err("no-codex".into()),
            Err(e) => Err(format!("Could not start the sign-in: {e}")),
            Ok(None) => Err("The sign-in was not finished within 5 minutes and was stopped. Try again.".into()),
            Ok(Some((status, out, err))) => {
                if status.success() {
                    return Ok(());
                }
                let mut detail = tail_text(&err, 300);
                if detail.is_empty() {
                    detail = tail_text(&out, 300);
                }
                Err(format!("The sign-in did not finish. {detail}").trim().to_string())
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Stops a running `codex_login`. Does nothing when none is running.
#[tauri::command]
async fn codex_login_cancel() -> Result<(), String> {
    stop_tracked(&CODEX_LOGIN_PID).await
}

/// The fallback sign-in, in Terminal: Codex's own sign-in.
#[tauri::command]
async fn codex_login_terminal() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let bin = find_codex().ok_or_else(|| "no-codex".to_string())?;
        sign_in_with_terminal(&bin, "login", "bloom-codex-sign-in")
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            load_data,
            save_data,
            export_data,
            save_pdf,
            read_pdf,
            delete_pdf,
            convert_to_pdf,
            ask_claude,
            claude_status,
            claude_install,
            claude_login,
            claude_login_cancel,
            claude_login_terminal,
            ask_codex,
            codex_status,
            codex_install,
            codex_login,
            codex_login_cancel,
            codex_login_terminal
        ])
        .run(tauri::generate_context!())
        .expect("error while running Bloom");
}
