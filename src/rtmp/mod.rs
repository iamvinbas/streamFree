//! Minimal RTMP/RTMPS publishing client: enough of the protocol to push one
//! live stream to YouTube, Twitch, Facebook, LinkedIn, Kick or any custom server.

pub mod chunk;

use crate::flv::{self, Amf};
use crate::media::{Packet, StreamConfig, Track};
use anyhow::{anyhow, bail, Context, Result};
use bytes::BytesMut;
use chunk::{ChunkReader, Message};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::mpsc;

const CSID_CONTROL: u32 = 2;
const CSID_COMMAND: u32 = 3;
const CSID_AUDIO: u32 = 4;
const CSID_DATA: u32 = 5;
const CSID_VIDEO: u32 = 6;
const OUT_CHUNK_SIZE: usize = 4096;
const HANDSHAKE_SIZE: usize = 1536;
const SETUP_TIMEOUT: Duration = Duration::from_secs(15);

/// Where to publish: parsed from an ingest URL and a stream key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    pub tls: bool,
    pub host: String,
    pub port: u16,
    pub app: String,
    pub tc_url: String,
    pub stream_key: String,
}

impl Target {
    /// Accepts `rtmp[s]://host[:port]/app[/more]` plus a separate key, or a
    /// full URL whose last path segment is the key when `key` is empty.
    pub fn parse(url: &str, key: &str) -> Result<Self> {
        let parsed = url::Url::parse(url.trim()).context("invalid ingest URL")?;
        let tls = match parsed.scheme() {
            "rtmp" => false,
            "rtmps" => true,
            other => bail!("unsupported scheme {other}: use rtmp:// or rtmps://"),
        };
        let host = parsed
            .host_str()
            .ok_or_else(|| anyhow!("ingest URL has no host"))?
            .to_owned();
        let port = parsed.port().unwrap_or(if tls { 443 } else { 1935 });
        let mut path = parsed.path().trim_matches('/').to_owned();
        if let Some(q) = parsed.query() {
            path = format!("{path}?{q}");
        }
        let key = key.trim();
        let (app, stream_key) = if key.is_empty() {
            match path.rsplit_once('/') {
                Some((app, key)) if !app.is_empty() && !key.is_empty() => {
                    (app.to_owned(), key.to_owned())
                }
                _ => bail!("missing stream key"),
            }
        } else {
            (path, key.to_owned())
        };
        if app.is_empty() {
            bail!("ingest URL has no application path (e.g. rtmp://host/live)");
        }
        let scheme = if tls { "rtmps" } else { "rtmp" };
        let tc_url = match parsed.port() {
            Some(p) => format!("{scheme}://{host}:{p}/{app}"),
            None => format!("{scheme}://{host}/{app}"),
        };
        Ok(Self {
            tls,
            host,
            port,
            app,
            tc_url,
            stream_key,
        })
    }
}

trait Stream: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Stream for T {}

async fn open(target: &Target) -> Result<Box<dyn Stream>> {
    let tcp = TcpStream::connect((target.host.as_str(), target.port))
        .await
        .with_context(|| format!("connect to {}:{}", target.host, target.port))?;
    tcp.set_nodelay(true).ok();
    if !target.tls {
        return Ok(Box::new(tcp));
    }
    let mut roots = rustls::RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let config = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()?
    .with_root_certificates(roots)
    .with_no_client_auth();
    let connector = tokio_rustls::TlsConnector::from(Arc::new(config));
    let name = rustls::pki_types::ServerName::try_from(target.host.clone())
        .context("invalid TLS server name")?;
    let tls = connector
        .connect(name, tcp)
        .await
        .context("TLS handshake")?;
    Ok(Box::new(tls))
}

/// Simple (non-digest) handshake, section 5.2 of the RTMP specification.
async fn handshake<S: AsyncRead + AsyncWrite + Unpin>(stream: &mut S) -> Result<()> {
    let mut c0c1 = vec![0u8; 1 + HANDSHAKE_SIZE];
    c0c1[0] = 3;
    getrandom::fill(&mut c0c1[9..]).map_err(|e| anyhow!("random: {e}"))?;
    stream.write_all(&c0c1).await?;
    let mut s0s1 = vec![0u8; 1 + HANDSHAKE_SIZE];
    stream.read_exact(&mut s0s1).await.context("read S0/S1")?;
    if s0s1[0] != 3 {
        bail!("server answered RTMP version {}", s0s1[0]);
    }
    // C2 echoes S1.
    stream.write_all(&s0s1[1..]).await?;
    let mut s2 = vec![0u8; HANDSHAKE_SIZE];
    stream.read_exact(&mut s2).await.context("read S2")?;
    Ok(())
}

