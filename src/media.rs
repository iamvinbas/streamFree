//! Encoded media packets shared by the ingest, the recorder and the RTMP outputs.
//!
//! The studio page encodes with WebCodecs: H.264 in `avc` format (length-prefixed
//! NAL units, `avcC` decoder configuration) and AAC-LC (raw frames plus an
//! `AudioSpecificConfig`). Those are exactly the payloads FLV/RTMP and MP4 carry,
//! so nothing here re-encodes.

use bytes::Bytes;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Track {
    Video,
    Audio,
}

/// Decoder configuration for the video track.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VideoConfig {
    pub width: u32,
    pub height: u32,
    pub framerate: u32,
    pub bitrate: u32,
    /// `AVCDecoderConfigurationRecord` (ISO/IEC 14496-15), as WebCodecs returns it
    /// in `decoderConfig.description` when `avc.format` is `"avc"`.
    pub avcc: Bytes,
}

/// Decoder configuration for the audio track.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AudioConfig {
    pub sample_rate: u32,
    pub channels: u32,
    pub bitrate: u32,
    /// MPEG-4 `AudioSpecificConfig` (ISO/IEC 14496-3).
    pub asc: Bytes,
}

/// One encoded access unit with its presentation time in microseconds,
/// relative to the start of the session.
#[derive(Debug, Clone)]
pub struct Packet {
    pub track: Track,
    pub pts_us: i64,
    pub keyframe: bool,
    pub data: Bytes,
}

impl Packet {
    pub fn pts_ms(&self) -> u32 {
        (self.pts_us.max(0) / 1000) as u32
    }
}

/// Everything an output needs to (re)start a stream: both decoder configs.
#[derive(Debug, Clone)]
pub struct StreamConfig {
    pub video: VideoConfig,
    pub audio: AudioConfig,
}

/// Merges the packets of two tracks into one stream ordered by timestamp.
///
/// Audio and video encoders emit chunks independently, so they arrive slightly
/// out of order. A packet is released once the other track has caught up to it,
/// or once it is older than `max_hold_us` (a track went silent). A packet that
/// arrives later than that keeps its own timestamp: only each track's own
/// timestamps must increase, and they are kept at least 1 ms apart so they
/// stay distinct in millisecond-based FLV/RTMP.
///
/// The stream starts with the first video keyframe. A hardware video encoder
/// can take seconds to emit it, so audio is held until then and only the audio
/// that precedes that keyframe is dropped.
pub struct Interleaver {
    video: std::collections::VecDeque<Packet>,
    audio: std::collections::VecDeque<Packet>,
    max_hold_us: i64,
    last_video: Option<i64>,
    last_audio: Option<i64>,
    started: bool,
}

/// Audio held while waiting for the first video keyframe (about 20 s of AAC).
const MAX_PRESTART_AUDIO: usize = 1000;

impl Interleaver {
    pub fn new(max_hold_us: i64) -> Self {
        Self {
            video: Default::default(),
            audio: Default::default(),
            max_hold_us,
            last_video: None,
            last_audio: None,
            started: false,
        }
    }

    pub fn push(&mut self, packet: Packet) -> Vec<Packet> {
        if !self.started {
            match packet.track {
                Track::Audio => {
                    if self.audio.len() == MAX_PRESTART_AUDIO {
                        self.audio.pop_front();
                    }
                    self.audio.push_back(packet);
                    return Vec::new();
                }
                Track::Video if !packet.keyframe => return Vec::new(),
                Track::Video => {
                    self.started = true;
                    let start = packet.pts_us;
                    self.audio.retain(|a| a.pts_us >= start);
                }
            }
        }
        match packet.track {
            Track::Video => self.video.push_back(packet),
            Track::Audio => self.audio.push_back(packet),
        }
        self.drain(false)
    }

    /// Releases everything still held, in timestamp order. Audio that never
    /// got a video keyframe to start the stream is discarded.
    pub fn flush(&mut self) -> Vec<Packet> {
        if !self.started {
            self.audio.clear();
        }
        self.drain(true)
    }

