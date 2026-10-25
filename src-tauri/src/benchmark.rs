use crate::db::{Database, LibrarySnapshot};
use crate::parser::{parse_track_path, ParsedTrackInfo};
use rayon::prelude::*;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::Instant;

#[derive(Debug, Clone, Serialize)]
pub struct BenchmarkReport {
    pub generated_tracks: usize,
    pub unique_artists: usize,
    pub unique_albums: usize,
    pub parse_time_ms: u128,
    pub sqlite_insert_ms: u128,
    pub total_time_ms: u128,
    pub snapshot: LibrarySnapshot,
}

const SEED_ARTISTS: &[&str] = &[
    "Black Sabbath", "Dio", "Rainbow", "Rammstein", "Gojira", "Terror",
    "Kickback", "Sick of It All", "Lofofora", "Slipknot", "Mylène Farmer",
    "Saez", "Angèle", "Iron Maiden", "Judas Priest", "Metallica", "Slayer",
    "Megadeth", "Pantera", "Sepultura", "Meshuggah", "Opeth", "Mastodon", "Tool", "Deftones",
];

pub fn run_50k_stress_benchmark(db: &Database, track_count: usize) -> Result<BenchmarkReport, String> {
    let total_start = Instant::now();
    let root_str = r"\\NAS-MUSICO\AudioLibrary";
    let root_path = Path::new(root_str);
    db.add_root_folder(root_str)?;

    let raw_paths: Vec<(PathBuf, u64, u32)> = (0..track_count)
        .into_par_iter()
        .map(|i| {
            let artist_idx = i / 25;
            let base_name = SEED_ARTISTS[artist_idx % SEED_ARTISTS.len()];
            let group_suffix = artist_idx / SEED_ARTISTS.len();
            let artist_folder = if group_suffix == 0 {
                base_name.to_string()
            } else if i % 2 == 0 {
                format!("{} Collective {:03}", base_name, group_suffix)
            } else {
                format!("{} COLLECTIVE {:03}", base_name.to_uppercase(), group_suffix)
            };

            let album_num = (i / 10) % 3;
            let year = 1970 + ((artist_idx + album_num) % 55);
            let disc_subfolder = if album_num == 2 {
                if (i % 10) < 5 { r"\CD1" } else { r"\CD2" }
            } else { "" };

            let track_no = (i % 10) + 1;
            let ext = if i % 3 == 0 { "flac" } else { "mp3" };
            let path_str = format!(
                r"{}\Rock\{}\{} - [{}] Studio Session Vol. {}{}\{:02} - Track_{:05}.{}",
                root_str, artist_folder, artist_folder, year, album_num + 1, disc_subfolder, track_no, i + 1, ext
            );
            (PathBuf::from(path_str), 24_000_000, 210)
        })
        .collect();

    let parse_start = Instant::now();
    let parsed_entries: Vec<(ParsedTrackInfo, u64, u32)> = raw_paths
        .par_iter()
        .map(|(p, sz, dur)| (parse_track_path(p, Some(root_path)), *sz, *dur))
        .collect();
    let parse_time_ms = parse_start.elapsed().as_millis();

    let sql_start = Instant::now();
    for chunk in parsed_entries.chunks(5000) {
        db.upsert_tracks_batch(chunk)?;
    }
    let sqlite_insert_ms = sql_start.elapsed().as_millis();

    let snapshot = db.get_library_snapshot()?;
    let total_time_ms = total_start.elapsed().as_millis();

    Ok(BenchmarkReport {
        generated_tracks: track_count,
        unique_artists: snapshot.artists.len(),
        unique_albums: snapshot.albums.len(),
        parse_time_ms,
        sqlite_insert_ms,
        total_time_ms,
        snapshot,
    })
}