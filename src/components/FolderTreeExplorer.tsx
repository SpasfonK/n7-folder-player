import React, { useMemo, useState } from "react";
import { Folder, FolderOpen, Music, Play, ChevronRight, ChevronDown } from "lucide-react";
import { AlbumSummary, useLibraryStore } from "../store/useLibraryStore";

export const FolderTreeExplorer: React.FC<{ onSelectAlbumFromTree: (a: AlbumSummary) => void }> = ({ onSelectAlbumFromTree }) => {
  const { roots, albums, searchQuery } = useLibraryStore();
  const [expandedRoots, setExpandedRoots] = useState<Record<string, boolean>>({});
  const [expandedArtists, setExpandedArtists] = useState<Record<string, boolean>>({});

  const tree = useMemo(() => {
    const q = searchQuery.toLowerCase();
    const map = new Map<string, Map<string, AlbumSummary[]>>();
    for (const r of roots) map.set(r, new Map());
    for (const alb of albums) {
      if (q && !alb.artist_name.toLowerCase().includes(q) && !alb.title.toLowerCase().includes(q)) continue;
      const matchingRoot = roots.find((r) => alb.folder_path.startsWith(r)) || roots[0] || "Bibliothèque";
      if (!map.has(matchingRoot)) map.set(matchingRoot, new Map());
      const artistMap = map.get(matchingRoot)!;
      const list = artistMap.get(alb.artist_name) || [];
      list.push(alb);
      artistMap.set(alb.artist_name, list);
    }
    return map;
  }, [roots, albums, searchQuery]);

  return (
    <aside style={{ width: 300, borderRight: "1px solid var(--border-subtle)", background: "rgba(14, 16, 22, 0.94)", display: "flex", flexDirection: "column", overflowY: "auto", padding: 10, fontSize: 12 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: "#00d2ff", marginBottom: 10 }}>ARBORESCENCE DES DOSSIERS</div>
      {Array.from(tree.entries()).map(([rootPath, artistMap]) => {
        const isRootOpen = expandedRoots[rootPath] ?? true;
        return (
          <div key={rootPath} style={{ marginBottom: 8 }}>
            <div onClick={() => setExpandedRoots((p) => ({ ...p, [rootPath]: !isRootOpen }))} style={{ display: "flex", alignItems: "center", gap: 6, padding: 6, borderRadius: 6, background: "rgba(255,255,255,0.04)", cursor: "pointer", fontWeight: 600 }}>
              {isRootOpen ? <ChevronDown size={14} color="#00d2ff" /> : <ChevronRight size={14} color="#9ca3af" />}
              {isRootOpen ? <FolderOpen size={15} color="#00d2ff" /> : <Folder size={15} color="#00d2ff" />}
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{rootPath}</span>
            </div>
            {isRootOpen && (
              <div style={{ paddingLeft: 14, marginTop: 4 }}>
                {Array.from(artistMap.entries()).map(([artistName, albList]) => {
                  const key = `${rootPath}::${artistName}`;
                  const isArtOpen = expandedArtists[key] ?? false;
                  return (
                    <div key={key}>
                      <div onClick={() => setExpandedArtists((p) => ({ ...p, [key]: !isArtOpen }))} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "4px 6px", cursor: "pointer" }}>
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{artistName}</span>
                        <span style={{ fontSize: 10, color: "#9ca3af" }}>{albList.length}</span>
                      </div>
                      {isArtOpen && (
                        <div style={{ paddingLeft: 14 }}>
                          {albList.map((alb) => (
                            <div key={alb.album_key} onClick={() => onSelectAlbumFromTree(alb)} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "4px 6px", cursor: "pointer", color: "#d1d5db" }}>
                              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}><Music size={11} color="#00d2ff" /> {alb.title}</span>
                              <Play size={11} color="#00d2ff" />
                            </div>
                          ))}
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
    </aside>
  );
};