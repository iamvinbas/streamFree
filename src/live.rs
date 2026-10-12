//! A live session: encoded packets from the studio fan out to every enabled
//! destination and to the local recorder.
//!
//! Each output reads from its own broadcast receiver. A slow destination falls
//! behind, loses packets until the next keyframe and catches up; it never
//! slows down the others. A destination that drops reconnects on its own.

use crate::media::{Interleaver, Packet, StreamConfig, Track};
use crate::mp4::Mp4Writer;
use crate::rtmp::{Publisher, Target};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{broadcast, watch, Mutex};

/// Packets buffered per output before a lagging output starts dropping.
const QUEUE_PACKETS: usize = 2048;
const MAX_BACKOFF: Duration = Duration::from_secs(10);
const SEND_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum OutputState {
    Connecting,
    Live,
    Reconnecting,
    Stopped,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
pub struct OutputStatus {
    pub id: String,
    pub name: String,
    pub state: OutputState,
    pub error: Option<String>,
    pub bytes: u64,
    pub dropped: u64,
    pub kbps: u32,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct RecordingStatus {
    pub path: Option<String>,
    pub bytes: u64,
    pub error: Option<String>,
    pub finished: bool,
}

pub struct DestinationSpec {
    pub id: String,
    pub name: String,
    pub target: Target,
}

pub struct SessionOptions {
    pub destinations: Vec<DestinationSpec>,
    pub record_path: Option<PathBuf>,
}

pub struct Session {
    tx: Option<broadcast::Sender<Arc<Packet>>>,
    interleaver: Interleaver,
    statuses: Vec<Arc<Mutex<OutputStatus>>>,
    recording: Arc<Mutex<RecordingStatus>>,
    tasks: Vec<tokio::task::JoinHandle<()>>,
    stop: watch::Sender<bool>,
}

impl Session {
    /// Starts all outputs. `config` holds the decoder configurations, so the
    /// first packets can be sent as soon as they arrive.
    pub fn start(config: StreamConfig, options: SessionOptions) -> Self {
        let (tx, _) = broadcast::channel(QUEUE_PACKETS);
        let (stop, stop_rx) = watch::channel(false);
        let config = Arc::new(config);
        let mut statuses = Vec::new();
        let mut tasks = Vec::new();
        for dest in options.destinations {
            let status = Arc::new(Mutex::new(OutputStatus {
                id: dest.id.clone(),
                name: dest.name.clone(),
                state: OutputState::Connecting,
                error: None,
                bytes: 0,
                dropped: 0,
                kbps: 0,
            }));
            statuses.push(status.clone());
            tasks.push(tokio::spawn(run_destination(
                dest.target,
                config.clone(),
                tx.subscribe(),
                status,
                stop_rx.clone(),
            )));
        }
        let recording = Arc::new(Mutex::new(RecordingStatus::default()));
        if let Some(path) = options.record_path {
            let rx = tx.subscribe();
            let status = recording.clone();
            let config = config.clone();
            tasks.push(tokio::spawn(async move {
                let result = tokio::task::spawn_blocking({
                    let status = status.clone();
                    let path = path.clone();
                    move || record(path, &config, rx, status)
                })
                .await;
                let mut s = status.lock().await;
                s.finished = true;
                match result {
                    Ok(Ok(())) => {}
                    Ok(Err(e)) => s.error = Some(e.to_string()),
                    Err(e) => s.error = Some(e.to_string()),
                }
            }));
        }
        Self {
            tx: Some(tx),
            interleaver: Interleaver::new(300_000),
            statuses,
            recording,
            tasks,
            stop,
        }
    }

    pub fn push(&mut self, packet: Packet) {
        let Some(tx) = &self.tx else { return };
        for p in self.interleaver.push(packet) {
            // An error only means no output is subscribed any more.
            let _ = tx.send(Arc::new(p));
        }
    }

    pub async fn status(&self) -> (Vec<OutputStatus>, RecordingStatus) {
        let mut outputs = Vec::new();
        for s in &self.statuses {
            outputs.push(s.lock().await.clone());
        }
        (outputs, self.recording.lock().await.clone())
    }

    /// Flushes buffered packets, closes every output and waits for the
    /// recording to be finalized.
    pub async fn stop(mut self) -> (Vec<OutputStatus>, RecordingStatus) {
        if let Some(tx) = self.tx.take() {
            for p in self.interleaver.flush() {
                let _ = tx.send(Arc::new(p));
            }
            drop(tx);
        }
        let _ = self.stop.send(true);
        for task in self.tasks.drain(..) {
            let _ = tokio::time::timeout(Duration::from_secs(15), task).await;
        }
        self.status().await
    }
}

fn record(
    path: PathBuf,
    config: &StreamConfig,
    mut rx: broadcast::Receiver<Arc<Packet>>,
    status: Arc<Mutex<RecordingStatus>>,
) -> anyhow::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let file = std::fs::File::create(&path)?;
    status.blocking_lock().path = Some(path.display().to_string());
    let mut writer = Mp4Writer::new(std::io::BufWriter::new(file), config)?;
    let mut waiting_for_key = false;
    let mut last_report = Instant::now();
    loop {
        match rx.blocking_recv() {
            Ok(packet) => {
                if waiting_for_key {
                    if packet.track == Track::Video && packet.keyframe {
                        waiting_for_key = false;
                    } else {
                        continue;
                    }
                }
                writer.push(&packet)?;
                if last_report.elapsed() > Duration::from_millis(500) {
                    status.blocking_lock().bytes = writer.bytes_written();
                    last_report = Instant::now();
                }
            }
            // Disk too slow: skip to the next keyframe rather than corrupt the GOP.
            Err(broadcast::error::RecvError::Lagged(_)) => waiting_for_key = true,
            Err(broadcast::error::RecvError::Closed) => break,
        }
    }
    let bytes = writer.bytes_written();
    let mut out = writer.finish()?;
    std::io::Write::flush(&mut out)?;
    out.into_inner().map_err(|e| e.into_error())?.sync_all()?;
    status.blocking_lock().bytes = bytes;
    Ok(())
}

async fn run_destination(
    target: Target,
    config: Arc<StreamConfig>,
    mut rx: broadcast::Receiver<Arc<Packet>>,
    status: Arc<Mutex<OutputStatus>>,
    mut stop: watch::Receiver<bool>,
) {
    let mut backoff = Duration::from_secs(1);
    let mut total_bytes = 0u64;
    loop {
        if *stop.borrow() {
            break;
        }
        let publisher = tokio::select! {
            r = Publisher::connect(&target) => r,
            _ = stop.changed() => break,
        };
        let mut publisher = match publisher {
            Ok(p) => p,
            Err(e) => {
                set_error(&status, OutputState::Reconnecting, format!("{e:#}")).await;
                tokio::select! {
                    _ = tokio::time::sleep(backoff) => {}
                    _ = stop.changed() => break,
                }
                backoff = (backoff * 2).min(MAX_BACKOFF);
                // Whatever queued during the outage is stale now.
                rx = rx.resubscribe();
                continue;
            }
        };
        if let Err(e) = publisher.send_headers(&config).await {
            set_error(&status, OutputState::Reconnecting, format!("{e:#}")).await;
            continue;
        }
        {
            let mut s = status.lock().await;
            s.state = OutputState::Live;
            s.error = None;
        }
        backoff = Duration::from_secs(1);

        let mut waiting_for_key = true;
        let mut window_start = Instant::now();
        let mut window_bytes = publisher.bytes_sent;
        let outcome: Result<bool, String> = loop {
            let packet = match rx.recv().await {
                Ok(p) => p,
                Err(broadcast::error::RecvError::Lagged(n)) => {
                    status.lock().await.dropped += n;
                    waiting_for_key = true;
                    continue;
                }
                Err(broadcast::error::RecvError::Closed) => break Ok(true),
            };
            if waiting_for_key {
                if packet.track == Track::Video && packet.keyframe {
                    waiting_for_key = false;
                } else {
                    continue;
                }
            }
            match tokio::time::timeout(
                SEND_TIMEOUT,
                publisher.send_packet(&packet, packet.pts_ms()),
            )
            .await
            {
                Ok(Ok(())) => {}
                Ok(Err(e)) => break Err(format!("{e:#}")),
                Err(_) => break Err("network too slow: send timed out".into()),
            }
            let elapsed = window_start.elapsed();
            if elapsed >= Duration::from_secs(1) {
                let sent = publisher.bytes_sent;
                let mut s = status.lock().await;
                s.bytes = total_bytes + sent;
                s.kbps =
                    ((sent - window_bytes) as f64 * 8.0 / 1000.0 / elapsed.as_secs_f64()) as u32;
                window_bytes = sent;
                window_start = Instant::now();
            }
        };
        total_bytes += publisher.bytes_sent;
        match outcome {
            Ok(_) => {
                publisher.close().await;
                break;
            }
            Err(e) => {
                set_error(&status, OutputState::Reconnecting, e).await;
                tokio::select! {
                    _ = tokio::time::sleep(backoff) => {}
                    _ = stop.changed() => break,
                }
                rx = rx.resubscribe();
            }
        }
    }
    let mut s = status.lock().await;
    s.bytes = s.bytes.max(total_bytes);
    s.kbps = 0;
    if s.state != OutputState::Failed {
        s.state = OutputState::Stopped;
    }
}

async fn set_error(status: &Arc<Mutex<OutputStatus>>, state: OutputState, error: String) {
    tracing::warn!("{}: {}", status.lock().await.name, error);
    let mut s = status.lock().await;
    s.state = state;
    s.error = Some(error);
    s.kbps = 0;
}