enum Incoming {
    Message(Message),
    Closed(String),
}

async fn read_loop(
    mut reader: tokio::io::ReadHalf<Box<dyn Stream>>,
    events: mpsc::Sender<Incoming>,
) {
    let mut parser = ChunkReader::default();
    let mut buf = vec![0u8; 16 * 1024];
    loop {
        let n = match reader.read(&mut buf).await {
            Ok(0) => {
                let _ = events
                    .send(Incoming::Closed("server closed the connection".into()))
                    .await;
                return;
            }
            Ok(n) => n,
            Err(e) => {
                let _ = events.send(Incoming::Closed(e.to_string())).await;
                return;
            }
        };
        parser.feed(&buf[..n]);
        loop {
            match parser.next_message() {
                Ok(Some(msg)) => {
                    if events.send(Incoming::Message(msg)).await.is_err() {
                        return;
                    }
                }
                Ok(None) => break,
                Err(e) => {
                    let _ = events.send(Incoming::Closed(e.to_string())).await;
                    return;
                }
            }
        }
    }
}

/// A connected, publishing RTMP session.
pub struct Publisher {
    writer: tokio::io::WriteHalf<Box<dyn Stream>>,
    events: mpsc::Receiver<Incoming>,
    stream_id: u32,
    stream_key: String,
    transaction: f64,
    out: BytesMut,
    bytes_received: u64,
    ack_window: u64,
    last_ack: u64,
    pub bytes_sent: u64,
}

impl Publisher {
    /// Connects, handshakes and publishes `target.stream_key`.
    pub async fn connect(target: &Target) -> Result<Self> {
        tokio::time::timeout(SETUP_TIMEOUT, Self::connect_inner(target))
            .await
            .map_err(|_| anyhow!("timed out connecting to {}", target.host))?
    }

    /// Checks that the server accepts a connection to the target's
    /// application, without publishing anything. Returns the server's name
    /// when it reports one. Stream keys are only checked when publishing.
    pub async fn check(target: &Target) -> Result<String> {
        tokio::time::timeout(SETUP_TIMEOUT, async {
            let (p, values) = Self::establish(target).await?;
            let server = values
                .get(2)
                .and_then(|v| v.get("fmsVer"))
                .and_then(Amf::as_str)
                .unwrap_or("RTMP server")
                .to_owned();
            p.disconnect().await;
            Ok(server)
        })
        .await
        .map_err(|_| anyhow!("timed out connecting to {}", target.host))?
    }

    async fn disconnect(mut self) {
        let _ = self.writer.shutdown().await;
    }

    /// TCP (+TLS), handshake and `connect`. Returns the `_result` values.
    async fn establish(target: &Target) -> Result<(Self, Vec<Amf>)> {
        let mut stream = open(target).await?;
        handshake(&mut stream).await?;
        let (reader, writer) = tokio::io::split(stream);
        let (tx, rx) = mpsc::channel(64);
        tokio::spawn(read_loop(reader, tx));
        let mut p = Self {
            writer,
            events: rx,
            stream_id: 0,
            stream_key: target.stream_key.clone(),
            transaction: 1.0,
            out: BytesMut::new(),
            bytes_received: 0,
            ack_window: 2_500_000,
            last_ack: 0,
            bytes_sent: 0,
        };
        p.queue(
            CSID_CONTROL,
            chunk::MSG_SET_CHUNK_SIZE,
            0,
            0,
            &(OUT_CHUNK_SIZE as u32).to_be_bytes(),
        );
        p.command(
            "connect",
            vec![Amf::Object(vec![
                ("app".into(), Amf::str(&target.app)),
                ("type".into(), Amf::str("nonprivate")),
                (
                    "flashVer".into(),
                    Amf::str("FMLE/3.0 (compatible; streamFree)"),
                ),
                ("tcUrl".into(), Amf::str(&target.tc_url)),
            ])],
            0,
        );
        p.flush().await?;
        let result = p.expect_result(1.0).await.context("connect rejected")?;
        Ok((p, result))
    }

    async fn connect_inner(target: &Target) -> Result<Self> {
        let (mut p, _) = Self::establish(target).await?;
        // Platforms reject a wrong or expired stream key by closing the
        // connection at this point, without an error message.
        p.publish(&target.stream_key).await.context(
            "the server refused the stream: check the stream key, and that your channel or live event is ready",
        )?;
        Ok(p)
    }

