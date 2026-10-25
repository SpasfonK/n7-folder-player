import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Play, Shuffle, ListPlus, Disc, ZoomIn, ZoomOut, Maximize2 } from "lucide-react";
import { ArtistSummary, AlbumSummary, TrackRecord, useLibraryStore } from "../store/useLibraryStore";
import { useCoverStore } from "../store/useCoverStore";
import { useAudioStore } from "../store/useAudioStore";

interface SpatialNode {
  artist: ArtistSummary;
  albums: AlbumSummary[];
  x: number;
  y: number;
  width: number;
  height: number;
}

const CELL_W = 430;
const CELL_H = 295;

export const SpatialSurface2D: React.FC<{
  JumpToLetterRef: React.MutableRefObject<((letter: string) => void) | null>;
  onOpenAlbumDetail: (album: AlbumSummary) => void;
}> = ({ JumpToLetterRef, onOpenAlbumDetail }) => {
  const { artists, albums, searchQuery } = useLibraryStore();
  const { urls, requestCover } = useCoverStore();
  const { playTracks, appendTracks, setShuffle } = useAudioStore();

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const camRef = useRef({
    x: 0, y: 0, zoom: 0.85,
    targetX: null as number | null, targetY: null as number | null, targetZoom: null as number | null,
    vx: 0, vy: 0, isDragging: false, lastMouseX: 0, lastMouseY: 0,
  });

  const [renderCam, setRenderCam] = useState({ x: 0, y: 0, zoom: 0.85 });
  const [viewportSize, setViewportSize] = useState({ w: 1280, h: 720 });
  const [hoveredArtistKey, setHoveredArtistKey] = useState<string | null>(null);

  const { nodes, letterAnchors } = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const filtered = q ? artists.filter((a) => a.display_name.toLowerCase().includes(q)) : artists;
    const albumsByArtist = new Map<string, AlbumSummary[]>();
    for (const alb of albums) {
      const list = albumsByArtist.get(alb.artist_key) || [];
      list.push(alb);
      albumsByArtist.set(alb.artist_key, list);
    }

    const total = Math.max(1, filtered.length);
    const cols = Math.max(4, Math.ceil(Math.sqrt(total * 1.45)));
    const computedNodes: SpatialNode[] = [];
    const anchorsMap = new Map<string, { letter: string; x: number; y: number }>();

    filtered.forEach((artist, index) => {
      const col = index % cols;
      const row = Math.floor(index / cols);
      const x = (col - cols / 2) * CELL_W + (row % 2 === 1 ? CELL_W * 0.35 : 0);
      const y = (row - Math.ceil(total / cols) / 2) * CELL_H;
      computedNodes.push({
        artist,
        albums: albumsByArtist.get(artist.artist_key) || [],
        x, y, width: 390, height: 255,
      });
      if (!anchorsMap.has(artist.first_letter)) {
        anchorsMap.set(artist.first_letter, { letter: artist.first_letter, x, y });
      }
    });

    return { nodes: computedNodes, letterAnchors: Array.from(anchorsMap.values()) };
  }, [artists, albums, searchQuery]);

  useEffect(() => {
    JumpToLetterRef.current = (letter: string) => {
      const anchor = letterAnchors.find((a) => a.letter === letter);
      if (anchor) {
        camRef.current.targetX = -anchor.x;
        camRef.current.targetY = -anchor.y;
        camRef.current.targetZoom = Math.max(camRef.current.zoom, 1.15);
        camRef.current.vx = 0; camRef.current.vy = 0;
      }
    };
  }, [letterAnchors, JumpToLetterRef]);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setViewportSize({ w: entry.contentRect.width, h: entry.contentRect.height });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    let animId: number;
    const tick = () => {
      const c = camRef.current;
      if (c.targetX !== null && c.targetY !== null) {
        c.x += (c.targetX - c.x) * 0.14;
        c.y += (c.targetY - c.y) * 0.14;
        if (c.targetZoom !== null) c.zoom += (c.targetZoom - c.zoom) * 0.14;
        if (Math.abs(c.targetX - c.x) < 1.5 && Math.abs(c.targetY - c.y) < 1.5) {
          c.targetX = null; c.targetY = null; c.targetZoom = null;
        }
      } else if (!c.isDragging) {
        if (Math.abs(c.vx) > 0.08 || Math.abs(c.vy) > 0.08) {
          c.x += c.vx; c.y += c.vy; c.vx *= 0.91; c.vy *= 0.91;
        } else { c.vx = 0; c.vy = 0; }
      }

      const canvas = canvasRef.current;
      if (canvas) {
        const ctx = canvas.getContext("2d");
        if (ctx) {
          const { w, h } = viewportSize;
          ctx.clearRect(0, 0, w, h);
          ctx.save();
          ctx.font = `800 ${Math.round(140 * c.zoom)}px "Segoe UI", sans-serif`;
          ctx.fillStyle = "rgba(0, 210, 255, 0.06)";
          for (const anchor of letterAnchors) {
            const sx = w / 2 + (anchor.x + c.x) * c.zoom;
            const sy = h / 2 + (anchor.y + c.y) * c.zoom;
            if (sx > -300 && sx < w + 300 && sy > -300 && sy < h + 300) {
              ctx.fillText(anchor.letter, sx - 50 * c.zoom, sy);
            }
          }
          ctx.restore();
        }
      }
      setRenderCam({ x: c.x, y: c.y, zoom: c.zoom });
      animId = requestAnimationFrame(tick);
    };
    animId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animId);
  }, [viewportSize, letterAnchors]);

  const visibleNodes = useMemo(() => {
    const { w, h } = viewportSize;
    const { x, y, zoom } = renderCam;
    const margin = 340;
    return nodes.filter((n) => {
      const sx = w / 2 + (n.x + x) * zoom;
      const sy = h / 2 + (n.y + y) * zoom;
      return sx + n.width * zoom > -margin && sx - n.width * zoom < w + margin &&
             sy + n.height * zoom > -margin && sy - n.height * zoom < h + margin;
    });
  }, [nodes, viewportSize, renderCam]);

  useEffect(() => {
    if (renderCam.zoom < 0.95) return;
    for (const node of visibleNodes) {
      for (const alb of node.albums.slice(0, 6)) {
        requestCover({
          coverKey: alb.cover_key,
          folderPath: alb.folder_path,
          artistName: alb.artist_name,
          albumTitle: alb.title,
        });
      }
    }
  }, [visibleNodes, renderCam.zoom, requestCover]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const c = camRef.current;
    c.targetX = null; c.targetY = null; c.targetZoom = null;
    const rect = viewportRef.current?.getBoundingClientRect();
    const mouseX = rect ? e.clientX - rect.left - rect.width / 2 : 0;
    const mouseY = rect ? e.clientY - rect.top - rect.height / 2 : 0;
    const worldX = mouseX / c.zoom - c.x;
    const worldY = mouseY / c.zoom - c.y;
    const nextZoom = Math.min(3.2, Math.max(0.28, c.zoom * (e.deltaY < 0 ? 1.13 : 0.885)));
    c.zoom = nextZoom;
    c.x = mouseX / nextZoom - worldX;
    c.y = mouseY / nextZoom - worldY;
  }, []);

  const handleArtistAction = async (e: React.MouseEvent, artistKey: string, mode: "play" | "shuffle" | "queue") => {
    e.stopPropagation();
    const tracks = await invoke<TrackRecord[]>("get_artist_tracks", { artistKey });
    if (tracks.length === 0) return;
    if (mode === "queue") await appendTracks(tracks);
    else if (mode === "shuffle") {
      await setShuffle(true);
      await playTracks(tracks, Math.floor(Math.random() * tracks.length));
    } else await playTracks(tracks, 0);
  };

  const showCoversLayer = renderCam.zoom >= 0.95;

  return (
    <div
      ref={viewportRef}
      onMouseDown={(e) => {
        if (e.button !== 0) return;
        camRef.current.isDragging = true;
        camRef.current.targetX = null; camRef.current.targetY = null;
        camRef.current.lastMouseX = e.clientX; camRef.current.lastMouseY = e.clientY;
      }}
      onMouseMove={(e) => {
        if (!camRef.current.isDragging) return;
        const dx = (e.clientX - camRef.current.lastMouseX) / camRef.current.zoom;
        const dy = (e.clientY - camRef.current.lastMouseY) / camRef.current.zoom;
        camRef.current.x += dx; camRef.current.y += dy;
        camRef.current.vx = dx * 0.85; camRef.current.vy = dy * 0.85;
        camRef.current.lastMouseX = e.clientX; camRef.current.lastMouseY = e.clientY;
      }}
      onMouseUp={() => { camRef.current.isDragging = false; }}
      onMouseLeave={() => { camRef.current.isDragging = false; }}
      onWheel={handleWheel}
      style={{
        position: "relative", flex: 1, height: "100%", overflow: "hidden",
        cursor: camRef.current.isDragging ? "grabbing" : "grab",
        background: "radial-gradient(circle at 50% 50%, rgba(16, 24, 38, 0.92) 0%, rgba(8, 9, 13, 0.98) 100%)",
      }}
    >
      <canvas ref={canvasRef} width={viewportSize.w} height={viewportSize.h} style={{ position: "absolute", inset: 0, pointerEvents: "none" }} />
      <div style={{
        position: "absolute", left: "50%", top: "50%",
        transform: `translate3d(${renderCam.x * renderCam.zoom}px, ${renderCam.y * renderCam.zoom}px, 0) scale(${renderCam.zoom})`,
        transformOrigin: "0 0", willChange: "transform",
      }}>
        {visibleNodes.map((node) => {
          const { artist, albums: artAlbums } = node;
          const isHovered = hoveredArtistKey === artist.artist_key;
          const fontSize = Math.round(18 + artist.weight * 26);
          return (
            <div
              key={artist.artist_key}
              onMouseEnter={() => setHoveredArtistKey(artist.artist_key)}
              onMouseLeave={() => setHoveredArtistKey(null)}
              style={{
                position: "absolute", left: node.x, top: node.y, width: node.width, padding: "10px 14px",
                borderRadius: 12, background: isHovered || showCoversLayer ? "rgba(18, 21, 30, 0.78)" : "transparent",
                border: isHovered ? "1px solid rgba(0, 210, 255, 0.55)" : "1px solid transparent",
              }}
            >
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
                <span style={{
                  fontSize: `${fontSize}px`, fontWeight: artist.weight > 0.55 ? 800 : 600,
                  color: isHovered ? "#00d2ff" : "#f3f4f6",
                  textShadow: isHovered ? "0 0 18px rgba(0,210,255,0.6)" : "none",
                  whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                }}>
                  {artist.display_name}
                </span>
                <span style={{ fontSize: 11, color: "#00d2ff", fontWeight: 600 }}>
                  {artist.album_count} alb • {artist.track_count}
                </span>
              </div>

              {isHovered && (
                <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                  <button onClick={(e) => handleArtistAction(e, artist.artist_key, "play")} style={{ background: "#00d2ff", color: "#000", border: "none", borderRadius: 4, padding: "3px 7px", fontSize: 10, fontWeight: 700, cursor: "pointer" }}>
                    <Play size={10} /> Tout lire
                  </button>
                  <button onClick={(e) => handleArtistAction(e, artist.artist_key, "shuffle")} style={{ background: "rgba(255,255,255,0.14)", color: "#fff", border: "none", borderRadius: 4, padding: "3px 7px", fontSize: 10, cursor: "pointer" }}>
                    <Shuffle size={10} /> Aléatoire
                  </button>
                  <button onClick={(e) => handleArtistAction(e, artist.artist_key, "queue")} style={{ background: "rgba(255,255,255,0.14)", color: "#fff", border: "none", borderRadius: 4, padding: "3px 7px", fontSize: 10, cursor: "pointer" }}>
                    <ListPlus size={10} /> + File
                  </button>
                </div>
              )}

              {showCoversLayer && (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, marginTop: 8 }}>
                  {artAlbums.slice(0, 6).map((alb) => {
                    const cov = urls[alb.cover_key];
                    return (
                      <div
                        key={alb.album_key}
                        onClick={(e) => { e.stopPropagation(); onOpenAlbumDetail(alb); }}
                        style={{
                          position: "relative", aspectRatio: "1 / 1", borderRadius: 7, overflow: "hidden",
                          background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", cursor: "pointer",
                        }}
                      >
                        {cov ? (
                          <img src={cov} alt={alb.title} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                        ) : (
                          <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 4 }}>
                            <Disc size={20} color="#00d2ff" />
                            <span style={{ fontSize: 9, color: "#d1d5db", textAlign: "center" }}>{alb.title}</span>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div style={{ position: "absolute", bottom: 18, right: 18, display: "flex", alignItems: "center", gap: 6, background: "rgba(12, 14, 22, 0.88)", border: "1px solid var(--border-subtle)", padding: "6px 10px", borderRadius: 8 }}>
        <button onClick={() => { camRef.current.zoom = Math.max(0.3, camRef.current.zoom * 0.8); }} style={{ background: "transparent", border: "none", color: "#fff", cursor: "pointer" }}><ZoomOut size={15} /></button>
        <span style={{ minWidth: 48, textAlign: "center", color: "#00d2ff", fontWeight: 700, fontSize: 12 }}>{Math.round(renderCam.zoom * 100)}%</span>
        <button onClick={() => { camRef.current.zoom = Math.min(3.0, camRef.current.zoom * 1.25); }} style={{ background: "transparent", border: "none", color: "#fff", cursor: "pointer" }}><ZoomIn size={15} /></button>
        <button onClick={() => { camRef.current.x = 0; camRef.current.y = 0; camRef.current.zoom = 0.85; }} style={{ background: "transparent", border: "none", color: "#fff", cursor: "pointer" }}><Maximize2 size={14} /></button>
      </div>
    </div>
  );
};