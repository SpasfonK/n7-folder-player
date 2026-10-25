import { create } from "zustand";
import { invoke, Channel } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";

export interface ArtistSummary {
  artist_key: string;
  display_name: string;
  album_count: number;
  track_count: number;
  weight: number;
  first_letter: string;
}

export interface AlbumSummary {
  album_key: string;
  artist_key: string;
  artist_name: string;
  title: string;
  year: number | null;
  cover_key: string;
  folder_path: string;
  track_count: number;
}

export interface TrackRecord {
  id: number;
  file_path: string;
  folder_path: string;
  artist_key: string;
  artist_name: string;
  album_key: string;
  album_title: string;
  title: string;
  track_no: number;
  disc_no: number;
  duration_sec: number;
  year: number | null;
  format: string;
  size_bytes: number;
  cover_key: string;
}

export interface ScanProgressEvent {
  phase: string;
  scanned_files: number;
  indexed_tracks: number;
  current_path: string;
  elapsed_ms: number;
  done: boolean;
}

interface LibrarySnapshot {
  roots: string[];
  artists: ArtistSummary[];
  albums: AlbumSummary[];
  total_tracks: number;
}

interface LibraryState {
  roots: string[];
  artists: ArtistSummary[];
  albums: AlbumSummary[];
  totalTracks: number;
  isScanning: boolean;
  scanProgress: ScanProgressEvent | null;
  selectedArtistKey: string | null;
  selectedAlbumKey: string | null;
  activeAlbumTracks: TrackRecord[];
  searchQuery: string;
  statusMessage: string | null;

  loadSnapshot: () => Promise<void>;
  pickAndScanFolders: () => Promise<void>;
  rescanAllRoots: () => Promise<void>;
  removeRoot: (path: string) => Promise<void>;
  relinkPaths: (oldPrefix: string, newPrefix: string) => Promise<void>;
  exportCatalog: () => Promise<void>;
  importCatalog: () => Promise<void>;
  runBenchmark50k: () => Promise<void>;
  clearLibrary: () => Promise<void>;
  selectArtist: (artistKey: string | null) => void;
  selectAlbum: (artistKey: string, albumKey: string) => Promise<void>;
  setSearchQuery: (q: string) => void;
}

