import React, { useEffect, useRef } from "react";
import { Play, Pause, SkipBack, SkipForward, Shuffle, Repeat, Volume2, Sliders, PictureInPicture2, Disc } from "lucide-react";
import { useAudioStore, EQ_PRESETS } from "../store/useAudioStore";
import { useCoverStore } from "../store/useCoverStore";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";

const EQ_LABELS = ["31", "62", "125", "250", "500", "1k", "2k", "4k", "8k", "16k"];

export const DockedPlayer: React.FC = () => {
  const {
    is_playing, position_sec, duration_sec, volume, shuffle, current_track,
    eq, spectrum, waveform, vizMode, showEqModal, isMiniPlayer,
    togglePlay, next, prev, seek, setVolume, toggleShuffle, cycleRepeat,
    applyEq, selectPreset, pollTelemetry, setVizMode, setShowEqModal, setMiniPlayer,
  } = useAudioStore();

  const { urls, requestCover } = useCoverStore();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const timer = setInterval(() => pollTelemetry(), 35);
    return () => clearInterval(timer);
  }, [pollTelemetry]);

  useEffect(() => {
    if (current_track) {
      requestCover({
        coverKey: current_track.cover_key,
        folderPath: current_track.folder_path,
        artistName: current_track.artist_name,
        albumTitle: current_track.album_title,
      });
    }
  }, [current_track, requestCover]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (vizMode === "spectrum") {
      const bw = canvas.width / 64;
      ctx.fillStyle = "#00d2ff";
      for (let i = 0; i < 64; i++) {
        const bh = Math.max(2, (spectrum[i] || 0) * (canvas.height - 4));
        ctx.fillRect(i * bw, canvas.height - bh, Math.max(1, bw - 1), bh);
      }
    } else {
      ctx.beginPath();
      ctx.strokeStyle = "#00d2ff";
      for (let i = 0; i < 64; i++) {
        const x = (i / 63) * canvas.width;
        const y = canvas.height / 2 + (waveform[i] || 0) * (canvas.height * 0.4);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  }, [spectrum, waveform, vizMode]);

  const toggleMiniPlayerWindow = async () => {
    const win = getCurrentWindow();
    const nextMini = !isMiniPlayer;
    setMiniPlayer(nextMini);
    if (nextMini) {
      await win.setAlwaysOnTop(true);
      await win.setSize(new LogicalSize(480, 145));
    } else {
      await win.setAlwaysOnTop(false);
      await win.setSize(new LogicalSize(1440, 900));
    }
  };

  const coverUrl = current_track ? urls[current_track.cover_key] : null;

  return (
    <>
      {showEqModal && (
        <div style={{ position: "fixed", bottom: 96, right: 24, width: 480, background: "rgba(14, 16, 24, 0.96)", border: "1px solid #00d2ff", borderRadius: 12, padding: 16, zIndex: 200 }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12 }}>
            <strong>Égaliseur 10 Bandes</strong>
            <div style={{ display: "flex", gap: 4 }}>
              {Object.keys(EQ_PRESETS).map((name) => (
                <button key={name} onClick={() => selectPreset(name)} style={{ background: eq.preset_name === name ? "#00d2ff" : "rgba(255,255,255,0.1)", color: eq.preset_name === name ? "#000" : "#fff", border: "none", borderRadius: 4, padding: "2px 6px", fontSize: 10, cursor: "pointer" }}>{name}</button>
              ))}
            </div>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", height: 120 }}>
            {eq.bands_db.map((dbVal, idx) => (
              <div key={EQ_LABELS[idx]} style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
                <input type="range" min={-12} max={12} step={0.5} value={dbVal} onChange={(e) => {
                  const nextBands = [...eq.bands_db];
                  nextBands[idx] = parseFloat(e.target.value);
                  applyEq({ ...eq, bands_db: nextBands, preset_name: "Custom" });
                }} style={{ writingMode: "vertical-lr", direction: "rtl", height: 80 }} />
                <span style={{ fontSize: 10, marginTop: 4 }}>{EQ_LABELS[idx]}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <footer style={{ height: 86, background: "rgba(10, 11, 16, 0.95)", borderTop: "1px solid rgba(255,255,255,0.1)", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 18px", gap: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 240 }}>
          <div style={{ width: 52, height: 52, borderRadius: 8, overflow: "hidden", background: "rgba(255,255,255,0.06)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            {coverUrl ? <img src={coverUrl} alt="Cover" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <Disc size={24} color="#00d2ff" />}
          </div>
          <div>
            <div style={{ fontWeight: 600, fontSize: 13 }}>{current_track ? current_track.title : "Prêt"}</div>
            <div style={{ fontSize: 11, color: "#9ca3af" }}>{current_track ? `${current_track.artist_name} — ${current_track.album_title}` : "Sélectionnez un titre"}</div>
          </div>
        </div>

        <div style={{ flex: 1, maxWidth: 520, display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <button onClick={toggleShuffle} style={{ background: "transparent", border: "none", color: shuffle ? "#00d2ff" : "#9ca3af", cursor: "pointer" }}><Shuffle size={15} /></button>
            <button onClick={prev} style={{ background: "transparent", border: "none", color: "#fff", cursor: "pointer" }}><SkipBack size={18} /></button>
            <button onClick={togglePlay} style={{ width: 36, height: 36, borderRadius: "50%", background: "#00d2ff", color: "#000", border: "none", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>{is_playing ? <Pause size={17} /> : <Play size={17} />}</button>
            <button onClick={next} style={{ background: "transparent", border: "none", color: "#fff", cursor: "pointer" }}><SkipForward size={18} /></button>
            <button onClick={cycleRepeat} style={{ background: "transparent", border: "none", color: "#9ca3af", cursor: "pointer" }}><Repeat size={15} /></button>
          </div>
          <input type="range" min={0} max={duration_sec > 0 ? duration_sec : 100} step={0.2} value={position_sec} onChange={(e) => seek(parseFloat(e.target.value))} style={{ width: "100%", accentColor: "#00d2ff" }} />
        </div>

        {!isMiniPlayer && (
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <canvas ref={canvasRef} width={120} height={40} onClick={() => setVizMode(vizMode === "spectrum" ? "oscilloscope" : "spectrum")} style={{ background: "rgba(0,0,0,0.4)", borderRadius: 6, cursor: "pointer" }} />
            <button onClick={() => setShowEqModal(!showEqModal)} style={{ background: "rgba(255,255,255,0.08)", color: "#fff", border: "none", borderRadius: 6, padding: "6px 10px", cursor: "pointer" }}><Sliders size={14} /></button>
            <Volume2 size={16} color="#9ca3af" />
            <input type="range" min={0} max={1} step={0.01} value={volume} onChange={(e) => setVolume(parseFloat(e.target.value))} style={{ width: 80, accentColor: "#00d2ff" }} />
            <button onClick={toggleMiniPlayerWindow} style={{ background: "transparent", border: "1px solid var(--border-subtle)", color: "#9ca3af", borderRadius: 6, padding: 6, cursor: "pointer" }}><PictureInPicture2 size={14} /></button>
          </div>
        )}
      </footer>
    </>
  );
};