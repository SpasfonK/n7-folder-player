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

interface LetterAnchor {
  letter: string;
  x: number;
  y: number;
}

interface ToroidalLayout {
  nodes: SpatialNode[];
  letterAnchors: LetterAnchor[];
  worldWidth: number;
  worldHeight: number;
}

interface RenderInstance {
  id: string;
  node: SpatialNode;
  worldX: number;
  worldY: number;
  opacity: number;
  scale: number;
}

const CELL_W = 430;
const CELL_H = 295;
const CARD_W = 390;
const CARD_H = 255;

const MIN_ZOOM = 0.3;
const MAX_ZOOM = 3.2;

const FADE_START = 0.82;
const EDGE_OPACITY = 0.15;
const EDGE_SCALE = 0.88;
const CULL_MARGIN = 260;

const wrap = (value: number, size: number): number => {
  if (size <= 0) return 0;
  const m = value % size;
  return m < 0 ? m + size : m;
};

const wrapDelta = (delta: number, size: number): number => {
  const m = wrap(delta, size);
  return m > size / 2 ? m - size : m;
};

const hash2 = (a: number, b: number): number => {
  const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return s - Math.floor(s);
};

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
  const [hoveredInstanceId, setHoveredInstanceId] = useState<string | null>(null);

  const layout = useMemo<ToroidalLayout>(() => {
    const q = searchQuery.trim().toLowerCase();
    const filtered = q ? artists.filter((a) => a.display_name.toLowerCase().includes(q)) : artists;

    const albumsByArtist = new Map<string, AlbumSummary[]>();
    for (const alb of albums) {
      const list = albumsByArtist.get(alb.artist_key) || [];
      list.push(alb);
      albumsByArtist.set(alb.artist_key, list);
    }

    const total = filtered.length;
    const cols = Math.max(1, Math.ceil(Math.sqrt(Math.max(1, total) * 1.45)));
    const rows = Math.max(1, Math.ceil(Math.max(1, total) / cols));
    const worldWidth = cols * CELL_W;
    const worldHeight = rows * CELL_H;
    const cellCount = cols * rows;

    const computedNodes: SpatialNode[] = [];
    const anchorsMap = new Map<string, LetterAnchor>();

    filtered.forEach((artist, index) => {
      const cellIndex = total > 0 ? Math.floor((index * cellCount) / total) : 0;
      const col = cellIndex % cols;
      const row = Math.floor(cellIndex / cols);
      const stagger = row % 2 === 1 ? CELL_W * 0.5 : 0;
      const jitterX = (hash2(col, row) - 0.5) * CELL_W * 0.09;
      const jitterY = (hash2(row + 11, col + 29) - 0.5) * CELL_H * 0.1;
      const x = wrap(col * CELL_W + stagger + jitterX, worldWidth);
      const y = wrap(row * CELL_H + jitterY, worldHeight);

      computedNodes.push({
        artist,
        albums: albumsByArtist.get(artist.artist_key) || [],
        x,
        y,
        width: CARD_W,
        height: CARD_H,
      });

      if (!anchorsMap.has(artist.first_letter)) {
        anchorsMap.set(artist.first_letter, { letter: artist.first_letter, x, y });
      }
    });

    return {
      nodes: computedNodes,
      letterAnchors: Array.from(anchorsMap.values()),
      worldWidth,
      worldHeight,
    };
  }, [artists, albums, searchQuery]);

  const { nodes, letterAnchors, worldWidth, worldHeight } = layout;

  const layoutRef = useRef(layout);
  useEffect(() => {
    layoutRef.current = layout;
  }, [layout]);

  useEffect(() => {
    JumpToLetterRef.current = (letter: string) => {
      const anchor = letterAnchors.find((a) => a.letter === letter);
      if (!anchor) return;
      const c = camRef.current;
      c.targetX = c.x + wrapDelta(-anchor.x - c.x, worldWidth);
      c.targetY = c.y + wrapDelta(-anchor.y - c.y, worldHeight);
      c.targetZoom = Math.max(c.zoom, 1.15);
      c.vx = 0; c.vy = 0;
    };
  }, [letterAnchors, worldWidth, worldHeight, JumpToLetterRef]);

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
      const { worldWidth: ww, worldHeight: wh, letterAnchors: anchors } = layoutRef.current;

      if (c.targetX !== null && c.targetY !== null) {
        const dx = wrapDelta(c.targetX - c.x, ww);
        const dy = wrapDelta(c.targetY - c.y, wh);
        c.x += dx * 0.14;
        c.y += dy * 0.14;
        if (c.targetZoom !== null) c.zoom += (c.targetZoom - c.zoom) * 0.14;
        if (Math.abs(dx) < 1.5 && Math.abs(dy) < 1.5) {
          c.targetX = null; c.targetY = null; c.targetZoom = null;
        }
      } else if (!c.isDragging) {
        if (Math.abs(c.vx) > 0.08 || Math.abs(c.vy) > 0.08) {
          c.x += c.vx; c.y += c.vy; c.vx *= 0.91; c.vy *= 0.91;
        } else { c.vx = 0; c.vy = 0; }
      }

      if (Math.abs(c.x) > ww * 64) c.x = wrap(c.x, ww);
      if (Math.abs(c.y) > wh * 64) c.y = wrap(c.y, wh);

      const wrappedX = wrap(c.x, ww);
      const wrappedY = wrap(c.y, wh);

      const canvas = canvasRef.current;
      if (canvas) {
        const ctx = canvas.getContext("2d");
        if (ctx) {
          const { w, h } = viewportSize;
          ctx.clearRect(0, 0, w, h);
          ctx.save();
          ctx.font = `800 ${Math.round(140 * c.zoom)}px "Segoe UI", sans-serif`;
          ctx.fillStyle = "rgba(0, 210, 255, 0.06)";
          const spanX = w / 2 / c.zoom;
          const spanY = h / 2 / c.zoom;
          const txMin = Math.floor((-wrappedX - spanX) / ww) - 1;
          const txMax = Math.floor((-wrappedX + spanX) / ww) + 1;
          const tyMin = Math.floor((-wrappedY - spanY) / wh) - 1;
          const tyMax = Math.floor((-wrappedY + spanY) / wh) + 1;
          for (let tx = txMin; tx <= txMax; tx++) {
            for (let ty = tyMin; ty <= tyMax; ty++) {
              for (const anchor of anchors) {
                const sx = w / 2 + (anchor.x + tx * ww + wrappedX) * c.zoom;
                const sy = h / 2 + (anchor.y + ty * wh + wrappedY) * c.zoom;
                if (sx > -300 && sx < w + 300 && sy > -300 && sy < h + 300) {
                  ctx.fillText(anchor.letter, sx - 50 * c.zoom, sy);
                }
              }
            }
          }
          ctx.restore();
        }
      }

      setRenderCam({ x: wrappedX, y: wrappedY, zoom: c.zoom });
      animId = requestAnimationFrame(tick);
    };
    animId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animId);
  }, [viewportSize]);

  const tileRange = useMemo(() => {
    const { w, h } = viewportSize;
    const { x, y, zoom } = renderCam;
    const spanX = w / 2 / zoom;
    const spanY = h / 2 / zoom;
    return {
      txMin: Math.floor((-x - spanX) / worldWidth) - 1,
      txMax: Math.floor((-x + spanX) / worldWidth) + 1,
      tyMin: Math.floor((-y - spanY) / worldHeight) - 1,
      tyMax: Math.floor((-y + spanY) / worldHeight) + 1,
    };
  }, [viewportSize, renderCam, worldWidth, worldHeight]);

  const renderInstances = useMemo<RenderInstance[]>(() => {
    const { w, h } = viewportSize;
    const { x, y, zoom } = renderCam;
    const halfW = w / 2;
    const halfH = h / 2;
    const instances: RenderInstance[] = [];

    for (let tx = tileRange.txMin; tx <= tileRange.txMax; tx++) {
      for (let ty = tileRange.tyMin; ty <= tileRange.tyMax; ty++) {
        const offsetX = tx * worldWidth;
        const offsetY = ty * worldHeight;

        for (const node of nodes) {
          const worldX = node.x + offsetX;
          const worldY = node.y + offsetY;
          const boxW = node.width * zoom;
          const boxH = node.height * zoom;
          const screenLeft = halfW + (worldX + x) * zoom;
          const screenTop = halfH + (worldY + y) * zoom;
          const centerX = screenLeft + boxW / 2;
          const centerY = screenTop + boxH / 2;

          if (centerX + boxW / 2 < -CULL_MARGIN || centerX - boxW / 2 > w + CULL_MARGIN) continue;
          if (centerY + boxH / 2 < -CULL_MARGIN || centerY - boxH / 2 > h + CULL_MARGIN) continue;

          const nx = halfW > 0 ? (centerX - halfW) / halfW : 0;
          const ny = halfH > 0 ? (centerY - halfH) / halfH : 0;
          const radial = Math.min(1, Math.sqrt(nx * nx + ny * ny) / Math.SQRT2);
          const falloff = Math.max(0, Math.min(1, (radial - FADE_START) / (1 - FADE_START)));

          instances.push({
            id: `${node.artist.artist_key}#${tx}:${ty}`,
            node,
            worldX,
            worldY,
            opacity: 1 - falloff * (1 - EDGE_OPACITY),
            scale: 1 - falloff * (1 - EDGE_SCALE),
          });
        }
      }
    }

    return instances;
  }, [nodes, viewportSize, renderCam, tileRange, worldWidth, worldHeight]);

  const showCoversLayer = renderCam.zoom >= 0.95;

  useEffect(() => {
    if (renderCam.zoom < 0.95) return;
    const queued = new Set<string>();
    for (const instance of renderInstances) {
      for (const alb of instance.node.albums.slice(0, 6)) {
        if (queued.has(alb.cover_key)) continue;
        queued.add(alb.cover_key);
        requestCover({
          coverKey: alb.cover_key,
          folderPath: alb.folder_path,
          artistName: alb.artist_name,
          albumTitle: alb.title,
        });
      }
    }
  }, [renderInstances, renderCam.zoom, requestCover]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const c = camRef.current;
    c.targetX = null; c.targetY = null; c.targetZoom = null;
    const rect = viewportRef.current?.getBoundingClientRect();
    const mouseX = rect ? e.clientX - rect.left - rect.width / 2 : 0;
    const mouseY = rect ? e.clientY - rect.top - rect.height / 2 : 0;
    const worldX = mouseX / c.zoom - c.x;
    const worldY = mouseY / c.zoom - c.y;
    const nextZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, c.zoom * (e.deltaY < 0 ? 1.13 : 0.885)));
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
        {renderInstances.map((instance) => {
          const { artist, albums: artAlbums } = instance.node;
          const isHovered = hoveredInstanceId === instance.id;
          const fontSize = Math.round(18 + artist.weight * 26);
          return (
            <div
              key={instance.id}
              onMouseEnter={() => setHoveredInstanceId(instance.id)}
              onMouseLeave={() => setHoveredInstanceId(null)}
              style={{
                position: "absolute", left: instance.worldX, top: instance.worldY, width: instance.node.width,
                padding: "10px 14px", borderRadius: 12,
                opacity: instance.opacity, transform: `scale(${instance.scale})`, transformOrigin: "center center",
                background: isHovered || showCoversLayer ? "rgba(18, 21, 30, 0.78)" : "transparent",
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

      <div style={{
        position: "absolute", inset: 0, pointerEvents: "none",
        background: "radial-gradient(ellipse 84% 78% at 50% 50%, rgba(0,0,0,0) 50%, rgba(4,5,10,0.34) 74%, rgba(3,4,8,0.78) 100%)",
      }} />

      <div style={{ position: "absolute", bottom: 18, right: 18, display: "flex", alignItems: "center", gap: 6, background: "rgba(12, 14, 22, 0.88)", border: "1px solid var(--border-subtle)", padding: "6px 10px", borderRadius: 8 }}>
        <button onClick={() => { camRef.current.zoom = Math.max(MIN_ZOOM, camRef.current.zoom * 0.8); }} style={{ background: "transparent", border: "none", color: "#fff", cursor: "pointer" }}><ZoomOut size={15} /></button>
        <span style={{ minWidth: 48, textAlign: "center", color: "#00d2ff", fontWeight: 700, fontSize: 12 }}>{Math.round(renderCam.zoom * 100)}%</span>
        <button onClick={() => { camRef.current.zoom = Math.min(MAX_ZOOM, camRef.current.zoom * 1.25); }} style={{ background: "transparent", border: "none", color: "#fff", cursor: "pointer" }}><ZoomIn size={15} /></button>
        <button onClick={() => {
          const c = camRef.current;
          c.x = 0; c.y = 0; c.zoom = 0.85;
          c.targetX = null; c.targetY = null; c.targetZoom = null;
          c.vx = 0; c.vy = 0;
        }} style={{ background: "transparent", border: "none", color: "#fff", cursor: "pointer" }}><Maximize2 size={14} /></button>
      </div>
    </div>
  );
};
