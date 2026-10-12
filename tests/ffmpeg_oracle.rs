//! End-to-end checks of the Rust media path with FFmpeg as an independent
//! oracle: FFmpeg encodes real H.264/AAC, streamFree muxes and publishes it,
//! and FFmpeg/ffprobe read the result back.
//!
//! Skipped (with a message) when `ffmpeg`/`ffprobe` are not installed.

use bytes::Bytes;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Duration;
use streamfree::live::{DestinationSpec, Session, SessionOptions};
use streamfree::media::{AudioConfig, Packet, StreamConfig, Track, VideoConfig};
use streamfree::mp4::Mp4Writer;
use streamfree::rtmp::{Publisher, Target};

const FPS: u32 = 30;
const SECONDS: u32 = 4;

fn have_ffmpeg() -> bool {
    let ok = |bin: &str| {
        Command::new(bin)
            .arg("-version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|s| s.success())
    };
    if ok("ffmpeg") && ok("ffprobe") {
        true
    } else {
        eprintln!("skipping: ffmpeg/ffprobe not installed");
        false
    }
}

fn run(cmd: &mut Command) {
    let out = cmd.output().expect("spawn");
    assert!(
        out.status.success(),
        "{:?} failed: {}",
        cmd,
        String::from_utf8_lossy(&out.stderr)
    );
}

/// Splits an Annex-B byte stream into NAL units (without start codes).
fn nal_units(data: &[u8]) -> Vec<&[u8]> {
    let mut starts = Vec::new();
    let mut i = 0;
    while i + 3 <= data.len() {
        if data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 1 {
            starts.push(i + 3);
            i += 3;
        } else {
            i += 1;
        }
    }
    let mut out = Vec::new();
    for (n, &start) in starts.iter().enumerate() {
        let mut end = starts.get(n + 1).map(|s| s - 3).unwrap_or(data.len());
        while end > start && data[end - 1] == 0 {
            end -= 1;
        }
        out.push(&data[start..end]);
    }
    out
}

struct Media {
    config: StreamConfig,
    packets: Vec<Packet>,
}

/// Encodes a test pattern and a tone with FFmpeg and converts them to the
/// packet format the studio sends: length-prefixed AVC and raw AAC frames.
fn encode_test_media(dir: &Path) -> Media {
    let h264 = dir.join("v.h264");
    let aac = dir.join("a.aac");
    run(Command::new("nice")
        .args([
            "-n",
            "19",
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
        ])
        .args([
            "-f",
            "lavfi",
            "-i",
            &format!("testsrc2=size=640x360:rate={FPS}:duration={SECONDS}"),
        ])
        .args([
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-profile:v",
            "high",
            "-bf",
            "0",
            "-g",
            &(FPS * 2).to_string(),
        ])
        .args([
            "-pix_fmt",
            "yuv420p",
            "-x264-params",
            "aud=1:threads=2",
            "-f",
            "h264",
        ])
        .arg(&h264));
    run(Command::new("nice")
        .args([
            "-n",
            "19",
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
        ])
        .args([
            "-f",
            "lavfi",
            "-i",
            &format!("sine=frequency=440:sample_rate=48000:duration={SECONDS}"),
        ])
        .args(["-ac", "2", "-c:a", "aac", "-b:a", "128k", "-f", "adts"])
        .arg(&aac));

    let data = std::fs::read(&h264).unwrap();
    let mut sps = None;
    let mut pps = None;
    let mut frames: Vec<(bool, Vec<u8>)> = Vec::new();
    for nal in nal_units(&data) {
        match nal[0] & 0x1f {
            9 => frames.push((false, Vec::new())), // access unit delimiter
            7 => sps = Some(nal.to_vec()),
            8 => pps = Some(nal.to_vec()),
            kind => {
                let frame = frames.last_mut().expect("stream starts with an AUD");
                if kind == 5 {
                    frame.0 = true;
                }
                frame.1.extend_from_slice(&(nal.len() as u32).to_be_bytes());
                frame.1.extend_from_slice(nal);
            }
        }
    }
    let (sps, pps) = (sps.expect("SPS"), pps.expect("PPS"));
    let mut avcc = vec![1, sps[1], sps[2], sps[3], 0xff, 0xe1];
    avcc.extend_from_slice(&(sps.len() as u16).to_be_bytes());
    avcc.extend_from_slice(&sps);
    avcc.push(1);
    avcc.extend_from_slice(&(pps.len() as u16).to_be_bytes());
    avcc.extend_from_slice(&pps);

    let mut packets: Vec<Packet> = frames
        .into_iter()
        .filter(|(_, d)| !d.is_empty())
        .enumerate()
        .map(|(i, (key, data))| Packet {
            track: Track::Video,
            pts_us: i as i64 * 1_000_000 / FPS as i64,
            keyframe: key,
            data: Bytes::from(data),
        })
        .collect();

    let adts = std::fs::read(&aac).unwrap();
    let mut pos = 0;
    let mut asc = None;
    let mut n = 0i64;
    while pos + 7 <= adts.len() {
        let h = &adts[pos..];
        assert_eq!((h[0], h[1] & 0xf0), (0xff, 0xf0), "ADTS sync");
        let protection_absent = h[1] & 1 == 1;
        let profile = (h[2] >> 6) + 1;
        let sr_index = (h[2] >> 2) & 0x0f;
        let channels = ((h[2] & 1) << 2) | (h[3] >> 6);
        let len = (((h[3] & 3) as usize) << 11) | ((h[4] as usize) << 3) | ((h[5] as usize) >> 5);
        let header = if protection_absent { 7 } else { 9 };
        asc.get_or_insert_with(|| {
            let v: u16 =
                ((profile as u16) << 11) | ((sr_index as u16) << 7) | ((channels as u16) << 3);
            v.to_be_bytes().to_vec()
        });
        packets.push(Packet {
            track: Track::Audio,
            pts_us: n * 1024 * 1_000_000 / 48_000,
            keyframe: true,
            data: Bytes::copy_from_slice(&adts[pos + header..pos + len]),
        });
        n += 1;
        pos += len;
    }
    packets.sort_by_key(|p| p.pts_us);

    Media {
        config: StreamConfig {
            video: VideoConfig {
                width: 640,
                height: 360,
                framerate: FPS,
                bitrate: 1_000_000,
                avcc: avcc.into(),
            },
            audio: AudioConfig {
                sample_rate: 48_000,
                channels: 2,
                bitrate: 128_000,
                asc: asc.unwrap().into(),
            },
        },
        packets,
    }
}

struct Probe {
    codecs: Vec<String>,
    duration: f64,
    video_frames: u64,
}

fn probe(path: &Path) -> Probe {
    let out = Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-count_frames",
            "-show_entries",
            "stream=codec_name,nb_read_frames:format=duration",
            "-of",
            "json",
        ])
        .arg(path)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "ffprobe: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    let streams = v["streams"].as_array().unwrap();
    Probe {
        codecs: streams
            .iter()
            .map(|s| s["codec_name"].as_str().unwrap().to_owned())
            .collect(),
        duration: v["format"]["duration"]
            .as_str()
            .unwrap_or("0")
            .parse()
            .unwrap(),
        video_frames: streams
            .iter()
            .find(|s| s["codec_name"] == "h264")
            .and_then(|s| s["nb_read_frames"].as_str())
            .and_then(|n| n.parse().ok())
            .unwrap_or(0),
    }
}

