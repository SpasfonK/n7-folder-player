use deunicode::deunicode;
use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Component, Path};

static RE_NON_ALNUM: Lazy<Regex> = Lazy::new(|| Regex::new(r"[^a-z0-9]+").unwrap());
static RE_DISC_FOLDER: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)^(?:cd|disc|disque|disk|vol\.?|volume)\s*0*([1-9][0-9]?)(?:\b|\s*[-_:]\s*(.*))?$").unwrap()
});
static RE_PURE_YEAR: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"^[\[\(\s]*(19\d{2}|20\d{2})[\]\)\s]*$").unwrap()
});
static RE_YEAR_PREFIX: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"^[\[\(]?(19\d{2}|20\d{2})[\]\)]?\s*[-_–—.]+\s*(.+)$").unwrap()
});
static RE_YEAR_SUFFIX: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"^(.+?)\s*[\[\(](19\d{2}|20\d{2})[\]\)]$").unwrap()
});
static RE_FEAT_SPLIT: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)\s+(?:feat\.?|ft\.?|featuring|avec|vs\.?)\s+(.+)$").unwrap()
});
static RE_TRACK_FILENAME: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"^(?:(\d{1,2})[-_.](\d{1,3})|(\d{1,3}))\s*[-_–—.\s]+\s*(.+)$").unwrap()
});

