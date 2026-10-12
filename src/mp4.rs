//! Fragmented MP4 recorder (ISO/IEC 14496-12 ISO BMFF, 14496-14 MP4, 14496-15 AVC).
//!
//! The file starts with `ftyp` + `moov` (sample tables empty, `mvex` present) and
//! then holds one `moof` + `mdat` pair per fragment. Each fragment starts at a
//! video keyframe, so a recording cut short by a crash or power loss stays
//! playable up to its last complete fragment.

use crate::media::{Packet, StreamConfig, Track};
use std::io::{self, Seek, SeekFrom, Write};

const VIDEO_TRACK: u32 = 1;
const AUDIO_TRACK: u32 = 2;
const VIDEO_TIMESCALE: u64 = 90_000;
const MOVIE_TIMESCALE: u64 = 1000;
/// Minimum fragment length; the next keyframe after this starts a new fragment.
const FRAGMENT_US: i64 = 1_000_000;
/// AAC-LC frames always hold 1024 samples per channel.
const AAC_FRAME_SAMPLES: u32 = 1024;

const SAMPLE_SYNC: u32 = 0x0200_0000;
const SAMPLE_NON_SYNC: u32 = 0x0101_0000;

struct Sample {
    dts: u64,
    keyframe: bool,
    data: bytes::Bytes,
}

struct TrackState {
    timescale: u64,
    pending: Vec<Sample>,
    /// Decode time of the last sample written, used to keep durations positive.
    last_dts: Option<u64>,
    end_dts: u64,
}

impl TrackState {
    fn new(timescale: u64) -> Self {
        Self {
            timescale,
            pending: Vec::new(),
            last_dts: None,
            end_dts: 0,
        }
    }

    fn to_dts(&self, pts_us: i64) -> u64 {
        (pts_us.max(0) as u128 * self.timescale as u128 / 1_000_000) as u64
    }

    fn push(&mut self, packet: &Packet) {
        let mut dts = self.to_dts(packet.pts_us);
        let floor = self
            .pending
            .last()
            .map(|s| s.dts + 1)
            .or(self.last_dts.map(|d| d + 1))
            .unwrap_or(0);
        if dts < floor {
            dts = floor;
        }
        self.pending.push(Sample {
            dts,
            keyframe: packet.keyframe,
            data: packet.data.clone(),
        });
    }
}

pub struct Mp4Writer<W: Write + Seek> {
    out: W,
    video_frame_duration: u64,
    sequence: u32,
    video: TrackState,
    audio: TrackState,
    mehd_offset: u64,
    started: bool,
    first_keyframe_us: i64,
    fragment_start_us: i64,
    bytes_written: u64,
}

impl<W: Write + Seek> Mp4Writer<W> {
    pub fn new(mut out: W, config: &StreamConfig) -> io::Result<Self> {
        let ftyp = ftyp();
        let (moov, mehd_in_moov) = moov(config);
        out.write_all(&ftyp)?;
        out.write_all(&moov)?;
        let fps = config.video.framerate.max(1) as u64;
        Ok(Self {
            out,
            video_frame_duration: VIDEO_TIMESCALE / fps,
            sequence: 0,
            video: TrackState::new(VIDEO_TIMESCALE),
            audio: TrackState::new(config.audio.sample_rate.max(1) as u64),
            mehd_offset: ftyp.len() as u64 + mehd_in_moov as u64,
            started: false,
            first_keyframe_us: 0,
            fragment_start_us: 0,
            bytes_written: (ftyp.len() + moov.len()) as u64,
        })
    }

    pub fn bytes_written(&self) -> u64 {
        self.bytes_written
    }

    pub fn push(&mut self, packet: &Packet) -> io::Result<()> {
        match packet.track {
            Track::Video => {
                if !self.started {
                    if !packet.keyframe {
                        return Ok(());
                    }
                    self.started = true;
                    self.first_keyframe_us = packet.pts_us;
                    self.fragment_start_us = packet.pts_us;
                } else if packet.keyframe && packet.pts_us - self.fragment_start_us >= FRAGMENT_US {
                    let next_video_dts = self.video.to_dts(packet.pts_us);
                    self.write_fragment(Some(next_video_dts))?;
                    self.fragment_start_us = packet.pts_us;
                }
                self.video.push(packet);
            }
            Track::Audio => {
                if !self.started || packet.pts_us < self.first_keyframe_us {
                    return Ok(());
                }
                self.audio.push(packet);
            }
        }
        Ok(())
    }