    async fn publish(&mut self, key: &str) -> Result<()> {
        self.command("releaseStream", vec![Amf::Null, Amf::str(key)], 0);
        self.command("FCPublish", vec![Amf::Null, Amf::str(key)], 0);
        let create_tid = self.transaction;
        self.command("createStream", vec![Amf::Null], 0);
        self.flush().await?;
        let result = self
            .expect_result(create_tid)
            .await
            .context("createStream rejected")?;
        self.stream_id = result
            .get(3)
            .and_then(Amf::as_number)
            .ok_or_else(|| anyhow!("createStream returned no stream id"))?
            as u32;
        let stream_id = self.stream_id;
        self.command(
            "publish",
            vec![Amf::Null, Amf::str(key), Amf::str("live")],
            stream_id,
        );
        self.flush().await?;
        self.expect_publish_start().await
    }

    fn queue(&mut self, csid: u32, msg_type: u8, stream_id: u32, timestamp: u32, payload: &[u8]) {
        chunk::encode_message(
            &mut self.out,
            OUT_CHUNK_SIZE,
            csid,
            msg_type,
            stream_id,
            timestamp,
            payload,
        );
    }

    fn command(&mut self, name: &str, args: Vec<Amf>, stream_id: u32) {
        let tid = if name == "publish" {
            0.0
        } else {
            self.transaction
        };
        if name != "publish" {
            self.transaction += 1.0;
        }
        let mut values = vec![Amf::str(name), Amf::Number(tid)];
        values.extend(args);
        let body = flv::encode_values(&values);
        self.queue(CSID_COMMAND, chunk::MSG_COMMAND_AMF0, stream_id, 0, &body);
    }

    async fn flush(&mut self) -> Result<()> {
        if self.out.is_empty() {
            return Ok(());
        }
        let data = self.out.split().freeze();
        self.writer.write_all(&data).await?;
        self.writer.flush().await?;
        self.bytes_sent += data.len() as u64;
        Ok(())
    }

    /// Handles protocol control messages; returns command messages to the caller.
    async fn next_command(&mut self) -> Result<Vec<Amf>> {
        loop {
            let msg = match self.events.recv().await {
                Some(Incoming::Message(msg)) => msg,
                Some(Incoming::Closed(reason)) => bail!("{reason}"),
                None => bail!("connection reader stopped"),
            };
            if let Some(values) = self.handle_control(msg).await? {
                return Ok(values);
            }
        }
    }

    async fn handle_control(&mut self, msg: Message) -> Result<Option<Vec<Amf>>> {
        self.bytes_received += msg.payload.len() as u64 + 12;
        match msg.msg_type {
            chunk::MSG_WINDOW_ACK_SIZE if msg.payload.len() >= 4 => {
                self.ack_window = u32::from_be_bytes(msg.payload[..4].try_into().unwrap()) as u64;
            }
            chunk::MSG_USER_CONTROL if msg.payload.len() >= 6 => {
                let event = u16::from_be_bytes([msg.payload[0], msg.payload[1]]);
                if event == 6 {
                    // PingRequest -> PingResponse with the same timestamp.
                    let mut body = vec![0, 7];
                    body.extend_from_slice(&msg.payload[2..6]);
                    self.queue(CSID_CONTROL, chunk::MSG_USER_CONTROL, 0, 0, &body);
                    self.flush().await?;
                }
            }
            chunk::MSG_COMMAND_AMF0 => return Ok(Some(Amf::decode_all(&msg.payload))),
            _ => {}
        }
        if self.ack_window > 0 && self.bytes_received - self.last_ack >= self.ack_window {
            self.last_ack = self.bytes_received;
            let seq = (self.bytes_received as u32).to_be_bytes();
            self.queue(CSID_CONTROL, chunk::MSG_ACK, 0, 0, &seq);
            self.flush().await?;
        }
        Ok(None)
    }

    async fn expect_result(&mut self, tid: f64) -> Result<Vec<Amf>> {
        loop {
            let values = self.next_command().await?;
            let name = values.first().and_then(Amf::as_str).unwrap_or_default();
            let id = values.get(1).and_then(Amf::as_number).unwrap_or(-1.0);
            match name {
                "_result" if id == tid => return Ok(values),
                "_error" if id == tid => bail!("{}", describe_status(&values)),
                _ => {}
            }
        }
    }

    async fn expect_publish_start(&mut self) -> Result<()> {
        loop {
            let values = self.next_command().await?;
            if values.first().and_then(Amf::as_str) != Some("onStatus") {
                continue;
            }
            let info = values.get(3);
            let code = info
                .and_then(|i| i.get("code"))
                .and_then(Amf::as_str)
                .unwrap_or_default();
            match code {
                "NetStream.Publish.Start" => return Ok(()),
                c if c.starts_with("NetStream.Publish.")
                    || c.ends_with("Failed")
                    || c.ends_with("Rejected") =>
                {
                    bail!("publish refused: {}", describe_status(&values))
                }
                _ => {}
            }
        }
    }

