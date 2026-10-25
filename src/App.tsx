import React, { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Disc3, FolderPlus, RefreshCw, Link2, Download, Upload, Search, FolderTree, Zap, Minus, Square, X } from "lucide-react";
import { AlbumSummary, useLibraryStore } from "./store/useLibraryStore";
import { useAudioStore } from "./store/useAudioStore";
import { SpatialSurface2D } from "./components/SpatialSurface2D";
import { AlphabetJumpBar } from "./components/AlphabetJumpBar";
import { FolderTreeExplorer } from "./components/FolderTreeExplorer";
import { AlbumDetailModal } from "./components/AlbumDetailModal";
import { DockedPlayer } from "./components/DockedPlayer";

export default function App() {
  const appWindow = getCurrentWindow();
  const {
    roots, artists, albums, totalTracks, isScanning, searchQuery, statusMessage,
    loadSnapshot, pickAndScanFolders, rescanAllRoots, relinkPaths,
    exportCatalog, importCatalog, runBenchmark50k, setSearchQuery,
  } = useLibraryStore();

  const { isMiniPlayer } = useAudioStore();
  const [showTreePanel, setShowTreePanel] = useState(false);
  const [showRelinkModal, setShowRelinkModal] = useState(false);
  const [oldDrive, setOldDrive] = useState("E:\\");
  const [newDrive, setNewDrive] = useState("F:\\");
  const [inspectAlbum, setInspectAlbum] = useState<AlbumSummary | null>(null);
  const jumpToLetterRef = useRef<((letter: string) => void) | null>(null);

  useEffect(() => { loadSnapshot(); }, [loadSnapshot]);

  return (
    <div className="app-shell">
      <header className="titlebar">
        <div className="titlebar-drag" onMouseDown={() => appWindow.startDragging()}>
          <Disc3 size={18} color="#00d2ff" />
          <span>n7-FOLDER MUSIC PLAYER</span>
          {!isMiniPlayer && (
            <span style={{ color: "#9ca3af", fontSize: 12, marginLeft: 8 }}>
              {artists.length} Artistes • {albums.length} Albums • {totalTracks} Titres
            </span>
          )}
        </div>
        <div className="titlebar-controls">
          <button className="win-btn" onClick={() => appWindow.minimize()}><Minus size={15} /></button>
          <button className="win-btn" onClick={() => appWindow.toggleMaximize()}><Square size={13} /></button>
          <button className="win-btn close" onClick={() => appWindow.close()}><X size={16} /></button>
        </div>
      </header>

      {!isMiniPlayer && (
        <>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 14px", background: "rgba(14, 16, 24, 0.94)", borderBottom: "1px solid var(--border-subtle)", gap: 8 }}>
            <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
              <button onClick={() => setShowTreePanel(!showTreePanel)} style={btnStyle}><FolderTree size={14} /> Arborescence</button>
              <button onClick={pickAndScanFolders} disabled={isScanning} style={{ ...btnStyle, background: "#00d2ff", color: "#000", fontWeight: 700 }}><FolderPlus size={14} /> + Dossier(s)</button>
              <button onClick={rescanAllRoots} disabled={isScanning || roots.length === 0} style={btnStyle}><RefreshCw size={14} /> Rescanner</button>
              <button onClick={() => setShowRelinkModal(!showRelinkModal)} style={btnStyle}><Link2 size={14} /> Relink</button>
              <button onClick={exportCatalog} style={btnStyle}><Download size={14} /> Export JSON</button>
              <button onClick={importCatalog} style={btnStyle}><Upload size={14} /> Import JSON</button>
              <button onClick={runBenchmark50k} disabled={isScanning} style={{ ...btnStyle, borderColor: "#00d2ff", color: "#00d2ff" }}><Zap size={14} /> Simuler 50k Pistes</button>
            </div>
            <div style={{ display: "flex", alignItems: "center", background: "rgba(0,0,0,0.4)", border: "1px solid var(--border-subtle)", borderRadius: 6, padding: "4px 10px", width: 240 }}>
              <Search size={14} color="#9ca3af" />
              <input type="text" placeholder="Rechercher artiste..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} style={{ background: "transparent", border: "none", color: "#fff", marginLeft: 8, outline: "none", width: "100%", fontSize: 12 }} />
            </div>
          </div>

          <AlphabetJumpBar onSelectLetter={(l) => jumpToLetterRef.current?.(l)} />

          {showRelinkModal && (
            <div style={{ background: "rgba(0, 210, 255, 0.1)", padding: "8px 16px", display: "flex", alignItems: "center", gap: 10, fontSize: 12 }}>
              <strong>Relink Lecteur / NAS :</strong>
              <input value={oldDrive} onChange={(e) => setOldDrive(e.target.value)} style={{ background: "#000", color: "#fff", border: "1px solid #333", padding: 4 }} />
              <span>→</span>
              <input value={newDrive} onChange={(e) => setNewDrive(e.target.value)} style={{ background: "#000", color: "#fff", border: "1px solid #333", padding: 4 }} />
              <button onClick={() => { relinkPaths(oldDrive, newDrive); setShowRelinkModal(false); }} style={{ background: "#00d2ff", color: "#000", border: "none", padding: "4px 10px", borderRadius: 4, fontWeight: 700, cursor: "pointer" }}>Appliquer</button>
            </div>
          )}

          {statusMessage && (
            <div style={{ padding: "4px 16px", background: "rgba(0, 210, 255, 0.08)", fontSize: 11, color: "#00d2ff" }}>{statusMessage}</div>
          )}

          <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
            {showTreePanel && <FolderTreeExplorer onSelectAlbumFromTree={(alb) => setInspectAlbum(alb)} />}
            <SpatialSurface2D JumpToLetterRef={jumpToLetterRef} onOpenAlbumDetail={(alb) => setInspectAlbum(alb)} />
          </div>

          <AlbumDetailModal album={inspectAlbum} onClose={() => setInspectAlbum(null)} />
        </>
      )}

      <DockedPlayer />
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  background: "rgba(255,255,255,0.06)", color: "#e5e7eb", border: "1px solid var(--border-subtle)",
  padding: "5px 10px", borderRadius: 6, fontSize: 12, display: "flex", alignItems: "center", gap: 5, cursor: "pointer",
};