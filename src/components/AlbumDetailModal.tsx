import React, { useEffect } from "react";
import { Play, Shuffle, ListPlus, X, Disc } from "lucide-react";
import { AlbumSummary, useLibraryStore } from "../store/useLibraryStore";
import { useCoverStore } from "../store/useCoverStore";
import { useAudioStore } from "../store/useAudioStore";

export const AlbumDetailModal: React.FC<{ album: AlbumSummary | null; onClose: () => void }> = ({ album, onClose }) => {
  const { activeAlbumTracks, selectAlbum } = useLibraryStore();
  const { urls, bios, requestCover } = useCoverStore();
  const { playTracks, appendTracks, setShuffle, current_track } = useAudioStore();

  useEffect(() => {
    if (album) {
      selectAlbum(album.artist_key, album.album_key);
      requestCover({
        coverKey: album.cover_key,
        folderPath: album.folder_path,
        artistName: album.artist_name,
        albumTitle: album.title,
      });
    }
  }, [album, selectAlbum, requestCover]);

  if (!album) return null;
  const coverUrl = urls[album.cover_key];
  const bio = bios[album.cover_key];

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(4, 6, 10, 0.78)", backdropFilter: "blur(16px)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 150, padding: 32 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: "min(900px, 94vw)", maxHeight: "82vh", background: "rgba(16, 19, 28, 0.96)", border: "1px solid rgba(0, 210, 255, 0.35)", borderRadius: 16, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <div style={{ display: "flex", gap: 24, padding: 24, borderBottom: "1px solid var(--border-subtle)", position: "relative" }}>
          <div style={{ width: 160, height: 160, borderRadius: 12, overflow: "hidden", background: "rgba(255,255,255,0.05)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            {coverUrl ? <img src={coverUrl} alt={album.title} style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <Disc size={56} color="#00d2ff" />}
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ color: "#00d2ff", fontSize: 13, fontWeight: 700 }}>{album.artist_name}</div>
            <h2 style={{ fontSize: 24, fontWeight: 800, marginTop: 4 }}>{album.title}</h2>
            {bio && <p style={{ fontSize: 12, color: "#d1d5db", marginTop: 8, maxHeight: 52, overflowY: "auto" }}>{bio}</p>}
            <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
              <button onClick={() => playTracks(activeAlbumTracks, 0)} style={{ background: "#00d2ff", color: "#000", border: "none", padding: "8px 16px", borderRadius: 8, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}><Play size={14} /> Tout lire</button>
              <button onClick={() => { setShuffle(true); playTracks(activeAlbumTracks, 0); }} style={{ background: "rgba(255,255,255,0.1)", color: "#fff", border: "none", padding: "8px 14px", borderRadius: 8, cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}><Shuffle size={14} /> Aléatoire</button>
              <button onClick={() => appendTracks(activeAlbumTracks)} style={{ background: "rgba(255,255,255,0.1)", color: "#fff", border: "none", padding: "8px 14px", borderRadius: 8, cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}><ListPlus size={14} /> + File</button>
            </div>
          </div>
          <button onClick={onClose} style={{ position: "absolute", top: 16, right: 16, background: "transparent", border: "none", color: "#fff", cursor: "pointer" }}><X size={18} /></button>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "12px 24px" }}>
          {activeAlbumTracks.map((t, idx) => (
            <div key={t.id} onClick={() => playTracks(activeAlbumTracks, idx)} style={{ display: "flex", justifyContent: "space-between", padding: "8px 6px", borderBottom: "1px solid rgba(255,255,255,0.04)", cursor: "pointer", color: current_track?.id === t.id ? "#00d2ff" : "#fff" }}>
              <span>{t.disc_no > 1 ? `CD${t.disc_no}-` : ""}{String(t.track_no || idx + 1).padStart(2, "0")}. {t.title}</span>
              <span style={{ color: "#00d2ff", fontSize: 11, fontWeight: 700 }}>{t.format}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};