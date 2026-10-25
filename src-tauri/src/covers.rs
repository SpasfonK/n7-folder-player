use crate::to_windows_long_path;
use image::imageops::FilterType;
use lofty::file::TaggedFileExt;
use lofty::probe::Probe;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

const LOCAL_COVER_CANDIDATES: &[&str] = &[
    "cover.jpg", "cover.jpeg", "cover.png", "cover.webp",
    "folder.jpg", "folder.jpeg", "folder.png", "front.jpg", "artwork.jpg", "album.jpg",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CoverResolution {
    pub cover_key: String,
    pub local_cache_path: Option<String>,
    pub source_tier: String,
    pub album_bio: Option<String>,
}

#[derive(Deserialize)]
struct AudioDbAlbumResponse { album: Option<Vec<AudioDbAlbumItem>> }

#[derive(Deserialize)]
struct AudioDbAlbumItem {
    #[serde(rename = "strAlbumThumb")] str_album_thumb: Option<String>,
    #[serde(rename = "strDescriptionFR")] str_description_fr: Option<String>,
    #[serde(rename = "strDescriptionEN")] str_description_en: Option<String>,
}

pub fn resolve_album_cover(
    cache_dir: &Path, cover_key: &str, folder_path: &str, sample_audio_file: Option<&str>,
    artist_name: &str, album_title: &str, allow_online_fallback: bool,
) -> CoverResolution {
    let cached_webp = cache_dir.join(format!("{}.webp", cover_key));
    let cached_bio_txt = cache_dir.join(format!("{}.txt", cover_key));
    let existing_bio = fs::read_to_string(&cached_bio_txt).ok();

    if cached_webp.exists() {
        return CoverResolution {
            cover_key: cover_key.to_string(),
            local_cache_path: Some(cached_webp.to_string_lossy().to_string()),
            source_tier: "cache".to_string(),
            album_bio: existing_bio,
        };
    }

    let dir_path = to_windows_long_path(Path::new(folder_path));
    if let Some(local_img_path) = find_local_folder_image(&dir_path) {
        if let Ok(bytes) = fs::read(&local_img_path) {
            if save_resized_webp(&bytes, &cached_webp).is_ok() {
                return CoverResolution {
                    cover_key: cover_key.to_string(),
                    local_cache_path: Some(cached_webp.to_string_lossy().to_string()),
                    source_tier: "folder".to_string(),
                    album_bio: existing_bio,
                };
            }
        }
    }

    let audio_candidate = sample_audio_file.map(PathBuf::from).or_else(|| find_first_audio_in_dir(&dir_path));
    if let Some(audio_path) = audio_candidate {
        let long_audio = to_windows_long_path(&audio_path);
        if let Some(pic_bytes) = extract_embedded_picture(&long_audio) {
            if save_resized_webp(&pic_bytes, &cached_webp).is_ok() {
                return CoverResolution {
                    cover_key: cover_key.to_string(),
                    local_cache_path: Some(cached_webp.to_string_lossy().to_string()),
                    source_tier: "embedded".to_string(),
                    album_bio: existing_bio,
                };
            }
        }
    }

    if allow_online_fallback && artist_name != "Artiste Inconnu" {
        if let Some((img_bytes, bio)) = fetch_from_theaudiodb(artist_name, album_title) {
            if let Some(ref b) = bio { let _ = fs::write(&cached_bio_txt, b); }
            if let Some(bytes) = img_bytes {
                if save_resized_webp(&bytes, &cached_webp).is_ok() {
                    return CoverResolution {
                        cover_key: cover_key.to_string(),
                        local_cache_path: Some(cached_webp.to_string_lossy().to_string()),
                        source_tier: "theaudiodb".to_string(),
                        album_bio: bio,
                    };
                }
            }
        }
    }

    CoverResolution {
        cover_key: cover_key.to_string(), local_cache_path: None,
        source_tier: "none".to_string(), album_bio: existing_bio,
    }
}

fn find_local_folder_image(dir: &Path) -> Option<PathBuf> {
    for candidate in LOCAL_COVER_CANDIDATES {
        let p = dir.join(candidate);
        if p.is_file() { return Some(p); }
    }
    None
}

fn find_first_audio_in_dir(dir: &Path) -> Option<PathBuf> {
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_file() {
                if let Some(ext) = p.extension().and_then(|e| e.to_str()) {
                    if ["mp3", "flac", "m4a", "ogg", "wav"].contains(&ext.to_ascii_lowercase().as_str()) {
                        return Some(p);
                    }
                }
            }
        }
    }
    None
}

fn extract_embedded_picture(audio_path: &Path) -> Option<Vec<u8>> {
    let tagged_file = Probe::open(audio_path).ok()?.read().ok()?;
    for tag in tagged_file.tags() {
        if let Some(pic) = tag.pictures().first() { return Some(pic.data().to_vec()); }
    }
    None
}

fn save_resized_webp(raw_bytes: &[u8], target_webp: &Path) -> Result<(), String> {
    let img = image::load_from_memory(raw_bytes).map_err(|e| e.to_string())?;
    let thumb = img.resize_to_fill(320, 320, FilterType::Triangle);
    thumb.save_with_format(target_webp, image::ImageFormat::WebP).map_err(|e| e.to_string())
}

fn fetch_from_theaudiodb(artist: &str, album: &str) -> Option<(Option<Vec<u8>>, Option<String>)> {
    let client = reqwest::blocking::Client::builder().timeout(Duration::from_secs(4)).build().ok()?;
    let url = format!("https://www.theaudiodb.com/api/v1/json/2/searchalbum.php?s={}&a={}",
        urlencoding_simple(artist), urlencoding_simple(album));
    let resp: AudioDbAlbumResponse = client.get(&url).send().ok()?.json().ok()?;
    let item = resp.album?.into_iter().next()?;
    let bio = item.str_description_fr.filter(|s| !s.trim().is_empty()).or(item.str_description_en);
    let img_bytes = item.str_album_thumb.filter(|u| !u.trim().is_empty())
        .and_then(|u| client.get(&u).send().ok())
        .and_then(|r| r.bytes().ok()).map(|b| b.to_vec());
    Some((img_bytes, bio))
}

fn urlencoding_simple(input: &str) -> String {
    let mut out = String::new();
    for b in input.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' => out.push(b as char),
            b' ' => out.push_str("%20"),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}