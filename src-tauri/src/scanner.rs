use crate::db::Database;
use crate::parser::{parse_track_path, ParsedTrackInfo};
use crate::to_windows_long_path;
use jwalk::WalkDir;
use rayon::prelude::*;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::Instant;
use tauri::ipc::Channel;

const SUPPORTED_AUDIO_EXTS: &[&str] = &[
    "mp3", "flac", "ogg", "opus", "m4a", "aac", "wav", "wv", "aiff", "alac",
];

const JUNK_PATH_MARKERS: &[&str] = &["freac", "notifier", "thumbs.db", ".cue", ".log", ".m3u"];

#[derive(Clone, Serialize)]
pub struct ScanProgressEvent {
    pub phase: String,
    pub scanned_files: usize,
    pub indexed_tracks: usize,
    pub current_path: String,
    pub elapsed_ms: u128,
    pub done: bool,
}

fn is_audio_file(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|ext| SUPPORTED_AUDIO_EXTS.contains(&ext.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

fn is_junk_path(path: &Path) -> bool {
    let lower = path.to_string_lossy().to_lowercase();
    JUNK_PATH_MARKERS.iter().any(|marker| lower.contains(marker))
}

pub fn scan_roots_into_db(
    db: &Database,
    roots: &[String],
    progress_chan: &Channel<ScanProgressEvent>,
) -> Result<usize, String> {
    let start = Instant::now();
    let mut total_indexed: usize = 0;

    for root_str in roots {
        db.add_root_folder(root_str)?;
        let clean_root_path = PathBuf::from(root_str);
        let walk_root = to_windows_long_path(&clean_root_path);

        let mut discovered_entries: Vec<(PathBuf, u64)> = Vec::with_capacity(8192);
        for entry_res in WalkDir::new(&walk_root).skip_hidden(true).follow_links(false) {
            if let Ok(entry) = entry_res {
                if entry.file_type().is_file() {
                    let path = entry.path();
                    if is_audio_file(&path) && !is_junk_path(&path) {
                        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                        let display_path = strip_long_path_prefix(&path);
                        discovered_entries.push((display_path, size));
                    }
                }
            }
        }

        for chunk in discovered_entries.chunks(1000) {
            let parsed_batch: Vec<(ParsedTrackInfo, u64, u32)> = chunk
                .par_iter()
                .map(|(p, size)| {
                    let info = parse_track_path(p, Some(&clean_root_path));
                    (info, *size, 0u32)
                })
                .collect();

            db.upsert_tracks_batch(&parsed_batch)?;
            total_indexed += parsed_batch.len();

            let sample_path = parsed_batch
                .last()
                .map(|(i, _, _)| i.file_path.clone())
                .unwrap_or_else(|| root_str.clone());

            let _ = progress_chan.send(ScanProgressEvent {
                phase: "Indexation ParsePath v6+...".to_string(),
                scanned_files: discovered_entries.len(),
                indexed_tracks: total_indexed,
                current_path: sample_path,
                elapsed_ms: start.elapsed().as_millis(),
                done: false,
            });
        }
    }

    let _ = progress_chan.send(ScanProgressEvent {
        phase: "Indexation terminée".to_string(),
        scanned_files: total_indexed,
        indexed_tracks: total_indexed,
        current_path: String::new(),
        elapsed_ms: start.elapsed().as_millis(),
        done: true,
    });

    Ok(total_indexed)
}

fn strip_long_path_prefix(path: &Path) -> PathBuf {
    let s = path.to_string_lossy();
    if let Some(unc) = s.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{}", unc));
    }
    if let Some(local) = s.strip_prefix(r"\\?\") {
        return PathBuf::from(local);
    }
    path.to_path_buf()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn test_supported_audio_extensions_only() {
        assert!(is_audio_file(Path::new(r"D:\Musique\Alpha Blondy\01 - Jerusalem.flac")));
        assert!(is_audio_file(Path::new(r"D:\Musique\Album\piste.MP3")));
        assert!(!is_audio_file(Path::new(r"D:\Musique\album.cue")));
        assert!(!is_audio_file(Path::new(r"D:\Musique\freac.extension.notifier")));
        assert!(!is_audio_file(Path::new(r"D:\Musique\Album\Thumbs.db")));
    }

    #[test]
    fn test_tool_and_system_files_are_rejected() {
        assert!(is_junk_path(Path::new(r"D:\Musique\freac.extension.notifier")));
        assert!(is_junk_path(Path::new(r"D:\Musique\Album\Thumbs.db")));
        assert!(is_junk_path(Path::new(r"D:\Musique\Album\album.cue")));
        assert!(is_junk_path(Path::new(r"D:\Musique\Album\rip.log")));
        assert!(is_junk_path(Path::new(r"D:\Musique\Album\playlist.m3u")));
        assert!(!is_junk_path(Path::new(r"D:\Musique\Alpha Blondy\1994 - Jerusalem\01 - Jerusalem.flac")));
    }
}