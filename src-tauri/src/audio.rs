use crate::to_windows_long_path;
use parking_lot::Mutex;
use rodio::{Decoder, OutputStream, Sink, Source};
use rustfft::{num_complex::Complex, FftPlanner};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::fs::File;
use std::io::BufReader;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::Arc;
use std::time::Duration;

pub const EQ_FREQUENCIES: [f32; 10] = [
    31.25, 62.5, 125.0, 250.0, 500.0, 1000.0, 2000.0, 4000.0, 8000.0, 16000.0,
];

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub enum RepeatMode {
    Off,
    All,
    One,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueueTrack {
    pub id: i64,
    pub file_path: String,
    pub title: String,
    pub artist_name: String,
    pub album_title: String,
    pub format: String,
    pub cover_key: String,
    pub folder_path: String,
    pub duration_sec: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EqConfig {
    pub enabled: bool,
    pub preamp_db: f32,
    pub bands_db: [f32; 10],
    pub preset_name: String,
}

impl Default for EqConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            preamp_db: 0.0,
            bands_db: [0.0; 10],
            preset_name: "Flat".to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlaybackStatus {
    pub is_playing: bool,
    pub position_sec: f32,
    pub duration_sec: f32,
    pub volume: f32,
    pub shuffle: bool,
    pub repeat_mode: RepeatMode,
    pub current_index: usize,
    pub current_track: Option<QueueTrack>,
    pub queue_len: usize,
    pub eq: EqConfig,
    pub spectrum: Vec<f32>,
    pub waveform: Vec<f32>,
}

#[derive(Clone, Copy, Default)]
struct BiquadFilter {
    b0: f32, b1: f32, b2: f32, a1: f32, a2: f32,
    x1: f32, x2: f32, y1: f32, y2: f32,
}

impl BiquadFilter {
    fn configure_peaking(&mut self, freq: f32, sample_rate: f32, gain_db: f32, q: f32) {
        let a = 10.0_f32.powf(gain_db / 40.0);
        let w0 = 2.0 * std::f32::consts::PI * (freq / sample_rate).clamp(0.001, 0.48);
        let cos_w0 = w0.cos();
        let sin_w0 = w0.sin();
        let alpha = sin_w0 / (2.0 * q);
        let a0 = 1.0 + alpha / a;
        self.b0 = (1.0 + alpha * a) / a0;
        self.b1 = (-2.0 * cos_w0) / a0;
        self.b2 = (1.0 - alpha * a) / a0;
        self.a1 = (-2.0 * cos_w0) / a0;
        self.a2 = (1.0 - alpha / a) / a0;
    }

    #[inline(always)]
    fn process(&mut self, x: f32) -> f32 {
        let y = self.b0 * x + self.b1 * self.x1 + self.b2 * self.x2 - self.a1 * self.y1 - self.a2 * self.y2;
        self.x2 = self.x1; self.x1 = x;
        self.y2 = self.y1; self.y1 = y;
        y
    }
}

pub struct SharedDspState {
    pub eq_config: Mutex<EqConfig>,
    pub eq_dirty: AtomicBool,
    pub sample_ring: Mutex<VecDeque<f32>>,
    pub played_frames: AtomicU64,
    pub sample_rate: AtomicU64,
}

impl SharedDspState {
    fn new() -> Self {
        Self {
            eq_config: Mutex::new(EqConfig::default()),
            eq_dirty: AtomicBool::new(true),
            sample_ring: Mutex::new(VecDeque::with_capacity(2048)),
            played_frames: AtomicU64::new(0),
            sample_rate: AtomicU64::new(44100),
        }
    }
}

struct DspSource<S> where S: Source<Item = f32> {
    inner: S,
    dsp: Arc<SharedDspState>,
    channels: u16,
    sample_rate: u32,
    current_channel: u16,
    filters: [[BiquadFilter; 10]; 2],
    preamp_linear: f32,
    eq_enabled: bool,
    sample_counter: u64,
}

impl<S> DspSource<S> where S: Source<Item = f32> {
    fn new(inner: S, dsp: Arc<SharedDspState>) -> Self {
        let channels = inner.channels().max(1);
        let sample_rate = inner.sample_rate().max(8000);
        dsp.sample_rate.store(sample_rate as u64, Ordering::Relaxed);
        let mut src = Self {
            inner, dsp, channels, sample_rate, current_channel: 0,
            filters: [[BiquadFilter::default(); 10]; 2],
            preamp_linear: 1.0, eq_enabled: true, sample_counter: 0,
        };
        src.refresh_filters();
        src
    }

    fn refresh_filters(&mut self) {
        let cfg = self.dsp.eq_config.lock().clone();
        self.eq_enabled = cfg.enabled;
        self.preamp_linear = 10.0_f32.powf(cfg.preamp_db / 20.0);
        let sr = self.sample_rate as f32;
        for ch in 0..2 {
            for (idx, &freq) in EQ_FREQUENCIES.iter().enumerate() {
                self.filters[ch][idx].configure_peaking(freq, sr, cfg.bands_db[idx], 1.414);
            }
        }
    }
}

impl<S> Iterator for DspSource<S> where S: Source<Item = f32> {
    type Item = f32;
    fn next(&mut self) -> Option<Self::Item> {
        let mut sample = self.inner.next()?;
        if self.dsp.eq_dirty.swap(false, Ordering::Relaxed) {
            self.refresh_filters();
        }
        let ch_idx = (self.current_channel as usize).min(1);
        if self.eq_enabled {
            sample *= self.preamp_linear;
            for band in 0..10 {
                sample = self.filters[ch_idx][band].process(sample);
            }
            sample = sample.clamp(-0.99, 0.99);
        }
        if self.current_channel == 0 {
            self.sample_counter += 1;
            if self.sample_counter % 2 == 0 {
                if let Some(mut ring) = self.dsp.sample_ring.try_lock() {
                    if ring.len() >= 1024 { ring.pop_front(); }
                    ring.push_back(sample);
                }
            }
            self.dsp.played_frames.fetch_add(1, Ordering::Relaxed);
        }
        self.current_channel = (self.current_channel + 1) % self.channels;
        Some(sample)
    }
}

impl<S> Source for DspSource<S> where S: Source<Item = f32> {
    fn current_frame_len(&self) -> Option<usize> { self.inner.current_frame_len() }
    fn channels(&self) -> u16 { self.channels }
    fn sample_rate(&self) -> u32 { self.sample_rate }
    fn total_duration(&self) -> Option<Duration> { self.inner.total_duration() }
}

pub enum AudioCommand {
    SetQueueAndPlay { tracks: Vec<QueueTrack>, start_index: usize },
    AppendQueue { tracks: Vec<QueueTrack> },
    TogglePlayPause, Next, Prev, Seek(f32), SetVolume(f32),
    SetShuffle(bool), SetRepeat(RepeatMode), SetEq(EqConfig),
}

struct InternalState {
    queue: Vec<QueueTrack>, current_index: usize, is_playing: bool,
    duration_sec: f32, base_seek_sec: f32, volume: f32,
    shuffle: bool, repeat_mode: RepeatMode,
}

pub struct AudioController {
    tx: Sender<AudioCommand>,
    state: Arc<Mutex<InternalState>>,
    dsp: Arc<SharedDspState>,
}

impl AudioController {
    pub fn new() -> Self {
        let (tx, rx) = mpsc::channel::<AudioCommand>();
        let state = Arc::new(Mutex::new(InternalState {
            queue: Vec::new(), current_index: 0, is_playing: false,
            duration_sec: 0.0, base_seek_sec: 0.0, volume: 0.85,
            shuffle: false, repeat_mode: RepeatMode::Off,
        }));
        let dsp = Arc::new(SharedDspState::new());
        let state_clone = Arc::clone(&state);
        let dsp_clone = Arc::clone(&dsp);

        std::thread::Builder::new().name("n7-audio-dsp".to_string()).spawn(move || {
            let stream_res = OutputStream::try_default();
            let (_stream, stream_handle) = match stream_res {
                Ok(pair) => (Some(pair.0), Some(pair.1)),
                Err(_) => (None, None),
            };
            let mut active_sink: Option<Sink> = None;

            let load_and_play = |idx: usize, seek_offset: f32, st: &mut InternalState, sink_slot: &mut Option<Sink>| {
                if idx >= st.queue.len() { return; }
                st.current_index = idx;
                let track = st.queue[idx].clone();
                let long_path = to_windows_long_path(Path::new(&track.file_path));
                if let Some(handle) = &stream_handle {
                    if let Ok(file) = File::open(&long_path) {
                        if let Ok(decoder) = Decoder::new(BufReader::new(file)) {
                            st.duration_sec = decoder.total_duration().map(|d| d.as_secs_f32()).unwrap_or(track.duration_sec as f32);
                            st.base_seek_sec = seek_offset;
                            dsp_clone.played_frames.store(0, Ordering::Relaxed);
                            let skipped = decoder.convert_samples::<f32>().skip_duration(Duration::from_secs_f32(seek_offset.max(0.0)));
                            let dsp_src = DspSource::new(skipped, Arc::clone(&dsp_clone));
                            if let Ok(new_sink) = Sink::try_new(handle) {
                                new_sink.set_volume(st.volume.clamp(0.0, 1.0).powf(2.2));
                                new_sink.append(dsp_src);
                                new_sink.play();
                                *sink_slot = Some(new_sink);
                                st.is_playing = true;
                            }
                        }
                    }
                }
            };

            loop {
                while let Ok(cmd) = rx.try_recv() {
                    let mut st = state_clone.lock();
                    match cmd {
                        AudioCommand::SetQueueAndPlay { tracks, start_index } => {
                            st.queue = tracks;
                            if !st.queue.is_empty() {
                                let idx = start_index.min(st.queue.len() - 1);
                                load_and_play(idx, 0.0, &mut st, &mut active_sink);
                            }
                        }
                        AudioCommand::AppendQueue { tracks } => {
                            let was_empty = st.queue.is_empty();
                            st.queue.extend(tracks);
                            if was_empty && !st.queue.is_empty() {
                                load_and_play(0, 0.0, &mut st, &mut active_sink);
                            }
                        }
                        AudioCommand::TogglePlayPause => {
                            if let Some(s) = &active_sink {
                                if s.is_paused() { s.play(); st.is_playing = true; }
                                else { s.pause(); st.is_playing = false; }
                            } else if !st.queue.is_empty() {
                                let idx = st.current_index;
                                load_and_play(idx, 0.0, &mut st, &mut active_sink);
                            }
                        }
                        AudioCommand::Next => {
                            if !st.queue.is_empty() {
                                let next_idx = (st.current_index + 1) % st.queue.len();
                                load_and_play(next_idx, 0.0, &mut st, &mut active_sink);
                            }
                        }
                        AudioCommand::Prev => {
                            if !st.queue.is_empty() {
                                let prev_idx = if st.current_index == 0 { st.queue.len() - 1 } else { st.current_index - 1 };
                                load_and_play(prev_idx, 0.0, &mut st, &mut active_sink);
                            }
                        }
                        AudioCommand::Seek(sec) => {
                            if !st.queue.is_empty() {
                                let idx = st.current_index;
                                load_and_play(idx, sec, &mut st, &mut active_sink);
                            }
                        }
                        AudioCommand::SetVolume(vol) => {
                            st.volume = vol.clamp(0.0, 1.0);
                            if let Some(s) = &active_sink { s.set_volume(st.volume.powf(2.2)); }
                        }
                        AudioCommand::SetShuffle(sh) => { st.shuffle = sh; }
                        AudioCommand::SetRepeat(rep) => { st.repeat_mode = rep; }
                        AudioCommand::SetEq(eq) => {
                            *dsp_clone.eq_config.lock() = eq;
                            dsp_clone.eq_dirty.store(true, Ordering::Relaxed);
                        }
                    }
                }
                std::thread::sleep(Duration::from_millis(18));
            }
        }).expect("Impossible de lancer le thread audio");

        Self { tx, state, dsp }
    }

    pub fn send(&self, cmd: AudioCommand) { let _ = self.tx.send(cmd); }

    pub fn get_status_and_fft(&self) -> PlaybackStatus {
        let st = self.state.lock();
        let sr = self.dsp.sample_rate.load(Ordering::Relaxed).max(1) as f32;
        let frames = self.dsp.played_frames.load(Ordering::Relaxed) as f32;
        let pos = (st.base_seek_sec + (frames / sr)).min(st.duration_sec.max(0.0));
        let current_track = st.queue.get(st.current_index).cloned();
        let eq = self.dsp.eq_config.lock().clone();
        let (spectrum, waveform) = if st.is_playing { compute_fft_and_waveform(&self.dsp) } else { (vec![0.0; 64], vec![0.0; 64]) };

        PlaybackStatus {
            is_playing: st.is_playing, position_sec: pos, duration_sec: st.duration_sec,
            volume: st.volume, shuffle: st.shuffle, repeat_mode: st.repeat_mode,
            current_index: st.current_index, current_track, queue_len: st.queue.len(),
            eq, spectrum, waveform,
        }
    }
}

fn compute_fft_and_waveform(dsp: &SharedDspState) -> (Vec<f32>, Vec<f32>) {
    let ring = dsp.sample_ring.lock();
    if ring.len() < 512 { return (vec![0.0; 64], vec![0.0; 64]); }
    let n = 512;
    let samples: Vec<f32> = ring.iter().rev().take(n).copied().collect();
    let mut waveform = Vec::with_capacity(64);
    for i in 0..64 { waveform.push(samples[(i * n / 64).min(samples.len() - 1)].clamp(-1.0, 1.0)); }

    let mut buffer: Vec<Complex<f32>> = samples.iter().enumerate().map(|(i, &s)| {
        let hann = 0.5 * (1.0 - (2.0 * std::f32::consts::PI * i as f32 / (n as f32 - 1.0)).cos());
        Complex { re: s * hann, im: 0.0 }
    }).collect();

    let mut planner = FftPlanner::<f32>::new();
    planner.plan_fft_forward(n).process(&mut buffer);

    let half = n / 2;
    let mut spectrum = Vec::with_capacity(64);
    for b in 0..64 {
        let s_bin = (((b as f32 / 64.0).powf(1.8) * half as f32) as usize).clamp(1, half - 1);
        let e_bin = ((((b + 1) as f32 / 64.0).powf(1.8) * half as f32) as usize).clamp(s_bin + 1, half);
        let sum: f32 = buffer[s_bin..e_bin].iter().map(|c| (c.re * c.re + c.im * c.im).sqrt()).sum();
        let avg = sum / ((e_bin - s_bin) as f32);
        spectrum.push(((avg * 0.18).ln_1p() * 1.35).clamp(0.0, 1.0));
    }
    (spectrum, waveform)
}