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

/// Reorders packets of two tracks into one stream with non-decreasing timestamps.
///
/// Audio and video encoders emit chunks independently, so they arrive slightly
/// out of order. A packet is released once the other track has caught up to it,
/// or once it is older than `max_hold_us` (a track went silent).
pub struct Interleaver {
    video: std::collections::VecDeque<Packet>,
    audio: std::collections::VecDeque<Packet>,
    max_hold_us: i64,
    last_out: i64,
}

impl Interleaver {
    pub fn new(max_hold_us: i64) -> Self {
        Self {
            video: Default::default(),
            audio: Default::default(),
            max_hold_us,
            last_out: i64::MIN,
        }
    }

    pub fn push(&mut self, packet: Packet) -> Vec<Packet> {
        match packet.track {
            Track::Video => self.video.push_back(packet),
            Track::Audio => self.audio.push_back(packet),
        }
        self.drain(false)
    }

    /// Releases everything still held, in timestamp order.
    pub fn flush(&mut self) -> Vec<Packet> {
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
            // A late packet from a stalled track must not move the clock backwards.
            if packet.pts_us < self.last_out {
                packet.pts_us = self.last_out;
            }
            self.last_out = packet.pts_us;
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
            keyframe: false,
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
    fn interleaver_never_goes_backwards() {
        let mut il = Interleaver::new(10_000);
        il.push(p(Track::Video, 0));
        let out = il.push(p(Track::Video, 50_000));
        assert_eq!(out.len(), 1);
        il.push(p(Track::Video, 60_000));
        // Audio arrives late with an old timestamp.
        let mut out = il.push(p(Track::Audio, 1_000));
        out.extend(il.flush());
        let ts: Vec<i64> = out.iter().map(|p| p.pts_us).collect();
        let mut sorted = ts.clone();
        sorted.sort();
        assert_eq!(ts, sorted);
    }
}
