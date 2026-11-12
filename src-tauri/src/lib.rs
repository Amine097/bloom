//! Native shell for Bloom. The interface (ui/) does all the work; this side only owns the data
//! file (load, atomic save, one backup per day, export to the Downloads folder) and the lecture
//! PDFs stored beside it in `pdfs/`.

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::thread;
use std::time::{Duration, Instant};
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
    mut cmd: Command,
    input: &[u8],
    timeout: Duration,
) -> Result<Option<(ExitStatus, Vec<u8>, Vec<u8>)>, std::io::Error> {
    let mut child = cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
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
    if let Some(mut stdin) = child.stdin.take() {
        // a write error shows up as a failed run below
        let _ = stdin.write_all(input);
        // stdin is closed here, so the CLI knows the prompt is complete
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

    let mut shell = Command::new("/bin/zsh");
    shell.args(["-lc", "command -v claude"]);
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

/// Runs Claude Code on one lecture PDF. `prompt` holds `{{PDF}}`, replaced here by the PDF's
/// absolute path. Returns Claude's final text, or an error she can read; "no-claude" means the
/// CLI could not be found.
#[tauri::command]
async fn ask_claude(app: AppHandle, pdf_id: String, prompt: String) -> Result<String, String> {
    let file = pdf_path(&app, &pdf_id)?;
    if !file.is_file() {
        return Err("The PDF of this lecture is missing. Attach it again from Courses.".into());
    }
    let dir = match file.parent() {
        Some(d) => d.to_path_buf(),
        None => return Err("invalid file path".into()),
    };
    let prompt = prompt.replace("{{PDF}}", &file.to_string_lossy());
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
            ask_claude
        ])
        .run(tauri::generate_context!())
        .expect("error while running Bloom");
}