export const useLibraryStore = create<LibraryState>((set, get) => ({
  roots: [],
  artists: [],
  albums: [],
  totalTracks: 0,
  isScanning: false,
  scanProgress: null,
  selectedArtistKey: null,
  selectedAlbumKey: null,
  activeAlbumTracks: [],
  searchQuery: "",
  statusMessage: null,

  loadSnapshot: async () => {
    const snap = await invoke<LibrarySnapshot>("get_library_snapshot");
    set({
      roots: snap.roots,
      artists: snap.artists,
      albums: snap.albums,
      totalTracks: snap.total_tracks,
    });
  },

  pickAndScanFolders: async () => {
    const selected = await open({
      directory: true,
      multiple: true,
      title: "Sélectionner un ou plusieurs dossiers musicaux (Local / USB / NAS UNC)",
    });
    if (!selected) return;
    const folders = Array.isArray(selected) ? selected : [selected];
    if (folders.length === 0) return;

    set({ isScanning: true, statusMessage: null });
    const progressChan = new Channel<ScanProgressEvent>();
    progressChan.onmessage = (msg) => set({ scanProgress: msg });

    try {
      const snap = await invoke<LibrarySnapshot>("scan_library_folders", {
        folders,
        onProgress: progressChan,
      });
      set({
        roots: snap.roots,
        artists: snap.artists,
        albums: snap.albums,
        totalTracks: snap.total_tracks,
        isScanning: false,
        statusMessage: `${snap.total_tracks} titres indexés (${snap.artists.length} artistes uniques).`,
      });
    } catch (err) {
      set({ isScanning: false, statusMessage: String(err) });
    }
  },

  rescanAllRoots: async () => {
    const { roots } = get();
    if (roots.length === 0) return;
    set({ isScanning: true });
    const progressChan = new Channel<ScanProgressEvent>();
    progressChan.onmessage = (msg) => set({ scanProgress: msg });
    try {
      const snap = await invoke<LibrarySnapshot>("scan_library_folders", {
        folders: roots,
        onProgress: progressChan,
      });
      set({
        roots: snap.roots,
        artists: snap.artists,
        albums: snap.albums,
        totalTracks: snap.total_tracks,
        isScanning: false,
      });
    } catch (err) {
      set({ isScanning: false, statusMessage: String(err) });
    }
  },

  removeRoot: async (path: string) => {
    const snap = await invoke<LibrarySnapshot>("remove_root_folder", { path });
    set({
      roots: snap.roots,
      artists: snap.artists,
      albums: snap.albums,
      totalTracks: snap.total_tracks,
    });
  },

  relinkPaths: async (oldPrefix: string, newPrefix: string) => {
    const [updatedCount, snap] = await invoke<[number, LibrarySnapshot]>(
      "relink_library_paths",
      { oldPrefix, newPrefix }
    );
    set({
      roots: snap.roots,
      artists: snap.artists,
      albums: snap.albums,
      totalTracks: snap.total_tracks,
      statusMessage: `Relink terminé : ${updatedCount} fichiers réalignés.`,
    });
  },

  exportCatalog: async () => {
    const targetPath = await save({
      title: "Exporter le catalogue JSON",
      defaultPath: "n7folder-library-backup.json",
      filters: [{ name: "JSON Catalog", extensions: ["json"] }],
    });
    if (!targetPath) return;
    const count = await invoke<number>("export_library_json", { targetPath });
    set({ statusMessage: `Catalogue exporté (${count} pistes).` });
  },

  importCatalog: async () => {
    const sourcePath = await open({
      multiple: false,
      title: "Importer un catalogue JSON",
      filters: [{ name: "JSON Catalog", extensions: ["json"] }],
    });
    if (!sourcePath || Array.isArray(sourcePath)) return;
    const snap = await invoke<LibrarySnapshot>("import_library_json", { sourcePath });
    set({
      roots: snap.roots,
      artists: snap.artists,
      albums: snap.albums,
      totalTracks: snap.total_tracks,
      statusMessage: `Catalogue importé : ${snap.total_tracks} pistes.`,
    });
  },

  runBenchmark50k: async () => {
    set({ isScanning: true, statusMessage: "Simulation 50 000 pistes en cours..." });
    try {
      const report = await invoke<{
        total_time_ms: number;
        parse_time_ms: number;
        sqlite_insert_ms: number;
        unique_artists: number;
        unique_albums: number;
        snapshot: LibrarySnapshot;
      }>("run_scale_benchmark_50k");
      set({
        roots: report.snapshot.roots,
        artists: report.snapshot.artists,
        albums: report.snapshot.albums,
        totalTracks: report.snapshot.total_tracks,
        isScanning: false,
        statusMessage: `Benchmark 50k validé en ${report.total_time_ms} ms (ParsePath v6+: ${report.parse_time_ms} ms, SQLite: ${report.sqlite_insert_ms} ms) — ${report.unique_artists} artistes, ${report.unique_albums} albums.`,
      });
    } catch (err) {
      set({ isScanning: false, statusMessage: String(err) });
    }
  },

  clearLibrary: async () => {
    const snap = await invoke<LibrarySnapshot>("clear_entire_library");
    set({
      roots: snap.roots,
      artists: snap.artists,
      albums: snap.albums,
      totalTracks: snap.total_tracks,
      selectedArtistKey: null,
      selectedAlbumKey: null,
      activeAlbumTracks: [],
      statusMessage: "Bibliothèque purgée.",
    });
  },

  selectArtist: (artistKey) =>
    set({ selectedArtistKey: artistKey, selectedAlbumKey: null, activeAlbumTracks: [] }),

  selectAlbum: async (artistKey, albumKey) => {
    const tracks = await invoke<TrackRecord[]>("get_album_tracks", { artistKey, albumKey });
    set({ selectedArtistKey: artistKey, selectedAlbumKey: albumKey, activeAlbumTracks: tracks });
  },

  setSearchQuery: (q) => set({ searchQuery: q }),
}));