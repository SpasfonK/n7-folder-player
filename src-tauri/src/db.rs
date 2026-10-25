use crate::parser::ParsedTrackInfo;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArtistSummary {
    pub artist_key: String,
    pub display_name: String,
    pub album_count: u32,
    pub track_count: u32,
    pub weight: f32,
    pub first_letter: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AlbumSummary {
    pub album_key: String,
    pub artist_key: String,
    pub artist_name: String,
    pub title: String,
    pub year: Option<u32>,
    pub cover_key: String,
    pub folder_path: String,
    pub track_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrackRecord {
    pub id: i64,
    pub file_path: String,
    pub folder_path: String,
    pub artist_key: String,
    pub artist_name: String,
    pub album_key: String,
    pub album_title: String,
    pub title: String,
    pub track_no: u32,
    pub disc_no: u32,
    pub duration_sec: u32,
    pub year: Option<u32>,
    pub format: String,
    pub size_bytes: u64,
    pub cover_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LibrarySnapshot {
    pub roots: Vec<String>,
    pub artists: Vec<ArtistSummary>,
    pub albums: Vec<AlbumSummary>,
    pub total_tracks: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CatalogExport {
    pub version: String,
    pub roots: Vec<String>,
    pub tracks: Vec<TrackRecord>,
}

pub struct Database {
    pub db_path: PathBuf,
}

impl Database {
    pub fn new(app_data_dir: &Path) -> Result<Self, String> {
        let db_path = app_data_dir.join("library.db");
        let db = Self { db_path };
        db.init_schema()?;
        Ok(db)
    }

    pub fn connect(&self) -> Result<Connection, String> {
        let conn = Connection::open(&self.db_path).map_err(|e| e.to_string())?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA temp_store = MEMORY;
             PRAGMA cache_size = -32000;",
        )
        .map_err(|e| e.to_string())?;
        Ok(conn)
    }

    fn init_schema(&self) -> Result<(), String> {
        let conn = self.connect()?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS root_folders (
                path TEXT PRIMARY KEY,
                added_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS tracks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                file_path TEXT UNIQUE NOT NULL,
                folder_path TEXT NOT NULL,
                artist_key TEXT NOT NULL,
                artist_name TEXT NOT NULL,
                album_key TEXT NOT NULL,
                album_title TEXT NOT NULL,
                title TEXT NOT NULL,
                track_no INTEGER NOT NULL,
                disc_no INTEGER NOT NULL,
                duration_sec INTEGER NOT NULL DEFAULT 0,
                year INTEGER,
                format TEXT NOT NULL,
                size_bytes INTEGER NOT NULL DEFAULT 0,
                cover_key TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_tracks_artist_key ON tracks(artist_key);
            CREATE INDEX IF NOT EXISTS idx_tracks_album_key ON tracks(artist_key, album_key);
            CREATE INDEX IF NOT EXISTS idx_tracks_folder ON tracks(folder_path);",
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn add_root_folder(&self, path: &str) -> Result<(), String> {
        let conn = self.connect()?;
        conn.execute(
            "INSERT OR IGNORE INTO root_folders (path, added_at) VALUES (?1, strftime('%s','now'))",
            params![path],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn remove_root_folder(&self, path: &str) -> Result<(), String> {
        let conn = self.connect()?;
        conn.execute("DELETE FROM root_folders WHERE path = ?1", params![path])
            .map_err(|e| e.to_string())?;
        let like_pattern = format!("{}%", path);
        conn.execute("DELETE FROM tracks WHERE file_path LIKE ?1", params![like_pattern])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn upsert_tracks_batch(&self, batch: &[(ParsedTrackInfo, u64, u32)]) -> Result<(), String> {
        let mut conn = self.connect()?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        {
            let mut stmt = tx
                .prepare_cached(
                    "INSERT INTO tracks (
                        file_path, folder_path, artist_key, artist_name,
                        album_key, album_title, title, track_no, disc_no,
                        duration_sec, year, format, size_bytes, cover_key
                    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
                    ON CONFLICT(file_path) DO UPDATE SET
                        folder_path = excluded.folder_path,
                        artist_key = excluded.artist_key,
                        artist_name = excluded.artist_name,
                        album_key = excluded.album_key,
                        album_title = excluded.album_title,
                        title = excluded.title,
                        track_no = excluded.track_no,
                        disc_no = excluded.disc_no,
                        duration_sec = excluded.duration_sec,
                        year = excluded.year,
                        format = excluded.format,
                        size_bytes = excluded.size_bytes,
                        cover_key = excluded.cover_key",
                )
                .map_err(|e| e.to_string())?;

            for (info, size_bytes, duration_sec) in batch {
                stmt.execute(params![
                    info.file_path,
                    info.folder_path,
                    info.artist_key,
                    info.artist_name,
                    info.album_key,
                    info.album_title,
                    info.track_title,
                    info.track_no,
                    info.disc_no,
                    duration_sec,
                    info.year,
                    info.format,
                    *size_bytes as i64,
                    info.cover_key
                ])
                .map_err(|e| e.to_string())?;
            }
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_library_snapshot(&self) -> Result<LibrarySnapshot, String> {
        let conn = self.connect()?;
        let roots: Vec<String> = conn
            .prepare("SELECT path FROM root_folders ORDER BY added_at ASC")
            .map_err(|e| e.to_string())?
            .query_map([], |row| row.get(0))
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .collect();

        let mut stmt_artists = conn
            .prepare(
                "SELECT artist_key, MAX(artist_name), COUNT(DISTINCT album_key), COUNT(*)
                 FROM tracks GROUP BY artist_key ORDER BY artist_key ASC",
            )
            .map_err(|e| e.to_string())?;

        let mut raw_artists: Vec<(String, String, u32, u32)> = Vec::new();
        let mut max_tracks: u32 = 1;
        let rows = stmt_artists
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)))
            .map_err(|e| e.to_string())?;

        for r in rows.flatten() {
            if r.3 > max_tracks {
                max_tracks = r.3;
            }
            raw_artists.push(r);
        }

        let max_ln = (max_tracks as f32 + 1.0).ln();
        let artists: Vec<ArtistSummary> = raw_artists
            .into_iter()
            .map(|(artist_key, display_name, album_count, track_count)| {
                let weight = if max_ln > 0.0 {
                    ((track_count as f32 + 1.0).ln() / max_ln).clamp(0.15, 1.0)
                } else {
                    0.5
                };
                let first_char = artist_key.chars().next().map(|c| c.to_ascii_uppercase()).unwrap_or('#');
                let first_letter = if first_char.is_ascii_alphabetic() {
                    first_char.to_string()
                } else {
                    "#".to_string()
                };
                ArtistSummary {
                    artist_key,
                    display_name,
                    album_count,
                    track_count,
                    weight,
                    first_letter,
                }
            })
            .collect();

        let mut stmt_albums = conn
            .prepare(
                "SELECT album_key, artist_key, MAX(artist_name), MAX(album_title),
                        MAX(year), MAX(cover_key), MIN(folder_path), COUNT(*)
                 FROM tracks GROUP BY artist_key, album_key
                 ORDER BY artist_key ASC, year ASC, album_title ASC",
            )
            .map_err(|e| e.to_string())?;

        let albums: Vec<AlbumSummary> = stmt_albums
            .query_map([], |row| {
                Ok(AlbumSummary {
                    album_key: row.get(0)?,
                    artist_key: row.get(1)?,
                    artist_name: row.get(2)?,
                    title: row.get(3)?,
                    year: row.get(4)?,
                    cover_key: row.get(5)?,
                    folder_path: row.get(6)?,
                    track_count: row.get(7)?,
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .collect();

        let total_tracks: u32 = conn
            .query_row("SELECT COUNT(*) FROM tracks", [], |row| row.get(0))
            .unwrap_or(0);

        Ok(LibrarySnapshot {
            roots,
            artists,
            albums,
            total_tracks,
        })
    }

    pub fn get_album_tracks(&self, artist_key: &str, album_key: &str) -> Result<Vec<TrackRecord>, String> {
        let conn = self.connect()?;
        let mut stmt = conn
            .prepare(
                "SELECT id, file_path, folder_path, artist_key, artist_name,
                        album_key, album_title, title, track_no, disc_no,
                        duration_sec, year, format, size_bytes, cover_key
                 FROM tracks WHERE artist_key = ?1 AND album_key = ?2
                 ORDER BY disc_no ASC, track_no ASC, title ASC",
            )
            .map_err(|e| e.to_string())?;

        let tracks = stmt
            .query_map(params![artist_key, album_key], |row| {
                Ok(TrackRecord {
                    id: row.get(0)?,
                    file_path: row.get(1)?,
                    folder_path: row.get(2)?,
                    artist_key: row.get(3)?,
                    artist_name: row.get(4)?,
                    album_key: row.get(5)?,
                    album_title: row.get(6)?,
                    title: row.get(7)?,
                    track_no: row.get(8)?,
                    disc_no: row.get(9)?,
                    duration_sec: row.get(10)?,
                    year: row.get(11)?,
                    format: row.get(12)?,
                    size_bytes: row.get::<_, i64>(13)? as u64,
                    cover_key: row.get(14)?,
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .collect();
        Ok(tracks)
    }

    pub fn get_artist_tracks(&self, artist_key: &str) -> Result<Vec<TrackRecord>, String> {
        let conn = self.connect()?;
        let mut stmt = conn
            .prepare(
                "SELECT id, file_path, folder_path, artist_key, artist_name,
                        album_key, album_title, title, track_no, disc_no,
                        duration_sec, year, format, size_bytes, cover_key
                 FROM tracks WHERE artist_key = ?1
                 ORDER BY year ASC, album_key ASC, disc_no ASC, track_no ASC, title ASC",
            )
            .map_err(|e| e.to_string())?;

        let tracks = stmt
            .query_map(params![artist_key], |row| {
                Ok(TrackRecord {
                    id: row.get(0)?,
                    file_path: row.get(1)?,
                    folder_path: row.get(2)?,
                    artist_key: row.get(3)?,
                    artist_name: row.get(4)?,
                    album_key: row.get(5)?,
                    album_title: row.get(6)?,
                    title: row.get(7)?,
                    track_no: row.get(8)?,
                    disc_no: row.get(9)?,
                    duration_sec: row.get(10)?,
                    year: row.get(11)?,
                    format: row.get(12)?,
                    size_bytes: row.get::<_, i64>(13)? as u64,
                    cover_key: row.get(14)?,
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .collect();
        Ok(tracks)
    }

    pub fn relink_prefix(&self, old_prefix: &str, new_prefix: &str) -> Result<usize, String> {
        let mut conn = self.connect()?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let old_len = old_prefix.chars().count() as i64;
        let like_pattern = format!("{}%", old_prefix);

        let updated = tx
            .execute(
                "UPDATE tracks
                 SET file_path = ?2 || SUBSTR(file_path, ?3 + 1),
                     folder_path = ?2 || SUBSTR(folder_path, ?3 + 1)
                 WHERE file_path LIKE ?1",
                params![like_pattern, new_prefix, old_len],
            )
            .map_err(|e| e.to_string())?;

        tx.execute(
            "UPDATE OR REPLACE root_folders
             SET path = ?2 || SUBSTR(path, ?3 + 1)
             WHERE path LIKE ?1",
            params![like_pattern, new_prefix, old_len],
        )
        .map_err(|e| e.to_string())?;

        tx.commit().map_err(|e| e.to_string())?;
        Ok(updated)
    }

    pub fn export_catalog_json(&self, target_file: &Path) -> Result<usize, String> {
        let conn = self.connect()?;
        let roots: Vec<String> = conn
            .prepare("SELECT path FROM root_folders")
            .map_err(|e| e.to_string())?
            .query_map([], |r| r.get(0))
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .collect();

        let mut stmt = conn
            .prepare(
                "SELECT id, file_path, folder_path, artist_key, artist_name,
                        album_key, album_title, title, track_no, disc_no,
                        duration_sec, year, format, size_bytes, cover_key FROM tracks",
            )
            .map_err(|e| e.to_string())?;

        let tracks: Vec<TrackRecord> = stmt
            .query_map([], |row| {
                Ok(TrackRecord {
                    id: row.get(0)?,
                    file_path: row.get(1)?,
                    folder_path: row.get(2)?,
                    artist_key: row.get(3)?,
                    artist_name: row.get(4)?,
                    album_key: row.get(5)?,
                    album_title: row.get(6)?,
                    title: row.get(7)?,
                    track_no: row.get(8)?,
                    disc_no: row.get(9)?,
                    duration_sec: row.get(10)?,
                    year: row.get(11)?,
                    format: row.get(12)?,
                    size_bytes: row.get::<_, i64>(13)? as u64,
                    cover_key: row.get(14)?,
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .collect();

        let count = tracks.len();
        let payload = CatalogExport {
            version: "1.0.0".to_string(),
            roots,
            tracks,
        };
        let json_str = serde_json::to_string_pretty(&payload).map_err(|e| e.to_string())?;
        std::fs::write(target_file, json_str).map_err(|e| e.to_string())?;
        Ok(count)
    }

    pub fn import_catalog_json(&self, source_file: &Path) -> Result<usize, String> {
        let content = std::fs::read_to_string(source_file).map_err(|e| e.to_string())?;
        let payload: CatalogExport = serde_json::from_str(&content).map_err(|e| e.to_string())?;
        for r in &payload.roots {
            self.add_root_folder(r)?;
        }
        let batch: Vec<(ParsedTrackInfo, u64, u32)> = payload
            .tracks
            .into_iter()
            .map(|t| {
                (
                    ParsedTrackInfo {
                        artist_name: t.artist_name,
                        artist_key: t.artist_key,
                        album_title: t.album_title,
                        album_key: t.album_key,
                        track_title: t.title,
                        track_no: t.track_no,
                        disc_no: t.disc_no,
                        year: t.year,
                        format: t.format,
                        cover_key: t.cover_key,
                        folder_path: t.folder_path,
                        file_path: t.file_path,
                    },
                    t.size_bytes,
                    t.duration_sec,
                )
            })
            .collect();
        let count = batch.len();
        self.upsert_tracks_batch(&batch)?;
        Ok(count)
    }
}