    /// Writes the last fragment and the total duration. The file is complete
    /// and playable after this returns.
    pub fn finish(mut self) -> io::Result<W> {
        if !self.video.pending.is_empty() || !self.audio.pending.is_empty() {
            self.write_fragment(None)?;
        }
        let video_ms = self.video.end_dts * MOVIE_TIMESCALE / VIDEO_TIMESCALE;
        let audio_ms = self.audio.end_dts * MOVIE_TIMESCALE / self.audio.timescale;
        let first_ms =
            self.video.to_dts(self.first_keyframe_us) * MOVIE_TIMESCALE / VIDEO_TIMESCALE;
        let duration_ms = video_ms.max(audio_ms).saturating_sub(first_ms);
        let end = self.out.stream_position()?;
        // mehd is a version-1 full box: 8 bytes header, 4 bytes version/flags.
        self.out.seek(SeekFrom::Start(self.mehd_offset + 12))?;
        self.out.write_all(&duration_ms.to_be_bytes())?;
        self.out.seek(SeekFrom::Start(end))?;
        self.out.flush()?;
        Ok(self.out)
    }

    fn write_fragment(&mut self, next_video_dts: Option<u64>) -> io::Result<()> {
        let video = std::mem::take(&mut self.video.pending);
        let audio = std::mem::take(&mut self.audio.pending);
        if video.is_empty() && audio.is_empty() {
            return Ok(());
        }
        let video_runs = durations(&video, next_video_dts, self.video_frame_duration);
        let audio_runs = durations(&audio, None, AAC_FRAME_SAMPLES as u64);

        self.sequence += 1;
        let tracks = [
            (VIDEO_TRACK, &video, &video_runs),
            (AUDIO_TRACK, &audio, &audio_runs),
        ];
        // The moof size does not depend on the offset values, so build it once
        // to measure, then again with the real offsets.
        let probe = moof(self.sequence, &tracks, &[0, 0]);
        let video_bytes: usize = video.iter().map(|s| s.data.len()).sum();
        let first = probe.len() as i32 + 8;
        let offsets = [first, first + video_bytes as i32];
        let moof = moof(self.sequence, &tracks, &offsets);

        let audio_bytes: usize = audio.iter().map(|s| s.data.len()).sum();
        let mdat_len = 8 + video_bytes + audio_bytes;
        self.out.write_all(&moof)?;
        self.out.write_all(&(mdat_len as u32).to_be_bytes())?;
        self.out.write_all(b"mdat")?;
        for sample in video.iter().chain(audio.iter()) {
            self.out.write_all(&sample.data)?;
        }
        self.out.flush()?;
        self.bytes_written += (moof.len() + mdat_len) as u64;

        for (state, samples, runs) in [
            (&mut self.video, &video, &video_runs),
            (&mut self.audio, &audio, &audio_runs),
        ] {
            if let (Some(last), Some(dur)) = (samples.last(), runs.last()) {
                state.last_dts = Some(last.dts);
                state.end_dts = last.dts + *dur as u64;
            }
        }
        Ok(())
    }
}

/// Sample durations from decode-time deltas. The last sample lasts until
/// `next_dts` when it is known, otherwise `fallback`.
fn durations(samples: &[Sample], next_dts: Option<u64>, fallback: u64) -> Vec<u32> {
    let mut out = Vec::with_capacity(samples.len());
    for (i, sample) in samples.iter().enumerate() {
        let next = samples.get(i + 1).map(|s| s.dts).or(next_dts);
        let duration = match next {
            Some(next) if next > sample.dts => next - sample.dts,
            _ => fallback,
        };
        out.push(duration.min(u32::MAX as u64) as u32);
    }
    out
}

// ---------------------------------------------------------------- boxes

fn bx(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(8 + body.len());
    out.extend_from_slice(&((8 + body.len()) as u32).to_be_bytes());
    out.extend_from_slice(kind);
    out.extend_from_slice(body);
    out
}

fn full(kind: &[u8; 4], version: u8, flags: u32, body: &[u8]) -> Vec<u8> {
    let mut inner = Vec::with_capacity(4 + body.len());
    inner.push(version);
    inner.extend_from_slice(&flags.to_be_bytes()[1..]);
    inner.extend_from_slice(body);
    bx(kind, &inner)
}

fn cat(parts: &[&[u8]]) -> Vec<u8> {
    parts.concat()
}

const MATRIX: [u32; 9] = [0x0001_0000, 0, 0, 0, 0x0001_0000, 0, 0, 0, 0x4000_0000];

