#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

pub mod audio;
pub mod benchmark;
pub mod covers;
pub mod db;
pub mod parser;
pub mod scanner;

use audio::{AudioCommand, AudioController, EqConfig, PlaybackStatus, QueueTrack, RepeatMode};
use benchmark::{run_50k_stress_benchmark, BenchmarkReport};
use covers::{resolve_album_cover, CoverResolution};
use db::{Database, LibrarySnapshot, TrackRecord};
use scanner::{scan_roots_into_db, ScanProgressEvent};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::ipc::Channel;
use tauri::{Manager, State};
use window_vibrancy::{apply_acrylic, apply_mica};

pub struct AppState {
    pub db: Arc<Database>,
    pub audio: Arc<AudioController>,
    pub covers_cache_dir: PathBuf,
}

pub fn to_windows_long_path(path: &Path) -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        let raw = path.to_string_lossy();
        if raw.starts_with(r"\\?\") { return path.to_path_buf(); }
        if let Some(stripped_unc) = raw.strip_prefix(r"\\") {
            return PathBuf::from(format!(r"\\?\UNC\{}", stripped_unc));
        }
        if raw.len() >= 240 {
            return PathBuf::from(format!(r"\\?\{}", raw));
        }
    }
    path.to_path_buf()
}

#[tauri::command]
async fn scan_library_folders(
    state: State<'_, AppState>,
    folders: Vec<String>,
    on_progress: Channel<ScanProgressEvent>,
) -> Result<LibrarySnapshot, String> {
    let db = Arc::clone(&state.db);
    tokio::task::spawn_blocking(move || {
        scan_roots_into_db(&db, &folders, &on_progress)?;
        db.get_library_snapshot()
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn get_library_snapshot(state: State<'_, AppState>) -> Result<LibrarySnapshot, String> {
    state.db.get_library_snapshot()
}

#[tauri::command]
fn get_album_tracks(state: State<'_, AppState>, artist_key: String, album_key: String) -> Result<Vec<TrackRecord>, String> {
    state.db.get_album_tracks(&artist_key, &album_key)
}

#[tauri::command]
fn get_artist_tracks(state: State<'_, AppState>, artist_key: String) -> Result<Vec<TrackRecord>, String> {
    state.db.get_artist_tracks(&artist_key)
}

#[tauri::command]
fn remove_root_folder(state: State<'_, AppState>, path: String) -> Result<LibrarySnapshot, String> {
    state.db.remove_root_folder(&path)?;
    state.db.get_library_snapshot()
}

#[tauri::command]
fn relink_library_paths(state: State<'_, AppState>, old_prefix: String, new_prefix: String) -> Result<(usize, LibrarySnapshot), String> {
    let updated = state.db.relink_prefix(&old_prefix, &new_prefix)?;
    let snap = state.db.get_library_snapshot()?;
    Ok((updated, snap))
}

#[tauri::command]
fn export_library_json(state: State<'_, AppState>, target_path: String) -> Result<usize, String> {
    state.db.export_catalog_json(Path::new(&target_path))
}

#[tauri::command]
fn import_library_json(state: State<'_, AppState>, source_path: String) -> Result<LibrarySnapshot, String> {
    state.db.import_catalog_json(Path::new(&source_path))?;
    state.db.get_library_snapshot()
}

#[tauri::command]
async fn run_scale_benchmark_50k(state: State<'_, AppState>) -> Result<BenchmarkReport, String> {
    let db = Arc::clone(&state.db);
    tokio::task::spawn_blocking(move || run_50k_stress_benchmark(&db, 50_000))
        .await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn clear_entire_library(state: State<'_, AppState>) -> Result<LibrarySnapshot, String> {
    let conn = state.db.connect()?;
    conn.execute_batch("DELETE FROM tracks; DELETE FROM root_folders;").map_err(|e| e.to_string())?;
    state.db.get_library_snapshot()
}

#[tauri::command]
fn audio_play_tracks(state: State<'_, AppState>, tracks: Vec<QueueTrack>, start_index: usize) -> Result<(), String> {
    state.audio.send(AudioCommand::SetQueueAndPlay { tracks, start_index });
    Ok(())
}

#[tauri::command]
fn audio_append_queue(state: State<'_, AppState>, tracks: Vec<QueueTrack>) -> Result<(), String> {
    state.audio.send(AudioCommand::AppendQueue { tracks });
    Ok(())
}

#[tauri::command]
fn audio_toggle_play(state: State<'_, AppState>) -> Result<(), String> {
    state.audio.send(AudioCommand::TogglePlayPause);
    Ok(())
}

#[tauri::command]
fn audio_next(state: State<'_, AppState>) -> Result<(), String> {
    state.audio.send(AudioCommand::Next);
    Ok(())
}

#[tauri::command]
fn audio_prev(state: State<'_, AppState>) -> Result<(), String> {
    state.audio.send(AudioCommand::Prev);
    Ok(())
}

#[tauri::command]
fn audio_seek(state: State<'_, AppState>, position_sec: f32) -> Result<(), String> {
    state.audio.send(AudioCommand::Seek(position_sec));
    Ok(())
}

#[tauri::command]
fn audio_set_volume(state: State<'_, AppState>, volume: f32) -> Result<(), String> {
    state.audio.send(AudioCommand::SetVolume(volume));
    Ok(())
}

#[tauri::command]
fn audio_set_shuffle(state: State<'_, AppState>, shuffle: bool) -> Result<(), String> {
    state.audio.send(AudioCommand::SetShuffle(shuffle));
    Ok(())
}

#[tauri::command]
fn audio_set_repeat(state: State<'_, AppState>, mode: RepeatMode) -> Result<(), String> {
    state.audio.send(AudioCommand::SetRepeat(mode));
    Ok(())
}

#[tauri::command]
fn audio_set_eq(state: State<'_, AppState>, eq: EqConfig) -> Result<(), String> {
    state.audio.send(AudioCommand::SetEq(eq));
    Ok(())
}

#[tauri::command]
fn audio_get_telemetry(state: State<'_, AppState>) -> PlaybackStatus {
    state.audio.get_status_and_fft()
}

#[tauri::command]
async fn resolve_cover_lazy(
    state: State<'_, AppState>, cover_key: String, folder_path: String,
    artist_name: String, album_title: String, allow_online: bool,
) -> Result<CoverResolution, String> {
    let cache_dir = state.covers_cache_dir.clone();
    tokio::task::spawn_blocking(move || {
        resolve_album_cover(&cache_dir, &cover_key, &folder_path, None, &artist_name, &album_title, allow_online)
    }).await.map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let app_dir = app.path().app_data_dir()?;
            let covers_cache_dir = app_dir.join("covers_cache");
            std::fs::create_dir_all(&covers_cache_dir)?;

            let db = Database::new(&app_dir).expect("Erreur init SQLite");
            let audio = AudioController::new();

            app.manage(AppState {
                db: Arc::new(db),
                audio: Arc::new(audio),
                covers_cache_dir,
            });

            if let Some(window) = app.get_webview_window("main") {
                #[cfg(target_os = "windows")]
                {
                    if apply_mica(&window, Some(true)).is_err() {
                        let _ = apply_acrylic(&window, Some((14, 14, 20, 230)));
                    }
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            scan_library_folders, get_library_snapshot, get_album_tracks, get_artist_tracks,
            remove_root_folder, relink_library_paths, export_library_json, import_library_json,
            run_scale_benchmark_50k, clear_entire_library,
            audio_play_tracks, audio_append_queue, audio_toggle_play, audio_next, audio_prev,
            audio_seek, audio_set_volume, audio_set_shuffle, audio_set_repeat, audio_set_eq,
            audio_get_telemetry, resolve_cover_lazy
        ])
        .run(tauri::generate_context!())
        .expect("Erreur fatale Tauri");
}