const GENERIC_CONTAINERS: &[&str] = &[
    "musique", "music", "audio", "sons", "mp3", "flac", "wav", "ogg", "m4a", "alac",
    "lossless", "hires", "rock", "metal", "hardrock", "heavy", "hardcore", "pop",
    "jazz", "electro", "classique", "classical", "rap", "hiphop", "chanson",
    "francaise", "variete", "compilations", "albums", "artistes", "artists",
    "downloads", "telechargements", "nas", "share", "public", "media", "library",
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ParsedTrackInfo {
    pub artist_name: String,
    pub artist_key: String,
    pub album_title: String,
    pub album_key: String,
    pub track_title: String,
    pub track_no: u32,
    pub disc_no: u32,
    pub year: Option<u32>,
    pub format: String,
    pub cover_key: String,
    pub folder_path: String,
    pub file_path: String,
}

pub fn keyify(input: &str) -> String {
    let ascii = deunicode(input).to_lowercase();
    let cleaned = RE_NON_ALNUM.replace_all(&ascii, "");
    cleaned.trim().to_string()
}

pub fn is_generic_folder(segment: &str) -> bool {
    let trimmed = segment.trim();
    if trimmed.is_empty() || RE_PURE_YEAR.is_match(trimmed) {
        return true;
    }
    let k = keyify(trimmed);
    if k.is_empty() {
        return true;
    }
    if k.len() <= 2 && (k.chars().all(|c| c.is_ascii_digit()) || k.len() == 1) {
        return true;
    }
    GENERIC_CONTAINERS.contains(&k.as_str())
}

fn extract_year_and_clean(raw: &str) -> (String, Option<u32>) {
    let trimmed = raw.trim();
    if let Some(caps) = RE_YEAR_PREFIX.captures(trimmed) {
        let yr = caps.get(1).and_then(|m| m.as_str().parse::<u32>().ok());
        let rest = caps.get(2).map(|m| m.as_str().trim().to_string()).unwrap_or_default();
        if !rest.is_empty() {
            return (rest, yr);
        }
    }
    if let Some(caps) = RE_YEAR_SUFFIX.captures(trimmed) {
        let rest = caps.get(1).map(|m| m.as_str().trim().to_string()).unwrap_or_default();
        let yr = caps.get(2).and_then(|m| m.as_str().parse::<u32>().ok());
        if !rest.is_empty() {
            return (rest, yr);
        }
    }
    (trimmed.to_string(), None)
}

fn split_hyphen_pair(s: &str) -> Option<(String, String)> {
    let normalized = s.replace('–', "-").replace('—', "-");
    if let Some(idx) = normalized.find(" - ") {
        let left = normalized[..idx].trim().to_string();
        let right = normalized[idx + 3..].trim().to_string();
        if !left.is_empty() && !right.is_empty() {
            return Some((left, right));
        }
    }
    None
}

fn strip_collaborators(artist_raw: &str) -> (String, Option<String>) {
    if let Some(caps) = RE_FEAT_SPLIT.captures(artist_raw) {
        if let Some(m) = caps.get(0) {
            let base = artist_raw[..m.start()].trim().to_string();
            let guest = caps.get(1).map(|g| g.as_str().trim().to_string());
            if !base.is_empty() {
                return (base, guest);
            }
        }
    }
    (artist_raw.trim().to_string(), None)
}

pub fn compute_cover_key(artist_key: &str, album_key: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(format!("{}::{}", artist_key, album_key).as_bytes());
    let digest = hex::encode(hasher.finalize());
    digest[..16].to_string()
}

pub fn parse_track_path(file_path: &Path, root_path: Option<&Path>) -> ParsedTrackInfo {
    let rel_path = match root_path {
        Some(root) => file_path.strip_prefix(root).unwrap_or(file_path),
        None => file_path,
    };

    let mut segments: Vec<String> = Vec::new();
    for comp in rel_path.components() {
        if let Component::Normal(os) = comp {
            segments.push(os.to_string_lossy().to_string());
        }
    }

    let file_name = segments.pop().unwrap_or_else(|| "Unknown.mp3".to_string());
    let format = Path::new(&file_name)
        .extension()
        .map(|e| e.to_string_lossy().to_uppercase())
        .unwrap_or_else(|| "AUDIO".to_string());
    let file_stem = Path::new(&file_name)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| file_name.clone());

    let mut detected_year: Option<u32> = None;
    let mut meaningful_dirs: Vec<String> = Vec::new();

    for dir in segments {
        if let Some(caps) = RE_PURE_YEAR.captures(dir.trim()) {
            if let Some(yr) = caps.get(1).and_then(|m| m.as_str().parse::<u32>().ok()) {
                detected_year = Some(yr);
            }
            continue;
        }
        if is_generic_folder(&dir) {
            continue;
        }
        meaningful_dirs.push(dir);
    }

    let mut disc_no: u32 = 1;
    if let Some(last_dir) = meaningful_dirs.last().cloned() {
        if let Some(caps) = RE_DISC_FOLDER.captures(&last_dir) {
            disc_no = caps
                .get(1)
                .and_then(|m| m.as_str().parse::<u32>().ok())
                .unwrap_or(1);
            meaningful_dirs.pop();
        }
    }

    let mut raw_artist = String::from("Artiste Inconnu");
    let mut raw_album = String::from("Single / Divers");

    if meaningful_dirs.len() >= 2 {
        let parent_dir = meaningful_dirs[meaningful_dirs.len() - 2].clone();
        let leaf_dir = meaningful_dirs[meaningful_dirs.len() - 1].clone();

        let (parent_clean, yr1) = extract_year_and_clean(&parent_dir);
        let (leaf_clean, yr2) = extract_year_and_clean(&leaf_dir);
        if yr2.is_some() {
            detected_year = yr2;
        } else if yr1.is_some() {
            detected_year = yr1;
        }

        raw_artist = parent_clean.clone();
        raw_album = leaf_clean.clone();

        if let Some((left, right)) = split_hyphen_pair(&leaf_clean) {
            if keyify(&left) == keyify(&parent_clean) {
                raw_album = right;
            } else if let Some(yr) = RE_PURE_YEAR
                .captures(&left)
                .and_then(|c| c.get(1))
                .and_then(|m| m.as_str().parse::<u32>().ok())
            {
                detected_year = Some(yr);
                raw_album = right;
            }
        }
    } else if meaningful_dirs.len() == 1 {
        let only_dir = meaningful_dirs[0].clone();
        let (cleaned_dir, yr) = extract_year_and_clean(&only_dir);
        if yr.is_some() {
            detected_year = yr;
        }

        if let Some((left, right)) = split_hyphen_pair(&cleaned_dir) {
            let (left_clean, yr_left) = extract_year_and_clean(&left);
            if yr_left.is_some() {
                detected_year = yr_left;
            }
            raw_artist = left_clean;
            raw_album = right;
        } else {
            raw_artist = cleaned_dir.clone();
            raw_album = cleaned_dir;
        }
    }

    let (album_final, yr_alb) = extract_year_and_clean(&raw_album);
    if detected_year.is_none() && yr_alb.is_some() {
        detected_year = yr_alb;
    }
    raw_album = album_final;

    let (clean_artist, mut featured_guest) = strip_collaborators(&raw_artist);
    raw_artist = clean_artist;

    let mut track_no: u32 = 0;
    let mut raw_title = file_stem.trim().to_string();

    if let Some(caps) = RE_TRACK_FILENAME.captures(&raw_title) {
        if let (Some(d_match), Some(t_match)) = (caps.get(1), caps.get(2)) {
            if disc_no == 1 {
                disc_no = d_match.as_str().parse::<u32>().unwrap_or(1);
            }
            track_no = t_match.as_str().parse::<u32>().unwrap_or(0);
        } else if let Some(t_match) = caps.get(3) {
            track_no = t_match.as_str().parse::<u32>().unwrap_or(0);
        }
        if let Some(rest) = caps.get(4) {
            raw_title = rest.as_str().trim().to_string();
        }
    }

    if let Some((left, right)) = split_hyphen_pair(&raw_title) {
        let (left_base, guest_in_file) = strip_collaborators(&left);
        if keyify(&left_base) == keyify(&raw_artist) {
            raw_title = right;
            if guest_in_file.is_some() {
                featured_guest = guest_in_file;
            }
        } else if raw_artist == "Artiste Inconnu" {
            raw_artist = left_base;
            raw_title = right;
            if guest_in_file.is_some() {
                featured_guest = guest_in_file;
            }
        }
    }

    if let Some(guest) = featured_guest {
        let lower_title = raw_title.to_lowercase();
        if !lower_title.contains("feat") && !lower_title.contains(&guest.to_lowercase()) {
            raw_title = format!("{} (feat. {})", raw_title, guest);
        }
    }

    let mut artist_key = keyify(&raw_artist);
    if artist_key.is_empty() {
        raw_artist = "Artiste Inconnu".to_string();
        artist_key = "artisteinconnu".to_string();
    }

    let mut album_key = keyify(&raw_album);
    if album_key.is_empty() {
        raw_album = "Album Inconnu".to_string();
        album_key = "albuminconnu".to_string();
    }

    let cover_key = compute_cover_key(&artist_key, &album_key);
    let folder_path = file_path
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();

    ParsedTrackInfo {
        artist_name: raw_artist,
        artist_key,
        album_title: raw_album,
        album_key,
        track_title: raw_title,
        track_no,
        disc_no,
        year: detected_year,
        format,
        cover_key,
        folder_path,
        file_path: file_path.to_string_lossy().to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn test_keyify_accent_and_case_normalization() {
        assert_eq!(keyify("Angèle"), "angele");
        assert_eq!(keyify("Angele"), "angele");
        assert_eq!(keyify("ANGÈLE"), "angele");
        assert_eq!(keyify("Mylène Farmer"), "mylenefarmer");
    }

    #[test]
    fn test_saez_nested_and_flat_pruning() {
        let root = Path::new(r"D:\Musique");
        let p1 = Path::new(r"D:\Musique\Saez\Saez - Debbie\01 - Jeune et con.mp3");
        let r1 = parse_track_path(p1, Some(root));
        assert_eq!(r1.artist_name, "Saez");
        assert_eq!(r1.album_title, "Debbie");

        let p2 = Path::new(r"D:\Musique\Saez - Debbie\02 - Sauver cette étoile.flac");
        let r2 = parse_track_path(p2, Some(root));
        assert_eq!(r2.artist_name, "Saez");
        assert_eq!(r2.album_title, "Debbie");
    }

    #[test]
    fn test_year_prefix_never_becomes_artist() {
        let root = Path::new(r"D:\Musique\1\Rock");
        let p = Path::new(r"D:\Musique\1\Rock\1970 - Black Sabbath\01 - Black Sabbath.flac");
        let res = parse_track_path(p, Some(root));
        assert_eq!(res.year, Some(1970));
        assert_eq!(res.artist_name, "Black Sabbath");
        assert_ne!(res.artist_name, "1970");
    }

    #[test]
    fn test_multi_cd_merged_into_parent_album() {
        let root = Path::new(r"\\NAS\Musique");
        let cd1 = Path::new(r"\\NAS\Musique\Gojira\From Mars to Sirius\CD1\01 - Ocean Planet.flac");
        let cd2 = Path::new(r"\\NAS\Musique\Gojira\From Mars to Sirius\CD2\01 - From Mars.flac");
        let r1 = parse_track_path(cd1, Some(root));
        let r2 = parse_track_path(cd2, Some(root));
        assert_eq!(r1.album_key, r2.album_key);
        assert_eq!(r1.disc_no, 1);
        assert_eq!(r2.disc_no, 2);
    }
}