fn matrix() -> Vec<u8> {
    MATRIX.iter().flat_map(|v| v.to_be_bytes()).collect()
}

fn ftyp() -> Vec<u8> {
    bx(
        b"ftyp",
        &cat(&[
            b"isom",
            &0x200u32.to_be_bytes(),
            b"isom",
            b"iso6",
            b"iso2",
            b"avc1",
            b"mp41",
        ]),
    )
}

/// Returns the `moov` box and the offset of `mehd` inside it.
fn moov(config: &StreamConfig) -> (Vec<u8>, usize) {
    let mut mvhd = Vec::new();
    mvhd.extend_from_slice(&[0; 8]); // creation, modification time
    mvhd.extend_from_slice(&(MOVIE_TIMESCALE as u32).to_be_bytes());
    mvhd.extend_from_slice(&0u32.to_be_bytes()); // duration: see mehd
    mvhd.extend_from_slice(&0x0001_0000u32.to_be_bytes()); // rate 1.0
    mvhd.extend_from_slice(&0x0100u16.to_be_bytes()); // volume 1.0
    mvhd.extend_from_slice(&[0; 10]);
    mvhd.extend_from_slice(&matrix());
    mvhd.extend_from_slice(&[0; 24]);
    mvhd.extend_from_slice(&3u32.to_be_bytes()); // next_track_ID
    let mvhd = full(b"mvhd", 0, 0, &mvhd);

    let video = video_trak(config);
    let audio = audio_trak(config);

    let mehd = full(b"mehd", 1, 0, &0u64.to_be_bytes());
    let trex = |track: u32| {
        full(
            b"trex",
            0,
            0,
            &cat(&[&track.to_be_bytes(), &1u32.to_be_bytes(), &[0; 12]]),
        )
    };
    let mvex = bx(
        b"mvex",
        &cat(&[&mehd, &trex(VIDEO_TRACK), &trex(AUDIO_TRACK)]),
    );

    let mehd_offset = 8 + mvhd.len() + video.len() + audio.len() + 8;
    let moov = bx(b"moov", &cat(&[&mvhd, &video, &audio, &mvex]));
    (moov, mehd_offset)
}

fn tkhd(track: u32, volume: u16, width: u32, height: u32) -> Vec<u8> {
    let mut body = Vec::new();
    body.extend_from_slice(&[0; 8]);
    body.extend_from_slice(&track.to_be_bytes());
    body.extend_from_slice(&[0; 4]); // reserved
    body.extend_from_slice(&[0; 4]); // duration
    body.extend_from_slice(&[0; 8]); // reserved
    body.extend_from_slice(&[0; 4]); // layer, alternate_group
    body.extend_from_slice(&volume.to_be_bytes());
    body.extend_from_slice(&[0; 2]);
    body.extend_from_slice(&matrix());
    body.extend_from_slice(&(width << 16).to_be_bytes());
    body.extend_from_slice(&(height << 16).to_be_bytes());
    full(b"tkhd", 0, 0x3, &body)
}

fn mdhd(timescale: u32) -> Vec<u8> {
    let mut body = Vec::new();
    body.extend_from_slice(&[0; 8]);
    body.extend_from_slice(&timescale.to_be_bytes());
    body.extend_from_slice(&[0; 4]);
    body.extend_from_slice(&0x55C4u16.to_be_bytes()); // language "und"
    body.extend_from_slice(&[0; 2]);
    full(b"mdhd", 0, 0, &body)
}

fn hdlr(handler: &[u8; 4], name: &str) -> Vec<u8> {
    let mut body = vec![0; 4];
    body.extend_from_slice(handler);
    body.extend_from_slice(&[0; 12]);
    body.extend_from_slice(name.as_bytes());
    body.push(0);
    full(b"hdlr", 0, 0, &body)
}

fn dinf() -> Vec<u8> {
    let url = full(b"url ", 0, 1, &[]);
    let dref = full(b"dref", 0, 0, &cat(&[&1u32.to_be_bytes(), &url]));
    bx(b"dinf", &dref)
}

fn stbl(sample_entry: &[u8]) -> Vec<u8> {
    let stsd = full(b"stsd", 0, 0, &cat(&[&1u32.to_be_bytes(), sample_entry]));
    let stts = full(b"stts", 0, 0, &[0; 4]);
    let stsc = full(b"stsc", 0, 0, &[0; 4]);
    let stsz = full(b"stsz", 0, 0, &[0; 8]);
    let stco = full(b"stco", 0, 0, &[0; 4]);
    bx(b"stbl", &cat(&[&stsd, &stts, &stsc, &stsz, &stco]))
}