    /// Sends `onMetaData` and both sequence headers. Must precede media.
    pub async fn send_headers(&mut self, config: &StreamConfig) -> Result<()> {
        let sid = self.stream_id;
        self.queue(
            CSID_DATA,
            chunk::MSG_DATA_AMF0,
            sid,
            0,
            &flv::metadata(config, true),
        );
        self.queue(
            CSID_VIDEO,
            chunk::MSG_VIDEO,
            sid,
            0,
            &flv::video_sequence_header(&config.video.avcc),
        );
        self.queue(
            CSID_AUDIO,
            chunk::MSG_AUDIO,
            sid,
            0,
            &flv::audio_sequence_header(&config.audio.asc),
        );
        self.flush().await
    }

    pub async fn send_packet(&mut self, packet: &Packet, timestamp_ms: u32) -> Result<()> {
        let sid = self.stream_id;
        match packet.track {
            Track::Video => {
                let body = flv::video_frame(packet.keyframe, &packet.data);
                self.queue(CSID_VIDEO, chunk::MSG_VIDEO, sid, timestamp_ms, &body);
            }
            Track::Audio => {
                let body = flv::audio_frame(&packet.data);
                self.queue(CSID_AUDIO, chunk::MSG_AUDIO, sid, timestamp_ms, &body);
            }
        }
        self.flush().await?;
        // Answer pings and acknowledgements without blocking the media path.
        while let Ok(event) = self.events.try_recv() {
            match event {
                Incoming::Message(msg) => {
                    if let Some(values) = self.handle_control(msg).await? {
                        if values.first().and_then(Amf::as_str) == Some("onStatus") {
                            let level = values
                                .get(3)
                                .and_then(|i| i.get("level"))
                                .and_then(Amf::as_str);
                            if level == Some("error") {
                                bail!("server error: {}", describe_status(&values));
                            }
                        }
                    }
                }
                Incoming::Closed(reason) => bail!("{reason}"),
            }
        }
        Ok(())
    }

    /// Ends the stream politely; errors are ignored because the stream is over.
    pub async fn close(mut self) {
        let sid = self.stream_id;
        let key = self.stream_key.clone();
        self.command("FCUnpublish", vec![Amf::Null, Amf::str(&key)], 0);
        self.command("deleteStream", vec![Amf::Null, Amf::Number(sid as f64)], 0);
        let _ = tokio::time::timeout(Duration::from_secs(2), self.flush()).await;
        let _ = self.writer.shutdown().await;
    }
}

fn describe_status(values: &[Amf]) -> String {
    let info = values.iter().skip(2).find(|v| matches!(v, Amf::Object(_)));
    let code = info.and_then(|i| i.get("code")).and_then(Amf::as_str);
    let desc = info
        .and_then(|i| i.get("description"))
        .and_then(Amf::as_str);
    match (code, desc) {
        (Some(c), Some(d)) => format!("{c}: {d}"),
        (Some(c), None) => c.to_owned(),
        (None, Some(d)) => d.to_owned(),
        (None, None) => "no details from server".to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_youtube_style_target() {
        let t = Target::parse("rtmp://a.rtmp.youtube.com/live2", "abcd-1234").unwrap();
        assert!(!t.tls);
        assert_eq!(t.port, 1935);
        assert_eq!(t.app, "live2");
        assert_eq!(t.tc_url, "rtmp://a.rtmp.youtube.com/live2");
        assert_eq!(t.stream_key, "abcd-1234");
    }

    #[test]
    fn parses_rtmps_with_trailing_slash() {
        let t = Target::parse("rtmps://live-api-s.facebook.com:443/rtmp/", "FB-1?s_bl=1").unwrap();
        assert!(t.tls);
        assert_eq!(t.port, 443);
        assert_eq!(t.app, "rtmp");
        assert_eq!(t.tc_url, "rtmps://live-api-s.facebook.com:443/rtmp");
        assert_eq!(t.stream_key, "FB-1?s_bl=1");
    }

    #[test]
    fn splits_key_from_full_url() {
        let t = Target::parse("rtmp://127.0.0.1:1936/live/test", "").unwrap();
        assert_eq!(t.app, "live");
        assert_eq!(t.stream_key, "test");
        assert_eq!(t.port, 1936);
    }

    #[test]
    fn rejects_bad_targets() {
        assert!(Target::parse("http://x/live", "k").is_err());
        assert!(Target::parse("rtmp://x", "k").is_err());
        assert!(Target::parse("rtmp://x/live", "").is_err());
    }
}