/// Decodes the whole file; FFmpeg reports any corrupt packet as an error.
fn decodes_cleanly(path: &Path) {
    let out = Command::new("ffmpeg")
        .args(["-v", "error", "-i"])
        .arg(path)
        .args(["-f", "null", "-"])
        .output()
        .unwrap();
    let errors = String::from_utf8_lossy(&out.stderr);
    assert!(
        out.status.success() && errors.trim().is_empty(),
        "decode errors in {}: {errors}",
        path.display()
    );
}

#[test]
fn mp4_recording_is_valid() {
    if !have_ffmpeg() {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let media = encode_test_media(dir.path());
    let path = dir.path().join("rec.mp4");
    let file = std::fs::File::create(&path).unwrap();
    let mut writer = Mp4Writer::new(std::io::BufWriter::new(file), &media.config).unwrap();
    for p in &media.packets {
        writer.push(p).unwrap();
    }
    writer.finish().unwrap();

    let info = probe(&path);
    assert_eq!(info.codecs, vec!["h264", "aac"]);
    assert!(
        (info.duration - SECONDS as f64).abs() < 0.2,
        "duration {}",
        info.duration
    );
    assert_eq!(info.video_frames, (FPS * SECONDS) as u64);
    decodes_cleanly(&path);
}

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

/// Starts an FFmpeg RTMP server that saves what it receives.
fn rtmp_sink(port: u16, out: &Path) -> std::process::Child {
    Command::new("nice")
        .args([
            "-n",
            "19",
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-listen",
            "1",
            "-f",
            "flv",
        ])
        .args(["-i", &format!("rtmp://127.0.0.1:{port}/live/test")])
        .args(["-c", "copy", "-f", "flv"])
        .arg(out)
        .stdout(Stdio::null())
        .spawn()
        .unwrap()
}

async fn wait_exit(mut child: std::process::Child) {
    for _ in 0..200 {
        if child.try_wait().unwrap().is_some() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let _ = child.kill();
    panic!("ffmpeg sink did not exit");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn publishes_over_rtmp() {
    if !have_ffmpeg() {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let media = encode_test_media(dir.path());
    // FFmpeg's `-listen 1` accepts exactly one client, so readiness is found
    // by retrying the publish rather than by a probe connection.
    let port = free_port();
    let out = dir.path().join("sink.flv");
    let sink = rtmp_sink(port, &out);
    let target = Target::parse(&format!("rtmp://127.0.0.1:{port}/live"), "test").unwrap();
    let mut publisher = None;
    for _ in 0..100 {
        match Publisher::connect(&target).await {
            Ok(p) => {
                publisher = Some(p);
                break;
            }
            Err(_) => tokio::time::sleep(Duration::from_millis(100)).await,
        }
    }
    let mut publisher = publisher.expect("connected to ffmpeg");
    publisher.send_headers(&media.config).await.unwrap();
    for p in &media.packets {
        publisher.send_packet(p, p.pts_ms()).await.unwrap();
    }
    publisher.close().await;
    wait_exit(sink).await;

    let info = probe(&out);
    assert_eq!(info.codecs, vec!["h264", "aac"]);
    assert!(
        (info.duration - SECONDS as f64).abs() < 0.3,
        "duration {}",
        info.duration
    );
    assert_eq!(info.video_frames, (FPS * SECONDS) as u64);
    decodes_cleanly(&out);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn session_fans_out_to_two_destinations_and_records() {
    if !have_ffmpeg() {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let media = encode_test_media(dir.path());
    let ports = [free_port(), free_port()];
    let outs = [dir.path().join("a.flv"), dir.path().join("b.flv")];
    let sinks: Vec<_> = ports
        .iter()
        .zip(outs.iter())
        .map(|(p, o)| rtmp_sink(*p, o))
        .collect();
    // Give both listeners time to bind; Publisher retries on its own anyway.
    tokio::time::sleep(Duration::from_millis(800)).await;

    let record = dir.path().join("rec.mp4");
    let destinations = ports
        .iter()
        .enumerate()
        .map(|(i, port)| DestinationSpec {
            id: format!("d{i}"),
            name: format!("sink {i}"),
            target: Target::parse(&format!("rtmp://127.0.0.1:{port}/live"), "test").unwrap(),
        })
        .collect();
    let mut session = Session::start(
        media.config.clone(),
        SessionOptions {
            destinations,
            record_path: Some(record.clone()),
        },
    );
    // Wait until both outputs are live before sending, as a studio would
    // keep streaming while they connect.
    for _ in 0..100 {
        let (outputs, _) = session.status().await;
        if outputs
            .iter()
            .all(|o| o.state == streamfree::live::OutputState::Live)
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    for p in media.packets.iter().cloned() {
        session.push(p);
        // Real time is not needed; a short yield keeps the queues small.
        tokio::task::yield_now().await;
    }
    let (outputs, recording) = session.stop().await;
    for sink in sinks {
        wait_exit(sink).await;
    }
    assert!(recording.error.is_none(), "{:?}", recording.error);
    for o in &outputs {
        assert_eq!(o.dropped, 0, "{} dropped packets", o.name);
    }
    for path in outs.iter().chain(std::iter::once(&record)) {
        let info = probe(path);
        assert_eq!(info.codecs, vec!["h264", "aac"], "{}", path.display());
        assert_eq!(
            info.video_frames,
            (FPS * SECONDS) as u64,
            "{}",
            path.display()
        );
        decodes_cleanly(path);
    }
}