fn video_trak(config: &StreamConfig) -> Vec<u8> {
    let v = &config.video;
    let mut avc1 = Vec::new();
    avc1.extend_from_slice(&[0; 6]);
    avc1.extend_from_slice(&1u16.to_be_bytes()); // data_reference_index
    avc1.extend_from_slice(&[0; 16]);
    avc1.extend_from_slice(&(v.width as u16).to_be_bytes());
    avc1.extend_from_slice(&(v.height as u16).to_be_bytes());
    avc1.extend_from_slice(&0x0048_0000u32.to_be_bytes());
    avc1.extend_from_slice(&0x0048_0000u32.to_be_bytes());
    avc1.extend_from_slice(&[0; 4]);
    avc1.extend_from_slice(&1u16.to_be_bytes()); // frame_count
    let mut compressor = [0u8; 32];
    let name = b"streamFree H.264";
    compressor[0] = name.len() as u8;
    compressor[1..=name.len()].copy_from_slice(name);
    avc1.extend_from_slice(&compressor);
    avc1.extend_from_slice(&0x0018u16.to_be_bytes());
    avc1.extend_from_slice(&(-1i16).to_be_bytes());
    avc1.extend_from_slice(&bx(b"avcC", &v.avcc));
    let avc1 = bx(b"avc1", &avc1);

    let vmhd = full(b"vmhd", 0, 1, &[0; 8]);
    let minf = bx(b"minf", &cat(&[&vmhd, &dinf(), &stbl(&avc1)]));
    let mdia = bx(
        b"mdia",
        &cat(&[
            &mdhd(VIDEO_TIMESCALE as u32),
            &hdlr(b"vide", "VideoHandler"),
            &minf,
        ]),
    );
    bx(
        b"trak",
        &cat(&[&tkhd(VIDEO_TRACK, 0, v.width, v.height), &mdia]),
    )
}

/// MPEG-4 descriptor with a one-byte size (all descriptors here are < 128 bytes).
fn descriptor(tag: u8, body: &[u8]) -> Vec<u8> {
    let mut out = vec![tag];
    let mut len = body.len();
    // Expandable size field, written in 7-bit groups.
    let mut groups = vec![(len & 0x7f) as u8];
    len >>= 7;
    while len > 0 {
        groups.push(((len & 0x7f) as u8) | 0x80);
        len >>= 7;
    }
    groups.reverse();
    out.extend_from_slice(&groups);
    out.extend_from_slice(body);
    out
}

fn audio_trak(config: &StreamConfig) -> Vec<u8> {
    let a = &config.audio;
    let dsi = descriptor(0x05, &a.asc);
    let mut dcd = vec![0x40, 0x15]; // MPEG-4 Audio, AudioStream
    dcd.extend_from_slice(&[0, 0, 0]); // bufferSizeDB
    dcd.extend_from_slice(&a.bitrate.to_be_bytes()); // maxBitrate
    dcd.extend_from_slice(&a.bitrate.to_be_bytes()); // avgBitrate
    dcd.extend_from_slice(&dsi);
    let dcd = descriptor(0x04, &dcd);
    let sl = descriptor(0x06, &[0x02]);
    let mut es = Vec::new();
    es.extend_from_slice(&(AUDIO_TRACK as u16).to_be_bytes());
    es.push(0);
    es.extend_from_slice(&dcd);
    es.extend_from_slice(&sl);
    let esds = full(b"esds", 0, 0, &descriptor(0x03, &es));

    let mut mp4a = Vec::new();
    mp4a.extend_from_slice(&[0; 6]);
    mp4a.extend_from_slice(&1u16.to_be_bytes());
    mp4a.extend_from_slice(&[0; 8]);
    mp4a.extend_from_slice(&(a.channels as u16).to_be_bytes());
    mp4a.extend_from_slice(&16u16.to_be_bytes());
    mp4a.extend_from_slice(&[0; 4]);
    mp4a.extend_from_slice(&((a.sample_rate.min(65535)) << 16).to_be_bytes());
    mp4a.extend_from_slice(&esds);
    let mp4a = bx(b"mp4a", &mp4a);

    let smhd = full(b"smhd", 0, 0, &[0; 4]);
    let minf = bx(b"minf", &cat(&[&smhd, &dinf(), &stbl(&mp4a)]));
    let mdia = bx(
        b"mdia",
        &cat(&[&mdhd(a.sample_rate), &hdlr(b"soun", "SoundHandler"), &minf]),
    );
    bx(b"trak", &cat(&[&tkhd(AUDIO_TRACK, 0x0100, 0, 0), &mdia]))
}