    fn drain(&mut self, all: bool) -> Vec<Packet> {
        let mut out = Vec::new();
        loop {
            let newest = self
                .video
                .back()
                .map(|p| p.pts_us)
                .into_iter()
                .chain(self.audio.back().map(|p| p.pts_us))
                .max();
            let next = match (self.video.front(), self.audio.front()) {
                (Some(v), Some(a)) => {
                    if v.pts_us <= a.pts_us {
                        Track::Video
                    } else {
                        Track::Audio
                    }
                }
                (Some(v), None) => {
                    if all || newest.unwrap_or(v.pts_us) - v.pts_us >= self.max_hold_us {
                        Track::Video
                    } else {
                        break;
                    }
                }
                (None, Some(a)) => {
                    if all || newest.unwrap_or(a.pts_us) - a.pts_us >= self.max_hold_us {
                        Track::Audio
                    } else {
                        break;
                    }
                }
                (None, None) => break,
            };
            let mut packet = match next {
                Track::Video => self.video.pop_front(),
                Track::Audio => self.audio.pop_front(),
            }
            .expect("front checked above");
            let last = match packet.track {
                Track::Video => &mut self.last_video,
                Track::Audio => &mut self.last_audio,
            };
            if let Some(prev) = *last {
                if packet.pts_us < prev + 1000 {
                    packet.pts_us = prev + 1000;
                }
            }
            *last = Some(packet.pts_us);
            out.push(packet);
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(track: Track, pts_us: i64) -> Packet {
        Packet {
            track,
            pts_us,
            keyframe: true,
            data: Bytes::new(),
        }
    }

    #[test]
    fn interleaver_orders_by_timestamp() {
        let mut il = Interleaver::new(500_000);
        let mut out = Vec::new();
        out.extend(il.push(p(Track::Video, 0)));
        out.extend(il.push(p(Track::Video, 33_000)));
        out.extend(il.push(p(Track::Audio, 10_000)));
        out.extend(il.push(p(Track::Audio, 31_000)));
        out.extend(il.push(p(Track::Audio, 52_000)));
        out.extend(il.flush());
        let ts: Vec<i64> = out.iter().map(|p| p.pts_us).collect();
        assert_eq!(ts, vec![0, 10_000, 31_000, 33_000, 52_000]);
    }

    #[test]
    fn interleaver_releases_single_track_after_hold() {
        let mut il = Interleaver::new(100_000);
        assert!(il.push(p(Track::Video, 0)).is_empty());
        let out = il.push(p(Track::Video, 150_000));
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].pts_us, 0);
    }

    #[test]
    fn holds_audio_until_the_first_video_keyframe() {
        let mut il = Interleaver::new(100_000);
        let mut out = Vec::new();
        // Audio flows for 2 s before the video encoder produces anything.
        for i in 0..100 {
            out.extend(il.push(p(Track::Audio, i * 20_000)));
        }
        assert!(out.is_empty(), "audio must wait for video");
        // A delta frame cannot start the stream.
        let mut delta = p(Track::Video, 10_000);
        delta.keyframe = false;
        out.extend(il.push(delta));
        out.extend(il.push(p(Track::Video, 30_000)));
        out.extend(il.flush());
        let first_audio = out.iter().find(|p| p.track == Track::Audio).unwrap().pts_us;
        assert_eq!(
            first_audio, 40_000,
            "audio before the keyframe is dropped, the rest kept"
        );
        assert_eq!(out.iter().filter(|p| p.track == Track::Audio).count(), 98);
        assert_eq!(out.iter().filter(|p| p.track == Track::Video).count(), 1);
    }

    #[test]
    fn late_packets_keep_their_timestamps_but_tracks_stay_monotonic() {
        let mut il = Interleaver::new(10_000);
        let mut out = Vec::new();
        out.extend(il.push(p(Track::Video, 0)));
        out.extend(il.push(p(Track::Video, 50_000)));
        out.extend(il.push(p(Track::Video, 60_000)));
        // Audio arrives long after the video it belongs with.
        out.extend(il.push(p(Track::Audio, 1_000)));
        // A video frame with a repeated timestamp.
        out.extend(il.push(p(Track::Video, 60_000)));
        out.extend(il.flush());
        let audio: Vec<i64> = out
            .iter()
            .filter(|p| p.track == Track::Audio)
            .map(|p| p.pts_us)
            .collect();
        assert_eq!(audio, vec![1_000]);
        let video: Vec<i64> = out
            .iter()
            .filter(|p| p.track == Track::Video)
            .map(|p| p.pts_us)
            .collect();
        assert_eq!(video, vec![0, 50_000, 60_000, 61_000]);
    }
}
