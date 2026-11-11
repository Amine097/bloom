//! Native shell for Bloom. The interface (ui/) does all the work; this side only owns the data
//! file: load, atomic save, one backup per day, and export to the Downloads folder.

use std::fs;
use std::path::PathBuf;
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![load_data, save_data, export_data])
        .run(tauri::generate_context!())
        .expect("error while running Bloom");
}