fn moof(
    sequence: u32,
    tracks: &[(u32, &Vec<Sample>, &Vec<u32>); 2],
    offsets: &[i32; 2],
) -> Vec<u8> {
    let mfhd = full(b"mfhd", 0, 0, &sequence.to_be_bytes());
    let mut body = mfhd;
    for (i, (track, samples, runs)) in tracks.iter().enumerate() {
        if samples.is_empty() {
            continue;
        }
        let tfhd = full(b"tfhd", 0, 0x02_0000, &track.to_be_bytes());
        let tfdt = full(b"tfdt", 1, 0, &samples[0].dts.to_be_bytes());
        let mut trun = Vec::new();
        trun.extend_from_slice(&(samples.len() as u32).to_be_bytes());
        trun.extend_from_slice(&offsets[i].to_be_bytes());
        for (sample, duration) in samples.iter().zip(runs.iter()) {
            trun.extend_from_slice(&duration.to_be_bytes());
            trun.extend_from_slice(&(sample.data.len() as u32).to_be_bytes());
            let flags = if *track == AUDIO_TRACK || sample.keyframe {
                SAMPLE_SYNC
            } else {
                SAMPLE_NON_SYNC
            };
            trun.extend_from_slice(&flags.to_be_bytes());
        }
        // data-offset, sample-duration, sample-size, sample-flags present
        let trun = full(b"trun", 0, 0x00_0701, &trun);
        body.extend_from_slice(&bx(b"traf", &cat(&[&tfhd, &tfdt, &trun])));
    }
    bx(b"moof", &body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media::{AudioConfig, VideoConfig};
    use bytes::Bytes;
    use std::io::Cursor;

    fn config() -> StreamConfig {
        StreamConfig {
            video: VideoConfig {
                width: 1280,
                height: 720,
                framerate: 30,
                bitrate: 4_000_000,
                avcc: Bytes::from_static(&[1, 0x64, 0, 0x1f, 0xff, 0xe1, 0, 0, 0xe1, 0, 0]),
            },
            audio: AudioConfig {
                sample_rate: 48_000,
                channels: 2,
                bitrate: 128_000,
                asc: Bytes::from_static(&[0x11, 0x90]),
            },
        }
    }

    /// Walks top-level boxes and returns their types.
    fn top_level(buf: &[u8]) -> Vec<String> {
        let mut pos = 0;
        let mut kinds = Vec::new();
        while pos + 8 <= buf.len() {
            let size = u32::from_be_bytes(buf[pos..pos + 4].try_into().unwrap()) as usize;
            kinds.push(String::from_utf8_lossy(&buf[pos + 4..pos + 8]).into_owned());
            assert!(size >= 8, "box too small");
            pos += size;
        }
        assert_eq!(pos, buf.len(), "boxes must tile the file exactly");
        kinds
    }

    #[test]
    fn writes_fragments_starting_at_keyframes() {
        let mut w = Mp4Writer::new(Cursor::new(Vec::new()), &config()).unwrap();
        // A delta frame before the first keyframe is dropped.
        w.push(&Packet {
            track: Track::Video,
            pts_us: 0,
            keyframe: false,
            data: Bytes::from_static(&[9]),
        })
        .unwrap();
        for i in 0..90i64 {
            let key = i % 60 == 0;
            w.push(&Packet {
                track: Track::Video,
                pts_us: 33_333 * (i + 1),
                keyframe: key,
                data: Bytes::from(vec![0u8; 100]),
            })
            .unwrap();
            w.push(&Packet {
                track: Track::Audio,
                pts_us: 33_333 * (i + 1) + 5_000,
                keyframe: true,
                data: Bytes::from(vec![1u8; 20]),
            })
            .unwrap();
        }
        let out = w.finish().unwrap().into_inner();
        let kinds = top_level(&out);
        assert_eq!(kinds[..2], ["ftyp".to_string(), "moov".to_string()]);
        assert_eq!(kinds.iter().filter(|k| *k == "moof").count(), 2);
        assert_eq!(kinds.iter().filter(|k| *k == "mdat").count(), 2);
    }

    #[test]
    fn descriptor_size_is_expandable() {
        assert_eq!(descriptor(5, &[1, 2]), vec![5, 2, 1, 2]);
        let long = descriptor(5, &[0; 200]);
        assert_eq!(&long[..3], &[5, 0x81, 0x48]);
    }
}
