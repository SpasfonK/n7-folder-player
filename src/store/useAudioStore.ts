import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { TrackRecord } from "./useLibraryStore";

export type RepeatMode = "Off" | "All" | "One";

export interface EqConfig {
  enabled: boolean;
  preamp_db: number;
  bands_db: number[];
  preset_name: string;
}

export const EQ_PRESETS: Record<string, { preamp: number; bands: number[] }> = {
  Flat: { preamp: 0, bands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  "Rock / Metal": { preamp: -1.5, bands: [5, 4, 2, -1.5, -2, 0.5, 3, 4.5, 5, 5] },
  "Bass Boost": { preamp: -2.0, bands: [7, 6, 4.5, 2, 0, 0, 0, 0, 0, 0] },
  Jazz: { preamp: 0, bands: [3.5, 2.5, 1, 2, -1.5, -1.5, 0, 1.5, 3, 4] },
  Vocal: { preamp: 0, bands: [-2, -3, -1, 2, 4.5, 4.5, 3, 1.5, 0, -1] },
};

export interface PlaybackStatus {
  is_playing: boolean;
  position_sec: number;
  duration_sec: number;
  volume: number;
  shuffle: boolean;
  repeat_mode: RepeatMode;
  current_index: number;
  current_track: TrackRecord | null;
  queue_len: number;
  eq: EqConfig;
  spectrum: number[];
  waveform: number[];
}

interface AudioStoreState extends PlaybackStatus {
  vizMode: "spectrum" | "oscilloscope";
  showEqModal: boolean;
  isMiniPlayer: boolean;

  playTracks: (tracks: TrackRecord[], startIndex?: number) => Promise<void>;
  appendTracks: (tracks: TrackRecord[]) => Promise<void>;
  togglePlay: () => Promise<void>;
  next: () => Promise<void>;
  prev: () => Promise<void>;
  seek: (sec: number) => Promise<void>;
  setVolume: (vol: number) => Promise<void>;
  setShuffle: (sh: boolean) => Promise<void>;
  toggleShuffle: () => Promise<void>;
  cycleRepeat: () => Promise<void>;
  applyEq: (eq: EqConfig) => Promise<void>;
  selectPreset: (presetName: string) => Promise<void>;
  pollTelemetry: () => Promise<void>;
  setVizMode: (mode: "spectrum" | "oscilloscope") => void;
  setShowEqModal: (show: boolean) => void;
  setMiniPlayer: (mini: boolean) => void;
}

export const useAudioStore = create<AudioStoreState>((set, get) => ({
  is_playing: false,
  position_sec: 0,
  duration_sec: 0,
  volume: 0.85,
  shuffle: false,
  repeat_mode: "Off",
  current_index: 0,
  current_track: null,
  queue_len: 0,
  eq: {
    enabled: true,
    preamp_db: 0,
    bands_db: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    preset_name: "Flat",
  },
  spectrum: new Array(64).fill(0),
  waveform: new Array(64).fill(0),
  vizMode: "spectrum",
  showEqModal: false,
  isMiniPlayer: false,

  playTracks: async (tracks, startIndex = 0) => {
    await invoke("audio_play_tracks", { tracks, startIndex });
  },
  appendTracks: async (tracks) => {
    await invoke("audio_append_queue", { tracks });
  },
  togglePlay: async () => {
    await invoke("audio_toggle_play");
  },
  next: async () => {
    await invoke("audio_next");
  },
  prev: async () => {
    await invoke("audio_prev");
  },
  seek: async (sec) => {
    set({ position_sec: sec });
    await invoke("audio_seek", { positionSec: sec });
  },
  setVolume: async (vol) => {
    set({ volume: vol });
    await invoke("audio_set_volume", { volume: vol });
  },
  setShuffle: async (sh) => {
    set({ shuffle: sh });
    await invoke("audio_set_shuffle", { shuffle: sh });
  },
  toggleShuffle: async () => {
    const nextShuffle = !get().shuffle;
    set({ shuffle: nextShuffle });
    await invoke("audio_set_shuffle", { shuffle: nextShuffle });
  },
  cycleRepeat: async () => {
    const current = get().repeat_mode;
    const nextMode: RepeatMode = current === "Off" ? "All" : current === "All" ? "One" : "Off";
    set({ repeat_mode: nextMode });
    await invoke("audio_set_repeat", { mode: nextMode });
  },
  applyEq: async (eq) => {
    set({ eq });
    await invoke("audio_set_eq", { eq });
  },
  selectPreset: async (presetName) => {
    const p = EQ_PRESETS[presetName];
    if (!p) return;
    await get().applyEq({
      enabled: get().eq.enabled,
      preamp_db: p.preamp,
      bands_db: [...p.bands],
      preset_name: presetName,
    });
  },
  pollTelemetry: async () => {
    const status = await invoke<PlaybackStatus>("audio_get_telemetry");
    set(status);
  },
  setVizMode: (vizMode) => set({ vizMode }),
  setShowEqModal: (showEqModal) => set({ showEqModal }),
  setMiniPlayer: (isMiniPlayer) => set({ isMiniPlayer }),
}));