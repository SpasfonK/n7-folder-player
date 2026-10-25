import { create } from "zustand";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";

interface CoverResolution {
  cover_key: string;
  local_cache_path: string | null;
  source_tier: string;
  album_bio: string | null;
}

export interface CoverQueueItem {
  coverKey: string;
  folderPath: string;
  artistName: string;
  albumTitle: string;
}

interface CoverStoreState {
  urls: Record<string, string | null>;
  bios: Record<string, string | null>;
  pending: Record<string, boolean>;
  onlineFallbackEnabled: boolean;
  requestCover: (item: CoverQueueItem) => void;
  setOnlineFallback: (enabled: boolean) => void;
}

const lifoViewportQueue: CoverQueueItem[] = [];
const lruOrder: string[] = [];
let activeWorkers = 0;

const MAX_CONCURRENT_WORKERS = 4;
const MAX_PENDING_VIEWPORT_QUEUE = 24;
const MAX_LRU_TEXTURES_IN_RAM = 450;

export const useCoverStore = create<CoverStoreState>((set, get) => {
  const processNext = async () => {
    if (activeWorkers >= MAX_CONCURRENT_WORKERS || lifoViewportQueue.length === 0) return;
    const item = lifoViewportQueue.pop()!;
    activeWorkers++;

    try {
      const res = await invoke<CoverResolution>("resolve_cover_lazy", {
        coverKey: item.coverKey,
        folderPath: item.folderPath,
        artistName: item.artistName,
        albumTitle: item.albumTitle,
        allowOnline: get().onlineFallbackEnabled,
      });

      const assetUrl = res.local_cache_path ? convertFileSrc(res.local_cache_path) : null;

      set((state) => {
        const nextUrls = { ...state.urls, [item.coverKey]: assetUrl };
        const nextBios = { ...state.bios, [item.coverKey]: res.album_bio };
        const nextPending = { ...state.pending };
        delete nextPending[item.coverKey];

        lruOrder.push(item.coverKey);
        if (lruOrder.length > MAX_LRU_TEXTURES_IN_RAM) {
          const evictedKey = lruOrder.shift();
          if (evictedKey) delete nextUrls[evictedKey];
        }
        return { urls: nextUrls, bios: nextBios, pending: nextPending };
      });
    } catch {
      set((state) => {
        const nextPending = { ...state.pending };
        delete nextPending[item.coverKey];
        return { urls: { ...state.urls, [item.coverKey]: null }, pending: nextPending };
      });
    } finally {
      activeWorkers--;
      processNext();
    }
  };

  return {
    urls: {},
    bios: {},
    pending: {},
    onlineFallbackEnabled: true,
    setOnlineFallback: (enabled) => set({ onlineFallbackEnabled: enabled }),
    requestCover: (item) => {
      const state = get();
      if (item.coverKey in state.urls || state.pending[item.coverKey]) return;
      if (lifoViewportQueue.length >= MAX_PENDING_VIEWPORT_QUEUE) {
        const dropped = lifoViewportQueue.shift();
        if (dropped) {
          set((s) => {
            const copy = { ...s.pending };
            delete copy[dropped.coverKey];
            return { pending: copy };
          });
        }
      }
      set((s) => ({ pending: { ...s.pending, [item.coverKey]: true } }));
      lifoViewportQueue.push(item);
      processNext();
    },
  };
});